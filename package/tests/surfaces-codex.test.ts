/**
 * Direct codex MCP surface (ADR-009 v1.2) — project-local
 * `<cwd>/.codex/config.toml` section surgery: our block lands next to
 * foreign sections (the core's `[features] memories = false` lever, operator
 * content), drift is REPLACED (repair duty), removal strips exactly our
 * namespace and leaves the rest byte-stable.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  checkCodexPeer,
  codexConfigPath,
  expectedCodexBlock,
  mergeCodexMcp,
  provisionCodexPeer,
  removeCodexMcp,
  unprovisionCodexPeer,
} from "../src/surfaces/codex.js";
import { liveEgress } from "../src/egress.js";

// Refusing handle (preload sandbox env): the trust spawn SKIPs, file
// surfaces work — exactly the hermetic mode these tests want.
const EG = liveEgress();

let tmp: string;
let cwd: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "im-codex-"));
  cwd = path.join(tmp, "peer");
  fs.mkdirSync(cwd, { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

const configPath = () => codexConfigPath(cwd);
const read = () => fs.readFileSync(configPath(), "utf-8");

describe("codex per-peer MCP block", () => {
  it("creates the config with the expected block on a clean cwd", () => {
    const r = mergeCodexMcp({ cwd, port: 8766 });
    expect(r.action).toBe("written");
    expect(read()).toBe(expectedCodexBlock(8766));
    expect(read()).toContain('url = "http://127.0.0.1:8766/mcp"');
    expect(read()).toContain('"X-IAPeer-Identity" = "PEER_IDENTITY"');
  });

  it("is idempotent (already, zero churn) and re-bakes a changed port", () => {
    mergeCodexMcp({ cwd, port: 8766 });
    const before = read();
    expect(mergeCodexMcp({ cwd, port: 8766 }).action).toBe("already");
    expect(read()).toBe(before);
    expect(mergeCodexMcp({ cwd, port: 9100 }).action).toBe("written");
    expect(read()).toContain("127.0.0.1:9100");
    expect(read()).not.toContain("127.0.0.1:8766");
  });

  it("merges AROUND foreign sections — the core's [features] lever survives byte-stable", () => {
    const foreign = '[features]\nmemories = false\n\n[mcp_servers.other]\nurl = "http://x/"\n';
    fs.mkdirSync(path.dirname(configPath()), { recursive: true });
    fs.writeFileSync(configPath(), foreign);

    mergeCodexMcp({ cwd, port: 8766 });
    const text = read();
    expect(text).toContain("memories = false");
    expect(text).toContain("[mcp_servers.other]");
    expect(text).toContain(`[mcp_servers.iapeer-memory]`);

    const r = removeCodexMcp({ cwd });
    expect(r.action).toBe("removed");
    expect(read()).toBe(foreign); // foreign content byte-identical after our round-trip
  });

  it("repairs a drifted block (mangled url, injected key) — replace, not append", () => {
    mergeCodexMcp({ cwd, port: 8766 });
    const tampered = read()
      .replace("127.0.0.1:8766", "127.0.0.1:1")
      .replace('default_tools_approval_mode = "approve"\n', "");
    fs.writeFileSync(configPath(), tampered);
    expect(checkCodexPeer(EG, { cwd, port: 8766, hooksDir: path.join(cwd, 'hooks-territory') })[0].ok).toBe(false);

    expect(mergeCodexMcp({ cwd, port: 8766 }).action).toBe("written");
    expect(checkCodexPeer(EG, { cwd, port: 8766, hooksDir: path.join(cwd, 'hooks-territory') })[0].ok).toBe(true);
    // exactly one block — the drifted one was removed, not shadowed
    expect(read().split("[mcp_servers.iapeer-memory]").length).toBe(2);
  });

  it("removal of an only-ours config removes the file; absent stays absent", () => {
    provisionCodexPeer(EG, { cwd, port: 8766, hooksDir: path.join(cwd, 'hooks-territory') });
    const r = unprovisionCodexPeer({ cwd });
    expect(r[0].action).toBe("removed");
    expect(fs.existsSync(configPath())).toBe(false);
    expect(unprovisionCodexPeer({ cwd })[0].action).toBe("absent");
  });

  it("check distinguishes missing vs drifted vs ok", () => {
    expect(checkCodexPeer(EG, { cwd, port: 8766, hooksDir: path.join(cwd, 'hooks-territory') })[0].detail).toContain("no codex config");
    fs.mkdirSync(path.dirname(configPath()), { recursive: true });
    fs.writeFileSync(configPath(), "[features]\nmemories = false\n");
    expect(checkCodexPeer(EG, { cwd, port: 8766, hooksDir: path.join(cwd, 'hooks-territory') })[0].detail).toContain("missing");
    mergeCodexMcp({ cwd, port: 8766 });
    expect(checkCodexPeer(EG, { cwd, port: 8766, hooksDir: path.join(cwd, 'hooks-territory') })[0].ok).toBe(true);
  });
});

// ── Ш2: hooks surface + trust pre-seed ───────────────────────────────────────

describe("codex hooks surface (Ш2: file-form hooks + trust-hooks pre-seed)", () => {
  const hooksDir = () => path.join(cwd, "hooks-territory");
  const hooksJson = () => path.join(cwd, ".codex", "hooks.json");

  function fakeIapeer(stdout = "trusted", exitCode = 0): { bin: string; capture: string } {
    const capture = path.join(tmp, "trust-args.txt");
    const bin = path.join(tmp, "fake-iapeer");
    fs.writeFileSync(
      bin,
      `#!/usr/bin/env bash\nprintf '%s\\n' "$@" > "${capture}"\necho "${stdout}"\nexit ${exitCode}\n`,
    );
    fs.chmodSync(bin, 0o755);
    return { bin, capture };
  }

  it("provision writes MCP + hooks.json (both events, NO matcher) + shims; trust SKIPs under the refusing egress", () => {
    const outcomes = provisionCodexPeer(EG, { cwd, port: 8766, hooksDir: hooksDir() });
    expect(outcomes.map((o) => `${o.surface}:${o.action}`)).toEqual([
      "mcp:written",
      "hooks:written",
      "trust:skipped",
    ]);
    const obj = JSON.parse(fs.readFileSync(hooksJson(), "utf-8"));
    for (const event of ["PostToolUse", "SessionStart"]) {
      expect(obj.hooks[event]).toHaveLength(1);
      expect(obj.hooks[event][0].matcher).toBeUndefined(); // identity goes the VERIFIED branch
      expect(obj.hooks[event][0].hooks[0].command).toContain("iapeer-memory.");
    }
    // shims materialised into the package territory, executable
    expect(fs.statSync(path.join(hooksDir(), "iapeer-memory.post-write.sh")).mode & 0o111).toBeTruthy();
    // idempotent re-run: hooks already, trust skipped again
    const again = provisionCodexPeer(EG, { cwd, port: 8766, hooksDir: hooksDir() });
    expect(again.map((o) => `${o.surface}:${o.action}`)).toEqual([
      "mcp:already",
      "hooks:already",
      "trust:skipped",
    ]);
  });

  it("trust pre-seed spawns `trust-hooks <realpath>` (explicit fake bin punches the sandbox legally)", () => {
    const { bin, capture } = fakeIapeer("seeded 2 hook(s)");
    const outcomes = provisionCodexPeer(EG, { cwd, port: 8766, hooksDir: hooksDir(), iapeerBin: bin });
    const trust = outcomes.find((o) => o.surface === "trust")!;
    expect(trust.action).toBe("written");
    const args = fs.readFileSync(capture, "utf-8").trim().split("\n");
    expect(args[0]).toBe("trust-hooks");
    expect(args[1]).toBe(fs.realpathSync(hooksJson()));
    // verb says "already trusted" on the re-run → action mirrors it
    const again = fakeIapeer("already trusted");
    const rerun = provisionCodexPeer(EG, { cwd, port: 8766, hooksDir: hooksDir(), iapeerBin: again.bin });
    expect(rerun.find((o) => o.surface === "trust")!.action).toBe("already");
  });

  it("a failed verb is LOUD (untrusted hooks skip silently in headless — the worst mode)", () => {
    const { bin } = fakeIapeer("unknown command: trust-hooks", 2);
    const outcomes = provisionCodexPeer(EG, { cwd, port: 8766, hooksDir: hooksDir(), iapeerBin: bin });
    const trust = outcomes.find((o) => o.surface === "trust")!;
    expect(trust.action).toBe("failed");
    expect(trust.detail).toContain("UNTRUSTED");
    expect(trust.detail).toContain("0.2.32");
  });

  it("merge preserves FOREIGN hooks; removal strips exactly ours (file removed when only-ours)", () => {
    fs.mkdirSync(path.dirname(hooksJson()), { recursive: true });
    const foreign = {
      hooks: {
        PostToolUse: [{ matcher: "shell", hooks: [{ type: "command", command: "/usr/local/bin/their-hook.sh" }] }],
        Stop: [{ hooks: [{ type: "command", command: "/their/stop.sh" }] }],
      },
    };
    fs.writeFileSync(hooksJson(), JSON.stringify(foreign, null, 2));
    provisionCodexPeer(EG, { cwd, port: 8766, hooksDir: hooksDir() });
    const merged = JSON.parse(fs.readFileSync(hooksJson(), "utf-8"));
    expect(merged.hooks.PostToolUse).toHaveLength(2); // theirs + ours
    expect(merged.hooks.Stop).toHaveLength(1); // untouched
    const r = unprovisionCodexPeer({ cwd });
    expect(r.map((o) => `${o.surface}:${o.action}`)).toEqual(["mcp:removed", "hooks:removed"]);
    const после = JSON.parse(fs.readFileSync(hooksJson(), "utf-8"));
    expect(JSON.stringify(после)).toBe(JSON.stringify(foreign)); // byte-stable round-trip
    // only-ours case: file disappears entirely
    fs.unlinkSync(hooksJson());
    provisionCodexPeer(EG, { cwd, port: 8766, hooksDir: hooksDir() });
    unprovisionCodexPeer({ cwd });
    expect(fs.existsSync(hooksJson())).toBe(false);
  });

  it("checkCodexPeer: hooks entries + trust verdict via --check (visible degradation)", () => {
    const { bin, capture } = fakeIapeer();
    provisionCodexPeer(EG, { cwd, port: 8766, hooksDir: hooksDir(), iapeerBin: bin });
    const ok = checkCodexPeer(EG, { cwd, port: 8766, hooksDir: hooksDir(), iapeerBin: bin });
    expect(ok.map((c) => `${c.surface}:${c.ok}`)).toEqual(["mcp:true", "hooks:true", "trust:true"]);
    expect(fs.readFileSync(capture, "utf-8")).toContain("--check");
    // drifted trust: verb exits 1 → NOT ok, repair hint visible
    const bad = fakeIapeer("drift\tPostToolUse\t<key>", 1);
    const drift = checkCodexPeer(EG, { cwd, port: 8766, hooksDir: hooksDir(), iapeerBin: bad.bin });
    const trust = drift.find((c) => c.surface === "trust")!;
    expect(trust.ok).toBe(false);
    expect(trust.detail).toContain("NOT trusted");
    // sandbox (no bin): trust check SKIPs as ok with the skip detail
    const sbox = checkCodexPeer(EG, { cwd, port: 8766, hooksDir: hooksDir() });
    expect(sbox.find((c) => c.surface === "trust")!.detail).toContain("skipped (test sandbox)");
  });
});
