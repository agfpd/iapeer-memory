import { describe, it, expect, beforeEach, afterEach, vi } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDatabase, upsertDocument, storeChunkEmbeddings, getChunksWithoutEmbeddings } from "../src/db.js";
import type { CoreDb } from "../src/db.js";
import type { CoreConfig } from "../src/config.js";
import { runVaultSearch, runDedup, buildSnippet, stripLeadingTitleEcho } from "../src/search.js";
import { _resetEmbeddingCircuitForTests } from "../src/embedding.js";
import { _resetRerankerCircuitForTests } from "../src/reranker.js";
import { getTaxonomy, DEFAULT_RANKING } from "../src/taxonomy.js";

function makeConfig(overrides: Partial<CoreConfig> = {}): CoreConfig {
  return {
    vaultPath: "/tmp/test-vault",
    locale: "ru",
    taxonomy: getTaxonomy("ru"),
    ranking: { ...DEFAULT_RANKING },
    curatorSet: ["index", "scriber", "dreamweaver"],
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
  body = title,
  frontmatter: Record<string, unknown> = {},
  outgoing: string[] = [],
  status: string | null = null,
): void {
  upsertDocument(
    db,
    {
      path: docPath,
      title,
      type: null,
      status,
      tags: [],
      contentHash: docPath,
      frontmatter,
      created: null,
      updated: null,
      indexedAt: "x",
    },
    [{ chunkIndex: 0, text: body }],
    outgoing.map((target) => ({ target, contextSnippet: "" })),
  );
}

let tmpDir: string;
let db: CoreDb;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mergemind-search-test-"));
  db = openDatabase(makeConfig({
    index: { dbPath: path.join(tmpDir, "test.db"), fullScanOnStartup: false },
    batch: { curatorMs: 6 * 3600_000 },
  }));
  // Module-level circuit breaker shares state across tests, иначе
  // тест в котором ловится 2 timeout'а откроет breaker и следующий тест
  // получит status="circuit-open" вместо ожидаемого retry-результата.
  _resetEmbeddingCircuitForTests();
  _resetRerankerCircuitForTests();
});

afterEach(() => {
  try { db.close(); } catch {}
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

// ---- BM25-only path (no embedding, no reranker) ----

describe("runVaultSearch — BM25-only", () => {
  it("returns matching note", async () => {
    addDoc(db, "a.md", "Apple", "apple banana");
    addDoc(db, "b.md", "Berry", "blackberry");

    const out = await runVaultSearch({
      db, config: makeConfig(), query: "apple",
    });
    expect(out.results.map((r) => r.path)).toContain("a.md");
    expect(out.results.map((r) => r.path)).not.toContain("b.md");
  });

  it("returns empty for whitespace query", async () => {
    addDoc(db, "a.md", "Apple", "apple");
    const out = await runVaultSearch({ db, config: makeConfig(), query: "   " });
    expect(out.results).toEqual([]);
  });

  it("snippet has BM25 highlight when BM25 matched", async () => {
    addDoc(db, "a.md", "Apple", "the apple is red");
    const out = await runVaultSearch({
      db, config: makeConfig(), query: "apple",
    });
    expect(out.results[0]!.snippet).toMatch(/\[apple\]/i);
  });
});

// ---- Frontmatter status boost ----

describe("runVaultSearch — frontmatter status boost", () => {
  it("'актуально' ranks above 'устарело' for equal BM25", async () => {
    // Two notes with the same body length and the same query match —
    // status alone breaks the tie via the ×1.2 / ×0.5 multipliers.
    addDoc(db, "active.md", "Active", "apple", {}, [], "актуально");
    addDoc(db, "stale.md", "Stale", "apple", {}, [], "устарело");

    const out = await runVaultSearch({
      db, config: makeConfig(), query: "apple",
    });
    const active = out.results.findIndex((r) => r.path === "active.md");
    const stale = out.results.findIndex((r) => r.path === "stale.md");
    expect(active).toBeGreaterThanOrEqual(0);
    expect(stale).toBeGreaterThanOrEqual(0);
    expect(active).toBeLessThan(stale);
  });

  it("'черновик' (pending) ranks below 'актуально'", async () => {
    addDoc(db, "active.md", "Active", "apple", {}, [], "актуально");
    addDoc(db, "draft.md", "Draft", "apple", {}, [], "черновик");

    const out = await runVaultSearch({
      db, config: makeConfig(), query: "apple",
    });
    const aIdx = out.results.findIndex((r) => r.path === "active.md");
    const dIdx = out.results.findIndex((r) => r.path === "draft.md");
    expect(aIdx).toBeLessThan(dIdx);
  });

  it("'статус: реализуется' applies the active boost (project life-cycle)", async () => {
    addDoc(db, "active-phase.md", "AP", "apple", {}, [], "реализуется");
    addDoc(db, "stale.md", "S", "apple", {}, [], "устарело");
    const out = await runVaultSearch({
      db, config: makeConfig(), query: "apple",
    });
    const apIdx = out.results.findIndex((r) => r.path === "active-phase.md");
    const stIdx = out.results.findIndex((r) => r.path === "stale.md");
    expect(apIdx).toBeLessThan(stIdx);
  });
});

// ---- Foreign operative penalty ----

describe("runVaultSearch — foreign operative penalty", () => {
  it("foreign-author oper note is deboosted when callerAgent is set", async () => {
    // boris reads. linus has a personal note in his folder. Search should
    // surface boris's own note higher (same BM25 hit otherwise).
    addDoc(db, "06_Оперативка_агентов/boris/x.md", "Bnote", "apple", {
      author: "boris",
    });
    addDoc(db, "06_Оперативка_агентов/linus/x.md", "Lnote", "apple", {
      author: "linus",
    });

    const out = await runVaultSearch({
      db,
      config: makeConfig({ callerAgent: "boris" }),
      query: "apple",
    });
    const bIdx = out.results.findIndex((r) => r.path === "06_Оперативка_агентов/boris/x.md");
    const lIdx = out.results.findIndex((r) => r.path === "06_Оперативка_агентов/linus/x.md");
    expect(bIdx).toBeGreaterThanOrEqual(0);
    expect(lIdx).toBeGreaterThanOrEqual(0);
    expect(bIdx).toBeLessThan(lIdx);
  });

  it("no penalty when callerAgent is null (admin-mode)", async () => {
    addDoc(db, "06_Оперативка_агентов/boris/x.md", "Bnote", "apple", {
      author: "boris",
    });
    addDoc(db, "06_Оперативка_агентов/linus/x.md", "Lnote", "apple", {
      author: "linus",
    });

    const out = await runVaultSearch({
      db,
      // callerAgent: null (default)
      config: makeConfig(),
      query: "apple",
    });
    // Order isn't guaranteed since no penalty applies — both should appear.
    const paths = out.results.map((r) => r.path);
    expect(paths).toContain("06_Оперативка_агентов/boris/x.md");
    expect(paths).toContain("06_Оперативка_агентов/linus/x.md");
  });
});

// ---- forCuration mode ----
//
// Курирование Индекса: при построении `## Связи` для оперативной заметки
// автора A Индекс зовёт memory_search с forCuration:true, чтобы FOREIGN_-
// OPERATIVE_PENALTY ×0.7 не давил intra-папку. Без этого режима оперативка
// автора A для Индекса (callerAgent=index) — чужая, и теряется на фоне канона.

describe("runVaultSearch — forCuration mode", () => {
  it("forCuration=true disables foreign-operative penalty", async () => {
    // Индекс курирует заметку boris и ищет соседей. callerAgent=index → для
    // обычного memory_search оперативка boris чужая, ×0.7. Канон без штрафа.
    // По BM25 оба матчат одинаково. Без forCuration канон выше; с forCuration
    // штраф снимается, и при равном BM25 оперативка ≥ канон.
    addDoc(db, "06_Оперативка_агентов/boris/x.md", "Bnote", "apple banana", {
      author: "boris",
    });
    addDoc(db, "01_Знания/k.md", "Knote", "apple banana", {});

    const outDefault = await runVaultSearch({
      db,
      config: makeConfig({ callerAgent: "index" }),
      query: "apple banana",
    });
    const outCuration = await runVaultSearch({
      db,
      config: makeConfig({ callerAgent: "index" }),
      query: "apple banana",
      forCuration: true,
    });

    const bDefaultIdx = outDefault.results.findIndex((r) => r.path === "06_Оперативка_агентов/boris/x.md");
    const kDefaultIdx = outDefault.results.findIndex((r) => r.path === "01_Знания/k.md");
    const bCurationIdx = outCuration.results.findIndex((r) => r.path === "06_Оперативка_агентов/boris/x.md");
    const kCurationIdx = outCuration.results.findIndex((r) => r.path === "01_Знания/k.md");

    expect(bDefaultIdx).toBeGreaterThanOrEqual(0);
    expect(kDefaultIdx).toBeGreaterThanOrEqual(0);
    // Без forCuration: оперативка после канона (penalty ×0.7).
    expect(bDefaultIdx).toBeGreaterThan(kDefaultIdx);
    // С forCuration: penalty снят → оперативка не хуже канона. При равном
    // BM25 порядок зависит от внутренней сортировки stable-sort; главное —
    // оперативка не позади канона.
    expect(bCurationIdx).toBeLessThanOrEqual(kCurationIdx);
  });

  it("forCuration preserves status-based boost (active/stale)", async () => {
    // Курирование НЕ должно ломать ACTIVE_BOOST/STALE_PENALTY — устаревшая
    // оперативка должна оставаться ниже актуальной даже в curation-режиме.
    addDoc(db, "06_Оперативка_агентов/boris/active.md", "A", "apple", {
      author: "boris",
    }, [], "актуально");
    addDoc(db, "06_Оперативка_агентов/boris/stale.md", "S", "apple", {
      author: "boris",
    }, [], "устарело");

    const out = await runVaultSearch({
      db,
      config: makeConfig({ callerAgent: "index" }),
      query: "apple",
      forCuration: true,
    });
    const aIdx = out.results.findIndex((r) => r.path === "06_Оперативка_агентов/boris/active.md");
    const sIdx = out.results.findIndex((r) => r.path === "06_Оперативка_агентов/boris/stale.md");
    expect(aIdx).toBeGreaterThanOrEqual(0);
    expect(sIdx).toBeGreaterThanOrEqual(0);
    expect(aIdx).toBeLessThan(sIdx);
  });

  // Прод-сценарий с reranker'ом: гипотеза #2 boris'а. Когда penalty стоял ДО
  // rerank'а, applyReranker делал `score / maxScore` и относительная дельта
  // ×0.7 нормализовалась в ноль (реальный repro: 0.93 vs 0.93). Penalty
  // вынесен ПОСЛЕ rerank'а — на финальный score, без последующей нормализации
  // кроме сортировки. Этот тест блокирует регрессию.
  it("foreign-operative penalty survives reranker normalization (post-rerank)", async () => {
    addDoc(db, "06_Оперативка_агентов/boris/x.md", "B", "apple banana", {
      author: "boris",
    });
    addDoc(db, "01_Знания/k.md", "K", "apple banana", {});

    // Reranker возвращает одинаковый score для обеих — кросс-энкодер не знает
    // про author'а. Если бы penalty стоял до rerank, нормализация уравняла бы
    // финальный score; здесь penalty применяется ПОСЛЕ — оперативка ниже канона.
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify([
          { index: 0, score: 0.9 },
          { index: 1, score: 0.9 },
        ]),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const cfg = makeConfig({
      callerAgent: "index",
      reranker: { endpoint: "http://fake/rerank", model: "r", topK: 10, weight: 0.7, apiKey: null },
    });

    const outDefault = await runVaultSearch({ db, config: cfg, query: "apple banana" });
    const outCuration = await runVaultSearch({ db, config: cfg, query: "apple banana", forCuration: true });

    const bDef = outDefault.results.find((r) => r.path === "06_Оперативка_агентов/boris/x.md");
    const kDef = outDefault.results.find((r) => r.path === "01_Знания/k.md");
    const bCur = outCuration.results.find((r) => r.path === "06_Оперативка_агентов/boris/x.md");
    const kCur = outCuration.results.find((r) => r.path === "01_Знания/k.md");

    expect(bDef).toBeDefined();
    expect(kDef).toBeDefined();
    expect(bCur).toBeDefined();
    expect(kCur).toBeDefined();

    // Default + callerAgent=index: оперативка boris чужая → final score ×0.7
    // относительно канона. После rerank, без последующей нормализации.
    expect(bDef!.score).toBeLessThan(kDef!.score);
    // Curation: penalty пропущен, обе равны (одинаковый rerankScore + те же
    // ACTIVE_STATUSES=none + одинаковая нормализация в applyReranker).
    expect(bCur!.score).toBeCloseTo(kCur!.score, 3);
  });
});

// ---- Backlink boost ----

describe("runVaultSearch — backlink boost", () => {
  it("hub note (≥5 backlinks) gets a score bump", async () => {
    // hub: 5 incoming links + "apple" in body
    addDoc(db, "hub.md", "Hub", "apple");
    // 5 different notes link to hub
    for (let i = 0; i < 5; i++) {
      addDoc(db, `citer-${i}.md`, `C${i}`, `body ${i}`, {}, ["hub.md"]);
    }
    // peer note also has "apple" but no backlinks
    addDoc(db, "peer.md", "Peer", "apple");

    const out = await runVaultSearch({
      db, config: makeConfig(), query: "apple",
    });
    const hubIdx = out.results.findIndex((r) => r.path === "hub.md");
    const peerIdx = out.results.findIndex((r) => r.path === "peer.md");
    expect(hubIdx).toBeLessThan(peerIdx);
  });

  it("operative backlinks STILL count toward the boost (Audit #6 split, A side)", async () => {
    // Decision: in search ranking, "many agents reference this" is a
    // legitimate cross-agent importance signal — operative→canon backlinks
    // are deliberately NOT filtered here (unlike memory_map). This test locks
    // that in so a future change can't silently unify the two halves.
    addDoc(db, "hub.md", "Hub", "apple");
    for (let i = 0; i < 5; i++) {
      addDoc(db, `06_Оперативка_агентов/boris/c${i}.md`, `C${i}`, `body ${i}`, {
        author: "boris",
      }, ["hub.md"]);
    }
    addDoc(db, "peer.md", "Peer", "apple");

    const out = await runVaultSearch({
      db, config: makeConfig(), query: "apple",
    });
    const hubIdx = out.results.findIndex((r) => r.path === "hub.md");
    const peerIdx = out.results.findIndex((r) => r.path === "peer.md");
    expect(hubIdx).toBeLessThan(peerIdx);
  });
});

// ---- Snippet fallback for graph-expanded items ----

describe("runVaultSearch — snippet fallback", () => {
  it("provides a non-empty snippet for graph-expanded items (no BM25 hit)", async () => {
    // Center matches 'apple', neighbor doesn't but gets expanded via the graph.
    addDoc(db, "center.md", "Center", "apple is here", {}, ["neighbor.md"]);
    addDoc(db, "neighbor.md", "Neighbor", "completely unrelated text");

    const out = await runVaultSearch({
      db, config: makeConfig(), query: "apple",
    });
    const neighbor = out.results.find((r) => r.path === "neighbor.md");
    // Neighbor is reachable through graph-expand from `center`.
    if (neighbor) {
      expect(neighbor.snippet.length).toBeGreaterThan(0);
    }
  });
});

// ---- Query-aware snippet builder (regression: title-echo defect) ----

describe("buildSnippet / stripLeadingTitleEcho", () => {
  it("stripLeadingTitleEcho drops bare title + markdown heading lines, keeps prose", () => {
    const text = "Описание X\n\n# Описание X\n\nРеальный текст начинается тут.";
    expect(stripLeadingTitleEcho(text, "Описание X")).toBe(
      "Реальный текст начинается тут.",
    );
  });

  it("collapses a title+H1-only chunk to empty (the degenerate chunk[0])", () => {
    expect(stripLeadingTitleEcho("План inter-agent\n\n# План — inter-agent", "План inter-agent")).toBe("");
  });

  it("returns a body window around the query terms, NOT the title echo", () => {
    // Exact shape of the reported defect: chunk[0] is the degenerate
    // "<Title>\n\n# <Title>" prefix chunk; the real content is chunk[1].
    const chunks = [
      "Описание inter-agent\n\n# Описание inter-agent",
      "# Описание inter-agent\n\nНадёжная межагентная координация без молчаливой потери сообщений: канал доставляет события внутрь живой сессии.",
    ];
    const snip = buildSnippet(
      "межагентная координация канал доставка сообщений",
      chunks,
      "Описание inter-agent",
    );
    expect(snip).not.toBe("Описание inter-agent # Описание inter-agent");
    expect(snip).not.toContain("# Описание inter-agent");
    expect(snip).toContain("[межагентная]");
    expect(snip).toContain("[координация]");
    expect(snip).toContain("[сообщений]");
  });

  it("a content-empty stub note yields an honest marker, not a title echo", () => {
    const snip = buildSnippet(
      "что угодно",
      ["План inter-agent\n\n# План — inter-agent"],
      "План inter-agent",
    );
    expect(snip).not.toContain("План inter-agent #");
    expect(snip).toContain("пустой каркас");
  });

  it("pure semantic hit (no lexical overlap) → first prose head, no echo", () => {
    const chunks = [
      "Заметка Z\n\n# Заметка Z",
      "# Заметка Z\n\nЭто содержательный первый абзац про совершенно другую тему.",
    ];
    const snip = buildSnippet("apple banana", chunks, "Заметка Z");
    expect(snip).toBe(
      "Это содержательный первый абзац про совершенно другую тему.",
    );
  });

  it("wraps matched terms in [brackets] preserving original casing", () => {
    const snip = buildSnippet("Apple", ["The Apple is red"], "T");
    expect(snip).toContain("[Apple]");
  });
});

// ---- Vector path with mocked fetch ----

describe("runVaultSearch — vector path (mocked TEI)", () => {
  it("incorporates vector results when embedding endpoint is reachable", async () => {
    // Two docs. BM25 finds neither (query word doesn't appear). Vector
    // search "finds" both via cosine. We mock embeddings so doc-a is very
    // close to the query vector, doc-b is far.
    addDoc(db, "a.md", "A", "alpha");
    addDoc(db, "b.md", "B", "beta");

    // Pre-embed both chunks with known vectors.
    const missing = getChunksWithoutEmbeddings(db, 10);
    // Map by docPath so we don't depend on insertion order.
    const byPath = new Map(missing.map((m) => [m.docPath, m.id]));
    const closeVec = new Float32Array([1, 0, 0]);
    const farVec = new Float32Array([0, 1, 0]);
    storeChunkEmbeddings(db, [
      { id: byPath.get("a.md")!, embedding: Buffer.from(closeVec.buffer) },
      { id: byPath.get("b.md")!, embedding: Buffer.from(farVec.buffer) },
    ]);

    // Mock TEI: respond with closeVec for the query (so a.md ranks higher).
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(
          JSON.stringify({ data: [{ embedding: [1, 0, 0] }] }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );

    const cfg = makeConfig({
      embedding: {
        endpoint: "http://fake/v1/embeddings",
        model: "fake",
        dimensions: 3,
        batchSize: 32,
        apiKey: null,
      },
    });
    const out = await runVaultSearch({
      db, config: cfg, query: "nothing-matches-bm25",
    });
    expect(fetchMock).toHaveBeenCalled();
    const paths = out.results.map((r) => r.path);
    expect(paths).toContain("a.md");
    // Both should appear (graph expand or vector both), but a.md ranks higher.
    const aIdx = paths.indexOf("a.md");
    const bIdx = paths.indexOf("b.md");
    if (bIdx >= 0) {
      expect(aIdx).toBeLessThan(bIdx);
    }
  });

  it("falls back to BM25 only when embedding endpoint is unreachable", async () => {
    addDoc(db, "a.md", "A", "apple");
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("ECONNREFUSED"));

    const cfg = makeConfig({
      embedding: {
        endpoint: "http://nowhere/v1/embeddings",
        model: "fake",
        dimensions: 3,
        batchSize: 32,
        apiKey: null,
      },
    });
    const out = await runVaultSearch({
      db, config: cfg, query: "apple",
    });
    // BM25 still finds the note even though vector path errored out.
    expect(out.results.map((r) => r.path)).toContain("a.md");
  });
});

// ---- runDedup: archive exclusion (lean §3a/§3b candidate filter) ----

describe("runDedup — archive is excluded from dup + link candidates", () => {
  // An archived note must never surface as a dedup candidate (it is dead, not a
  // real duplicate) nor as a link-hint target (active→archive wikilinks are
  // forbidden by the link-rule invariant). Both bands share the canonHeads
  // filter, so one test covers both.
  function embedCfg(): CoreConfig {
    return makeConfig({
      embedding: {
        endpoint: "http://fake/v1/embeddings",
        model: "fake",
        dimensions: 3,
        batchSize: 32,
        apiKey: null,
      },
    });
  }

  it("a near-identical archived note is dropped; the live-canon twin survives", async () => {
    const T = getTaxonomy("ru").folders;
    const activePath = `${T.knowledge}/Активная заметка.md`;
    const archivedPath = `${T.archive}/Архивная заметка.md`;
    addDoc(db, activePath, "Активная заметка", "одинаковое тело про одну тему");
    addDoc(db, archivedPath, "Архивная заметка", "одинаковое тело про одну тему");

    // Embed both chunks with the SAME vector → both rank at cosine ~1.0, so the
    // ONLY thing that can exclude the archived one is the folder filter.
    const missing = getChunksWithoutEmbeddings(db, 10);
    const byPath = new Map(missing.map((m) => [m.docPath, m.id]));
    const closeVec = new Float32Array([1, 0, 0]);
    storeChunkEmbeddings(db, [
      { id: byPath.get(activePath)!, embedding: Buffer.from(closeVec.buffer) },
      { id: byPath.get(archivedPath)!, embedding: Buffer.from(closeVec.buffer) },
    ]);

    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ data: [{ embedding: [1, 0, 0] }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const out = await runDedup(db, embedCfg(), {
      content: "одинаковое тело про одну тему",
      threshold: 0.78,
      linkThreshold: 0.68,
    });
    expect(out.enabled).toBe(true);
    const paths = out.matches.map((m) => m.path);
    expect(paths).toContain(activePath);
    expect(paths).not.toContain(archivedPath);
  });
});

// ---- Reranker with mocked fetch ----

describe("runVaultSearch — reranker (mocked TEI)", () => {
  it("reordering follows reranker scores when available", async () => {
    addDoc(db, "a.md", "A", "apple alpha");
    addDoc(db, "b.md", "B", "apple beta");

    // Mock fetch — embedding-style request never made (no embedding config),
    // only reranker. TEI reranker schema: {results: [{index, score}, ...]}.
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify([
          // Note: rerank() in reranker.ts expects RerankItem[] directly.
          { index: 0, score: 0.1 },
          { index: 1, score: 0.99 },
        ]),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const cfg = makeConfig({
      reranker: {
        endpoint: "http://fake/rerank",
        model: "fake-r",
        topK: 10,
        weight: 1.0, // Reranker drives the score entirely
        apiKey: null,
      },
    });
    const out = await runVaultSearch({
      db, config: cfg, query: "apple",
    });
    // BM25 returns both; with weight=1.0, reranker controls order. We mocked
    // index=1 (b.md) as the higher rerank score, so b.md should rank first.
    const aIdx = out.results.findIndex((r) => r.path === "a.md");
    const bIdx = out.results.findIndex((r) => r.path === "b.md");
    expect(bIdx).toBeLessThan(aIdx);
  });

  it("keeps RRF order when reranker is unreachable", async () => {
    addDoc(db, "a.md", "A", "apple");
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("nope"));

    const cfg = makeConfig({
      reranker: {
        endpoint: "http://nowhere/rerank",
        model: "fake-r",
        topK: 10,
        weight: 0.7,
        apiKey: null,
      },
    });
    const out = await runVaultSearch({
      db, config: cfg, query: "apple",
    });
    // Result still surfaces a.md — graceful degradation.
    expect(out.results.map((r) => r.path)).toContain("a.md");
  });
});

// ---- Pipeline status в response ----

describe("runVaultSearch — pipeline status", () => {
  it("reports all components in response, even when none configured", async () => {
    addDoc(db, "a.md", "A", "apple");
    const out = await runVaultSearch({ db, config: makeConfig(), query: "apple" });
    expect(out.pipeline).toBeDefined();
    expect(out.pipeline.bm25).toBe("ok");
    expect(out.pipeline.embedding).toBe("disabled");
    expect(out.pipeline.reranker).toBe("disabled");
    expect(out.pipeline.graph).toBe("ok");
    expect(out.pipeline.caller_agent).toBeNull();
    expect(out.pipeline.for_curation).toBe(false);
  });

  it("echoes caller_agent and for_curation for diagnostics", async () => {
    addDoc(db, "a.md", "A", "apple");
    const out = await runVaultSearch({
      db,
      config: makeConfig({ callerAgent: "index" }),
      query: "apple",
      forCuration: true,
    });
    expect(out.pipeline.caller_agent).toBe("index");
    expect(out.pipeline.for_curation).toBe(true);
  });

  it("embedding='ok' when endpoint responds successfully", async () => {
    addDoc(db, "a.md", "A", "apple");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ data: [{ embedding: [1, 0, 0] }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const cfg = makeConfig({
      embedding: {
        endpoint: "http://fake/v1/embeddings",
        model: "fake",
        dimensions: 3,
        batchSize: 32,
        apiKey: null,
      },
    });
    const out = await runVaultSearch({ db, config: cfg, query: "apple" });
    expect(out.pipeline.embedding).toBe("ok");
  });

  it("embedding='error' when endpoint rejects", async () => {
    addDoc(db, "a.md", "A", "apple");
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("ECONNREFUSED"));
    const cfg = makeConfig({
      embedding: {
        endpoint: "http://nowhere/v1/embeddings",
        model: "fake",
        dimensions: 3,
        batchSize: 32,
        apiKey: null,
      },
    });
    const out = await runVaultSearch({ db, config: cfg, query: "apple" });
    expect(out.pipeline.embedding).toBe("error");
    // Поиск всё равно вернул результат — BM25-only deg.
    expect(out.results.map((r) => r.path)).toContain("a.md");
  });

  it("embedding='timeout' when fetch is aborted", async () => {
    addDoc(db, "a.md", "A", "apple");
    const abortErr = new Error("aborted");
    abortErr.name = "AbortError";
    vi.spyOn(globalThis, "fetch").mockRejectedValue(abortErr);
    const cfg = makeConfig({
      embedding: {
        endpoint: "http://nowhere/v1/embeddings",
        model: "fake",
        dimensions: 3,
        batchSize: 32,
        apiKey: null,
      },
    });
    const out = await runVaultSearch({ db, config: cfg, query: "apple" });
    expect(out.pipeline.embedding).toBe("timeout");
  });

  it("reranker='ok' when ≥2 results and endpoint responds", async () => {
    addDoc(db, "a.md", "A", "apple alpha");
    addDoc(db, "b.md", "B", "apple beta");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify([
          { index: 0, score: 0.1 },
          { index: 1, score: 0.9 },
        ]),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    const cfg = makeConfig({
      reranker: {
        endpoint: "http://fake/rerank",
        model: "fake-r",
        topK: 10,
        weight: 0.7,
        apiKey: null,
      },
    });
    const out = await runVaultSearch({ db, config: cfg, query: "apple" });
    expect(out.pipeline.reranker).toBe("ok");
  });

  it("reranker='skipped' when fused has ≤1 element", async () => {
    addDoc(db, "a.md", "A", "apple");
    // Никаких других заметок — fused.length == 1 после BM25.
    const spy = vi.spyOn(globalThis, "fetch");
    const cfg = makeConfig({
      reranker: {
        endpoint: "http://fake/rerank",
        model: "fake-r",
        topK: 10,
        weight: 0.7,
        apiKey: null,
      },
    });
    const out = await runVaultSearch({ db, config: cfg, query: "apple" });
    expect(out.pipeline.reranker).toBe("skipped");
    // Skip = реально не делаем сетевой вызов.
    expect(spy).not.toHaveBeenCalled();
  });

  it("reranker='error' when endpoint rejects (≥2 fused results)", async () => {
    addDoc(db, "a.md", "A", "apple alpha");
    addDoc(db, "b.md", "B", "apple beta");
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("nope"));
    const cfg = makeConfig({
      reranker: {
        endpoint: "http://nowhere/rerank",
        model: "fake-r",
        topK: 10,
        weight: 0.7,
        apiKey: null,
      },
    });
    const out = await runVaultSearch({ db, config: cfg, query: "apple" });
    expect(out.pipeline.reranker).toBe("error");
    expect(out.results.length).toBeGreaterThan(0); // graceful
  });

  it("embedding='circuit-open' after circuit breaker trips", async () => {
    addDoc(db, "a.md", "A", "apple");
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("net"));
    const cfg = makeConfig({
      embedding: {
        endpoint: "http://nowhere/v1/embeddings",
        model: "fake",
        dimensions: 3,
        batchSize: 32,
        apiKey: null,
      },
    });

    // Два провала подряд открывают breaker.
    await runVaultSearch({ db, config: cfg, query: "apple" });
    await runVaultSearch({ db, config: cfg, query: "apple" });
    spy.mockClear();

    const out = await runVaultSearch({ db, config: cfg, query: "apple" });
    expect(out.pipeline.embedding).toBe("circuit-open");
    expect(spy).not.toHaveBeenCalled(); // short-circuited без fetch
  });
});

// ---- search-mcp important batch (audit 2026-07-02) ----

describe("runVaultSearch — reranker tail scale (audit important)", () => {
  it("candidates outside topK never leapfrog the reranked set in BM25-only mode", async () => {
    // 4 matching docs, topK=2: the two best get reranked (normalized ≤ 1.0),
    // the tail used to keep RAW bm25 × 0.3 — at raw > ~3.3 the WORST
    // candidates topped the final list exactly in the serve-first window.
    addDoc(db, "01_Знания/top1.md", "Top1", "apple apple apple apple apple");
    addDoc(db, "01_Знания/top2.md", "Top2", "apple apple apple apple");
    addDoc(db, "01_Знания/tail1.md", "Tail1", "apple apple apple");
    addDoc(db, "01_Знания/tail2.md", "Tail2", "apple apple");

    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify([
          { index: 0, score: 0.9 },
          { index: 1, score: 0.8 },
        ]),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    const cfg = makeConfig({
      reranker: { endpoint: "http://fake/rerank", model: "r", topK: 2, weight: 0.7, apiKey: null },
    });
    const out = await runVaultSearch({ db, config: cfg, query: "apple" });
    const paths = out.results.map((r) => r.path);
    // The reranked pair holds the top-2 — the tail sits strictly below.
    expect(paths.slice(0, 2).sort()).toEqual(["01_Знания/top1.md", "01_Знания/top2.md"]);
    // Tail display scores stay well under the reranked ones (same scale now).
    const tail = out.results.filter((r) => r.path.includes("tail"));
    for (const t of tail) expect(t.score).toBeLessThan(0.5);
  });
});

describe("runVaultSearch — archive location floor (audit important)", () => {
  it("a note dragged into the archive with an ACTIVE status ranks with the stale penalty, not the active boost", async () => {
    // Identical bodies; the archived twin carries status «актуально» (the
    // one-way «archive ⇒ stale» invariant was bypassed by a manual move).
    addDoc(db, "01_Знания/живая.md", "Живая", "яблоко яблоко", {}, [], "актуально");
    addDoc(db, "07_Архив/мёртвая.md", "Мёртвая", "яблоко яблоко", {}, [], "актуально");

    const out = await runVaultSearch({ db, config: makeConfig(), query: "яблоко" });
    const live = out.results.find((r) => r.path === "01_Знания/живая.md");
    const dead = out.results.find((r) => r.path === "07_Архив/мёртвая.md");
    expect(live).toBeDefined();
    expect(dead).toBeDefined();
    // ×1.2 vs ×0.5 → the dead note sits at ~stalePenalty/activeBoost of the live one.
    expect(dead!.score).toBeLessThan(live!.score * 0.6);
  });
});

describe("runVaultSearch — reranker sees body evidence for vector-found candidates (audit important)", () => {
  it("the rerank request carries chunk prose, not a bare title", async () => {
    addDoc(db, "01_Знания/семантическая.md", "Семантическая", "полный текст про устройство памяти команды");
    addDoc(db, "01_Знания/лексическая.md", "Лексическая", "запрос запрос запрос");

    const missing = getChunksWithoutEmbeddings(db, 10);
    const byPath = new Map(missing.map((m) => [m.docPath, m.id]));
    storeChunkEmbeddings(db, [
      { id: byPath.get("01_Знания/семантическая.md")!, embedding: Buffer.from(new Float32Array([1, 0, 0]).buffer) },
      { id: byPath.get("01_Знания/лексическая.md")!, embedding: Buffer.from(new Float32Array([0, 1, 0]).buffer) },
    ]);

    let rerankTexts: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation((async (url: unknown, init?: RequestInit) => {
      const u = String(url);
      if (u.includes("/rerank")) {
        const body = JSON.parse(String(init?.body)) as { texts?: string[]; documents?: string[] };
        rerankTexts = body.texts ?? body.documents ?? [];
        return new Response(
          JSON.stringify(rerankTexts.map((_t, i) => ({ index: i, score: 0.5 }))),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      // embeddings: query vector close to «семантическая»
      return new Response(JSON.stringify({ data: [{ embedding: [1, 0, 0] }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch);

    const cfg = makeConfig({
      embedding: { endpoint: "http://fake/v1/embeddings", model: "f", dimensions: 3, batchSize: 32, apiKey: null },
      reranker: { endpoint: "http://fake/rerank", model: "r", topK: 10, weight: 0.7, apiKey: null },
    });
    await runVaultSearch({ db, config: cfg, query: "запрос" });

    // The vector-found note arrived with an EMPTY pipeline snippet — its
    // rerank text must still carry body prose (pre-fix: bare title).
    const semantic = rerankTexts.find((t) => t.startsWith("Семантическая"));
    expect(semantic).toBeDefined();
    expect(semantic).toContain("устройство памяти");
  });
});

describe("runDedup — embed input is capped to the index contract (audit important)", () => {
  it("a very long note embeds only the head window — no context overflow, no breaker trip", async () => {
    let embedInputLen = -1;
    vi.spyOn(globalThis, "fetch").mockImplementation((async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { input: string[] };
      embedInputLen = body.input[0]!.length;
      return new Response(JSON.stringify({ data: [{ embedding: [1, 0, 0] }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch);

    const cfg = makeConfig({
      embedding: { endpoint: "http://fake/v1/embeddings", model: "f", dimensions: 3, batchSize: 32, apiKey: null },
    });
    const longContent = "слово ".repeat(2000); // ~12K chars — way past chunkSize
    await runDedup(db, cfg, { content: longContent });
    expect(embedInputLen).toBeGreaterThan(0);
    expect(embedInputLen).toBeLessThanOrEqual(cfg.search.chunkSize * 2);
  });
});
