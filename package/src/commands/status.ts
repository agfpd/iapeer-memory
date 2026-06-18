/**
 * `iapeer-memory status` — read-only diagnostics of the whole chain
 * (ADR-009: the status surface must diagnose a socket without a system).
 * Aggregates: verify checks (NO repair) + slot declaration + a live TCP
 * probe of the MCP endpoint. Never mutates anything;
 * exit 1 when something needs attention.
 */

import fs from "node:fs";
import path from "node:path";
import {
  ensureLoopbackNotProxied,
  getTaxonomy,
  isLocaleId,
  prepareSqliteRuntime,
} from "@agfpd/iapeer-memory-core";
import type { Egress } from "../egress.js";
import { memoryPaths } from "../paths.js";
import { readSlot } from "../slot.js";
import { packageVersion } from "../version.js";
import { runVerify } from "./verify.js";

/**
 * The search-pipeline line — VISIBLE degradation is an acceptance condition
 * (P3a): a host configured for vector search that silently falls
 * back must say so here and why.
 *
 * Source of truth ladder: (1) the LIVE pipeline as reported by the running
 * memoryd (a real memory_search call over MCP — per-component statuses, the
 * same object every search returns); (2) when memoryd is down — the static
 * configuration view + the sqlite runtime probe. P3c live-smoke fact: in
 * the compiled binary the sqlite-vec dylib does not resolve from /$bunfs —
 * memoryd logs it once and vector search continues BRUTE-FORCE (semantics
 * intact, slower on large vaults); the live pipeline still says
 * embedding: ok, which is the truthful state.
 */
export function searchPipelineLine(env: Record<string, string | undefined>): string {
  const embeddingConfigured = Boolean(env.IAPEER_MEMORY_EMBEDDING_ENDPOINT);
  const rerankerConfigured = Boolean(env.IAPEER_MEMORY_RERANKER_ENDPOINT);
  if (!embeddingConfigured) {
    return "BM25-only (no embedding endpoint configured — a valid zero-config state)";
  }
  const vec = prepareSqliteRuntime();
  return (
    `hybrid configured: BM25 + embeddings${rerankerConfigured ? " + reranker" : ""}; ` +
    (vec.available
      ? `vec index runtime ok (${vec.dylibPath})`
      : `vec index unavailable (${vec.reason}) — vector search runs brute-force`)
  );
}

/** Live pipeline from the running memoryd — the same per-component statuses
 * every memory_search returns. Null when memoryd is unreachable. */
export async function probeSearchPipeline(
  egress: Egress,
  port: number,
): Promise<string | null> {
  ensureLoopbackNotProxied(); // fleet-class: proxy-env lies about live loopback ports
  try {
    const res = await egress.fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "X-IAPeer-Identity": "claude-status-probe",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "memory_search", arguments: { query: "status probe" } },
      }),
      signal: AbortSignal.timeout(8000),
    });
    const text = await res.text();
    // streamable-http frames the JSON as an SSE `data:` line
    const dataLine = text.split("\n").find((l) => l.startsWith("data:"));
    const payload = JSON.parse(dataLine ? dataLine.slice(5) : text) as {
      result?: { structuredContent?: { pipeline?: Record<string, unknown> } };
    };
    const pipeline = payload.result?.structuredContent?.pipeline;
    if (!pipeline) return null;
    const parts = ["bm25", "embedding", "reranker", "graph"]
      .filter((k) => k in pipeline)
      .map((k) => `${k}: ${String(pipeline[k])}`);
    return `live pipeline — ${parts.join(", ")}`;
  } catch {
    return null;
  }
}

async function probeMcp(
  egress: Egress,
  port: number,
): Promise<{ line: string; alive: boolean }> {
  ensureLoopbackNotProxied(); // fleet-class: proxy-env lies about live loopback ports
  try {
    const res = await egress.fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
      signal: AbortSignal.timeout(1500),
    });
    // ANY http response means memoryd is listening (a real MCP handshake
    // needs a session — this is a liveness probe, not a protocol check).
    return { line: `listening on ${port} (http ${res.status})`, alive: true };
  } catch {
    return { line: `nothing listening on ${port}`, alive: false };
  }
}

export async function cmdStatus(argv: string[], egress: Egress): Promise<number> {
  if (argv.length) {
    console.error(`iapeer-memory status: unknown flag: ${argv[0]}`);
    return 2;
  }
  const paths = memoryPaths();
  const version = packageVersion();
  console.log(`iapeer-memory v${version}`);

  const results = runVerify(egress, { repair: false });
  const width = Math.max(...results.map((r) => r.name.length), 12);
  for (const r of results) {
    const mark =
      r.status === "ok" ? "ok  " : r.status === "skip" ? "skip" : "FAIL";
    console.log(`${mark}  ${r.name.padEnd(width)}  ${r.detail}`);
  }

  const slot = readSlot(paths.slotPath);
  console.log(
    `      ${"slot-file".padEnd(width)}  ` +
      (slot
        ? `${slot.provider} v${slot.version} (registered ${slot.registeredAt})`
        : "empty"),
  );

  const port = Number(process.env.IAPEER_MEMORY_MCP_PORT || "") || 8766;
  const mcp = await probeMcp(egress, port);
  console.log(`      ${"mcp-endpoint".padEnd(width)}  ${mcp.line}`);
  // The live pipeline is only probed when the endpoint is alive — a dead
  // port already told us everything (and the static view says the rest).
  const livePipeline = mcp.alive ? await probeSearchPipeline(egress, port) : null;
  console.log(
    `      ${"search".padEnd(width)}  ` +
      (livePipeline ?? `${searchPipelineLine(process.env)} (memoryd down — static view)`),
  );

  return results.some((r) => r.status === "fail") ? 1 : 0;
}
