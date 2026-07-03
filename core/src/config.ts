/**
 * iapeer-memory core runtime config.
 *
 * Re-built from the reference implementation's `config.ts` for the iapeer-memory
 * namespace: `IAPEER_MEMORY_*` env vars, taxonomy-driven defaults (ADR-002 —
 * the locale preset supplies folder names instead of hard-coded constants)
 * and the `~/.iapeer/{cache,…}/iapeer-memory/` path namespace.
 *
 * Embedding/reranker stay pluggable and off-by-default: empty endpoint →
 * BM25-only, a valid working state. Any endpoint speaking the
 * OpenAI-compatible `/v1/embeddings` + TEI `/rerank` protocols works; no
 * provider is hard-coded.
 *
 * `callerAgent`: at the MCP layer the caller identity comes from the
 * `X-IAPeer-Identity` header of the http connection (ADR-012) and takes
 * precedence; the env var is the fallback for CLI/programmatic consumers
 * outside harness sessions.
 */

import { statSync } from "node:fs";
import os from "node:os";
import { isEmbeddingProvider, DEFAULT_INDEX_TIMEOUT_MS, type EmbeddingProvider } from "./embedding.js";
import { isRerankerProvider, type RerankerProvider } from "./reranker.js";
import {
  defaultExcludeFolders,
  getTaxonomy,
  isLocaleId,
  DEFAULT_CURATOR_SET,
  DEFAULT_RANKING,
  type LocaleId,
  type RankingConfig,
  type TaxonomyPreset,
} from "./taxonomy.js";

export type CoreConfig = {
  vaultPath: string;
  locale: LocaleId;
  taxonomy: TaxonomyPreset;
  ranking: RankingConfig;
  excludeFolders: string[];
  /** ADR-006 curator set — personalities exempt from needs_review stamping. */
  curatorSet: string[];
  callerAgent: string | null;
  search: {
    chunkSize: number;
    chunkOverlap: number;
    maxResults: number;
    rrfK: number;
  };
  index: {
    dbPath: string;
    fullScanOnStartup: boolean;
  };
  /** Каденция курации: канон-правки уходят
   *  ПАЧКОЙ, не событиями — правки должны устаканиться, 10 пишущих агентов
   *  не дёргают конвейер постоянно. */
  batch: {
    /** CURATOR_TICK period, ms (default 6h) — the curation pass over changed
     *  canon (Scriber/Index links + health). */
    curatorMs: number;
  };
  /**
   * MCP-http endpoint of memoryd (ADR-012). The default port 8766 is the
   * neighbour of the iapeer foundation MCP (8765) — one ecosystem block,
   * easy to remember, far from the OS ephemeral ranges. `0` = ephemeral
   * (tests). The session surfaces' `.mcp.json` must reference the SAME port.
   */
  mcp: {
    port: number;
  };
  embedding: {
    endpoint: string;
    model: string;
    dimensions: number;
    batchSize: number;
    apiKey: string | null;
    /** Wire format (ADR-013); configFromEnv always sets it. */
    provider?: EmbeddingProvider;
    /** Per-batch INDEXING timeout, ms (query path keeps the 3s default);
     *  configFromEnv always sets it. */
    indexTimeoutMs?: number;
  } | null;
  reranker: {
    endpoint: string;
    model: string;
    topK: number;
    weight: number;
    apiKey: string | null;
    /** Wire format (ADR-013); configFromEnv always sets it. */
    provider?: RerankerProvider;
  } | null;
};

/**
 * Keep an operator-configured LOCAL embedding/reranker host off the egress
 * proxy. Empirically proven failure mode (inherited from the reference):
 * the process env may carry HTTP(S)_PROXY; NO_PROXY usually excludes LAN via
 * CIDR, but Bun's fetch does NOT implement CIDR matching in NO_PROXY (exact
 * host / suffix only). Result: every embedding/reranker call detours to the
 * proxy, gets a 500, opens the circuit breaker and search silently degrades
 * to BM25. Adding the exact endpoint host to NO_PROXY is idempotent and
 * monotonic — it only bypasses the explicitly configured host.
 */
export function ensureEndpointNotProxied(endpoint: string): void {
  let host: string;
  try {
    host = new URL(endpoint).hostname;
  } catch {
    return; // broken URL — let fetch fail loudly, that's a different misconfig
  }
  if (!host) return;
  for (const varName of ["NO_PROXY", "no_proxy"]) {
    const current = process.env[varName] ?? "";
    const tokens = current.split(",").map((s) => s.trim()).filter(Boolean);
    if (tokens.includes(host)) continue;
    tokens.push(host);
    process.env[varName] = tokens.join(",");
  }
}

/**
 * Loopback NEVER goes through a proxy — fleet-class defect: every peer's
 * shell carries HTTP(S)_PROXY (VPN tinyproxy),
 * Bun's fetch honours it for 127.0.0.1 too → the status probe of the LIVE
 * memoryd port detoured to the proxy and lied «nothing listening» (proven:
 * lsof caught tinyproxy SYN_SENT to 8766; `env -u HTTP_PROXY` → truthful).
 * Call before ANY loopback fetch from CLI paths that run in agent shells.
 */
export function ensureLoopbackNotProxied(): void {
  ensureEndpointNotProxied("http://127.0.0.1/");
  ensureEndpointNotProxied("http://localhost/");
}

function envString(name: string, fallback = ""): string {
  const value = process.env[name];
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

function envNumber(name: string, fallback: number): number {
  const value = process.env[name];
  // "" is treated as unset — harness ${VAR} expansion in .mcp.json renders
  // missing variables as the empty string, not "undefined".
  if (typeof value !== "string" || value.length === 0) return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function envBoolean(name: string, fallback: boolean): boolean {
  const value = process.env[name];
  if (typeof value !== "string" || value.length === 0) return fallback;
  return value === "1" || value.toLowerCase() === "true";
}

function envStringArray(name: string, fallback: string[]): string[] {
  const value = process.env[name];
  if (typeof value !== "string" || value.length === 0) return fallback;
  return value.split(",").map((s) => s.trim()).filter(Boolean);
}

export function configFromEnv(): CoreConfig {
  const vaultPath = envString("IAPEER_MEMORY_VAULT_PATH");
  if (!vaultPath) {
    throw new Error(
      "IAPEER_MEMORY_VAULT_PATH is not set. Run init to provision the vault, " +
      "then point IAPEER_MEMORY_VAULT_PATH at its absolute path in the " +
      "package config and restart.",
    );
  }

  // Validate the vault path resolves to a directory. Without this check the
  // process would start "healthy" on a typo / unmounted drive / offloaded
  // iCloud root — search would return empty results and agents would assume
  // an empty vault. Fail loud at startup beats silent degraded mode.
  try {
    const stat = statSync(vaultPath);
    if (!stat.isDirectory()) {
      throw new Error(
        `IAPEER_MEMORY_VAULT_PATH (${vaultPath}) is not a directory.`,
      );
    }
  } catch (err) {
    const e = err as { code?: string; message?: string };
    if (e.code === "ENOENT") {
      throw new Error(
        `IAPEER_MEMORY_VAULT_PATH (${vaultPath}) does not exist. Check that ` +
        `the vault is provisioned and the path is correct (including a ` +
        `possibly offloaded iCloud root).`,
      );
    }
    throw err;
  }

  const rawLocale = envString("IAPEER_MEMORY_LOCALE", "en");
  if (!isLocaleId(rawLocale)) {
    throw new Error(
      `IAPEER_MEMORY_LOCALE (${rawLocale}) is not a known locale preset ` +
      `(expected "en" or "ru").`,
    );
  }
  const taxonomy = getTaxonomy(rawLocale);

  // DB default follows the SAME ladder as the package's memoryPaths():
  // explicit DB_PATH → CACHE_DIR/index.db → IAPEER_ROOT/cache/… → ~/.iapeer/….
  // A hardcoded ~/.iapeer default here once ignored IAPEER_MEMORY_CACHE_DIR
  // and leaked SQLite writes OUT of a sandbox into the prod cache (e2e §A/C
  // finding) — the override chain must be honoured end-to-end.
  const iapeerRoot = envString("IAPEER_ROOT", `${process.env.HOME || os.homedir()}/.iapeer`);
  const cacheDir = envString(
    "IAPEER_MEMORY_CACHE_DIR",
    `${iapeerRoot}/cache/iapeer-memory`,
  );
  const dbPath = envString("IAPEER_MEMORY_DB_PATH", `${cacheDir}/index.db`);

  const embeddingEndpoint = envString("IAPEER_MEMORY_EMBEDDING_ENDPOINT");
  const rerankerEndpoint = envString("IAPEER_MEMORY_RERANKER_ENDPOINT");

  // Provider enums (ADR-013). Unknown value → throw, exactly like an
  // unknown locale: fail loud at startup beats a silently dead pipeline.
  // Defaults preserve the inherited behaviour: embedding "openai"
  // (the reference wire format), reranker "tei" when an endpoint is set.
  // Reranker "none" is the explicit OFF switch: the block resolves to null
  // even with an endpoint configured (the pipeline default state — no
  // reranker — is simply an empty endpoint, as before).
  const embeddingProviderRaw = envString("IAPEER_MEMORY_EMBEDDING_PROVIDER", "openai");
  if (!isEmbeddingProvider(embeddingProviderRaw)) {
    throw new Error(
      `IAPEER_MEMORY_EMBEDDING_PROVIDER (${embeddingProviderRaw}) is not a known ` +
      `provider (expected "tei" or "openai").`,
    );
  }
  const rerankerProviderRaw = envString("IAPEER_MEMORY_RERANKER_PROVIDER", "tei");
  if (rerankerProviderRaw !== "none" && !isRerankerProvider(rerankerProviderRaw)) {
    throw new Error(
      `IAPEER_MEMORY_RERANKER_PROVIDER (${rerankerProviderRaw}) is not a known ` +
      `provider (expected "tei", "cohere", "nvidia", "jina" or "none").`,
    );
  }

  // Strip egress proxying from local endpoints before the first fetch
  // (Bun fetch does not honour CIDR in NO_PROXY — see ensureEndpointNotProxied).
  if (embeddingEndpoint) ensureEndpointNotProxied(embeddingEndpoint);
  if (rerankerEndpoint) ensureEndpointNotProxied(rerankerEndpoint);

  return {
    vaultPath,
    locale: rawLocale,
    taxonomy,
    ranking: { ...DEFAULT_RANKING },
    callerAgent: envString("IAPEER_MEMORY_AGENT_NAME") || null,
    curatorSet: envStringArray("IAPEER_MEMORY_CURATOR_SET", [...DEFAULT_CURATOR_SET]),
    excludeFolders: envStringArray(
      "IAPEER_MEMORY_EXCLUDE_FOLDERS",
      defaultExcludeFolders(taxonomy),
    ),
    search: {
      chunkSize: envNumber("IAPEER_MEMORY_CHUNK_SIZE", 500),
      chunkOverlap: envNumber("IAPEER_MEMORY_CHUNK_OVERLAP", 80),
      maxResults: envNumber("IAPEER_MEMORY_MAX_RESULTS", 6),
      rrfK: envNumber("IAPEER_MEMORY_RRF_K", 60),
    },
    index: {
      dbPath,
      fullScanOnStartup: envBoolean("IAPEER_MEMORY_FULL_SCAN_ON_STARTUP", true),
    },
    batch: {
      curatorMs: envNumber("IAPEER_MEMORY_CURATOR_TICK_SECS", 6 * 3600) * 1000,
    },
    mcp: {
      port: envNumber("IAPEER_MEMORY_MCP_PORT", 8766),
    },
    embedding: embeddingEndpoint
      ? {
          provider: embeddingProviderRaw,
          endpoint: embeddingEndpoint,
          model: envString("IAPEER_MEMORY_EMBEDDING_MODEL", "Qwen/Qwen3-Embedding-8B"),
          dimensions: envNumber("IAPEER_MEMORY_EMBEDDING_DIMENSIONS", 4096),
          batchSize: envNumber("IAPEER_MEMORY_EMBEDDING_BATCH_SIZE", 32),
          apiKey: envString("IAPEER_MEMORY_EMBEDDING_API_KEY") || null,
          indexTimeoutMs: envNumber(
            "IAPEER_MEMORY_EMBEDDING_TIMEOUT_MS",
            DEFAULT_INDEX_TIMEOUT_MS,
          ),
        }
      : null,
    reranker: rerankerEndpoint && rerankerProviderRaw !== "none"
      ? {
          provider: rerankerProviderRaw,
          endpoint: rerankerEndpoint,
          model: envString("IAPEER_MEMORY_RERANKER_MODEL", "BAAI/bge-reranker-v2-m3"),
          topK: envNumber("IAPEER_MEMORY_RERANKER_TOP_K", 20),
          weight: envNumber("IAPEER_MEMORY_RERANKER_WEIGHT", 0.7),
          apiKey: envString("IAPEER_MEMORY_RERANKER_API_KEY") || null,
        }
      : null,
  };
}
