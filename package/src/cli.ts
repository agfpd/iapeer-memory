#!/usr/bin/env bun
/**
 * iapeer-memory CLI — the package facade over core.
 *
 * The package IS the system (ADR-009): everything live — memoryd with the
 * MCP-http endpoint, fragment/index/doctrine rendering, frontmatter tooling,
 * install/verify/update — enters through this binary. The claude/codex
 * session surfaces are thin sockets that call back into it.
 *
 * Boot order: resolve the path namespace → load the package config file
 * (env precedence: flags > process env > config file > defaults,
 * `config-env.ts`) → dispatch. Exit codes: 0 ok, 1 command failed /
 * verify found problems, 2 usage error or not-yet-implemented stage.
 */

import { sandboxBlocksProdRead } from "@agfpd/iapeer-memory-core";
import { loadConfigFile } from "./config-env.js";
import { liveEgress } from "./egress.js";
import { memoryPaths } from "./paths.js";
import { packageVersion } from "./version.js";
import { cmdFmUpdate } from "./commands/fm-update.js";
import { cmdBake } from "./commands/bake.js";
import { cmdHook } from "./commands/hook.js";
import { cmdInit } from "./commands/init.js";
import { cmdInstallBinary } from "./commands/install-binary.js";
import { cmdMemoryd } from "./commands/memoryd.js";
import { cmdMigrate } from "./commands/migrate.js";
import { cmdDreamCollect } from "./commands/dream-collect.js";
import { cmdArchiveStale } from "./commands/archive-stale.js";
import { cmdProvisionPeer, cmdUnprovisionPeer } from "./commands/provision-peer.js";
import { cmdRender } from "./commands/render.js";
import { cmdStatus } from "./commands/status.js";
import { cmdUninstall } from "./commands/uninstall.js";
import { cmdUpdate } from "./commands/update.js";
import { cmdVerify } from "./commands/verify.js";

export const USAGE = `iapeer-memory — peer memory for the iapeer ecosystem

Usage: iapeer-memory <command> [options]

Commands:
  init                      provision the system on this host (vault, config,
                            role peers, memoryd registration); idempotent
  uninstall [--keep-binary] remove the system: slot declaration + binary
                            (vault and config are kept — user-owned)
  status                    read-only diagnostics: verify + slot + MCP probe
  verify [--repair]         check (and repair) the live surfaces: config,
                            memory-provider slot, memoryd heartbeat, role
                            doctrine versions
  update [--skip-binary]    update every surface (ADR-010): binary recompile,
                            templates, doctrine re-render, slot version,
                            launcher, managed memoryd restart
  install-binary [--out P]  compile the stable CLI binary (~/.local/bin) —
                            init step / repair path; needs package sources
  provision-peer --cwd P --runtime claude|codex --personality NAME [--occasion O]
                            merge the direct session surfaces into one peer's
                            cwd (claude: hooks/MCP/skills; codex: project MCP +
                            hooks.json with a trust-hooks pre-seed; idempotent,
                            own keys only); the iapeer core shells into this at
                            peer birth
  unprovision-peer --cwd P --runtime claude|codex [--occasion O]
                            strip OUR surfaces from one peer's cwd (mirror)
  fm-update [ops] FILE...   structural frontmatter edits + attribution stamp
  bake FILE...              re-stamp YOUR authorship on notes you wrote via
                            bash/shell (which bypasses the post-write hook)
  migrate --source DIR      move harness auto-memory into the vault
                            (dry-run by default; --apply to execute)
  dream-collect [--gate]    deterministic weekly-tick pre-filter (zero LLM):
                            active agent-memory folders in the 7d window +
                            candidate flags + resolved transcript files +
                            batched tasks, from the LIVE registry (read-only).
                            --gate: no output, exit 0 iff there is work (the
                            notifier check that decides if DreamWeaver wakes)
  archive-stale [--commit]  deliberate backlog archiver (lean §2.2a): move
                            pre-existing stale notes to the archive. Dry-run by
                            default (lists what would move); --commit executes.
                            ALL content folders incl. 03_Projects (unified rule);
                            memoryd archives ongoing staleness on its own.
  render index|fragment|doctrine|guide
                            render one artifact explicitly (memoryd does this
                            continuously; render is the manual/scripted path)
  memoryd                   run the daemon in the foreground (stdout = event
                            lines; supervised by a notifier watcher)
  hook post-write|session-start
                            hook engine (the session surfaces' bash hooks are
                            3-line shims around these; fail-open by contract)
  version                   print the package version
  help                      print this help

Config file: ~/.iapeer/plugins/iapeer-memory/config.env (env format;
overridable via IAPEER_MEMORY_CONFIG_FILE). An explicit IAPEER_MEMORY_* in
the process env always wins over the file.`;

export async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;

  // The config file is the env context of every command (except pure
  // help/version, where a broken file must not block the output).
  // Deny-by-default §7.2 (accepted): under a test sandbox the LIVE host's
  // config.env is never read — it would pull the live vault path, the
  // embedding/reranker endpoints and the production port into a sandboxed
  // process. A test must pass ITS OWN IAPEER_MEMORY_CONFIG_FILE.
  if (cmd && !["help", "--help", "-h", "version", "--version", "-V"].includes(cmd)) {
    const configFile = memoryPaths().configFile;
    if (sandboxBlocksProdRead(configFile)) {
      console.error(
        `iapeer-memory: live config.env skipped under the test sandbox (${configFile}) — pass IAPEER_MEMORY_CONFIG_FILE`,
      );
    } else {
      loadConfigFile(configFile);
    }
  }

  // The ONE egress construction point (deny-by-default §4 П2): under a
  // test-sandbox env this is a refusing handle — commands degrade to their
  // SKIP semantics; nothing below re-checks the env.
  const egress = liveEgress();

  switch (cmd) {
    case undefined:
    case "help":
    case "--help":
    case "-h":
      console.log(USAGE);
      return 0;
    case "version":
    case "--version":
    case "-V":
      console.log(packageVersion());
      return 0;
    case "init":
      return cmdInit(rest, egress);
    case "uninstall":
      return cmdUninstall(rest, egress);
    case "status":
      return cmdStatus(rest, egress);
    case "verify":
      return cmdVerify(rest, egress);
    case "update":
      return cmdUpdate(rest, egress);
    case "install-binary":
      return cmdInstallBinary(rest, egress);
    case "dream-collect":
      return cmdDreamCollect(rest, egress);
    case "archive-stale":
      return cmdArchiveStale(rest);
    case "provision-peer":
      return cmdProvisionPeer(rest, egress);
    case "unprovision-peer":
      return cmdUnprovisionPeer(rest);
    case "fm-update":
      return cmdFmUpdate(rest);
    case "bake":
      return cmdBake(rest);
    case "migrate":
      return cmdMigrate(rest);
    case "render":
      return cmdRender(rest);
    case "memoryd":
      return cmdMemoryd(rest);
    case "hook":
      return cmdHook(rest, egress);
    default:
      console.error(`iapeer-memory: unknown command: ${cmd}\n`);
      console.error(USAGE);
      return 2;
  }
}

if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2));
}
