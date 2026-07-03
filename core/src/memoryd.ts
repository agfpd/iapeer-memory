/**
 * memoryd — the single iapeer-memory daemon (ADR-004 + ADR-012).
 *
 * One process owns everything live:
 * - the WRITER role: sole SQLite owner (openDatabase + indexAll), fs.watch
 *   over the vault with debounce, incremental re-index by content hash;
 * - the detect subsystems (stage 8 cores): human-edit attribution, the
 *   silent-edit (unstamped) belt, the tags-dictionary mirror, and the
 *   permanent smart-hash diff COALESCED into one curation pass;
 * - the event stream: one signal line per curation pass on stdout
 *   (`CURATOR_TICK: [<paths…>]`) — a notifier watcher forwards it to the
 *   curation receiver as an IAP signal;
 * - the heartbeat state file (consumer: every peer's SessionStart
 *   health-check, ADR-009/010);
 * - the MCP-http endpoint (ADR-012): localhost, port from config, three
 *   read-only tools (memory_search / memory_related / memory_map — ADR-008,
 *   vault_read is NOT on the surface), caller identity from the
 *   `X-IAPeer-Identity` header per request.
 *
 * The supervision (restart, hang detection, alerts) belongs to the
 * notifier watcher registration owned by the package (ADR-010) — memoryd
 * itself stays a plain long-running process with clean shutdown.
 */

import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import corePkg from "../package.json";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import type { CoreConfig } from "./config.js";
import {
  openDatabase,
  checkEmbeddingModelChanged,
  checkParserChanged,
  backfillVecChunks,
  countChunksWithoutEmbeddings,
  gcOrphanVecChunks,
  type CoreDb,
} from "./db.js";
import { indexAll, embedMissingChunks } from "./indexer.js";
import { PARSER_VERSION } from "./parser.js";
import { runSearch, runGraph, runMap } from "./mcp-tools.js";
import { runDedup } from "./search.js";
import { decideUpdate, getZone, sha256 } from "./human-edit-detect.js";
import { smartHash } from "./smart-hash.js";
import { decideMirror, tagsDictionarySourceRel } from "./tags-mirror.js";
import { renderTagsProjection, DEFAULT_TAGS_BOUNDARY_MAXLEN } from "./tags-gate.js";
import { isArchivableZone, shouldArchive, archiveTargetRel } from "./archive.js";
import {
  snapshotVault,
  collectNeedsReview,
  type VaultSnapshot,
} from "./permanent-detect.js";
import { makeLogger, type Logger } from "./log.js";
import {
  atomicWrite,
  buildOutput,
  collectNotes,
  filterAgentNotes,
  fullIndexPathFor,
  type RenderContext,
} from "./index-render.js";
import { renderPeerFragment, type FragmentEnv } from "./context-render.js";
import { guardedWriteFileSync, guardedUnlinkSync, sandboxBlocksProdRead, guardedRenameSync, sandboxEnvArmed, isUnderProdAnchor } from "./fs-guard.js";
import {
  isSilentEdit,
  readStampRecord,
  restampUnstamped,
  setNeedsReviewFalse,
  type SilentZone,
  type StampRecord,
} from "./silent-edit-detect.js";

// ── identity ────────────────────────────────────────────────────────────────

const KNOWN_RUNTIME_PREFIXES = ["claude-", "codex-"];

/**
 * `X-IAPeer-Identity: <runtime>-<personality>` → personality. A bare
 * personality (no known runtime prefix) passes through as-is; personalities
 * may themselves contain dashes (`iapeer-memory`), so ONLY the known
 * runtime prefixes are stripped. Missing/empty header → null (admin access,
 * identity-dependent mechanics like the foreign-memory penalty are off).
 */
export function parsePersonalityFromIdentity(
  header: string | null | undefined,
): string | null {
  const v = (header ?? "").trim();
  if (!v) return null;
  for (const prefix of KNOWN_RUNTIME_PREFIXES) {
    if (v.startsWith(prefix) && v.length > prefix.length) {
      return v.slice(prefix.length);
    }
  }
  return v;
}

// ── MCP server (three tools, ADR-008) ───────────────────────────────────────

function toResult(payload: unknown): CallToolResult {
  const structured =
    payload && typeof payload === "object" && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : undefined;
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    ...(structured ? { structuredContent: structured } : {}),
  };
}

function toError(toolName: string, err: unknown, logger: Logger): CallToolResult {
  const msg = err instanceof Error ? err.message : String(err);
  logger.error(`tool ${toolName} failed: ${msg}`);
  return {
    content: [{ type: "text", text: JSON.stringify({ error: msg }, null, 2) }],
    isError: true,
  };
}

// Zod fragments — ported from the reference server (vault_read schema
// deliberately absent, ADR-008).
const relatedItem = z.object({
  path: z.string(),
  title: z.string(),
  direction: z.string(),
});

const searchResultItem = z.object({
  title: z.string(),
  path: z.string(),
  type: z.string().nullable(),
  status: z.string().nullable(),
  score: z.number(),
  snippet: z.string(),
  related: z.array(relatedItem),
});

const pipelineStatusSchema = z.object({
  bm25: z.string(),
  embedding: z.string(),
  reranker: z.string(),
  graph: z.string(),
  caller_agent: z.string().nullable(),
  for_curation: z.boolean(),
});

const vaultSearchOutput = z.object({
  query: z.string(),
  results: z.array(searchResultItem),
  pipeline: pipelineStatusSchema,
});

const graphNode = z.object({
  path: z.string(),
  title: z.string(),
  type: z.string().nullable(),
  status: z.string().nullable(),
  depth: z.number(),
  direction: z.string(),
});

const graphEdge = z.object({ from: z.string(), to: z.string() });

const vaultGraphOutput = z.object({
  center: z
    .object({ path: z.string(), title: z.string(), type: z.string().nullable() })
    .optional(),
  nodes: z.array(graphNode).optional(),
  edges: z.array(graphEdge).optional(),
  stats: z
    .object({ totalNodes: z.number(), totalEdges: z.number(), depth: z.number() })
    .optional(),
  found: z.boolean().optional(),
  error: z.string().optional(),
});

const mapPart = z.enum([
  "clusters",
  "hubs",
  "bridges",
  "orphans",
  "orphan_wikilinks",
  "active_to_archive_links",
]);

const mapClusterFull = z.object({
  name: z.string(),
  size: z.number(),
  hub: z.object({ title: z.string(), degree: z.number() }).nullable(),
  nodes: z.array(z.string()),
});
const mapClusterSummary = z.object({
  name: z.string(),
  size: z.number(),
  hub: z.object({ title: z.string(), degree: z.number() }).nullable(),
  top_nodes: z.array(z.string()),
});

const mapHub = z.object({
  title: z.string(),
  in: z.number(),
  out: z.number(),
  total: z.number(),
});

const mapBridge = z.object({ title: z.string(), connects: z.array(z.string()) });

const vaultMapOutput = z.object({
  generated: z.string(),
  stats: z.object({
    documents: z.number(),
    edges: z.number(),
    clusters: z.number(),
    hubs: z.number(),
    bridges: z.number(),
    orphans: z.number(),
    orphan_wikilinks: z.number(),
    active_to_archive_links: z.number(),
  }),
  detail: z.enum(["summary", "full"]),
  parts: z.array(mapPart),
  clusters: z.array(z.union([mapClusterFull, mapClusterSummary])).optional(),
  hubs: z.array(mapHub).optional(),
  hubs_truncated: z.number().optional(),
  bridges: z.array(mapBridge).optional(),
  orphans: z.array(z.string()).optional(),
  orphan_wikilinks: z
    .array(z.object({ source: z.string(), target: z.string(), reason: z.string() }))
    .optional(),
  active_to_archive_links: z
    .array(
      z.object({
        source: z.string(),
        target: z.string(),
        contextSnippet: z.string().nullable(),
      }),
    )
    .optional(),
});

export const MEMORYD_SERVER_NAME = "iapeer-memory";

function readCoreVersion(): string {
  // STATIC json import (embedded by the bundler), not a runtime fs read:
  // under `bun build --compile` import.meta.url resolves into /$bunfs/ where
  // ../package.json does not exist (P3a compile fact-check).
  try {
    const v = (corePkg as { version?: unknown }).version;
    if (typeof v === "string" && v.length > 0) return v;
  } catch {
    // fall through
  }
  return "0.0.0";
}

/**
 * Build an MCP server instance with the three-tool surface. `identity` is
 * the caller personality from the http header — it OVERRIDES the config's
 * env-fallback callerAgent for this connection (ADR-012).
 */
export function createMcpServer(opts: {
  db: CoreDb;
  config: CoreConfig;
  identity?: string | null;
  logger?: Logger;
}): McpServer {
  const { db, config } = opts;
  const logger = opts.logger ?? makeLogger("memoryd");
  const effectiveConfig: CoreConfig = {
    ...config,
    callerAgent: opts.identity ?? config.callerAgent,
  };

  const server = new McpServer(
    { name: MEMORYD_SERVER_NAME, version: readCoreVersion() },
    {
      // Server instructions carry the PURPOSE + when-to-use + the behavioural
      // cautions (Anthropic tool-design canon: tool descriptions must NOT
      // instruct behaviour — those hints live here, injected once).
      instructions:
        "iapeer-memory — the team's shared memory: knowledge, decisions, " +
        "context, ideas, lists, project notes. The tools return ranked paths and " +
        "snippets from an index SNAPSHOT, not live bodies — open a note with the " +
        "native Read tool, and re-check it before acting (its status or content " +
        "may have moved on). Stale-status notes are deboosted but still returned: " +
        "history, not current truth.",
    },
  );

  server.registerTool(
    "memory_search",
    {
      title: "Search team memory (by meaning)",
      description:
        "Find relevant memory by MEANING — semantic + keyword search, ranked. " +
        "Returns per item: title, path, type, status, score, snippet, and " +
        "`related` neighbours; `pipeline` carries per-component status (BM25 / " +
        "vector / rerank / graph). Does NOT walk a known note's links — use " +
        "memory_related; for the whole-vault landscape use memory_map.",
      inputSchema: {
        query: z
          .string()
          .min(1, "memory_search: query is required")
          .describe("What to search for — keywords or a natural-language description. Quoted phrases supported."),
        forCuration: z
          .boolean()
          .optional()
          .describe("Internal: bias ranking for a curation pass (Index/Scriber). Omit for a normal author search."),
      },
      outputSchema: vaultSearchOutput.shape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ query, forCuration }) => {
      try {
        return toResult(await runSearch(db, effectiveConfig, { query, forCuration }));
      } catch (err) {
        return toError("memory_search", err, logger);
      }
    },
  );

  server.registerTool(
    "memory_related",
    {
      title: "Related notes (link graph)",
      description:
        "Walk the wikilink graph around a note you ALREADY have — 1–3 hops, both " +
        "directions — surfacing its cross-linked neighbours and backlinks. Returns " +
        "the subgraph (nodes, edges); agent-memory backlinks of canon are " +
        "one-way-filtered; an unknown center path → {found:false}. To find notes by " +
        "meaning use memory_search; for the whole-vault landscape use memory_map.",
      inputSchema: {
        path: z
          .string()
          .min(1, "memory_related: path is required")
          .describe("Vault-relative path of the note to center on (e.g. `01_Knowledge/Note.md`) — take it from a memory_search result's `path`."),
        depth: z
          .number()
          .int()
          .min(1)
          .max(3)
          .optional()
          .describe("Hops outward (1–3). Default 1 — the note's immediate neighbours."),
      },
      outputSchema: vaultGraphOutput.shape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ path: p, depth }) => {
      try {
        return toResult(runGraph(db, effectiveConfig, { path: p, depth }));
      } catch (err) {
        return toError("memory_related", err, logger);
      }
    },
  );

  server.registerTool(
    "memory_map",
    {
      title: "Vault landscape (map)",
      description:
        "The holistic LANDSCAPE of the LIVE canonical graph (agent memory AND " +
        "archive excluded), like the Obsidian graph view: clusters, hubs, bridges, " +
        "orphans (+ optional orphan_wikilinks and active_to_archive_links health " +
        "signals). For the BIG PICTURE — themes, structure, gaps — not a single " +
        "note. For one note's neighbourhood use memory_related; to find notes by " +
        "meaning use memory_search.",
      inputSchema: {
        detail: z
          .enum(["summary", "full"])
          .optional()
          .describe("`summary` (counts + top items) or `full` (every cluster/hub). Default summary."),
        parts: z
          .array(mapPart)
          .optional()
          .describe("Which parts to include: clusters, hubs, bridges, orphans, orphan_wikilinks, active_to_archive_links. Default: all but the opt-in parts (orphan_wikilinks, active_to_archive_links — counts always in stats)."),
      },
      outputSchema: vaultMapOutput.shape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ detail, parts }) => {
      try {
        return toResult(runMap(db, effectiveConfig, { detail, parts }));
      } catch (err) {
        return toError("memory_map", err, logger);
      }
    },
  );

  return server;
}

/**
 * Start the MCP-http endpoint (ADR-012): stateless transport, one
 * server+transport pair per request, identity from the
 * `X-IAPeer-Identity` header. Returns the bound port and a closer.
 */
export async function startMcpHttp(opts: {
  db: CoreDb;
  config: CoreConfig;
  port?: number;
  host?: string;
  logger?: Logger;
}): Promise<{ port: number; close: () => Promise<void> }> {
  const logger = opts.logger ?? makeLogger("memoryd");
  const host = opts.host ?? "127.0.0.1";

  const httpServer = http.createServer((req, res) => {
    void (async () => {
      const url = (req.url ?? "").split("?")[0];
      // Dedup hint (lean §3a) — a memoryd-INTERNAL RPC for the post-write hook,
      // NOT an MCP tool (the MCP surface stays the three read tools). Loopback
      // (host is 127.0.0.1) + read-only. The hook calls it fail-open with a
      // short timeout, so a slow/down memoryd never hangs a write.
      if (url === "/dedup" && req.method === "POST") {
        const chunks: Buffer[] = [];
        req.on("data", (c) => chunks.push(c as Buffer));
        await new Promise<void>((resolve) => req.on("end", () => resolve()));
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString("utf-8")) as {
            content?: string;
            threshold?: number;
            limit?: number;
            linkThreshold?: number;
          };
          const content = (body.content ?? "").trim();
          const result = content
            ? await runDedup(opts.db, opts.config, {
                content,
                threshold: body.threshold,
                limit: body.limit,
                linkThreshold: body.linkThreshold,
              })
            : { enabled: Boolean(opts.config.embedding), matches: [] };
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(result));
        } catch (err) {
          logger.error(`dedup request failed: ${String(err)}`);
          if (!res.headersSent) {
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ enabled: false, matches: [], error: "internal error" }));
          }
        }
        return;
      }
      if (url !== "/mcp") {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "not found; MCP endpoint is /mcp" }));
        return;
      }
      const identity = parsePersonalityFromIdentity(
        (req.headers["x-iapeer-identity"] as string | undefined) ?? null,
      );
      const server = createMcpServer({ db: opts.db, config: opts.config, identity, logger });
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined, // stateless: no session tracking
      });
      res.on("close", () => {
        void transport.close();
        void server.close();
      });
      try {
        await server.connect(transport);
        await transport.handleRequest(req, res);
      } catch (err) {
        logger.error(`mcp http request failed: ${String(err)}`);
        if (!res.headersSent) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "internal error" }));
        }
      }
    })();
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(opts.port ?? 0, host, () => resolve());
  });
  const address = httpServer.address();
  const port = typeof address === "object" && address ? address.port : (opts.port ?? 0);
  logger.info(`MCP http listening on http://${host}:${port}/mcp`);

  return {
    port,
    close: () =>
      new Promise<void>((resolve) => {
        // Kill keep-alive/SSE connections FIRST — otherwise close() waits
        // for them and a daemon shutdown hangs for the keep-alive timeout.
        httpServer.closeAllConnections?.();
        httpServer.closeIdleConnections?.();
        const fallback = setTimeout(resolve, 1500);
        (fallback as { unref?: () => void }).unref?.();
        httpServer.close(() => {
          clearTimeout(fallback);
          resolve();
        });
      }),
  };
}

// ── detect-hash persistence (stage-9 review note 5) ─────────────────────────
//
// Without persistence a daemon restart zeroed the human-edit detector's
// last-seen map: the first event per file skipped the content-hash guard.
// The risk is LOWER here than in the reference (the startup full-scan
// catches up indexing; the echo window suppresses spurious re-stamps), but
// a sync-storm right after a restart could still mis-attribute — so the
// baseline survives restarts, atomically (same tmp+rename canon).

/** Persisted batch baselines: the permanent-folders snapshot (rel → smart
 *  hash) + the silent-edit stamp baseline (rel → {updated, leb}; the
 *  unstamped detector judges stamp movement against it). Survives restarts —
 *  порт паттерна старых мониторов «seen переживает сбой». Migration is
 *  FIRST-SIGHT by construction: an absent silentStamps key (pre-detector
 *  state file) reads as an empty map — one warm-up pass records, never
 *  judges. Legacy `inbox`/`humanInbox` keys in an old state file are simply
 *  ignored on load. */
export type BatchState = {
  permanent: VaultSnapshot | null;
  silentStamps: Map<string, StampRecord> | null;
  /** Wall-clock epoch-ms of the last CADENCE curator tick. Persisted so the
   *  6h countdown SURVIVES restarts: the old in-memory setInterval counted a
   *  full period from process start, and a deploy-dense day (each foundation
   *  deploy recycles the watcher-held daemon) reset it forever — curation
   *  starved while memoryd looked healthy. Absent key (pre-anchor state
   *  file) reads as null → anchored at the next start. */
  lastCuratorTickAt: number | null;
};

export function loadBatchState(filePath: string): BatchState {
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, "utf-8")) as Record<
      string,
      Record<string, unknown>
    >;
    const toMap = (o: Record<string, unknown> | undefined): VaultSnapshot | null =>
      o
        ? new Map(
            Object.entries(o).filter((e): e is [string, string] => typeof e[1] === "string"),
          )
        : null;
    const toStamps = (
      o: Record<string, unknown> | undefined,
    ): Map<string, StampRecord> | null => {
      if (!o) return null;
      const m = new Map<string, StampRecord>();
      for (const [k, v] of Object.entries(o)) {
        if (v && typeof v === "object" && !Array.isArray(v)) {
          const r = v as { hash?: unknown; updated?: unknown; leb?: unknown };
          if (typeof r.hash !== "string") continue; // schema drift → first-sight
          m.set(k, {
            hash: r.hash,
            updated: typeof r.updated === "string" ? r.updated : null,
            leb: typeof r.leb === "string" ? r.leb : null,
          });
        }
      }
      return m;
    };
    const anchor = (raw as Record<string, unknown>).lastCuratorTickAt;
    return {
      permanent: toMap(raw.permanent),
      silentStamps: toStamps(raw.silentStamps),
      lastCuratorTickAt: typeof anchor === "number" && Number.isFinite(anchor) ? anchor : null,
    };
  } catch {
    return { permanent: null, silentStamps: null, lastCuratorTickAt: null };
  }
}

export function persistBatchState(
  filePath: string,
  state: {
    permanent: VaultSnapshot;
    silentStamps: Map<string, StampRecord>;
    lastCuratorTickAt: number | null;
  },
): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp`;
  guardedWriteFileSync(
    tmp,
    JSON.stringify({
      permanent: Object.fromEntries(state.permanent),
      silentStamps: Object.fromEntries(state.silentStamps),
      lastCuratorTickAt: state.lastCuratorTickAt,
    }),
    "utf-8",
  );
  guardedRenameSync(tmp, filePath);
}

export function loadHashState(filePath: string): Map<string, string> {
  const map = new Map<string, string>();
  try {
    const obj = JSON.parse(fs.readFileSync(filePath, "utf-8")) as Record<string, unknown>;
    for (const [k, v] of Object.entries(obj)) {
      if (typeof v === "string" && /^[a-f0-9]{64}$/.test(v)) map.set(k, v);
    }
  } catch {
    // first run / corrupt file — start empty
  }
  return map;
}

export function persistHashState(filePath: string, map: Map<string, string>): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp`;
  guardedWriteFileSync(tmp, JSON.stringify(Object.fromEntries(map)), "utf-8");
  guardedRenameSync(tmp, filePath);
}

// ── the daemon ───────────────────────────────────────────────────────────────

export type MemorydOptions = {
  config: CoreConfig;
  logger?: Logger;
  /** Event sink; default writes signal lines to stdout. */
  emit?: (line: string) => void;
  /** Debounce for fs events (ms). */
  debounceMs?: number;
  /** Heartbeat period (ms). */
  heartbeatMs?: number;
  /** Heartbeat file; default `<db dir>/memoryd.heartbeat`. */
  heartbeatPath?: string;
  /** Tags mirror target; default `<db dir>/tags-dictionary.md`. */
  tagsMirrorPath?: string;
  /** Compact tags-projection target (injected to all peers, lean §3);
   *  default `<db dir>/tags-projection.md`. */
  tagsProjectionPath?: string;
  /** Detect-hash persistence file; default `<db dir>/memoryd.hashes.json`. */
  hashStatePath?: string;
  /** Persisted batch baselines (the permanent-folders snapshot + silent
   *  stamps). */
  batchStatePath?: string;
  /** Curator-tick cadence override (tests); default from config.batch. */
  curatorTickMs?: number;
  /** Periodic hash-persist interval (ms). */
  persistMs?: number;
  /** Human owner name; human-edit detection is OFF when absent (⚖7). */
  humanName?: string | null;
  freshEditWindowS?: number;
  /** Upper bound on debounce coalescing, ms: a continuous event storm must
   *  not defer flush forever. Default 10 × debounceMs. */
  debounceMaxWaitMs?: number;
  /** Single-writer lock file; default `<db dir>/memoryd.lock`. */
  lockPath?: string;
  /** Liveness probe for the pid recorded in an existing lock (the package
   *  passes an egress-based `ps` probe). Absent → mtime staleness decides
   *  (the daemon touches the lock on every heartbeat tick). */
  lockPidAlive?: (pid: number) => boolean;
  /** Poll period while fs.watch is DOWN (degraded mode), ms. Default 5 min. */
  watchFallbackMs?: number;
  /** Belt-pass period while fs.watch is UP (insurance against silently dead
   *  FSEvents on iCloud vaults), ms. Default 60 min. */
  watchBeltMs?: number;
  /** Start WITHOUT fs.watch — the degraded polling contour from tick one.
   *  Diagnostic/test lever for the watch-loss path; production never sets it. */
  disableWatch?: boolean;
  /** Base backoff of the embed-backfill retry loop, ms. Default 60s (≥ the
   *  breaker cooldown); exponential ×5 up to a 15 min cap. Test lever. */
  backfillRetryMs?: number;
  /**
   * MCP http port (0 = ephemeral). Pass null to disable the endpoint;
   * omit to use `config.mcp.port` (the configured default, ADR-012).
   */
  mcpPort?: number | null;
  /** Continuous per-peer fragment rendering (docs/05: «триггер регенерации —
   *  debounce от FS-изменений vault в memoryd»). Omit → rendering off
   *  (host-neutral core: the ecosystem wiring comes from the package). */
  fragments?: MemorydFragmentsWiring;
};

/**
 * Fleet fragment wiring — assembled by the PACKAGE (ADR-009: ecosystem
 * joints live there), consumed by core as plain data. The fleet map is a
 * JSON state file (`{peers: [{personality, cwd}]}`) written by the package
 * from `iapeer list --json` (init/update/verify --repair — the registry cwd
 * is the FACT, iapeer 0.2.14); core only reads it, fail-open: missing or
 * malformed map = rendering quietly off (контракт docs/05 был обещан
 * шапкой render.ts и не подключён — пиры после рестарта не знали
 * пути записи vault).
 */
export type MemorydFragmentsWiring = {
  /** Fleet map JSON path (package state namespace). */
  fleetMapPath: string;
  /** paths-block facts for every fragment (vault/db/config/state/cache/logs). */
  paths: FragmentEnv["paths"];
  /** Author-index target (capped variant) for an agent; `-full` derived. */
  authorIndexPathFor: (agent: string) => string;
  /** Index curator personality (its branch adds the tags dictionary). */
  indexAgent?: string;
  /** ADR-014 projects root for `dir:` resolution. */
  projectsRoot?: string;
};

export type FleetPeer = { personality: string; cwd: string };

export type MemorydHandle = {
  mcpPort: number | null;
  /** Force one detect pass immediately (used by tests and shutdown flush). */
  runDetectPass: () => Promise<void>;
  /** Force a curator tick (tests / operator force-tick). */
  runCuratorTick: () => void;
  close: () => Promise<void>;
};

/**
 * Single-writer lock (audit important: no single-instance guard). memoryd is
 * the SOLE SQLite writer and the sole owner of the `.memoryd.tmp` rename
 * paths — a second instance on the same vault/DB means two writers racing
 * one tmp file (torn notes on disk), SQLITE_BUSY swallowed as «skip file»,
 * and double curator ticks. O_EXCL + pid inside; liveness of an existing
 * owner is decided by the caller-supplied probe when given (the package
 * passes an egress `ps` probe — precise, immediate takeover after a crash),
 * else by lock mtime staleness (the daemon touches the lock on every
 * heartbeat tick, so a live owner's lock is always fresh).
 *
 * Returns a release function. Throws (loudly, with the owner pid) when a
 * LIVE owner holds the lock — refusing the second writer is the point.
 */
export function acquireMemorydLock(
  lockPath: string,
  opts: { pidAlive?: (pid: number) => boolean; staleMs?: number } = {},
): () => void {
  const staleMs = opts.staleMs ?? 120_000;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(lockPath, "wx");
      fs.writeSync(fd, `${process.pid}\n`);
      fs.closeSync(fd);
      return () => {
        try {
          guardedUnlinkSync(lockPath);
        } catch {
          // best effort — a stale lock is detected on the next acquire
        }
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== "EEXIST") throw err;
      let ownerPid = NaN;
      let mtimeMs = 0;
      try {
        ownerPid = Number(fs.readFileSync(lockPath, "utf-8").trim());
        mtimeMs = fs.statSync(lockPath).mtimeMs;
      } catch {
        // unreadable/vanished between EEXIST and read — treat as stale, retake
      }
      const ownerAlive = opts.pidAlive
        ? Number.isInteger(ownerPid) && ownerPid > 1 && opts.pidAlive(ownerPid)
        : Date.now() - mtimeMs < staleMs;
      if (ownerAlive) {
        throw new Error(
          `another memoryd (pid ${ownerPid || "unknown"}) holds ${lockPath} — ` +
            "refusing a second writer on the same vault/DB; stop it first (iapeer-memory uninstall stops by pid file)",
        );
      }
      try {
        guardedUnlinkSync(lockPath); // stale lock from a crashed owner
      } catch {
        // someone else may have swept it — the retake attempt decides
      }
    }
  }
  throw new Error(`could not acquire ${lockPath} after clearing a stale lock — giving up`);
}

/**
 * Whether a note's frontmatter already carries a non-empty `author`. The
 * first-sight guard uses it to tell a SETTLED note (has author — never
 * re-stamp it at startup) from a genuinely NEW one (a human's bare-body canon
 * note with no author yet — fill it on its first event, §9). No frontmatter →
 * bare → not settled.
 */
function hasAuthorField(content: string): boolean {
  const fm = /^---[^\S\n]*\n([\s\S]*?)\n---[^\S\n]*(?:\n|$)/.exec(content);
  if (!fm) return false;
  return /^author\s*:\s*\S/m.test(fm[1]);
}

export async function startMemoryd(opts: MemorydOptions): Promise<MemorydHandle> {
  const { config } = opts;
  const logger = opts.logger ?? makeLogger("memoryd");
  const emit = opts.emit ?? ((line: string) => process.stdout.write(`${line}\n`));
  const debounceMs = opts.debounceMs ?? 1500;
  const heartbeatMs = opts.heartbeatMs ?? 30_000;
  const dbDir = path.dirname(config.index.dbPath);
  const heartbeatPath = opts.heartbeatPath ?? path.join(dbDir, "memoryd.heartbeat");
  const tagsMirrorPath = opts.tagsMirrorPath ?? path.join(dbDir, "tags-dictionary.md");
  const tagsProjectionPath = opts.tagsProjectionPath ?? path.join(dbDir, "tags-projection.md");
  const tagsBoundaryMaxLen =
    Number(process.env.IAPEER_MEMORY_TAGS_BOUNDARY_MAXLEN) || DEFAULT_TAGS_BOUNDARY_MAXLEN;
  const hashStatePath = opts.hashStatePath ?? path.join(dbDir, "memoryd.hashes.json");
  const persistMs = opts.persistMs ?? 60_000;
  const taxonomy = config.taxonomy;

  // Writer-startup cache invalidation — the daemon is the sole SQLite owner,
  // so it owns these one-time migrations (read-only MCP frontends never run
  // them). `migrateVecDimension` rebuilds vec_chunks when the embedder's
  // output width changed, else a stale dimension crash-loops every embedding
  // INSERT. Then, BEFORE indexAll repopulates: a model swap nulls stale
  // embeddings and a PARSER_VERSION bump nulls content_hash to force a reparse.
  // All are no-ops when nothing changed (and embedding checks no-op entirely
  // when vectors are off).
  //
  // Serve-first: indexAll runs STRUCTURAL-ONLY here (`embed: false`) — parse /
  // chunk / upsert / wikilink-resolve, everything BM25/FTS5 serving needs —
  // and the network-bound embed pass is deferred to a background task kicked
  // off below, once the MCP port + heartbeat are up. On a model swap or
  // PARSER_VERSION bump that invalidation re-embeds the WHOLE vault (minutes on
  // a large vault); doing it inline would keep the port closed and the
  // heartbeat stale that whole time — an availability hole for a rolling fleet
  // update. While the backfill catches up, search degrades to BM25-only for
  // not-yet-embedded chunks (search.ts graceful degradation) and gains vectors
  // as they fill in.
  // Sandbox belt at the DOOR (audit important, fs-guard finding): a sandboxed
  // process pointed at the LIVE vault (an inherited IAPEER_MEMORY_VAULT_PATH,
  // a test config naming prod) must refuse to start at all — per-operation
  // guards catch writes, but a daemon over the prod vault also READS team
  // notes and archives them; refusing the start closes the whole class.
  if (sandboxEnvArmed() && isUnderProdAnchor(config.vaultPath)) {
    throw new Error(
      `memoryd: refusing to start under the test sandbox over a production vault (${config.vaultPath}) — ` +
        "point IAPEER_MEMORY_VAULT_PATH at a sandbox tmp vault",
    );
  }

  // Single-writer lock BEFORE the database opens (audit important): a second
  // memoryd on the same vault/DB must die here, not after it has already run
  // a full indexAll as a second writer.
  const lockPath = opts.lockPath ?? path.join(dbDir, "memoryd.lock");
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  const releaseLock = acquireMemorydLock(lockPath, { pidAlive: opts.lockPidAlive });

  const db = openDatabase(config, { migrateVecDimension: true });
  checkEmbeddingModelChanged(db, config.embedding);
  // The COMPOSITE fingerprint, not the bare version: stored chunks depend on
  // chunkSize/chunkOverlap (boundaries) and the taxonomy locale (which links
  // heading is stripped from the indexed text). Pre-fix, an operator changing
  // IAPEER_MEMORY_CHUNK_SIZE (or the locale) restarted into an index that
  // NEVER re-chunked — a permanent mix of old and new slicing (audit
  // important: «affects the index but not the hash invalidation»).
  checkParserChanged(
    db,
    `${PARSER_VERSION}:${config.search.chunkSize}:${config.search.chunkOverlap}:${config.locale}`,
  );
  // One-shot GC of vec_chunks rows under dead rowids (pre-fix orphans from
  // the backfill↔reindex race, audit critical #1); steady-state a no-op.
  const orphans = gcOrphanVecChunks(db);
  if (orphans > 0) logger.info(`iapeer-memory: GC removed ${orphans} orphan vec_chunks rows`);
  await indexAll({ db, config, logger, embed: false });

  // Baseline (каденция): канон + оперативка
  // копятся и уходят ПАЧКОЙ раз в batch.curatorMs (default 6h, CURATOR_TICK).
  // Снапшот ПЕРСИСТИТСЯ через рестарты (порт паттерна старых мониторов: «seen
  // переживает сбой») — рестарт не глотает накопленное и не реплеит
  // обработанное.
  const batchStatePath = opts.batchStatePath ?? path.join(dbDir, "memoryd.batches.json");
  const persistedBatches = loadBatchState(batchStatePath);
  let permanentBaseline: VaultSnapshot =
    persistedBatches.permanent ?? snapshotVault(config.vaultPath, taxonomy);
  const lastSeenHashes = loadHashState(hashStatePath);
  /** Silent-edit stamp baseline (rel → {updated, leb}); absent key in an
   *  old state file = empty map = first-sight warm-up (design §4). */
  const silentStamps: Map<string, StampRecord> =
    persistedBatches.silentStamps ?? new Map();
  // Curator-tick wall-clock anchor (see BatchState): persisted → the 6h
  // countdown survives restarts. No persisted anchor (fresh install or a
  // pre-anchor state file) → anchor at THIS start: first tick one full
  // period from now — the pre-anchor behavior, minus the reset-on-restart.
  let lastCuratorTickAt: number = persistedBatches.lastCuratorTickAt ?? Date.now();

  function persistBatches(): void {
    try {
      persistBatchState(batchStatePath, {
        permanent: permanentBaseline,
        silentStamps,
        lastCuratorTickAt,
      });
    } catch (err) {
      logger.error(`batch-state persist failed: ${String(err)}`);
    }
  }
  // First run OR a pre-anchor state file: persist so the freshly-minted
  // anchor survives an immediate recycle (deploy bursts are the incident class).
  if (!persistedBatches.permanent || persistedBatches.lastCuratorTickAt === null) {
    persistBatches();
  }

  /** iCloud-mount guard (порт защиты старых мониторов): корень vault
   *  недоступен → пропускаем проход целиком, baseline не трогаем — после
   *  восстановления mount «всё новое» не реплеится штормом. */
  function vaultAvailable(): boolean {
    try {
      return fs.statSync(config.vaultPath).isDirectory();
    } catch {
      logger.warn("vault root unavailable (iCloud unmount?) — pass skipped");
      return false;
    }
  }

  /** SOURCE-фильтр кураторских правок (директива п.5 + stale-fix): свежий
   *  last_edited_by читается ИЗ ФАЙЛА на момент пачки — правки
   *  index/scriber/dreamweaver в пачку не попадают (эхо-брейкер механикой,
   *  не доктриной). */
  // ── per-peer fragments (docs/05: свежесть за секунды от FS-изменений) ──
  const fragments = opts.fragments ?? null;
  // The needs_review finalizer name — SHARED by the fragment renderer and
  // curatorClearPass (audit cosmetic: the clear pass hardcoded "index", so a
  // deployment with a renamed finalizer never auto-cleared the flag).
  const indexAgent = fragments?.indexAgent ?? "index";
  let fleetCache: { mtimeMs: number; peers: FleetPeer[] } | null = null;
  let warnedFleetReadBlocked = false;

  /** Fail-open fleet map reader with an mtime cache: missing/malformed file
   *  → empty fleet (rendering quietly off), never throws. */
  function readFleetMap(): FleetPeer[] {
    if (!fragments) return [];
    // Read-as-egress (И4 parity): the prod fleet map NAMES live cwds — a
    // sandboxed process must not learn them. Empty fleet = rendering off.
    if (sandboxBlocksProdRead(fragments.fleetMapPath)) {
      if (!warnedFleetReadBlocked) {
        warnedFleetReadBlocked = true;
        logger.warn(
          `fragments: live fleet map skipped under the test sandbox (${fragments.fleetMapPath}) — set IAPEER_MEMORY_STATE_DIR/IAPEER_ROOT`,
        );
      }
      return [];
    }
    try {
      const st = fs.statSync(fragments.fleetMapPath);
      if (fleetCache && fleetCache.mtimeMs === st.mtimeMs) return fleetCache.peers;
      const raw = JSON.parse(fs.readFileSync(fragments.fleetMapPath, "utf-8")) as {
        peers?: Array<{ personality?: unknown; cwd?: unknown }>;
      };
      const peers: FleetPeer[] = (Array.isArray(raw?.peers) ? raw.peers : [])
        .filter(
          (p): p is { personality: string; cwd: string } =>
            typeof p?.personality === "string" &&
            p.personality.trim() !== "" &&
            typeof p?.cwd === "string" &&
            p.cwd.trim() !== "",
        )
        .map((p) => ({ personality: p.personality.trim(), cwd: p.cwd.trim() }));
      fleetCache = { mtimeMs: st.mtimeMs, peers };
      return peers;
    } catch {
      fleetCache = null;
      return [];
    }
  }

  /** One render pass over the whole fleet: collectNotes ONCE (the full
   *  vault scan is the expensive part), then filter/build/write per peer.
   *  Per-peer failures are isolated; a peer whose cwd is gone is skipped
   *  (never scaffold directories for a removed peer). */
  function renderFleetFragments(reason: string): void {
    if (!fragments || !vaultAvailable()) return;
    const peers = readFleetMap();
    if (!peers.length) return;
    const ctx: RenderContext = { taxonomy, ranking: config.ranking };
    let collected: ReturnType<typeof collectNotes>;
    try {
      collected = collectNotes(config.vaultPath, ctx);
    } catch (err) {
      logger.warn(`fragments: vault collect failed (${String(err)}) — pass skipped`);
      return;
    }
    let rendered = 0;
    for (const peer of peers) {
      try {
        if (!fs.existsSync(peer.cwd)) continue;
        const mine = filterAgentNotes(collected.notes, collected.incomingCount, peer.personality, ctx);
        const outFile = fragments.authorIndexPathFor(peer.personality);
        fs.mkdirSync(path.dirname(outFile), { recursive: true }); // atomicWrite не создаёт родителя
        const fullOut = fullIndexPathFor(outFile);
        const [text] = buildOutput(mine, peer.personality, {
          ctx,
          projectsRoot: fragments.projectsRoot,
          fullIndexPath: fullOut,
        });
        atomicWrite(outFile, text);
        const [fullText] = buildOutput(mine, peer.personality, {
          ctx,
          projectsRoot: fragments.projectsRoot,
          memoryCap: null,
          canonCap: null,
          projectHardCap: null,
        });
        atomicWrite(fullOut, fullText);
        renderPeerFragment({
          peerCwd: peer.cwd,
          env: {
            agent: peer.personality,
            indexAgent,
            paths: fragments.paths,
            authorIndexPath: outFile,
            // lean §3: the compact dictionary projection is injected to EVERY
            // author now (pre-lean: only the Index got the full mirror).
            tagsProjectionPath,
            tagsTitle: taxonomy.systemFiles.tagsDictionary,
          },
        });
        rendered++;
      } catch (err) {
        logger.warn(`fragments: ${peer.personality} render failed (${String(err)})`);
      }
    }
    if (rendered) logger.info(`fragments: rendered ${rendered} peer fragment(s) (${reason})`);
  }

  syncTagsMirror(); // best-effort materialisation at start

  function syncTagsMirror(): void {
    const srcPath = path.join(config.vaultPath, tagsDictionarySourceRel(taxonomy));
    let srcContent: string | null = null;
    try {
      srcContent = fs.readFileSync(srcPath, "utf-8");
    } catch {
      srcContent = null;
    }
    let mirrorContent: string | null = null;
    try {
      mirrorContent = fs.readFileSync(tagsMirrorPath, "utf-8");
    } catch {
      mirrorContent = null;
    }
    const decision = decideMirror({ srcContent, mirrorContent });
    if (decision.action === "write") {
      fs.mkdirSync(path.dirname(tagsMirrorPath), { recursive: true });
      const tmp = `${tagsMirrorPath}.tmp`;
      guardedWriteFileSync(tmp, srcContent!, "utf-8");
      guardedRenameSync(tmp, tagsMirrorPath);
      mirrorContent = srcContent;
      logger.info(`tags mirror updated (${decision.reason})`);
    }
    // Refresh the compact projection from the (up-to-date) mirror — even when
    // the mirror was unchanged, so the projection materialises on first run
    // after the feature ships (lean §3). Idempotent: writes only on a change.
    syncTagsProjection(mirrorContent);
  }

  function syncTagsProjection(mirrorContent: string | null): void {
    if (!mirrorContent || !mirrorContent.trim()) return; // no dict → keep existing
    const proj = renderTagsProjection(mirrorContent, { boundaryMaxLen: tagsBoundaryMaxLen });
    if (!proj.trim()) return;
    let existing: string | null = null;
    try {
      existing = fs.readFileSync(tagsProjectionPath, "utf-8");
    } catch {
      existing = null;
    }
    if (existing === proj) return;
    fs.mkdirSync(path.dirname(tagsProjectionPath), { recursive: true });
    const tmp = `${tagsProjectionPath}.tmp`;
    guardedWriteFileSync(tmp, proj, "utf-8");
    guardedRenameSync(tmp, tagsProjectionPath);
    logger.info("tags projection updated");
  }

  /** Zone map of the unstamped detector (design §3): the six monitored
   *  folders (five canonical + agent memory — wider than humanEditPass's
   *  getZone, which has no agent-memory notion). */
  function silentZoneOf(absPath: string): SilentZone | null {
    const rel = path.relative(config.vaultPath, absPath);
    if (rel.startsWith("..")) return null;
    const first = rel.split(path.sep)[0];
    const f = taxonomy.folders;
    if (
      first === f.knowledge ||
      first === f.decisions ||
      first === f.projects ||
      first === f.ideas ||
      first === f.lists ||
      first === f.agentMemory
    ) {
      return "permanent";
    }
    return null;
  }

  /**
   * Unstamped-write detector (design doc). Runs
   * BEFORE humanEditPass: a re-stamped file then reads `last_edited_by:
   * unstamped` — the curator source filters pass it into the curation pass,
   * and humanEditPass sees a fresh agent stamp (echo-agent skip, no double
   * stamp — order instead of ifs). Candidates carry CHANGED files only (the
   * fs.watch set) — the semantic-hash precondition of the rule; service-only
   * echoes never reach here (smart-hash blindness = echo safety of our own
   * re-stamp).
   */
  function silentEditPass(candidatesAbs: Set<string>): void {
    for (const abs of candidatesAbs) {
      const zone = silentZoneOf(abs);
      if (!zone) continue;
      const rel = path.relative(config.vaultPath, abs);
      let content: string;
      try {
        content = fs.readFileSync(abs, "utf-8");
      } catch {
        silentStamps.delete(rel); // deleted mid-debounce — drop the record
        continue;
      }
      const curr = readStampRecord(content);
      const prev = silentStamps.get(rel);
      if (prev === undefined) {
        silentStamps.set(rel, curr); // first sight: record, never judge
        continue;
      }
      if (!isSilentEdit({ prev, curr, nowMs: Date.now(), freshEditWindowS: opts.freshEditWindowS })) {
        silentStamps.set(rel, curr);
        continue;
      }
      const restamped = restampUnstamped(content, Date.now());
      if (restamped === null) {
        silentStamps.set(rel, curr); // bare draft — the fill machinery's job
        continue;
      }
      const tmp = `${abs}.memoryd.tmp`;
      try {
        guardedWriteFileSync(tmp, restamped, "utf-8");
        guardedRenameSync(tmp, abs);
        silentStamps.set(rel, readStampRecord(restamped));
        logger.info(`silent edit re-stamped (${zone}): ${rel}`);
      } catch (err) {
        try {
          guardedUnlinkSync(tmp);
        } catch {
          // best effort
        }
        logger.error(`silent-edit re-stamp failed for ${abs}: ${String(err)}`);
      }
    }
  }

  function humanEditPass(changedAbs: Set<string>, prevSmart?: Map<string, string>): void {
    const human = opts.humanName ?? null;
    if (!human) return; // ⚖7: no human role — detection off
    for (const filePath of changedAbs) {
      const zone = getZone(filePath, config.vaultPath, taxonomy);
      if (!zone) continue;
      let content: string;
      let stat: fs.Stats;
      try {
        content = fs.readFileSync(filePath, "utf-8");
        stat = fs.statSync(filePath);
      } catch {
        continue; // deleted mid-debounce
      }
      // FIRST-SIGHT GUARD (churn-дефект; §9-фикс 0.3.1):
      // путь, которого нет в hash-базе — это ПЕРВОЕ наблюдение. Если у ноты
      // УЖЕ есть author — она SETTLED (старт демона над населённым vault, или
      // любая атрибутированная нота): запиши baseline и НЕ стампь (load-bearing
      // инвариант — старт никогда не перештамповывает существующие ноты).
      // Нота БЕЗ author — генуинно новая: голое тело человека прямо в канон —
      // проваливается в fill ниже и достраивается на ЭТОМ первом событии (§9:
      // голое тело человека достраивается, не откладывается до второго).
      // (Размещений Индексом больше нет — инбокс устранён.)
      if (!lastSeenHashes.has(filePath) && hasAuthorField(content)) {
        lastSeenHashes.set(filePath, sha256(content));
        continue;
      }
      const decision = decideUpdate({
        content,
        human,
        nowMs: Date.now(),
        birthtimeMs: stat.birthtime ? stat.birthtime.getTime() : 0,
        mtimeMs: stat.mtime.getTime(),
        path: filePath,
        vault: config.vaultPath,
        lastHash: lastSeenHashes.get(filePath) ?? null,
        taxonomy,
        freshEditWindowS: opts.freshEditWindowS,
        // Service-only guard source, PER-PASS first (audit important): the
        // pre-pass silentStamps snapshot carries the semantic hash as of the
        // LAST pass — the 6h-frozen permanentBaseline missed every semantic
        // edit since the tick, so a human's checkbox-clear of needs_review
        // after an agent's recent content edit compared against a stale hash,
        // the guard whiffed, and the clear was REVERTED (flag forced back,
        // human falsely into coauthors). Baseline stays as the fallback for
        // files without a silentStamps record yet.
        prevSmartHash:
          prevSmart?.get(filePath) ??
          permanentBaseline.get(path.relative(config.vaultPath, filePath)) ??
          null,
      });
      if (decision.action === "skip") {
        if (decision.recordHash !== null) lastSeenHashes.set(filePath, decision.recordHash);
        continue;
      }
      const tmp = `${filePath}.memoryd.tmp`;
      try {
        guardedWriteFileSync(tmp, decision.newContent, "utf-8");
        guardedRenameSync(tmp, filePath);
        lastSeenHashes.set(filePath, decision.recordHash);
        logger.info(`human-edit ${decision.reason}: ${path.relative(config.vaultPath, filePath)}`);
      } catch (err) {
        try {
          guardedUnlinkSync(tmp);
        } catch {
          // best effort
        }
        logger.error(`human-edit write failed for ${filePath}: ${String(err)}`);
      }
    }
  }

  /**
   * Deterministic archiving (lean §2.2a): move stale notes among the changed
   * files to the archive folder. Runs AFTER humanEditPass (a note just marked
   * stale carries its stamp). The move is invisible to permanent-detect
   * (deletions are ignored; the archive is outside `monitoredFolders`), and
   * `indexAll` below reconciles the path change (drops the source, indexes the
   * archived copy — still searchable with the stale boost). Returns the count.
   */
  function archiveStaleNotes(candidatesAbs: Set<string>): number {
    let moved = 0;
    for (const abs of candidatesAbs) {
      const rel = path.relative(config.vaultPath, abs);
      if (!isArchivableZone(rel, taxonomy)) continue;
      let content: string;
      try {
        content = fs.readFileSync(abs, "utf-8");
      } catch {
        continue; // deleted mid-debounce
      }
      if (!shouldArchive(rel, content, taxonomy)) continue;
      const targetRel = archiveTargetRel(path.basename(abs), taxonomy, (r) =>
        fs.existsSync(path.join(config.vaultPath, r)),
      );
      const targetAbs = path.join(config.vaultPath, targetRel);
      try {
        fs.mkdirSync(path.dirname(targetAbs), { recursive: true });
        guardedRenameSync(abs, targetAbs);
        silentStamps.delete(rel); // baselines follow the move
        lastSeenHashes.delete(abs);
        moved += 1;
        logger.info(`archived (stale): ${rel} → ${targetRel}`);
      } catch (err) {
        logger.error(`archive failed for ${rel}: ${String(err)}`);
      }
    }
    return moved;
  }

  // ── fs.watch + debounce ──
  const pending = new Set<string>();
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  let flushing: Promise<void> = Promise.resolve();
  /** Oldest un-flushed event of the current debounce series — feeds the
   *  max-wait cap (a storm must not defer flush forever). */
  let firstPendingAt: number | null = null;
  const debounceMaxWaitMs = opts.debounceMaxWaitMs ?? debounceMs * 10;
  /** Retry contour for a LOST pass (vault unavailable / pass error):
   *  schedule() re-arms only on NEW fs events, so a re-queued set needs its
   *  own timer. Backoff is bounded — a long unmount must not spin hot. */
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let retryBackoffMs = 0;
  /** While the background embed backfill is draining the global
   *  NULL-embedding queue, flush must not embed inline (double work +
   *  the flush chain would block on the whole backlog). Also true during
   *  shutdown: the final flush is structural-only, embeddings resume next
   *  start (the backfill is restart-safe). */
  let backfillActive = config.embedding != null;
  let shuttingDown = false;

  /**
   * needs_review CLOSURE (Release 3, inv 3/5/7): when the Index — the finalizer —
   * curates a flagged note, clear `needs_review: false` IN CODE, not on LLM
   * discipline. A "curation" is an edit attributed `last_edited_by: index` that
   * MOVED the semantic hash (real content work: links enriched, dedup, wikilinks
   * fixed — all in body/non-service frontmatter). A service-only Index touch
   * (hash unmoved — a backfill / stamp / `fm-update --agent index`) does NOT
   * clear (inv 5, the same smart-hash discriminator as the Release 1 guard).
   * Only `index` finalizes; scriber/dreamweaver report but never clear (inv 7).
   * First-sight (no prev hash) is conservative — leave the flag; the queue
   * self-returns the note on the next curator tick. The clear is a service-only
   * splice (needs_review only — leb/updated from the hook stay), so it never
   * moves the semantic hash and is echo-safe.
   */
  function curatorClearPass(candidatesAbs: Set<string>, prevSmart: Map<string, string>): void {
    for (const abs of candidatesAbs) {
      let content: string;
      try {
        content = fs.readFileSync(abs, "utf-8");
      } catch {
        continue;
      }
      const fm = /^---[^\S\n]*\n([\s\S]*?)\n---/.exec(content);
      if (!fm) continue;
      const leb = /^last_edited_by\s*:\s*(.+?)\s*$/m.exec(fm[1]);
      if (!leb || leb[1].trim() !== indexAgent) continue; // only the finalizer clears (inv 7)
      const nr = /^needs_review\s*:\s*(\S+)/m.exec(fm[1]);
      if (!nr || nr[1].replace(/#.*$/, "").trim() !== "true") continue; // nothing flagged
      const prev = prevSmart.get(abs);
      if (prev == null) continue; // first-sight: can't tell if THIS edit moved the hash → leave
      if (smartHash(new TextEncoder().encode(content)) === prev) continue; // service-only (inv 5)
      const cleared = setNeedsReviewFalse(content);
      if (cleared === null || cleared === content) continue;
      const tmp = `${abs}.memoryd.tmp`;
      try {
        guardedWriteFileSync(tmp, cleared, "utf-8");
        guardedRenameSync(tmp, abs);
        const rel = path.relative(config.vaultPath, abs);
        lastSeenHashes.set(abs, sha256(cleared));
        silentStamps.set(rel, readStampRecord(cleared));
        logger.info(`needs_review auto-cleared (index curation): ${rel}`);
      } catch (err) {
        try {
          guardedUnlinkSync(tmp);
        } catch {
          // best effort
        }
        logger.error(`needs_review auto-clear failed for ${abs}: ${String(err)}`);
      }
    }
  }

  /**
   * One detect+index pass. Default INCREMENTAL: indexAll touches only the
   * changed set (audit important — a single edit used to read+sha256 the
   * whole vault). `full` forces the complete reconciliation walk — used by
   * startup-adjacent callers: the poll/belt pass (its job is to catch what
   * fs.watch MISSED, incremental would be blind to exactly that) and the
   * runDetectPass test/operator hook.
   */
  async function flush(full = false): Promise<void> {
    const changed = new Set(pending);
    pending.clear();
    firstPendingAt = null;

    // A LOST pass must not eat the changed set (audit important: pending was
    // cleared before the work). The detect belts (stamping, archival,
    // needs_review) run ONLY off this set — re-queue and retry with bounded
    // backoff. Baselines are untouched here, so the retry judges the same
    // edits correctly.
    const requeue = (why: string): void => {
      for (const p of changed) pending.add(p);
      retryBackoffMs = Math.min(retryBackoffMs ? retryBackoffMs * 2 : debounceMs * 4, 5 * 60_000);
      if (retryTimer) clearTimeout(retryTimer);
      retryTimer = setTimeout(() => {
        retryTimer = null;
        flushing = flushing.then(() => flush()).catch((err) => {
          logger.error(`retry pass failed: ${String(err)}`);
        });
      }, retryBackoffMs);
      retryTimer.unref?.();
      logger.warn(
        `flush deferred (${why}) — ${changed.size} path(s) re-queued, retry in ${retryBackoffMs}ms`,
      );
    };

    if (!vaultAvailable()) {
      requeue("vault unavailable");
      return;
    }

    try {
      // Per-pass prev smart-hash (needs_review closure, Release 3): snapshot the
      // silentStamps baseline BEFORE silentEditPass advances it, so curatorClearPass
      // can tell whether THIS pass's edit MOVED the semantic hash (real curation →
      // auto-clear) or not (service-only → leave the flag).
      const prevSmart = new Map<string, string>();
      for (const abs of changed) {
        const rec = silentStamps.get(path.relative(config.vaultPath, abs));
        if (rec) prevSmart.set(abs, rec.hash);
      }

      // Unstamped detector FIRST (design §3 order): re-stamps land before
      // humanEditPass judges (a re-stamped file then reads `last_edited_by:
      // unstamped` and humanEditPass sees a fresh agent stamp → echo-agent
      // skip, no double stamp — order instead of ifs). Candidates are the
      // fs.watch changed set; service-only echoes never reach the rule
      // (smart-hash blindness = echo safety of our own re-stamp).
      silentEditPass(changed);

      humanEditPass(changed, prevSmart);
      curatorClearPass(changed, prevSmart); // needs_review closure: Index curation auto-clears the flag
      archiveStaleNotes(changed); // lean §2.2a — stale → archive before reindex
      syncTagsMirror();
      // embed:false while the background backfill drains the global queue
      // (audit important: indexAll's inline embed pass takes the WHOLE
      // NULL-embedding queue — a single edit would block the flush chain on
      // the entire backlog AND double-embed every batch the backfill also
      // selects). A changed note's new chunks land in the same queue and the
      // backfill drains them. Same for shutdown: structural-only, the
      // restart-safe backfill resumes next start.
      await indexAll({
        db,
        config,
        logger,
        embed: backfillActive || shuttingDown ? false : undefined,
        changedPaths: full ? undefined : changed,
      });
      renderFleetFragments("vault-change"); // docs/05: свежесть за секунды
      retryBackoffMs = 0;
      if (retryTimer) {
        // A pending retry is moot — this pass covered the re-queued set too.
        clearTimeout(retryTimer);
        retryTimer = null;
      }
      // Canon edits are NOT emitted instantly — they accumulate to the curator
      // tick (cadence 6h); see runCuratorTick.
    } catch (err) {
      logger.error(`detect pass failed: ${String(err)}`);
      requeue("pass error");
    }
  }

  /** CURATOR_TICK — one cadence pass: diff canon + agent memory against the
   *  carried baseline, curator-authored edits filtered BY SOURCE, the rest
   *  goes out as ONE line (a JSON array of ABSOLUTE paths → one delivery →
   *  one ephemeral curation session → one report). In lean the emit is
   *  suppressed (no proactive receiver), but the baseline still advances. */
  function runCuratorTick(): void {
    if (!vaultAvailable()) return; // anchor NOT advanced — the retry floor re-checks soon
    // Advance the persisted cadence anchor FIRST — the tick occasion is
    // consumed even if the queue is empty (persistBatches below carries it
    // atomically with the advanced baseline).
    lastCuratorTickAt = Date.now();
    // permanentBaseline still advances — the Release 1 humanEditPass service-only
    // guard reads it as its prev-smart-hash source.
    permanentBaseline = snapshotVault(config.vaultPath, taxonomy);
    // SET = the needs_review:true QUEUE (Release 3, inv 2), NOT the smart-hash
    // diff. A flagged note stays in the curator's work-set until its flag is
    // cleared (self-returning closure), instead of a one-shot diff that decoupled
    // from the flag in lean (baseline advanced under suppressed emit → the flag
    // piled up: the mechanical root of the 235+372 backlog). The flag is set only
    // on non-curator writes, so the queue is inherently the "uncurated" set — no
    // source filter needed; a flagged note Index merely service-touched (flag
    // still true) legitimately stays until a real curation auto-clears it.
    const absPaths = collectNeedsReview(config.vaultPath, taxonomy).map((rel) =>
      path.join(config.vaultPath, rel),
    );
    if (absPaths.length) {
      logger.info(`curator tick: ${absPaths.length} needs_review path(s)`);
      emit(`CURATOR_TICK: ${JSON.stringify(absPaths)}`);
    }
    persistBatches();
  }

  function schedule(absPath: string): void {
    pending.add(absPath);
    const now = Date.now();
    if (firstPendingAt === null) firstPendingAt = now;
    if (flushTimer) clearTimeout(flushTimer);
    // Max-wait cap (audit important: debounce without an upper bound): an
    // event storm with gaps < debounceMs (iCloud sync, bulk migration) resets
    // the timer forever — search would serve a stale index for the whole
    // storm and the eventual giant pass would be a single point of loss.
    // Once the OLDEST pending event has waited debounceMaxWaitMs, flush now.
    if (now - firstPendingAt >= debounceMaxWaitMs) {
      flushTimer = null;
      flushing = flushing.then(() => flush()).catch((err) => {
        logger.error(`detect pass failed: ${String(err)}`);
      });
      return;
    }
    flushTimer = setTimeout(() => {
      flushTimer = null;
      flushing = flushing.then(() => flush()).catch((err) => {
        logger.error(`detect pass failed: ${String(err)}`);
      });
    }, debounceMs);
  }

  // ── vault watch + degradation contour (audit critical #6) ──
  // fs.watch is the ONLY event source feeding flush(); pre-fix, a dead
  // watcher (failed at start, or an async FSWatcher 'error' — which without
  // a listener CRASHES the process) froze the index and every render forever
  // while the heartbeat kept ticking green: silent staleness for the whole
  // team. The contour: a polling timer drives the SAME pipeline — a
  // snapshotVault diff feeds the detect rules their changed-paths set, then
  // one full flush (indexAll is content-hash incremental) refreshes
  // index + renders + deletions. Two cadences, one mechanism:
  //   - POLL (watchFallbackMs, default 5 min) while the watcher is DOWN —
  //     the vault stays live at reduced latency instead of freezing;
  //   - BELT (watchBeltMs, default 60 min) while the watcher is UP — cheap
  //     insurance against FSEvents dying SILENTLY (iCloud vaults do this;
  //     it is undetectable from the watcher object).
  // The watch state is written into the heartbeat file (`watch=on|off`) so
  // verify/status can surface the degradation instead of reporting green.
  const watchFallbackMs = opts.watchFallbackMs ?? 5 * 60_000;
  const watchBeltMs = opts.watchBeltMs ?? 60 * 60_000;
  let watcher: fs.FSWatcher | null = null;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let pollSnapshot: VaultSnapshot | null = null;

  function pollPass(): void {
    if (!vaultAvailable()) return;
    try {
      const snap = snapshotVault(config.vaultPath, taxonomy);
      if (pollSnapshot) {
        const keys = new Set([...pollSnapshot.keys(), ...snap.keys()]);
        for (const rel of keys) {
          if (pollSnapshot.get(rel) !== snap.get(rel)) {
            pending.add(path.join(config.vaultPath, rel));
          }
        }
      }
      pollSnapshot = snap;
    } catch (err) {
      logger.error(`watch-fallback snapshot failed: ${String(err)}`);
    }
    // FULL pipeline regardless of the diff: this pass's whole job is to
    // catch what fs.watch missed (dead/degraded watch, folders outside the
    // snapshot's monitored set, unreported deletions) — the incremental mode
    // is blind to exactly that. Content-hash skip keeps a no-change full
    // walk cheap in IO terms relative to its cadence.
    flushing = flushing.then(() => flush(true)).catch((err) => {
      logger.error(`watch-fallback pass failed: ${String(err)}`);
    });
  }

  function armPollTimer(periodMs: number): void {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(pollPass, periodMs);
    pollTimer.unref?.();
  }

  function degradeWatch(reason: string): void {
    try {
      watcher?.close();
    } catch {
      // already dead — that's why we're here
    }
    watcher = null;
    logger.error(
      `fs.watch DOWN (${reason}) — degraded to polling every ${Math.round(watchFallbackMs / 1000)}s; ` +
        "index/renders stay live at reduced latency; restart memoryd to re-arm watch",
    );
    armPollTimer(watchFallbackMs);
    touchHeartbeat(); // reflect watch=off immediately, not on the next tick
  }

  if (opts.disableWatch) {
    degradeWatch("disabled by options");
  } else {
    try {
      watcher = fs.watch(config.vaultPath, { recursive: true }, (_event, filename) => {
        if (!filename || !filename.toString().endsWith(".md")) return;
        const name = filename.toString();
        if (name.includes(".memoryd.tmp")) return;
        schedule(path.join(config.vaultPath, name));
      });
      // An async watcher error without a listener is an unhandled 'error'
      // event — it would crash the daemon. Degrade to polling instead.
      watcher.on("error", (err) => degradeWatch(String(err)));
      armPollTimer(watchBeltMs);
    } catch (err) {
      degradeWatch(String(err));
    }
  }

  // ── heartbeat ──
  function touchHeartbeat(): void {
    try {
      fs.mkdirSync(path.dirname(heartbeatPath), { recursive: true });
      // tmp+rename like every other state file (audit cosmetic): a reader
      // (verify / SessionStart health-check) landing between truncate and
      // write saw an empty/partial heartbeat → false «memoryd unhealthy».
      // Single writer (the lock guarantees it) — a fixed tmp name is safe.
      const tmp = `${heartbeatPath}.tmp`;
      guardedWriteFileSync(
        tmp,
        `${new Date().toISOString()} ${os.hostname()} watch=${watcher ? "on" : "off"}\n`,
      );
      guardedRenameSync(tmp, heartbeatPath);
    } catch (err) {
      logger.error(`heartbeat write failed: ${String(err)}`);
    }
    try {
      // Keep the single-writer lock FRESH: the mtime-staleness fallback of
      // acquireMemorydLock reads this as «the owner is alive».
      const now = new Date();
      fs.utimesSync(lockPath, now, now);
    } catch {
      // lock vanished (manual sweep) — the next acquire will sort it out
    }
  }
  touchHeartbeat();
  const heartbeatTimer = setInterval(() => {
    touchHeartbeat();
    // Fleet-map change without a vault change (a new peer landed in the
    // registry, the package re-wrote the map) → render the newcomers on
    // the next tick; the mtime cache makes the no-change case a stat().
    if (fragments) {
      try {
        const st = fs.statSync(fragments.fleetMapPath);
        if (st.mtimeMs !== fleetCache?.mtimeMs) renderFleetFragments("fleet-map-change");
      } catch {
        // no map — rendering stays off (fail-open)
      }
    }
  }, heartbeatMs);
  heartbeatTimer.unref?.();

  // Cold-start coverage: render the WHOLE fleet at startup —
  // a memoryd restart after install/update populates every peer's fragment
  // before the fleet's own restarts pick them up.
  renderFleetFragments("startup");

  // Periodic atomic persist of the detect baseline (only when changed —
  // no churn); a non-graceful exit loses at most one interval.
  let lastPersistedJson: string | null = null;
  function persistQuiet(): void {
    try {
      const json = JSON.stringify(Object.fromEntries(lastSeenHashes));
      if (json === lastPersistedJson) return;
      persistHashState(hashStatePath, lastSeenHashes);
      lastPersistedJson = json;
    } catch (err) {
      logger.error(`hash-state persist failed: ${String(err)}`);
    }
  }
  // silentStamps used to persist only on the 6h curator tick + graceful
  // close — a non-graceful death lost up to 6h of stamp baselines, and the
  // first-sight warm-up then skipped real silent edits unjudged (audit
  // important, FSWatcher finding). Ride the same 60s cadence as the hashes,
  // change-gated so the no-op case stays a JSON.stringify.
  let lastBatchJson: string | null = null;
  function persistBatchesQuiet(): void {
    try {
      const json = JSON.stringify([[...permanentBaseline], [...silentStamps], lastCuratorTickAt]);
      if (json === lastBatchJson) return;
      persistBatches();
      lastBatchJson = json;
    } catch (err) {
      logger.error(`batch-state persist failed: ${String(err)}`);
    }
  }
  const persistTimer = setInterval(() => {
    persistQuiet();
    persistBatchesQuiet();
  }, persistMs);
  persistTimer.unref?.();

  // ── cadence timer — WALL-CLOCK anchored + persisted (директива ~15:31 gave
  // «первый прогон через полный период»; the anchor keeps that semantic
  // WITHOUT the old reset-on-restart). The previous setInterval counted a
  // full period from PROCESS START, in memory only: every memoryd recycle
  // (the notifier watcher relaunches the daemon on each foundation deploy)
  // restarted the 6h countdown, and a deploy-dense day starved curation
  // entirely (live incident 02–03.07: ≈40h without one CURATOR_TICK while
  // the heartbeat stayed green). Now: restart mid-period sleeps only the
  // REMAINDER; overdue (restart churn ate the whole period) → catch-up tick
  // after the floor delay, not another full period.
  const curatorTickMs = opts.curatorTickMs ?? config.batch.curatorMs;
  // The floor paces edge cases without hot-looping: a vault-unavailable skip
  // leaves the anchor in place (re-check soon, not in 6h), and an overdue
  // catch-up fires after a short settle window instead of mid-startup. It
  // scales as period/20 capped at 60s (prod 6h → 60s; sub-second test
  // periods stay observable). The cap at one full period bounds a
  // forward-skewed anchor (clock jump): the next tick can never land more
  // than curatorTickMs out.
  const curatorRetryFloorMs = Math.min(60_000, Math.max(1, Math.floor(curatorTickMs / 20)));
  let curatorTimer: ReturnType<typeof setTimeout> | null = null;
  function armCuratorTick(): void {
    const delay = Math.min(
      Math.max(lastCuratorTickAt + curatorTickMs - Date.now(), curatorRetryFloorMs),
      curatorTickMs,
    );
    curatorTimer = setTimeout(() => {
      try {
        runCuratorTick();
      } catch (err) {
        logger.error(`curator tick failed: ${String(err)}`);
      }
      armCuratorTick();
    }, delay);
    curatorTimer.unref?.();
  }
  armCuratorTick();

  // ── MCP http ──
  let mcp: { port: number; close: () => Promise<void> } | null = null;
  if (opts.mcpPort !== null) {
    mcp = await startMcpHttp({ db, config, port: opts.mcpPort ?? config.mcp.port, logger });
  }

  // ── background embedding backfill (serve-first) ──
  // The structural index is already live (BM25/FTS5 serving, port open,
  // heartbeat ticking). The embed pass — deferred from startup above — now runs
  // off the critical path: re-embed of NULL-embedding chunks, then mirror into
  // vec_chunks. Both passes are restart-safe (re-query what's still missing),
  // so a shutdown mid-backfill simply resumes next start. `backfillStopping`
  // lets close() bail the loop promptly. Errors are logged, never fatal — a
  // degraded (BM25-only) daemon beats a crashed one.
  let backfillStopping = false;
  /** Wakes a backoff sleep early so close() never waits out a retry window. */
  let backfillWake: (() => void) | null = null;
  const backfillSleep = (ms: number): Promise<void> =>
    new Promise((resolve) => {
      const t = setTimeout(() => {
        backfillWake = null;
        resolve();
      }, ms);
      t.unref?.();
      backfillWake = () => {
        clearTimeout(t);
        backfillWake = null;
        resolve();
      };
    });
  const backfillRetryBaseMs = opts.backfillRetryMs ?? 60_000;
  const backfillTask: Promise<void> = (async () => {
    if (!config.embedding) return;
    try {
      const initial = countChunksWithoutEmbeddings(db);
      if (initial > 0) {
        logger.info(`iapeer-memory: background embed backfill — ${initial} chunk(s) pending`);
      }
      // RETRY LOOP (audit important: the one-shot pass died on the first
      // endpoint failure — memoryd racing TEI up after a reboot left the
      // whole vault BM25-only until the next vault edit, while the log said
      // «backfill complete»). Exponential backoff, base ≥ the breaker
      // cooldown so a retry never lands inside circuit-open for nothing;
      // the sleep is cancellable — close() wakes it and the loop exits on
      // backfillStopping.
      let backoffMs = backfillRetryBaseMs;
      while (!backfillStopping) {
        await embedMissingChunks({ db, config, logger, shouldStop: () => backfillStopping });
        if (backfillStopping) break;
        const remaining = countChunksWithoutEmbeddings(db);
        if (remaining === 0) {
          if (db.vecAvailable) {
            await backfillVecChunks(db, 200, () => backfillStopping);
          }
          if (initial > 0) {
            // «complete» ONLY when the queue is actually empty — the old
            // unconditional line masked a 0-of-N failure as success.
            logger.info("iapeer-memory: background embed backfill complete");
          }
          break;
        }
        logger.warn(
          `iapeer-memory: embed backfill stalled — ${remaining} chunk(s) still pending, retry in ${Math.round(backoffMs / 1000)}s`,
        );
        await backfillSleep(backoffMs);
        backoffMs = Math.min(backoffMs * 5, 15 * 60_000);
      }
    } catch (err) {
      logger.error(`iapeer-memory: background embed backfill failed: ${String(err)}`);
    } finally {
      // From here on the global NULL-embedding queue has a single owner
      // again — flush embeds its changed notes inline as before.
      backfillActive = false;
    }
  })();
  backfillTask.catch(() => {}); // unhandled-rejection guard (errors handled within)

  logger.info(
    `memoryd up: vault=${config.vaultPath}, watch=${watcher ? "on" : "OFF"}, mcp=${mcp ? mcp.port : "disabled"}`,
  );

  return {
    mcpPort: mcp?.port ?? null,
    runCuratorTick,
    runDetectPass: async () => {
      if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = null;
      }
      // Serialize through the SAME chain schedule() uses (audit cosmetic): a
      // bare `await flush()` here could interleave with a debounce-timer
      // flush armed during the await — two indexAll runs racing on their
      // await boundaries. FULL pass: the hook's contract is «force one
      // complete detect pass» — tests and operators call it without knowing
      // what fs.watch delivered.
      flushing = flushing.then(() => flush(true)).catch((err) => {
        logger.error(`detect-pass flush failed: ${String(err)}`);
      });
      await flushing;
    },
    close: async () => {
      shuttingDown = true; // shutdown flush is structural-only (embed:false)
      watcher?.close();
      if (pollTimer) clearInterval(pollTimer);
      backfillStopping = true; // bail the background embed loop at its next batch
      backfillWake?.(); // …and never wait out a retry-backoff window
      await backfillTask; // batches are atomic — await ensures no torn write
      if (flushTimer) clearTimeout(flushTimer);
      if (retryTimer) clearTimeout(retryTimer);
      clearInterval(heartbeatTimer);
      if (curatorTimer) clearTimeout(curatorTimer);
      clearInterval(persistTimer);
      // Shutdown flush — the handle contract always promised it, close()
      // never ran it (audit important): a SIGTERM inside the debounce window
      // (the typical update flow: a burst of edits, then restart a second
      // later) must not drop the pending set — the detect belts run only off
      // it, and the notes would go unjudged until the NEXT touch.
      if (pending.size > 0) {
        flushing = flushing.then(() => flush()).catch((err) => {
          logger.error(`shutdown flush failed: ${String(err)}`);
        });
      }
      await flushing;
      persistQuiet();
      // Batch state (silentStamps + the permanent baseline) also persists on
      // shutdown — otherwise silentStamps moved since the last curator tick are
      // lost, breaking the "survives restarts" invariant (first-sight warm-up
      // would then re-skip a real edit after a graceful restart).
      persistBatches();
      if (mcp) await mcp.close();
      try {
        guardedUnlinkSync(heartbeatPath);
      } catch {
        // best effort
      }
      db.close();
      releaseLock();
    },
  };
}
