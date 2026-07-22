/**
 * init/uninstall e2e — the LOCAL half of the install story, fully sandboxed
 * (IAPEER_ROOT + every override in tmp; the ecosystem half — peers/watcher/
 * sweep — needs a live core and is covered by the phase-acceptance live
 * smoke, not unit e2e).
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const PKG_DIR = path.dirname(import.meta.dir);
let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "im-init-"));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function runCli(args: string[], overrides: Record<string, string> = {}) {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    if (k.startsWith("IAPEER_MEMORY_") || k === "PEER_PERSONALITY" || k === "IAPEER_ROOT") continue;
    env[k] = v;
  }
  env.IAPEER_ROOT = path.join(tmp, "iapeer-root");
  // The send-fuse MUST survive the IAPEER_MEMORY_* stripping above — a
  // spawned CLI without it would reach the LIVE notifier (this run was
  // saved only by the IAPEER_ROOT sandbox registry).
  env.IAPEER_MEMORY_SUPPRESS_IAP_SEND = "1";
  env.IAPEER_MEMORY_CONFIG_FILE = path.join(tmp, "config.env");
  env.IAPEER_MEMORY_STATE_DIR = path.join(tmp, "state");
  env.IAPEER_MEMORY_CACHE_DIR = path.join(tmp, "cache");
  env.IAPEER_MEMORY_LOGS_DIR = path.join(tmp, "logs");
  env.IAPEER_MEMORY_BINARY_PATH = path.join(tmp, "bin", "iapeer-memory");
  const proc = Bun.spawnSync(["bun", "src/cli.ts", ...args], {
    cwd: PKG_DIR,
    env: { ...env, ...overrides },
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore", // non-tty by construction
  });
  return { exitCode: proc.exitCode, stdout: proc.stdout.toString(), stderr: proc.stderr.toString() };
}

const LOCAL_FLAGS = ["--skip-deps", "--skip-ecosystem", "--skip-binary"];

describe("init (local half, sandboxed)", () => {
  it("non-tty without --vault → refusal exit 2, nothing provisioned", () => {
    const r = runCli(["init", ...LOCAL_FLAGS]);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("refusing");
    expect(fs.existsSync(path.join(tmp, "config.env"))).toBe(false);
  });

  it("re-init with a DIFFERENT --vault than the host runs with → refusal exit 2 (split-brain guard)", () => {
    // The runtime resolves the vault from config.env/env; doctrines and the
    // host guide render from --vault. A mismatch would send peers writing
    // into a vault nobody indexes (audit important) — init must refuse.
    const oldVault = path.join(tmp, "old-vault");
    fs.mkdirSync(oldVault, { recursive: true });
    const r = runCli(["init", "--vault", path.join(tmp, "new-vault"), "--locale", "en", ...LOCAL_FLAGS], {
      IAPEER_MEMORY_VAULT_PATH: oldVault,
    });
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("split-brain");
    expect(r.stderr).toContain(oldVault); // the recipe names the effective vault
    expect(fs.existsSync(path.join(tmp, "new-vault"))).toBe(false); // no step ran

    // Same path (even via a symlink-free resolve) → proceeds normally.
    const same = runCli(["init", "--vault", oldVault, "--locale", "en", ...LOCAL_FLAGS], {
      IAPEER_MEMORY_VAULT_PATH: oldVault,
    });
    expect(same.exitCode).toBe(0);
  });

  it("flag-driven run provisions vault+config+templates+slot+guide, exit 0", () => {
    const vault = path.join(tmp, "vault");
    const r = runCli(["init", "--vault", vault, "--locale", "ru", "--human", "arthur", ...LOCAL_FLAGS]);
    expect(r.exitCode).toBe(0);

    // vault skeleton (RU preset)
    expect(fs.existsSync(path.join(vault, "01_Знания"))).toBe(true);
    expect(fs.existsSync(path.join(vault, "99_Система", "Теги.md"))).toBe(true);
    // operator config with the answers
    const cfg = fs.readFileSync(path.join(tmp, "config.env"), "utf-8");
    expect(cfg).toContain(`IAPEER_MEMORY_VAULT_PATH=${vault}`);
    expect(cfg).toContain("IAPEER_MEMORY_LOCALE=ru");
    expect(cfg).toContain("IAPEER_MEMORY_HUMAN_NAME=arthur");
    // package-owned templates (templatesDir hangs off the config file's dir)
    expect(fs.existsSync(path.join(tmp, "templates", "ru", "index.md"))).toBe(true);
    // slot declaration (contract schema, v1.2 — the core shells into the
    // provision command at peer birth; NO plugin block, ADR-009 v1.2)
    const slot = JSON.parse(
      fs.readFileSync(path.join(tmp, "iapeer-root", "memory-provider.json"), "utf-8"),
    );
    expect(slot.provider).toBe("iapeer-memory");
    expect(slot.heartbeat).toBe(path.join(tmp, "state", "memoryd.heartbeat"));
    expect(slot.provision.args).toContain("provision-peer");
    expect(slot.provision.args).toContain("{personality}");
    expect(slot.unprovision.args[0]).toBe("unprovision-peer");
    // the fleet rollout itself is ecosystem half — skipped here
    expect(r.stdout).toContain("surfaces");
    expect(r.stdout).toContain("skipped (--skip-ecosystem)");
    // host-wide guide fragment (layer 5) INSIDE the sandbox root
    const guide = fs.readFileSync(
      path.join(tmp, "iapeer-root", "fragments", "iapeer-memory.md"),
      "utf-8",
    );
    expect(guide).toContain("01_Знания");
    // write-path carries the HOST FACT, never a placeholder (the folder
    // segment after it is the guide's wording — не лочим: гайд перепишется)
    expect(guide).toContain(`${vault}/`);
    expect(guide).not.toContain("{{VAULT_PATH}}");
    expect(guide).not.toContain("<vault>");
  });

  it("re-run is idempotent and keeps the operator's config edits", () => {
    const vault = path.join(tmp, "vault");
    expect(runCli(["init", "--vault", vault, "--locale", "en", ...LOCAL_FLAGS]).exitCode).toBe(0);
    fs.appendFileSync(path.join(tmp, "config.env"), "IAPEER_MEMORY_MCP_PORT=9999\n");
    const again = runCli(["init", "--vault", vault, "--locale", "en", ...LOCAL_FLAGS]);
    expect(again.exitCode).toBe(0);
    expect(again.stdout).toContain("(exists)"); // config untouched
    expect(fs.readFileSync(path.join(tmp, "config.env"), "utf-8")).toContain("9999");
  });

  it("a foreign slot makes init fail loudly (exit 1) without touching it", () => {
    const slotPath = path.join(tmp, "iapeer-root", "memory-provider.json");
    fs.mkdirSync(path.dirname(slotPath), { recursive: true });
    fs.writeFileSync(
      slotPath,
      JSON.stringify({ provider: "other", package: "@x/o", version: "1", registeredAt: "t" }),
    );
    const r = runCli(["init", "--vault", path.join(tmp, "v"), "--locale", "en", ...LOCAL_FLAGS]);
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toContain("foreign provider");
    expect(JSON.parse(fs.readFileSync(slotPath, "utf-8")).provider).toBe("other");
  });

  it("ecosystem half (v1.2): surfaces sweep over the fleet, NO memory-plugin on; slot lands in the provision form", () => {
    // Fake core bin: `list --json` returns one claude peer (its cwd inside
    // the sandbox) and records every other invocation together with the slot
    // FORM at call time (v11 = plugin block readable, v12 = provision form).
    const slotPath = path.join(tmp, "iapeer-root", "memory-provider.json");
    const peerCwd = path.join(tmp, "peer-smoke");
    fs.mkdirSync(peerCwd, { recursive: true });
    const capture = path.join(tmp, "calls.txt");
    const bin = path.join(tmp, "fake-iapeer");
    fs.writeFileSync(
      bin,
      `#!/usr/bin/env bash\n` +
        `if [ "$1" = "list" ]; then echo '[{"personality":"smoke","cwd":"${peerCwd}","runtimes":[{"runtime":"claude","status":"asleep"}]}]'; exit 0; fi\n` +
        `FORM=absent; if [ -f "${slotPath}" ]; then if grep -q '"plugin"' "${slotPath}"; then FORM=v11; else FORM=v12; fi; fi\n` +
        `printf '%s|slot=%s\\n' "$*" "$FORM" >> "${capture}"\n`,
    );
    fs.chmodSync(bin, 0o755);

    const r = runCli(
      ["init", "--vault", path.join(tmp, "vault"), "--locale", "en", "--human", "x",
       "--skip-deps", "--skip-binary", "--iapeer-bin", bin],
      // lift BOTH fuses: every call goes to the FAKE bin above, nothing live
      { IAPEER_MEMORY_SUPPRESS_IAP_SEND: "0", IAPEER_TEST_SANDBOX: "0" },
    );
    const calls = fs.readFileSync(capture, "utf-8").trim().split("\n");
    // v1.2: the plugin verb is NEVER invoked on a fresh host…
    expect(calls.some((c) => c.startsWith("memory-plugin"))).toBe(false);
    // …and the native sweep runs after the v1.2 slot is on disk
    expect(calls).toContain("native-memory off --all|slot=v12");

    // fleet map written (the fake peer in it) BEFORE the surfaces sweep…
    const fleet = JSON.parse(fs.readFileSync(path.join(tmp, "state", "fleet.json"), "utf-8"));
    expect(fleet.peers).toEqual([
      { personality: "smoke", cwd: peerCwd, runtimes: ["claude"] },
    ]);
    // …and the sweep actually provisioned the peer's direct surfaces
    expect(r.stdout).toContain("1/1 peer-runtime(s) provisioned");
    const mcp = JSON.parse(fs.readFileSync(path.join(peerCwd, ".mcp.json"), "utf-8"));
    expect(mcp.mcpServers["iapeer-memory"].headers["X-IAPeer-Identity"]).toBe("${PEER_IDENTITY:-claude-smoke}");
    expect(fs.existsSync(path.join(peerCwd, ".claude", "settings.json"))).toBe(true);
    expect(fs.existsSync(path.join(peerCwd, ".claude", "skills", "iapeer-memory-status", "SKILL.md"))).toBe(true);
  });

  it("v1.2 runtime contract: --runtime threads into `iapeer create`, and the watcher never assumes claude", () => {
    // index ABSENT in the registry → init creates it; assert the host runtime is
    // threaded to create, and the watcher refuses to guess (no claude fallback).
    const capture = path.join(tmp, "calls.txt");
    const bin = path.join(tmp, "fake-iapeer");
    fs.writeFileSync(
      bin,
      `#!/usr/bin/env bash\n` +
        `printf '%s\\n' "$*" >> "${capture}"\n` +
        `if [ "$1" = "list" ]; then echo "[]"; exit 0; fi\n` +
        `exit 0\n`,
    );
    fs.chmodSync(bin, 0o755);
    runCli(
      ["init", "--vault", path.join(tmp, "vault"), "--locale", "en", "--human", "x",
       "--runtime", "codex", "--skip-deps", "--skip-binary", "--iapeer-bin", bin],
      { IAPEER_MEMORY_SUPPRESS_IAP_SEND: "0", IAPEER_TEST_SANDBOX: "0" },
    );
    const calls = fs.readFileSync(capture, "utf-8");
    // role peers created WITH the host runtime — not the core's both→claude default
    expect(calls).toContain("create index --runtime codex");
    expect(calls).toContain("create scriber --runtime codex");
    // …and BORN with the canonical role description (В36) — never nameless in `iapeer list`
    expect(calls).toContain("create index --runtime codex --description ");
    expect(calls).toContain("create dreamweaver --runtime codex --description ");
    // ONE runtime end-to-end: the flag also drives the watcher identity directly
    // (no registry round-trip needed), and NEVER the old hardcoded claude-index
    expect(calls).toContain("send watcher --from codex-index");
    expect(calls).not.toContain("--from claude-index");
  });

  it("v1.2 runtime contract: the watcher registers from the index peer's DECLARED runtime (codex), not claude", () => {
    const peerCwd = path.join(tmp, "peer-index");
    fs.mkdirSync(peerCwd, { recursive: true });
    const capture = path.join(tmp, "calls.txt");
    const bin = path.join(tmp, "fake-iapeer");
    fs.writeFileSync(
      bin,
      `#!/usr/bin/env bash\n` +
        `printf '%s\\n' "$*" >> "${capture}"\n` +
        `if [ "$1" = "list" ]; then echo '[{"personality":"index","default_runtime":"codex","cwd":"${peerCwd}","runtimes":[{"runtime":"codex","status":"asleep"}]}]'; exit 0; fi\n` +
        `exit 0\n`,
    );
    fs.chmodSync(bin, 0o755);
    runCli(
      ["init", "--vault", path.join(tmp, "vault"), "--locale", "en", "--human", "x",
       "--skip-deps", "--skip-binary", "--iapeer-bin", bin],
      { IAPEER_MEMORY_SUPPRESS_IAP_SEND: "0", IAPEER_TEST_SANDBOX: "0" },
    );
    const calls = fs.readFileSync(capture, "utf-8");
    expect(calls).toContain("send watcher --from codex-index");
    expect(calls).not.toContain("--from claude-index");
  });

  it("role peer pre-existing with an EMPTY registry description → init backfills via `create --path --description` (В36 re-provision)", () => {
    // index EXISTS in the registry but is nameless (created by a pre-0.4.17
    // init); scriber/dreamweaver are absent and get born with a description.
    const peerCwd = path.join(tmp, "peer-index");
    fs.mkdirSync(peerCwd, { recursive: true });
    const capture = path.join(tmp, "calls.txt");
    const bin = path.join(tmp, "fake-iapeer");
    fs.writeFileSync(
      bin,
      `#!/usr/bin/env bash\n` +
        `printf '%s\\n' "$*" >> "${capture}"\n` +
        `if [ "$1" = "list" ]; then echo '[{"personality":"index","cwd":"${peerCwd}","description":"","runtimes":[{"runtime":"claude","status":"asleep"}]}]'; exit 0; fi\n` +
        `exit 0\n`,
    );
    fs.chmodSync(bin, 0o755);
    runCli(
      ["init", "--vault", path.join(tmp, "vault"), "--locale", "en", "--human", "x",
       "--skip-deps", "--skip-binary", "--iapeer-bin", bin],
      { IAPEER_MEMORY_SUPPRESS_IAP_SEND: "0", IAPEER_TEST_SANDBOX: "0" },
    );
    const calls = fs.readFileSync(capture, "utf-8");
    // the nameless EXISTING peer is re-described at its REGISTRY cwd — and
    // never re-created blank (no bare `create index` without a description)
    expect(calls).toContain(`create index --path ${peerCwd} --description `);
    expect(calls).not.toMatch(/^create index$/m);
    // absent role peers are born WITH the description in the same run
    expect(calls).toContain("create scriber --description ");
    expect(calls).toContain("create dreamweaver --description ");
  });

  it("v1.2 runtime contract: no agentic runtime → graceful BM25-only degrade (exit 0 + advisory)", () => {
    const bin = path.join(tmp, "fake-iapeer");
    // `create` fails like iapeer on a no-runtime host; `list` is empty.
    fs.writeFileSync(
      bin,
      `#!/usr/bin/env bash\n` +
        `if [ "$1" = "list" ]; then echo "[]"; exit 0; fi\n` +
        `if [ "$1" = "create" ]; then echo "no agentic runtime installed (Claude Code or Codex CLI)" >&2; exit 1; fi\n` +
        `exit 0\n`,
    );
    fs.chmodSync(bin, 0o755);
    const r = runCli(
      ["init", "--vault", path.join(tmp, "vault"), "--locale", "en", "--human", "x",
       "--skip-deps", "--skip-binary", "--iapeer-bin", bin],
      { IAPEER_MEMORY_SUPPRESS_IAP_SEND: "0", IAPEER_TEST_SANDBOX: "0" },
    );
    expect(r.exitCode).toBe(0); // graceful: base provisioned, role peers wait on a runtime
    expect(r.stdout).toContain("no agentic runtime installed");
    expect(r.stdout).toContain("verify --repair");
    // Contract with onboard: it re-reads the slot to report state. The base IS
    // functional on degrade, so the slot MUST be declared (else onboard
    // mis-reports provider-init-failed). Declared in the functional v1.2 form.
    const slot = JSON.parse(
      fs.readFileSync(path.join(tmp, "iapeer-root", "memory-provider.json"), "utf-8"),
    );
    expect(slot.provider).toBe("iapeer-memory");
    expect(slot.provision.args[0]).toBe("provision-peer");
  });

  it("after init, verify on the same env goes green for the local checks", () => {
    const vault = path.join(tmp, "vault");
    runCli(["init", "--vault", vault, "--locale", "en", ...LOCAL_FLAGS]);
    const v = runCli(["verify"], { IAPEER_MEMORY_VAULT_PATH: vault, IAPEER_MEMORY_LOCALE: "en" });
    expect(v.stdout).toMatch(/ok\s+config/);
    expect(v.stdout).toMatch(/ok\s+memory-slot/);
    // heartbeat fails (memoryd not running) — expected; roles skipped (--skip-ecosystem)
    expect(v.stdout).toContain("memoryd-heartbeat");
  });
});

describe("update (ADR-010: every surface, sandboxed)", () => {
  it("re-renders stale doctrines, re-declares the slot version; idempotent re-run", () => {
    const vault = path.join(tmp, "vault");
    expect(runCli(["init", "--vault", vault, "--locale", "en", ...LOCAL_FLAGS]).exitCode).toBe(0);

    // simulate drift: a roles manifest whose doctrine is missing + an old slot version
    const peerCwd = path.join(tmp, "peers", "index");
    fs.mkdirSync(peerCwd, { recursive: true });
    fs.mkdirSync(path.join(tmp, "state"), { recursive: true });
    fs.writeFileSync(
      path.join(tmp, "state", "roles.json"),
      JSON.stringify({
        roles: [
          {
            role: "index",
            peerCwd,
            template: path.join(tmp, "templates", "en", "index.md"),
          },
        ],
      }),
    );
    const slotPath = path.join(tmp, "iapeer-root", "memory-provider.json");
    const oldSlot = JSON.parse(fs.readFileSync(slotPath, "utf-8"));
    fs.writeFileSync(slotPath, JSON.stringify({ ...oldSlot, version: "0.0.1" }));

    // fleet source = fake bin (hermetic by construction)
    const bin = path.join(tmp, "fake-iapeer");
    fs.writeFileSync(bin, `#!/usr/bin/env bash\nif [ "$1" = "list" ]; then echo "[]"; exit 0; fi\nexit 0\n`);
    fs.chmodSync(bin, 0o755);

    const r = runCli(["update", "--skip-binary", "--iapeer-bin", bin], {
      IAPEER_MEMORY_VAULT_PATH: vault,
      IAPEER_MEMORY_LOCALE: "en",
    });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("index: written");
    const pkg = JSON.parse(
      fs.readFileSync(path.join(PKG_DIR, "package.json"), "utf-8"),
    ) as { version: string };
    const doctrine = fs.readFileSync(path.join(peerCwd, ".iapeer", "IAPEER.md"), "utf-8");
    expect(doctrine).toContain(`<!-- iapeer-memory doctrine v${pkg.version} -->`);
    expect(JSON.parse(fs.readFileSync(slotPath, "utf-8")).version).toBe(pkg.version);

    // idempotent: second run → identical everywhere, still exit 0
    const again = runCli(["update", "--skip-binary", "--iapeer-bin", bin], {
      IAPEER_MEMORY_VAULT_PATH: vault,
      IAPEER_MEMORY_LOCALE: "en",
    });
    expect(again.exitCode).toBe(0);
    expect(again.stdout).toContain("index: identical");
    expect(again.stdout).toMatch(/slot\s+identical/);
  });

  it("a foreign slot is never updated over", () => {
    const slotPath = path.join(tmp, "iapeer-root", "memory-provider.json");
    fs.mkdirSync(path.dirname(slotPath), { recursive: true });
    fs.writeFileSync(
      slotPath,
      JSON.stringify({ provider: "other", package: "@x/o", version: "1", registeredAt: "t" }),
    );
    const r = runCli(["update", "--skip-binary"]);
    expect(r.exitCode).toBe(1);
    expect(JSON.parse(fs.readFileSync(slotPath, "utf-8")).provider).toBe("other");
  });
});

describe("uninstall stops memoryd by pid file (defensive kill contract)", () => {
  it("SIGTERMs a live process whose command is VERIFIED as memoryd, removes the pid file", async () => {
    // a fake daemon whose command line contains "memoryd" (like the real one)
    const fakeScript = path.join(tmp, "fake-memoryd.sh");
    fs.writeFileSync(fakeScript, "#!/bin/sh\nsleep 60\n");
    fs.chmodSync(fakeScript, 0o755);
    const daemon = Bun.spawn(["bash", fakeScript]);
    try {
      const stateDir = path.join(tmp, "state");
      fs.mkdirSync(stateDir, { recursive: true });
      fs.writeFileSync(path.join(stateDir, "memoryd.pid"), `${daemon.pid}\n`);

      const r = runCli(["uninstall", "--iapeer-bin", "/nonexistent/iapeer"]);
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain(`SIGTERM sent to pid ${daemon.pid}`);
      expect(r.stdout).toContain("unregister not sent"); // no core in the sandbox — honest
      expect(fs.existsSync(path.join(stateDir, "memoryd.pid"))).toBe(false);

      const exitCode = await daemon.exited;
      expect(exitCode).not.toBe(0); // killed, not completed
    } finally {
      daemon.kill("SIGKILL"); // never leave a smoke process behind
    }
  });

  it("a pid file pointing at a FOREIGN process is never signalled (recycled-pid class)", async () => {
    const stranger = Bun.spawn(["sleep", "60"]);
    try {
      const stateDir = path.join(tmp, "state");
      fs.mkdirSync(stateDir, { recursive: true });
      fs.writeFileSync(path.join(stateDir, "memoryd.pid"), `${stranger.pid}\n`);

      const r = runCli(["uninstall", "--iapeer-bin", "/nonexistent/iapeer"]);
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain("NOT signalling");
      expect(fs.existsSync(path.join(stateDir, "memoryd.pid"))).toBe(false); // stale file cleared

      // the stranger is still alive — prove it, then clean up ourselves
      expect(stranger.killed).toBe(false);
      process.kill(stranger.pid, 0); // would throw if it had been killed
    } finally {
      stranger.kill("SIGKILL");
    }
  });
});
