/**
 * Host-wide provision lock — the iapeer v1.2 contract obliges the provision
 * command to TOLERATE PARALLEL CALLS (the locking the plugin manager used to
 * give moved to the provider; §7 requirement 3). The core may fire
 * provision-peer concurrently (peer births race sweeps); two unsynchronised
 * read-merge-writes of the SAME settings.json would lose one writer's keys.
 *
 * Form: mkdir-based exclusive lock (atomic on every POSIX fs, no flock in
 * Bun's stable API) carrying an OWNER TOKEN (`owner` file: pid + nonce).
 * One lock for the whole host.
 *
 * Stale detection (audit important — the age-only break tore locks from
 * LIVE holders): a lock older than STALE_MS is broken ONLY when its owner
 * pid is confirmed dead (the caller-supplied `pidAlive` probe — an egress
 * `ps` lookup) or carries no token (crash mid-take / pre-token era). A live
 * holder legitimately exceeding STALE_MS (a codex sweep spawning
 * trust-hooks per peer) keeps its lock. Release is OWNED: the finally
 * removes the lock only when the token is still ours — a process whose lock
 * was stale-broken must not tear down the NEXT holder's lock (the
 * third-writer cascade).
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { guardedWriteFileSync, guardedRmSync } from "@agfpd/iapeer-memory-core";

const RETRY_MS = 50;
const DEFAULT_TIMEOUT_MS = 15_000;
export const STALE_MS = 120_000;

export type LockResult<T> =
  | { acquired: true; result: T }
  | { acquired: false; detail: string };

function ownerPath(lockDir: string): string {
  return path.join(lockDir, "owner");
}

function tryTake(lockDir: string, token: string): boolean {
  try {
    fs.mkdirSync(lockDir); // atomic: EEXIST when held
  } catch {
    return false;
  }
  try {
    guardedWriteFileSync(ownerPath(lockDir), token, "utf-8");
  } catch {
    // token write failed — the lock still holds (mkdir won); breakers treat
    // a tokenless STALE dir as breakable, which is the honest state here.
  }
  return true;
}

function breakIfStale(lockDir: string, pidAlive?: (pid: number) => boolean): void {
  try {
    const stat = fs.statSync(lockDir);
    if (Date.now() - stat.mtimeMs <= STALE_MS) return;
    // Age alone no longer breaks a LIVE holder: consult the owner token.
    if (pidAlive) {
      try {
        const pid = Number(fs.readFileSync(ownerPath(lockDir), "utf-8").split(":")[0]);
        if (Number.isInteger(pid) && pid > 1 && pidAlive(pid)) return; // live — wait
      } catch {
        // no/unreadable token → crashed take or pre-token lock → breakable
      }
    }
    guardedRmSync(lockDir, { recursive: true, force: true });
  } catch {
    // raced away or unreadable — the next tryTake decides
  }
}

/** Generic pid-liveness probe over an egress handle (`ps` — allowance 3 of
 *  the refusing egress, same class as the verified-kill guard's lookup). */
export function pidAliveProbe(egress: {
  spawnSync: (argv: string[]) => { exitCode: number; stdout: string; spawnError?: string };
}): (pid: number) => boolean {
  return (pid) => {
    const r = egress.spawnSync(["ps", "-p", String(pid), "-o", "pid="]);
    return !r.spawnError && r.exitCode === 0 && r.stdout.trim().length > 0;
  };
}

export function withProvisionLock<T>(opts: {
  stateDir: string;
  fn: () => T;
  timeoutMs?: number;
  /** Owner-liveness probe for the stale-breaker (see header). Omitted →
   *  age-only breaking of TOKENLESS locks; a token'd lock is never broken
   *  without a probe. */
  pidAlive?: (pid: number) => boolean;
}): LockResult<T> {
  const lockDir = path.join(opts.stateDir, "provision.lock.d");
  fs.mkdirSync(opts.stateDir, { recursive: true });
  const token = `${process.pid}:${crypto.randomBytes(8).toString("hex")}`;
  const deadline = Date.now() + (opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  while (!tryTake(lockDir, token)) {
    breakIfStale(lockDir, opts.pidAlive);
    if (Date.now() >= deadline) {
      return {
        acquired: false,
        detail: `provision lock busy for ${Math.round((opts.timeoutMs ?? DEFAULT_TIMEOUT_MS) / 1000)}s (${lockDir}) — another provision hung? dead-owner locks self-break after ${STALE_MS / 1000}s`,
      };
    }
    Bun.sleepSync(RETRY_MS);
  }
  try {
    return { acquired: true, result: opts.fn() };
  } finally {
    try {
      // OWNED release: only tear down the lock while the token is still ours.
      const current = fs.readFileSync(ownerPath(lockDir), "utf-8");
      if (current === token) {
        guardedRmSync(lockDir, { recursive: true, force: true });
      }
    } catch {
      // lock (or token) already gone — stale-broken by a peer; never touch
      // what may be the NEXT holder's lock
    }
  }
}
