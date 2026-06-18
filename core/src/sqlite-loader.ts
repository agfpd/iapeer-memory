/**
 * SQLite runtime preparation for `bun:sqlite` + `sqlite-vec`.
 *
 * Why this file exists: bun's bundled SQLite is compiled with
 * `SQLITE_OMIT_LOAD_EXTENSION`, which makes `Database.prototype.loadExtension`
 * fail at runtime ("This build of sqlite3 does not support dynamic extension
 * loading"). bun:sqlite exports a static escape hatch — `Database.setCustomSQLite(path)`
 * — that swaps in any libsqlite3.dylib at process startup. Most non-bundled
 * builds (homebrew, system Linux distro packages) compile with extension
 * loading enabled, so we can use them as the runtime SQLite and load
 * `sqlite-vec` on top.
 *
 * Call exactly once per process, BEFORE constructing any `Database` — the
 * choice is process-wide. On failure (no non-stripped libsqlite3 found, or
 * `setCustomSQLite` itself throws), the function does NOT crash the process:
 * it returns `{ available: false, reason }` and the caller falls back to the
 * bundled bun-sqlite (without vec). That keeps the system working in degraded
 * BM25-only mode on machines that don't have homebrew sqlite.
 */

import fs from "node:fs";
import { Database } from "bun:sqlite";

export type SqliteRuntime = {
  available: boolean;
  dylibPath: string | null;
  reason: string;
};

const DEFAULT_DYLIB_CANDIDATES = [
  // macOS — Homebrew (preferred: stays up to date, compiled without
  // OMIT_LOAD_EXTENSION).
  "/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib",
  "/opt/homebrew/lib/libsqlite3.dylib",
  "/usr/local/opt/sqlite/lib/libsqlite3.dylib",
  "/usr/local/lib/libsqlite3.dylib",
  // Linux — typical package paths. Both Debian/Ubuntu and Fedora ship
  // libsqlite3 with extension loading enabled by default.
  "/usr/lib/x86_64-linux-gnu/libsqlite3.so",
  "/usr/lib/x86_64-linux-gnu/libsqlite3.so.0",
  "/usr/lib/aarch64-linux-gnu/libsqlite3.so",
  "/usr/lib/aarch64-linux-gnu/libsqlite3.so.0",
  "/usr/lib64/libsqlite3.so",
  "/usr/lib64/libsqlite3.so.0",
  "/usr/lib/libsqlite3.so",
  "/usr/lib/libsqlite3.so.0",
];

// Module-level guard: setCustomSQLite is global per process. Calling it twice
// either silently no-ops or throws depending on bun version — easier to track
// the first decision ourselves and surface the result on subsequent calls.
let cached: SqliteRuntime | null = null;

export function prepareSqliteRuntime(
  logger?: { info: (msg: string) => void; warn: (msg: string) => void },
): SqliteRuntime {
  if (cached) return cached;

  // Explicit env override wins. Lets operators point at a bundled or
  // custom-built libsqlite3 without code changes.
  const envOverride = process.env.IAPEER_MEMORY_SQLITE_DYLIB;
  const candidates = envOverride
    ? [envOverride, ...DEFAULT_DYLIB_CANDIDATES]
    : DEFAULT_DYLIB_CANDIDATES;

  let chosen: string | null = null;
  for (const path of candidates) {
    try {
      if (fs.existsSync(path)) {
        chosen = path;
        break;
      }
    } catch {
      // unreadable path — skip
    }
  }

  if (!chosen) {
    cached = {
      available: false,
      dylibPath: null,
      reason:
        "non-stripped libsqlite3 not found; install homebrew sqlite or set IAPEER_MEMORY_SQLITE_DYLIB",
    };
    logger?.warn(
      `sqlite-loader: ${cached.reason} — falling back to bundled bun-sqlite (no vec)`,
    );
    return cached;
  }

  try {
    Database.setCustomSQLite(chosen);
  } catch (err) {
    cached = {
      available: false,
      dylibPath: chosen,
      reason: `setCustomSQLite(${chosen}) failed: ${String(err)}`,
    };
    logger?.warn(`sqlite-loader: ${cached.reason}`);
    return cached;
  }

  // Verify the chosen sqlite supports extension loading. A `.dylib` whose
  // build has OMIT_LOAD_EXTENSION compiled in would still let setCustomSQLite
  // succeed but block sqliteVec.load() later — better to catch it here so the
  // reason is reported once at startup, not on every search.
  try {
    const probe = new Database(":memory:");
    const opts = probe.prepare("SELECT * FROM pragma_compile_options()").all() as Array<{
      compile_options: string;
    }>;
    probe.close();
    const stripped = opts.some((o) =>
      /OMIT_LOAD_EXTENSION/i.test(String(o.compile_options ?? "")),
    );
    if (stripped) {
      cached = {
        available: false,
        dylibPath: chosen,
        reason: `${chosen} is built with SQLITE_OMIT_LOAD_EXTENSION`,
      };
      logger?.warn(`sqlite-loader: ${cached.reason} — falling back to BM25-only`);
      return cached;
    }
  } catch (err) {
    cached = {
      available: false,
      dylibPath: chosen,
      reason: `compile-options probe failed: ${String(err)}`,
    };
    logger?.warn(`sqlite-loader: ${cached.reason}`);
    return cached;
  }

  cached = {
    available: true,
    dylibPath: chosen,
    reason: "ok",
  };
  logger?.info(`sqlite-loader: using ${chosen} (extension loading enabled)`);
  return cached;
}

/**
 * Test-only escape hatch: reset the module-level cache so a unit test can
 * exercise the detection logic against a synthetic env or candidate list.
 * Production code never calls this.
 */
export function _resetSqliteRuntimeCacheForTests(): void {
  cached = null;
}
