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
};

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

/** Parse one response into vectors, or null when the shape is wrong. */
function parseResponse(json: unknown, config: EmbeddingConfig): Float32Array[] | null {
  const provider = config.provider ?? "openai";
  try {
    if (provider === "openai") {
      const data = (json as { data: Array<{ embedding: number[] }> }).data;
      return data.map((item) => new Float32Array(item.embedding));
    }
    // tei: a bare array of float arrays
    const rows = json as number[][];
    if (!Array.isArray(rows)) return null;
    return rows.map((row) => new Float32Array(row));
  } catch {
    return null;
  }
}

/**
 * Embed a batch of texts. Returns `{vectors, status}` where `vectors === null`
 * on any non-ok status. Callers check `status` when they need to tell a
 * timeout from an error.
 */
export async function embedTexts(
  texts: string[],
  config: EmbeddingConfig,
  signal?: AbortSignal,
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
      breaker,
    });
    if (result.status !== "ok") {
      return { vectors: null, status: result.status };
    }

    const vectors = parseResponse(result.json, config);
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
