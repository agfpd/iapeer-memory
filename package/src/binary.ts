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
import crypto from "node:crypto";
import type { Egress } from "./egress.js";
import { signInstalledBinary, type SigningOutcome } from "./signing.js";
import { assertSandboxWritablePath, guardedUnlinkSync, guardedRenameSync } from "@agfpd/iapeer-memory-core";
import { packageVersion } from "./version.js";

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
  // The compiler and codesign are external writers: assert BEFORE spawning,
  // not merely at rename (which would be too late for a sandbox leak).
  assertSandboxWritablePath(outPath, "install-binary");

  const cliPath = new URL("./cli.ts", import.meta.url).pathname;
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const tmp = path.join(
    path.dirname(outPath),
    `.${path.basename(outPath)}.${crypto.randomBytes(6).toString("hex")}.build.tmp`,
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

  const fail = (detail: string): InstallBinaryOutcome => {
    if (fs.existsSync(tmp)) guardedUnlinkSync(tmp);
    return { action: "failed", outPath, detail: `${detail} — previous installation unchanged` };
  };
  fs.chmodSync(tmp, 0o755);
  // Never activate an unverified candidate. The stable-identity signature
  // (and its TCC subject) is applied BEFORE the atomic swap. Tests do not
  // touch the keychain; they ad-hoc sign ONLY this asserted tmp candidate.
  let signing: SigningOutcome;
  if (egress.refused && process.platform === "darwin") {
    const sign = egress.spawnSync(["/usr/bin/codesign", "-f", "-s", "-", "--identifier", "com.agfpd.iapeer-memory.test", tmp], { explicitBin: true, timeoutMs: 30_000 });
    if (sign.exitCode !== 0) return fail(`sandbox candidate signing failed: ${sign.stderr || sign.spawnError}`);
    signing = { state: "skipped-sandbox", detail: "stable identity skipped; isolated candidate ad-hoc signed" };
  } else {
    signing = signInstalledBinary(egress, tmp);
    if (signing.state === "failed-soft") return fail(`candidate signing failed: ${signing.detail}`);
  }
  if (process.platform === "darwin") {
    const verify = egress.spawnSync(["/usr/bin/codesign", "--verify", "--strict", tmp], { explicitBin: true, timeoutMs: 30_000 });
    if (verify.exitCode !== 0) return fail(`candidate signature invalid: ${verify.stderr || verify.spawnError}`);
  }
  const probe = egress.spawnSync([tmp, "version"], { explicitBin: true, timeoutMs: 10_000 });
  if (probe.exitCode !== 0 || probe.stdout.trim() !== packageVersion()) {
    return fail(`candidate version probe failed (exit ${probe.exitCode}, expected ${packageVersion()}, got ${JSON.stringify(probe.stdout.trim())}): ${probe.stderr || probe.spawnError || ""}`);
  }
  guardedRenameSync(tmp, outPath); // only now replace the working installation
  return { action: "compiled", outPath, bytes: fs.statSync(outPath).size, signing };
}

export function removeBinary(outPath: string): "removed" | "absent" {
  if (!fs.existsSync(outPath)) return "absent";
  guardedUnlinkSync(outPath);
  return "removed";
}
