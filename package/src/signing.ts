/**
 * Stable code-signing for the compiled binary — TCC grants must SURVIVE
 * updates. Port of the iapeer reference (their signing.ts, 0079106): the
 * bun-compiled binary is ad-hoc linker-signed (CDHash-only requirement) —
 * every update is a NEW TCC subject → re-prompts. On THIS product the
 * stake is higher: the vault lives in iCloud Drive (~/Library/Mobile
 * Documents — TCC-protected), memoryd touches it on every index pass.
 *
 * CONTRACT with iapeer (fixed on both sides —
 * their comment block over SIGNING_IDENTITY_CN, b3f5dd4):
 * - SHARED CN «iapeer Local Codesign» — one keychain identity per host for
 *   the whole stack; PER-PRODUCT identifier (ours: com.agfpd.iapeer-memory)
 *   → designated requirements differ per product, TCC subjects stay
 *   separate, ONE keychain prompt per host.
 * - first-needs-creates with the IDENTICAL profile (EKU codeSigning,
 *   system LibreSSL p12, `security import -T /usr/bin/codesign`).
 *   Changing the CN or the profile — only by mutual agreement.
 * - Footnote 1 (race): two installers first-creating the identity
 *   simultaneously → duplicate CN → codesign "ambiguous identity".
 *   Residual accepted: installs are operator-sequential; we never sign
 *   from parallel sweeps.
 * - Footnote 2 (blast radius): deleting/re-creating the identity changes
 *   the cert leaf → every product of the stack re-prompts once. The
 *   accepted price of one shared key.
 * - Footnote 3 (expiry): the cert lives 3650 days (~2036); expiry =
 *   re-creation = footnote 2.
 *
 * ONE binary = ONE identifier: memoryd is the same Mach-O
 * (`launcher → exec binary memoryd`), so a single TCC subject covers the
 * CLI and the daemon.
 *
 * Failure policy: SOFT — the binary works ad-hoc-signed exactly as before;
 * a signing hiccup must never break install/update (reported loud: the
 * operator learns TCC prompts will re-appear). 90 s ceiling so an
 * unanswered keychain prompt can't wedge an unattended update.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Egress } from "./egress.js";
import { guardedRmSync } from "@agfpd/iapeer-memory-core";

export const SIGNING_IDENTITY_CN = "iapeer Local Codesign";
export const SIGNING_IDENTIFIER = "com.agfpd.iapeer-memory";

/** System LibreSSL — always present on macOS; its pkcs12 output imports
 *  into the keychain directly (homebrew OpenSSL 3.x p12 needs -legacy —
 *  live-caught by the iapeer experiment; pinning the system binary removes
 *  the PATH-dependent branch). */
const SYSTEM_OPENSSL = "/usr/bin/openssl";

export type SigningRunner = (
  cmd: string,
  args: string[],
) => { status: number | null; stdout: string; stderr: string };

/** The keychain trio (security/openssl/codesign) goes out through the
 *  egress handle — 90 s ceiling so an unanswered keychain prompt can't
 *  wedge an unattended update. */
function egressRunner(egress: Egress): SigningRunner {
  return (cmd, args) => {
    const r = egress.spawnSync([cmd, ...args], { timeoutMs: 90_000 });
    if (r.spawnError) return { status: null, stdout: "", stderr: r.spawnError };
    return { status: r.exitCode, stdout: r.stdout, stderr: r.stderr };
  };
}

export type SigningOutcome = {
  state:
    | "signed" // re-signed with the existing identity
    | "signed-new-identity" // identity created this run (the ONE install-time event)
    | "skipped-sandbox" // tests never touch the real keychain
    | "failed-soft"; // binary stays ad-hoc (works; TCC prompts return)
  detail?: string;
};

/** Deliberately NOT `-v` (valid-only): the self-signed cert reads
 *  CSSMERR_TP_NOT_TRUSTED, which is fine for signing — `-v` would hide it
 *  and re-create endlessly (iapeer reference fact). */
function identityPresent(run: SigningRunner): boolean {
  const r = run("security", ["find-identity", "-p", "codesigning"]);
  return r.status === 0 && r.stdout.includes(`"${SIGNING_IDENTITY_CN}"`);
}

function createIdentity(run: SigningRunner): { ok: boolean; detail?: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "iapeer-memory-signing-"));
  const key = path.join(dir, "key.pem");
  const cert = path.join(dir, "cert.pem");
  const p12 = path.join(dir, "id.p12");
  // Throwaway transport password — lives seconds inside a 0700 tmp dir.
  const pass = `iapeer-memory-${process.pid}-${Math.floor(Math.random() * 1e9)}`;
  try {
    const req = run(SYSTEM_OPENSSL, [
      "req", "-x509", "-newkey", "rsa:2048", "-keyout", key, "-out", cert,
      "-days", "3650", "-nodes", "-subj", `/CN=${SIGNING_IDENTITY_CN}`,
      "-addext", "keyUsage=digitalSignature",
      "-addext", "extendedKeyUsage=codeSigning",
    ]);
    if (req.status !== 0) {
      return { ok: false, detail: `openssl req failed: ${req.stderr.trim().split("\n")[0] ?? ""}` };
    }
    const exp = run(SYSTEM_OPENSSL, [
      "pkcs12", "-export", "-inkey", key, "-in", cert, "-out", p12,
      "-passout", `pass:${pass}`, "-name", SIGNING_IDENTITY_CN,
    ]);
    if (exp.status !== 0) {
      return { ok: false, detail: `openssl pkcs12 failed: ${exp.stderr.trim().split("\n")[0] ?? ""}` };
    }
    // -T pre-authorizes codesign in the key's ACL — at most ONE keychain
    // confirmation at the very first signing (the install-time event).
    const imp = run("security", ["import", p12, "-P", pass, "-T", "/usr/bin/codesign"]);
    if (imp.status !== 0) {
      return { ok: false, detail: `security import failed: ${imp.stderr.trim().split("\n")[0] ?? ""}` };
    }
    return { ok: true };
  } finally {
    try {
      guardedRmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup of the throwaway key material
    }
  }
}

/**
 * Re-sign the installed binary with the stable local identity (creating it
 * on first use). Called by installBinary after the atomic rename — every
 * install/update path — so the designated requirement (and every TCC
 * grant) stays constant while the bytes change.
 */
export function signInstalledBinary(
  egress: Egress,
  binPath: string,
  run: SigningRunner = egressRunner(egress),
): SigningOutcome {
  // The keychain is HOST-GLOBAL — same class as live sends. The sandbox
  // decision lives in the egress constructor (deny-by-default §4); a
  // refusing handle maps to the historical skipped-sandbox outcome.
  if (egress.refused) {
    return { state: "skipped-sandbox", detail: "test sandbox — not touching the real keychain" };
  }
  let created = false;
  if (!identityPresent(run)) {
    const c = createIdentity(run);
    if (!c.ok) {
      return {
        state: "failed-soft",
        detail: `${c.detail} — binary stays ad-hoc-signed (works, but TCC prompts will re-appear after updates)`,
      };
    }
    created = true;
  }
  const sign = run("codesign", [
    "-f", "-s", SIGNING_IDENTITY_CN, "--identifier", SIGNING_IDENTIFIER, binPath,
  ]);
  if (sign.status !== 0) {
    return {
      state: "failed-soft",
      detail: `codesign failed: ${sign.stderr.trim().split("\n")[0] ?? `exit ${sign.status}`} — binary stays ad-hoc-signed (works, but TCC prompts will re-appear after updates)`,
    };
  }
  return created ? { state: "signed-new-identity" } : { state: "signed" };
}
