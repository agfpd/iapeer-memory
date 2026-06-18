import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { bashWriteTargets, bashVaultWriteReminder } from "../src/commands/hook.js";
import { cmdBake } from "../src/commands/bake.js";

const VAULT = "/vault";
const ev = (command: string, cwd?: string) =>
  JSON.stringify({ tool_name: "Bash", tool_input: { command }, ...(cwd ? { cwd } : {}) });
const env = { IAPEER_MEMORY_VAULT_PATH: VAULT, IAPEER_MEMORY_LOCALE: "ru" };

describe("bashWriteTargets — write-TARGET extraction (not reads)", () => {
  it("redirection > and >>", () => {
    expect(bashWriteTargets("echo x > /vault/01_Знания/a.md")).toContain("/vault/01_Знания/a.md");
    expect(bashWriteTargets('echo "y" >> /vault/01_Знания/b.md')).toContain("/vault/01_Знания/b.md");
  });
  it("read + redirect ELSEWHERE → target is the elsewhere, not the read path", () => {
    const t = bashWriteTargets("cat /vault/01_Знания/a.md > /tmp/x");
    expect(t).toContain("/tmp/x");
    expect(t).not.toContain("/vault/01_Знания/a.md"); // the vault path is a READ arg
  });
  it("does not treat 2> (fd redirect) or >& as a file target", () => {
    expect(bashWriteTargets("cmd 2>/dev/null")).not.toContain("/dev/null"); // fd, not a write we care about
  });
  it("tee, sed -i, cp/mv destinations", () => {
    expect(bashWriteTargets("echo x | tee /vault/01_Знания/t.md")).toContain("/vault/01_Знания/t.md");
    expect(bashWriteTargets("sed -i 's/a/b/' /vault/01_Знания/s.md")).toContain("/vault/01_Знания/s.md");
    expect(bashWriteTargets("cp /tmp/src.md /vault/01_Знания/c.md")).toContain("/vault/01_Знания/c.md");
    expect(bashWriteTargets("mv /tmp/src.md /vault/01_Знания/m.md")).toContain("/vault/01_Знания/m.md");
  });
  it("captures a QUOTED path with spaces (the real vault has them)", () => {
    expect(bashWriteTargets('echo x > "/a b/c.md"')).toContain("/a b/c.md");
    expect(bashWriteTargets("echo x > '/a b/c.md'")).toContain("/a b/c.md");
    expect(bashWriteTargets('cmd | tee "/a b/c.md"')).toContain("/a b/c.md");
  });
});

describe("bashVaultWriteReminder — fires only on a vault .md WRITE", () => {
  it("FIRES on a bash write to a vault note, names the file + bake", () => {
    const r = bashVaultWriteReminder(ev("echo x >> /vault/01_Знания/note.md"), env);
    expect(r).toContain("iapeer-memory bake");
    expect(r).toContain("/vault/01_Знания/note.md");
  });
  it("does NOT fire on a read (grep/cat) of a vault note", () => {
    expect(bashVaultWriteReminder(ev("grep foo /vault/01_Знания/note.md"), env)).toBeNull();
    expect(bashVaultWriteReminder(ev("cat /vault/01_Знания/note.md"), env)).toBeNull();
  });
  it("does NOT fire on read-then-redirect-ELSEWHERE", () => {
    expect(bashVaultWriteReminder(ev("cat /vault/01_Знания/note.md > /tmp/x"), env)).toBeNull();
  });
  it("does NOT fire on a write OUTSIDE the vault", () => {
    expect(bashVaultWriteReminder(ev("echo x > /tmp/other.md"), env)).toBeNull();
  });
  it("does NOT fire on a non-.md vault write", () => {
    expect(bashVaultWriteReminder(ev("echo x > /vault/01_Знания/data.txt"), env)).toBeNull();
  });
  it("does NOT fire for a non-Bash tool", () => {
    expect(
      bashVaultWriteReminder(JSON.stringify({ tool_name: "Write", tool_input: { file_path: "/vault/01_Знания/n.md" } }), env),
    ).toBeNull();
  });
  it("resolves a relative target against the event cwd when present", () => {
    const r = bashVaultWriteReminder(ev("echo x > note.md", "/vault/01_Знания"), env);
    expect(r).toContain("iapeer-memory bake");
  });
  it("best-effort: relative target with NO cwd is skipped (no false positive)", () => {
    expect(bashVaultWriteReminder(ev("echo x > note.md"), env)).toBeNull();
  });
  it("fires for a QUOTED spaced vault path (the real vault: '…/Mobile Documents/…')", () => {
    const SPACED = "/Users/x/Mobile Documents/vault";
    const r = bashVaultWriteReminder(
      JSON.stringify({ tool_name: "Bash", tool_input: { command: `echo x >> "${SPACED}/01_Знания/n.md"` } }),
      { IAPEER_MEMORY_VAULT_PATH: SPACED },
    );
    expect(r).toContain("iapeer-memory bake");
    expect(r).toContain(`${SPACED}/01_Знания/n.md`);
  });
});

describe("cmdBake — pure attribution stamp", () => {
  let tmp: string;
  let savedLocale: string | undefined;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "im-bake-"));
    savedLocale = process.env.IAPEER_MEMORY_LOCALE;
    process.env.IAPEER_MEMORY_LOCALE = "ru"; // match the RU note's taxonomy
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
    if (savedLocale === undefined) delete process.env.IAPEER_MEMORY_LOCALE;
    else process.env.IAPEER_MEMORY_LOCALE = savedLocale;
  });

  it("stamps last_edited_by = the agent on a note written past the hook", () => {
    const vault = path.join(tmp, "vault");
    const p = path.join(vault, "01_Знания", "Заметка.md");
    fs.mkdirSync(path.dirname(p), { recursive: true });
    // a note as if written by bash — no agent stamp
    fs.writeFileSync(p, "---\ntitle: Заметка\ntype: знание\nstatus: актуально\nauthor: linus\n---\n\nтело\n");
    const code = cmdBake(["--agent", "boris", "--vault", vault, p]);
    expect(code).toBe(0);
    const text = fs.readFileSync(p, "utf-8");
    expect(text).toContain("last_edited_by: boris"); // attribution fixed to the running agent
    expect(text).toContain("author: linus"); // original author untouched
  });

  it("errors with no files given", () => {
    expect(cmdBake([])).toBe(2);
  });
});
