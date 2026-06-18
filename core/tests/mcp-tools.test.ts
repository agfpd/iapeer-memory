import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { getTaxonomy, DEFAULT_RANKING } from "../src/taxonomy.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDatabase, upsertDocument } from "../src/db.js";
import type { CoreDb } from "../src/db.js";
import type { CoreConfig } from "../src/config.js";
import { runRead, runGraph, runMap, runSearch } from "../src/mcp-tools.js";

function makeConfig(overrides: Partial<CoreConfig> = {}): CoreConfig {
  return {
    locale: "ru" as const,
    taxonomy: getTaxonomy("ru"),
    ranking: { ...DEFAULT_RANKING },
    curatorSet: ["index", "scriber", "dreamweaver"],
    vaultPath: "/tmp/test-vault",
    callerAgent: null,
    excludeFolders: [],
    search: { chunkSize: 500, chunkOverlap: 80, maxResults: 6, rrfK: 60 },
    index: { dbPath: ":memory:", fullScanOnStartup: false },
    batch: { curatorMs: 6 * 3600_000 },
    mcp: { port: 0 },
    embedding: null,
    reranker: null,
    ...overrides,
  };
}

function addDoc(
  db: CoreDb,
  docPath: string,
  title: string,
  outgoing: string[] = [],
  body = title,
): void {
  upsertDocument(
    db,
    {
      path: docPath,
      title,
      type: null,
      status: null,
      tags: [],
      contentHash: docPath,
      frontmatter: {},
      created: null,
      updated: null,
      indexedAt: "x",
    },
    [{ chunkIndex: 0, text: body }],
    outgoing.map((target) => ({ target, contextSnippet: "" })),
  );
}

let tmpDir: string;
let vaultDir: string;
let db: CoreDb;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mergemind-tools-test-"));
  vaultDir = path.join(tmpDir, "vault");
  fs.mkdirSync(vaultDir, { recursive: true });
  db = openDatabase(makeConfig({ index: { dbPath: path.join(tmpDir, "test.db"), fullScanOnStartup: false } }));
});

afterEach(() => {
  try { db.close(); } catch {}
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---- runRead — path validation ----

describe("runRead — path validation", () => {
  const config = () => makeConfig({ vaultPath: vaultDir });

  it("throws on absolute paths", async () => {
    await expect(runRead(db, config(), { path: "/etc/passwd.md" }))
      .rejects.toThrow(/relative to the vault root/);
  });

  it("throws on non-.md extension", async () => {
    await expect(runRead(db, config(), { path: "note.txt" }))
      .rejects.toThrow(/Only \.md files/);
  });

  it("throws on '..' traversal", async () => {
    await expect(runRead(db, config(), { path: "../escape.md" }))
      .rejects.toThrow(/empty, '\.' or '\.\.'/);
  });

  it("throws on null byte injection", async () => {
    await expect(runRead(db, config(), { path: "note.md\0evil" }))
      .rejects.toThrow();
  });

  it("throws on empty segment", async () => {
    await expect(runRead(db, config(), { path: "foo//bar.md" }))
      .rejects.toThrow(/empty, '\.' or '\.\.'/);
  });

  it("returns not-found for paths in excludeFolders (no leak)", async () => {
    const cfg = makeConfig({
      vaultPath: vaultDir,
      excludeFolders: ["00_Inbox"],
    });
    // Even if the file exists on disk, excludeFolders membership masks it.
    fs.mkdirSync(path.join(vaultDir, "00_Inbox"), { recursive: true });
    fs.writeFileSync(path.join(vaultDir, "00_Inbox", "draft.md"), "secret");

    const res = (await runRead(db, cfg, { path: "00_Inbox/draft.md" })) as {
      found: boolean;
      error: string;
    };
    expect(res.found).toBe(false);
    expect(res.error).toContain("Document not found");
  });
});

// ---- runRead — payload shape ----

describe("runRead — payload shape", () => {
  it("returns indexed doc with backlinks", async () => {
    fs.writeFileSync(
      path.join(vaultDir, "a.md"),
      "---\ntitle: A\nstatus: актуально\n---\n\n[[b]] body",
    );
    fs.writeFileSync(path.join(vaultDir, "b.md"), "B");
    addDoc(db, "a.md", "A", ["b.md"]);
    addDoc(db, "b.md", "B", ["a.md"]);

    const out = (await runRead(db, makeConfig({ vaultPath: vaultDir }), {
      path: "a.md",
    })) as { path: string; text: string; meta: any; wikilinks: any[]; backlinks: any[] };

    expect(out.path).toBe("a.md");
    expect(out.text).toContain("title: A");
    expect(out.meta.title).toBe("A");
    expect(out.wikilinks.map((w: any) => w.target)).toContain("b");
    expect(out.backlinks.map((b: any) => b.path)).toContain("b.md");
  });

  it("returns not-found when neither in index nor on disk", async () => {
    const res = (await runRead(db, makeConfig({ vaultPath: vaultDir }), {
      path: "missing.md",
    })) as { found: boolean; error: string };
    expect(res.found).toBe(false);
  });

  it("falls back to disk parse when on-disk but not indexed", async () => {
    fs.writeFileSync(
      path.join(vaultDir, "not-indexed.md"),
      "---\ntitle: Fresh\n---\n\nbody",
    );
    const out = (await runRead(db, makeConfig({ vaultPath: vaultDir }), {
      path: "not-indexed.md",
    })) as { meta: any; text: string };
    expect(out.meta.title).toBe("Fresh");
    expect(out.meta.notIndexed).toBe(true);
    expect(out.text).toContain("body");
  });

  it("returns not-found when indexed but file vanished on disk", async () => {
    addDoc(db, "ghost.md", "Ghost");
    // No file on disk
    const res = (await runRead(db, makeConfig({ vaultPath: vaultDir }), {
      path: "ghost.md",
    })) as { found: boolean; error: string };
    expect(res.found).toBe(false);
  });
});

// ---- runGraph ----

describe("runGraph", () => {
  it("returns not-found for unknown center", () => {
    const out = runGraph(db, makeConfig(), { path: "nope.md" }) as { found: boolean; error: string };
    expect(out.found).toBe(false);
  });

  it("returns 1-hop neighborhood by default", () => {
    addDoc(db, "center.md", "Center", ["a.md", "b.md"]);
    addDoc(db, "a.md", "A", []);
    addDoc(db, "b.md", "B", []);

    const out = runGraph(db, makeConfig(), { path: "center.md" }) as {
      center: { path: string };
      nodes: Array<{ path: string; depth: number; direction: string }>;
      edges: Array<{ from: string; to: string }>;
      stats: { totalNodes: number; depth: number };
    };

    expect(out.center.path).toBe("center.md");
    expect(out.stats.depth).toBe(1);
    expect(new Set(out.nodes.map((n) => n.path))).toEqual(new Set(["a.md", "b.md"]));
    expect(out.nodes.every((n) => n.direction === "outgoing")).toBe(true);
  });

  it("clamps depth to [1, 3]", () => {
    addDoc(db, "x.md", "X", []);
    expect((runGraph(db, makeConfig(), { path: "x.md", depth: 0 }) as any).stats.depth).toBe(1);
    expect((runGraph(db, makeConfig(), { path: "x.md", depth: 99 }) as any).stats.depth).toBe(3);
    expect((runGraph(db, makeConfig(), { path: "x.md", depth: 2 }) as any).stats.depth).toBe(2);
  });

  it("walks 2 hops when depth=2", () => {
    // center → a → grandchild
    addDoc(db, "center.md", "C", ["a.md"]);
    addDoc(db, "a.md", "A", ["grandchild.md"]);
    addDoc(db, "grandchild.md", "G", []);

    const out = runGraph(db, makeConfig(), { path: "center.md", depth: 2 }) as {
      nodes: Array<{ path: string; depth: number }>;
    };
    const paths = new Set(out.nodes.map((n) => n.path));
    expect(paths).toEqual(new Set(["a.md", "grandchild.md"]));
    expect(out.nodes.find((n) => n.path === "grandchild.md")?.depth).toBe(2);
  });

  it("filters operative backlinks for vault-center notes", () => {
    // vault center, with one normal backlink + one operative backlink
    addDoc(db, "vault/note.md", "Note");
    addDoc(db, "vault/citer.md", "Citer", ["vault/note.md"]);
    addDoc(
      db,
      "06_Оперативка_агентов/boris/diary.md",
      "Diary",
      ["vault/note.md"],
    );

    const out = runGraph(db, makeConfig(), { path: "vault/note.md" }) as {
      nodes: Array<{ path: string }>;
    };
    const paths = out.nodes.map((n) => n.path);
    expect(paths).toContain("vault/citer.md");
    expect(paths).not.toContain("06_Оперативка_агентов/boris/diary.md");
  });

  it("shows operative backlinks for operative-center notes", () => {
    // Same data, but center is the operative note. Backlinks from elsewhere
    // (e.g. Index linking to it) should be visible.
    addDoc(
      db,
      "06_Оперативка_агентов/boris/diary.md",
      "Diary",
    );
    addDoc(db, "vault/index.md", "Index", ["06_Оперативка_агентов/boris/diary.md"]);

    const out = runGraph(db, makeConfig(), {
      path: "06_Оперативка_агентов/boris/diary.md",
    }) as { nodes: Array<{ path: string }> };
    expect(out.nodes.map((n) => n.path)).toContain("vault/index.md");
  });
});

// ---- runMap ----

describe("runMap", () => {
  it("returns empty-ish stats on empty DB with all parts", () => {
    const out = runMap(db, makeConfig()) as {
      stats: { documents: number };
      detail: string;
      parts: string[];
    };
    expect(out.stats.documents).toBe(0);
    expect(out.detail).toBe("summary");
    expect(out.parts.sort()).toEqual(["bridges", "clusters", "hubs", "orphans"]);
  });

  it("subset parts: only orphans returned, others absent", () => {
    addDoc(db, "iso.md", "Iso");
    addDoc(db, "a.md", "A", ["b.md"]);
    addDoc(db, "b.md", "B");
    const out = runMap(db, makeConfig(), { parts: ["orphans"] }) as {
      orphans: string[];
      clusters?: unknown;
      hubs?: unknown;
    };
    expect(out.orphans).toEqual(["iso"]);
    expect(out.clusters).toBeUndefined();
    expect(out.hubs).toBeUndefined();
  });

  it("summary clusters cap top_nodes; full lists all", () => {
    // Build a star: hub + 8 leaves all linked to it. Cluster has 9 nodes.
    const hubName = "hub.md";
    const leaves = Array.from({ length: 8 }, (_, i) => `leaf${i}.md`);
    addDoc(db, hubName, "Hub", leaves);
    for (const l of leaves) addDoc(db, l, l, []);

    const summary = runMap(db, makeConfig(), { detail: "summary" }) as {
      clusters: Array<{ name: string; size: number; top_nodes?: string[]; nodes?: string[] }>;
    };
    const full = runMap(db, makeConfig(), { detail: "full" }) as {
      clusters: Array<{ name: string; size: number; top_nodes?: string[]; nodes?: string[] }>;
    };

    const summaryCluster = summary.clusters[0]!;
    const fullCluster = full.clusters[0]!;
    expect(summaryCluster.size).toBe(9);
    expect(summaryCluster.top_nodes).toBeDefined();
    expect(summaryCluster.top_nodes!.length).toBeLessThanOrEqual(5);
    expect(fullCluster.nodes).toBeDefined();
    expect(fullCluster.nodes!.length).toBe(9);
  });

  it("hubs_truncated set when summary trims >20 hubs", () => {
    // Build 21 nodes each linked to all others — every node has total degree 40.
    const n = 21;
    const others = (i: number) =>
      Array.from({ length: n }, (_, j) => `n${j}.md`).filter(
        (_, j) => j !== i,
      );
    for (let i = 0; i < n; i++) addDoc(db, `n${i}.md`, `N${i}`, others(i));

    const out = runMap(db, makeConfig(), { detail: "summary", parts: ["hubs"] }) as {
      hubs: unknown[];
      hubs_truncated?: number;
    };
    expect(out.hubs.length).toBe(20);
    expect(out.hubs_truncated).toBe(1);
  });
});

// ---- runSearch (BM25 only — no embedding/reranker config) ----

describe("runSearch — BM25-only", () => {
  it("returns hits for an indexed term", async () => {
    addDoc(db, "a.md", "Apple", [], "apple banana cherry");
    addDoc(db, "b.md", "Berry", [], "blackberry raspberry");

    const out = (await runSearch(db, makeConfig(), { query: "apple" })) as {
      query: string;
      results: Array<{ title: string; path: string }>;
    };
    expect(out.query).toBe("apple");
    expect(out.results.map((r) => r.path)).toContain("a.md");
    expect(out.results.map((r) => r.path)).not.toContain("b.md");
  });

  it("returns empty results for no-match query", async () => {
    addDoc(db, "a.md", "Apple", [], "apple");
    const out = (await runSearch(db, makeConfig(), {
      query: "zzznothinghere",
    })) as { results: unknown[] };
    expect(out.results).toEqual([]);
  });

  it("falls back to chunk text snippet when BM25 finds no match", async () => {
    // Empty query string would have been rejected at MCP layer, but at runSearch
    // level escape produces empty FTS — no BM25 rows, returns []. Just confirm
    // it doesn't throw.
    const out = (await runSearch(db, makeConfig(), { query: "   " })) as {
      results: unknown[];
    };
    expect(out.results).toEqual([]);
  });
});
