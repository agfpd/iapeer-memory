import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { versionMarker } from "@agfpd/iapeer-memory-core";
import { runVerify, DEFAULT_HEARTBEAT_STALE_MS } from "../src/commands/verify.js";
import { memoryPaths, type MemoryPaths } from "../src/paths.js";
import { writeSlot } from "../src/slot.js";
import { liveEgress } from "../src/egress.js";

// Refusing handle under the preload sandbox env; explicit fake bins punch
// through legally (egress allowance 1) — the old env-juggling is gone.
const EG = liveEgress();

const ENV_KEYS = ["IAPEER_MEMORY_VAULT_PATH", "IAPEER_MEMORY_LOCALE"];
let saved: Record<string, string | undefined>;
let tmp: string;
let paths: MemoryPaths;

beforeEach(() => {
  saved = {};
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "im-verify-"));
  fs.mkdirSync(path.join(tmp, "vault"));
  process.env.IAPEER_MEMORY_VAULT_PATH = path.join(tmp, "vault");
  paths = memoryPaths({
    HOME: tmp,
    IAPEER_MEMORY_STATE_DIR: path.join(tmp, "state"),
    IAPEER_MEMORY_CACHE_DIR: path.join(tmp, "cache"),
  });
  fs.mkdirSync(paths.stateDir, { recursive: true });
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  fs.rmSync(tmp, { recursive: true, force: true });
});

function byName(results: ReturnType<typeof runVerify>, name: string) {
  const r = results.find((x) => x.name === name);
  if (!r) throw new Error(`no check named ${name}`);
  return r;
}

describe("runVerify", () => {
  it("config ok when the vault resolves; fail when the env context is broken", () => {
    const ok = runVerify(EG, { paths, version: "1.0.0" });
    expect(byName(ok, "config").status).toBe("ok");

    delete process.env.IAPEER_MEMORY_VAULT_PATH;
    const bad = runVerify(EG, { paths, version: "1.0.0" });
    expect(byName(bad, "config").status).toBe("fail");
    expect(byName(bad, "config").detail).toContain("IAPEER_MEMORY_VAULT_PATH");
  });

  it("fleet-map: missing → fail; repair re-writes from `list --json`; populated → ok", () => {
    const missing = byName(runVerify(EG, { paths, version: "1.0.0" }), "fleet-map");
    expect(missing.status).toBe("fail");
    expect(missing.detail).toContain("fleet map");

    // repair with a fake core bin answering `list --json`
    const bin = path.join(tmp, "fake-iapeer");
    fs.writeFileSync(
      bin,
      `#!/usr/bin/env bash\nprintf '%s' '[{"personality":"boris","cwd":"/x/boris"}]'\n`,
    );
    fs.chmodSync(bin, 0o755);
    const repaired = byName(
      runVerify(EG, { paths, version: "1.0.0", repair: true, iapeerBin: bin }),
      "fleet-map",
    );
    expect(repaired.status).toBe("repaired");
    expect(JSON.parse(fs.readFileSync(paths.fleetMapPath, "utf-8")).peers).toEqual([
      { personality: "boris", cwd: "/x/boris", runtimes: [] },
    ]);

    const ok = byName(runVerify(EG, { paths, version: "1.0.0" }), "fleet-map");
    expect(ok.status).toBe("ok");
    expect(ok.detail).toContain("1 peer(s)");
  });

  it("heartbeat: missing → fail, fresh → ok, stale → fail", () => {
    const missing = runVerify(EG, { paths, version: "1.0.0" });
    expect(byName(missing, "memoryd-heartbeat").status).toBe("fail");
    expect(byName(missing, "memoryd-heartbeat").detail).toContain("not running");

    fs.writeFileSync(paths.heartbeatPath, "beat\n");
    const fresh = runVerify(EG, { paths, version: "1.0.0" });
    expect(byName(fresh, "memoryd-heartbeat").status).toBe("ok");

    const stale = runVerify(EG, {
      paths,
      version: "1.0.0",
      nowMs: Date.now() + DEFAULT_HEARTBEAT_STALE_MS + 60_000,
    });
    expect(byName(stale, "memoryd-heartbeat").status).toBe("fail");
    expect(byName(stale, "memoryd-heartbeat").detail).toContain("stale");
  });

  it("heartbeat: fresh but watch=off → FAIL (audit critical #6 — a degraded daemon must not hide behind a green mtime)", () => {
    fs.writeFileSync(paths.heartbeatPath, "2026-07-03T00:00:00.000Z host watch=off\n");
    const degraded = byName(runVerify(EG, { paths, version: "1.0.0" }), "memoryd-heartbeat");
    expect(degraded.status).toBe("fail");
    expect(degraded.detail).toContain("fs.watch is DOWN");

    // watch=on stays ok — the marker, not mere freshness, decides.
    fs.writeFileSync(paths.heartbeatPath, "2026-07-03T00:00:00.000Z host watch=on\n");
    expect(byName(runVerify(EG, { paths, version: "1.0.0" }), "memoryd-heartbeat").status).toBe("ok");
  });

  it("notifier watcher: skip without an index role; ok/fail by the durable trigger in the index profile", () => {
    // no roles manifest → init has not run → skip
    const skip = byName(runVerify(EG, { paths, version: "1.0.0" }), "notifier-watcher");
    expect(skip.status).toBe("skip");
    expect(skip.detail).toContain("init has not run");

    // index role present, no trigger in its profile → fail
    const indexCwd = path.join(tmp, "peers", "index");
    fs.mkdirSync(path.join(indexCwd, ".iapeer"), { recursive: true });
    fs.writeFileSync(
      paths.rolesManifestPath,
      JSON.stringify({ roles: [{ role: "index", peerCwd: indexCwd, template: "/t.md" }] }),
    );
    const missing = byName(runVerify(EG, { paths, version: "1.0.0" }), "notifier-watcher");
    expect(missing.status).toBe("fail");
    expect(missing.detail).toContain("no iapeer-memory-memoryd trigger");

    // durable trigger present with the EXPECTED launcher script AND the
    // inverted-pipeline target (scriber) → ok
    fs.writeFileSync(
      path.join(indexCwd, ".iapeer", "peer-profile.json"),
      JSON.stringify({
        notifier: {
          triggers: [
            {
              role: "event",
              id: "iapeer-memory-memoryd",
              owner: "index",
              target: "scriber",
              script: paths.launcherPath,
            },
          ],
        },
      }),
    );
    const ok = byName(runVerify(EG, { paths, version: "1.0.0" }), "notifier-watcher");
    expect(ok.status).toBe("ok");

    // legacy target=index (pre-inversion host) → fail with the re-target hint
    fs.writeFileSync(
      path.join(indexCwd, ".iapeer", "peer-profile.json"),
      JSON.stringify({
        notifier: {
          triggers: [
            {
              role: "event",
              id: "iapeer-memory-memoryd",
              owner: "index",
              target: "index",
              script: paths.launcherPath,
            },
          ],
        },
      }),
    );
    const legacy = byName(runVerify(EG, { paths, version: "1.0.0" }), "notifier-watcher");
    expect(legacy.status).toBe("fail");
    expect(legacy.detail).toContain("expected scriber");

    // trigger pointing at a WRONG script (stale launcher) → fail
    fs.writeFileSync(
      path.join(indexCwd, ".iapeer", "peer-profile.json"),
      JSON.stringify({
        notifier: {
          triggers: [
            { role: "event", id: "iapeer-memory-memoryd", owner: "index", script: "/old.sh" },
          ],
        },
      }),
    );
    const stale = byName(runVerify(EG, { paths, version: "1.0.0" }), "notifier-watcher");
    expect(stale.status).toBe("fail");
    expect(stale.detail).toContain("/old.sh");
  });

  it("dream timer: ok by a durable role=time entry; missing/wrong-check → fail", () => {
    const indexCwd = path.join(tmp, "peers", "index");
    fs.mkdirSync(path.join(indexCwd, ".iapeer"), { recursive: true });
    fs.writeFileSync(
      paths.rolesManifestPath,
      JSON.stringify({ roles: [{ role: "index", peerCwd: indexCwd, template: "/t.md" }] }),
    );
    // absent → fail
    fs.writeFileSync(
      path.join(indexCwd, ".iapeer", "peer-profile.json"),
      JSON.stringify({ notifier: { triggers: [] } }),
    );
    let results = runVerify(EG, { paths, version: "1.0.0" });
    expect(byName(results, "dream-timer").status).toBe("fail");

    // present with the right shape → ok
    fs.writeFileSync(
      path.join(indexCwd, ".iapeer", "peer-profile.json"),
      JSON.stringify({
        notifier: {
          triggers: [
            {
              role: "time",
              id: "iapeer-memory-dream-tick",
              owner: "index",
              target: "dreamweaver",
              check: paths.dreamGateScriptPath,
            },
          ],
        },
      }),
    );
    results = runVerify(EG, { paths, version: "1.0.0" });
    expect(byName(results, "dream-timer").status).toBe("ok");

    // drifted check path → fail
    fs.writeFileSync(
      path.join(indexCwd, ".iapeer", "peer-profile.json"),
      JSON.stringify({
        notifier: {
          triggers: [
            {
              role: "time",
              id: "iapeer-memory-dream-tick",
              owner: "index",
              target: "dreamweaver",
              check: "/stale/check.sh",
            },
          ],
        },
      }),
    );
    expect(byName(runVerify(EG, { paths, version: "1.0.0" }), "dream-timer").status).toBe("fail");
  });

  it("doctrines: manifest absent → skip (init has not run)", () => {
    const r = byName(runVerify(EG, { paths, version: "1.0.0" }), "role-doctrines");
    expect(r.status).toBe("skip");
  });

  it("doctrines: stale version → fail; --repair re-renders to the package version (ADR-010)", () => {
    const peerCwd = path.join(tmp, "peer");
    const template = path.join(tmp, "index-doctrine.md");
    fs.mkdirSync(peerCwd, { recursive: true });
    fs.writeFileSync(template, "---\ntitle: tmpl\n---\n# Index role\nDoctrine body.\n");
    fs.writeFileSync(
      paths.rolesManifestPath,
      JSON.stringify({ roles: [{ role: "index", peerCwd, template }] }),
    );

    // No doctrine yet → fail without repair.
    const missing = runVerify(EG, { paths, version: "2.0.0" });
    expect(byName(missing, "doctrine[index]").status).toBe("fail");

    // Repair renders it with the current marker.
    const repaired = runVerify(EG, { paths, version: "2.0.0", repair: true });
    expect(byName(repaired, "doctrine[index]").status).toBe("repaired");
    const rendered = fs.readFileSync(path.join(peerCwd, ".iapeer", "IAPEER.md"), "utf-8");
    expect(rendered.startsWith(versionMarker("2.0.0"))).toBe(true);
    expect(rendered).toContain("Doctrine body.");
    expect(rendered).not.toContain("title: tmpl"); // template frontmatter stripped

    // Re-run: now ok.
    const ok = runVerify(EG, { paths, version: "2.0.0" });
    expect(byName(ok, "doctrine[index]").status).toBe("ok");

    // Package moves on → stale again, repair again.
    const stale = runVerify(EG, { paths, version: "2.1.0" });
    expect(byName(stale, "doctrine[index]").status).toBe("fail");
    expect(byName(stale, "doctrine[index]").detail).toContain("v2.0.0 != package v2.1.0");
  });

  it("doctrines: repair with a missing template stays a fail (never silently ok)", () => {
    const peerCwd = path.join(tmp, "peer");
    fs.mkdirSync(peerCwd, { recursive: true });
    fs.writeFileSync(
      paths.rolesManifestPath,
      JSON.stringify({
        roles: [{ role: "index", peerCwd, template: path.join(tmp, "absent.md") }],
      }),
    );
    const r = byName(runVerify(EG, { paths, version: "1.0.0", repair: true }), "doctrine[index]");
    expect(r.status).toBe("fail");
    expect(r.detail).toContain("template missing");
  });

  it("doctrines: unreadable manifest is a fail, not a crash", () => {
    fs.writeFileSync(paths.rolesManifestPath, "{not json");
    const r = byName(runVerify(EG, { paths, version: "1.0.0" }), "role-doctrines");
    expect(r.status).toBe("fail");
  });

  it("slot: missing on a provisioned host → fail; --repair re-declares with heartbeat", () => {
    const missing = byName(runVerify(EG, { paths, version: "1.0.0" }), "memory-slot");
    expect(missing.status).toBe("fail");

    const repaired = byName(
      runVerify(EG, { paths, version: "1.0.0", repair: true }),
      "memory-slot",
    );
    expect(repaired.status).toBe("repaired");
    const slot = JSON.parse(fs.readFileSync(paths.slotPath, "utf-8"));
    expect(slot.provider).toBe("iapeer-memory");
    expect(slot.version).toBe("1.0.0");
    expect(slot.heartbeat).toBe(paths.heartbeatPath);

    expect(byName(runVerify(EG, { paths, version: "1.0.0" }), "memory-slot").status).toBe("ok");
    // package moved on → version drift is a fail until repaired
    expect(byName(runVerify(EG, { paths, version: "1.1.0" }), "memory-slot").status).toBe("fail");
  });

  it("slot: foreign provider is a fail and NEVER repaired over", () => {
    fs.mkdirSync(path.dirname(paths.slotPath), { recursive: true });
    fs.writeFileSync(
      paths.slotPath,
      JSON.stringify({ provider: "other", package: "@x/o", version: "1", registeredAt: "t" }),
    );
    const r = byName(runVerify(EG, { paths, version: "1.0.0", repair: true }), "memory-slot");
    expect(r.status).toBe("fail");
    expect(r.detail).toContain("foreign");
    expect(JSON.parse(fs.readFileSync(paths.slotPath, "utf-8")).provider).toBe("other");
  });

  it("slot: skip when the host is not provisioned (config failed)", () => {
    delete process.env.IAPEER_MEMORY_VAULT_PATH;
    const r = byName(runVerify(EG, { paths, version: "1.0.0" }), "memory-slot");
    expect(r.status).toBe("skip");
  });

  it("peer-surfaces (ADR-009 v1.2): drifted peer → fail per peer-runtime; --repair re-provisions; then ok", () => {
    // Fixtures BY HAND — never via a repair chain: a repair run with no
    // fleet map queried the LIVE registry and swept the LIVE fleet's cwds;
    // the fleet.ts fuse now refuses, this test stays hermetic.
    writeSlot({
      slotPath: paths.slotPath,
      version: "1.0.0",
      binaryPath: paths.binaryPath,
      heartbeat: paths.heartbeatPath,
    });
    const peerCwd = path.join(tmp, "peer-y");
    fs.mkdirSync(peerCwd, { recursive: true });
    fs.writeFileSync(
      paths.fleetMapPath,
      JSON.stringify({ peers: [{ personality: "y", cwd: peerCwd, runtimes: ["claude"] }] }),
    );

    const bad = runVerify(EG, { paths, version: "1.0.0" });
    expect(byName(bad, "peer-surfaces[y:claude]").status).toBe("fail");

    const repaired = byName(
      runVerify(EG, { paths, version: "1.0.0", repair: true }),
      "peer-surfaces",
    );
    expect(repaired.status).toBe("repaired");
    const mcp = JSON.parse(fs.readFileSync(path.join(peerCwd, ".mcp.json"), "utf-8"));
    expect(mcp.mcpServers["iapeer-memory"].headers["X-IAPeer-Identity"]).toBe("${PEER_IDENTITY:-claude-y}");
    expect(fs.existsSync(path.join(peerCwd, ".claude", "skills", "iapeer-memory-status", "SKILL.md"))).toBe(true);

    expect(byName(runVerify(EG, { paths, version: "1.0.0" }), "peer-surfaces").status).toBe("ok");
  });
});

describe("runVerify — hung-memoryd repair (audit important: the documented no-gap contract)", () => {
  function staleNow(): number {
    return Date.now() + DEFAULT_HEARTBEAT_STALE_MS + 60_000;
  }

  it("stale heartbeat without --repair: fail with the repair hint, nothing signalled", () => {
    fs.writeFileSync(paths.heartbeatPath, "beat\n");
    const r = byName(runVerify(EG, { paths, version: "1.0.0", nowMs: staleNow() }), "memoryd-heartbeat");
    expect(r.status).toBe("fail");
    expect(r.detail).toContain("verify --repair");
  });

  it("--repair terminates a hung memoryd (verified command line) and removes the pid file", async () => {
    // A fake daemon whose command line carries "memoryd" (the verified-kill
    // probe greps for it) and which IGNORES SIGTERM — the deadlocked-event-
    // loop class: the SIGTERM handler exists but never runs. Only the
    // SIGKILL escalation can end it.
    const script = path.join(tmp, "fake-memoryd.sh");
    fs.writeFileSync(script, "#!/bin/sh\ntrap '' TERM\nwhile true; do sleep 1; done\n");
    fs.chmodSync(script, 0o755);
    const daemon = Bun.spawn(["bash", script]);
    try {
      fs.writeFileSync(paths.pidPath, `${daemon.pid}\n`);
      fs.writeFileSync(paths.heartbeatPath, "beat\n");

      const r = byName(
        runVerify(EG, { paths, version: "1.0.0", repair: true, nowMs: staleNow() }),
        "memoryd-heartbeat",
      );
      expect(r.status).toBe("repaired");
      expect(r.detail).toContain("SIGKILL"); // escalation actually happened
      expect(fs.existsSync(paths.pidPath)).toBe(false); // removed AFTER confirmed death
      const exitCode = await daemon.exited;
      expect(exitCode).not.toBe(0);
    } finally {
      daemon.kill("SIGKILL"); // never leave a smoke process behind
    }
  }, 20_000); // the escalation itself holds a 5s SIGTERM grace before SIGKILL

  it("--repair never signals a FOREIGN pid (recycled-pid class) and keeps the pid file", async () => {
    const stranger = Bun.spawn(["sleep", "60"]);
    try {
      fs.writeFileSync(paths.pidPath, `${stranger.pid}\n`);
      fs.writeFileSync(paths.heartbeatPath, "beat\n");
      const r = byName(
        runVerify(EG, { paths, version: "1.0.0", repair: true, nowMs: staleNow() }),
        "memoryd-heartbeat",
      );
      expect(r.status).toBe("fail");
      expect(r.detail).toContain("does not point at a live memoryd");
      expect(fs.existsSync(paths.pidPath)).toBe(true);
      expect(stranger.killed).toBe(false); // untouched
    } finally {
      stranger.kill("SIGKILL");
    }
  });
});

describe("runVerify — stale dream timer when the role is OFF (audit important, docs-contract)", () => {
  const DREAM_KEY = "IAPEER_MEMORY_PROACTIVE_DREAMWEAVER";
  let savedDream: string | undefined;

  beforeEach(() => {
    savedDream = process.env[DREAM_KEY];
    process.env[DREAM_KEY] = "off";
    const indexCwd = path.join(tmp, "peers", "index");
    fs.mkdirSync(path.join(indexCwd, ".iapeer"), { recursive: true });
    fs.writeFileSync(
      paths.rolesManifestPath,
      JSON.stringify({ roles: [{ role: "index", peerCwd: indexCwd, template: "/t.md" }] }),
    );
    fs.writeFileSync(
      path.join(indexCwd, ".iapeer", "peer-profile.json"),
      JSON.stringify({
        notifier: {
          triggers: [
            { role: "event", id: "iapeer-memory-memoryd", owner: "index", target: "scriber", script: paths.launcherPath },
            { role: "time", id: "iapeer-memory-dream-tick", owner: "index", target: "dreamweaver", check: paths.dreamGateScriptPath },
          ],
        },
      }),
    );
  });

  afterEach(() => {
    if (savedDream === undefined) delete process.env[DREAM_KEY];
    else process.env[DREAM_KEY] = savedDream;
  });

  it("role OFF + leftover timer: FAIL (not skip) without repair — the timer would keep waking DreamWeaver", () => {
    const r = byName(runVerify(EG, { paths, version: "1.0.0" }), "dream-timer");
    expect(r.status).toBe("fail");
    expect(r.detail).toContain("role is OFF");
  });

  it("role OFF + leftover timer + --repair: unregister is sent (fake core bin)", () => {
    const bin = path.join(tmp, "fake-iapeer");
    fs.writeFileSync(
      bin,
      `#!/usr/bin/env bash\nif [ "$1" = "list" ]; then printf '%s' '[{"personality":"index","default_runtime":"claude"}]'; fi\n`,
    );
    fs.chmodSync(bin, 0o755);
    const r = byName(
      runVerify(EG, { paths, version: "1.0.0", repair: true, iapeerBin: bin }),
      "dream-timer",
    );
    expect(r.status).toBe("repaired");
    expect(r.detail).toContain("unregistered");
  });

  it("role OFF and NO leftover timer: skip stays a skip", () => {
    const indexCwd = path.join(tmp, "peers", "index");
    fs.writeFileSync(
      path.join(indexCwd, ".iapeer", "peer-profile.json"),
      JSON.stringify({
        notifier: {
          triggers: [
            { role: "event", id: "iapeer-memory-memoryd", owner: "index", target: "scriber", script: paths.launcherPath },
          ],
        },
      }),
    );
    const r = byName(runVerify(EG, { paths, version: "1.0.0" }), "dream-timer");
    expect(r.status).toBe("skip");
  });
});

describe("runVerify — placeholder doctrine is NOT ok (audit important, renders batch)", () => {
  it("current version marker + VAULT_PATH placeholder → fail; repair re-renders with the host fact", () => {
    const peerCwd = path.join(tmp, "peer-ph");
    const template = path.join(tmp, "tmpl.md");
    fs.mkdirSync(path.join(peerCwd, ".iapeer"), { recursive: true });
    fs.writeFileSync(template, "Doctrine body. Vault: {{VAULT_PATH}}\n");
    fs.writeFileSync(
      paths.rolesManifestPath,
      JSON.stringify({ roles: [{ role: "index", peerCwd, template }] }),
    );
    // A doctrine rendered WITHOUT the vault fact but stamped with the
    // CURRENT version — the exact state `render doctrine` used to produce.
    fs.writeFileSync(
      path.join(peerCwd, ".iapeer", "IAPEER.md"),
      `Doctrine body. Vault: <unknown — see IAPEER_MEMORY_VAULT_PATH in the package config.env>\n\n<!-- iapeer-memory doctrine v1.0.0 -->\n`,
    );

    const bad = byName(runVerify(EG, { paths, version: "1.0.0" }), "doctrine[index]");
    expect(bad.status).toBe("fail");
    expect(bad.detail).toContain("placeholder");

    const repaired = byName(
      runVerify(EG, { paths, version: "1.0.0", repair: true }),
      "doctrine[index]",
    );
    expect(repaired.status).toBe("repaired");
    const after = fs.readFileSync(path.join(peerCwd, ".iapeer", "IAPEER.md"), "utf-8");
    expect(after).not.toContain("<unknown");
    expect(after).toContain(process.env.IAPEER_MEMORY_VAULT_PATH!); // the host fact landed
  });
});
