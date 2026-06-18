import { describe, it, expect } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { liveEgress, sandboxEnvArmed, IAPEER_BIN } from "../src/egress.js";

// The preload arms BOTH sandbox vars — every liveEgress() in this suite is
// the refusing handle unless a test lifts the env explicitly (and restores).

describe("egress constructor — the ONE env decision point (П2)", () => {
  it("under the armed sandbox env the handle refuses", () => {
    expect(sandboxEnvArmed()).toBe(true);
    expect(liveEgress().refused).toBe(true);
  });

  it("without the env the handle is live (constructed only — nothing spawned)", () => {
    const a = process.env.IAPEER_MEMORY_SUPPRESS_IAP_SEND;
    const b = process.env.IAPEER_TEST_SANDBOX;
    delete process.env.IAPEER_MEMORY_SUPPRESS_IAP_SEND;
    delete process.env.IAPEER_TEST_SANDBOX;
    try {
      expect(liveEgress().refused).toBe(false);
    } finally {
      if (a !== undefined) process.env.IAPEER_MEMORY_SUPPRESS_IAP_SEND = a;
      if (b !== undefined) process.env.IAPEER_TEST_SANDBOX = b;
    }
  });

  it("either belt alone arms the refusal (generic env-stripping)", () => {
    const b = process.env.IAPEER_TEST_SANDBOX;
    delete process.env.IAPEER_TEST_SANDBOX;
    try {
      expect(sandboxEnvArmed()).toBe(true); // SUPPRESS_IAP_SEND still set
    } finally {
      if (b !== undefined) process.env.IAPEER_TEST_SANDBOX = b;
    }
  });
});

describe("refusing handle — deny by default, four explicit allowances", () => {
  const eg = liveEgress();

  it("a PATH-resolved external binary refuses BEFORE the spawn (the default `iapeer` would hit the live host)", () => {
    const r = eg.spawnSync([IAPEER_BIN, "list", "--json"]);
    expect(r.refused).toBe(true);
    expect(r.spawnError).toContain("refused");
    // refusal, not ENOENT: the binary EXISTS on this host — it was never exec'd
  });

  it("allowance 1: an explicitly named binary spawns (the fake-bin test class)", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "im-egress-"));
    try {
      const bin = path.join(tmp, "fake-bin");
      fs.writeFileSync(bin, "#!/usr/bin/env bash\necho ran\n");
      fs.chmodSync(bin, 0o755);
      const r = eg.spawnSync([bin], { explicitBin: true });
      expect(r.refused).toBeUndefined();
      expect(r.exitCode).toBe(0);
      expect(r.stdout.trim()).toBe("ran");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("allowance 2: self-runtime spawns work (binary compile, hook kick) — the child re-refuses via its own env", () => {
    const r = eg.spawnSync([process.execPath, "--version"]);
    expect(r.refused).toBeUndefined();
    expect(r.exitCode).toBe(0);
  });

  it("allowance 3: the `ps` probe works (it FEEDS the verified-kill guard)", () => {
    const r = eg.spawnSync(["ps", "-o", "command=", "-p", String(process.pid)]);
    expect(r.refused).toBeUndefined();
    expect(r.exitCode).toBe(0);
  });

  it("allowance 4: loopback fetch passes to the network layer; non-loopback refuses", async () => {
    // closed loopback port → a NETWORK error, not the refusal message
    await expect(
      eg.fetch("http://127.0.0.1:1/never", { signal: AbortSignal.timeout(500) }),
    ).rejects.not.toThrow("egress refused");
    await expect(eg.fetch("http://example.com/")).rejects.toThrow("egress refused");
  });

  it("a detached spawn of a non-self binary refuses; self-runtime is allowed", () => {
    expect(eg.spawnDetached(["sleep", "1"]).started).toBe(false);
    // no self-runtime detached here: it would actually fork a process
  });

  it("kill never throws: a bogus pid reports undelivered", () => {
    expect(eg.kill(999999999, "SIGTERM").delivered).toBe(false);
  });
});
