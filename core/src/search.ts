/**
 * Full search pipeline:
 *   1. BM25 (FTS5)
 *   2. Vector search (cosine similarity)
 *   3. RRF fusion
 *   4. Frontmatter boosting
 *   5. Cross-encoder rerank (TEI)
 *   6. Graph expand (1 hop)
 *   7. Backlink boost
 *
 * Graceful degradation: works with BM25-only if GPU services are down.
 */

import type { CoreConfig } from "./config.js";
import type { CoreDb, SearchRow } from "./db.js";
import { getRelatedPaths, searchDocuments, getDocumentMeta, getChunkTexts } from "./db.js";
import { embedQuery, cosineSimilarity } from "./embedding.js";
import type { EmbeddingStatus } from "./embedding.js";
import { rerank } from "./reranker.js";
import type { RerankerStatus } from "./reranker.js";
import { escapeFtsQuery, queryTokens } from "./utils.js";
import { agentMemoryFolderMarker, statusGroup } from "./taxonomy.js";

/**
 * Per-step pipeline status, прокидывается наверх в response memory_search,
 * чтобы агент-вызыватель видел в каком режиме отработал поиск (полный
 * пайплайн / BM25-only из-за деградации эмбеддингов / без reranker).
 *
 * Расширяемо: новый компонент = новое поле. Текущие значения:
 * - `bm25`: всегда "ok" (FTS5 локальная, не сетевая — отвалиться может только
 *           вместе с самим MCP-процессом).
 * - `embedding`: "disabled" если endpoint не настроен в env; иначе один из
 *                EmbeddingStatus.
 * - `reranker`: "disabled" если endpoint не настроен; "skipped" если fused
 *               содержит ≤1 элемент (rerank бессмыслен); иначе RerankerStatus.
 * - `graph`: всегда "ok" (1-hop expand чисто на SQLite).
 */
export type PipelineStatus = {
  bm25: "ok";
  embedding: EmbeddingStatus | "disabled" | "skipped";
  reranker: RerankerStatus | "disabled" | "skipped";
  graph: "ok";
  // Echo `config.callerAgent` + `forCuration` — диагностика проброса.
  // null caller_agent при env-misconfig → foreign-операт penalty не работает.
  caller_agent: string | null;
  for_curation: boolean;
};

// Max chars of body text in a result snippet. Long enough to give the agent
// enough context to decide whether to vault_read, short enough to stay out of
// the response-size budget.
const SNIPPET_WINDOW_CHARS = 240;
// Chars of lead-in context kept before the first matched term, so the snippet
// reads as a sentence fragment, not a word cut mid-air.
const SNIPPET_LEAD_CHARS = 40;
// Honest marker for a note that has frontmatter/links but zero body prose
// (a stub "План"/"Фаза" the author hasn't filled in yet). The tool
// contract promises a non-empty snippet; the old code met that by echoing
// the title as if it were content, which is exactly the lie this fix kills.
// A stub marker tells the agent "don't vault_read, there's nothing here"
// without faking relevance.
const EMPTY_NOTE_SNIPPET = "(пустой каркас — в заметке нет содержимого)";
// How many top-degree related notes to surface per result. Was unbounded —
// hub notes (e.g. a project Plan note) inflated payload to ~10KB on a 6-result
// search. Agents can call memory_related for the full neighborhood.
const RELATED_LIMIT = 3;

// --- Frontmatter status categories & ranking coefficients ---
//
// Source of truth: the «Boost'ы при поиске по `status`» contract.
// Three life-cycle groups, one boost per group regardless of `type`. The
// groups (per-locale status tokens) live in the taxonomy preset and the
// coefficients in `config.ranking` (ADR-002) — no local constants here.
// Foreign agent-memory penalty (×0.7 default): `06_Agent_Memory/<other>/`
// ranks below own memory at equal semantics.

export type VaultSearchResult = {
  title: string;
  path: string;
  type: string | null;
  status: string | null;
  score: number;
  snippet: string;
  related: Array<{ path: string; title: string; direction: string }>;
};

export type VaultSearchOutput = {
  results: VaultSearchResult[];
  pipeline: PipelineStatus;
};

export async function runVaultSearch(params: {
  db: CoreDb;
  config: CoreConfig;
  query: string;
  forCuration?: boolean;
}): Promise<VaultSearchOutput> {
  const { db, config, query } = params;
  const forCuration = params.forCuration ?? false;
  const maxResults = config.search.maxResults;
  const candidateLimit = maxResults * 4; // Fetch more for fusion/reranking

  // Default initialisation учитывает наличие config:
  //   - endpoint не настроен в env → "disabled" (terminal, шаг никогда не
  //     запустится в этой сессии).
  //   - endpoint настроен, но шаг ещё не выполнен / пропущен → "skipped"
  //     (бывает при early-return, либо при reranker'е с ≤1 кандидатом).
  // После реального вызова это значение перезаписывается фактическим
  // EmbeddingStatus / RerankerStatus от модуля-клиента.
  const pipeline: PipelineStatus = {
    bm25: "ok",
    embedding: config.embedding ? "skipped" : "disabled",
    reranker: config.reranker ? "skipped" : "disabled",
    graph: "ok",
    caller_agent: config.callerAgent,
    for_curation: forCuration,
  };

  const t0 = Date.now();

  // --- Step 1: BM25 ---
  const ftsQuery = escapeFtsQuery(query);
  const bm25Results = ftsQuery
    ? searchDocuments(db, { query: ftsQuery, limit: candidateLimit })
    : [];
  const t1 = Date.now();

  // --- Step 2: Vector search ---
  let vectorResults: Array<{ path: string; score: number }> = [];
  if (config.embedding) {
    const queryResult = await embedQuery(query, config.embedding);
    pipeline.embedding = queryResult.status;
    if (queryResult.vector) {
      vectorResults = vectorSearch(db, queryResult.vector, candidateLimit);
    }
  }
  const t2 = Date.now();

  // --- Step 3: RRF fusion ---
  let fused: Array<{ path: string; score: number; snippet: string }>;

  if (bm25Results.length > 0 && vectorResults.length > 0) {
    fused = rrfFusion(bm25Results, vectorResults, config.search.rrfK ?? 60);
  } else if (bm25Results.length > 0) {
    // BM25 only — normalize negative FTS5 ranks to positive scores
    fused = bm25Results.map((r) => ({
      path: r.path,
      score: -r.score, // FTS5 rank is negative, more negative = better
      snippet: r.snippet,
    }));
  } else if (vectorResults.length > 0) {
    fused = vectorResults.map((r) => ({
      path: r.path,
      score: r.score,
      snippet: "",
    }));
  } else {
    return { results: [], pipeline };
  }

  // --- Step 4: Frontmatter status boost (active/stale/pending) ---
  // FOREIGN_OPERATIVE_PENALTY вынесен ниже — после rerank'а, иначе
  // нормализация `item.score / maxScore` в applyReranker размывает множитель
  // ×0.7 в относительный ноль (доказано репро с моком reranker'а: 0.93 vs
  // 0.93 для оперативки и канона при тождественном rerankScore). До rerank
  // здесь остаётся только семантический буст по `status` — он осмысленно
  // нормализуется в пуле кандидатов (актуальное > устаревшего внутри
  // ранжирования reranker'а), не зависит от author.
  fused = applyStatusBoost(db, fused, config);

  // --- Step 5: Cross-encoder rerank ---
  // pipeline.reranker уже инициализирован "disabled" если endpoint не задан,
  // либо "skipped" если задан но шаг не запустился (например fused ≤1).
  // Перезаписываем только когда реально дёрнули endpoint.
  if (config.reranker && fused.length > 1) {
    const rerankResult = await applyReranker(db, query, fused, config);
    fused = rerankResult.items;
    pipeline.reranker = rerankResult.status;
  }

  // --- Step 5.5: Foreign-operative penalty (после rerank) ---
  // Множитель ×0.7 на чужую оперативку применяется ПОСЛЕ rerank'а — на
  // финальный score, без последующей нормализации. forCuration пропускает
  // этот шаг (Индекс при построении `## Связи` должен видеть intra-папку
  // на равных с каноном).
  if (!forCuration && config.callerAgent) {
    fused = applyForeignOperativePenalty(db, fused, config.callerAgent, config);
  }

  const t3 = Date.now();
  if (process.env.IAPEER_MEMORY_DEBUG) {
    // stdout is reserved for MCP JSON-RPC — diagnostics must go to stderr,
    // otherwise debug output corrupts the wire protocol and Claude Code deadlocks.
    process.stderr.write(`[mergemind search] BM25=${t1-t0}ms, Vector=${t2-t1}ms, Rerank=${t3-t2}ms, BM25=${bm25Results.length} VEC=${vectorResults.length}\n`);
  }

  // Sort by score descending (higher = better)
  fused.sort((a, b) => b.score - a.score);

  // Take top results before graph expand
  const topFused = fused.slice(0, maxResults);

  // --- Step 6: Graph expand (1 hop) ---
  const expanded = graphExpand(db, topFused, maxResults, config);

  // --- Step 7: Backlink boost ---
  applyBacklinkBoost(db, expanded, config);

  // Final sort
  expanded.sort((a, b) => b.score - a.score);

  // Display normalisation — DELIBERATE DEVIATION from the reference
  // (sanctioned by PM): raw pipeline scores at BM25-only magnitudes
  // (RRF over FTS5 rank) round to 0.000 for every result, and BM25-only is
  // the zero-config default of the public product — "0.0 on everything"
  // reads as a broken search. Normalise by the max BEFORE rounding: the
  // displayed score is relative relevance, top result = 1.0. Ordering is
  // computed on RAW scores above and is unchanged by construction (a
  // positive constant divisor is order-preserving).
  const maxScore = expanded.length > 0 ? expanded[0].score : 0;

  // Build result objects
  const results: VaultSearchResult[] = expanded.slice(0, maxResults).map((item) => {
    const meta = getDocumentMeta(db, item.path);
    const related = getRelatedTopByDegree(db, item.path, RELATED_LIMIT);

    // Snippet is built uniformly here from the note's own chunk texts, not
    // taken from the BM25 path's SQL `snippet()` column. Reason: every result
    // arriving via the vector-only / RRF / graph-expand branch carried an
    // empty snippet, and the old fallback returned chunk[0] verbatim —
    // which for the canonical note shape ("# Title" as the first body line)
    // is the degenerate "<Title>\n\n# <Title>" prefix chunk parser.chunkText
    // emits. Result: the snippet collapsed to a title echo and told the
    // reader nothing about *why* the note matched. buildSnippet instead
    // finds the body window around the actual query terms (or, for a pure
    // semantic hit with no lexical overlap, the first real prose), so the
    // snippet is what an agent uses to judge relevance without a vault_read.
    const snippet = buildSnippet(
      query,
      getChunkTexts(db, item.path),
      meta?.title ?? "",
    );

    return {
      title: meta?.title ?? item.path,
      path: item.path,
      type: meta?.type ?? null,
      status: meta?.status ?? null,
      score: maxScore > 0 ? Math.round((item.score / maxScore) * 1000) / 1000 : 0,
      snippet,
      related,
    } as VaultSearchResult;
  });

  return { results, pipeline };
}

export type DedupMatch = { path: string; title: string; similarity: number };

/** Dup band lower bound — raw cosine ≥ this ⇒ «possible duplicate» (§3a).
 *  0.78 confirmed on live TEI calibration: paraphrase
 *  0.81–0.88 caught, related-but-different ~0.72 excluded; 0.82 clipped heavy
 *  paraphrase at 0.815. Env-overridable (`IAPEER_MEMORY_DEDUP_THRESHOLD`). */
export const DEFAULT_DEDUP_THRESHOLD = 0.78;

/** Link-hint band lower bound — cosine in [this, DEDUP_THRESHOLD) ⇒
 *  «semantically close, maybe link» (§3b). HONEST framing: catches
 *  semantically SIMILAR notes, NOT complementary ones (a real link at cosine
 *  ~0.54 is missed) — additive to the Index's link saturation (§8), not a
 *  replacement. Env-overridable. */
export const DEFAULT_LINK_HINT_THRESHOLD = 0.68;

/**
 * Dedup hint (lean §3a): given the content of a CANON note being written,
 * find existing CANON notes with raw cosine similarity ≥ threshold. SEMANTIC
 * by design — with embeddings disabled it returns `{enabled:false}` and the
 * caller stays SILENT (a noisy BM25 overlap is worse than nothing; the author
 * has memory_search). Read-only; operative/inbox matches are excluded (a
 * canon note is not a duplicate of someone's operative note). Title = file
 * basename (the guard sets `title` from the file name), so the caller can
 * render `[[title]]`.
 */
export async function runDedup(
  db: CoreDb,
  config: CoreConfig,
  params: { content: string; threshold?: number; limit?: number; linkThreshold?: number },
): Promise<{ enabled: boolean; matches: DedupMatch[] }> {
  if (!config.embedding) return { enabled: false, matches: [] };
  const threshold = params.threshold ?? DEFAULT_DEDUP_THRESHOLD;
  // §3b: when a link-band lower bound is given, `threshold` is the DUP-band
  // bound and `linkThreshold` the LINK-band bound; each band gets its OWN cap so
  // a burst of ≥`limit` dup matches never starves the link band (both are
  // returned, the caller re-classifies by similarity). Without it → legacy
  // single-band behaviour (identical to before).
  const linkThreshold = params.linkThreshold;
  const lower = linkThreshold !== undefined ? Math.min(linkThreshold, threshold) : threshold;
  const limit = Math.max(1, params.limit ?? 5);
  const q = await embedQuery(params.content, config.embedding);
  if (!q.vector) return { enabled: true, matches: [] }; // embed failed / circuit-open → silent
  const raw = vectorSearch(db, q.vector, limit * 6); // headroom: canon filter + two bands
  const f = config.taxonomy.folders;
  // Live canon only — the archive is EXCLUDED. An archived note is dead: it is
  // not a real duplicate to merge against (§3a), and surfacing it as a link
  // target (§3b) would push the author to create an active→archive wikilink,
  // which the link-rule invariant forbids. Archived candidates are dropped.
  const canonHeads = new Set([f.knowledge, f.decisions, f.projects, f.ideas, f.lists]);
  const dup: DedupMatch[] = [];
  const link: DedupMatch[] = [];
  for (const r of raw) {
    if (r.score < lower) break; // raw is cosine-descending → below the lowest band, done
    const head = r.path.split("/")[0];
    if (!canonHeads.has(head)) continue; // live canon only — archive excluded
    const base = r.path.split("/").pop() ?? r.path;
    const m: DedupMatch = { path: r.path, title: base.replace(/\.md$/, ""), similarity: r.score };
    if (r.score >= threshold) {
      if (dup.length < limit) dup.push(m);
    } else if (linkThreshold !== undefined && r.score >= linkThreshold) {
      if (link.length < limit) link.push(m);
    }
    if (dup.length >= limit && (linkThreshold === undefined || link.length >= limit)) break;
  }
  return { enabled: true, matches: [...dup, ...link] };
}

// --- Vector search ---
//
// Hot path: `vec_chunks` virtual table from sqlite-vec, MATCH+ORDER BY runs
// the KNN inside the SQL engine. Per-query JS allocation: one Float32Array
// for the bound query vector plus K (chunk-level, before dedup-by-path)
// result rows = a few KB. Replaces the legacy brute-force path that pulled
// every chunk's BLOB into JS heap on every search (~25 MB/query at the
// current vault size, the root cause of the 04:45 panic).
//
// Fallback: when `db.vecAvailable` is false (no non-stripped libsqlite3 on
// the host, sqlite-vec didn't load), drop to the brute-force scan. It still
// produces correct results, just with the heap cost the vec path was
// introduced to eliminate. Kept so the system works on installs that don't
// have homebrew sqlite (or equivalent) yet.
//
// Score convention. sqlite-vec returns `distance` (cosine distance = 1 - sim,
// because we created the table with `distance_metric=cosine`). The rest of
// the pipeline ranks higher-is-better, so we surface `score = 1 - distance`
// — identical to what the legacy `cosineSimilarity` returned to ~1e-8.

function vectorSearch(
  db: CoreDb,
  queryVec: Float32Array,
  limit: number,
): Array<{ path: string; score: number }> {
  if (db.vecAvailable) {
    return vectorSearchVec(db, queryVec, limit);
  }
  return vectorSearchBruteForce(db, queryVec, limit);
}

function vectorSearchVec(
  db: CoreDb,
  queryVec: Float32Array,
  limit: number,
): Array<{ path: string; score: number }> {
  // KNN at the chunk level. Several chunks of the same doc can rank, so we
  // ask for limit*4 chunks (same expansion factor used in BM25 fetch upstream)
  // and dedup by path keeping the best chunk-level score per doc.
  //
  // sqlite-vec requires the K constraint inline in the WHERE clause via the
  // pseudo-column `k`, NOT as a bound `LIMIT ?` — without it the query fails
  // with "A LIMIT or 'k = ?' constraint is required on vec0 knn queries".
  // `k = ?` binds cleanly and is the documented hot path.
  const chunkLimit = limit * 4;
  const blob = new Uint8Array(queryVec.buffer, queryVec.byteOffset, queryVec.byteLength);
  const rows = db
    .prepare(
      `SELECT c.doc_path AS path, v.distance AS distance
       FROM vec_chunks v
       JOIN chunks c ON c.id = v.rowid
       WHERE v.embedding MATCH ? AND k = ?
       ORDER BY v.distance`,
    )
    .all(blob, chunkLimit) as Array<{ path: string; distance: number }>;

  const scored = new Map<string, number>();
  for (const row of rows) {
    const sim = 1 - row.distance;
    const existing = scored.get(row.path) ?? -Infinity;
    if (sim > existing) scored.set(row.path, sim);
  }

  return [...scored.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([path, score]) => ({ path, score }));
}

function vectorSearchBruteForce(
  db: CoreDb,
  queryVec: Float32Array,
  limit: number,
): Array<{ path: string; score: number }> {
  const rows = db
    .prepare(
      `SELECT c.doc_path as path, c.embedding as embedding
       FROM chunks c
       WHERE c.embedding IS NOT NULL`,
    )
    .all() as Array<{ path: string; embedding: Buffer }>;

  const scored = new Map<string, number>();
  for (const row of rows) {
    const vec = new Float32Array(row.embedding.buffer, row.embedding.byteOffset, row.embedding.byteLength / 4);
    const sim = cosineSimilarity(queryVec, vec);
    const existing = scored.get(row.path) ?? -Infinity;
    if (sim > existing) scored.set(row.path, sim);
  }

  return [...scored.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([path, score]) => ({ path, score }));
}

// --- RRF (Reciprocal Rank Fusion) ---

function rrfFusion(
  bm25: SearchRow[],
  vector: Array<{ path: string; score: number }>,
  k: number,
): Array<{ path: string; score: number; snippet: string }> {
  const scores = new Map<string, { score: number; snippet: string }>();

  // BM25 results are sorted by rank ASC (more negative = better match)
  bm25.forEach((r, idx) => {
    const rrfScore = 1 / (k + idx + 1);
    const existing = scores.get(r.path);
    scores.set(r.path, {
      score: (existing?.score ?? 0) + rrfScore,
      snippet: existing?.snippet || r.snippet,
    });
  });

  // Vector results are sorted by cosine similarity DESC
  vector.forEach((r, idx) => {
    const rrfScore = 1 / (k + idx + 1);
    const existing = scores.get(r.path);
    scores.set(r.path, {
      score: (existing?.score ?? 0) + rrfScore,
      snippet: existing?.snippet ?? "",
    });
  });

  return [...scores.entries()]
    .map(([path, { score, snippet }]) => ({ path, score, snippet }))
    .sort((a, b) => b.score - a.score);
}

// --- Status boost (active/stale/pending) ---
//
// Применяется ДО rerank'а: семантическое свойство заметки, осмысленно
// нормализуется reranker'ом в пуле кандидатов.
//
// Поле needs_review — авто-флаг «Индекс ещё не подтвердил», ставится
// hook/watcher на любую правку. Не применяет penalty в поиске: активно
// правящиеся заметки иначе зависают в полузабытом состоянии до
// permanent-tick'а (до 6 часов) — инверсия ранжирования. Флаг работает
// как маркер для Индекса/монитора, не как сигнал ранжирования.
function applyStatusBoost(
  db: CoreDb,
  items: Array<{ path: string; score: number; snippet: string }>,
  config: CoreConfig,
): Array<{ path: string; score: number; snippet: string }> {
  return items.map((item) => {
    const meta = getDocumentMeta(db, item.path);
    if (!meta) return item;

    const status = meta.status?.toLowerCase();
    let multiplier = 1.0;
    const group = status ? statusGroup(config.taxonomy, status) : null;
    if (group === "active") {
      multiplier = config.ranking.activeBoost;
    } else if (group === "stale") {
      multiplier = config.ranking.stalePenalty;
    } else if (group === "pending") {
      multiplier = config.ranking.pendingPenalty;
    }
    return { ...item, score: item.score * multiplier };
  });
}

// --- Foreign-operative penalty ---
//
// Применяется ПОСЛЕ rerank'а: множитель ×0.7 размывался бы нормализацией
// `item.score / maxScore` внутри applyReranker (проверено репро — penalty в
// проде не имел эффекта пока стоял до rerank'а). Здесь же — финальный
// score, без последующего нормализующего шага кроме сортировки.
//
// `callerAgent` берётся из env `IAPEER_MEMORY_AGENT_NAME (fallback; первичен identity MCP-подключения, ADR-012)`. Если не задан
// (локальный CC без connect) — caller выше пропускает вызов, penalty не
// применяется, вся оперативка видна как есть. Параметр author лежит в
// frontmatter заметки (load-bearing — равен имени подпапки
// `06_Оперативка_агентов/<имя>/`).
function applyForeignOperativePenalty(
  db: CoreDb,
  items: Array<{ path: string; score: number; snippet: string }>,
  callerAgent: string,
  config: CoreConfig,
): Array<{ path: string; score: number; snippet: string }> {
  const marker = agentMemoryFolderMarker(config.taxonomy);
  return items.map((item) => {
    if (!item.path.includes(marker)) return item;
    const meta = getDocumentMeta(db, item.path);
    if (!meta) return item;
    const author = meta.frontmatter?.author as string | undefined;
    if (!author || author === callerAgent) return item;
    return { ...item, score: item.score * config.ranking.foreignAgentMemoryPenalty };
  });
}

// --- Cross-encoder reranker ---

async function applyReranker(
  db: CoreDb,
  query: string,
  items: Array<{ path: string; score: number; snippet: string }>,
  config: CoreConfig,
): Promise<{
  items: Array<{ path: string; score: number; snippet: string }>;
  status: RerankerStatus;
}> {
  // Caller проверяет наличие reranker до вызова — этот guard просто
  // защищает от опечатки и возвращает все исходные элементы со статусом
  // "ok" (sentinel — фактического сетевого вызова не было).
  if (!config.reranker) return { items, status: "ok" };

  const topK = Math.min(items.length, config.reranker.topK);
  const candidates = items.slice(0, topK);

  // Build texts for reranking: use snippets or titles
  const texts = candidates.map((item) => {
    const meta = getDocumentMeta(db, item.path);
    const title = meta?.title ?? item.path;
    const snippet = item.snippet || "";
    return `${title}\n${snippet}`.trim();
  });

  const rerankResp = await rerank(query, texts, config.reranker);
  if (!rerankResp.items) {
    // Reranker недоступен (timeout / error / circuit-open) — оставляем
    // RRF-ранжирование, статус прокидываем наверх для pipeline.reranker.
    return { items, status: rerankResp.status };
  }
  const ranked = rerankResp.items;

  // Merge reranker scores with existing scores
  const rerankerWeight = config.reranker.weight ?? 0.7;
  const fusionWeight = 1 - rerankerWeight;

  // Normalize existing scores to [0, 1]
  const maxScore = Math.max(...candidates.map((c) => c.score), 0.001);

  const reranked = candidates.map((item, idx) => {
    const rerankResult = ranked.find((r) => r.index === idx);
    const rerankScore = rerankResult?.score ?? 0;
    const normalizedFusion = item.score / maxScore;
    return {
      ...item,
      score: fusionWeight * normalizedFusion + rerankerWeight * rerankScore,
    };
  });

  // Add remaining items (not reranked) with reduced scores
  const remaining = items.slice(topK).map((item) => ({
    ...item,
    score: item.score * 0.3, // Penalize items that didn't make it to reranking
  }));

  return { items: [...reranked, ...remaining], status: "ok" };
}

// --- Graph expand ---

function graphExpand(
  db: CoreDb,
  items: Array<{ path: string; score: number; snippet: string }>,
  maxResults: number,
  config: CoreConfig,
): Array<{ path: string; score: number; snippet: string }> {
  const existing = new Set(items.map((i) => i.path));
  const expanded = [...items];

  for (const item of items) {
    if (expanded.length >= maxResults * 2) break;
    const neighbors = getRelatedPaths(db, item.path, 3);
    for (const neighborPath of neighbors) {
      if (existing.has(neighborPath)) continue;
      // Only include neighbors that exist in the index
      const meta = getDocumentMeta(db, neighborPath);
      if (!meta) continue;
      existing.add(neighborPath);
      expanded.push({
        path: neighborPath,
        score: item.score * config.ranking.graphExpandPenalty,
        snippet: "",
      });
    }
  }

  return expanded;
}

// --- Backlink boost ---

function applyBacklinkBoost(
  db: CoreDb,
  items: Array<{ path: string; score: number; snippet: string }>,
  config: CoreConfig,
): void {
  for (const item of items) {
    const backlinkCount = (
      db
        .prepare("SELECT COUNT(*) as n FROM edges WHERE target_path = ?")
        .get(item.path) as { n: number }
    ).n;
    if (backlinkCount >= config.ranking.backlinkHubThreshold) {
      item.score *= config.ranking.backlinkHubBoost;
    }
  }
}

// --- Related paths with metadata ---

/**
 * Return up to `limit` related notes (incoming + outgoing wikilink neighbors)
 * sorted by their own total degree in the edges graph — i.e. the most
 * "hub-like" neighbors first. Hub neighbors are usually more useful to surface
 * than leaf siblings.
 *
 * Single SQL pass via UNION + COUNT subqueries instead of N+1 getDocumentMeta
 * calls.
 */
function getRelatedTopByDegree(
  db: CoreDb,
  docPath: string,
  limit: number,
): Array<{ path: string; title: string; direction: string }> {
  const rows = db
    .prepare(
      `
      WITH neighbors AS (
        SELECT target_path AS path, 'outgoing' AS direction FROM edges WHERE source_path = ?
        UNION
        SELECT source_path AS path, 'incoming' AS direction FROM edges WHERE target_path = ?
      )
      SELECT
        n.path AS path,
        n.direction AS direction,
        d.title AS title,
        (
          (SELECT COUNT(*) FROM edges WHERE source_path = n.path) +
          (SELECT COUNT(*) FROM edges WHERE target_path = n.path)
        ) AS degree
      FROM neighbors n
      JOIN documents d ON d.path = n.path
      ORDER BY degree DESC, n.path ASC
      LIMIT ?
      `,
    )
    .all(docPath, docPath, limit) as Array<{
      path: string;
      direction: string;
      title: string;
      degree: number;
    }>;

  // Dedup by path (UNION already does, but a note can have edges in both
  // directions and SQL UNION keeps both rows — we keep the first/highest-degree).
  const seen = new Set<string>();
  const result: Array<{ path: string; title: string; direction: string }> = [];
  for (const r of rows) {
    if (seen.has(r.path)) continue;
    seen.add(r.path);
    result.push({ path: r.path, title: r.title, direction: r.direction });
  }
  return result;
}

// --- Query-aware snippet builder ---
//
// Exported for unit tests. Given a query, a note's ordered chunk texts and its
// title, returns a body fragment that shows *why* the note is relevant: the
// window around the densest cluster of query terms, with those terms wrapped
// in [brackets]. Falls back to the first real prose when the match is purely
// semantic (vector hit, zero lexical overlap). Never returns the title echo.

/**
 * Drop leading lines that are pure structure, not content: the bare title
 * (parser.chunkText prepends it to chunk[0]) and any markdown headings
 * ("# Title" — the canonical first body line of every vault note). Returns
 * the first prose onward. A chunk that is *only* title+heading collapses to
 * "" and is skipped by the caller — that is exactly the degenerate
 * "<Title>\n\n# <Title>" chunk[0] this whole fix exists to stop surfacing.
 */
export function stripLeadingTitleEcho(text: string, title: string): string {
  const lines = text.split("\n");
  const t = title.trim().toLowerCase();
  let i = 0;
  while (i < lines.length) {
    const line = lines[i].trim();
    if (line === "") {
      i++;
      continue;
    }
    const isHeading = /^#{1,6}\s/.test(line);
    const isBareTitle = t.length > 0 && line.toLowerCase() === t;
    if (isHeading || isBareTitle) {
      i++;
      continue;
    }
    break;
  }
  return lines.slice(i).join("\n").trim();
}

/**
 * Best window over `text` for `terms`: the offset of the matched term that
 * starts the SNIPPET_WINDOW_CHARS span covering the most *distinct* terms
 * (tie-break: most total hits, then earliest). null = no term occurs at all.
 */
function bestWindow(
  text: string,
  terms: string[],
): { start: number; distinct: number; hits: number } | null {
  const lower = text.toLowerCase();
  const matches: Array<{ idx: number; term: string }> = [];
  for (const term of terms) {
    let from = 0;
    for (;;) {
      const idx = lower.indexOf(term, from);
      if (idx === -1) break;
      matches.push({ idx, term });
      from = idx + term.length;
    }
  }
  if (matches.length === 0) return null;
  matches.sort((a, b) => a.idx - b.idx);

  let best: { start: number; distinct: number; hits: number } | null = null;
  for (let i = 0; i < matches.length; i++) {
    const winEnd = matches[i].idx + SNIPPET_WINDOW_CHARS;
    const seenTerms = new Set<string>();
    let hits = 0;
    for (let j = i; j < matches.length && matches[j].idx < winEnd; j++) {
      seenTerms.add(matches[j].term);
      hits++;
    }
    const distinct = seenTerms.size;
    if (
      !best ||
      distinct > best.distinct ||
      (distinct === best.distinct && hits > best.hits)
    ) {
      best = { start: matches[i].idx, distinct, hits };
    }
  }
  return best;
}

/** Wrap every occurrence of any term in `[ ]`, preserving original casing.
 *  Single left-to-right scan (longest term wins) — no nested/overlap wraps. */
function highlightTerms(text: string, terms: string[]): string {
  const lower = text.toLowerCase();
  let out = "";
  let i = 0;
  while (i < text.length) {
    let matched = "";
    for (const term of terms) {
      if (term.length > matched.length && lower.startsWith(term, i)) {
        matched = term;
      }
    }
    if (matched) {
      out += "[" + text.slice(i, i + matched.length) + "]";
      i += matched.length;
    } else {
      out += text[i];
      i += 1;
    }
  }
  return out;
}

/** Cut the window around `matchStart`, snap to word boundaries, ellipsize the
 *  cut edges, then highlight the query terms inside it. */
function extractWindow(
  text: string,
  matchStart: number,
  terms: string[],
): string {
  let start = Math.max(0, matchStart - SNIPPET_LEAD_CHARS);
  if (start > 0) {
    const sp = text.indexOf(" ", start);
    if (sp !== -1 && sp - start < 30) start = sp + 1;
  }
  let end = Math.min(text.length, start + SNIPPET_WINDOW_CHARS);
  const truncatedRight = end < text.length;
  if (truncatedRight) {
    // Inside the chunk — snap back to a word boundary so we don't cut a word.
    const sp = text.lastIndexOf(" ", end);
    if (sp > start) end = sp;
  }
  let raw = text.slice(start, end).trim();

  // `text` is one chunk — a ~500-char cut of the note — so even when the
  // window reaches the chunk's end it is usually mid-sentence, not the
  // note's end. Trailing "…" unless we stopped on sentence punctuation.
  const endsClean = /[.!?…»"”)\]]$/.test(raw);
  if (!truncatedRight && !endsClean) {
    raw = raw.replace(/\s*\S*$/, ""); // drop the dangling partial word
  }

  let slice = highlightTerms(raw.trim(), terms);
  if (start > 0) slice = "…" + slice;
  if (truncatedRight || !endsClean) slice = slice + "…";
  return slice;
}

export function buildSnippet(
  query: string,
  chunks: string[],
  title: string,
): string {
  const terms = [
    ...new Set(
      queryTokens(query)
        .map((t) => t.toLowerCase())
        .filter((t) => t.length >= 2),
    ),
  ];

  const cleaned = chunks
    .map((c, idx) => ({
      idx,
      text: stripLeadingTitleEcho(c, title).replace(/\s+/g, " ").trim(),
    }))
    .filter((c) => c.text.length > 0);
  if (cleaned.length === 0) return EMPTY_NOTE_SNIPPET;

  if (terms.length > 0) {
    let pick:
      | { idx: number; text: string; w: ReturnType<typeof bestWindow> }
      | null = null;
    for (const c of cleaned) {
      const w = bestWindow(c.text, terms);
      if (!w) continue;
      if (
        !pick ||
        w.distinct > pick.w!.distinct ||
        (w.distinct === pick.w!.distinct && w.hits > pick.w!.hits)
        // earlier chunk wins on a full tie: it iterates first, so the
        // strict `>` comparisons above already keep the first-seen best.
      ) {
        pick = { idx: c.idx, text: c.text, w };
      }
    }
    if (pick && pick.w) {
      return extractWindow(pick.text, pick.w.start, terms);
    }
  }

  // No lexical overlap (pure semantic / graph-expanded hit) — head of the
  // first real prose chunk. Still query-honest: there is nothing to centre on.
  const head = cleaned[0].text;
  if (head.length <= SNIPPET_WINDOW_CHARS) return head;
  return head.slice(0, SNIPPET_WINDOW_CHARS).replace(/\s*\S*$/, "") + "…";
}
