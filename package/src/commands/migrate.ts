/**
 * `iapeer-memory migrate` — move a harness's built-in auto-memory into the
 * vault's agent-memory zone (core engine; the SOURCE directory is
 * adapter-scoped and always explicit — the engine never guesses where a
 * harness keeps its memories, ADR/нюанс: codex format is gated on live
 * verification, P5).
 *
 *   iapeer-memory migrate --source DIR --agent NAME [--apply]
 *                         [--backup-root DIR]
 *
 * Dry-run by default: prints the plan (per-file mapping + subtype counts)
 * and exits 0. `--apply` runs the real migration: per-file backup → convert
 * + atomic write → unlink source; exit 1 if any file errored.
 */

import fs from "node:fs";
import {
  applyMigration,
  configFromEnv,
  planMigration,
  resolveAgentName,
} from "@agfpd/iapeer-memory-core";
import { memoryPaths } from "../paths.js";
import path from "node:path";

export function cmdMigrate(argv: string[]): number {
  let source = "";
  let agent: string | null = null;
  let apply = false;
  let backupRoot = "";

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--source":
        source = argv[++i] ?? "";
        break;
      case "--agent":
        agent = argv[++i] ?? null;
        break;
      case "--apply":
        apply = true;
        break;
      case "--backup-root":
        backupRoot = argv[++i] ?? "";
        break;
      default:
        console.error(`iapeer-memory migrate: unknown flag: ${a}`);
        return 2;
    }
  }

  const resolvedAgent = resolveAgentName(agent);
  if (!source || !resolvedAgent) {
    console.error(
      "iapeer-memory migrate: --source DIR is required, and an agent " +
        "(--agent or PEER_PERSONALITY) must resolve",
    );
    return 2;
  }
  if (!fs.existsSync(source) || !fs.statSync(source).isDirectory()) {
    console.error(`iapeer-memory migrate: source is not a directory: ${source}`);
    return 1;
  }

  const config = configFromEnv();
  const paths = memoryPaths();

  if (!apply) {
    const plan = planMigration({
      sourceDir: source,
      agent: resolvedAgent,
      vault: config.vaultPath,
      taxonomy: config.taxonomy,
    });
    console.log(`migrate (dry-run): ${plan.source} → ${plan.target}`);
    for (const f of plan.files) {
      console.log(
        f.error
          ? `  !! ${f.name}: ${f.error}`
          : `  ${f.name}: ${f.oldType} → ${f.subtype}`,
      );
    }
    if (plan.skippedSystem.length) {
      console.log(`  system (backup-only): ${plan.skippedSystem.join(", ")}`);
    }
    if (plan.skippedAlreadyInTarget.length) {
      // apply also removes these from the source (the target copy wins).
      console.log(
        `  already in target (source copy will be backed up + removed): ${plan.skippedAlreadyInTarget.join(", ")}`,
      );
    }
    if (plan.backupOnly.length) {
      // The plan must show EVERYTHING apply mutates: non-md files are backed
      // up and removed from the source — confirming a plan that hides them
      // would approve an operation wider than shown (audit important).
      console.log(
        `  backup-only, will be REMOVED from source: ${plan.backupOnly.join(", ")}`,
      );
    }
    console.log(
      `  total to migrate: ${plan.totalToMigrate} ` +
        `(${Object.entries(plan.subtypeCounts).map(([k, v]) => `${k}: ${v}`).join(", ") || "none"})`,
    );
    console.log("run again with --apply to migrate");
    return 0;
  }

  const result = applyMigration({
    sourceDir: source,
    agent: resolvedAgent,
    vault: config.vaultPath,
    backupRoot: backupRoot || path.join(paths.stateDir, "migrate-backups"),
    taxonomy: config.taxonomy,
  });
  console.log(
    `migrate: ${result.migrated.length} migrated, ${result.skipped.length} skipped, ` +
      `${result.errors.length} errors; backup: ${result.backupDir}` +
      `${result.sourceRemoved ? "; source dir removed" : ""}`,
  );
  for (const e of result.errors) console.error(`  !! ${e}`);
  return result.errors.length ? 1 : 0;
}
