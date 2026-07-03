import { describe, it, expect, beforeEach, afterEach, vi } from "bun:test";
import {
  cosineSimilarity,
  embedTexts,
  embedQuery,
  _resetEmbeddingCircuitForTests,
  type EmbeddingConfig,
} from "../src/embedding.js";

function f32(...nums: number[]): Float32Array {
  return new Float32Array(nums);
}

function makeConfig(overrides: Partial<EmbeddingConfig> = {}): EmbeddingConfig {
  return {
    endpoint: "http://fake/v1/embeddings",
    model: "fake-model",
    dimensions: 3,
    batchSize: 32,
    apiKey: null,
    ...overrides,
  };
}

function mockEmbeddingResponse(vectors: number[][]): Response {
  return new Response(
    JSON.stringify({ data: vectors.map((v) => ({ embedding: v })) }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

describe("cosineSimilarity", () => {
  it("returns 1 for identical unit vectors", () => {
    const v = f32(1, 0, 0);
    expect(cosineSimilarity(v, v)).toBeCloseTo(1, 6);
  });

  it("returns 0 for orthogonal vectors", () => {
    expect(cosineSimilarity(f32(1, 0), f32(0, 1))).toBeCloseTo(0, 6);
  });

  it("returns -1 for opposite vectors", () => {
    expect(cosineSimilarity(f32(1, 2, 3), f32(-1, -2, -3))).toBeCloseTo(-1, 6);
  });

  it("is invariant to scaling (cosine, not dot product)", () => {
    const a = f32(1, 2, 3);
    const b = f32(2, 4, 6); // 2× a
    expect(cosineSimilarity(a, b)).toBeCloseTo(1, 6);
  });

  it("is symmetric", () => {
    const a = f32(0.1, 0.4, 0.9);
    const b = f32(0.5, 0.5, 0.2);
    expect(cosineSimilarity(a, b)).toBeCloseTo(cosineSimilarity(b, a), 9);
  });

  it("handles zero vector without NaN (returns 0)", () => {
    // Division by zero norm — implementation should guard. If it doesn't,
    // this test will surface that as a bug.
    const result = cosineSimilarity(f32(0, 0, 0), f32(1, 2, 3));
    expect(Number.isFinite(result)).toBe(true);
  });
});

// Circuit breaker и timeout state живут в module — обязательно сбрасываем
// между тестами, иначе один failing test роняет breaker и все следующие
// получают status="circuit-open" вместо своего ожидаемого исхода.
describe("embedTexts — happy path", () => {
  beforeEach(() => _resetEmbeddingCircuitForTests());
  afterEach(() => vi.restoreAllMocks());

  it("returns vectors with status 'ok' on 2xx response", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      mockEmbeddingResponse([[0.1, 0.2, 0.3]]),
    );

    const result = await embedTexts(["hi"], makeConfig());
    expect(result.status).toBe("ok");
    expect(result.vectors).not.toBeNull();
    expect(result.vectors!.length).toBe(1);
    expect(Array.from(result.vectors![0])).toEqual([
      Math.fround(0.1),
      Math.fround(0.2),
      Math.fround(0.3),
    ]);
  });

  it("returns empty vectors array (no fetch) when input is empty", async () => {
    const spy = vi.spyOn(globalThis, "fetch");
    const result = await embedTexts([], makeConfig());
    expect(result.status).toBe("ok");
    expect(result.vectors).toEqual([]);
    expect(spy).not.toHaveBeenCalled();
  });

  it("embedQuery wraps embedTexts and returns single vector", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      mockEmbeddingResponse([[1, 0, 0]]),
    );
    const result = await embedQuery("hi", makeConfig());
    expect(result.status).toBe("ok");
    expect(result.vector).not.toBeNull();
    expect(Array.from(result.vector!)).toEqual([1, 0, 0]);
  });

  it("batches input according to config.batchSize (multiple fetch calls)", async () => {
    // 33 texts с batchSize=10 → 4 batch'а (10+10+10+3).
    const spy = vi.spyOn(
    globalThis as unknown as { fetch: (...args: unknown[]) => Promise<Response> },
    "fetch",
  ).mockImplementation(async () =>
      mockEmbeddingResponse([[0, 0, 0]]),
    );
    const texts = Array.from({ length: 33 }, (_, i) => `t${i}`);
    await embedTexts(texts, makeConfig({ batchSize: 10 }));
    expect(spy).toHaveBeenCalledTimes(4);
  });
});

describe("embedTexts — indexing timeout plumbing (audit critical #3)", () => {
  beforeEach(() => _resetEmbeddingCircuitForTests());
  afterEach(() => vi.restoreAllMocks());

  // A fetch mock that HONOURS the abort signal: resolves after `delayMs`
  // unless the signal fires first — the real-fetch timeout semantics the
  // 3s-default regression hid behind mocks that ignored the signal.
  function slowEndpointMock(delayMs: number) {
    return vi
      .spyOn(globalThis as unknown as { fetch: (url: unknown, init?: RequestInit) => Promise<Response> }, "fetch")
      .mockImplementation(
        (_url: unknown, init?: RequestInit) =>
          new Promise<Response>((resolve, reject) => {
            const t = setTimeout(() => resolve(mockEmbeddingResponse([[0, 0, 0]])), delayMs);
            init?.signal?.addEventListener("abort", () => {
              clearTimeout(t);
              const err = new Error("aborted");
              err.name = "AbortError";
              reject(err);
            });
          }),
      );
  }

  it("a slow batch that outlives the passed timeout aborts as 'timeout'", async () => {
    slowEndpointMock(200);
    const result = await embedTexts(["x"], makeConfig(), undefined, 20);
    expect(result.status).toBe("timeout");
  });

  it("the same slow batch SUCCEEDS under the indexing timeout (the regression: 3s default killed every batch)", async () => {
    slowEndpointMock(50);
    const result = await embedTexts(["x"], makeConfig(), undefined, 2_000);
    expect(result.status).toBe("ok");
    expect(result.vectors).toHaveLength(1);
  });
});

describe("embedTexts — error classification", () => {
  beforeEach(() => _resetEmbeddingCircuitForTests());
  afterEach(() => vi.restoreAllMocks());

  it("classifies network error (ECONNREFUSED) as 'error'", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("ECONNREFUSED"));
    const result = await embedTexts(["x"], makeConfig());
    expect(result.status).toBe("error");
    expect(result.vectors).toBeNull();
  });

  it("classifies AbortError as 'timeout'", async () => {
    // Симулируем то, что выкидывает AbortSignal.timeout при таймауте.
    const abortErr = new Error("aborted");
    abortErr.name = "AbortError";
    vi.spyOn(globalThis, "fetch").mockRejectedValue(abortErr);
    const result = await embedTexts(["x"], makeConfig());
    expect(result.status).toBe("timeout");
    expect(result.vectors).toBeNull();
  });

  it("classifies TimeoutError as 'timeout'", async () => {
    const timeoutErr = new Error("timeout");
    timeoutErr.name = "TimeoutError";
    vi.spyOn(globalThis, "fetch").mockRejectedValue(timeoutErr);
    const result = await embedTexts(["x"], makeConfig());
    expect(result.status).toBe("timeout");
  });

  it("classifies non-2xx response as 'error'", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("server fail", { status: 503 }),
    );
    const result = await embedTexts(["x"], makeConfig());
    expect(result.status).toBe("error");
    expect(result.vectors).toBeNull();
  });

  it("classifies invalid JSON body as 'error' (не падаем наверх)", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("<<not json>>", { status: 200 }),
    );
    const result = await embedTexts(["x"], makeConfig());
    expect(result.status).toBe("error");
    expect(result.vectors).toBeNull();
  });
});

describe("embedTexts — circuit breaker", () => {
  beforeEach(() => _resetEmbeddingCircuitForTests());
  afterEach(() => vi.restoreAllMocks());

  it("opens after 2 consecutive failures and short-circuits next call without fetch", async () => {
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("nope"));

    const r1 = await embedTexts(["a"], makeConfig());
    const r2 = await embedTexts(["b"], makeConfig());
    expect(r1.status).toBe("error");
    expect(r2.status).toBe("error");
    expect(spy).toHaveBeenCalledTimes(2);

    // 3-й вызов уходит в short-circuit — fetch вызван не должен быть.
    const r3 = await embedTexts(["c"], makeConfig());
    expect(r3.status).toBe("circuit-open");
    expect(r3.vectors).toBeNull();
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("resets failure counter on first success (breaker stays closed)", async () => {
    const spy = vi.spyOn(globalThis, "fetch");
    // 1-я попытка падает...
    spy.mockRejectedValueOnce(new Error("flaky"));
    const r1 = await embedTexts(["a"], makeConfig());
    expect(r1.status).toBe("error");

    // ...но 2-я успешна — счётчик failures сбрасывается.
    spy.mockResolvedValueOnce(mockEmbeddingResponse([[1, 0, 0]]));
    const r2 = await embedTexts(["b"], makeConfig());
    expect(r2.status).toBe("ok");

    // Ещё один fail — counter снова 1, breaker всё ещё закрыт.
    spy.mockRejectedValueOnce(new Error("flaky2"));
    const r3 = await embedTexts(["c"], makeConfig());
    expect(r3.status).toBe("error");
    expect(r3.status).not.toBe("circuit-open");
  });

  it("breaker triggered by mix of timeout + error", async () => {
    const spy = vi.spyOn(globalThis, "fetch");
    const timeout = new Error("t");
    timeout.name = "TimeoutError";
    spy.mockRejectedValueOnce(timeout);
    const r1 = await embedTexts(["a"], makeConfig());
    expect(r1.status).toBe("timeout");

    spy.mockRejectedValueOnce(new Error("net"));
    const r2 = await embedTexts(["b"], makeConfig());
    expect(r2.status).toBe("error");

    // 2 разнотипных fail подряд — порог достигнут.
    const r3 = await embedTexts(["c"], makeConfig());
    expect(r3.status).toBe("circuit-open");
  });
});

describe("embedTexts — default timeout", () => {
  beforeEach(() => _resetEmbeddingCircuitForTests());
  afterEach(() => vi.restoreAllMocks());

  it("passes an AbortSignal to fetch when none is supplied (default timeout active)", async () => {
    let capturedSignal: AbortSignal | undefined;
    vi.spyOn(
    globalThis as unknown as { fetch: (...args: unknown[]) => Promise<Response> },
    "fetch",
  ).mockImplementation(async (_url, init) => {
      capturedSignal = (init as RequestInit | undefined)?.signal as
        | AbortSignal
        | undefined;
      return mockEmbeddingResponse([[1, 0, 0]]);
    });

    await embedTexts(["x"], makeConfig());
    expect(capturedSignal).toBeDefined();
    // AbortSignal.timeout всегда даёт reason при abort'е — здесь главное что
    // он передан в fetch, не unbounded null.
  });

  it("uses caller-supplied AbortSignal as-is when provided", async () => {
    const controller = new AbortController();
    let capturedSignal: AbortSignal | undefined;
    vi.spyOn(
    globalThis as unknown as { fetch: (...args: unknown[]) => Promise<Response> },
    "fetch",
  ).mockImplementation(async (_url, init) => {
      capturedSignal = (init as RequestInit | undefined)?.signal as
        | AbortSignal
        | undefined;
      return mockEmbeddingResponse([[1, 0, 0]]);
    });

    await embedTexts(["x"], makeConfig(), controller.signal);
    expect(capturedSignal).toBe(controller.signal);
  });
});
