/**
 * Reranker provider adapters (ADR-013) on top of the shared HTTP client.
 *
 * Providers (`RerankerProvider`) — every adapter maps to a uniform
 * `RerankItem[] = [{index, score}]`, sorted by descending score:
 *
 * - `tei` — native TEI `/rerank` (DEFAULT, inherited behaviour):
 *     request  { query, texts }
 *     response [ { index, score }, ... ]
 * - `jina` — Jina reranker API and compatibles; covers the key LOCAL case:
 *   llama.cpp server `/v1/rerank` speaks this format (fact-checked
 *   against tools/server/README.md — request is
 *   {query, documents}, "similar to jina", NOT TEI-compatible):
 *     request  { model, query, documents: [...texts], top_n }
 *     response { results: [{ index, relevance_score }, ...] }
 * - `cohere` — Cohere v2 `/v2/rerank` (same wire shape as jina; kept as a
 *   separate provider so endpoint defaults/docs stay honest):
 *     request  { model, query, documents: [...texts], top_n }
 *     response { results: [{ index, relevance_score }, ...] }
 * - `nvidia` — NeMo Retriever ranking NIM `/v1/ranking`:
 *     request  { model, query: {text}, passages: [{text}, ...], truncate: "END" }
 *     response { rankings: [{ index, logit }, ...] }  (logit = score)
 *
 * `none` is a config-level value (reranker disabled), not an adapter —
 * configFromEnv resolves it to a null reranker block.
 *
 * Graceful degradation: `{items: null, status}` on any failure — the search
 * pipeline keeps its pre-rerank ranking. Timeout & circuit breaker live in
 * the shared client; this module keeps its OWN breaker instance (reranker
 * failures must not block embeddings and vice versa).
 */

import { makeCircuitBreaker, postJson } from "./http-client.js";
import type { ProviderCallStatus } from "./http-client.js";

export type RerankerProvider = "tei" | "cohere" | "nvidia" | "jina";

export const RERANKER_PROVIDERS: readonly RerankerProvider[] = [
  "tei",
  "cohere",
  "nvidia",
  "jina",
];

export function isRerankerProvider(value: string): value is RerankerProvider {
  return (RERANKER_PROVIDERS as readonly string[]).includes(value);
}

export type RerankerConfig = {
  endpoint: string;
  model: string;
  topK: number;
  // Bearer token when the endpoint sits behind auth. Null for direct
  // local access.
  apiKey: string | null;
  /** Wire format (ADR-013). Default "tei" — the inherited behaviour. */
  provider?: RerankerProvider;
};

export type RerankItem = {
  index: number;
  score: number;
};

export type RerankerStatus = ProviderCallStatus;

export type RerankResult = {
  items: RerankItem[] | null;
  status: RerankerStatus;
};

const breaker = makeCircuitBreaker();

/**
 * Test-only helper to reset the circuit breaker between test cases.
 */
export function _resetRerankerCircuitForTests(): void {
  breaker._resetForTests();
}

function buildRequestBody(
  query: string,
  texts: string[],
  config: RerankerConfig,
): unknown {
  const provider = config.provider ?? "tei";
  switch (provider) {
    case "tei":
      return { query, texts };
    case "jina":
    case "cohere":
      return { model: config.model, query, documents: texts, top_n: config.topK };
    case "nvidia":
      return {
        model: config.model,
        query: { text: query },
        passages: texts.map((text) => ({ text })),
        truncate: "END",
      };
  }
}

/** Parse one response into RerankItem[], or null when the shape is wrong. */
function parseResponse(json: unknown, config: RerankerConfig): RerankItem[] | null {
  const provider = config.provider ?? "tei";
  try {
    if (provider === "tei") {
      const items = json as RerankItem[];
      if (!Array.isArray(items)) return null;
      return items.map((i) => ({ index: i.index, score: i.score }));
    }
    if (provider === "nvidia") {
      const rankings = (json as { rankings: Array<{ index: number; logit: number }> })
        .rankings;
      if (!Array.isArray(rankings)) return null;
      return rankings.map((r) => ({ index: r.index, score: r.logit }));
    }
    // jina / cohere
    const results = (
      json as { results: Array<{ index: number; relevance_score: number }> }
    ).results;
    if (!Array.isArray(results)) return null;
    return results.map((r) => ({ index: r.index, score: r.relevance_score }));
  } catch {
    return null;
  }
}

/**
 * Rerank documents against a query. Returns `{items, status}` where `items`
 * are sorted by descending score, or `null` on any non-ok status.
 */
export async function rerank(
  query: string,
  texts: string[],
  config: RerankerConfig,
  signal?: AbortSignal,
): Promise<RerankResult> {
  if (!texts.length) return { items: [], status: "ok" };

  const result = await postJson({
    endpoint: config.endpoint,
    body: buildRequestBody(query, texts, config),
    apiKey: config.apiKey,
    signal,
    breaker,
  });
  if (result.status !== "ok") {
    return { items: null, status: result.status };
  }

  const items = parseResponse(result.json, config);
  if (items === null) {
    breaker.recordFailure();
    return { items: null, status: "error" };
  }

  return {
    items: items.sort((a, b) => b.score - a.score),
    status: "ok",
  };
}
