/**
 * Shared HTTP client for embedding/reranker provider adapters (ADR-013).
 *
 * Owns the cross-provider mechanics so adapters stay pure request/response
 * mappers: default timeout (a hung endpoint must not eat the ~30s fetch
 * default on every search), failure classification and a circuit breaker
 * (after N consecutive failures calls are skipped for a cooldown — search
 * stays on its graceful BM25 fallback without paying the timeout each time).
 *
 * Each consumer creates its OWN breaker instance: embedding failures must
 * not block reranking and vice versa (parity with the reference behaviour
 * where each module kept its own module-level counters).
 */

export type ProviderCallStatus = "ok" | "timeout" | "error" | "circuit-open";

// One fetch to a local/LAN inference endpoint normally answers in <500ms.
// 3s is a generous threshold that catches an unreachable endpoint without
// cutting legitimate answers under load.
export const DEFAULT_TIMEOUT_MS = 3000;
const FAILURE_THRESHOLD = 2;
const COOLDOWN_MS = 60_000;

export type CircuitBreaker = {
  /** True while in cooldown — the caller must skip the network call. */
  isOpen(): boolean;
  recordFailure(): void;
  recordSuccess(): void;
  /** Test-only: reset counters between test cases. */
  _resetForTests(): void;
};

export function makeCircuitBreaker(
  failureThreshold: number = FAILURE_THRESHOLD,
  cooldownMs: number = COOLDOWN_MS,
): CircuitBreaker {
  let consecutiveFailures = 0;
  let cooldownUntil = 0;
  return {
    isOpen: () => Date.now() < cooldownUntil,
    recordFailure: () => {
      consecutiveFailures += 1;
      if (consecutiveFailures >= failureThreshold) {
        cooldownUntil = Date.now() + cooldownMs;
      }
    },
    recordSuccess: () => {
      consecutiveFailures = 0;
      cooldownUntil = 0;
    },
    _resetForTests: () => {
      consecutiveFailures = 0;
      cooldownUntil = 0;
    },
  };
}

function classifyFetchError(err: unknown): ProviderCallStatus {
  if (err instanceof Error) {
    if (err.name === "TimeoutError" || err.name === "AbortError") return "timeout";
  }
  return "error";
}

export type PostJsonResult =
  | { json: unknown; status: "ok" }
  | { json: null; status: Exclude<ProviderCallStatus, "ok"> };

/**
 * POST a JSON body and parse a JSON response, with breaker/timeout/failure
 * accounting. Returns `{json, status}`; `json === null` on any non-ok
 * status. Success resets the breaker; timeout/non-2xx/parse failure record
 * a failure. The caller-supplied signal is honoured as-is (the caller
 * controls cancellation, e.g. batch indexing); otherwise the default
 * timeout signal is attached.
 */
export async function postJson(opts: {
  endpoint: string;
  body: unknown;
  apiKey?: string | null;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  timeoutMs?: number;
  breaker: CircuitBreaker;
}): Promise<PostJsonResult> {
  if (opts.breaker.isOpen()) {
    return { json: null, status: "circuit-open" };
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(opts.headers ?? {}),
  };
  if (opts.apiKey) {
    headers["Authorization"] = `Bearer ${opts.apiKey}`;
  }

  const effectiveSignal =
    opts.signal ?? AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  let resp: Response;
  try {
    resp = await fetch(opts.endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(opts.body),
      signal: effectiveSignal,
    });
  } catch (err) {
    opts.breaker.recordFailure();
    return { json: null, status: classifyFetchError(err) };
  }

  if (!resp.ok) {
    opts.breaker.recordFailure();
    return { json: null, status: "error" };
  }

  let json: unknown;
  try {
    json = await resp.json();
  } catch {
    opts.breaker.recordFailure();
    return { json: null, status: "error" };
  }

  opts.breaker.recordSuccess();
  return { json, status: "ok" };
}
