import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Database } from "bun:sqlite";
import {
  openDatabase,
  getMeta,
  setMeta,
  checkEmbeddingModelChanged,
  checkParserChanged,
  upsertDocument,
  deleteMissingDocuments,
  searchDocuments,
  getDocumentMeta,
  getRelatedPaths,
  getChunkTexts,
  getChunksWithoutEmbeddings,
  storeChunkEmbeddings,
  getBacklinks,
  getActiveToArchiveLinks,
  getStoredHash,
  vecChunksDimension,
  gcOrphanVecChunks,
} from "../src/db.js";
import type { CoreDb } from "../src/db.js";
import type { CoreConfig } from "../src/config.js";
import { getTaxonomy, DEFAULT_RANKING } from "../src/taxonomy.js";

// openDatabase wants a config — we only use config.index.dbPath, but TypeScript
// insists on the full shape. Minimal stub.
function makeConfig(dbPath: string): CoreConfig {
  return {
    vaultPath: "/tmp/test-vault",
    locale: "en",
    taxonomy: getTaxonomy("en"),
    ranking: { ...DEFAULT_RANKING },
    curatorSet: ["index", "scriber", "dreamweaver"],
    callerAgent: null,
    excludeFolders: [],
    search: { chunkSize: 500, chunkOverlap: 80, maxResults: 6, rrfK: 60 },
    index: { dbPath, fullScanOnStartup: false },
    batch: { curatorMs: 6 * 3600_000 },
    mcp: { port: 0 },
    embedding: null,
    reranker: null,
  };
}

// Same stub but with an embedding provider configured, so openDatabase creates
// the `vec_chunks` virtual table at `dimensions`. The endpoint is never hit —
// these tests exercise schema/migration, not embedding HTTP.
function makeConfigWithEmbedding(dbPath: string, dimensions: number): CoreConfig {
  return {
    ...makeConfig(dbPath),
    embedding: {
      endpoint: "http://127.0.0.1:1/v1/embeddings",
      model: "test-embedder",
      dimensions,
      batchSize: 32,
      apiKey: null,
    },
  };
}

// vec_chunks only exists when the process-wide sqlite has extension support
// (non-stripped libsqlite3). Probe once so the migration tests skip cleanly on
// machines without it instead of failing — the BM25-only path is a valid state.
function probeVecAvailable(): boolean {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "iapeer-memory-vecprobe-"));
  try {
    const probe = openDatabase(makeConfigWithEmbedding(path.join(dir, "probe.db"), 4));
    const ok = probe.vecAvailable;
    probe.close();
    return ok;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
const VEC_AVAILABLE = probeVecAvailable();

function vecRowCount(h: CoreDb): number {
  return (h.prepare("SELECT COUNT(*) AS c FROM vec_chunks").get() as { c: number }).c;
}

function insertOneEmbedding(h: CoreDb, docPath: string, hash: string, vec: number[]): void {
  upsertDocument(
    h,
    {
      path: docPath,
      title: docPath,
      type: null,
      status: null,
      tags: [],
      contentHash: hash,
      frontmatter: {},
      created: null,
      updated: null,
      indexedAt: "x",
    },
    [{ chunkIndex: 0, text: "to embed" }],
    [],
  );
  const id = getChunksWithoutEmbeddings(h, 1)[0]!.id;
  storeChunkEmbeddings(h, [{ id, embedding: Buffer.from(new Float32Array(vec).buffer) }]);
}

let tmpDir: string;
let db: CoreDb;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "iapeer-memory-test-"));
  const dbPath = path.join(tmpDir, "test.db");
  db = openDatabase(makeConfig(dbPath));
});

afterEach(() => {
  try {
    db.close();
  } catch {}
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("openDatabase — fresh", () => {
  it("creates required tables", () => {
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type IN ('table','virtual') ORDER BY name")
      .all() as Array<{ name: string }>;
    const names = tables.map((t) => t.name);
    expect(names).toContain("documents");
    expect(names).toContain("chunks");
    expect(names).toContain("edges");
    expect(names).toContain("meta");
    // chunk_fts is a virtual table — sqlite_master shows shadow tables too.
    expect(names.some((n) => n.startsWith("chunk_fts"))).toBe(true);
  });

  it("documents schema has no source/agent_id columns", () => {
    const cols = db
      .prepare("PRAGMA table_info(documents)")
      .all() as Array<{ name: string }>;
    const colNames = cols.map((c) => c.name);
    expect(colNames).not.toContain("source");
    expect(colNames).not.toContain("agent_id");
  });

  it("enables WAL mode", () => {
    const row = db.prepare("PRAGMA journal_mode").get() as { journal_mode: string } | null;
    expect(row?.journal_mode).toBe("wal");
  });
});

describe("schema migration", () => {
  it("drops legacy tables when documents.source column is present", () => {
    // Manually craft a legacy DB with the old schema.
    db.close();
    const legacyPath = path.join(tmpDir, "legacy.db");
    const legacy = new Database(legacyPath, { create: true, strict: true });
    legacy.exec(`
      CREATE TABLE documents (
        path TEXT PRIMARY KEY,
        title TEXT,
        source TEXT NOT NULL,
        agent_id TEXT
      );
      CREATE TABLE chunks (id INTEGER PRIMARY KEY, doc_path TEXT);
      CREATE TABLE edges (source_path TEXT, target_path TEXT);
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
      INSERT INTO documents (path, title, source) VALUES ('x.md', 'X', 'vault');
      INSERT INTO chunks (doc_path) VALUES ('x.md');
      INSERT INTO meta (key, value) VALUES ('parser_fingerprint', 'old-version');
    `);
    legacy.close();

    // Now reopen via openDatabase — migration should kick in.
    db = openDatabase(makeConfig(legacyPath));

    // documents should be empty (old rows dropped, schema rebuilt).
    const docCount = (
      db.prepare("SELECT COUNT(*) as n FROM documents").get() as { n: number }
    ).n;
    expect(docCount).toBe(0);

    // documents schema no longer has source/agent_id.
    const cols = db
      .prepare("PRAGMA table_info(documents)")
      .all() as Array<{ name: string }>;
    const colNames = cols.map((c) => c.name);
    expect(colNames).not.toContain("source");
    expect(colNames).not.toContain("agent_id");

    // meta is preserved — fingerprints survive migration.
    expect(getMeta(db, "parser_fingerprint")).toBe("old-version");
  });

  it("is idempotent — re-opening a clean new DB doesn't drop anything", () => {
    upsertDocument(
      db,
      {
        path: "stay.md",
        title: "Stay",
        type: null,
        status: null,
        tags: [],
        contentHash: "abc",
        frontmatter: {},
        created: null,
        updated: null,
        indexedAt: new Date().toISOString(),
      },
      [{ chunkIndex: 0, text: "Stay content" }],
      [],
    );
    const dbPath = path.join(tmpDir, "test.db");
    db.close();
    db = openDatabase(makeConfig(dbPath));
    const meta = getDocumentMeta(db, "stay.md");
    expect(meta?.title).toBe("Stay");
  });
});

describe("upsertDocument + getDocumentMeta", () => {
  it("inserts a new document and returns it", () => {
    upsertDocument(
      db,
      {
        path: "test.md",
        title: "Test Note",
        type: "знание",
        status: "актуально",
        tags: ["foo", "bar"],
        contentHash: "h1",
        frontmatter: { author: "boris" },
        created: "2026-01-01",
        updated: "2026-01-02",
        indexedAt: "2026-01-03T10:00:00.000Z",
      },
      [{ chunkIndex: 0, text: "hello world" }],
      [{ target: "01_Знания/Other.md", contextSnippet: "see [[Other]]" }],
    );

    const meta = getDocumentMeta(db, "test.md");
    expect(meta).not.toBeNull();
    expect(meta!.title).toBe("Test Note");
    expect(meta!.type).toBe("знание");
    expect(meta!.status).toBe("актуально");
    expect(meta!.tags).toEqual(["foo", "bar"]);
    expect(meta!.frontmatter).toEqual({ author: "boris" });
    expect(meta!.created).toBe("2026-01-01");
  });

  it("upsert replaces chunks and edges on second call", () => {
    upsertDocument(
      db,
      {
        path: "x.md",
        title: "X",
        type: null,
        status: null,
        tags: [],
        contentHash: "h1",
        frontmatter: {},
        created: null,
        updated: null,
        indexedAt: "2026-01-01T00:00:00.000Z",
      },
      [
        { chunkIndex: 0, text: "first chunk" },
        { chunkIndex: 1, text: "second chunk" },
      ],
      [{ target: "old", contextSnippet: "" }],
    );

    upsertDocument(
      db,
      {
        path: "x.md",
        title: "X v2",
        type: null,
        status: null,
        tags: [],
        contentHash: "h2",
        frontmatter: {},
        created: null,
        updated: null,
        indexedAt: "2026-01-02T00:00:00.000Z",
      },
      [{ chunkIndex: 0, text: "replaced chunk" }],
      [{ target: "new", contextSnippet: "" }],
    );

    const chunks = getChunkTexts(db, "x.md");
    expect(chunks).toEqual(["replaced chunk"]);
    expect(getDocumentMeta(db, "x.md")?.title).toBe("X v2");
    expect(getStoredHash(db, "x.md")).toBe("h2");
  });
});

describe("searchDocuments (FTS5)", () => {
  it("returns hits matching the FTS query", () => {
    upsertDocument(
      db,
      {
        path: "a.md",
        title: "Apple",
        type: null,
        status: null,
        tags: [],
        contentHash: "ha",
        frontmatter: {},
        created: null,
        updated: null,
        indexedAt: "x",
      },
      [{ chunkIndex: 0, text: "apple banana cherry" }],
      [],
    );
    upsertDocument(
      db,
      {
        path: "b.md",
        title: "Berry",
        type: null,
        status: null,
        tags: [],
        contentHash: "hb",
        frontmatter: {},
        created: null,
        updated: null,
        indexedAt: "x",
      },
      [{ chunkIndex: 0, text: "blackberry raspberry" }],
      [],
    );

    const hits = searchDocuments(db, { query: '"apple"*', limit: 5 });
    expect(hits.map((h) => h.path)).toContain("a.md");
    expect(hits.map((h) => h.path)).not.toContain("b.md");
  });

  it("dedups multi-chunk hits by path", () => {
    upsertDocument(
      db,
      {
        path: "multi.md",
        title: "M",
        type: null,
        status: null,
        tags: [],
        contentHash: "h",
        frontmatter: {},
        created: null,
        updated: null,
        indexedAt: "x",
      },
      [
        { chunkIndex: 0, text: "kiwi pear" },
        { chunkIndex: 1, text: "kiwi grape" },
        { chunkIndex: 2, text: "kiwi peach" },
      ],
      [],
    );
    const hits = searchDocuments(db, { query: '"kiwi"*', limit: 5 });
    expect(hits.filter((h) => h.path === "multi.md")).toHaveLength(1);
  });
});

describe("deleteMissingDocuments", () => {
  it("removes documents not in the existingPaths set", () => {
    for (const p of ["keep.md", "drop.md"]) {
      upsertDocument(
        db,
        {
          path: p,
          title: p,
          type: null,
          status: null,
          tags: [],
          contentHash: "h",
          frontmatter: {},
          created: null,
          updated: null,
          indexedAt: "x",
        },
        [{ chunkIndex: 0, text: p }],
        [],
      );
    }
    const removed = deleteMissingDocuments(db, new Set(["keep.md"]));
    expect(removed).toBe(1);
    expect(getDocumentMeta(db, "keep.md")).not.toBeNull();
    expect(getDocumentMeta(db, "drop.md")).toBeNull();
  });

  it("returns 0 when nothing is stale", () => {
    upsertDocument(
      db,
      {
        path: "a.md",
        title: "A",
        type: null,
        status: null,
        tags: [],
        contentHash: "h",
        frontmatter: {},
        created: null,
        updated: null,
        indexedAt: "x",
      },
      [{ chunkIndex: 0, text: "a" }],
      [],
    );
    expect(deleteMissingDocuments(db, new Set(["a.md"]))).toBe(0);
  });
});

describe("link-rule: move-aware edges + active→archive detection", () => {
  const ARCH = getTaxonomy("en").folders.archive;
  const OPER = getTaxonomy("en").folders.agentMemory;
  const doc = (
    p: string,
    links: Array<{ target: string; contextSnippet: string }> = [],
  ) =>
    upsertDocument(
      db,
      {
        path: p,
        title: p,
        type: null,
        status: null,
        tags: [],
        contentHash: "h",
        frontmatter: {},
        created: null,
        updated: null,
        indexedAt: "x",
      },
      [{ chunkIndex: 0, text: p }],
      links,
    );

  it("re-points incoming edges when a target MOVES to the archive (backlink survives)", () => {
    const oldY = "01_K/Y.md";
    const newY = `${ARCH}/Y.md`;
    doc("01_K/X.md", [{ target: oldY, contextSnippet: "x→y" }]);
    doc(oldY);
    expect(getBacklinks(db, oldY).map((b) => b.path)).toEqual(["01_K/X.md"]);
    // Y archived: new path indexed, old path now stale → move-aware re-point.
    doc(newY);
    deleteMissingDocuments(db, new Set(["01_K/X.md", newY]));
    expect(getBacklinks(db, oldY)).toEqual([]); // old path carries no backlinks
    expect(getBacklinks(db, newY).map((b) => b.path)).toEqual(["01_K/X.md"]); // re-pointed
    // the now-archived target makes X→Y a forbidden active→archive link.
    expect(getActiveToArchiveLinks(db, ARCH, OPER).map((e) => `${e.source}→${e.target}`)).toEqual([
      `01_K/X.md→${newY}`,
    ]);
  });

  it("genuine deletion (no new home for the basename) drops incoming edges", () => {
    doc("01_K/X.md", [{ target: "01_K/Z.md", contextSnippet: "x→z" }]);
    doc("01_K/Z.md");
    deleteMissingDocuments(db, new Set(["01_K/X.md"])); // Z gone, no same-basename new path
    expect(getBacklinks(db, "01_K/Z.md")).toEqual([]);
  });

  it("getActiveToArchiveLinks: only active→archive, never archive→active or active→active", () => {
    doc("01_K/A.md", [{ target: `${ARCH}/X.md`, contextSnippet: "a→x (forbidden)" }]);
    doc(`${ARCH}/Y.md`, [{ target: "01_K/B.md", contextSnippet: "y→b (allowed)" }]);
    doc("01_K/C.md", [{ target: "01_K/D.md", contextSnippet: "c→d (allowed)" }]);
    const r = getActiveToArchiveLinks(db, ARCH, OPER).map((e) => `${e.source}→${e.target}`);
    expect(r).toEqual([`01_K/A.md→${ARCH}/X.md`]);
  });

  it("operative→archive is NOT a violation (personal journal, outside the canon graph)", () => {
    doc("01_K/A.md", [{ target: `${ARCH}/X.md`, contextSnippet: "canon→archive (forbidden)" }]);
    doc(`${OPER}/boris/J.md`, [{ target: `${ARCH}/X.md`, contextSnippet: "operative→archive (allowed history)" }]);
    const r = getActiveToArchiveLinks(db, ARCH, OPER).map((e) => `${e.source}→${e.target}`);
    expect(r).toEqual([`01_K/A.md→${ARCH}/X.md`]); // only the canon source, operative excluded
  });
});

describe("getRelatedPaths + getBacklinks", () => {
  beforeEach(() => {
    upsertDocument(
      db,
      {
        path: "a.md",
        title: "A",
        type: null,
        status: null,
        tags: [],
        contentHash: "h",
        frontmatter: {},
        created: null,
        updated: null,
        indexedAt: "x",
      },
      [{ chunkIndex: 0, text: "a" }],
      [
        { target: "b.md", contextSnippet: "ref to b" },
        { target: "c.md", contextSnippet: "ref to c" },
      ],
    );
    upsertDocument(
      db,
      {
        path: "b.md",
        title: "B",
        type: null,
        status: null,
        tags: [],
        contentHash: "h",
        frontmatter: {},
        created: null,
        updated: null,
        indexedAt: "x",
      },
      [{ chunkIndex: 0, text: "b" }],
      [{ target: "a.md", contextSnippet: "ref back to a" }],
    );
  });

  it("getRelatedPaths returns both outgoing and incoming neighbours", () => {
    const neighbours = getRelatedPaths(db, "a.md");
    expect(new Set(neighbours)).toEqual(new Set(["b.md", "c.md"]));
  });

  it("getBacklinks returns notes that reference target", () => {
    const backlinks = getBacklinks(db, "a.md");
    expect(backlinks.map((b) => b.path)).toEqual(["b.md"]);
    expect(backlinks[0]!.contextSnippet).toBe("ref back to a");
  });

  it("getBacklinks returns empty for nodes with no incoming refs", () => {
    // Isolated note created here: nobody references it.
    upsertDocument(
      db,
      {
        path: "isolated.md",
        title: "Iso",
        type: null,
        status: null,
        tags: [],
        contentHash: "h",
        frontmatter: {},
        created: null,
        updated: null,
        indexedAt: "x",
      },
      [{ chunkIndex: 0, text: "i" }],
      [],
    );
    expect(getBacklinks(db, "isolated.md")).toEqual([]);
  });
});

describe("embeddings storage", () => {
  it("stores and retrieves chunk embeddings", () => {
    upsertDocument(
      db,
      {
        path: "e.md",
        title: "E",
        type: null,
        status: null,
        tags: [],
        contentHash: "h",
        frontmatter: {},
        created: null,
        updated: null,
        indexedAt: "x",
      },
      [{ chunkIndex: 0, text: "to embed" }],
      [],
    );
    const missing = getChunksWithoutEmbeddings(db, 10);
    expect(missing).toHaveLength(1);
    const buf = Buffer.from(new Float32Array([0.1, 0.2, 0.3]).buffer);
    storeChunkEmbeddings(db, [{ id: missing[0]!.id, embedding: buf }]);
    expect(getChunksWithoutEmbeddings(db, 10)).toHaveLength(0);
  });
});

describe("meta + fingerprint guards", () => {
  it("getMeta / setMeta round-trip", () => {
    expect(getMeta(db, "k")).toBeNull();
    setMeta(db, "k", "v");
    expect(getMeta(db, "k")).toBe("v");
    setMeta(db, "k", "v2");
    expect(getMeta(db, "k")).toBe("v2");
  });

  it("checkEmbeddingModelChanged: first run does not invalidate (no prior fingerprint)", () => {
    const invalidated = checkEmbeddingModelChanged(db, {
      model: "test-model",
      dimensions: 768,
    });
    expect(invalidated).toBe(false);
    // But fingerprint is now stored.
    expect(getMeta(db, "embedding_fingerprint")).toBe("test-model:768");
  });

  it("checkEmbeddingModelChanged: model change clears embeddings + returns true", () => {
    setMeta(db, "embedding_fingerprint", "old-model:512");
    upsertDocument(
      db,
      {
        path: "x.md",
        title: "X",
        type: null,
        status: null,
        tags: [],
        contentHash: "h",
        frontmatter: {},
        created: null,
        updated: null,
        indexedAt: "x",
      },
      [{ chunkIndex: 0, text: "x" }],
      [],
    );
    const missing0 = getChunksWithoutEmbeddings(db, 10);
    storeChunkEmbeddings(db, [
      { id: missing0[0]!.id, embedding: Buffer.from(new Float32Array([1]).buffer) },
    ]);
    expect(getChunksWithoutEmbeddings(db, 10)).toHaveLength(0);

    const invalidated = checkEmbeddingModelChanged(db, {
      model: "new-model",
      dimensions: 1024,
    });
    expect(invalidated).toBe(true);
    expect(getChunksWithoutEmbeddings(db, 10)).toHaveLength(1);
    expect(getMeta(db, "embedding_fingerprint")).toBe("new-model:1024");
  });

  it("checkParserChanged: bumping the version nullifies content hashes", () => {
    upsertDocument(
      db,
      {
        path: "x.md",
        title: "X",
        type: null,
        status: null,
        tags: [],
        contentHash: "h-old",
        frontmatter: {},
        created: null,
        updated: null,
        indexedAt: "x",
      },
      [{ chunkIndex: 0, text: "x" }],
      [],
    );
    expect(getStoredHash(db, "x.md")).toBe("h-old");

    setMeta(db, "parser_fingerprint", "v1");
    const invalidated = checkParserChanged(db, "v2");
    expect(invalidated).toBe(true);
    expect(getStoredHash(db, "x.md")).toBeNull();
  });
});

describe("vec_chunks dimension migration", () => {
  it("vecChunksDimension is null when embedding is disabled (no vec table)", () => {
    // The beforeEach db has embedding:null → vec_chunks never created.
    expect(vecChunksDimension(db)).toBeNull();
  });

  it.skipIf(!VEC_AVAILABLE)(
    "writer recreates vec_chunks at the new dimension on an embedder swap",
    () => {
      const p = path.join(tmpDir, "vec-migrate.db");

      // First boot: embedder at dim 4 → vec_chunks float[4], one vector stored.
      let h = openDatabase(makeConfigWithEmbedding(p, 4), { migrateVecDimension: true });
      expect(h.vecAvailable).toBe(true);
      expect(vecChunksDimension(h)).toBe(4);
      insertOneEmbedding(h, "e.md", "h1", [0.1, 0.2, 0.3, 0.4]);
      expect(vecRowCount(h)).toBe(1);
      h.close();

      // Embedder swapped to dim 8. Without the migration this reopen would keep
      // float[4] (IF NOT EXISTS) and the insert below would throw
      // "Dimension mismatch". The writer drops + recreates empty at float[8].
      h = openDatabase(makeConfigWithEmbedding(p, 8), { migrateVecDimension: true });
      expect(vecChunksDimension(h)).toBe(8);
      expect(vecRowCount(h)).toBe(0);
      insertOneEmbedding(h, "e.md", "h2", new Array(8).fill(0.5));
      expect(vecRowCount(h)).toBe(1);
      h.close();
    },
  );

  it.skipIf(!VEC_AVAILABLE)(
    "a read-only open (no migrateVecDimension) never touches vec_chunks dimension",
    () => {
      const p = path.join(tmpDir, "vec-reader.db");
      let h = openDatabase(makeConfigWithEmbedding(p, 4), { migrateVecDimension: true });
      expect(vecChunksDimension(h)).toBe(4);
      h.close();

      // Reader opens with a different configured dimension — must stay
      // non-mutating: the stale table survives, reader degrades to BM25.
      h = openDatabase(makeConfigWithEmbedding(p, 8));
      expect(vecChunksDimension(h)).toBe(4);
      h.close();
    },
  );

  it.skipIf(!VEC_AVAILABLE)(
    "re-opening at the same dimension preserves vec_chunks (idempotent)",
    () => {
      const p = path.join(tmpDir, "vec-idem.db");
      let h = openDatabase(makeConfigWithEmbedding(p, 4), { migrateVecDimension: true });
      insertOneEmbedding(h, "e.md", "h1", [1, 2, 3, 4]);
      expect(vecRowCount(h)).toBe(1);
      h.close();

      h = openDatabase(makeConfigWithEmbedding(p, 4), { migrateVecDimension: true });
      expect(vecChunksDimension(h)).toBe(4);
      expect(vecRowCount(h)).toBe(1); // not dropped — same dimension
      h.close();
    },
  );

  it.skipIf(!VEC_AVAILABLE)(
    "checkEmbeddingModelChanged clears stale vec_chunks on a SAME-dimension model swap",
    () => {
      // The dimension-mismatch drop above does NOT fire when only the model
      // name changes (same dim). Without checkEmbeddingModelChanged clearing the
      // vec mirror, the old model's vectors would linger and — under memoryd's
      // serve-first startup — be searched against a new-model query before the
      // background re-embed overwrites them. This guards that clear.
      const p = path.join(tmpDir, "vec-modelswap.db");

      // First boot: model A at dim 4, fingerprint set, one vector stored.
      let h = openDatabase(makeConfigWithEmbedding(p, 4), { migrateVecDimension: true });
      checkEmbeddingModelChanged(h, { model: "model-A", dimensions: 4 });
      insertOneEmbedding(h, "e.md", "h1", [0.1, 0.2, 0.3, 0.4]);
      expect(vecRowCount(h)).toBe(1);
      h.close();

      // Reboot: SAME dim 4, DIFFERENT model. migrateVecDimension preserves the
      // table (dim unchanged) — the stale vector survives until the model check.
      h = openDatabase(makeConfigWithEmbedding(p, 4), { migrateVecDimension: true });
      expect(vecChunksDimension(h)).toBe(4);
      expect(vecRowCount(h)).toBe(1); // still the OLD vector at this point

      const invalidated = checkEmbeddingModelChanged(h, { model: "model-B", dimensions: 4 });
      expect(invalidated).toBe(true);
      expect(vecRowCount(h)).toBe(0); // vec mirror cleared
      expect(getChunksWithoutEmbeddings(h, 10)).toHaveLength(1); // chunk awaits re-embed
      h.close();
    },
  );
});

describe("vec_chunks orphan protection (backfill ↔ reindex race, audit critical #1)", () => {
  it("storeChunkEmbeddings for a DEAD chunk id writes nothing (no orphan vec row)", () => {
    // The race: an embed batch holds chunk ids; while it awaits the endpoint,
    // the note is re-indexed (upsertDocument deletes + reinserts chunks under
    // NEW autoincrement ids). The returning batch must drop its vectors, not
    // resurrect the dead rowids in vec_chunks.
    upsertDocument(
      db,
      {
        path: "raced.md", title: "R", type: null, status: null, tags: [],
        contentHash: "h1", frontmatter: {}, created: null, updated: null, indexedAt: "x",
      },
      [{ chunkIndex: 0, text: "old content" }],
      [],
    );
    const staleId = getChunksWithoutEmbeddings(db, 1)[0]!.id;

    // Concurrent reindex of the same note → old chunks row is gone.
    upsertDocument(
      db,
      {
        path: "raced.md", title: "R", type: null, status: null, tags: [],
        contentHash: "h2", frontmatter: {}, created: null, updated: null, indexedAt: "x",
      },
      [{ chunkIndex: 0, text: "new content" }],
      [],
    );

    const buf = Buffer.from(new Float32Array([1, 2, 3]).buffer);
    storeChunkEmbeddings(db, [{ id: staleId, embedding: buf }]); // must not throw
    // The dead id got neither resurrected nor embedded; the NEW chunk still
    // waits in the NULL queue (it will re-embed on the next pass).
    const missing = getChunksWithoutEmbeddings(db, 10);
    expect(missing).toHaveLength(1);
    expect(missing[0]!.chunkText).toBe("new content");
  });

  it.skipIf(!VEC_AVAILABLE)(
    "the race leaves no vec_chunks row; gcOrphanVecChunks sweeps pre-fix leftovers",
    () => {
      const p = path.join(tmpDir, "vec-orphan.db");
      const h = openDatabase(makeConfigWithEmbedding(p, 4), { migrateVecDimension: true });
      insertOneEmbedding(h, "live.md", "h1", [1, 2, 3, 4]); // a legitimate row

      // Replay the race against a second note.
      upsertDocument(
        h,
        {
          path: "raced.md", title: "R", type: null, status: null, tags: [],
          contentHash: "h1", frontmatter: {}, created: null, updated: null, indexedAt: "x",
        },
        [{ chunkIndex: 0, text: "old content" }],
        [],
      );
      const staleId = getChunksWithoutEmbeddings(h, 1)[0]!.id;
      upsertDocument(
        h,
        {
          path: "raced.md", title: "R", type: null, status: null, tags: [],
          contentHash: "h2", frontmatter: {}, created: null, updated: null, indexedAt: "x",
        },
        [{ chunkIndex: 0, text: "new content" }],
        [],
      );
      storeChunkEmbeddings(h, [
        { id: staleId, embedding: Buffer.from(new Float32Array([9, 9, 9, 9]).buffer) },
      ]);
      expect(vecRowCount(h)).toBe(1); // only live.md's vector — no orphan

      // Pre-fix DBs may already carry orphans: plant one directly and GC it.
      h.prepare("INSERT INTO vec_chunks(rowid, embedding) VALUES (?, ?)").run(
        999_999,
        Buffer.from(new Float32Array([7, 7, 7, 7]).buffer),
      );
      expect(vecRowCount(h)).toBe(2);
      expect(gcOrphanVecChunks(h)).toBe(1);
      expect(vecRowCount(h)).toBe(1); // live row untouched
      expect(gcOrphanVecChunks(h)).toBe(0); // steady-state no-op
      h.close();
    },
  );

  it("gcOrphanVecChunks is a no-op without vec support", () => {
    expect(gcOrphanVecChunks(db)).toBe(0);
  });
});
