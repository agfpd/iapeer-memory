import { describe, it, expect } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  sandboxEnvArmed,
  isUnderProdAnchor,
  isHarnessTreeOutsideSandbox,
  sandboxBlocksProdRead,
  assertSandboxWritablePath,
  guardedWriteFileSync,
  guardedRenameSync,
  guardedUnlinkSync,
  guardedRmSync,
} from "../src/fs-guard.js";

// The preload arms both sandbox vars for every test run — the belt below is
// therefore ACTIVE here, exactly as in any `bun test` on a live host.

describe("isUnderProdAnchor — the predicate (checkable without arming a write)", () => {
  const home = os.homedir();

  it("flags every production anchor, including nested paths", () => {
    expect(isUnderProdAnchor(path.join(home, ".iapeer", "cache", "x.db"))).toBe(true);
    expect(isUnderProdAnchor(path.join(home, ".claude", "settings.json"))).toBe(true);
    expect(isUnderProdAnchor(path.join(home, ".codex", "config.toml"))).toBe(true);
    expect(
      isUnderProdAnchor(path.join(home, "Library", "Mobile Documents", "vault", "note.md")),
    ).toBe(true);
  });

  it("does not flag the home dir itself, tmp roots or project dirs", () => {
    expect(isUnderProdAnchor(home)).toBe(false);
    expect(isUnderProdAnchor(os.tmpdir())).toBe(false);
    expect(isUnderProdAnchor(path.join(home, "Projects", "x"))).toBe(false);
    // prefix must respect the path separator: ~/.iapeer-other is NOT ~/.iapeer
    expect(isUnderProdAnchor(path.join(home, ".iapeer-other", "f"))).toBe(false);
  });

  it("resolves relative segments before judging (the ladder-drift class)", () => {
    expect(
      isUnderProdAnchor(path.join(os.tmpdir(), "..", "..", "..") /* climbs out */),
    ).toBe(false); // wherever it lands, judging happens on the RESOLVED path
    expect(isUnderProdAnchor(`${os.homedir()}/Projects/../.iapeer/cache`)).toBe(true);
  });
});

describe("the belt under the armed sandbox env", () => {
  it("the env is armed in this run (preload)", () => {
    expect(sandboxEnvArmed()).toBe(true);
  });

  it("rename is IN the belt: either end under a prod anchor refuses (audit important)", () => {
    const os = require("node:os");
    const prod = `${os.homedir()}/.iapeer/plugins/iapeer-memory/note.md`;
    // data LEAVING a prod location (the archiveStaleNotes class)…
    expect(() => guardedRenameSync(prod, "/tmp/anywhere.md")).toThrow("production anchor");
    // …and data LANDING in one — both ends are asserted.
    expect(() => guardedRenameSync("/tmp/anywhere.md", prod)).toThrow("production anchor");
  });

  it("a write into a prod anchor throws BEFORE touching the disk", () => {
    const target = path.join(os.homedir(), ".iapeer", "fs-guard-must-never-exist");
    expect(() => guardedWriteFileSync(target, "x")).toThrow("production anchor");
    expect(fs.existsSync(target)).toBe(false);
  });

  it("unlink of a prod-anchor path refuses the same way", () => {
    const target = path.join(os.homedir(), ".claude", "fs-guard-must-never-touch");
    expect(() => guardedUnlinkSync(target)).toThrow("production anchor");
  });

  it("tmp-root writes pass — the sandbox keeps working", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fs-guard-"));
    try {
      const f = path.join(dir, "ok.md");
      guardedWriteFileSync(f, "body", "utf-8");
      expect(fs.readFileSync(f, "utf-8")).toBe("body");
      guardedUnlinkSync(f);
      expect(fs.existsSync(f)).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("without the env the assert is pass-through (live init/migrate keep writing where they always did)", () => {
    const a = process.env.IAPEER_MEMORY_SUPPRESS_IAP_SEND;
    const b = process.env.IAPEER_TEST_SANDBOX;
    delete process.env.IAPEER_MEMORY_SUPPRESS_IAP_SEND;
    delete process.env.IAPEER_TEST_SANDBOX;
    try {
      // assert ONLY — no write is performed against the live anchor
      expect(() =>
        assertSandboxWritablePath(path.join(os.homedir(), ".iapeer", "x"), "write"),
      ).not.toThrow();
    } finally {
      if (a !== undefined) process.env.IAPEER_MEMORY_SUPPRESS_IAP_SEND = a;
      if (b !== undefined) process.env.IAPEER_TEST_SANDBOX = b;
    }
  });
});

// v2 segment rule — the residual lane (24/29
// fleet cwds sit OUTSIDE every prod anchor; a fragments/
// surfaces write into `<live-cwd>/.iapeer|.claude|.codex` passed the v1
// anchor belt). Boris acceptance regression: «не-якорное .iapeer/.claude/
// .codex-дерево вне песочницы = отказ».
describe("v2 segment rule — harness trees outside the sandbox roots", () => {
  const home = os.homedir();

  it("flags harness trees in arbitrary cwds (the probe lane: ~/Peers, ~/Projects)", () => {
    expect(
      isHarnessTreeOutsideSandbox(
        path.join(home, "Peers", "boris", ".iapeer", "fragments", "iapeer-memory.md"),
      ),
    ).toBe(true);
    expect(
      isHarnessTreeOutsideSandbox(path.join(home, "Projects", "x", ".claude", "settings.json")),
    ).toBe(true);
    expect(
      isHarnessTreeOutsideSandbox(path.join(home, "Projects", "x", ".codex", "config.toml")),
    ).toBe(true);
  });

  it("does not flag harness trees inside tmp roots, nor non-harness paths anywhere", () => {
    expect(
      isHarnessTreeOutsideSandbox(path.join(os.tmpdir(), "sb", ".iapeer", "peer-profile.json")),
    ).toBe(false);
    expect(isHarnessTreeOutsideSandbox(path.join("/tmp", "sb", ".claude", "settings.json"))).toBe(
      false,
    );
    expect(isHarnessTreeOutsideSandbox(path.join(home, "Projects", "x", "src", "file.ts"))).toBe(
      false,
    );
    // exact segment match only: `.claude-plugin` (repo adapters) is NOT `.claude`
    expect(
      isHarnessTreeOutsideSandbox(path.join(home, "Projects", "x", ".claude-plugin", "plugin.json")),
    ).toBe(false);
  });

  it("an explicit IAPEER_ROOT names a sandbox root — same semantics as the egress --iapeer-bin allowance", () => {
    const prev = process.env.IAPEER_ROOT;
    process.env.IAPEER_ROOT = path.join(home, "sandbox-root");
    try {
      expect(isHarnessTreeOutsideSandbox(path.join(home, "sandbox-root", ".iapeer", "x"))).toBe(
        false,
      );
      expect(isHarnessTreeOutsideSandbox(path.join(home, "elsewhere", ".iapeer", "x"))).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.IAPEER_ROOT;
      else process.env.IAPEER_ROOT = prev;
    }
  });

  it("write/rm into a non-anchor harness tree REFUSES under the armed sandbox, before touching disk", () => {
    const target = path.join(home, "Peers", "fs-guard-victim", ".iapeer", "fragments", "f.md");
    expect(() => guardedWriteFileSync(target, "x")).toThrow("OUTSIDE the sandbox roots");
    expect(fs.existsSync(target)).toBe(false);
    expect(() =>
      guardedRmSync(path.join(home, "Projects", "victim", ".claude", "settings.json")),
    ).toThrow("OUTSIDE the sandbox roots");
  });
});

describe("sandboxBlocksProdRead — read-as-egress parity (И4 precedent)", () => {
  it("blocks prod-anchor state reads under the armed env, passes sandbox paths", () => {
    expect(
      sandboxBlocksProdRead(
        path.join(os.homedir(), ".iapeer", "state", "iapeer-memory", "fleet.json"),
      ),
    ).toBe(true);
    expect(sandboxBlocksProdRead(path.join(os.homedir(), ".iapeer", "memory-provider.json"))).toBe(
      true,
    );
    expect(sandboxBlocksProdRead(path.join(os.tmpdir(), "state", "fleet.json"))).toBe(false);
  });

  it("is inert without the env — live memoryd keeps reading the live map", () => {
    const a = process.env.IAPEER_MEMORY_SUPPRESS_IAP_SEND;
    const b = process.env.IAPEER_TEST_SANDBOX;
    delete process.env.IAPEER_MEMORY_SUPPRESS_IAP_SEND;
    delete process.env.IAPEER_TEST_SANDBOX;
    try {
      expect(
        sandboxBlocksProdRead(
          path.join(os.homedir(), ".iapeer", "state", "iapeer-memory", "fleet.json"),
        ),
      ).toBe(false);
    } finally {
      if (a !== undefined) process.env.IAPEER_MEMORY_SUPPRESS_IAP_SEND = a;
      if (b !== undefined) process.env.IAPEER_TEST_SANDBOX = b;
    }
  });
});
