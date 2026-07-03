/**
 * Embedding provider adapters (ADR-013) on top of the shared HTTP client.
 *
 * Providers (`EmbeddingProvider`):
 * - `openai` — OpenAI-compatible `/v1/embeddings`:
 *     request  { input: [...texts], model }
 *     response { data: [{ embedding: [number...] }, ...] }
 *   This is the DEFAULT and the behaviour inherited verbatim from the
 *   reference client (which spoke this wire format against TEI's
 *   OpenAI-compatible endpoint). It covers OpenAI, NVIDIA NIM
 *   (openai-compat), and the key local case — Ollama / LM Studio /
 *   llama.cpp server on localhost.
 * - `tei` — native TEI `/embed`:
 *     request  { inputs: [...texts] }
 *     response [ [number...], ... ]
 *
 * Graceful degradation: `{vectors: null, status}` when the endpoint is
 * unavailable or returns malformed data — search falls back to BM25-only.
 * Timeout & circuit breaker live in the shared client (`http-client.ts`);
 * this module keeps its OWN breaker instance so embedding failures never
 * block the reranker and vice versa.
 */

import { makeCircuitBreaker, postJson } from "./http-client.js";
import type { ProviderCallStatus } from "./http-client.js";

export type EmbeddingProvider = "tei" | "openai";

export const EMBEDDING_PROVIDERS: readonly EmbeddingProvider[] = ["tei", "openai"];

export function isEmbeddingProvider(value: string): value is EmbeddingProvider {
  return (EMBEDDING_PROVIDERS as readonly string[]).includes(value);
}

export type EmbeddingConfig = {
  endpoint: string;
  model: string;
  dimensions: number;
  batchSize: number;
  // Bearer token when the endpoint sits behind auth (cloud providers,
  // reverse-proxied local servers). Null for direct local access.
  apiKey: string | null;
  /** Wire format (ADR-013). Default "openai" — the inherited behaviour. */
  provider?: EmbeddingProvider;
  /**
   * Per-batch timeout for the INDEXING path (embedMissingChunks), ms.
   * The shared http-client default (3s) is calibrated for ONE short query
   * text; a full batch (batchSize × chunkSize chars) on a busy local
   * endpoint legitimately takes 4–10s+. Left at 3s, every batch aborts,
   * the vault never embeds, and nothing reports it (audit critical #3).
   * The QUERY path deliberately stays on the 3s default — an interactive
   * search must not hang a minute on a dead endpoint.
   */
  indexTimeoutMs?: number;
};

/** Default for {@link EmbeddingConfig.indexTimeoutMs} — generous enough for a
 *  CPU-bound local endpoint chewing a full batch, still finite. */
export const DEFAULT_INDEX_TIMEOUT_MS = 60_000;

/**
 * Status of a single embedding call, surfaced up to the memory_search
 * response (`pipeline.embedding`).
 *
 * - `ok`           — valid response;
 * - `timeout`      — fetch aborted by the default timeout;
 * - `error`        — non-2xx, network failure or malformed payload;
 * - `circuit-open` — skipped without a network call (breaker in cooldown).
 */
export type EmbeddingStatus = ProviderCallStatus;

export type EmbedBatchResult = {
  vectors: Float32Array[] | null;
  status: EmbeddingStatus;
};

export type EmbedQueryResult = {
  vector: Float32Array | null;
  status: EmbeddingStatus;
};

// Per-process breaker: resets on process restart, which is what we want —
// every new session gives the endpoint a fresh chance.
const breaker = makeCircuitBreaker();

/**
 * Test-only helper to reset the circuit breaker between test cases.
 */
export function _resetEmbeddingCircuitForTests(): void {
  breaker._resetForTests();
}

function buildRequestBody(batch: string[], config: EmbeddingConfig): unknown {
  const provider = config.provider ?? "openai";
  switch (provider) {
    case "openai":
      return { input: batch, model: config.model };
    case "tei":
      return { inputs: batch };
  }
}

/**
 * Parse one response into vectors, or null when the shape is wrong.
 *
 * VALIDATED, not trusted (audit important): the raw `data.map(new
 * Float32Array(item.embedding))` accepted any shape — a short response gave
 * `undefined` vectors (TypeError downstream), a missing `embedding` field
 * became a 0-length vector stored as non-NULL (never re-embedded, NaN in
 * cosine), a server-side model swap to another dimensionality crashed every
 * vec insert forever, and out-of-order rows would bind chunk A's text to
 * chunk B's vector silently. Checks: row count == batch length, every vector
 * matches config.dimensions, openai rows sorted by their `index` field when
 * present (the spec does not guarantee order — that's what `index` is for).
 * Any mismatch → null → the caller's existing graceful error path.
 */
function parseResponse(
  json: unknown,
  config: EmbeddingConfig,
  batchLength: number,
): Float32Array[] | null {
  const provider = config.provider ?? "openai";
  try {
    let rows: unknown[];
    if (provider === "openai") {
      const data = (json as { data?: Array<{ embedding?: unknown; index?: unknown }> }).data;
      if (!Array.isArray(data) || data.length !== batchLength) return null;
      const ordered = data.every((item) => typeof item?.index === "number")
        ? [...data].sort((a, b) => (a.index as number) - (b.index as number))
        : data;
      rows = ordered.map((item) => item?.embedding);
    } else {
      // tei: a bare array of float arrays
      if (!Array.isArray(json) || json.length !== batchLength) return null;
      rows = json as unknown[];
    }
    const out: Float32Array[] = [];
    for (const row of rows) {
      if (!Array.isArray(row)) return null;
      const vector = new Float32Array(row as number[]);
      if (vector.length !== config.dimensions) return null;
      out.push(vector);
    }
    return out;
  } catch {
    return null;
  }
}

/**
 * Embed a batch of texts. Returns `{vectors, status}` where `vectors === null`
 * on any non-ok status. Callers check `status` when they need to tell a
 * timeout from an error.
 *
 * `timeoutMs` applies PER BATCH (each inner postJson call) and only when no
 * caller `signal` is given — a caller-supplied signal replaces the timeout
 * entirely (postJson contract). The indexing path passes its long
 * `indexTimeoutMs` here; the query path omits it and keeps the strict 3s
 * default.
 */
export async function embedTexts(
  texts: string[],
  config: EmbeddingConfig,
  signal?: AbortSignal,
  timeoutMs?: number,
): Promise<EmbedBatchResult> {
  if (!texts.length) return { vectors: [], status: "ok" };

  const allVectors: Float32Array[] = [];

  for (let i = 0; i < texts.length; i += config.batchSize) {
    const batch = texts.slice(i, i + config.batchSize);

    const result = await postJson({
      endpoint: config.endpoint,
      body: buildRequestBody(batch, config),
      apiKey: config.apiKey,
      signal,
      timeoutMs,
      breaker,
    });
    if (result.status !== "ok") {
      return { vectors: null, status: result.status };
    }

    const vectors = parseResponse(result.json, config, batch.length);
    if (vectors === null) {
      breaker.recordFailure();
      return { vectors: null, status: "error" };
    }
    allVectors.push(...vectors);
  }

  return { vectors: allVectors, status: "ok" };
}

/**
 * Embed a single text. Returns `{vector, status}` where `vector === null`
 * on any non-ok status.
 */
export async function embedQuery(
  text: string,
  config: EmbeddingConfig,
): Promise<EmbedQueryResult> {
  const result = await embedTexts([text], config);
  return {
    vector: result.vectors?.[0] ?? null,
    status: result.status,
  };
}

/**
 * Cosine similarity of two vectors.
 */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}
