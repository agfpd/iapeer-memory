/**
 * Host-side path namespace of the package: `~/.iapeer/{state,cache,logs,
 * plugins}/iapeer-memory/` (the iapeer host-integration convention).
 *
 * Every root is individually overridable via env (the same keys are valid
 * `config.env` entries — docs/08 §package config):
 *
 * - `IAPEER_MEMORY_CONFIG_FILE` — package config (env format); default
 *   `~/.iapeer/plugins/iapeer-memory/config.env` (the precedent set by the
 *   reference plugin config location);
 * - `IAPEER_MEMORY_STATE_DIR`  — author indexes, heartbeat, detect-hash
 *   state, roles manifest;
 * - `IAPEER_MEMORY_CACHE_DIR`  — SQLite index, tags-dictionary mirror;
 * - `IAPEER_MEMORY_LOGS_DIR`   — log files;
 * - `IAPEER_MEMORY_DB_PATH`    — SQLite file itself (core config reads the
 *   same key; the default here mirrors core's `<cacheDir>/index.db`).
 *
 * Derived file names are FIXED relative to those roots — one source of
 * truth for every command (memoryd writes the heartbeat exactly where
 * verify reads it, by construction).
 */

import os from "node:os";
import path from "node:path";

export type MemoryPaths = {
  configFile: string;
  stateDir: string;
  cacheDir: string;
  logsDir: string;
  dbPath: string;
  heartbeatPath: string;
  hashStatePath: string;
  tagsMirrorPath: string;
  /** Compact tags-dictionary projection, injected to all peers (lean §3). */
  tagsProjectionPath: string;
  /** Roles manifest (written by init, read by verify/render): role → peerCwd/template. */
  rolesManifestPath: string;
  /** Rendered author indexes (`<agent>-vault-index.md` + `-full` variant). */
  indexesDir: string;
  /** memoryd pid file (written by the CLI memoryd command; uninstall stops by it). */
  pidPath: string;
  /**
   * Memory-provider slot declaration (iapeer memory-slot contract, FINAL):
   * `~/.iapeer/memory-provider.json` in the STORAGE ROOT (next to the
   * registry) — written/removed by our init/uninstall, only READ by the core.
   */
  slotPath: string;
  /** Stable compiled CLI binary (hooks/watcher rely on this path). */
  binaryPath: string;
  /** Materialised package-owned templates (roles, guide) — see templates/index.ts. */
  templatesDir: string;
  /** Materialised hook shims (fail-open bash, 3 lines) — the ABSOLUTE command
   *  paths merged into peers' `.claude/settings.json` (ownership lives IN THE
   *  DATA: the command path is the identity of our entries — ADR-009 v1.2). */
  hooksDir: string;
  /** memoryd launcher — the notifier watcher's script (wraps the stable binary). */
  launcherPath: string;
  /** Dream-tick gate check-script — the notifier `check` for the weekly timer
   *  (shells the registry-free `dream-collect --gate`; a dead week wakes no one). */
  dreamGateScriptPath: string;
  /** Fleet map (personality → cwd) — written by init/update/verify --repair
   *  from `iapeer list --json`, consumed by memoryd's fragment renderer
   *  (docs/05: без карты пиры не получали paths-блок и индекс). */
  fleetMapPath: string;
};

export function memoryPaths(
  env: Record<string, string | undefined> = process.env,
): MemoryPaths {
  const home = env.HOME || os.homedir();
  // IAPEER_ROOT — the ecosystem's ONE storage-root override (fact: iapeer
  // core constants.ts; its own sandbox tests relocate ~/.iapeer with it).
  // Respecting it keeps our slot/state co-located with the core's registry
  // in sandboxes and tests alike.
  const iapeerDir = env.IAPEER_ROOT || path.join(home, ".iapeer");
  const stateDir =
    env.IAPEER_MEMORY_STATE_DIR || path.join(iapeerDir, "state", "iapeer-memory");
  const cacheDir =
    env.IAPEER_MEMORY_CACHE_DIR || path.join(iapeerDir, "cache", "iapeer-memory");
  const logsDir =
    env.IAPEER_MEMORY_LOGS_DIR || path.join(iapeerDir, "logs", "iapeer-memory");
  const configFile =
    env.IAPEER_MEMORY_CONFIG_FILE ||
    path.join(iapeerDir, "plugins", "iapeer-memory", "config.env");
  return {
    configFile,
    stateDir,
    cacheDir,
    logsDir,
    dbPath: env.IAPEER_MEMORY_DB_PATH || path.join(cacheDir, "index.db"),
    heartbeatPath: path.join(stateDir, "memoryd.heartbeat"),
    hashStatePath: path.join(stateDir, "memoryd.hashes.json"),
    tagsMirrorPath: path.join(cacheDir, "tags-dictionary.md"),
    tagsProjectionPath: path.join(cacheDir, "tags-projection.md"),
    rolesManifestPath: path.join(stateDir, "roles.json"),
    indexesDir: path.join(stateDir, "indexes"),
    pidPath: path.join(stateDir, "memoryd.pid"),
    slotPath: path.join(iapeerDir, "memory-provider.json"),
    binaryPath:
      env.IAPEER_MEMORY_BINARY_PATH || path.join(home, ".local", "bin", "iapeer-memory"),
    templatesDir: path.join(path.dirname(configFile), "templates"),
    hooksDir: path.join(path.dirname(configFile), "hooks"),
    launcherPath: path.join(path.dirname(configFile), "memoryd-launcher.sh"),
    dreamGateScriptPath: path.join(path.dirname(configFile), "dream-tick-gate.sh"),
    fleetMapPath: path.join(stateDir, "fleet.json"),
  };
}

/**
 * Rendered author index file. The basename becomes the section title inside
 * the layer-5 fragment (context-render uses `path.basename`) — the
 * `<agent>-vault-index.md` form keeps the visible title parity with the
 * reference shards.
 */
export function authorIndexPath(paths: MemoryPaths, agent: string): string {
  return path.join(paths.indexesDir, `${agent}-vault-index.md`);
}
