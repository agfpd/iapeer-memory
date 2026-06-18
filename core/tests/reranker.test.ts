import { describe, it, expect, beforeEach, afterEach, vi } from "bun:test";
import {
  rerank,
  _resetRerankerCircuitForTests,
  type RerankerConfig,
} from "../src/reranker.js";

function makeConfig(overrides: Partial<RerankerConfig> = {}): RerankerConfig {
  return {
    endpoint: "http://fake/rerank",
    model: "fake-r",
    topK: 10,
    apiKey: null,
    ...overrides,
  };
}

function mockRerankResponse(items: Array<{ index: number; score: number }>): Response {
  return new Response(JSON.stringify(items), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

// Reranker имеет свой module-level breaker (отдельный от embedding'а) —
// сбрасываем перед каждым тестом.

describe("rerank — happy path", () => {
  beforeEach(() => _resetRerankerCircuitForTests());
  afterEach(() => vi.restoreAllMocks());

  it("returns sorted items with status 'ok'", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      mockRerankResponse([
        { index: 0, score: 0.1 },
        { index: 1, score: 0.9 },
      ]),
    );
    const result = await rerank("q", ["a", "b"], makeConfig());
    expect(result.status).toBe("ok");
    expect(result.items).not.toBeNull();
    // По убыванию score: index=1 (0.9) первый.
    expect(result.items![0]!.index).toBe(1);
    expect(result.items![1]!.index).toBe(0);
  });

  it("returns empty items array (no fetch) when texts is empty", async () => {
    const spy = vi.spyOn(globalThis, "fetch");
    const result = await rerank("q", [], makeConfig());
    expect(result.status).toBe("ok");
    expect(result.items).toEqual([]);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("rerank — error classification", () => {
  beforeEach(() => _resetRerankerCircuitForTests());
  afterEach(() => vi.restoreAllMocks());

  it("classifies network error as 'error'", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("ECONNREFUSED"));
    const result = await rerank("q", ["a"], makeConfig());
    expect(result.status).toBe("error");
    expect(result.items).toBeNull();
  });

  it("classifies AbortError as 'timeout'", async () => {
    const abortErr = new Error("aborted");
    abortErr.name = "AbortError";
    vi.spyOn(globalThis, "fetch").mockRejectedValue(abortErr);
    const result = await rerank("q", ["a"], makeConfig());
    expect(result.status).toBe("timeout");
  });

  it("classifies non-2xx response as 'error'", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("oops", { status: 502 }),
    );
    const result = await rerank("q", ["a"], makeConfig());
    expect(result.status).toBe("error");
  });

  it("classifies invalid JSON as 'error'", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("<<not json>>", { status: 200 }),
    );
    const result = await rerank("q", ["a"], makeConfig());
    expect(result.status).toBe("error");
  });
});

describe("rerank — circuit breaker", () => {
  beforeEach(() => _resetRerankerCircuitForTests());
  afterEach(() => vi.restoreAllMocks());

  it("opens after 2 consecutive failures and short-circuits next call", async () => {
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("nope"));

    await rerank("q", ["a"], makeConfig());
    await rerank("q", ["a"], makeConfig());
    expect(spy).toHaveBeenCalledTimes(2);

    const r3 = await rerank("q", ["a"], makeConfig());
    expect(r3.status).toBe("circuit-open");
    expect(r3.items).toBeNull();
    expect(spy).toHaveBeenCalledTimes(2); // не дёргали
  });

  it("resets counter on success", async () => {
    const spy = vi.spyOn(globalThis, "fetch");
    spy.mockRejectedValueOnce(new Error("flaky"));
    await rerank("q", ["a"], makeConfig());

    spy.mockResolvedValueOnce(mockRerankResponse([{ index: 0, score: 0.5 }]));
    const ok = await rerank("q", ["a"], makeConfig());
    expect(ok.status).toBe("ok");

    spy.mockRejectedValueOnce(new Error("flaky2"));
    const fail = await rerank("q", ["a"], makeConfig());
    expect(fail.status).toBe("error");
    expect(fail.status).not.toBe("circuit-open"); // breaker не открылся
  });
});

describe("rerank — default timeout", () => {
  beforeEach(() => _resetRerankerCircuitForTests());
  afterEach(() => vi.restoreAllMocks());

  it("passes AbortSignal to fetch when none supplied", async () => {
    let captured: AbortSignal | undefined;
    vi.spyOn(
    globalThis as unknown as { fetch: (...args: unknown[]) => Promise<Response> },
    "fetch",
  ).mockImplementation(async (_u, init) => {
      captured = (init as RequestInit | undefined)?.signal as
        | AbortSignal
        | undefined;
      return mockRerankResponse([{ index: 0, score: 0.5 }]);
    });
    await rerank("q", ["a"], makeConfig());
    expect(captured).toBeDefined();
  });

  it("uses caller-supplied signal as-is", async () => {
    const controller = new AbortController();
    let captured: AbortSignal | undefined;
    vi.spyOn(
    globalThis as unknown as { fetch: (...args: unknown[]) => Promise<Response> },
    "fetch",
  ).mockImplementation(async (_u, init) => {
      captured = (init as RequestInit | undefined)?.signal as
        | AbortSignal
        | undefined;
      return mockRerankResponse([{ index: 0, score: 0.5 }]);
    });
    await rerank("q", ["a"], makeConfig(), controller.signal);
    expect(captured).toBe(controller.signal);
  });
});
