/**
 * Direct claude session surfaces (ADR-009 v1.2) — the acceptance criteria of
 * the form, as tests: provision lands the surfaces; a re-run is idempotent;
 * STAGED DRIFT is repaired; user keys NEXT TO ours are untouched; the
 * un-verb strips ONLY ours (per the surface-ownership requirements).
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  checkClaudePeer,
  expectedHookEntries,
  expectedMcpEntry,
  isOurHookCommand,
  materialiseShims,
  MCP_SERVER_KEY,
  provisionClaudePeer,
  unprovisionClaudePeer,
} from "../src/surfaces/claude.js";
import { withProvisionLock, STALE_MS } from "../src/surfaces/lock.js";
import { SKILL_NAMES, SKILL_BODIES } from "../src/templates/skills.js";
import { main } from "../src/cli.js";

let tmp: string;
let cwd: string;
let hooksDir: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "im-surf-"));
  cwd = path.join(tmp, "peer");
  fs.mkdirSync(cwd, { recursive: true });
  hooksDir = path.join(tmp, "plugins", "iapeer-memory", "hooks");
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

const settingsPath = () => path.join(cwd, ".claude", "settings.json");
const mcpPath = () => path.join(cwd, ".mcp.json");
const skillPath = (name: string) => path.join(cwd, ".claude", "skills", name, "SKILL.md");
const readJson = (p: string) => JSON.parse(fs.readFileSync(p, "utf-8"));

describe("provision on a clean cwd", () => {
  it("lands all three surfaces and materialises executable shims", () => {
    const outcomes = provisionClaudePeer({ cwd, hooksDir, port: 8766, personality: "testpeer" });
    expect(outcomes.map((o) => `${o.surface}:${o.action}`)).toEqual([
      "hooks:written",
      "mcp:written",
      "skills:written",
    ]);

    const settings = readJson(settingsPath());
    expect(settings.hooks.PostToolUse).toEqual([expectedHookEntries(hooksDir).PostToolUse]);
    expect(settings.hooks.SessionStart).toEqual([expectedHookEntries(hooksDir).SessionStart]);

    expect(readJson(mcpPath()).mcpServers[MCP_SERVER_KEY]).toEqual(expectedMcpEntry({ port: 8766, personality: "testpeer" }));
    // identity migrated to env-substitution (cwd-landmine fix):
    // ${PEER_IDENTITY}, not a literal claude-<peer> baked at provision.
    expect(
      readJson(mcpPath()).mcpServers[MCP_SERVER_KEY].headers["X-IAPeer-Identity"],
    ).toBe("${PEER_IDENTITY:-claude-testpeer}");

    for (const name of SKILL_NAMES) {
      expect(fs.readFileSync(skillPath(name), "utf-8")).toBe(SKILL_BODIES[name]);
    }

    for (const shim of ["iapeer-memory.post-write.sh", "iapeer-memory.session-start.sh"]) {
      const stat = fs.statSync(path.join(hooksDir, shim));
      expect(stat.mode & 0o111).toBeGreaterThan(0); // executable
    }
    // ownership lives IN THE DATA: the merged command path carries our mark
    const command = settings.hooks.PostToolUse[0].hooks[0].command as string;
    expect(isOurHookCommand(command)).toBe(true);
    expect(path.isAbsolute(command)).toBe(true);
  });

  it("is idempotent: the second run reports `already` on every surface", () => {
    provisionClaudePeer({ cwd, hooksDir, port: 8766, personality: "testpeer" });
    const before = fs.readFileSync(settingsPath(), "utf-8");
    const second = provisionClaudePeer({ cwd, hooksDir, port: 8766, personality: "testpeer" });
    expect(second.map((o) => o.action)).toEqual(["already", "already", "already"]);
    expect(fs.readFileSync(settingsPath(), "utf-8")).toBe(before); // zero churn
  });
});

describe("user settings next to ours are NEVER clobbered (требование №1)", () => {
  it("merges around foreign keys, hook entries and MCP servers", () => {
    fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
    const foreignHook = {
      matcher: "Bash",
      hooks: [{ type: "command", command: "/Users/x/.local/bin/totp-presence-hook" }],
    };
    fs.writeFileSync(
      settingsPath(),
      JSON.stringify({
        autoMemoryEnabled: false, // the core's native-memory lever
        statusLine: { type: "command", command: "/usr/local/bin/statusline-injector" },
        hooks: { PostToolUse: [foreignHook] },
      }),
    );
    fs.writeFileSync(
      mcpPath(),
      JSON.stringify({ mcpServers: { "user-server": { type: "http", url: "http://x/" } } }),
    );

    provisionClaudePeer({ cwd, hooksDir, port: 8766, personality: "testpeer" });

    const settings = readJson(settingsPath());
    expect(settings.autoMemoryEnabled).toBe(false);
    expect(settings.statusLine.command).toBe("/usr/local/bin/statusline-injector");
    expect(settings.hooks.PostToolUse).toEqual([
      foreignHook,
      expectedHookEntries(hooksDir).PostToolUse,
    ]);

    const mcp = readJson(mcpPath());
    expect(mcp.mcpServers["user-server"].url).toBe("http://x/");
    expect(mcp.mcpServers[MCP_SERVER_KEY]).toEqual(expectedMcpEntry({ port: 8766, personality: "testpeer" }));
  });

  it("refuses to clobber a non-object settings.json / .mcp.json", () => {
    fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
    fs.writeFileSync(settingsPath(), JSON.stringify(["not", "an", "object"]));
    fs.writeFileSync(mcpPath(), "{broken json");
    const outcomes = provisionClaudePeer({ cwd, hooksDir, port: 8766, personality: "testpeer" });
    expect(outcomes.find((o) => o.surface === "hooks")?.action).toBe("failed");
    expect(outcomes.find((o) => o.surface === "mcp")?.action).toBe("failed");
    // the broken files are left byte-identical
    expect(fs.readFileSync(settingsPath(), "utf-8")).toBe(JSON.stringify(["not", "an", "object"]));
    expect(fs.readFileSync(mcpPath(), "utf-8")).toBe("{broken json");
  });
});

describe("staged drift is repaired (требование №2)", () => {
  it("re-writes a mangled hook command, a deleted MCP key and a patched skill", () => {
    provisionClaudePeer({ cwd, hooksDir, port: 8766, personality: "testpeer" });

    // stage drift on every surface
    const settings = readJson(settingsPath());
    settings.hooks.PostToolUse[0].hooks[0].command = "/elsewhere/iapeer-memory.post-write.sh"; // stale shim LOCATION — still ours by basename namespace
    fs.writeFileSync(settingsPath(), JSON.stringify(settings));
    const mcp = readJson(mcpPath());
    delete mcp.mcpServers[MCP_SERVER_KEY];
    fs.writeFileSync(mcpPath(), JSON.stringify(mcp));
    fs.writeFileSync(skillPath(SKILL_NAMES[0]), "tampered");

    const check = checkClaudePeer({ cwd, hooksDir, port: 8766, personality: "testpeer" });
    expect(check.every((c) => !c.ok)).toBe(true);

    const outcomes = provisionClaudePeer({ cwd, hooksDir, port: 8766, personality: "testpeer" });
    expect(outcomes.map((o) => o.action)).toEqual(["written", "written", "written"]);
    expect(checkClaudePeer({ cwd, hooksDir, port: 8766, personality: "testpeer" }).every((c) => c.ok)).toBe(true);

    // the stale-path entry was REPLACED, not duplicated
    const repaired = readJson(settingsPath());
    expect(repaired.hooks.PostToolUse).toHaveLength(1);
  });
});

describe("unprovision strips ONLY ours (mirror symmetry)", () => {
  it("removes our entries, keeps foreign ones, sweeps empty containers", () => {
    fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
    const foreignHook = {
      matcher: "Bash",
      hooks: [{ type: "command", command: "/foreign/hook.sh" }],
    };
    fs.writeFileSync(
      settingsPath(),
      JSON.stringify({ theme: "dark", hooks: { PostToolUse: [foreignHook] } }),
    );
    fs.writeFileSync(
      mcpPath(),
      JSON.stringify({ mcpServers: { keepme: { type: "http", url: "http://x/" } } }),
    );
    fs.mkdirSync(path.join(cwd, ".claude", "skills", "user-skill"), { recursive: true });

    provisionClaudePeer({ cwd, hooksDir, port: 8766, personality: "testpeer" });
    const outcomes = unprovisionClaudePeer({ cwd });
    expect(outcomes.map((o) => `${o.surface}:${o.action}`)).toEqual([
      "hooks:removed",
      "mcp:removed",
      "skills:removed",
    ]);

    const settings = readJson(settingsPath());
    expect(settings.theme).toBe("dark");
    expect(settings.hooks.PostToolUse).toEqual([foreignHook]);
    expect(settings.hooks.SessionStart).toBeUndefined(); // emptied → swept

    const mcp = readJson(mcpPath());
    expect(mcp.mcpServers.keepme).toBeDefined();
    expect(mcp.mcpServers[MCP_SERVER_KEY]).toBeUndefined();

    expect(fs.existsSync(path.join(cwd, ".claude", "skills", "user-skill"))).toBe(true);
    for (const name of SKILL_NAMES) {
      expect(fs.existsSync(skillPath(name))).toBe(false);
    }
  });

  it("on a cwd that was ONLY ours: hooks container gone, .mcp.json file gone, skills dirs swept", () => {
    provisionClaudePeer({ cwd, hooksDir, port: 8766, personality: "testpeer" });
    unprovisionClaudePeer({ cwd });

    const settings = readJson(settingsPath());
    expect(settings.hooks).toBeUndefined(); // our litter swept, file kept (harness-owned)
    expect(fs.existsSync(mcpPath())).toBe(false); // semantically empty → removed
    expect(fs.existsSync(path.join(cwd, ".claude", "skills"))).toBe(false); // empty container swept
  });

  it("is idempotent and safe on a clean/vanished cwd", () => {
    expect(unprovisionClaudePeer({ cwd }).map((o) => o.action)).toEqual([
      "absent",
      "absent",
      "absent",
    ]);
    const gone = path.join(tmp, "vanished");
    expect(unprovisionClaudePeer({ cwd: gone }).map((o) => o.action)).toEqual([
      "absent",
      "absent",
      "absent",
    ]);
  });

  it("removes stale iapeer-memory-* skill dirs of older versions (namespace promise)", () => {
    provisionClaudePeer({ cwd, hooksDir, port: 8766, personality: "testpeer" });
    fs.mkdirSync(path.join(cwd, ".claude", "skills", "iapeer-memory-legacy"), { recursive: true });
    unprovisionClaudePeer({ cwd });
    expect(fs.existsSync(path.join(cwd, ".claude", "skills", "iapeer-memory-legacy"))).toBe(false);
  });
});

describe("ownership is invariant under EVERY path configuration (D4 live catch)", () => {
  it("a hooksDir WITHOUT an iapeer-memory path segment still yields owned entries: no duplication, no false drift", () => {
    // the exact failing configuration: custom IAPEER_MEMORY_CONFIG_FILE at
    // $SB/config.env → hooksDir $SB/hooks (no namespace in the DIRECTORY)
    const bareHooksDir = path.join(tmp, "hooks");
    provisionClaudePeer({ cwd, hooksDir: bareHooksDir, port: 8766, personality: "p" });
    // the directory-segment form read these entries as FOREIGN → re-added on
    // every run; the basename namespace recognises them as ours → `already`
    const second = provisionClaudePeer({ cwd, hooksDir: bareHooksDir, port: 8766, personality: "p" });
    expect(second.find((o) => o.surface === "hooks")?.action).toBe("already");
    const settings = readJson(settingsPath());
    expect(settings.hooks.PostToolUse).toHaveLength(1); // no duplicate
    expect(checkClaudePeer({ cwd, hooksDir: bareHooksDir, port: 8766, personality: "p" })[0].ok).toBe(true);
  });
});

describe("shims", () => {
  it("materialise is bytes-compare idempotent", () => {
    expect(materialiseShims(hooksDir)).toBe("written");
    expect(materialiseShims(hooksDir)).toBe("identical");
    fs.writeFileSync(path.join(hooksDir, "iapeer-memory.post-write.sh"), "drift");
    expect(materialiseShims(hooksDir)).toBe("written");
  });
});

describe("provision lock (parallel-call tolerance, §7 req 3)", () => {
  it("serialises: a held lock times out with a loud detail", () => {
    const stateDir = path.join(tmp, "state");
    fs.mkdirSync(path.join(stateDir, "provision.lock.d"), { recursive: true });
    const r = withProvisionLock({ stateDir, timeoutMs: 200, fn: () => "ran" });
    expect(r.acquired).toBe(false);
    if (!r.acquired) expect(r.detail).toContain("provision lock busy");
  });

  it("breaks a STALE lock (crashed run) and proceeds", () => {
    const stateDir = path.join(tmp, "state");
    const lockDir = path.join(stateDir, "provision.lock.d");
    fs.mkdirSync(lockDir, { recursive: true });
    const old = new Date(Date.now() - STALE_MS - 1000);
    fs.utimesSync(lockDir, old, old);
    const r = withProvisionLock({ stateDir, timeoutMs: 2000, fn: () => "ran" });
    expect(r.acquired).toBe(true);
    if (r.acquired) expect(r.result).toBe("ran");
    expect(fs.existsSync(lockDir)).toBe(false); // released
  });

  it("releases on an exception inside the body", () => {
    const stateDir = path.join(tmp, "state");
    expect(() =>
      withProvisionLock({
        stateDir,
        fn: () => {
          throw new Error("boom");
        },
      }),
    ).toThrow("boom");
    expect(fs.existsSync(path.join(stateDir, "provision.lock.d"))).toBe(false);
  });
});

describe("CLI verbs (argv contract with the core, §7)", () => {
  const env = (overrides: Record<string, string>) => {
    const saved: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(overrides)) {
      saved[k] = process.env[k];
      process.env[k] = v;
    }
    return () => {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    };
  };

  it("usage errors are exit 2: relative cwd, bad runtime, bad occasion, claude without personality", async () => {
    expect(await main(["provision-peer", "--cwd", "rel/path", "--runtime", "claude"])).toBe(2);
    expect(await main(["provision-peer", "--cwd", "/x", "--runtime", "python"])).toBe(2);
    expect(await main(["provision-peer", "--cwd", "/x", "--runtime", "claude", "--occasion", "yolo"])).toBe(2);
    // the literal identity header needs the personality fact (battle form)
    expect(await main(["provision-peer", "--cwd", "/x", "--runtime", "claude"])).toBe(2);
  });

  it("codex runtime provisions the project-local MCP block (D2)", async () => {
    const restore = env({
      IAPEER_ROOT: path.join(tmp, ".iapeer"),
      IAPEER_MEMORY_CONFIG_FILE: path.join(tmp, ".iapeer", "plugins", "iapeer-memory", "config.env"),
      IAPEER_MEMORY_STATE_DIR: path.join(tmp, ".iapeer", "state", "iapeer-memory"),
    });
    try {
      expect(await main(["provision-peer", "--cwd", cwd, "--runtime", "codex"])).toBe(0);
      const config = fs.readFileSync(path.join(cwd, ".codex", "config.toml"), "utf-8");
      expect(config).toContain("[mcp_servers.iapeer-memory]");
      expect(await main(["unprovision-peer", "--cwd", cwd, "--runtime", "codex"])).toBe(0);
      expect(fs.existsSync(path.join(cwd, ".codex", "config.toml"))).toBe(false);
    } finally {
      restore();
    }
  });

  it("happy path provisions through the real binary entry (sandboxed paths)", async () => {
    const restore = env({
      IAPEER_ROOT: path.join(tmp, ".iapeer"),
      IAPEER_MEMORY_CONFIG_FILE: path.join(tmp, ".iapeer", "plugins", "iapeer-memory", "config.env"),
      IAPEER_MEMORY_STATE_DIR: path.join(tmp, ".iapeer", "state", "iapeer-memory"),
    });
    try {
      expect(await main(["provision-peer", "--cwd", cwd, "--runtime", "claude", "--personality", "testpeer", "--occasion", "birth"])).toBe(0);
      expect(fs.existsSync(mcpPath())).toBe(true);
      expect(await main(["unprovision-peer", "--cwd", cwd, "--runtime", "claude", "--occasion", "remove"])).toBe(0);
      expect(fs.existsSync(mcpPath())).toBe(false);
    } finally {
      restore();
    }
  });

  it("provision of a non-existent cwd fails loud (exit 1) — best-effort at the core", async () => {
    expect(await main(["provision-peer", "--cwd", path.join(tmp, "nope"), "--runtime", "claude", "--personality", "x"])).toBe(1);
  });
});

describe("provision lock — owner token + liveness (audit important)", () => {
  it("a token'd lock of a LIVE holder is NOT stale-broken past the age threshold", () => {
    const stateDir = path.join(tmp, "lock-live");
    const lockDir = path.join(stateDir, "provision.lock.d");
    fs.mkdirSync(lockDir, { recursive: true });
    fs.writeFileSync(path.join(lockDir, "owner"), "12345:deadbeef");
    const old = new Date(Date.now() - STALE_MS - 60_000);
    fs.utimesSync(lockDir, old, old); // WAY past the stale age…
    const r = withProvisionLock({
      stateDir,
      timeoutMs: 300,
      pidAlive: () => true, // …but the owner is alive — the long sweep is legit
      fn: () => "won",
    });
    expect(r.acquired).toBe(false); // honoured, not torn from the live holder
    expect(fs.existsSync(lockDir)).toBe(true);
  });

  it("a token'd lock of a DEAD holder IS broken and re-taken", () => {
    const stateDir = path.join(tmp, "lock-dead");
    const lockDir = path.join(stateDir, "provision.lock.d");
    fs.mkdirSync(lockDir, { recursive: true });
    fs.writeFileSync(path.join(lockDir, "owner"), "999999:cafe");
    const old = new Date(Date.now() - STALE_MS - 60_000);
    fs.utimesSync(lockDir, old, old);
    const r = withProvisionLock({
      stateDir,
      timeoutMs: 2_000,
      pidAlive: () => false, // crashed owner
      fn: () => "won",
    });
    expect(r.acquired).toBe(true);
    expect((r as { result: string }).result).toBe("won");
    expect(fs.existsSync(lockDir)).toBe(false); // owned release cleaned up
  });

  it("release is OWNED: a process whose lock was stale-broken never tears down the next holder's lock", () => {
    const stateDir = path.join(tmp, "lock-owned");
    const lockDir = path.join(stateDir, "provision.lock.d");
    const r = withProvisionLock({
      stateDir,
      timeoutMs: 300,
      fn: () => {
        // Mid-body, a peer stale-breaks OUR lock and a NEW holder takes it
        // (simulated): swap the owner token for someone else's.
        fs.writeFileSync(path.join(lockDir, "owner"), "424242:other");
        return "done";
      },
    });
    expect(r.acquired).toBe(true);
    // finally saw a FOREIGN token → left the lock alone (pre-fix: rmdir'd it,
    // letting a third writer in — the cascade).
    expect(fs.existsSync(lockDir)).toBe(true);
    expect(fs.readFileSync(path.join(lockDir, "owner"), "utf-8")).toBe("424242:other");
  });
});
