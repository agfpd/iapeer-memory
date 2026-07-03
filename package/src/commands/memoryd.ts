/**
 * `iapeer-memory memoryd` — run the daemon in the foreground (ADR-004).
 *
 *   iapeer-memory memoryd [--mcp-port N | --no-mcp] [--human NAME]
 *
 * This IS the watcher script the notifier supervises: stdout carries the
 * curation signal line (CURATOR_TICK — core emits it per cadence pass),
 * stderr carries logs, SIGTERM/SIGINT shut down cleanly (flush + close). All state
 * paths come from the shared `paths.ts` namespace — the heartbeat lands
 * exactly where `verify` reads it, by construction.
 *
 * - MCP port: `--mcp-port` > IAPEER_MEMORY_MCP_PORT/config file > 8766
 *   (config default, ADR-012); `--no-mcp` disables the endpoint;
 * - human-edit detection: `--human` > IAPEER_MEMORY_HUMAN_NAME; absent →
 *   detection off (⚖7 — the human role is optional);
 * - fresh-edit window: IAPEER_MEMORY_FRESH_EDIT_WINDOW_S (default in core).
 */

import fs from "node:fs";
import { configFromEnv, startMemoryd, resolveMode, curationPlan } from "@agfpd/iapeer-memory-core";
import { authorIndexPath, memoryPaths } from "../paths.js";
import { guardedWriteFileSync, guardedUnlinkSync } from "@agfpd/iapeer-memory-core";
import type { Egress } from "../egress.js";
import { pidLooksLikeOurs } from "./uninstall.js";

export async function cmdMemoryd(argv: string[], egress: Egress): Promise<number> {
  let mcpPort: number | undefined;
  let noMcp = false;
  let human: string | null = null;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--mcp-port": {
        const v = Number(argv[++i]);
        if (!Number.isInteger(v) || v < 0 || v > 65535) {
          console.error(`iapeer-memory memoryd: invalid --mcp-port: ${argv[i]}`);
          return 2;
        }
        mcpPort = v;
        break;
      }
      case "--no-mcp":
        noMcp = true;
        break;
      case "--human":
        human = argv[++i] ?? null;
        break;
      default:
        console.error(`iapeer-memory memoryd: unknown flag: ${a}`);
        return 2;
    }
  }

  const config = configFromEnv();
  // Lean §7 emit-suppression: memoryd ALWAYS runs (the base — детектор/архив/
  // проекция/dedup), but it EMITS the curation event (CURATOR_TICK) only when
  // a proactive curation receiver exists (scriber ∥ index). Full-lean → a
  // no-op emit: the curator tick still runs (the baseline stays current — a
  // later lean→curated switch is clean), the watcher forwards nothing. The
  // watcher trigger ITSELF always registers (it launches memoryd; never gated).
  const { mode, roles } = resolveMode(process.env);
  const emitCuration = curationPlan(roles).emit;
  process.stderr.write(
    `iapeer-memory memoryd: mode=${mode} curation-emit=${emitCuration ? "on" : "off (lean)"}\n`,
  );
  const paths = memoryPaths();
  for (const dir of [paths.stateDir, paths.cacheDir, paths.logsDir]) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const freshEditWindowRaw = process.env.IAPEER_MEMORY_FRESH_EDIT_WINDOW_S;
  const freshEditWindowS =
    freshEditWindowRaw && Number.isFinite(Number(freshEditWindowRaw))
      ? Number(freshEditWindowRaw)
      : undefined;

  const handle = await startMemoryd({
    config,
    // full-lean → suppress curation emits (no-op); else core default (stdout).
    emit: emitCuration ? undefined : () => {},
    heartbeatPath: paths.heartbeatPath,
    hashStatePath: paths.hashStatePath,
    tagsMirrorPath: paths.tagsMirrorPath,
    humanName: human ?? process.env.IAPEER_MEMORY_HUMAN_NAME ?? null,
    freshEditWindowS,
    mcpPort: noMcp ? null : mcpPort,
    // Single-writer lock liveness (audit important: no single-instance
    // guard): the egress `ps` probe both checks the recorded pid is alive
    // AND that it is actually a memoryd — the recycled-pid class stays
    // closed. A crashed owner is taken over immediately, a live one refuses.
    lockPidAlive: (pid) => pidLooksLikeOurs(egress, pid),
    // Per-peer fragment rendering (docs/05): the package owns
    // the ecosystem joint — fleet-map path + paths-block facts; core
    // renders at startup, on vault changes and on fleet-map changes.
    fragments: {
      fleetMapPath: paths.fleetMapPath,
      paths: {
        vault: config.vaultPath,
        db: config.index.dbPath,
        config: paths.configFile,
        state: paths.stateDir,
        cache: paths.cacheDir,
        logs: paths.logsDir,
      },
      authorIndexPathFor: (agent) => authorIndexPath(paths, agent),
      indexAgent: process.env.IAPEER_MEMORY_INDEX_AGENT || "index",
      projectsRoot: process.env.IAPEER_MEMORY_PROJECTS_ROOT || undefined,
    },
  });

  // pid file — uninstall's stop handle. Written AFTER startMemoryd succeeds
  // (audit important): a second instance dying at the single-writer lock (or
  // at EADDRINUSE) must not have already clobbered the pid file of the LIVE
  // first instance — that stale overwrite broke stopMemorydByPidFile for
  // update/uninstall.
  guardedWriteFileSync(paths.pidPath, `${process.pid}\n`);

  return await new Promise<number>((resolve) => {
    let closing = false;
    const shutdown = (signal: string) => {
      if (closing) return;
      closing = true;
      console.error(`memoryd: ${signal} — shutting down`);
      handle
        .close()
        .then(() => {
          try {
            guardedUnlinkSync(paths.pidPath);
          } catch {
            // best effort
          }
          resolve(0);
        })
        .catch((err) => {
          console.error(`memoryd: close failed: ${String(err)}`);
          resolve(1);
        });
    };
    process.on("SIGINT", () => shutdown("SIGINT"));
    process.on("SIGTERM", () => shutdown("SIGTERM"));
  });
}
