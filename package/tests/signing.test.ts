import { describe, it, expect } from "bun:test";
import { liveEgress, type Egress } from "../src/egress.js";
import {
  signInstalledBinary,
  SIGNING_IDENTITY_CN,
  SIGNING_IDENTIFIER,
  type SigningRunner,
} from "../src/signing.js";

// Non-refused handle for the mocked-runner tests: the runner is injected, so
// every command goes through the recorder — the egress methods must never run.
// (The old env-juggling is gone: refusal is a property of the HANDLE now,
// not of the process env — deny-by-default §4 П2.)
const LIVE_LIKE: Egress = {
  refused: false,
  spawnSync: () => { throw new Error("unexpected egress.spawnSync (runner is injected)"); },
  spawnDetached: () => { throw new Error("unexpected egress.spawnDetached"); },
  kill: () => { throw new Error("unexpected egress.kill"); },
  fetch: () => Promise.reject(new Error("unexpected egress.fetch")),
};

type Call = { cmd: string; args: string[] };

function recorder(
  script: (call: Call, n: number) => { status: number; stdout?: string; stderr?: string },
): { run: SigningRunner; calls: Call[] } {
  const calls: Call[] = [];
  const run: SigningRunner = (cmd, args) => {
    const call = { cmd, args };
    calls.push(call);
    const r = script(call, calls.length);
    return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  };
  return { run, calls };
}

describe("signInstalledBinary", () => {
  it("a refusing egress (test sandbox) forces skipped-sandbox BEFORE any command runs", () => {
    const { run, calls } = recorder(() => ({ status: 0 }));
    // liveEgress() under the preload sandbox env = the refusing handle.
    const outcome = signInstalledBinary(liveEgress(), "/bin/x", run);
    expect(outcome.state).toBe("skipped-sandbox");
    expect(calls.length).toBe(0);
  });

  it("identity present → ONLY find-identity + codesign with the contract CN/identifier", () => {
    const { run, calls } = recorder((c) =>
      c.cmd === "security"
        ? { status: 0, stdout: `1) ABC "${SIGNING_IDENTITY_CN}"` }
        : { status: 0 },
    );
    const outcome = signInstalledBinary(LIVE_LIKE, "/bin/x", run);
    expect(outcome.state).toBe("signed");
    expect(calls.map((c) => c.cmd)).toEqual(["security", "codesign"]);
    const sign = calls[1];
    expect(sign.args).toContain(SIGNING_IDENTITY_CN);
    expect(sign.args).toContain("--identifier");
    expect(sign.args).toContain(SIGNING_IDENTIFIER);
    expect(sign.args).toContain("/bin/x");
  });

  it("identity absent → create (openssl req → pkcs12 → import -T codesign) then sign; reports the one-time event", () => {
    const { run, calls } = recorder((c) =>
      c.cmd === "security" && c.args[0] === "find-identity"
        ? { status: 0, stdout: "0 identities found" }
        : { status: 0 },
    );
    const outcome = signInstalledBinary(LIVE_LIKE, "/bin/x", run);
    expect(outcome.state).toBe("signed-new-identity");
    expect(calls.map((c) => `${c.cmd}:${c.args[0]}`)).toEqual([
      "security:find-identity",
      "/usr/bin/openssl:req",
      "/usr/bin/openssl:pkcs12",
      "security:import",
      "codesign:-f",
    ]);
    // ACL pre-authorization — at most one keychain confirmation ever
    const imp = calls[3];
    expect(imp.args).toContain("-T");
    expect(imp.args).toContain("/usr/bin/codesign");
    // the cert profile carries the codeSigning EKU (contract profile)
    expect(calls[1].args.join(" ")).toContain("extendedKeyUsage=codeSigning");
  });

  it("SOFT failures: identity creation fails → failed-soft, no codesign attempted", () => {
    const { run, calls } = recorder((c) =>
      c.cmd === "security" && c.args[0] === "find-identity"
        ? { status: 0, stdout: "0 identities found" }
        : c.cmd === "/usr/bin/openssl"
          ? { status: 1, stderr: "boom" }
          : { status: 0 },
    );
    const outcome = signInstalledBinary(LIVE_LIKE, "/bin/x", run);
    expect(outcome.state).toBe("failed-soft");
    expect(outcome.detail).toContain("TCC prompts will re-appear");
    expect(calls.some((c) => c.cmd === "codesign")).toBe(false);
  });

  it("SOFT failures: codesign fails → failed-soft with the consequence named", () => {
    const { run } = recorder((c) =>
      c.cmd === "security"
        ? { status: 0, stdout: `"${SIGNING_IDENTITY_CN}"` }
        : { status: 1, stderr: "errSecInternalComponent" },
    );
    const outcome = signInstalledBinary(LIVE_LIKE, "/bin/x", run);
    expect(outcome.state).toBe("failed-soft");
    expect(outcome.detail).toContain("errSecInternalComponent");
    expect(outcome.detail).toContain("TCC prompts will re-appear");
  });
});
