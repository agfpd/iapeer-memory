import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { getTaxonomy, DEFAULT_RANKING } from "../src/taxonomy.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDatabase, upsertDocument } from "../src/db.js";
import type { CoreDb } from "../src/db.js";
import type { CoreConfig } from "../src/config.js";
import { buildVaultMap } from "../src/graph.js";

function makeConfig(dbPath: string): CoreConfig {
  return {
    locale: "ru" as const,
    taxonomy: getTaxonomy("ru"),
    ranking: { ...DEFAULT_RANKING },
    curatorSet: ["index", "scriber", "dreamweaver"],
    vaultPath: "/tmp/test-vault",
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

// Add a fully-populated document with a list of outgoing edges. Used by
// every test case to build a synthetic graph in a few lines.
function addDoc(
  db: CoreDb,
  docPath: string,
  title: string,
  outgoing: string[],
  tags: string[] = [],
): void {
  upsertDocument(
    db,
    {
      path: docPath,
      title,
      type: null,
      status: null,
      tags,
      contentHash: docPath,
      frontmatter: {},
      created: null,
      updated: null,
      indexedAt: "x",
    },
    [{ chunkIndex: 0, text: title }],
    outgoing.map((target) => ({ target, contextSnippet: "" })),
  );
}

let tmpDir: string;
let db: CoreDb;
let cfg: CoreConfig;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mergemind-graph-test-"));
  cfg = makeConfig(path.join(tmpDir, "test.db"));
  db = openDatabase(cfg);
});

afterEach(() => {
  try { db.close(); } catch {}
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("buildVaultMap — archive excluded from the live-canon topology", () => {
  const K = getTaxonomy("ru").folders.knowledge;
  const ARCH = getTaxonomy("ru").folders.archive;

  it("archived notes never appear as nodes/orphans/hubs; the active→archive health signal survives", () => {
    // Live cluster A↔B; an active C whose only link points INTO the archive;
    // the archived note itself. The archive node must be absent everywhere in
    // the topology, yet the forbidden C→archive edge must still be flagged.
    addDoc(db, `${K}/A.md`, "A", [`${K}/B.md`]);
    addDoc(db, `${K}/B.md`, "B", []);
    addDoc(db, `${K}/C.md`, "C", [`${ARCH}/Old.md`]); // forbidden active→archive
    addDoc(db, `${ARCH}/Old.md`, "Old", []); // dead, must be excluded

    const out = buildVaultMap(db, cfg);

    const hasArchive = (s: string) => s.includes(ARCH);
    // No archive path in any cluster, orphan, hub or bridge.
    for (const c of out.clusters) {
      expect(c.nodes.some(hasArchive)).toBe(false);
    }
    expect(out.orphans.some(hasArchive)).toBe(false);
    expect(out.hubs.some((h) => hasArchive(h.path))).toBe(false);
    expect(out.bridges.some((b) => hasArchive(b.path))).toBe(false);

    // Only the 3 live notes are counted; the archived one is dropped.
    expect(out.stats.documents).toBe(3);
    // C is now an orphan in live canon (its only edge pointed at the archive).
    expect(out.orphans.some((o) => o.endsWith("C.md"))).toBe(true);
    // Diagnostic preserved: the forbidden active→archive edge is still caught.
    expect(out.stats.active_to_archive_links).toBe(1);
  });
});

describe("buildVaultMap — empty + trivial", () => {
  it("returns zero stats on an empty DB", () => {
    const out = buildVaultMap(db, cfg);
    expect(out.stats).toEqual({
      documents: 0,
      edges: 0,
      clusters: 0,
      hubs: 0,
      bridges: 0,
      orphans: 0,
      orphan_wikilinks: 0,
      active_to_archive_links: 0,
    });
    expect(out.clusters).toEqual([]);
    expect(out.hubs).toEqual([]);
    expect(out.bridges).toEqual([]);
    expect(out.orphans).toEqual([]);
  });

  it("a single isolated doc shows up as an orphan", () => {
    addDoc(db, "lone.md", "Lone", []);
    const out = buildVaultMap(db, cfg);
    expect(out.orphans).toEqual(["lone.md"]);
    expect(out.clusters).toEqual([]);
    expect(out.stats.documents).toBe(1);
    expect(out.stats.orphans).toBe(1);
  });
});

describe("buildVaultMap — clusters", () => {
  it("groups connected docs into one cluster", () => {
    addDoc(db, "a.md", "A", ["b.md"]);
    addDoc(db, "b.md", "B", ["c.md"]);
    addDoc(db, "c.md", "C", []);

    const out = buildVaultMap(db, cfg);
    expect(out.clusters).toHaveLength(1);
    expect(new Set(out.clusters[0]!.nodes)).toEqual(
      new Set(["a.md", "b.md", "c.md"]),
    );
    expect(out.orphans).toEqual([]);
  });

  it("separates disconnected components into multiple clusters", () => {
    // Component 1: a <-> b
    addDoc(db, "a.md", "A", ["b.md"]);
    addDoc(db, "b.md", "B", []);
    // Component 2: c <-> d
    addDoc(db, "c.md", "C", ["d.md"]);
    addDoc(db, "d.md", "D", []);

    const out = buildVaultMap(db, cfg);
    expect(out.clusters).toHaveLength(2);
    // Largest cluster first
    expect(out.clusters[0]!.nodes.length).toBeGreaterThanOrEqual(
      out.clusters[1]!.nodes.length,
    );
  });

  it("names cluster by top-level tag of its hub when tags present", () => {
    addDoc(db, "hub.md", "Hub", ["b.md", "c.md", "d.md"], ["topic/sub"]);
    addDoc(db, "b.md", "B", []);
    addDoc(db, "c.md", "C", []);
    addDoc(db, "d.md", "D", []);

    const out = buildVaultMap(db, cfg);
    expect(out.clusters[0]!.name).toBe("topic");
    expect(out.clusters[0]!.hub?.title).toBe("Hub");
  });

  it("falls back to hub title when no node in the cluster has tags", () => {
    addDoc(db, "hub.md", "Hub", ["b.md", "c.md"]);
    addDoc(db, "b.md", "B", []);
    addDoc(db, "c.md", "C", []);

    const out = buildVaultMap(db, cfg);
    expect(out.clusters[0]!.name).toBe("Hub");
  });

  it("names cluster by the MOST FREQUENT top-level tag, not the hub's tags[0] (Audit #8)", () => {
    // Hub is tagged `zeta`, but 4 of 5 nodes are tagged `alpha`.
    addDoc(db, "hub.md", "Hub", ["b.md", "c.md", "d.md", "e.md"], ["zeta"]);
    addDoc(db, "b.md", "B", [], ["alpha"]);
    addDoc(db, "c.md", "C", [], ["alpha"]);
    addDoc(db, "d.md", "D", [], ["alpha"]);
    addDoc(db, "e.md", "E", [], ["alpha"]);

    expect(buildVaultMap(db, cfg).clusters[0]!.name).toBe("alpha");
  });

  it("cluster name is independent of tag order within a note", () => {
    // node1 carries two tags; only the SET matters, not the YAML order.
    addDoc(db, "a.md", "A", ["b.md"], ["x", "y"]);
    addDoc(db, "b.md", "B", [], ["x"]);
    const name1 = buildVaultMap(db, cfg).clusters[0]!.name; // x=2, y=1 → "x"

    // Fresh DB, same graph, tag order on a.md reversed.
    db.exec("DELETE FROM documents; DELETE FROM edges; DELETE FROM chunks; DELETE FROM chunk_fts;");
    addDoc(db, "a.md", "A", ["b.md"], ["y", "x"]);
    addDoc(db, "b.md", "B", [], ["x"]);
    const name2 = buildVaultMap(db, cfg).clusters[0]!.name;

    expect(name1).toBe("x");
    expect(name2).toBe("x"); // unchanged despite reordered tags
  });

  it("ties between top-level tags break alphabetically (deterministic)", () => {
    addDoc(db, "a.md", "A", ["b.md"], ["beta"]);
    addDoc(db, "b.md", "B", [], ["alpha"]);
    expect(buildVaultMap(db, cfg).clusters[0]!.name).toBe("alpha");
  });
});

describe("buildVaultMap — hubs", () => {
  it("flags a node with ≥5 links as a hub", () => {
    addDoc(db, "h.md", "Hub", ["a.md", "b.md", "c.md", "d.md", "e.md"]);
    addDoc(db, "a.md", "A", []);
    addDoc(db, "b.md", "B", []);
    addDoc(db, "c.md", "C", []);
    addDoc(db, "d.md", "D", []);
    addDoc(db, "e.md", "E", []);

    const out = buildVaultMap(db, cfg);
    const hub = out.hubs.find((h) => h.path === "h.md");
    expect(hub).toBeDefined();
    expect(hub!.outDegree).toBe(5);
    expect(hub!.inDegree).toBe(0);
    expect(hub!.total).toBe(5);
  });

  it("does NOT flag a node with <5 links as a hub", () => {
    addDoc(db, "h.md", "H", ["a.md", "b.md", "c.md"]);
    addDoc(db, "a.md", "A", []);
    addDoc(db, "b.md", "B", []);
    addDoc(db, "c.md", "C", []);

    expect(buildVaultMap(db, cfg).hubs).toEqual([]);
  });

  it("hubs are sorted by total degree desc", () => {
    // Hub with degree 6
    addDoc(db, "big.md", "Big", ["a.md", "b.md", "c.md", "d.md", "e.md", "f.md"]);
    // Hub with degree 5
    addDoc(db, "small.md", "Small", ["a.md", "b.md", "c.md", "d.md", "e.md"]);
    for (const p of ["a.md", "b.md", "c.md", "d.md", "e.md", "f.md"]) {
      addDoc(db, p, p, []);
    }

    const out = buildVaultMap(db, cfg);
    expect(out.hubs[0]!.path).toBe("big.md");
    expect(out.hubs[1]!.path).toBe("small.md");
    expect(out.hubs[0]!.total).toBeGreaterThan(out.hubs[1]!.total);
  });
});

describe("buildVaultMap — stats edges", () => {
  it("counts unique directed edges only", () => {
    addDoc(db, "a.md", "A", ["b.md", "b.md"]); // dup ignored at SQL level
    addDoc(db, "b.md", "B", ["a.md"]);

    const out = buildVaultMap(db, cfg);
    expect(out.stats.edges).toBe(2); // a→b + b→a
  });
});

describe("buildVaultMap — orphan vs cluster classification", () => {
  it("an orphan has zero in + zero out degree", () => {
    addDoc(db, "iso.md", "Iso", []);
    addDoc(db, "a.md", "A", ["b.md"]);
    addDoc(db, "b.md", "B", []);

    const out = buildVaultMap(db, cfg);
    expect(out.orphans).toEqual(["iso.md"]);
    expect(out.stats.clusters).toBe(1);
  });

  it("a node with at least one edge is in a cluster, not an orphan", () => {
    addDoc(db, "a.md", "A", ["b.md"]);
    addDoc(db, "b.md", "B", []);
    const out = buildVaultMap(db, cfg);
    expect(out.orphans).toEqual([]);
    expect(out.stats.clusters).toBe(1);
  });
});

describe("buildVaultMap — bridges (Audit #4)", () => {
  it("returns the middle node of a simple A-B-C chain as a bridge", () => {
    // Old code named both sides by the single component cluster name →
    // conn[0] === conn[1] → every bridge dropped. B must now surface.
    addDoc(db, "a.md", "A", ["b.md"]);
    addDoc(db, "b.md", "B", ["c.md"]);
    addDoc(db, "c.md", "C", []);

    const out = buildVaultMap(db, cfg);
    const bridge = out.bridges.find((x) => x.path === "b.md");
    expect(bridge).toBeDefined();
    expect(bridge!.connects).toHaveLength(2);
    // Sides labelled by their own representative + size, and distinct.
    expect(bridge!.connects[0]).not.toBe(bridge!.connects[1]);
    expect(bridge!.connects.every((s) => /\(n=\d+\)$/.test(s))).toBe(true);
    expect(out.stats.bridges).toBeGreaterThanOrEqual(1);
  });

  it("finds the single connector between two dense triangles", () => {
    // Triangle 1
    addDoc(db, "a.md", "A", ["b.md"]);
    addDoc(db, "b.md", "B", ["c.md"]);
    addDoc(db, "c.md", "C", ["a.md"]);
    // Triangle 2
    addDoc(db, "d.md", "D", ["e.md"]);
    addDoc(db, "e.md", "E", ["f.md"]);
    addDoc(db, "f.md", "F", ["d.md"]);
    // Single bridge node joining the triangles
    addDoc(db, "x.md", "X", ["a.md", "d.md"]);

    const out = buildVaultMap(db, cfg);
    const paths = out.bridges.map((b) => b.path);
    expect(paths).toContain("x.md");
    const x = out.bridges.find((b) => b.path === "x.md")!;
    expect(x.connects).toHaveLength(2);
    expect(x.connects[0]).not.toBe(x.connects[1]);
  });

  it("no bridges in a fully connected triangle (no articulation point)", () => {
    addDoc(db, "a.md", "A", ["b.md", "c.md"]);
    addDoc(db, "b.md", "B", ["c.md"]);
    addDoc(db, "c.md", "C", ["a.md"]);
    const out = buildVaultMap(db, cfg);
    expect(out.bridges).toEqual([]);
    expect(out.stats.bridges).toBe(0);
  });
});

describe("buildVaultMap — operative excluded (Audit #6 split, B side)", () => {
  it("operative→canon backlinks do NOT make a canon note a hub; canon reads as orphan", () => {
    addDoc(db, "01_Знания/Hub.md", "Hub", []);
    // Five agents journal about Hub in their operative notes.
    for (let i = 0; i < 5; i++) {
      addDoc(db, `06_Оперативка_агентов/boris/o${i}.md`, `O${i}`, [
        "01_Знания/Hub.md",
      ]);
    }

    const out = buildVaultMap(db, cfg);
    // Operative notes are not part of the canonical topology at all.
    expect(out.stats.documents).toBe(1);
    expect(out.hubs).toEqual([]); // 5 operative backlinks must NOT make a hub
    // Hub has zero CANONICAL links → honest orphan signal for health-check.
    expect(out.orphans).toEqual(["01_Знания/Hub.md"]);
    const allClusterNodes = out.clusters.flatMap((c) => c.nodes);
    expect(allClusterNodes.some((p) => p.includes("06_Оперативка_агентов/"))).toBe(
      false,
    );
  });

  it("canon↔canon topology is unaffected by the operative exclusion", () => {
    addDoc(db, "01_Знания/A.md", "A", ["01_Знания/B.md"]);
    addDoc(db, "01_Знания/B.md", "B", []);
    addDoc(db, "06_Оперативка_агентов/linus/n.md", "N", ["01_Знания/A.md"]);

    const out = buildVaultMap(db, cfg);
    expect(out.stats.documents).toBe(2); // only the two canon notes
    expect(out.clusters).toHaveLength(1);
    expect(new Set(out.clusters[0]!.nodes)).toEqual(
      new Set(["01_Знания/A.md", "01_Знания/B.md"]),
    );
    expect(out.orphans).toEqual([]);
  });
});
