/**
 * CLI e2e — every test spawns the REAL entry (`bun src/cli.ts …`) in a
 * scrubbed env: all inherited IAPEER_MEMORY_* / PEER_PERSONALITY are
 * stripped (this peer's own session env must not leak into fixtures) and
 * the config file points into the fixture tmpdir — the host's production
 * config can never be read.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const PKG_DIR = path.dirname(import.meta.dir); // package/
let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "im-cli-"));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function scrubbedEnv(overrides: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    if (k.startsWith("IAPEER_MEMORY_") || k === "PEER_PERSONALITY" || k === "IAPEER_ROOT") {
      continue;
    }
    env[k] = v;
  }
  env.IAPEER_MEMORY_CONFIG_FILE = path.join(tmp, "config.env"); // absent by default
  env.IAPEER_MEMORY_STATE_DIR = path.join(tmp, "state");
  env.IAPEER_MEMORY_CACHE_DIR = path.join(tmp, "cache");
  env.IAPEER_MEMORY_LOGS_DIR = path.join(tmp, "logs");
  // The production ~/.iapeer (slot!) and ~/.local/bin must be unreachable
  // from any spawned CLI — same hygiene as the vault isolation.
  env.IAPEER_ROOT = path.join(tmp, "iapeer-root");
  env.IAPEER_MEMORY_BINARY_PATH = path.join(tmp, "bin", "iapeer-memory");
  // П7: the scrub must not RESURRECT the production port default — carry the
  // preload-derived test port into the spawned CLI (explicit overrides win).
  if (process.env.IAPEER_MEMORY_MCP_PORT) {
    env.IAPEER_MEMORY_MCP_PORT = process.env.IAPEER_MEMORY_MCP_PORT;
  }
  return { ...env, ...overrides };
}

function runCli(
  args: string[],
  overrides: Record<string, string> = {},
): { exitCode: number; stdout: string; stderr: string } {
  const proc = Bun.spawnSync(["bun", "src/cli.ts", ...args], {
    cwd: PKG_DIR,
    env: scrubbedEnv(overrides),
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: proc.exitCode,
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
  };
}

function makeVault(): string {
  const vault = path.join(tmp, "vault");
  for (const dir of ["00_Inbox", "01_Knowledge", "03_Projects", "06_Agent_Memory"]) {
    fs.mkdirSync(path.join(vault, dir), { recursive: true });
  }
  return vault;
}

describe("cli basics", () => {
  it("bare invocation prints usage, exit 0", () => {
    const r = runCli([]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("Usage: iapeer-memory");
  });

  it("version prints the package.json version", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(PKG_DIR, "package.json"), "utf-8"));
    const r = runCli(["version"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe(pkg.version);
  });

  it("unknown command → usage on stderr, exit 2", () => {
    const r = runCli(["frobnicate"]);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("unknown command: frobnicate");
  });

  it("init refuses non-tty without --vault; update rejects unknown flags", () => {
    const init = runCli(["init", "--skip-deps", "--skip-ecosystem", "--skip-binary"]);
    expect(init.exitCode).toBe(2);
    expect(init.stderr).toContain("refusing");
    const update = runCli(["update", "--frobnicate"]);
    expect(update.exitCode).toBe(2);
  });

  it("the config file feeds the env context (file fills, explicit env wins)", () => {
    const vault = makeVault();
    fs.writeFileSync(
      path.join(tmp, "config.env"),
      `IAPEER_MEMORY_VAULT_PATH=${vault}\nIAPEER_MEMORY_LOCALE=ru\n`,
    );
    // verify's config check resolves vault+locale from the file alone.
    const r = runCli(["verify"]);
    expect(r.stdout).toContain(`vault ${vault} (locale ru)`);
    // …and an explicit env var beats the file.
    const r2 = runCli(["verify"], { IAPEER_MEMORY_LOCALE: "en" });
    expect(r2.stdout).toContain(`(locale en)`);
  });
});

describe("fm-update command", () => {
  it("structural op + attribution stamp on a permanent-zone note", () => {
    const vault = makeVault();
    const file = path.join(vault, "01_Knowledge", "Note.md");
    fs.writeFileSync(file, "---\ntitle: Note\nstatus: current\n---\n\nBody.\n");
    const r = runCli([
      "fm-update",
      "--agent", "tester",
      "--vault", vault,
      "--set", "status", "deprecated",
      file,
    ]);
    expect(r.exitCode).toBe(0);
    const out = fs.readFileSync(file, "utf-8");
    expect(out).toContain("status: deprecated");
    expect(out).toContain("last_edited_by: tester");
    expect(out).toContain("needs_review: true"); // tester is not in the curator set
    expect(out).toContain("Body.");
  });

  it("--no-stamp applies the op only", () => {
    const vault = makeVault();
    const file = path.join(vault, "01_Knowledge", "Note.md");
    fs.writeFileSync(file, "---\ntitle: Note\n---\n\nBody.\n");
    const r = runCli([
      "fm-update",
      "--agent", "tester",
      "--vault", vault,
      "--no-stamp",
      "--set", "status", "current",
      file,
    ]);
    expect(r.exitCode).toBe(0);
    const out = fs.readFileSync(file, "utf-8");
    expect(out).toContain("status: current");
    expect(out).not.toContain("last_edited_by");
  });

  it("no files → usage error, exit 2", () => {
    const r = runCli(["fm-update", "--agent", "x"]);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("no files");
  });
});

describe("render commands", () => {
  it("render index writes the author index (+full variant) into the state namespace", () => {
    const vault = makeVault();
    fs.writeFileSync(
      path.join(vault, "01_Knowledge", "Fact.md"),
      "---\ntitle: Fact\ntype: knowledge\nstatus: current\nauthor: tester\ncreated: 2026-06-10\n---\n\nA fact.\n",
    );
    const r = runCli(["render", "index", "--agent", "tester"], {
      IAPEER_MEMORY_VAULT_PATH: vault,
    });
    expect(r.exitCode).toBe(0);
    const outFile = path.join(tmp, "state", "indexes", "tester-vault-index.md");
    expect(fs.existsSync(outFile)).toBe(true);
    expect(fs.existsSync(path.join(tmp, "state", "indexes", "tester-vault-index-full.md"))).toBe(true);
    expect(fs.readFileSync(outFile, "utf-8")).toContain("Fact");
  });

  it("render fragment composes paths + author index into the peer's layer-5 file", () => {
    const vault = makeVault();
    fs.writeFileSync(
      path.join(vault, "01_Knowledge", "Fact.md"),
      "---\ntitle: Fact\ntype: knowledge\nstatus: current\nauthor: tester\ncreated: 2026-06-10\n---\n\nA fact.\n",
    );
    const env = { IAPEER_MEMORY_VAULT_PATH: vault };
    expect(runCli(["render", "index", "--agent", "tester"], env).exitCode).toBe(0);

    const peerCwd = path.join(tmp, "peer");
    fs.mkdirSync(peerCwd);
    const r = runCli(
      ["render", "fragment", "--agent", "tester", "--peer-cwd", peerCwd],
      env,
    );
    expect(r.exitCode).toBe(0);
    const fragment = path.join(peerCwd, ".iapeer", "fragments", "iapeer-memory.md");
    expect(fs.existsSync(fragment)).toBe(true);
    const text = fs.readFileSync(fragment, "utf-8");
    expect(text).toContain("<iapeer-memory-paths>");
    expect(text).toContain(`vault: ${vault}`);
    expect(text).toContain("tester-vault-index.md");
    expect(text).toContain("Fact");
  });

  it("render fragment without a rendered index fails loud (no silent index-less fragment)", () => {
    const vault = makeVault();
    const peerCwd = path.join(tmp, "peer");
    fs.mkdirSync(peerCwd);
    const r = runCli(
      ["render", "fragment", "--agent", "tester", "--peer-cwd", peerCwd],
      { IAPEER_MEMORY_VAULT_PATH: vault },
    );
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("render index");
  });

  it("render doctrine stamps the package version marker (ADR-010)", () => {
    const template = path.join(tmp, "tmpl.md");
    fs.writeFileSync(template, "---\nname: index\n---\n# Role\nBody.\n");
    const peerCwd = path.join(tmp, "peer");
    fs.mkdirSync(peerCwd);
    const r = runCli([
      "render", "doctrine",
      "--role", "index",
      "--peer-cwd", peerCwd,
      "--template", template,
    ]);
    expect(r.exitCode).toBe(0);
    const pkg = JSON.parse(fs.readFileSync(path.join(PKG_DIR, "package.json"), "utf-8"));
    const rendered = fs.readFileSync(path.join(peerCwd, ".iapeer", "IAPEER.md"), "utf-8");
    expect(rendered.startsWith(`<!-- iapeer-memory doctrine v${pkg.version} -->`)).toBe(true);
  });

  it("render guide demands an explicit target (fleet safety)", () => {
    const r = runCli(["render", "guide", "--source", path.join(tmp, "g.md")]);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("--target");

    fs.writeFileSync(path.join(tmp, "g.md"), "# Guide\n");
    const target = path.join(tmp, "fake-iapeer");
    const ok = runCli([
      "render", "guide",
      "--source", path.join(tmp, "g.md"),
      "--target", target,
    ]);
    expect(ok.exitCode).toBe(0);
    expect(
      fs.readFileSync(path.join(target, "fragments", "iapeer-memory.md"), "utf-8"),
    ).toBe("# Guide\n");
  });
});

describe("hook command (e2e through the real CLI)", () => {
  function runHook(
    event: string,
    stdinBody: string,
    overrides: Record<string, string> = {},
  ) {
    const proc = Bun.spawnSync(["bun", "src/cli.ts", "hook", event], {
      cwd: PKG_DIR,
      env: scrubbedEnv(overrides),
      stdin: Buffer.from(stdinBody),
      stdout: "pipe",
      stderr: "pipe",
    });
    return {
      exitCode: proc.exitCode,
      stdout: proc.stdout.toString(),
      stderr: proc.stderr.toString(),
    };
  }

  it("post-write stamps a vault note end-to-end", () => {
    const vault = makeVault();
    const file = path.join(vault, "01_Knowledge", "Note.md");
    fs.writeFileSync(file, "---\ntitle: Note\n---\n\nBody.\n");
    const r = runHook(
      "post-write",
      JSON.stringify({ tool_name: "Write", tool_input: { file_path: file } }),
      { IAPEER_MEMORY_VAULT_PATH: vault, PEER_PERSONALITY: "tester" },
    );
    expect(r.exitCode).toBe(0);
    expect(fs.readFileSync(file, "utf-8")).toContain("last_edited_by: tester");
  });

  it("post-write is fail-open: garbage stdin still exits 0", () => {
    const r = runHook("post-write", "this is not json", {});
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe("");
  });

  it("session-start on an unprovisioned host prints the init hint, exit 0", () => {
    const r = runHook("session-start", "{}", {});
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("not provisioned");
  });

  it("unknown hook event → exit 2 (a wiring bug must be loud in dev)", () => {
    const r = runHook("nosuch", "{}", {});
    expect(r.exitCode).toBe(2);
  });
});

describe("migrate command", () => {
  it("dry-run prints the plan and leaves the source intact; --apply migrates with backup", () => {
    const vault = makeVault();
    const source = path.join(tmp, "auto-memory");
    fs.mkdirSync(source, { recursive: true });
    fs.writeFileSync(
      path.join(source, "owner.md"),
      "---\ntype: user\ndescription: facts about the owner\n---\n\nLikes tests.\n",
    );
    fs.writeFileSync(
      path.join(source, "lessons.md"),
      "---\ntype: feedback\ndescription: review feedback\n---\n\nBe precise.\n",
    );
    fs.writeFileSync(path.join(source, "MEMORY.md"), "index file\n");
    const env = { IAPEER_MEMORY_VAULT_PATH: vault, PEER_PERSONALITY: "tester" };

    const dry = runCli(["migrate", "--source", source, "--agent", "tester"], env);
    expect(dry.exitCode).toBe(0);
    expect(dry.stdout).toContain("dry-run");
    expect(dry.stdout).toContain("owner.md: user → person_profile");
    expect(dry.stdout).toContain("lessons.md: feedback → feedback");
    expect(dry.stdout).toContain("system (backup-only): MEMORY.md");
    expect(fs.existsSync(path.join(source, "owner.md"))).toBe(true);

    const apply = runCli(
      ["migrate", "--source", source, "--agent", "tester", "--apply"],
      env,
    );
    expect(apply.exitCode).toBe(0);
    expect(apply.stdout).toContain("2 migrated");
    const target = path.join(vault, "06_Agent_Memory", "tester", "owner.md");
    const migrated = fs.readFileSync(target, "utf-8");
    expect(migrated).toContain("type: agent_memory");
    expect(migrated).toContain("subtype: person_profile");
    expect(migrated).toContain("author: tester");
    expect(migrated).toContain("Likes tests.");
    expect(fs.existsSync(source)).toBe(false); // emptied source dir removed
    // backup landed in the state namespace
    const backups = fs.readdirSync(path.join(tmp, "state", "migrate-backups"));
    expect(backups.length).toBe(1);
  });

  it("missing --source → usage error", () => {
    const r = runCli(["migrate", "--agent", "x"]);
    expect(r.exitCode).toBe(2);
  });
});

describe("uninstall and status commands", () => {
  it("uninstall removes own slot + binary, keeps vault/config, prints the native-memory hint", () => {
    const vault = makeVault();
    const slotPath = path.join(tmp, "iapeer-root", "memory-provider.json");
    fs.mkdirSync(path.dirname(slotPath), { recursive: true });
    fs.writeFileSync(
      slotPath,
      JSON.stringify({ provider: "iapeer-memory", package: "@agfpd/iapeer-memory", version: "0.1.0", registeredAt: "t" }),
    );
    const binPath = path.join(tmp, "bin", "iapeer-memory");
    fs.mkdirSync(path.dirname(binPath), { recursive: true });
    fs.writeFileSync(binPath, "#!/bin/sh\n");
    fs.writeFileSync(path.join(tmp, "config.env"), `IAPEER_MEMORY_VAULT_PATH=${vault}\n`);

    const r = runCli(["uninstall"]);
    expect(r.exitCode).toBe(0);
    expect(fs.existsSync(slotPath)).toBe(false);
    expect(fs.existsSync(binPath)).toBe(false);
    expect(fs.existsSync(path.join(tmp, "config.env"))).toBe(true); // operator-owned
    expect(fs.existsSync(vault)).toBe(true);
    expect(r.stdout).toContain("native");
    expect(r.stdout).toContain("iapeer native-memory on --all");
    // v1.2: the surfaces sweep is attempted (no fleet map in this sandbox →
    // honest skip with the manual recipe); NO legacy plugin line — the slot
    // carries no plugin block
    expect(r.stdout).toContain("surfaces  : fleet map missing/unreadable");
    expect(r.stdout).not.toContain("plugin    :");
  });

  it("uninstall (v1.2 slot + fleet map) strips the direct surfaces of every peer-runtime before the slot falls", () => {
    const slotPath = path.join(tmp, "iapeer-root", "memory-provider.json");
    fs.mkdirSync(path.dirname(slotPath), { recursive: true });
    fs.writeFileSync(
      slotPath,
      JSON.stringify({
        provider: "iapeer-memory", package: "@agfpd/iapeer-memory", version: "0.2.0",
        registeredAt: "t",
        provision: { command: "/b", args: [] }, unprovision: { command: "/b", args: [] },
      }),
    );
    const peerCwd = path.join(tmp, "peer-x");
    fs.mkdirSync(path.join(peerCwd, ".claude", "skills", "iapeer-memory-status"), { recursive: true });
    fs.writeFileSync(path.join(peerCwd, ".claude", "skills", "iapeer-memory-status", "SKILL.md"), "x");
    fs.writeFileSync(
      path.join(peerCwd, ".mcp.json"),
      JSON.stringify({ mcpServers: { "iapeer-memory": { type: "http", url: "http://127.0.0.1:8766/mcp" } } }),
    );
    fs.mkdirSync(path.join(tmp, "state"), { recursive: true });
    fs.writeFileSync(
      path.join(tmp, "state", "fleet.json"),
      JSON.stringify({ peers: [{ personality: "x", cwd: peerCwd, runtimes: ["claude"] }] }),
    );

    const r = runCli(["uninstall"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("surfaces  : stripped from 1/1 peer-runtime(s)");
    expect(fs.existsSync(path.join(peerCwd, ".mcp.json"))).toBe(false);
    expect(fs.existsSync(path.join(peerCwd, ".claude", "skills", "iapeer-memory-status"))).toBe(false);
    expect(fs.existsSync(slotPath)).toBe(false);
  });

  it("bare uninstall (no --iapeer-bin) NEVER spawns a PATH-resolved iapeer under the sandbox", () => {
    // Regression contract (audit 2026-07-02, critical #7): uninstall used to
    // default iapeerBin to "iapeer", which the egress hub took for an
    // operator-NAMED binary (explicitBin, allowance 1) — `bun test` sent LIVE
    // unregisters of the production memoryd watcher + dream timer. Plant a
    // marker-writing `iapeer` at the front of PATH: if the refusing egress is
    // ever bypassed again, the marker appears and this test fails.
    const fakeBinDir = path.join(tmp, "fake-path-bin");
    const marker = path.join(tmp, "iapeer-was-spawned.marker");
    fs.mkdirSync(fakeBinDir, { recursive: true });
    fs.writeFileSync(
      path.join(fakeBinDir, "iapeer"),
      `#!/bin/sh\necho leaked > "${marker}"\necho '[]'\n`,
    );
    fs.chmodSync(path.join(fakeBinDir, "iapeer"), 0o755);

    const r = runCli(["uninstall"], {
      PATH: `${fakeBinDir}:${process.env.PATH ?? ""}`,
    });
    expect(r.exitCode).toBe(0);
    expect(fs.existsSync(marker)).toBe(false); // the doorway stayed shut
    expect(r.stdout).toContain("unregister not sent"); // honest refusal, not silence
  });

  it("uninstall refuses a foreign slot (exit 1, slot intact)", () => {
    const slotPath = path.join(tmp, "iapeer-root", "memory-provider.json");
    fs.mkdirSync(path.dirname(slotPath), { recursive: true });
    fs.writeFileSync(
      slotPath,
      JSON.stringify({ provider: "other", package: "@x/o", version: "1", registeredAt: "t" }),
    );
    const r = runCli(["uninstall"]);
    expect(r.exitCode).toBe(1);
    expect(fs.existsSync(slotPath)).toBe(true);
  });

  it("status aggregates verify + slot + MCP probe and stays read-only", () => {
    const vault = makeVault();
    const r = runCli(["status"], {
      IAPEER_MEMORY_VAULT_PATH: vault,
      IAPEER_MEMORY_MCP_PORT: "39999", // nothing listens there
    });
    expect(r.exitCode).toBe(1); // heartbeat + slot missing → attention needed
    expect(r.stdout).toContain("iapeer-memory v");
    expect(r.stdout).toContain("memory-slot");
    expect(r.stdout).toContain("slot-file");
    expect(r.stdout).toContain("nothing listening on 39999");
    // read-only: no slot file appeared, no repair side-effects
    expect(fs.existsSync(path.join(tmp, "iapeer-root", "memory-provider.json"))).toBe(false);
  });
});

describe("search pipeline visibility (acceptance condition: degradation is never silent)", () => {
  it("status names the search state in every configuration", () => {
    const vault = makeVault();
    // zero-config → BM25-only is a VALID state, named as such
    // Port override: the HOST may run a LIVE memoryd on 8766 —
    // the static-view assertion needs an unused port.
    const r = runCli(["status"], { IAPEER_MEMORY_VAULT_PATH: vault, IAPEER_MEMORY_MCP_PORT: "39998" });
    expect(r.stdout).toMatch(/search.*BM25/);

    // embedding configured (memoryd down → static view) → the line must
    // name the hybrid config AND the vec-index state — never silence.
    const r2 = runCli(["status"], {
      IAPEER_MEMORY_VAULT_PATH: vault,
      IAPEER_MEMORY_EMBEDDING_ENDPOINT: "http://127.0.0.1:1/v1/embeddings",
      IAPEER_MEMORY_MCP_PORT: "39998", // host may run a LIVE memoryd on 8766 (B!)
    });
    expect(r2.stdout).toMatch(/search\s+hybrid configured: BM25 \+ embeddings/);
    expect(r2.stdout).toMatch(/vec index (runtime ok|unavailable)/);
  });
});

describe("install-binary command", () => {
  it("compiles a working standalone binary to --out", () => {
    const out = path.join(tmp, "bin", "iapeer-memory");
    const r = runCli(["install-binary", "--out", out]);
    expect(r.exitCode).toBe(0);
    expect(fs.statSync(out).mode & 0o111).toBeTruthy();
    const ver = Bun.spawnSync([out, "version"], { env: scrubbedEnv() });
    const pkg = JSON.parse(fs.readFileSync(path.join(PKG_DIR, "package.json"), "utf-8"));
    expect(ver.stdout.toString().trim()).toBe(pkg.version);
  }, 30_000);
});

describe("memoryd command", () => {
  it("starts, writes the heartbeat where verify reads it, shuts down cleanly on SIGTERM", async () => {
    const vault = makeVault();
    const proc = Bun.spawn(["bun", "src/cli.ts", "memoryd", "--no-mcp"], {
      cwd: PKG_DIR,
      env: scrubbedEnv({
        IAPEER_MEMORY_VAULT_PATH: vault,
        IAPEER_MEMORY_DB_PATH: path.join(tmp, "cache", "index.db"),
      }),
      stdout: "pipe",
      stderr: "pipe",
    });

    const heartbeat = path.join(tmp, "state", "memoryd.heartbeat");
    const deadline = Date.now() + 10_000;
    while (!fs.existsSync(heartbeat) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(fs.existsSync(heartbeat)).toBe(true);

    proc.kill("SIGTERM");
    const exitCode = await proc.exited;
    expect(exitCode).toBe(0);
    // graceful close removes the heartbeat — verify then reports "not running", not "stale"
    expect(fs.existsSync(heartbeat)).toBe(false);
  }, 20_000);
});
