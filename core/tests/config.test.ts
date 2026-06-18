import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { configFromEnv } from "../src/config.js";

// configFromEnv reads process.env. Mutating it directly is the cheapest way to
// test all branches — Vitest gives each test an isolated worker so cross-test
// leakage is impossible.
//
// configFromEnv() now fail-louds when IAPEER_MEMORY_VAULT_PATH doesn't resolve to
// a directory (statSync guard). Tests therefore need a real on-disk vault
// fixture, created per-test via fs.mkdtempSync, instead of a hardcoded
// "/tmp/vault" that may not exist. A dedicated test covers the non-existent
// path branch so the fail-loud guard stays regression-protected.

const ENV_KEYS = [
  "IAPEER_MEMORY_VAULT_PATH",
  "IAPEER_MEMORY_LOCALE",
  "IAPEER_MEMORY_AGENT_NAME",
  "IAPEER_MEMORY_DB_PATH",
  "IAPEER_MEMORY_CACHE_DIR",
  "IAPEER_ROOT",
  "IAPEER_MEMORY_EXCLUDE_FOLDERS",
  "IAPEER_MEMORY_FULL_SCAN_ON_STARTUP",
  "IAPEER_MEMORY_EMBEDDING_ENDPOINT",
  "IAPEER_MEMORY_EMBEDDING_MODEL",
  "IAPEER_MEMORY_EMBEDDING_DIMENSIONS",
  "IAPEER_MEMORY_EMBEDDING_BATCH_SIZE",
  "IAPEER_MEMORY_EMBEDDING_API_KEY",
  "IAPEER_MEMORY_RERANKER_ENDPOINT",
  "IAPEER_MEMORY_RERANKER_MODEL",
  "IAPEER_MEMORY_RERANKER_TOP_K",
  "IAPEER_MEMORY_RERANKER_WEIGHT",
  "IAPEER_MEMORY_RERANKER_API_KEY",
  "IAPEER_MEMORY_CHUNK_SIZE",
  "IAPEER_MEMORY_CHUNK_OVERLAP",
  "IAPEER_MEMORY_MAX_RESULTS",
  "IAPEER_MEMORY_RRF_K",
  "IAPEER_MEMORY_MCP_PORT",
];

let saved: Record<string, string | undefined>;
let vaultDir: string;

beforeEach(() => {
  saved = {};
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  // Real directory so the fail-loud statSync guard in configFromEnv passes.
  vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), "iapeer-memory-config-test-"));
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  fs.rmSync(vaultDir, { recursive: true, force: true });
});

describe("configFromEnv", () => {
  it("throws when IAPEER_MEMORY_VAULT_PATH is missing", () => {
    expect(() => configFromEnv()).toThrow(/IAPEER_MEMORY_VAULT_PATH/);
  });

  it("throws when IAPEER_MEMORY_VAULT_PATH points to a non-existent path", () => {
    // fail-loud guard: a typo'd / unmounted vault root must crash at startup,
    // not silently degrade to empty search results.
    process.env.IAPEER_MEMORY_VAULT_PATH = path.join(vaultDir, "does-not-exist");
    expect(() => configFromEnv()).toThrow(/does not exist/);
  });

  it("throws when IAPEER_MEMORY_VAULT_PATH points to a file, not a directory", () => {
    const filePath = path.join(vaultDir, "not-a-dir");
    fs.writeFileSync(filePath, "x");
    process.env.IAPEER_MEMORY_VAULT_PATH = filePath;
    expect(() => configFromEnv()).toThrow(/is not a directory/);
  });

  it("loads minimal config with just IAPEER_MEMORY_VAULT_PATH set", () => {
    process.env.IAPEER_MEMORY_VAULT_PATH = vaultDir;
    const cfg = configFromEnv();
    expect(cfg.vaultPath).toBe(vaultDir);
    expect(cfg.embedding).toBeNull();
    expect(cfg.reranker).toBeNull();
    expect(cfg.callerAgent).toBeNull();
    // Default chunk size / overlap / max results.
    expect(cfg.search.chunkSize).toBe(500);
    expect(cfg.search.chunkOverlap).toBe(80);
    expect(cfg.search.maxResults).toBe(6);
    expect(cfg.search.rrfK).toBe(60);
  });

  it("treats empty string env vars as unset", () => {
    // .mcp.json's `${VAR:-}` expands missing vars to "". envString/envNumber/
    // envBoolean must treat "" as unset and apply the fallback.
    process.env.IAPEER_MEMORY_VAULT_PATH = vaultDir;
    process.env.IAPEER_MEMORY_CHUNK_SIZE = "";
    process.env.IAPEER_MEMORY_AGENT_NAME = "";
    const cfg = configFromEnv();
    expect(cfg.search.chunkSize).toBe(500);
    expect(cfg.callerAgent).toBeNull();
  });

  it("parses IAPEER_MEMORY_AGENT_NAME as callerAgent", () => {
    process.env.IAPEER_MEMORY_VAULT_PATH = vaultDir;
    process.env.IAPEER_MEMORY_AGENT_NAME = "boris";
    expect(configFromEnv().callerAgent).toBe("boris");
  });

  it("parses excludeFolders as comma-separated list", () => {
    process.env.IAPEER_MEMORY_VAULT_PATH = vaultDir;
    process.env.IAPEER_MEMORY_EXCLUDE_FOLDERS = "Drafts, Archive ,Trash";
    const cfg = configFromEnv();
    expect(cfg.excludeFolders).toEqual(["Drafts", "Archive", "Trash"]);
  });

  it("falls back to EN default excludeFolders when locale not set", () => {
    process.env.IAPEER_MEMORY_VAULT_PATH = vaultDir;
    const cfg = configFromEnv();
    expect(cfg.locale).toBe("en");
    expect(cfg.excludeFolders).toEqual(["99_System"]);
  });

  it("locale=ru switches taxonomy preset and default excludeFolders", () => {
    process.env.IAPEER_MEMORY_VAULT_PATH = vaultDir;
    process.env.IAPEER_MEMORY_LOCALE = "ru";
    const cfg = configFromEnv();
    expect(cfg.locale).toBe("ru");
    expect(cfg.taxonomy.folders.agentMemory).toBe("06_Оперативка_агентов");
    expect(cfg.excludeFolders).toEqual(["99_Система"]);
  });

  it("throws on unknown locale", () => {
    process.env.IAPEER_MEMORY_VAULT_PATH = vaultDir;
    process.env.IAPEER_MEMORY_LOCALE = "de";
    expect(() => configFromEnv()).toThrow(/IAPEER_MEMORY_LOCALE/);
  });

  it("ranking defaults are attached to the config", () => {
    process.env.IAPEER_MEMORY_VAULT_PATH = vaultDir;
    const cfg = configFromEnv();
    expect(cfg.ranking.foreignAgentMemoryPenalty).toBe(0.7);
    expect(cfg.ranking.activeBoost).toBe(1.2);
  });

  it("enables embedding block when endpoint is set", () => {
    process.env.IAPEER_MEMORY_VAULT_PATH = vaultDir;
    process.env.IAPEER_MEMORY_EMBEDDING_ENDPOINT = "http://tei:8080/v1/embeddings";
    process.env.IAPEER_MEMORY_EMBEDDING_DIMENSIONS = "1024";
    process.env.IAPEER_MEMORY_EMBEDDING_BATCH_SIZE = "16";
    process.env.IAPEER_MEMORY_EMBEDDING_API_KEY = "k1";
    const cfg = configFromEnv();
    expect(cfg.embedding).not.toBeNull();
    expect(cfg.embedding!.endpoint).toBe("http://tei:8080/v1/embeddings");
    expect(cfg.embedding!.dimensions).toBe(1024);
    expect(cfg.embedding!.batchSize).toBe(16);
    expect(cfg.embedding!.apiKey).toBe("k1");
  });

  it("enables reranker block when endpoint is set", () => {
    process.env.IAPEER_MEMORY_VAULT_PATH = vaultDir;
    process.env.IAPEER_MEMORY_RERANKER_ENDPOINT = "http://tei:8081/rerank";
    process.env.IAPEER_MEMORY_RERANKER_TOP_K = "10";
    process.env.IAPEER_MEMORY_RERANKER_WEIGHT = "0.5";
    const cfg = configFromEnv();
    expect(cfg.reranker).not.toBeNull();
    expect(cfg.reranker!.endpoint).toBe("http://tei:8081/rerank");
    expect(cfg.reranker!.topK).toBe(10);
    expect(cfg.reranker!.weight).toBe(0.5);
  });

  it("IAPEER_MEMORY_FULL_SCAN_ON_STARTUP defaults to true", () => {
    process.env.IAPEER_MEMORY_VAULT_PATH = vaultDir;
    expect(configFromEnv().index.fullScanOnStartup).toBe(true);
  });

  it("IAPEER_MEMORY_FULL_SCAN_ON_STARTUP=0 disables", () => {
    process.env.IAPEER_MEMORY_VAULT_PATH = vaultDir;
    process.env.IAPEER_MEMORY_FULL_SCAN_ON_STARTUP = "0";
    expect(configFromEnv().index.fullScanOnStartup).toBe(false);
  });

  it("non-numeric env value falls back to default", () => {
    process.env.IAPEER_MEMORY_VAULT_PATH = vaultDir;
    process.env.IAPEER_MEMORY_CHUNK_SIZE = "not-a-number";
    expect(configFromEnv().search.chunkSize).toBe(500);
  });

  it("db default follows the override ladder: CACHE_DIR → IAPEER_ROOT → ~/.iapeer", () => {
    // e2e §A/C finding: a hardcoded ~/.iapeer db default leaked
    // SQLite writes out of a sandbox — every override level must be honoured.
    process.env.IAPEER_MEMORY_VAULT_PATH = vaultDir;
    expect(configFromEnv().index.dbPath).toBe(
      `${process.env.HOME}/.iapeer/cache/iapeer-memory/index.db`,
    );
    process.env.IAPEER_ROOT = "/sandbox/iapeer";
    expect(configFromEnv().index.dbPath).toBe(
      "/sandbox/iapeer/cache/iapeer-memory/index.db",
    );
    process.env.IAPEER_MEMORY_CACHE_DIR = "/sandbox/cache";
    expect(configFromEnv().index.dbPath).toBe("/sandbox/cache/index.db");
    process.env.IAPEER_MEMORY_DB_PATH = "/explicit/index.db";
    expect(configFromEnv().index.dbPath).toBe("/explicit/index.db");
  });

  it("ensureLoopbackNotProxied: loopback hosts land in NO_PROXY (fleet-class fix)", async () => {
    const saved = {
      NO_PROXY: process.env.NO_PROXY,
      no_proxy: process.env.no_proxy,
    };
    try {
      process.env.NO_PROXY = "internal.example";
      delete process.env.no_proxy;
      const { ensureLoopbackNotProxied } = await import("../src/config.js");
      ensureLoopbackNotProxied();
      expect(process.env.NO_PROXY).toContain("127.0.0.1");
      expect(process.env.NO_PROXY).toContain("localhost");
      expect(process.env.NO_PROXY).toContain("internal.example"); // existing kept
      const once = process.env.NO_PROXY;
      ensureLoopbackNotProxied(); // idempotent
      expect(process.env.NO_PROXY).toBe(once!);
    } finally {
      if (saved.NO_PROXY === undefined) delete process.env.NO_PROXY;
      else process.env.NO_PROXY = saved.NO_PROXY;
      if (saved.no_proxy === undefined) delete process.env.no_proxy;
      else process.env.no_proxy = saved.no_proxy;
    }
  });

  it("MCP port defaults to 8766 (iapeer-MCP neighbour, ADR-012)", () => {
    process.env.IAPEER_MEMORY_VAULT_PATH = vaultDir;
    expect(configFromEnv().mcp.port).toBe(8766);
  });

  it("IAPEER_MEMORY_MCP_PORT overrides the MCP port", () => {
    process.env.IAPEER_MEMORY_VAULT_PATH = vaultDir;
    process.env.IAPEER_MEMORY_MCP_PORT = "9100";
    expect(configFromEnv().mcp.port).toBe(9100);
  });
});
