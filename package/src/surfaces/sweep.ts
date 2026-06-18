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

import fs from "node:fs";
import {
  checkClaudePeer,
  provisionClaudePeer,
  unprovisionClaudePeer,
  type SurfaceOutcome,
} from "./claude.js";
import { checkCodexPeer, provisionCodexPeer, unprovisionCodexPeer } from "./codex.js";
import type { Egress } from "../egress.js";
import type { FleetPeer } from "../fleet.js";

export const SESSION_RUNTIMES = ["claude", "codex"] as const;
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
        runtime === "codex"
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

export function sweepUnprovision(opts: { fleet: FleetPeer[] }): SweepSummary {
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
        runtime === "codex"
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
        runtime === "codex"
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
