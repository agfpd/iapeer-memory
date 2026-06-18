/**
 * Provider adapter matrix (ADR-013): wire-format mock tests for every
 * embedding/reranker provider — request body shape AND response parsing —
 * plus uniform graceful degradation (5xx → error → circuit-open) and
 * config-level provider validation (unknown → throw, none → null block).
 *
 * Formats fact-checked against official provider docs on 2026-06-09 —
 * sources in docs/08-infra-and-search.md §Рецепты.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { vi } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  embedTexts,
  _resetEmbeddingCircuitForTests,
  type EmbeddingConfig,
} from "../src/embedding.js";
import {
  rerank,
  _resetRerankerCircuitForTests,
  type RerankerConfig,
} from "../src/reranker.js";
import { configFromEnv } from "../src/config.js";

// ── helpers ─────────────────────────────────────────────────────────────────

type Captured = { url: string; body: unknown; auth: string | null };

function mockFetchJson(
  response: unknown,
  captured: Captured[] = [],
  status = 200,
): void {
  vi.spyOn(
    globalThis as unknown as {
      fetch: (url: string | URL | Request, init?: RequestInit) => Promise<Response>;
    },
    "fetch",
  ).mockImplementation((async (url: string | URL | Request, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    captured.push({
      url: String(url),
      body: JSON.parse(String(init?.body ?? "null")),
      auth: headers["Authorization"] ?? null,
    });
    return new Response(JSON.stringify(response), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }));
}

function embCfg(overrides: Partial<EmbeddingConfig> = {}): EmbeddingConfig {
  return {
    endpoint: "http://127.0.0.1:9999/v1/embeddings",
    model: "test-model",
    dimensions: 3,
    batchSize: 16,
    apiKey: null,
    ...overrides,
  };
}

function rrkCfg(overrides: Partial<RerankerConfig> = {}): RerankerConfig {
  return {
    endpoint: "http://127.0.0.1:9999/rerank",
    model: "test-reranker",
    topK: 5,
    apiKey: null,
    ...overrides,
  };
}

beforeEach(() => {
  _resetEmbeddingCircuitForTests();
  _resetRerankerCircuitForTests();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ── embedding providers — wire formats ──────────────────────────────────────

describe("embedding provider formats", () => {
  it("openai (default): request {input, model}; response data[].embedding", async () => {
    const captured: Captured[] = [];
    mockFetchJson({ data: [{ embedding: [1, 0, 0] }, { embedding: [0, 1, 0] }] }, captured);
    const out = await embedTexts(["a", "b"], embCfg()); // provider omitted → openai
    expect(out.status).toBe("ok");
    expect(out.vectors).toHaveLength(2);
    expect(Array.from(out.vectors![0]!)).toEqual([1, 0, 0]);
    expect(captured[0]!.body).toEqual({ input: ["a", "b"], model: "test-model" });
  });

  it("tei: request {inputs} without model; response bare [[...]]", async () => {
    const captured: Captured[] = [];
    mockFetchJson([[1, 0, 0], [0, 1, 0]], captured);
    const out = await embedTexts(["a", "b"], embCfg({ provider: "tei" }));
    expect(out.status).toBe("ok");
    expect(out.vectors).toHaveLength(2);
    expect(Array.from(out.vectors![1]!)).toEqual([0, 1, 0]);
    expect(captured[0]!.body).toEqual({ inputs: ["a", "b"] });
  });

  it("apiKey becomes a Bearer header for any provider", async () => {
    const captured: Captured[] = [];
    mockFetchJson([[1]], captured);
    await embedTexts(["a"], embCfg({ provider: "tei", apiKey: "k-123" }));
    expect(captured[0]!.auth).toBe("Bearer k-123");
  });

  it("malformed payload → error (graceful, no throw)", async () => {
    mockFetchJson({ unexpected: true });
    const out = await embedTexts(["a"], embCfg({ provider: "tei" }));
    expect(out.status).toBe("error");
    expect(out.vectors).toBeNull();
  });
});

// ── reranker providers — wire formats ───────────────────────────────────────

describe("reranker provider formats", () => {
  it("tei (default): request {query, texts}; response flat [{index, score}]", async () => {
    const captured: Captured[] = [];
    mockFetchJson([{ index: 1, score: 0.2 }, { index: 0, score: 0.9 }], captured);
    const out = await rerank("q", ["a", "b"], rrkCfg()); // provider omitted → tei
    expect(out.status).toBe("ok");
    expect(out.items).toEqual([
      { index: 0, score: 0.9 },
      { index: 1, score: 0.2 },
    ]); // sorted desc
    expect(captured[0]!.body).toEqual({ query: "q", texts: ["a", "b"] });
  });

  it("jina (llama.cpp /v1/rerank): request {model, query, documents, top_n}; response {results[].relevance_score}", async () => {
    const captured: Captured[] = [];
    mockFetchJson(
      { results: [{ index: 1, relevance_score: 0.8 }, { index: 0, relevance_score: 0.3 }] },
      captured,
    );
    const out = await rerank("q", ["a", "b"], rrkCfg({ provider: "jina" }));
    expect(out.status).toBe("ok");
    expect(out.items).toEqual([
      { index: 1, score: 0.8 },
      { index: 0, score: 0.3 },
    ]);
    expect(captured[0]!.body).toEqual({
      model: "test-reranker",
      query: "q",
      documents: ["a", "b"],
      top_n: 5,
    });
  });

  it("cohere v2: same wire shape as jina; response {results[].relevance_score}", async () => {
    const captured: Captured[] = [];
    mockFetchJson({ results: [{ index: 0, relevance_score: 0.99 }] }, captured);
    const out = await rerank("q", ["a"], rrkCfg({ provider: "cohere", apiKey: "co-key" }));
    expect(out.status).toBe("ok");
    expect(out.items).toEqual([{ index: 0, score: 0.99 }]);
    expect(captured[0]!.body).toEqual({
      model: "test-reranker",
      query: "q",
      documents: ["a"],
      top_n: 5,
    });
    expect(captured[0]!.auth).toBe("Bearer co-key");
  });

  it("nvidia (/v1/ranking): request {model, query:{text}, passages:[{text}], truncate}; response {rankings[].logit}", async () => {
    const captured: Captured[] = [];
    mockFetchJson(
      { rankings: [{ index: 2, logit: 3.5 }, { index: 0, logit: -1.2 }] },
      captured,
    );
    const out = await rerank("q", ["a", "b", "c"], rrkCfg({ provider: "nvidia" }));
    expect(out.status).toBe("ok");
    expect(out.items).toEqual([
      { index: 2, score: 3.5 },
      { index: 0, score: -1.2 },
    ]);
    expect(captured[0]!.body).toEqual({
      model: "test-reranker",
      query: { text: "q" },
      passages: [{ text: "a" }, { text: "b" }, { text: "c" }],
      truncate: "END",
    });
  });

  it("malformed payload → error for non-tei providers too", async () => {
    mockFetchJson({ nothing: [] });
    const out = await rerank("q", ["a"], rrkCfg({ provider: "nvidia" }));
    expect(out.status).toBe("error");
    expect(out.items).toBeNull();
  });
});

// ── uniform graceful degradation across providers ───────────────────────────

describe("uniform degradation: 5xx → error, then circuit-open", () => {
  const embProviders: Array<EmbeddingConfig["provider"]> = ["openai", "tei"];
  for (const provider of embProviders) {
    it(`embedding/${provider}: two 5xx → third call skipped (circuit-open)`, async () => {
      mockFetchJson({ oops: true }, [], 500);
      expect((await embedTexts(["a"], embCfg({ provider }))).status).toBe("error");
      expect((await embedTexts(["a"], embCfg({ provider }))).status).toBe("error");
      const third = await embedTexts(["a"], embCfg({ provider }));
      expect(third.status).toBe("circuit-open");
      expect(third.vectors).toBeNull();
    });
  }

  const rrkProviders: Array<RerankerConfig["provider"]> = ["tei", "jina", "cohere", "nvidia"];
  for (const provider of rrkProviders) {
    it(`reranker/${provider}: two 5xx → third call skipped (circuit-open)`, async () => {
      mockFetchJson({ oops: true }, [], 500);
      expect((await rerank("q", ["a"], rrkCfg({ provider }))).status).toBe("error");
      expect((await rerank("q", ["a"], rrkCfg({ provider }))).status).toBe("error");
      const third = await rerank("q", ["a"], rrkCfg({ provider }));
      expect(third.status).toBe("circuit-open");
      expect(third.items).toBeNull();
    });
  }
});

// ── config-level provider validation ────────────────────────────────────────

describe("configFromEnv providers (ADR-013)", () => {
  const ENV_KEYS = [
    "IAPEER_MEMORY_VAULT_PATH",
    "IAPEER_MEMORY_LOCALE",
    "IAPEER_MEMORY_EMBEDDING_ENDPOINT",
    "IAPEER_MEMORY_EMBEDDING_PROVIDER",
    "IAPEER_MEMORY_RERANKER_ENDPOINT",
    "IAPEER_MEMORY_RERANKER_PROVIDER",
  ];
  let saved: Record<string, string | undefined>;
  let vaultDir: string;

  beforeEach(() => {
    saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
    for (const k of ENV_KEYS) delete process.env[k];
    vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), "iapeer-memory-prov-"));
    process.env.IAPEER_MEMORY_VAULT_PATH = vaultDir;
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    fs.rmSync(vaultDir, { recursive: true, force: true });
  });

  it("unknown embedding provider → throw (like unknown locale)", () => {
    process.env.IAPEER_MEMORY_EMBEDDING_PROVIDER = "voodoo";
    expect(() => configFromEnv()).toThrow(/IAPEER_MEMORY_EMBEDDING_PROVIDER/);
  });

  it("unknown reranker provider → throw", () => {
    process.env.IAPEER_MEMORY_RERANKER_PROVIDER = "voodoo";
    expect(() => configFromEnv()).toThrow(/IAPEER_MEMORY_RERANKER_PROVIDER/);
  });

  it("defaults preserve inherited behaviour: embedding=openai, reranker=tei", () => {
    process.env.IAPEER_MEMORY_EMBEDDING_ENDPOINT = "http://h:1/v1/embeddings";
    process.env.IAPEER_MEMORY_RERANKER_ENDPOINT = "http://h:2/rerank";
    const cfg = configFromEnv();
    expect(cfg.embedding!.provider).toBe("openai");
    expect(cfg.reranker!.provider).toBe("tei");
  });

  it("provider=none disables the reranker block even with an endpoint set", () => {
    process.env.IAPEER_MEMORY_RERANKER_ENDPOINT = "http://h:2/rerank";
    process.env.IAPEER_MEMORY_RERANKER_PROVIDER = "none";
    expect(configFromEnv().reranker).toBeNull();
  });

  it("explicit providers are honoured", () => {
    process.env.IAPEER_MEMORY_EMBEDDING_ENDPOINT = "http://localhost:11434/v1/embeddings";
    process.env.IAPEER_MEMORY_EMBEDDING_PROVIDER = "tei";
    process.env.IAPEER_MEMORY_RERANKER_ENDPOINT = "http://localhost:8012/v1/rerank";
    process.env.IAPEER_MEMORY_RERANKER_PROVIDER = "jina";
    const cfg = configFromEnv();
    expect(cfg.embedding!.provider).toBe("tei");
    expect(cfg.reranker!.provider).toBe("jina");
  });

  it("no endpoints → both blocks null regardless of providers (off-by-default)", () => {
    process.env.IAPEER_MEMORY_EMBEDDING_PROVIDER = "openai";
    process.env.IAPEER_MEMORY_RERANKER_PROVIDER = "cohere";
    const cfg = configFromEnv();
    expect(cfg.embedding).toBeNull();
    expect(cfg.reranker).toBeNull();
  });
});
