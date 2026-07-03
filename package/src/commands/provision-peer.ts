/**
 * `iapeer-memory provision-peer|unprovision-peer --cwd <abs> --runtime <r>
 * --personality <p> [--occasion <o>]` — the provider half of the iapeer
 * v1.2 slot contract
 * (ADR-009 v1.2: direct per-peer surfaces; the core shells into THIS command
 * at peer birth/sweeps and never learns the surface forms).
 *
 * Contract obligations (§7, agreed with the iapeer core):
 *   - argv form, absolute paths, no shell — the core spawns us directly;
 *   - IDEMPOTENT: re-running repairs, never corrupts (every surface is a
 *     read-merge-write of our own keys only, atomic);
 *   - tolerant of PARALLEL calls — the host-wide provision lock serialises
 *     bodies (lock.ts);
 *   - {occasion} dictionary: birth | sweep-on | off-peer | off-all | remove.
 *     We have NO host-global surfaces (требование №3 «глобально не
 *     класть» — even the codex MCP form is project-local), so the ref-count
 *     distinction off-peer vs off-all is moot here: every occasion of the
 *     un-verb means «strip this peer's surfaces». Validated, logged, not
 *     branched on.
 *
 * Runtime forms: claude — hooks + mcp + skills (surfaces/claude.ts);
 * codex — per-peer MCP via `<cwd>/.codex/config.toml` + hooks.json with the
 * core's trust-hooks pre-seed (surfaces/codex.ts, Ш2; skills deliberately
 * not delivered — P5 §4.2). Exit: 0 ok, 1 a surface failed, 2 usage.
 */

import fs from "node:fs";
import type { Egress } from "../egress.js";
import { memoryPaths } from "../paths.js";
import {
  provisionClaudePeer,
  unprovisionClaudePeer,
  type SurfaceOutcome,
} from "../surfaces/claude.js";
import { provisionCodexPeer, unprovisionCodexPeer } from "../surfaces/codex.js";
import { withProvisionLock, pidAliveProbe } from "../surfaces/lock.js";
import { paintStatus, ui } from "../ui.js";

/** The memoryd MCP port FACT of this host (config.env is already loaded into
 *  the process env by the CLI boot) — baked literally into both MCP surface
 *  forms (no env substitution in either, D2 decision). Shared by the verbs
 *  here and the fleet sweeps in init/update/verify. Same resolution as
 *  status.ts. */
export function mcpPort(): number {
  return Number(process.env.IAPEER_MEMORY_MCP_PORT || "") || 8766;
}

export const OCCASIONS = ["birth", "sweep-on", "off-peer", "off-all", "remove"] as const;
export type Occasion = (typeof OCCASIONS)[number];

const RUNTIMES = ["claude", "codex"] as const;

type Flags = {
  cwd: string;
  runtime: (typeof RUNTIMES)[number];
  occasion: Occasion;
  personality: string;
  /** Explicitly named core binary (hermetic tests; egress explicit-bin). */
  iapeerBin?: string;
};

function parseFlags(
  verb: "provision-peer" | "unprovision-peer",
  argv: string[],
  defaultOccasion: Occasion,
): Flags | null {
  let cwd = "";
  let runtime = "";
  let occasion: string = defaultOccasion;
  let personality = "";
  let iapeerBin: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--cwd": cwd = argv[++i] ?? ""; break;
      case "--runtime": runtime = argv[++i] ?? ""; break;
      case "--occasion": occasion = argv[++i] ?? ""; break;
      case "--personality": personality = argv[++i] ?? ""; break;
      case "--iapeer-bin": iapeerBin = argv[++i]; break;
      default:
        console.error(`iapeer-memory ${verb}: unknown flag: ${a}`);
        return null;
    }
  }
  if (!cwd || !cwd.startsWith("/")) {
    console.error(`iapeer-memory ${verb}: --cwd must be an absolute path (got "${cwd}")`);
    return null;
  }
  if (!(RUNTIMES as readonly string[]).includes(runtime)) {
    console.error(`iapeer-memory ${verb}: --runtime must be one of ${RUNTIMES.join("|")} (got "${runtime}")`);
    return null;
  }
  if (!(OCCASIONS as readonly string[]).includes(occasion)) {
    console.error(`iapeer-memory ${verb}: --occasion must be one of ${OCCASIONS.join("|")} (got "${occasion}")`);
    return null;
  }
  // claude provision bakes the LITERAL identity header (battle form of the
  // core's own .mcp.json) — without the personality there is nothing honest
  // to bake. The core's executor supports the {personality} placeholder
  // the package sweep reads it from fleet.json. The un-verb
  // needs no identity: removal matches our key/marks, not the header value.
  if (verb === "provision-peer" && runtime === "claude" && !personality) {
    console.error(
      "iapeer-memory provision-peer: --personality is required for --runtime claude " +
        "(the literal MCP identity header is baked at provision time)",
    );
    return null;
  }
  return {
    cwd,
    runtime: runtime as Flags["runtime"],
    occasion: occasion as Occasion,
    personality,
    iapeerBin,
  };
}

function report(verb: string, flags: Flags, outcomes: SurfaceOutcome[]): number {
  let failed = false;
  for (const o of outcomes) {
    const ok = o.action !== "failed";
    if (!ok) failed = true;
    const token = paintStatus(ok ? "ok" : "fail", ok ? "ok  " : "FAIL");
    console.log(
      `${token}  ${o.surface.padEnd(7)} ${o.action}${o.detail ? ` — ${o.detail}` : ""} ${ui.dim(`(${o.path})`)}`,
    );
  }
  console.log(
    `${verb}: ${flags.runtime} peer at ${flags.cwd} (occasion: ${flags.occasion})` +
      (failed ? " — FAILED; re-run is the repair path (idempotent)" : "") +
      "\npickup: surfaces apply on the peer's NEXT session start (live sessions do not re-read them)",
  );
  return failed ? 1 : 0;
}

export function cmdProvisionPeer(argv: string[], egress: Egress): number {
  const flags = parseFlags("provision-peer", argv, "sweep-on");
  if (!flags) return 2;
  if (!fs.existsSync(flags.cwd)) {
    console.error(`iapeer-memory provision-peer: cwd does not exist: ${flags.cwd}`);
    return 1;
  }
  const paths = memoryPaths();
  const locked = withProvisionLock({
        pidAlive: pidAliveProbe(egress),
    stateDir: paths.stateDir,
    fn: () =>
      flags.runtime === "codex"
        ? provisionCodexPeer(egress, {
            cwd: flags.cwd,
            port: mcpPort(),
            hooksDir: paths.hooksDir,
            iapeerBin: flags.iapeerBin,
          })
        : provisionClaudePeer({
            cwd: flags.cwd,
            hooksDir: paths.hooksDir,
            port: mcpPort(),
            personality: flags.personality,
          }),
  });
  if (!locked.acquired) {
    console.error(`iapeer-memory provision-peer: ${locked.detail}`);
    return 1;
  }
  return report("provision-peer", flags, locked.result);
}

export function cmdUnprovisionPeer(argv: string[]): number {
  const flags = parseFlags("unprovision-peer", argv, "off-peer");
  if (!flags) return 2;
  // a vanished cwd is a VALID un-provision target (occasion=remove races the
  // peer directory removal) — every surface simply reports `absent`
  const paths = memoryPaths();
  const locked = withProvisionLock({
    // no egress in the unprovision entry — tokenless/dead-owner locks still
    // self-break by age; a token'd LIVE lock is honoured (waits/refuses).
    stateDir: paths.stateDir,
    fn: () =>
      flags.runtime === "codex"
        ? unprovisionCodexPeer({ cwd: flags.cwd })
        : unprovisionClaudePeer({ cwd: flags.cwd }),
  });
  if (!locked.acquired) {
    console.error(`iapeer-memory unprovision-peer: ${locked.detail}`);
    return 1;
  }
  return report("unprovision-peer", flags, locked.result);
}
