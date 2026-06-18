/**
 * Fleet map — the personality → cwd joint between the package (ecosystem
 * knowledge, ADR-009) and core memoryd's per-peer fragment renderer
 * (docs/05). Written from `iapeer list --json` (the registry cwd is the
 * FACT — iapeer 0.2.14); memoryd reads it fail-open and re-checks the
 * mtime on every heartbeat tick, so the self-healing loop is:
 * new peer wakes → SessionStart kick → `verify --repair` re-writes the
 * map → memoryd renders the newcomer's fragment within a tick.
 *
 * READ-AS-EGRESS (the FOURTH of its class — first FILE-path
 * one): `iapeer list` is read-only, but its RESULT is the target list of the
 * surfaces sweep — a sandboxed `verify --repair` with no fleet map repaired
 * the map from the LIVE registry and then swept the LIVE peers' cwds with
 * direct surfaces (the send-fuse never saw it: no IAP send involved).
 * Querying the live registry from a test IS the leak — the query now goes
 * through the egress handle (deny-by-default §4 П5): a refusing handle
 * blocks the default binary; tests pass a fake `iapeerBin` (explicit-bin
 * allowance) or write the map file directly.
 */

import fs from "node:fs";
import path from "node:path";
import { IAPEER_BIN, type Egress } from "./egress.js";
import { guardedWriteFileSync, sandboxBlocksProdRead } from "@agfpd/iapeer-memory-core";

export type FleetMapResult = {
  action: "written" | "failed";
  count: number;
  detail: string;
};

type ListedPeer = {
  personality?: unknown;
  cwd?: unknown;
  /** iapeer registry: `[{runtime: "claude"|"codex"|…, status}]`. */
  runtimes?: Array<{ runtime?: unknown }>;
};

/** Fleet-map entry. `runtimes` (ADR-009 v1.2) names the peer's session
 *  runtimes from the registry — the surfaces sweep keys its per-runtime
 *  forms on it (claude: hooks+mcp+skills; codex: project-local MCP).
 *  Core's memoryd reader takes personality/cwd only — additive, fail-open. */
export type FleetPeer = { personality: string; cwd: string; runtimes: string[] };

/** Fail-open fleet-map reader (the package side: the surfaces sweep and
 *  verify's per-peer checks). Missing/unreadable map → null — callers report
 *  honestly instead of guessing the fleet. Entries without a runtimes array
 *  (pre-v1.2 maps) read as `runtimes: []` — the sweep skips them until the
 *  next map re-write (init/update/verify --repair). */
export function readFleetMap(fleetMapPath: string): FleetPeer[] | null {
  // Read-as-egress (И4 parity): the prod fleet map NAMES live cwds — a
  // sandboxed process must not learn them. Null = «map unreadable», every
  // caller already reports that honestly instead of sweeping.
  if (sandboxBlocksProdRead(fleetMapPath)) {
    console.error(
      `iapeer-memory: live fleet map skipped under the test sandbox (${fleetMapPath}) — set IAPEER_MEMORY_STATE_DIR/IAPEER_ROOT`,
    );
    return null;
  }
  try {
    const raw = JSON.parse(fs.readFileSync(fleetMapPath, "utf-8")) as {
      peers?: Array<{ personality?: unknown; cwd?: unknown; runtimes?: unknown }>;
    };
    if (!Array.isArray(raw?.peers)) return null;
    return raw.peers
      .filter(
        (p): p is { personality: string; cwd: string; runtimes?: unknown } =>
          typeof p?.personality === "string" && typeof p?.cwd === "string",
      )
      .map((p) => ({
        personality: p.personality,
        cwd: p.cwd,
        runtimes: Array.isArray(p.runtimes)
          ? p.runtimes.filter((r): r is string => typeof r === "string")
          : [],
      }));
  } catch {
    return null;
  }
}

/** Live-registry query — the ONE place `iapeer list --json` is parsed.
 *  Shared by writeFleetMap (the persisted map) and dream-collect (the
 *  tick-time resolution; freshness fact: birth does NOT touch fleet.json
 *  and the SessionStart kick is heartbeat-gated, so the LIVE registry is
 *  the only source that sees a newborn before the next update). */
export function queryRegistry(
  egress: Egress,
  opts: { iapeerBin?: string },
): { peers: FleetPeer[] } | { error: string } {
  const bin = opts.iapeerBin ?? IAPEER_BIN;
  const proc = egress.spawnSync([bin, "list", "--json"], {
    explicitBin: opts.iapeerBin !== undefined,
  });
  if (proc.refused) {
    return { error: "live-registry query suppressed (test sandbox) — pass a fake iapeerBin" };
  }
  if (proc.spawnError) {
    return { error: `${bin} unavailable: ${proc.spawnError}` };
  }
  if (proc.exitCode !== 0) {
    return { error: (proc.stderr.trim() || `iapeer list exited ${proc.exitCode}`).slice(0, 160) };
  }
  let listed: ListedPeer[];
  try {
    const raw = JSON.parse(proc.stdout) as unknown;
    listed = Array.isArray(raw) ? (raw as ListedPeer[]) : [];
  } catch {
    return { error: "iapeer list --json: unparsable output" };
  }
  return {
    peers: listed
      .filter(
        (p): p is ListedPeer & { personality: string; cwd: string } =>
          typeof p.personality === "string" &&
          p.personality.trim() !== "" &&
          typeof p.cwd === "string" &&
          p.cwd.trim() !== "",
      )
      .map((p) => ({
        personality: p.personality.trim(),
        cwd: p.cwd.trim(),
        runtimes: [
          ...new Set(
            (Array.isArray(p.runtimes) ? p.runtimes : [])
              .map((r) => (typeof r?.runtime === "string" ? r.runtime.trim() : ""))
              .filter(Boolean),
          ),
        ],
      })),
  };
}

export function writeFleetMap(
  egress: Egress,
  opts: {
    fleetMapPath: string;
    iapeerBin?: string;
    /** Injectable for tests. */
    nowIso?: string;
  },
): FleetMapResult {
  const q = queryRegistry(egress, { iapeerBin: opts.iapeerBin });
  if ("error" in q) {
    return { action: "failed", count: 0, detail: q.error };
  }
  const peers = q.peers;

  const body =
    JSON.stringify(
      { updatedAt: opts.nowIso ?? new Date().toISOString(), peers },
      null,
      2,
    ) + "\n";
  fs.mkdirSync(path.dirname(opts.fleetMapPath), { recursive: true });
  const tmp = `${opts.fleetMapPath}.tmp`;
  guardedWriteFileSync(tmp, body, "utf-8");
  fs.renameSync(tmp, opts.fleetMapPath); // atomic — memoryd may race a read
  return {
    action: "written",
    count: peers.length,
    detail: `${peers.length} peer(s) → ${opts.fleetMapPath}`,
  };
}
