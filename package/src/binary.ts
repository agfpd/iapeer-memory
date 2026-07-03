/**
 * Stable CLI binary — `bun build --compile` into `~/.local/bin/iapeer-memory`
 * (the @agfpd/iapeer precedent: notifier/telegram runtime packages ship the
 * same Mach-O form). WHY a compiled binary and not the npx cache: hooks,
 * the notifier watcher launcher and the shims need a path that survives
 * npx-cache eviction — a production defect class proven on the reference implementation
 * («daemons executing a deleted cache snapshot») is closed by owning a
 * stable artifact (ADR-010).
 *
 * Facts from the P3a compile check (live, bun 1.3.13):
 * - the whole workspace (package + core) bundles into one ~61MB binary;
 * - runtime fs reads of package.json do NOT work inside the binary
 *   (`/$bunfs/`) — versions are embedded via static json imports;
 * - bun:sqlite works compiled (memoryd ran live: DB created, MCP up,
 *   heartbeat, clean SIGTERM); the sqlite-vec extension path is exercised
 *   only with an embedding endpoint configured and degrades to BM25-only
 *   with a logged reason — re-checked at the P3c live smoke.
 *
 * Recompilation needs SOURCES: a compiled binary cannot rebuild itself from
 * /$bunfs — `install-binary` run from the installed binary reports
 * `skipped-compiled` (re-install goes through npx, which runs from source).
 */

import fs from "node:fs";
import path from "node:path";
import type { Egress } from "./egress.js";
import { signInstalledBinary, type SigningOutcome } from "./signing.js";
import { guardedUnlinkSync, guardedRenameSync } from "@agfpd/iapeer-memory-core";

export function isCompiledRuntime(): boolean {
  return import.meta.url.includes("/$bunfs/");
}

export type InstallBinaryOutcome =
  | { action: "compiled"; outPath: string; bytes: number; signing: SigningOutcome }
  | { action: "skipped-compiled"; outPath: string }
  | { action: "failed"; outPath: string; detail: string };

export function installBinary(
  egress: Egress,
  opts: { outPath: string },
): InstallBinaryOutcome {
  const { outPath } = opts;
  if (isCompiledRuntime()) {
    return { action: "skipped-compiled", outPath };
  }

  const cliPath = new URL("./cli.ts", import.meta.url).pathname;
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const tmp = path.join(
    path.dirname(outPath),
    `.${path.basename(outPath)}.build.tmp`,
  );

  // Self-runtime spawn (egress allowance 2): compiling OUR cli with OUR bun
  // to a path-conventioned target — works in sandboxed e2e by design.
  const proc = egress.spawnSync([
    process.execPath, "build", "--compile", cliPath, "--outfile", tmp,
  ]);
  if (proc.spawnError || proc.exitCode !== 0 || !fs.existsSync(tmp)) {
    try {
      if (fs.existsSync(tmp)) guardedUnlinkSync(tmp);
    } catch {
      // best effort
    }
    return {
      action: "failed",
      outPath,
      detail:
        proc.spawnError || proc.stderr.trim() || `bun build exited ${proc.exitCode}`,
    };
  }

  fs.chmodSync(tmp, 0o755);
  guardedRenameSync(tmp, outPath); // atomic swap — safe over a running binary on macOS
  // Stable-identity re-sign on EVERY compile path (TCC grants survive
  // updates — contract with iapeer, see signing.ts). Soft-fail by design.
  const signing = signInstalledBinary(egress, outPath);
  return { action: "compiled", outPath, bytes: fs.statSync(outPath).size, signing };
}

export function removeBinary(outPath: string): "removed" | "absent" {
  if (!fs.existsSync(outPath)) return "absent";
  guardedUnlinkSync(outPath);
  return "removed";
}
