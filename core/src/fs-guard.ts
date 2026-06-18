/**
 * FS belt — the file-system half of deny-by-default
 * (iapeer-memory docs/_planning/DENY_BY_DEFAULT_DESIGN.md §4 П4).
 *
 * Incident class №2 («лестница рассинхронилась»): the db path ladder lived
 * in TWO copies (core config + package paths) and a drift wrote a sandbox
 * SQLite into the PROD `~/.iapeer/cache`. Path conventions cannot be the
 * only belt — so every raw write/unlink/rm in BOTH src trees goes through
 * the wrappers below, and under an armed test-sandbox env they REFUSE any
 * path under a production anchor, no matter what the ladder computed:
 *
 *   ~/.iapeer            — ecosystem state/cache/config of the live host
 *   ~/.claude, ~/.codex  — harness config surfaces of the live fleet
 *   ~/Library/Mobile Documents — the iCloud root (the live vault lives there)
 *
 * Outside the sandbox env the wrappers are pass-through: live init/update/
 * migrate write exactly where they always did. The grep invariant (И3) pins
 * the funnel: no raw `fs.writeFileSync`/`Bun.write`/`fs.rmSync`/
 * `fs.unlinkSync` outside this file in either src tree.
 *
 * Deliberately NOT guarded in v1: `mkdirSync` (creates empty dirs — no data
 * loss / no content leak; the write that would fill them refuses) and reads.
 * v2 narrows both exceptions where they fed the
 * residual lane: the segment rule refuses writes into harness trees outside
 * the sandbox roots, and `sandboxBlocksProdRead` gates the prod reads that
 * NAME live cwds (fleet.json, the provider slot).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Both test belts — the ecosystem-wide var survives generic
 *  IAPEER_MEMORY_* env-stripping. The ONE definition
 *  for both packages: the package egress hub imports this. */
export function sandboxEnvArmed(): boolean {
  return (
    process.env.IAPEER_MEMORY_SUPPRESS_IAP_SEND === "1" ||
    process.env.IAPEER_TEST_SANDBOX === "1"
  );
}

function prodAnchors(): string[] {
  const home = os.homedir();
  return [
    path.join(home, ".iapeer"),
    path.join(home, ".claude"),
    path.join(home, ".codex"),
    path.join(home, "Library", "Mobile Documents"),
  ];
}

/** True when the resolved path sits under a production anchor. Exported for
 *  tests: the predicate is checkable without arming any write. */
export function isUnderProdAnchor(filePath: string): boolean {
  const resolved = path.resolve(filePath);
  return prodAnchors().some(
    (a) => resolved === a || resolved.startsWith(a + path.sep),
  );
}

/**
 * v2 segment rule: a `.iapeer`, `.claude` or `.codex` directory ANYWHERE
 * on disk is a session surface of some peer — peer cwds live in
 * `~/Projects/*`, `~/Peers/*`, OUTSIDE every prod anchor (24/29 fleet cwds;
 * a fragments/surfaces write into a live tree passed the
 * v1 anchor belt). Under the sandbox, a write that crosses a harness
 * segment must sit inside a sandbox root: tmp, or an EXPLICIT
 * IAPEER_ROOT / IAPEER_MEMORY_*_DIR override (an explicit override IS the
 * authorisation — same semantics as the egress hub's `--iapeer-bin`
 * allowance).
 */
const HARNESS_SEGMENTS = new Set([".iapeer", ".claude", ".codex"]);

function realpathOrSelf(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}

/** Roots a sandboxed test may legitimately write harness trees under.
 *  `/tmp` is listed besides os.tmpdir(): on macOS os.tmpdir() is the
 *  per-process $TMPDIR (/var/folders/…) while fixtures commonly use a
 *  literal /tmp; the realpath twins cover the /var → /private/var symlink. */
function sandboxRoots(): string[] {
  const roots = [os.tmpdir(), realpathOrSelf(os.tmpdir()), "/tmp", realpathOrSelf("/tmp")];
  for (const key of [
    "IAPEER_ROOT",
    "IAPEER_MEMORY_STATE_DIR",
    "IAPEER_MEMORY_CACHE_DIR",
    "IAPEER_MEMORY_LOGS_DIR",
  ]) {
    const v = process.env[key];
    if (v) roots.push(v);
  }
  const cfg = process.env.IAPEER_MEMORY_CONFIG_FILE;
  if (cfg) roots.push(path.dirname(path.resolve(cfg)));
  return roots.map((r) => path.resolve(r));
}

/** True when the path crosses a harness-surface segment OUTSIDE every
 *  sandbox root. Exported for tests (predicate-level, no write armed). */
export function isHarnessTreeOutsideSandbox(filePath: string): boolean {
  const resolved = path.resolve(filePath);
  if (!resolved.split(path.sep).some((seg) => HARNESS_SEGMENTS.has(seg))) return false;
  const roots = sandboxRoots();
  return !roots.some((r) => resolved === r || resolved.startsWith(r + path.sep));
}

/**
 * Read-as-egress parity for prod STATE (the И4 precedent — live config.env
 * skip in cli.ts): data that NAMES live peer cwds (fleet.json, the
 * memory-provider slot) must not flow into a sandboxed process from the
 * prod store — it is the SOURCE feeding the residual write lane above.
 * Callers treat a blocked read as «file absent» and report honestly.
 */
export function sandboxBlocksProdRead(filePath: string): boolean {
  return sandboxEnvArmed() && isUnderProdAnchor(filePath);
}

/** Throws under an armed sandbox env when the path targets a prod anchor
 *  (v1) or a harness tree outside the sandbox roots (v2 segment rule).
 *  The op name makes the refusal teach: WHICH write was stopped. */
export function assertSandboxWritablePath(filePath: string, op: string): void {
  if (!sandboxEnvArmed()) return;
  if (isUnderProdAnchor(filePath)) {
    throw new Error(
      `fs-guard: ${op} refused under the test sandbox — "${filePath}" is under a production anchor ` +
        "(~/.iapeer, ~/.claude, ~/.codex or the iCloud root). A test must write " +
        "inside its own tmp root; if the path came from the env ladder, the ladder drifted.",
    );
  }
  if (isHarnessTreeOutsideSandbox(filePath)) {
    throw new Error(
      `fs-guard: ${op} refused under the test sandbox — "${filePath}" crosses a .iapeer/.claude/.codex ` +
        "segment OUTSIDE the sandbox roots (tmp, IAPEER_ROOT, IAPEER_MEMORY_*_DIR). Harness surfaces " +
        "of live peers live in arbitrary cwds — a test may only touch such trees inside its own sandbox; " +
        "if the cwd came from fleet.json/the registry, the sandbox read-gate drifted.",
    );
  }
}

export function guardedWriteFileSync(
  filePath: string,
  data: string | NodeJS.ArrayBufferView,
  options?: Parameters<typeof fs.writeFileSync>[2],
): void {
  assertSandboxWritablePath(filePath, "write");
  fs.writeFileSync(filePath, data, options);
}

export function guardedUnlinkSync(filePath: string): void {
  assertSandboxWritablePath(filePath, "unlink");
  fs.unlinkSync(filePath);
}

export function guardedRmSync(
  filePath: string,
  options?: Parameters<typeof fs.rmSync>[1],
): void {
  assertSandboxWritablePath(filePath, "rm");
  fs.rmSync(filePath, options);
}
