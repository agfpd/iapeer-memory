/**
 * Fleet-wide surfaces sweep — the package's own rail over fleet.json
 * (ADR-009 v1.2). The core's birth-hook covers NEWBORNS via the slot's
 * provision command; everything fleet-wide (init coverage of the existing
 * fleet, update's «всё на местах» duty, verify --repair self-healing) walks
 * the fleet map HERE — peer × session-runtime, claude and codex forms.
 *
 * Session runtimes are exactly {claude, codex}: telegram/notifier and other
 * infra runtimes carry no session config surfaces. A peer entry without a
 * runtimes array (pre-v1.2 map) is SKIPPED and reported — the next map
 * re-write (same command) picks it up.
 *
 * The caller holds the provision lock around the WHOLE sweep (one
 * acquisition, not per-peer — the sweep body is pure file I/O).
 */

import { queryPrivateDir } from "../fleet.js";
import fs from "node:fs";
import {
  checkClaudePeer,
  provisionClaudePeer,
  unprovisionClaudePeer,
  type SurfaceOutcome,
} from "./claude.js";
import { checkCodexPeer, provisionCodexPeer, unprovisionCodexPeer } from "./codex.js";
import { checkOpenCodePeer, provisionOpenCodePeer, unprovisionOpenCodePeer } from "./opencode.js";
import type { Egress } from "../egress.js";
import type { FleetPeer } from "../fleet.js";

export const SESSION_RUNTIMES = ["claude", "codex", "opencode"] as const;
export type SessionRuntime = (typeof SESSION_RUNTIMES)[number];

export type PeerSweepResult = {
  personality: string;
  runtime: SessionRuntime;
  cwd: string;
  /** worst action across the peer-runtime's surfaces */
  ok: boolean;
  outcomes: SurfaceOutcome[];
};

export type SweepSummary = {
  results: PeerSweepResult[];
  /** peers skipped: no session runtimes in the map entry / vanished cwd */
  skipped: Array<{ personality: string; reason: string }>;
};

/** OpenCode surfaces live in the core-owned private dir — asked from the
 *  core per peer; an unanswered query is a loud failed outcome, never a
 *  guessed path. */
function withPrivateDir(
  egress: Egress,
  personality: string,
  iapeerBin: string | undefined,
  surface: SurfaceOutcome["surface"],
  fn: (privateDir: string) => SurfaceOutcome[],
): SurfaceOutcome[] {
  const q = queryPrivateDir(egress, personality, { runtime: "opencode", iapeerBin });
  return "dir" in q ? fn(q.dir) : [{ surface, action: "failed", path: "(core private-dir)", detail: q.error }];
}

function sessionRuntimesOf(peer: FleetPeer): SessionRuntime[] {
  return SESSION_RUNTIMES.filter((r) => peer.runtimes.includes(r));
}

export function sweepProvision(
  egress: Egress,
  opts: {
    fleet: FleetPeer[];
    hooksDir: string;
    port: number;
    iapeerBin?: string;
  },
): SweepSummary {
  const results: PeerSweepResult[] = [];
  const skipped: SweepSummary["skipped"] = [];
  for (const peer of opts.fleet) {
    const runtimes = sessionRuntimesOf(peer);
    if (runtimes.length === 0) {
      skipped.push({
        personality: peer.personality,
        reason: peer.runtimes.length
          ? `no session runtime (${peer.runtimes.join(",")})`
          : "no runtimes in fleet map (pre-v1.2 entry) — re-write the map",
      });
      continue;
    }
    if (!fs.existsSync(peer.cwd)) {
      skipped.push({ personality: peer.personality, reason: `cwd missing: ${peer.cwd}` });
      continue;
    }
    for (const runtime of runtimes) {
      const outcomes =
        runtime === "opencode"
          ? withPrivateDir(egress, peer.personality, opts.iapeerBin, "hooks",
              (privateDir) => provisionOpenCodePeer({ personality: peer.personality, port: opts.port, privateDir }))
          : runtime === "codex"
          ? provisionCodexPeer(egress, {
              cwd: peer.cwd,
              port: opts.port,
              hooksDir: opts.hooksDir,
              iapeerBin: opts.iapeerBin,
            })
          : provisionClaudePeer({
              cwd: peer.cwd,
              hooksDir: opts.hooksDir,
              port: opts.port,
              personality: peer.personality,
            });
      results.push({
        personality: peer.personality,
        runtime,
        cwd: peer.cwd,
        ok: outcomes.every((o) => o.action !== "failed"),
        outcomes,
      });
    }
  }
  return { results, skipped };
}

export function sweepUnprovision(egress: Egress, opts: { fleet: FleetPeer[]; iapeerBin?: string }): SweepSummary {
  const results: PeerSweepResult[] = [];
  const skipped: SweepSummary["skipped"] = [];
  for (const peer of opts.fleet) {
    const runtimes = sessionRuntimesOf(peer);
    if (runtimes.length === 0) {
      skipped.push({ personality: peer.personality, reason: "no session runtime" });
      continue;
    }
    // a vanished cwd is fine on the off-path — surfaces report `absent`
    for (const runtime of runtimes) {
      const outcomes =
        runtime === "opencode"
          ? withPrivateDir(egress, peer.personality, opts.iapeerBin, "hooks",
              (privateDir) => unprovisionOpenCodePeer({ personality: peer.personality, privateDir }))
          : runtime === "codex"
          ? unprovisionCodexPeer({ cwd: peer.cwd })
          : unprovisionClaudePeer({ cwd: peer.cwd });
      results.push({
        personality: peer.personality,
        runtime,
        cwd: peer.cwd,
        ok: outcomes.every((o) => o.action !== "failed"),
        outcomes,
      });
    }
  }
  return { results, skipped };
}

export type PeerCheckResult = {
  personality: string;
  runtime: SessionRuntime;
  cwd: string;
  ok: boolean;
  problems: string[];
};

export function checkFleetSurfaces(
  egress: Egress,
  opts: {
    fleet: FleetPeer[];
    hooksDir: string;
    port: number;
    iapeerBin?: string;
  },
): { checks: PeerCheckResult[]; skipped: Array<{ personality: string; reason: string }> } {
  const checks: PeerCheckResult[] = [];
  const skipped: Array<{ personality: string; reason: string }> = [];
  for (const peer of opts.fleet) {
    const runtimes = sessionRuntimesOf(peer);
    if (runtimes.length === 0) {
      skipped.push({
        personality: peer.personality,
        reason: peer.runtimes.length
          ? `no session runtime (${peer.runtimes.join(",")})`
          : "no runtimes in fleet map (pre-v1.2 entry)",
      });
      continue;
    }
    if (!fs.existsSync(peer.cwd)) {
      skipped.push({ personality: peer.personality, reason: `cwd missing: ${peer.cwd}` });
      continue;
    }
    for (const runtime of runtimes) {
      const surfaceChecks =
        runtime === "opencode"
          ? (() => {
              const q = queryPrivateDir(egress, peer.personality, { runtime: "opencode", iapeerBin: opts.iapeerBin });
              return "dir" in q
                ? checkOpenCodePeer({ personality: peer.personality, port: opts.port, privateDir: q.dir })
                : [{ surface: "hooks" as const, ok: false, detail: q.error }];
            })()
          : runtime === "codex"
          ? checkCodexPeer(egress, {
              cwd: peer.cwd,
              port: opts.port,
              hooksDir: opts.hooksDir,
              iapeerBin: opts.iapeerBin,
            })
          : checkClaudePeer({
              cwd: peer.cwd,
              hooksDir: opts.hooksDir,
              port: opts.port,
              personality: peer.personality,
            });
      checks.push({
        personality: peer.personality,
        runtime,
        cwd: peer.cwd,
        ok: surfaceChecks.every((c) => c.ok),
        problems: surfaceChecks.filter((c) => !c.ok).map((c) => `${c.surface}: ${c.detail}`),
      });
    }
  }
  return { checks, skipped };
}
