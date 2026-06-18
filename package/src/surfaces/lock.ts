/**
 * Host-wide provision lock — the iapeer v1.2 contract obliges the provision
 * command to TOLERATE PARALLEL CALLS (the locking the plugin manager used to
 * give moved to the provider; §7 requirement 3). The core may fire
 * provision-peer concurrently (peer births race sweeps); two unsynchronised
 * read-merge-writes of the SAME settings.json would lose one writer's keys.
 *
 * Form: mkdir-based exclusive lock (atomic on every POSIX fs, no flock in
 * Bun's stable API). One lock for the whole host — provision bodies are
 * milliseconds of file I/O, serialising them is simpler and strictly safer
 * than per-cwd granularity. Stale detection: a lock directory older than
 * STALE_MS belongs to a crashed run — broken and re-taken (provision is
 * idempotent by contract, a double-run repairs, never corrupts).
 */

import fs from "node:fs";
import path from "node:path";

const RETRY_MS = 50;
const DEFAULT_TIMEOUT_MS = 15_000;
export const STALE_MS = 120_000;

export type LockResult<T> =
  | { acquired: true; result: T }
  | { acquired: false; detail: string };

function tryTake(lockDir: string): boolean {
  try {
    fs.mkdirSync(lockDir); // atomic: EEXIST when held
    return true;
  } catch {
    return false;
  }
}

function breakIfStale(lockDir: string): void {
  try {
    const stat = fs.statSync(lockDir);
    if (Date.now() - stat.mtimeMs > STALE_MS) fs.rmdirSync(lockDir);
  } catch {
    // raced away or unreadable — the next tryTake decides
  }
}

export function withProvisionLock<T>(opts: {
  stateDir: string;
  fn: () => T;
  timeoutMs?: number;
}): LockResult<T> {
  const lockDir = path.join(opts.stateDir, "provision.lock.d");
  fs.mkdirSync(opts.stateDir, { recursive: true });
  const deadline = Date.now() + (opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  while (!tryTake(lockDir)) {
    breakIfStale(lockDir);
    if (Date.now() >= deadline) {
      return {
        acquired: false,
        detail: `provision lock busy for ${Math.round((opts.timeoutMs ?? DEFAULT_TIMEOUT_MS) / 1000)}s (${lockDir}) — another provision hung? stale locks self-break after ${STALE_MS / 1000}s`,
      };
    }
    Bun.sleepSync(RETRY_MS);
  }
  try {
    return { acquired: true, result: opts.fn() };
  } finally {
    try {
      fs.rmdirSync(lockDir);
    } catch {
      // already gone (stale-broken by a peer) — nothing to release
    }
  }
}
