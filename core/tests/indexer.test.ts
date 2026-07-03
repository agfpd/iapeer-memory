import { describe, it, expect, beforeEach, afterEach, vi } from "bun:test";
import { getTaxonomy, DEFAULT_RANKING } from "../src/taxonomy.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  openDatabase,
  getUnresolvedLinks,
  getChunksWithoutEmbeddings,
  countChunksWithoutEmbeddings,
} from "../src/db.js";
import type { CoreDb } from "../src/db.js";
import type { CoreConfig } from "../src/config.js";
import { indexAll, embedMissingChunks } from "../src/indexer.js";
import { _resetEmbeddingCircuitForTests } from "../src/embedding.js";
import { runMap } from "../src/mcp-tools.js";

const noopLogger = { info: () => {}, warn: () => {}, error: () => {} };

function makeConfig(vaultPath: string, dbPath: string): CoreConfig {
  return {
    locale: "ru" as const,
    taxonomy: getTaxonomy("ru"),
    ranking: { ...DEFAULT_RANKING },
    curatorSet: ["index", "scriber", "dreamweaver"],
    vaultPath,
    callerAgent: null,
    excludeFolders: ["99_Система"],
    search: { chunkSize: 500, chunkOverlap: 80, maxResults: 6, rrfK: 60 },
    index: { dbPath, fullScanOnStartup: true },
    batch: { curatorMs: 6 * 3600_000 },
    mcp: { port: 0 },
    embedding: null,
    reranker: null,
  };
}

let tmpDir: string;
let vault: string;
let db: CoreDb;
let config: CoreConfig;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mergemind-indexer-test-"));
  vault = path.join(tmpDir, "vault");
  fs.mkdirSync(path.join(vault, "01_Знания"), { recursive: true });
  config = makeConfig(vault, path.join(tmpDir, "test.db"));
  db = openDatabase(config);
});

afterEach(() => {
  try { db.close(); } catch {}
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeNote(rel: string, body: string): void {
  const full = path.join(vault, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, body);
}

function edgeTargets(sourceLike: string): string[] {
  return (
    db
      .prepare("SELECT target_path FROM edges WHERE source_path LIKE ?")
      .all(`%${sourceLike}`) as Array<{ target_path: string }>
  ).map((r) => r.target_path);
}

describe("indexAll — Audit #1: titleToPath covers unchanged files", () => {
  it("a new note linking an UNCHANGED note resolves (edge not silently dropped on restart)", async () => {
    // 1. Existing note, no links. Index it.
    writeNote("01_Знания/Existing.md", "---\ntitle: Existing\n---\n\nbody");
    await indexAll({ db, config, logger: noopLogger });

    // 2. Re-scan with nothing changed (clean restart). Existing is unchanged →
    //    hits the hash early-return path. Before the fix its title was NOT
    //    registered here, so step 3's edge would be deleted.
    await indexAll({ db, config, logger: noopLogger });

    // 3. Add a brand-new note that links the unchanged note.
    writeNote("01_Знания/New.md", "---\ntitle: New\n---\n\nsee [[Existing]]");
    const titleToPath = await indexAll({ db, config, logger: noopLogger });

    // The unchanged note must be in the title map even though it was skipped.
    expect(titleToPath.get("Existing")).toEqual([
      expect.stringMatching(/01_Знания\/Existing\.md$/),
    ]);

    // And the edge must be resolved to the real path, not removed.
    const targets = edgeTargets("New.md");
    expect(targets.length).toBe(1);
    expect(targets[0]).toMatch(/01_Знания\/Existing\.md$/);
    expect(targets[0]).not.toBe("Existing"); // resolved, not left bare
  });

  it("idempotent: re-running indexAll on an unchanged vault keeps edges", async () => {
    writeNote("01_Знания/A.md", "---\ntitle: A\n---\n\nlink to [[B]]");
    writeNote("01_Знания/B.md", "---\ntitle: B\n---\n\nplain");
    await indexAll({ db, config, logger: noopLogger });
    const before = edgeTargets("A.md");
    expect(before).toEqual([expect.stringMatching(/01_Знания\/B\.md$/)]);

    // Nothing changed — second pass must not drop the resolved edge.
    await indexAll({ db, config, logger: noopLogger });
    expect(edgeTargets("A.md")).toEqual(before);
  });
});

describe("resolveWikilinks — Audit #3 (path-aware) + #5 (observable)", () => {
  it("a missing link is recorded as unresolved 'missing', not silently dropped", async () => {
    writeNote("01_Знания/A.md", "---\ntitle: A\n---\n\nsee [[Ghost]]");
    await indexAll({ db, config, logger: noopLogger });

    expect(edgeTargets("A.md")).toEqual([]); // not in the resolved graph
    const u = getUnresolvedLinks(db);
    expect(u).toHaveLength(1);
    expect(u[0]!.source).toMatch(/01_Знания\/A\.md$/);
    expect(u[0]!.target).toBe("Ghost");
    expect(u[0]!.reason).toBe("missing");
  });

  it("a bare basename shared by 2 folders is 'ambiguous' — never last-writer", async () => {
    writeNote("01_Знания/Dup.md", "---\ntitle: Dup\n---\n\nknowledge");
    writeNote("04_Идеи/Dup.md", "---\ntitle: Dup\n---\n\nidea");
    writeNote("01_Знания/C.md", "---\ntitle: C\n---\n\nlink [[Dup]]");
    await indexAll({ db, config, logger: noopLogger });

    // The ambiguous link must NOT have resolved to either Dup.
    expect(edgeTargets("C.md")).toEqual([]);
    const u = getUnresolvedLinks(db).filter((x) => x.source.endsWith("C.md"));
    expect(u).toHaveLength(1);
    expect(u[0]!.reason).toBe("ambiguous");
  });

  it("an explicit path resolves exactly even when the basename is ambiguous", async () => {
    writeNote("01_Знания/Dup.md", "---\ntitle: Dup\n---\n\nknowledge");
    writeNote("04_Идеи/Dup.md", "---\ntitle: Dup\n---\n\nidea");
    writeNote("01_Знания/E.md", "---\ntitle: E\n---\n\nlink [[04_Идеи/Dup]]");
    await indexAll({ db, config, logger: noopLogger });

    const targets = edgeTargets("E.md");
    expect(targets).toHaveLength(1);
    expect(targets[0]).toMatch(/04_Идеи\/Dup\.md$/);
    expect(getUnresolvedLinks(db).filter((x) => x.source.endsWith("E.md"))).toEqual([]);
  });

  it("self-heals: an unresolved link is promoted once its target appears", async () => {
    writeNote("01_Знания/B.md", "---\ntitle: B\n---\n\nsee [[Later]]");
    await indexAll({ db, config, logger: noopLogger });
    expect(getUnresolvedLinks(db)).toHaveLength(1);
    expect(edgeTargets("B.md")).toEqual([]);

    // The target appears on a later pass — link must self-heal.
    writeNote("04_Идеи/Later.md", "---\ntitle: Later\n---\n\nhere now");
    await indexAll({ db, config, logger: noopLogger });
    expect(getUnresolvedLinks(db)).toEqual([]);
    expect(edgeTargets("B.md")).toEqual([
      expect.stringMatching(/04_Идеи\/Later\.md$/),
    ]);
  });

  it("memory_map: count rides in stats; detail is opt-in (orphan_wikilinks part)", async () => {
    writeNote("01_Знания/A.md", "---\ntitle: A\n---\n\nbroken [[Nope]]");
    await indexAll({ db, config, logger: noopLogger });

    // Default call: count visible in stats, detail NOT in payload.
    const def = runMap(db, config) as {
      stats: { orphan_wikilinks: number };
      orphan_wikilinks?: unknown;
      parts: string[];
    };
    expect(def.stats.orphan_wikilinks).toBe(1);
    expect(def.orphan_wikilinks).toBeUndefined();
    expect(def.parts).not.toContain("orphan_wikilinks");

    // Opt-in: explicit part returns source / raw target / reason.
    const detail = runMap(db, config, { parts: ["orphan_wikilinks"] }) as {
      orphan_wikilinks: Array<{ source: string; target: string; reason: string }>;
    };
    expect(detail.orphan_wikilinks).toHaveLength(1);
    expect(detail.orphan_wikilinks[0]!.target).toBe("Nope");
    expect(detail.orphan_wikilinks[0]!.reason).toBe("missing");
  });
});

describe("indexAll — deferred embedding (serve-first background backfill)", () => {
  const DIMS = 8;

  function embedConfig(): CoreConfig {
    return {
      ...makeConfig(vault, path.join(tmpDir, "embed.db")),
      embedding: {
        endpoint: "http://fake/v1/embeddings",
        model: "fake-model",
        dimensions: DIMS,
        batchSize: 32,
        apiKey: null,
      },
    };
  }

  // Mock the embedder so the count returned matches each request's input
  // count (indexer maps result.vectors[i] per missing chunk — a short array
  // would throw). Returns the spy so tests can assert call/no-call.
  function mockEmbedder() {
    return vi
      .spyOn(
        globalThis as unknown as { fetch: (...args: unknown[]) => Promise<Response> },
        "fetch",
      )
      .mockImplementation(async (...args: unknown[]) => {
        const init = args[1] as { body?: unknown } | undefined;
        const body = JSON.parse(String(init?.body ?? "{}")) as { input?: string[] };
        const n = Array.isArray(body.input) ? body.input.length : 1;
        const vecs = Array.from({ length: n }, () =>
          Array.from({ length: DIMS }, () => 0.1),
        );
        return new Response(
          JSON.stringify({ data: vecs.map((v) => ({ embedding: v })) }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      });
  }

  let edb: CoreDb;
  beforeEach(() => _resetEmbeddingCircuitForTests());
  afterEach(() => {
    try { edb?.close(); } catch {}
    vi.restoreAllMocks();
  });

  it("embed:false indexes structurally but leaves embeddings NULL (embedder untouched)", async () => {
    writeNote("01_Знания/A.md", "---\ntitle: A\n---\nalpha body content for chunking");
    const fetchSpy = mockEmbedder();
    const cfg = embedConfig();
    edb = openDatabase(cfg);

    await indexAll({ db: edb, config: cfg, logger: noopLogger, embed: false });

    // structural work happened — chunks exist — but none are embedded yet
    expect(countChunksWithoutEmbeddings(edb)).toBeGreaterThan(0);
    expect(getChunksWithoutEmbeddings(edb, 100).length).toBeGreaterThan(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("default (embed:true) embeds inline — back-compat for incremental/CLI callers", async () => {
    writeNote("01_Знания/B.md", "---\ntitle: B\n---\nbeta body content for chunking");
    const fetchSpy = mockEmbedder();
    const cfg = embedConfig();
    edb = openDatabase(cfg);

    await indexAll({ db: edb, config: cfg, logger: noopLogger });

    expect(countChunksWithoutEmbeddings(edb)).toBe(0);
    expect(fetchSpy).toHaveBeenCalled();
  });

  it("embedMissingChunks fills deferred embeddings, then is a no-op (restart-safe)", async () => {
    writeNote("01_Знания/C.md", "---\ntitle: C\n---\ngamma body content for chunking");
    mockEmbedder();
    const cfg = embedConfig();
    edb = openDatabase(cfg);
    await indexAll({ db: edb, config: cfg, logger: noopLogger, embed: false });

    const pending = countChunksWithoutEmbeddings(edb);
    expect(pending).toBeGreaterThan(0);

    const n = await embedMissingChunks({ db: edb, config: cfg, logger: noopLogger });
    expect(n).toBe(pending);
    expect(countChunksWithoutEmbeddings(edb)).toBe(0);

    // re-run resumes from "what's still missing" → nothing to do
    const n2 = await embedMissingChunks({ db: edb, config: cfg, logger: noopLogger });
    expect(n2).toBe(0);
  });

  it("embedMissingChunks honours shouldStop — bails before touching the embedder", async () => {
    writeNote("01_Знания/D.md", "---\ntitle: D\n---\ndelta body content for chunking");
    const fetchSpy = mockEmbedder();
    const cfg = embedConfig();
    edb = openDatabase(cfg);
    await indexAll({ db: edb, config: cfg, logger: noopLogger, embed: false });

    const before = countChunksWithoutEmbeddings(edb);
    const n = await embedMissingChunks({
      db: edb,
      config: cfg,
      logger: noopLogger,
      shouldStop: () => true,
    });

    expect(n).toBe(0);
    expect(countChunksWithoutEmbeddings(edb)).toBe(before); // unchanged
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("indexAll — eviction ≠ deletion (audit critical #2)", () => {
  function docCount(): number {
    return (db.prepare("SELECT COUNT(*) AS n FROM documents").get() as { n: number }).n;
  }

  it("a small legitimate deletion still prunes the index", async () => {
    writeNote("01_Знания/A.md", "---\ntitle: A\n---\nbody a");
    writeNote("01_Знания/B.md", "---\ntitle: B\n---\nbody b");
    await indexAll({ db, config, logger: noopLogger });
    expect(docCount()).toBe(2);

    fs.rmSync(path.join(vault, "01_Знания/B.md"));
    await indexAll({ db, config, logger: noopLogger });
    expect(docCount()).toBe(1); // the fuse must not block routine deletions
  });

  it("an unreadable file (iCloud dataless offline / EACCES) is skipped, NOT deleted", async () => {
    writeNote("01_Знания/Evicted.md", "---\ntitle: Evicted\n---\nprecious body");
    await indexAll({ db, config, logger: noopLogger });
    expect(docCount()).toBe(1);

    // Simulate the read-failure window: readdir sees the entry, read throws.
    fs.chmodSync(path.join(vault, "01_Знания/Evicted.md"), 0o000);
    try {
      await indexAll({ db, config, logger: noopLogger });
    } finally {
      fs.chmodSync(path.join(vault, "01_Знания/Evicted.md"), 0o644);
    }
    expect(docCount()).toBe(1); // still indexed — the last-parsed copy keeps serving
  });

  it("a legacy .icloud placeholder counts as the note existing", async () => {
    writeNote("01_Знания/Cloudy.md", "---\ntitle: Cloudy\n---\ncloud body");
    await indexAll({ db, config, logger: noopLogger });
    expect(docCount()).toBe(1);

    // macOS <12.3 eviction: the note is replaced by a hidden placeholder.
    fs.rmSync(path.join(vault, "01_Знания/Cloudy.md"));
    writeNote("01_Знания/.Cloudy.md.icloud", "placeholder-blob");
    await indexAll({ db, config, logger: noopLogger });
    expect(docCount()).toBe(1); // eviction is not deletion
  });

  it("a ZERO-file scan over a non-empty corpus never wipes the index", async () => {
    writeNote("01_Знания/Only.md", "---\ntitle: Only\n---\nbody");
    await indexAll({ db, config, logger: noopLogger });
    expect(docCount()).toBe(1);

    // iCloud re-sync window: the root exists but no entries materialised yet.
    fs.rmSync(path.join(vault, "01_Знания"), { recursive: true });
    await indexAll({ db, config, logger: noopLogger });
    expect(docCount()).toBe(1); // refused — corpus intact
  });

  it("a vanished root (TOCTOU / unmount) skips deletion entirely", async () => {
    writeNote("01_Знания/Rooted.md", "---\ntitle: Rooted\n---\nbody");
    await indexAll({ db, config, logger: noopLogger });
    expect(docCount()).toBe(1);

    fs.rmSync(vault, { recursive: true });
    await indexAll({ db, config, logger: noopLogger });
    expect(docCount()).toBe(1);
    fs.mkdirSync(path.join(vault, "01_Знания"), { recursive: true }); // restore for afterEach
  });

  it("mass-delete fuse: >min-count AND >20% of the corpus gone at once is refused", async () => {
    // 12 notes → delete all 12: both thresholds (count>10, fraction>0.2) trip.
    for (let i = 0; i < 12; i++) writeNote(`01_Знания/N${i}.md`, `---\ntitle: N${i}\n---\nbody ${i}`);
    writeNote("01_Знания/Keeper.md", "---\ntitle: Keeper\n---\nstays");
    await indexAll({ db, config, logger: noopLogger });
    expect(docCount()).toBe(13);

    for (let i = 0; i < 12; i++) fs.rmSync(path.join(vault, `01_Знания/N${i}.md`));
    await indexAll({ db, config, logger: noopLogger });
    expect(docCount()).toBe(13); // refused — partial-sync suspicion

    // The conscious operator override lets the bulk cleanup through.
    process.env.IAPEER_MEMORY_ALLOW_MASS_DELETE = "1";
    try {
      await indexAll({ db, config, logger: noopLogger });
    } finally {
      delete process.env.IAPEER_MEMORY_ALLOW_MASS_DELETE;
    }
    expect(docCount()).toBe(1);
  });
});

describe("indexAll — incremental mode (audit important: O(changed), not O(vault))", () => {
  function doc(rel: string) {
    return db.prepare("SELECT path, title, content_hash FROM documents WHERE path = ?").get(rel.normalize("NFD")) as
      | { path: string; title: string; content_hash: string }
      | null;
  }

  it("re-indexes ONLY the changed path; links to unchanged notes still resolve", async () => {
    writeNote("01_Знания/Стабильная.md", "---\ntitle: Стабильная\n---\nстарое тело");
    writeNote("01_Знания/Правленая.md", "---\ntitle: Правленая\n---\nссылка на [[Стабильная]]");
    await indexAll({ db, config, logger: noopLogger }); // full baseline

    writeNote("01_Знания/Правленая.md", "---\ntitle: Правленая\n---\nновое тело, ссылка на [[Стабильная]]");
    await indexAll({
      db,
      config,
      logger: noopLogger,
      changedPaths: [path.join(vault, "01_Знания/Правленая.md")],
    });

    // the change landed…
    const chunks = db
      .prepare("SELECT chunk_text FROM chunks WHERE doc_path = ?")
      .all("01_Знания/Правленая.md".normalize("NFD")) as Array<{ chunk_text: string }>;
    expect(chunks.map((c) => c.chunk_text).join(" ")).toContain("новое тело");
    // …and the edge to the UNTOUCHED note resolved through the DB title map.
    expect(edgeTargets("Правленая.md")).toEqual(["01_Знания/Стабильная.md".normalize("NFD")]);
  });

  it("a changed path missing on disk is deleted TARGETEDLY; incoming links park in unresolved_links", async () => {
    writeNote("01_Знания/Цель.md", "---\ntitle: Цель\n---\nтело цели");
    writeNote("01_Знания/Источник.md", "---\ntitle: Источник\n---\nсм. [[Цель]]");
    await indexAll({ db, config, logger: noopLogger });
    expect(doc("01_Знания/Цель.md")).not.toBeNull();

    fs.rmSync(path.join(vault, "01_Знания/Цель.md"));
    await indexAll({
      db,
      config,
      logger: noopLogger,
      changedPaths: [path.join(vault, "01_Знания/Цель.md")],
    });

    expect(doc("01_Знания/Цель.md")).toBeNull(); // gone from the index
    expect(doc("01_Знания/Источник.md")).not.toBeNull(); // untouched survivor
    // the broken link is VISIBLE (health) and self-heal-able, not silently dropped
    const unresolved = getUnresolvedLinks(db);
    expect(unresolved).toEqual([
      { source: "01_Знания/Источник.md".normalize("NFD"), target: "Цель", reason: "missing" },
    ]);

    // …and self-heals when the note returns.
    writeNote("01_Знания/Цель.md", "---\ntitle: Цель\n---\nтело вернулось");
    await indexAll({
      db,
      config,
      logger: noopLogger,
      changedPaths: [path.join(vault, "01_Знания/Цель.md")],
    });
    expect(getUnresolvedLinks(db)).toEqual([]);
    expect(edgeTargets("Источник.md")).toEqual(["01_Знания/Цель.md".normalize("NFD")]);
  });

  it("a rename delivered as one changed set repoints incoming edges (move-aware)", async () => {
    writeNote("01_Знания/Старое имя заметки.md", "---\ntitle: Старое имя заметки\n---\nтело");
    writeNote("01_Знания/Ссылающаяся.md", "---\ntitle: Ссылающаяся\n---\nсм. [[Старое имя заметки]]");
    await indexAll({ db, config, logger: noopLogger });

    // archive-style move: same basename, new folder
    fs.mkdirSync(path.join(vault, "07_Архив"), { recursive: true });
    fs.renameSync(
      path.join(vault, "01_Знания/Старое имя заметки.md"),
      path.join(vault, "07_Архив/Старое имя заметки.md"),
    );
    await indexAll({
      db,
      config,
      logger: noopLogger,
      changedPaths: [
        path.join(vault, "07_Архив/Старое имя заметки.md"), // new location indexes first
        path.join(vault, "01_Знания/Старое имя заметки.md"), // old location gone
      ],
    });

    expect(doc("07_Архив/Старое имя заметки.md")).not.toBeNull();
    expect(doc("01_Знания/Старое имя заметки.md")).toBeNull();
    // incoming edge FOLLOWED the move — no unresolved entry
    expect(edgeTargets("Ссылающаяся.md")).toEqual(["07_Архив/Старое имя заметки.md".normalize("NFD")]);
    expect(getUnresolvedLinks(db)).toEqual([]);
  });

  it("changed paths in excluded folders and outside the vault are ignored", async () => {
    writeNote("99_Система/Теги.md", "---\ntitle: Теги\n---\nслужебное");
    await indexAll({
      db,
      config,
      logger: noopLogger,
      changedPaths: [
        path.join(vault, "99_Система/Теги.md"),
        "/somewhere/else/outside.md",
      ],
    });
    expect(doc("99_Система/Теги.md")).toBeNull();
  });
});
