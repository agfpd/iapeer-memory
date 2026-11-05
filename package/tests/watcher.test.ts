import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { liveEgress } from "../src/egress.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  dreamTimerMessage,
  DREAM_TRIGGER_ID,
  fromIdentity,
  launcherScriptContent,
  patchWakePolicyEphemeral,
  readWatcherTrigger,
  registerWatcher,
  registerTimer,
  unregisterTimer,
  registrationMessage,
  resolveRegistrantRuntime,
  unregisterWatcher,
  writeLauncherScript,
  WATCHER_TRIGGER_ID,
} from "../src/watcher.js";

let tmp: string;

describe("durable trigger reconciliation", () => {
  function profile(triggers: unknown[]) {
    fs.mkdirSync(path.join(tmp, ".iapeer"), { recursive: true });
    fs.writeFileSync(path.join(tmp, ".iapeer", "peer-profile.json"), JSON.stringify({ notifier: { triggers } }));
  }
  // Refusing egress turns an accidental send into a visible failure, without
  // ever contacting the host-global notifier sockets.
  it("identical watcher and absent timer do not send", () => {
    profile([{ role: "event", id: WATCHER_TRIGGER_ID, owner: "index", script: "/launcher", target: "scriber" }]);
    expect(registerWatcher(liveEgress(), { runtime: "codex", launcherPath: "/launcher", registrantCwd: tmp }).detail).toContain("no send");
    expect(unregisterTimer(liveEgress(), { runtime: "codex", id: DREAM_TRIGGER_ID, registrantCwd: tmp }).detail).toContain("no send");
  });
  it("watcher drift, foreign owner and unreadable state still send", () => {
    for (const drift of [{ script: "/old" }, { target: "index" }, { heartbeatSec: 10 }, { owner: "other" }]) {
      profile([{ role: "event", id: WATCHER_TRIGGER_ID, owner: "index", script: "/launcher", target: "scriber", ...drift }]);
      expect(registerWatcher(liveEgress(), { runtime: "codex", launcherPath: "/launcher", registrantCwd: tmp }).suppressed).toBe(true);
    }
    fs.writeFileSync(path.join(tmp, ".iapeer", "peer-profile.json"), "broken");
    expect(unregisterTimer(liveEgress(), { runtime: "codex", id: DREAM_TRIGGER_ID, registrantCwd: tmp }).suppressed).toBe(true);
  });
  it("timer compares schedule, target, payload, gate and topic", () => {
    const message = dreamTimerMessage({ dreamGateScriptPath: "/gate" });
    const desired = { ...JSON.parse(message), role: "time", owner: "index" };
    profile([desired]);
    expect(registerTimer(liveEgress(), { runtime: "codex", message, registrantCwd: tmp }).detail).toContain("no send");
    for (const drift of [{ when: "0 5 * * 1" }, { target: "index" }, { message: "old" }, { check: "/old" }, { topic: "old" }]) {
      profile([{ ...desired, ...drift }]);
      expect(registerTimer(liveEgress(), { runtime: "codex", message, registrantCwd: tmp }).suppressed).toBe(true);
    }
    expect(unregisterTimer(liveEgress(), { runtime: "codex", id: DREAM_TRIGGER_ID, registrantCwd: tmp }).suppressed).toBe(true);
  });
});

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "im-watch-"));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("launcher script", () => {
  it("wraps the stable binary and is executable; idempotent rewrite", () => {
    const launcherPath = path.join(tmp, "memoryd-launcher.sh");
    expect(writeLauncherScript({ launcherPath, binaryPath: "/x/bin/im" })).toBe("written");
    const text = fs.readFileSync(launcherPath, "utf-8");
    expect(text).toContain('exec "/x/bin/im" memoryd');
    expect(fs.statSync(launcherPath).mode & 0o111).toBeTruthy();
    expect(writeLauncherScript({ launcherPath, binaryPath: "/x/bin/im" })).toBe("identical");
    // binary path moved → regenerated (package-owned artifact)
    expect(writeLauncherScript({ launcherPath, binaryPath: "/y/bin/im" })).toBe("written");
    expect(launcherScriptContent("/y/bin/im")).toContain('"/y/bin/im" memoryd');
  });
});

describe("registration message", () => {
  it("event trigger targets the COPYWRITER (inverted pipeline, ADR-015)", () => {
    const msg = JSON.parse(registrationMessage({ script: "/l.sh" }));
    expect(msg).toEqual({ script: "/l.sh", target: "scriber", id: WATCHER_TRIGGER_ID });
  });

  it("dream timer: default weekly cron → dreamweaver, gated by the check script", () => {
    const msg = JSON.parse(
      dreamTimerMessage({ dreamGateScriptPath: "/x/dream-tick-gate.sh" }),
    );
    expect(msg.when).toBe("0 4 * * 1");
    expect(msg.target).toBe("dreamweaver");
    expect(msg.id).toBe(DREAM_TRIGGER_ID);
    expect(msg.check).toBe("/x/dream-tick-gate.sh");
    expect(msg.message).toContain("DREAM_TICK");
    expect(msg.message).toContain("dream-collect");
  });

  it("dream timer: cron is configurable; no check key when no gate path given", () => {
    const msg = JSON.parse(dreamTimerMessage({ cron: "0 5 * * 0" }));
    expect(msg.when).toBe("0 5 * * 0");
    expect(msg.check).toBeUndefined();
  });
});

describe("wake_policy patch (ephemeral scriber)", () => {
  it("merges exactly one key into the core-owned profile; missing starts empty; no-op preserves bytes", () => {
    const cwd = path.join(tmp, "scriber");
    expect(patchWakePolicyEphemeral(cwd)).toBe("written");
    fs.mkdirSync(path.join(cwd, ".iapeer"), { recursive: true });
    fs.writeFileSync(
      path.join(cwd, ".iapeer", "peer-profile.json"),
      JSON.stringify({ personality: "scriber", notifier: { triggers: [] } }),
    );
    expect(patchWakePolicyEphemeral(cwd)).toBe("written");
    const profile = JSON.parse(
      fs.readFileSync(path.join(cwd, ".iapeer", "peer-profile.json"), "utf-8"),
    );
    expect(profile.wake_policy).toBe("ephemeral");
    expect(profile.personality).toBe("scriber"); // foreign keys untouched
    expect(profile.notifier).toEqual({ triggers: [] });
    const file = path.join(cwd, ".iapeer", "peer-profile.json");
    const bytes = fs.readFileSync(file, "utf-8");
    const mtime = fs.statSync(file).mtimeMs;
    expect(patchWakePolicyEphemeral(cwd)).toBe("identical");
    expect(fs.readFileSync(file, "utf-8")).toBe(bytes);
    expect(fs.statSync(file).mtimeMs).toBe(mtime);
  });

  it("fails closed on malformed profiles without changing bytes", () => {
    const dir = path.join(tmp, ".iapeer");
    fs.mkdirSync(dir);
    const file = path.join(dir, "peer-profile.json");
    for (const bytes of ["{broken", "null", "[]"]) {
      fs.writeFileSync(file, bytes);
      expect(() => patchWakePolicyEphemeral(tmp)).toThrow();
      expect(fs.readFileSync(file, "utf-8")).toBe(bytes);
    }
  });

  it("does not bypass the shared lock or steal it by age", () => {
    const dir = path.join(tmp, ".iapeer");
    fs.mkdirSync(dir);
    const file = path.join(dir, "peer-profile.json");
    fs.writeFileSync(file, '{"foreign":{"keep":true}}');
    const lock = path.join(dir, ".peer-profile.lock");
    fs.mkdirSync(lock);
    fs.utimesSync(lock, new Date(0), new Date(0));
    expect(() => patchWakePolicyEphemeral(tmp)).toThrow();
    expect(fs.existsSync(lock)).toBe(true);
    expect(fs.readFileSync(file, "utf-8")).toBe('{"foreign":{"keep":true}}');
  });

  it("reads the latest foreign fields after another writer releases the lock", async () => {
    const dir = path.join(tmp, ".iapeer");
    fs.mkdirSync(dir);
    const file = path.join(dir, "peer-profile.json");
    fs.writeFileSync(file, "{}");
    const lock = path.join(dir, ".peer-profile.lock");
    // A separate process can make progress while the sync patch waits.
    const child = Bun.spawn([process.execPath, "-e", `
      const fs = require("node:fs");
      fs.mkdirSync(${JSON.stringify(lock)});
      fs.writeSync(1, "locked");
      setTimeout(() => {
        fs.writeFileSync(${JSON.stringify(file)}, JSON.stringify({foreign: {revision: 2}}));
        fs.rmdirSync(${JSON.stringify(lock)});
      }, 200);
    `], { stdout: "pipe", stderr: "pipe" });
    try {
      const reader = child.stdout.getReader();
      const ready = await reader.read();
      expect(new TextDecoder().decode(ready.value)).toBe("locked");
      reader.releaseLock();
      expect(patchWakePolicyEphemeral(tmp)).toBe("written");
      expect(await child.exited).toBe(0);
      expect(JSON.parse(fs.readFileSync(file, "utf-8"))).toEqual({
        foreign: { revision: 2 }, wake_policy: "ephemeral",
      });
    } finally {
      child.kill();
      await child.exited;
    }
  });

  it("keeps the memory sandbox belt around the external writer", () => {
    expect(() => patchWakePolicyEphemeral(path.join(os.homedir(), ".iapeer", "peers", "never-write"))).toThrow();
  });
});

describe("iapeer send identity (e2e §A defect: bare personality is rejected)", () => {
  /** Fake iapeer bin capturing argv — the only way to assert the real spawn. */
  function fakeIapeerBin(captureFile: string): string {
    const bin = path.join(tmp, "fake-iapeer");
    fs.writeFileSync(bin, `#!/usr/bin/env bash\nprintf '%s\\n' "$@" > "${captureFile}"\n`);
    fs.chmodSync(bin, 0o755);
    return bin;
  }

  // Deny-by-default: liveEgress() under the preload sandbox env is the
  // refusing handle — the DEFAULT binary never spawns; an EXPLICIT fake bin
  // punches through legally (egress allowance 1). The env-juggling the old
  // per-site fuse forced on these tests is gone.
  const EG = liveEgress();

  it("the refusing egress blocks the DEFAULT binary before any spawn (tests reached the live notifier)", () => {
    // No iapeerBin: the default `iapeer` would hit the LIVE notifier on this
    // host — the refusing handle must stop it before the spawn.
    const sent = registerWatcher(EG, { launcherPath: "/l.sh", runtime: "claude" });
    expect(sent.ok).toBe(false);
    expect(sent.suppressed).toBe(true);
    expect(sent.detail).toContain("suppressed");
  });

  it("fromIdentity builds <runtime>-<personality> — runtime is explicit, never assumed", () => {
    expect(fromIdentity("index", "claude")).toBe("claude-index");
    expect(fromIdentity("index", "codex")).toBe("codex-index");
  });

  it("register sends --from <declared-runtime>-index while the message target stays the personality", () => {
    const capture = path.join(tmp, "args.txt");
    // runtime is the registrant's DECLARED runtime (codex here) — not a hardcoded claude
    const sent = registerWatcher(EG, {
      launcherPath: "/l.sh",
      runtime: "codex",
      iapeerBin: fakeIapeerBin(capture),
    });
    expect(sent.ok).toBe(true);
    const args = fs.readFileSync(capture, "utf-8").trim().split("\n");
    expect(args.slice(0, 4)).toEqual(["send", "watcher", "--from", "codex-index"]);
    const msg = JSON.parse(args[args.indexOf("--message") + 1]);
    expect(msg.target).toBe("scriber"); // EVENT target (inverted pipeline), NOT the identity
  });

  it("unregister sends from the same declared identity with the role-scoped cmd", () => {
    const capture = path.join(tmp, "args.txt");
    const sent = unregisterWatcher(EG, { runtime: "codex", iapeerBin: fakeIapeerBin(capture) });
    expect(sent.ok).toBe(true);
    const args = fs.readFileSync(capture, "utf-8").trim().split("\n");
    expect(args.slice(0, 4)).toEqual(["send", "watcher", "--from", "codex-index"]);
    expect(JSON.parse(args[args.indexOf("--message") + 1])).toEqual({
      cmd: "unregister",
      id: WATCHER_TRIGGER_ID,
    });
  });
});

describe("resolveRegistrantRuntime — declared runtime from the registry (no hardcode)", () => {
  function fakeListBin(json: string): string {
    const bin = path.join(tmp, "fake-list");
    fs.writeFileSync(
      bin,
      `#!/usr/bin/env bash\nif [ "$1" = "list" ]; then echo '${json}'; exit 0; fi\nexit 0\n`,
    );
    fs.chmodSync(bin, 0o755);
    return bin;
  }
  const EG = liveEgress();

  it("returns the registrant's default_runtime (canonical pick for --from)", () => {
    const bin = fakeListBin(
      '[{"personality":"index","default_runtime":"codex","runtimes":[{"runtime":"codex","status":"asleep"}]}]',
    );
    expect(resolveRegistrantRuntime(EG, { iapeerBin: bin })).toBe("codex");
  });

  it("falls back to runtimes[] when default_runtime is absent", () => {
    const bin = fakeListBin('[{"personality":"index","runtimes":[{"runtime":"claude","status":"live"}]}]');
    expect(resolveRegistrantRuntime(EG, { iapeerBin: bin })).toBe("claude");
  });

  it("returns null when the registrant peer is absent — caller degrades, never guesses", () => {
    const bin = fakeListBin('[{"personality":"smoke","default_runtime":"claude"}]');
    expect(resolveRegistrantRuntime(EG, { iapeerBin: bin })).toBeNull();
  });

  it("returns null when the default binary is refused (sandbox) — no spawn, no guess", () => {
    expect(resolveRegistrantRuntime(EG)).toBeNull();
  });
});

describe("readWatcherTrigger — the canonical durable contract", () => {
  function writeProfile(cwd: string, triggers: unknown[]): void {
    fs.mkdirSync(path.join(cwd, ".iapeer"), { recursive: true });
    fs.writeFileSync(
      path.join(cwd, ".iapeer", "peer-profile.json"),
      JSON.stringify({ personality: "index", notifier: { triggers } }),
    );
  }

  it("matches by id+owner+role and ignores foreign/timer entries", () => {
    const cwd = path.join(tmp, "index");
    writeProfile(cwd, [
      { role: "time", id: "other", owner: "index" },
      { role: "event", id: WATCHER_TRIGGER_ID, owner: "someone-else" },
      {
        role: "event",
        id: WATCHER_TRIGGER_ID,
        owner: "index",
        target: "index",
        script: "/launcher.sh",
      },
    ]);
    const t = readWatcherTrigger({ registrantCwd: cwd });
    expect(t).not.toBeNull();
    expect(t!.script).toBe("/launcher.sh");
  });

  it("never throws: missing profile / malformed json / no triggers → null", () => {
    expect(readWatcherTrigger({ registrantCwd: path.join(tmp, "ghost") })).toBeNull();
    const cwd = path.join(tmp, "broken");
    fs.mkdirSync(path.join(cwd, ".iapeer"), { recursive: true });
    fs.writeFileSync(path.join(cwd, ".iapeer", "peer-profile.json"), "{nope");
    expect(readWatcherTrigger({ registrantCwd: cwd })).toBeNull();
  });
});
