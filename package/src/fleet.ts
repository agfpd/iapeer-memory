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
import crypto from "node:crypto";
import { IAPEER_BIN, type Egress } from "./egress.js";
import { guardedWriteFileSync, sandboxBlocksProdRead, guardedRenameSync } from "@agfpd/iapeer-memory-core";

export type FleetMapResult = {
  action: "written" | "failed";
  count: number;
  detail: string;
};

type ListedPeer = {
  personality?: unknown;
  cwd?: unknown;
  description?: unknown;
  /** iapeer registry: `[{runtime: "claude"|"codex"|…, status}]`. */
  runtimes?: Array<{ runtime?: unknown }>;
};

/** Fleet-map entry. `runtimes` (ADR-009 v1.2) names the peer's session
 *  runtimes from the registry — the surfaces sweep keys its per-runtime
 *  forms on it (claude: hooks+mcp+skills; codex: project-local MCP).
 *  Core's memoryd reader takes personality/cwd only — additive, fail-open. */
export type FleetPeer = { personality: string; cwd: string; runtimes: string[] };

/** queryRegistry's richer row: the registry `description` rides along for
 *  registry-facing checks (verify's role-descriptions). NOT persisted into
 *  the fleet map — the map stays the lean personality→cwd(+runtimes) joint. */
export type RegistryPeer = FleetPeer & { description: string };

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
): { peers: RegistryPeer[] } | { error: string } {
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
        description: typeof p.description === "string" ? p.description.trim() : "",
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
  // Persist the LEAN map form — description is a registry-facing extra
  // (verify's role-descriptions check), not part of the map contract.
  const peers: FleetPeer[] = q.peers.map(({ personality, cwd, runtimes }) => ({
    personality,
    cwd,
    runtimes,
  }));

  const body =
    JSON.stringify(
      { updatedAt: opts.nowIso ?? new Date().toISOString(), peers },
      null,
      2,
    ) + "\n";
  fs.mkdirSync(path.dirname(opts.fleetMapPath), { recursive: true });
  // UNIQUE tmp name (audit important): two concurrent writers over a shared
  // `.tmp` interleaved O_TRUNC + rename — a torn fleet.json (memoryd reads
  // it fail-open → fragment rendering silently OFF) or an ENOENT crash of
  // the losing writer. Same pattern as core atomicWrite.
  const tmp = `${opts.fleetMapPath}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  guardedWriteFileSync(tmp, body, "utf-8");
  guardedRenameSync(tmp, opts.fleetMapPath); // atomic — memoryd may race a read
  return {
    action: "written",
    count: peers.length,
    detail: `${peers.length} peer(s) → ${opts.fleetMapPath}`,
  };
}

/**
 * The core-owned runtime-private directory of a peer endpoint (iapeer
 * docs/15 + docs/20: `iapeer private-dir <p> --runtime <r>`). Consumers the
 * core does not launch — sweep, verify, the weekly collector — get the path
 * HERE and never derive the layout from the root. Failure is loud: an older
 * core without the verb, an unregistered peer or an undeclared runtime all
 * come back as `{ error }`, never as a guessed path.
 */
export function queryPrivateDir(
  egress: Egress,
  personality: string,
  opts: { runtime?: string; iapeerBin?: string } = {},
): { dir: string } | { error: string } {
  const bin = opts.iapeerBin ?? IAPEER_BIN;
  const proc = egress.spawnSync([bin, "private-dir", personality, "--runtime", opts.runtime ?? "opencode"], {
    explicitBin: opts.iapeerBin !== undefined,
  });
  if (proc.refused) return { error: "core private-dir query suppressed (test sandbox) — pass a fake iapeerBin" };
  if (proc.spawnError) return { error: `${bin} unavailable: ${proc.spawnError}` };
  if (proc.exitCode !== 0) {
    const why = proc.stderr.trim().split("\n")[0] || `exit ${proc.exitCode}`;
    return { error: `core did not answer private-dir for ${personality}: ${why}`.slice(0, 240) };
  }
  const dir = proc.stdout.trim();
  if (!dir.startsWith("/") || dir.includes("\n")) {
    return { error: `core private-dir for ${personality}: not an absolute path (${JSON.stringify(dir.slice(0, 80))})` };
  }
  return { dir };
}

/**
 * Single-entry fleet-map edit for the slot verbs (birth / remove). memoryd
 * re-renders per-peer fragments on a fleet.json mtime change — and birth did
 * not touch the map (only init/update/verify --repair re-wrote it), so a
 * peer born after memoryd's start got NO fragment/index until the next
 * update (OC09, 18.10.2026; any runtime). `add` merges the runtime into the
 * entry (creating it, or the map); `remove` drops the runtime and the entry
 * once it has none. No-op when nothing changes (no mtime churn → no
 * re-render storm). A present-but-unreadable map is never clobbered.
 */
export function editFleetEntry(
  fleetMapPath: string,
  op: "add" | "remove",
  peer: { personality: string; cwd: string; runtime: string },
): { action: "written" | "unchanged" | "skipped"; detail: string } {
  if (sandboxBlocksProdRead(fleetMapPath)) {
    return { action: "skipped", detail: "live fleet map not touched under the test sandbox" };
  }
  let doc: { updatedAt?: string; peers: Array<Record<string, unknown>> };
  if (fs.existsSync(fleetMapPath)) {
    try {
      const raw = JSON.parse(fs.readFileSync(fleetMapPath, "utf-8"));
      if (!raw || !Array.isArray(raw.peers)) throw new Error("no peers array");
      doc = raw;
    } catch (err) {
      return { action: "skipped", detail: `fleet map unreadable (${String(err)}) — not clobbered; repair: iapeer-memory verify --repair` };
    }
  } else {
    if (op === "remove") return { action: "unchanged", detail: "no fleet map" };
    doc = { peers: [] };
  }
  const before = JSON.stringify(doc.peers);
  const idx = doc.peers.findIndex((p) => p.personality === peer.personality);
  if (op === "add") {
    const prev = idx >= 0 ? doc.peers[idx]! : null;
    const runtimes = Array.isArray(prev?.runtimes) ? (prev!.runtimes as unknown[]).filter((r): r is string => typeof r === "string") : [];
    const entry = { ...(prev ?? {}), personality: peer.personality, cwd: peer.cwd, runtimes: runtimes.includes(peer.runtime) ? runtimes : [...runtimes, peer.runtime] };
    if (idx >= 0) doc.peers[idx] = entry; else doc.peers.push(entry);
  } else if (idx >= 0) {
    const prev = doc.peers[idx]!;
    const runtimes = (Array.isArray(prev.runtimes) ? (prev.runtimes as unknown[]) : []).filter((r) => r !== peer.runtime);
    if (runtimes.length) doc.peers[idx] = { ...prev, runtimes }; else doc.peers.splice(idx, 1);
  }
  if (JSON.stringify(doc.peers) === before) return { action: "unchanged", detail: "fleet map already current" };
  doc.updatedAt = new Date().toISOString();
  fs.mkdirSync(path.dirname(fleetMapPath), { recursive: true });
  const tmp = `${fleetMapPath}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  guardedWriteFileSync(tmp, JSON.stringify(doc, null, 2) + "\n", "utf-8");
  guardedRenameSync(tmp, fleetMapPath);
  return { action: "written", detail: `${op} ${peer.personality}:${peer.runtime} → ${fleetMapPath}` };
}
