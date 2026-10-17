import { beforeEach, afterEach, describe, it, expect } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { openCodePaths, provisionOpenCodePeer, unprovisionOpenCodePeer, checkOpenCodePeer } from "../src/surfaces/opencode.js";
import { cmdProvisionPeer, cmdUnprovisionPeer } from "../src/commands/provision-peer.js";
import { liveEgress } from "../src/egress.js";

let tmp: string;
let opts: { privateDir: string; personality: string; port: number; binary: string };
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "im-opencode-"));
  opts = { privateDir: path.join(tmp, "priv", "same-peer"), personality: "same-peer", port: 9811, binary: path.join(tmp, "memory") };
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe("runtime-private OpenCode surfaces", () => {
  it("is idempotent, repairs drift, removes only owned data", () => {
    const files = openCodePaths(opts);
    expect(provisionOpenCodePeer(opts).map((o) => o.action)).toEqual(["written", "written"]);
    expect(provisionOpenCodePeer(opts).map((o) => o.action)).toEqual(["already", "already"]);
    expect(checkOpenCodePeer(opts).every((c) => c.ok)).toBe(true);
    const obj = JSON.parse(fs.readFileSync(files.config, "utf-8"));
    obj.mcp.foreign = { type: "remote", url: "http://foreign" };
    obj.plugin.push("file:///foreign.mjs");
    obj.mcp["iapeer-memory"].url = "http://drift";
    fs.writeFileSync(files.config, JSON.stringify(obj));
    expect(checkOpenCodePeer(opts).every((c) => c.ok)).toBe(false);
    provisionOpenCodePeer(opts);
    expect(checkOpenCodePeer(opts).every((c) => c.ok)).toBe(true);
    expect(unprovisionOpenCodePeer(opts).map((o) => o.action)).toEqual(["removed", "removed"]);
    expect(JSON.parse(fs.readFileSync(files.config, "utf-8"))).toEqual({ mcp: { foreign: obj.mcp.foreign }, plugin: ["file:///foreign.mjs"] });
    expect(unprovisionOpenCodePeer(opts).map((o) => o.action)).toEqual(["absent", "absent"]);
  });

  it("does not touch another personality or any cwd surface", () => {
    const other = { ...opts, personality: "other-peer", privateDir: path.join(tmp, "priv", "other-peer") };
    provisionOpenCodePeer(opts);
    provisionOpenCodePeer(other);
    const files = openCodePaths(other);
    const before = fs.readFileSync(files.config, "utf-8");
    unprovisionOpenCodePeer(opts);
    expect(fs.readFileSync(files.config, "utf-8")).toBe(before);
    expect(fs.existsSync(path.join(tmp, "opencode.json"))).toBe(false);
    expect(fs.existsSync(path.join(tmp, ".opencode"))).toBe(false);
  });

  it("refuses foreign plugins and malformed config, keeps referenced hooks on failed remove", () => {
    provisionOpenCodePeer(opts);
    const files = openCodePaths(opts);
    fs.writeFileSync(files.config, "{");
    expect(unprovisionOpenCodePeer(opts)[0].action).toBe("failed");
    expect(fs.existsSync(files.plugin)).toBe(true);
    expect(provisionOpenCodePeer(opts).some((o) => o.action === "failed")).toBe(true);
    fs.writeFileSync(files.plugin, "export default () => ({})");
    expect(provisionOpenCodePeer(opts)[0].action).toBe("failed");
    expect(fs.readFileSync(files.plugin, "utf-8")).toBe("export default () => ({})");
  });

  it("uses exactly the core-given private dir and refuses a relative one", () => {
    expect(openCodePaths({ ...opts, privateDir: "/core/given" }).plugin).toBe("/core/given/iapeer-memory-plugin.mjs");
    expect(() => openCodePaths({ ...opts, privateDir: "relative/dir" })).toThrow();
  });

  it("without IAPEER_PRIVATE_DIR a slot verb asks the core; an unanswered query fails loud (no guessed path)", () => {
    const prev = { d: process.env.IAPEER_PRIVATE_DIR, r: process.env.IAPEER_ROOT };
    delete process.env.IAPEER_PRIVATE_DIR;
    process.env.IAPEER_ROOT = tmp;
    const fake = path.join(tmp, "fake-iapeer");
    try {
      const args = ["--cwd", tmp, "--runtime", "opencode", "--personality", "same-peer", "--iapeer-bin", fake];
      fs.writeFileSync(fake, `#!/bin/sh\n[ "$1" = private-dir ] && [ "$2" = same-peer ] && [ "$4" = opencode ] && { echo "${path.join(tmp, "core-answer")}"; exit 0; }\necho "peer not registered" >&2; exit 1\n`);
      fs.chmodSync(fake, 0o755);
      expect(cmdProvisionPeer(args, liveEgress())).toBe(0);
      expect(fs.existsSync(path.join(tmp, "core-answer", "iapeer-memory.json"))).toBe(true);
      fs.writeFileSync(fake, "#!/bin/sh\necho 'unknown verb' >&2; exit 2\n");
      expect(cmdProvisionPeer([...args.slice(0, 5), "other", ...args.slice(6)], liveEgress())).toBe(1);
      expect(fs.existsSync(path.join(tmp, "state", "opencode"))).toBe(false);
    } finally {
      if (prev.d !== undefined) process.env.IAPEER_PRIVATE_DIR = prev.d;
      if (prev.r === undefined) delete process.env.IAPEER_ROOT; else process.env.IAPEER_ROOT = prev.r;
    }
  });

  it("slot verbs honour the core-supplied IAPEER_PRIVATE_DIR (provision + unprovision)", () => {
    const priv = path.join(tmp, "core-private");
    const prev = { d: process.env.IAPEER_PRIVATE_DIR, r: process.env.IAPEER_ROOT };
    process.env.IAPEER_PRIVATE_DIR = priv;
    process.env.IAPEER_ROOT = tmp;
    try {
      const args = ["--cwd", tmp, "--runtime", "opencode", "--personality", "same-peer"];
      expect(cmdProvisionPeer(args, liveEgress())).toBe(0);
      expect(fs.existsSync(path.join(priv, "iapeer-memory.json"))).toBe(true);
      expect(fs.existsSync(path.join(priv, "iapeer-memory-plugin.mjs"))).toBe(true);
      expect(fs.existsSync(path.join(tmp, "state", "opencode", "same-peer"))).toBe(false);
      expect(cmdUnprovisionPeer(args, liveEgress())).toBe(0);
      expect(fs.existsSync(path.join(priv, "iapeer-memory.json"))).toBe(false);
      process.env.IAPEER_PRIVATE_DIR = "relative/dir";
      expect(cmdProvisionPeer(args, liveEgress())).toBe(1);
    } finally {
      if (prev.d === undefined) delete process.env.IAPEER_PRIVATE_DIR; else process.env.IAPEER_PRIVATE_DIR = prev.d;
      if (prev.r === undefined) delete process.env.IAPEER_ROOT; else process.env.IAPEER_ROOT = prev.r;
    }
  });

  it("rejects traversal and needs personality on BOTH lifecycle verbs", () => {
    expect(() => openCodePaths({ ...opts, personality: "../escape" })).toThrow();
    const args = ["--cwd", tmp, "--runtime", "opencode"];
    expect(cmdProvisionPeer(args, liveEgress())).toBe(2);
    expect(cmdUnprovisionPeer(args, liveEgress())).toBe(2);
  });

  it("loads the materialized plugin and forwards native args, multi-file moves and hints through the CLI", async () => {
    const record = path.join(tmp, "record.json");
    fs.writeFileSync(opts.binary, `#!${process.execPath}\nconst event = await Bun.stdin.json();\nif (process.argv.at(-1) === 'post-write') { await Bun.write(${JSON.stringify(record)}, JSON.stringify(event)); console.log(JSON.stringify({hookSpecificOutput:{additionalContext:'tag teaching'}})); }\n`);
    fs.chmodSync(opts.binary, 0o755);
    provisionOpenCodePeer(opts);
    const plugin = (await import(pathToFileURL(openCodePaths(opts).plugin).href)).default;
    const hooks = await plugin({ directory: tmp });
    for (const tool of ["write", "edit", "apply_patch", "bash"]) {
      const output = { output: "native output" };
      const args = { filePath: "note.md", patchText: "*** Begin Patch" };
      await hooks["tool.execute.after"]({ tool, args, sessionID: "s", callID: "c" }, output);
      expect(JSON.parse(fs.readFileSync(record, "utf-8"))).toEqual({ tool_name: `opencode:${tool}`, tool_input: args, tool_response: "native output", cwd: tmp });
      expect(output.output).toContain("tag teaching");
    }
  });
});
