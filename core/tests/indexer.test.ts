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
