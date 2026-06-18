/**
 * Egress hub — the ONE doorway from this package to the live host
 * (docs/_planning/DENY_BY_DEFAULT_DESIGN.md §4).
 *
 * Topology, not another fuse: four incidents («тест дотянулся до прода»)
 * shared one root — outbound channels were allowed by default and refused
 * only under a test flag each call site had to remember. This module
 * inverts the default. Modules never spawn/kill/probe the host themselves
 * and never PATH-resolve an external binary — they take an explicit
 * {@link Egress} handle. The single live constructor, {@link liveEgress},
 * is called from `cli.ts main()`; while a test-sandbox env is armed it
 * hands back a REFUSING handle instead, and every channel reports refusal
 * (callers map it to their SKIP semantics — the iapeer `skipped-sandbox`
 * precedent). A module imported directly by a test has no doorway to the
 * host by construction: there is nothing to forget.
 *
 * The grep invariant (И3) pins the topology: no `Bun.spawn*`/`process.kill`
 * outside this file in src/.
 *
 * EXPLICIT ALLOWANCES of the refusing handle — each narrow, each here, all
 * in one place (deny by DEFAULT, authorized consciously):
 *
 * 1. `explicitBin` spawns — argv[0] was NAMED by the operator/test via a
 *    flag (`--iapeer-bin <path>`). Same safety class as the sanctioned
 *    fake-bin test pattern: a consciously named binary is an authorization,
 *    a PATH-resolved default is not. (Closes the old env-juggling dance:
 *    fake-bin tests no longer clear the sandbox vars.)
 * 2. Self-runtime spawns — argv[0] === process.execPath (bun): the binary
 *    compile (`bun build --compile` to a path-conventioned target) and the
 *    hook kick (self `verify --repair`). A child process re-enters through
 *    its OWN main() and inherits the sandbox env → its egress refuses too;
 *    nothing transitively reaches the host.
 * 3. `ps` probes — read-only process-table lookup feeding the verified-kill
 *    guard (`pidLooksLikeOurs`). Refusing it would break the guard whose
 *    whole job is to make kill() safe.
 * 4. Loopback fetch — status' own-daemon probes in sandboxed e2e. The
 *    host-daemon collision is closed by test port isolation (И3), not by
 *    refusing the probe. Non-loopback fetch refuses.
 *
 * kill() stays guarded by the verified-kill contract (owner verification
 * before signalling — accepted at the P3c review), not by refusal: the pid
 * PROVENANCE (sandbox pid file vs prod pid file) is the FS-belt's question
 * (И2), and refusing kill would orphan sandbox daemons in e2e.
 */

export type EgressSpawnResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
  /** Set when the spawn itself failed (binary missing) or the egress
   *  refused the channel — exitCode is 127 by convention then. */
  spawnError?: string;
  /** True when the refusing egress (test sandbox) blocked the channel. */
  refused?: boolean;
};

export type EgressSpawnOpts = {
  timeoutMs?: number;
  /** argv[0] was explicitly named by the operator/test (a `--*-bin` flag) —
   *  allowance 1 of the refusing handle. */
  explicitBin?: boolean;
};

export interface Egress {
  /** True for the refusing handle — callers may report a SKIP up front. */
  readonly refused: boolean;
  /** External binary, synchronous (iapeer, ps, openssl, security, codesign,
   *  bun). Never throws — a missing binary is a result, not a crash. */
  spawnSync(argv: string[], opts?: EgressSpawnOpts): EgressSpawnResult;
  /** Fire-and-forget detached spawn (hook kick → self `verify --repair`). */
  spawnDetached(argv: string[]): { started: boolean; detail?: string };
  /** Signal a live process. Never throws; `delivered: false` = process gone. */
  kill(pid: number, signal: NodeJS.Signals): { delivered: boolean };
  /** HTTP probe (status' loopback checks) — read-as-egress (П5). */
  fetch(url: string, init?: RequestInit): Promise<Response>;
}

/** Default name of the ecosystem CLI — the ONE place it lives (П2: no
 *  scattered `?? "iapeer"` defaults; the danger moved into the handle). */
export const IAPEER_BIN = "iapeer";

/** The ONE definition of the sandbox-env check lives in core's fs-guard
 *  (the FS belt uses it too) — re-exported here for the constructor and
 *  its tests. */
import { sandboxEnvArmed } from "@agfpd/iapeer-memory-core";
export { sandboxEnvArmed };

function rawSpawnSync(argv: string[], opts?: EgressSpawnOpts): EgressSpawnResult {
  try {
    const proc = Bun.spawnSync(argv, {
      stdout: "pipe",
      stderr: "pipe",
      ...(opts?.timeoutMs !== undefined ? { timeout: opts.timeoutMs } : {}),
    });
    return {
      exitCode: proc.exitCode,
      stdout: proc.stdout.toString(),
      stderr: proc.stderr.toString(),
    };
  } catch (err) {
    return { exitCode: 127, stdout: "", stderr: "", spawnError: String(err) };
  }
}

function rawSpawnDetached(argv: string[]): { started: boolean; detail?: string } {
  try {
    const proc = Bun.spawn(argv, {
      stdout: "ignore",
      stderr: "ignore",
      stdin: "ignore",
    });
    proc.unref();
    return { started: true };
  } catch (err) {
    return { started: false, detail: String(err) };
  }
}

function rawKill(pid: number, signal: NodeJS.Signals): { delivered: boolean } {
  try {
    process.kill(pid, signal);
    return { delivered: true };
  } catch {
    return { delivered: false };
  }
}

function isLoopback(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return host === "127.0.0.1" || host === "localhost" || host === "::1";
  } catch {
    return false;
  }
}

const REFUSAL = "egress refused (test sandbox) — pass a fake egress";

function refusedResult(): EgressSpawnResult {
  return { exitCode: 127, stdout: "", stderr: "", spawnError: REFUSAL, refused: true };
}

function refusingEgress(): Egress {
  return {
    refused: true,
    spawnSync(argv, opts) {
      if (opts?.explicitBin) return rawSpawnSync(argv, opts); // allowance 1
      if (argv[0] === process.execPath) return rawSpawnSync(argv, opts); // allowance 2
      if (argv[0] === "ps") return rawSpawnSync(argv, opts); // allowance 3
      return refusedResult();
    },
    spawnDetached(argv) {
      if (argv[0] === process.execPath) return rawSpawnDetached(argv); // allowance 2
      return { started: false, detail: REFUSAL };
    },
    kill: rawKill, // verified-kill contract guards this, not refusal (header)
    fetch(url, init) {
      if (isLoopback(url)) return fetch(url, init); // allowance 4
      return Promise.reject(new Error(REFUSAL));
    },
  };
}

function realEgress(): Egress {
  return {
    refused: false,
    spawnSync: rawSpawnSync,
    spawnDetached: rawSpawnDetached,
    kill: rawKill,
    fetch: (url, init) => fetch(url, init),
  };
}

/**
 * The ONE live constructor — called from `cli.ts main()` only. Refuses
 * (hands back the refusing handle) while a test-sandbox env is armed; the
 * decision is taken ONCE here, never re-checked at call sites.
 */
export function liveEgress(): Egress {
  return sandboxEnvArmed() ? refusingEgress() : realEgress();
}
