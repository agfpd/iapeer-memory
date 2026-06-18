import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import {
  KICK_DEBOUNCE_MS,
  runPostWrite,
  runSessionStart,
  collectDedupAndLinkHints,
  mergeHookOutput,
} from "../src/commands/hook.js";
import { memoryPaths, type MemoryPaths } from "../src/paths.js";
import { liveEgress } from "../src/egress.js";

let tmp: string;
let vault: string;
let paths: MemoryPaths;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "im-hook-"));
  vault = path.join(tmp, "vault");
  for (const dir of ["00_Inbox", "01_Knowledge", path.join("06_Agent_Memory", "tester")]) {
    fs.mkdirSync(path.join(vault, dir), { recursive: true });
  }
  paths = memoryPaths({
    HOME: tmp,
    IAPEER_MEMORY_STATE_DIR: path.join(tmp, "state"),
    IAPEER_MEMORY_CONFIG_FILE: path.join(tmp, "config.env"),
  });
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function env(extra: Record<string, string> = {}): Record<string, string | undefined> {
  return {
    IAPEER_MEMORY_VAULT_PATH: vault,
    PEER_PERSONALITY: "tester",
    ...extra,
  };
}

function writeEvent(tool: string, filePath: string): string {
  return JSON.stringify({ tool_name: tool, tool_input: { file_path: filePath } });
}

describe("hook post-write", () => {
  it("stamps a vault note through the shared fill (last_edited_by + needs_review)", () => {
    const file = path.join(vault, "01_Knowledge", "Note.md");
    fs.writeFileSync(file, "---\ntitle: Note\n---\n\nBody.\n");
    const r = runPostWrite(writeEvent("Write", file), env());
    expect(r.stamped).toBe(true);
    const out = fs.readFileSync(file, "utf-8");
    expect(out).toContain("last_edited_by: tester");
    expect(out).toContain("needs_review: true");
  });

  it("non-write tools are gated out first (codex sends post_tool_use for EVERY tool)", () => {
    const file = path.join(vault, "01_Knowledge", "Note.md");
    fs.writeFileSync(file, "---\ntitle: Note\n---\n");
    for (const tool of ["Bash", "Read", "Glob", "mcp__something"]) {
      expect(runPostWrite(writeEvent(tool, file), env()).stamped).toBe(false);
    }
    expect(fs.readFileSync(file, "utf-8")).not.toContain("last_edited_by");
  });

  it("files outside the vault are never touched", () => {
    const outside = path.join(tmp, "elsewhere.md");
    fs.writeFileSync(outside, "---\ntitle: X\n---\n");
    const r = runPostWrite(writeEvent("Write", outside), env());
    expect(r.stamped).toBe(false);
    expect(fs.readFileSync(outside, "utf-8")).not.toContain("last_edited_by");
  });

  it("no identity → no stamp (deliberate divergence: never guess from cwd)", () => {
    const file = path.join(vault, "01_Knowledge", "Note.md");
    fs.writeFileSync(file, "---\ntitle: Note\n---\n");
    const r = runPostWrite(writeEvent("Write", file), {
      IAPEER_MEMORY_VAULT_PATH: vault,
    });
    expect(r.stamped).toBe(false);
    expect(fs.readFileSync(file, "utf-8")).not.toContain("last_edited_by");
  });

  it("Write into the author's OWN agent-memory folder is SILENT on success (lean §2.3)", () => {
    // The guard stamps but says NOTHING on a correct write — the pre-lean
    // canon-vs-memory reminder was per-write noise; that guidance lives in the
    // guide now. Author-facing output is reserved for problems (L1).
    const file = path.join(vault, "06_Agent_Memory", "tester", "My note.md");
    fs.writeFileSync(file, "---\nsubtype: context\ndescription: x\n---\n\nBody.\n");
    const r = runPostWrite(writeEvent("Write", file), env());
    expect(r.stamped).toBe(true);
    expect(r.output).toBeNull();
  });

  it("Edit in own memory is silent too", () => {
    const file = path.join(vault, "06_Agent_Memory", "tester", "My note.md");
    fs.writeFileSync(file, "---\nsubtype: context\ndescription: x\n---\n");
    const r = runPostWrite(writeEvent("Edit", file), env());
    expect(r.stamped).toBe(true);
    expect(r.output).toBeNull();
  });

  it("Write into ANOTHER agent's memory folder stamps but does not remind", () => {
    fs.mkdirSync(path.join(vault, "06_Agent_Memory", "other"), { recursive: true });
    const file = path.join(vault, "06_Agent_Memory", "other", "Note.md");
    fs.writeFileSync(file, "---\nsubtype: context\ndescription: x\n---\n");
    const r = runPostWrite(writeEvent("Write", file), env());
    expect(r.stamped).toBe(true);
    expect(r.output).toBeNull();
  });

  it("malformed event JSON and missing files are silent no-ops", () => {
    expect(runPostWrite("{not json", env()).stamped).toBe(false);
    const ghost = path.join(vault, "01_Knowledge", "Ghost.md");
    expect(runPostWrite(writeEvent("Write", ghost), env()).stamped).toBe(false);
  });
});

describe("hook post-write — tag gate (lean §3)", () => {
  function seedDict() {
    fs.mkdirSync(path.join(vault, "99_System"), { recursive: true });
    fs.writeFileSync(
      path.join(vault, "99_System", "Tags.md"),
      "# Tags\n\n| Tag | Boundary |\n|---|---|\n| Память | memory |\n| Безопасность | — |\n",
    );
  }
  function teaching(r: ReturnType<typeof runPostWrite>): string {
    return r.output ? JSON.parse(r.output).hookSpecificOutput.additionalContext : "";
  }
  function canon(tagsBlock: string): string {
    const file = path.join(vault, "01_Knowledge", "K.md");
    fs.writeFileSync(file, `---\ntitle: K\n${tagsBlock}---\n\nBody.\n`);
    return file;
  }

  it("unknown tag → teaching to register it first; note still stamped", () => {
    seedDict();
    const file = canon("tags:\n  - security\n");
    const r = runPostWrite(writeEvent("Edit", file), env());
    expect(r.stamped).toBe(true);
    expect(teaching(r)).toContain('"security"');
    expect(teaching(r)).toContain("register it");
  });

  it("valid tag → SILENT (nothing to fix)", () => {
    seedDict();
    const file = canon("tags:\n  - Память\n");
    const r = runPostWrite(writeEvent("Edit", file), env());
    expect(r.stamped).toBe(true);
    expect(r.output).toBeNull();
  });

  it("canon note with no tags → teaching ≥1 tag", () => {
    seedDict();
    const file = canon("");
    const r = runPostWrite(writeEvent("Write", file), env());
    expect(teaching(r)).toContain("no tags");
  });

  it("operative note is NOT gated (operative carries no tags)", () => {
    seedDict();
    const file = path.join(vault, "06_Agent_Memory", "tester", "Op.md");
    fs.writeFileSync(file, "---\nsubtype: context\ndescription: x\n---\n\nBody.\n");
    const r = runPostWrite(writeEvent("Write", file), env());
    expect(r.output).toBeNull();
  });

  it("dictionary absent → FAIL-OPEN (no gate, silent) even with no tags", () => {
    const file = canon(""); // no dict seeded
    const r = runPostWrite(writeEvent("Write", file), env());
    expect(r.stamped).toBe(true);
    expect(r.output).toBeNull();
  });

  it("codex apply_patch RECEIVES the tag teaching too (codex supports PostToolUse additionalContext)", () => {
    seedDict();
    const file = canon("tags:\n  - security\n");
    const ev = JSON.stringify({
      tool_name: "apply_patch",
      tool_input: { command: ["apply_patch"] },
      tool_response: `Success. Updated the following files:\nM ${file}`,
    });
    const r = runPostWrite(ev, env());
    expect(r.stamped).toBe(true);
    expect(teaching(r)).toContain('"security"'); // uniform: same channel/schema as claude
  });
});

describe("hook post-write — dedup + link hints (lean §3a/§3b)", () => {
  // mock /dedup returning given matches; returns a started server + its port
  async function mockDedup(matches: Array<{ path: string; title: string; similarity: number }>) {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ enabled: true, matches }));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    return { server, port: String((server.address() as { port: number }).port) };
  }

  it("mergeHookOutput combines tag + dup + link bands (or null when all empty)", () => {
    const tag = JSON.stringify({
      hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: "TAGMSG" },
    });
    expect(mergeHookOutput(null, { dup: [], link: [] })).toBeNull();
    expect(JSON.parse(mergeHookOutput(tag, { dup: [], link: [] })!).hookSpecificOutput.additionalContext).toBe("TAGMSG");

    const dupOnly = JSON.parse(mergeHookOutput(null, { dup: ["[[D]] (90%)"], link: [] })!)
      .hookSpecificOutput.additionalContext;
    expect(dupOnly).toContain("[[D]] (90%)");
    expect(dupOnly).toContain("possible duplicate");

    const linkOnly = JSON.parse(mergeHookOutput(null, { dup: [], link: ["[[L]] (72%)"] })!)
      .hookSpecificOutput.additionalContext;
    expect(linkOnly).toContain("[[L]] (72%)");
    expect(linkOnly).toContain("consider linking");

    const all = JSON.parse(mergeHookOutput(tag, { dup: ["[[D]] (90%)"], link: ["[[L]] (72%)"] })!)
      .hookSpecificOutput.additionalContext;
    expect(all).toContain("TAGMSG");
    expect(all).toContain("[[D]] (90%)");
    expect(all).toContain("[[L]] (72%)");
  });

  it("classifies matches into dup (≥0.78) and link [0.68,0.78) bands; <0.68 dropped", async () => {
    const { server, port } = await mockDedup([
      { path: "01_Knowledge/Dup.md", title: "Dup", similarity: 0.91 }, // dup
      { path: "01_Knowledge/Link.md", title: "Link", similarity: 0.72 }, // link
      { path: "01_Knowledge/Far.md", title: "Far", similarity: 0.6 }, // below — memoryd would not return; guard anyway
    ]);
    try {
      const file = path.join(vault, "01_Knowledge", "K.md");
      fs.writeFileSync(file, "---\ntitle: K\n---\nтело про гибридный поиск");
      const r = await collectDedupAndLinkHints(
        writeEvent("Edit", file),
        liveEgress(),
        env({ IAPEER_MEMORY_MCP_PORT: port }),
      );
      expect(r.dup).toEqual(["[[Dup]] (91%)"]);
      expect(r.link).toEqual(["[[Link]] (72%)"]);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it("reaches BOTH runtimes (claude Edit + codex apply_patch) — uniform delivery", async () => {
    const { server, port } = await mockDedup([
      { path: "01_Knowledge/Сосед.md", title: "Сосед", similarity: 0.91 },
    ]);
    try {
      const file = path.join(vault, "01_Knowledge", "K.md");
      fs.writeFileSync(file, "---\ntitle: K\n---\nтело");
      const e = env({ IAPEER_MEMORY_MCP_PORT: port });
      const claude = await collectDedupAndLinkHints(writeEvent("Edit", file), liveEgress(), e);
      expect(claude.dup).toEqual(["[[Сосед]] (91%)"]);
      const codexEv = JSON.stringify({
        tool_name: "apply_patch",
        tool_input: { command: ["apply_patch"] },
        tool_response: `Success. Updated the following files:\nM ${file}`,
      });
      const codex = await collectDedupAndLinkHints(codexEv, liveEgress(), e);
      expect(codex.dup).toEqual(["[[Сосед]] (91%)"]); // same hint, same channel
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it("self-guard filters the querying note despite NFC/NFD path mismatch (iCloud NFD vs tool NFC)", async () => {
    // «й» decomposes in NFD → a raw basename === leaked the note as its own duplicate.
    const baseNfc = "Зайка.md".normalize("NFC");
    const fileNfc = path.join(vault, "01_Knowledge", baseNfc); // tool passes NFC
    fs.writeFileSync(fileNfc, "---\ntitle: Зайка\n---\nтело про дедуп");
    // memoryd returns the SAME note with an NFD path (the FS/iCloud form)
    const { server, port } = await mockDedup([
      { path: `01_Knowledge/${baseNfc.normalize("NFD")}`, title: "Зайка", similarity: 0.95 },
    ]);
    try {
      const r = await collectDedupAndLinkHints(
        writeEvent("Edit", fileNfc),
        liveEgress(),
        env({ IAPEER_MEMORY_MCP_PORT: port }),
      );
      expect(r.dup).toEqual([]); // self-match must be filtered, not flagged as a duplicate
      expect(r.link).toEqual([]);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it("operative-zone write is not deduped (canon-only)", async () => {
    const file = path.join(vault, "06_Agent_Memory", "tester", "Op.md");
    fs.writeFileSync(file, "---\nsubtype: context\n---\nтело");
    expect(await collectDedupAndLinkHints(writeEvent("Write", file), liveEgress(), env())).toEqual({
      dup: [],
      link: [],
    });
  });

  it("canon write with memoryd unreachable → empty (fail-open, never hangs the write)", async () => {
    const file = path.join(vault, "01_Knowledge", "K.md");
    fs.writeFileSync(file, "---\ntitle: K\n---\nтело для дедупа");
    const r = await collectDedupAndLinkHints(
      writeEvent("Write", file),
      liveEgress(),
      env({ IAPEER_MEMORY_MCP_PORT: "59997" }),
    );
    expect(r).toEqual({ dup: [], link: [] });
  });
});

describe("hook session-start", () => {
  it("unprovisioned host → one-line init hint, no repair kick", () => {
    const r = runSessionStart({ paths, env: {} });
    expect(r.output).toContain("not provisioned");
    expect(r.output).toContain("init");
    expect(r.kicked).toBe(false);
  });

  it("fresh heartbeat → fully silent", () => {
    fs.mkdirSync(paths.stateDir, { recursive: true });
    fs.writeFileSync(paths.heartbeatPath, "beat\n");
    const r = runSessionStart({ paths, env: env() });
    expect(r.output).toBeNull();
    expect(r.kicked).toBe(false);
  });

  it("missing heartbeat → degraded warning + background repair kick", () => {
    let kicks = 0;
    const r = runSessionStart({ paths, env: env(), kick: () => kicks++ });
    expect(r.output).toContain("degraded");
    expect(r.output).toContain("not running");
    expect(r.kicked).toBe(true);
    expect(kicks).toBe(1);
    expect(fs.existsSync(path.join(paths.stateDir, "verify-kick.stamp"))).toBe(true);
  });

  it("stale heartbeat → degraded warning (hung daemon)", () => {
    fs.mkdirSync(paths.stateDir, { recursive: true });
    fs.writeFileSync(paths.heartbeatPath, "beat\n");
    const r = runSessionStart({
      paths,
      env: env(),
      nowMs: Date.now() + 10 * 60_000,
      kick: () => {},
    });
    expect(r.output).toContain("stale");
  });

  it("kick is debounced — simultaneous peer wakes must not storm repairs", () => {
    let kicks = 0;
    const now = Date.now();
    runSessionStart({ paths, env: env(), nowMs: now, kick: () => kicks++ });
    const second = runSessionStart({
      paths,
      env: env(),
      nowMs: now + 1000,
      kick: () => kicks++,
    });
    expect(kicks).toBe(1);
    expect(second.kicked).toBe(false);
    expect(second.output).toContain("recently");

    // …and after the debounce window the kick fires again.
    const third = runSessionStart({
      paths,
      env: env(),
      nowMs: now + KICK_DEBOUNCE_MS + 1000,
      kick: () => kicks++,
    });
    expect(third.kicked).toBe(true);
    expect(kicks).toBe(2);
  });
});

// ── Ш2: codex apply_patch branch ─────────────────────────────────────────────

describe("hook post-write — codex apply_patch (Ш2)", () => {
  function note(rel: string, body = "тело\n"): string {
    const p = path.join(vault, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, body);
    return p;
  }

  it("stamps EVERY vault .md named by the patch envelope (multi-file patch)", () => {
    const a = note("01_Knowledge/Заметка А.md");
    const b = note("02_Decisions/Решение Б.md");
    const ev = JSON.stringify({
      tool_name: "apply_patch",
      cwd: tmp,
      tool_input: {
        input: `*** Begin Patch\n*** Update File: ${a}\n@@\n-x\n+y\n*** Add File: ${b}\n+тело\n*** End Patch`,
      },
    });
    const r = runPostWrite(ev, env());
    expect(r.stamped).toBe(true);
    // both canon → full permanent fill (type from folder, author, stamp)
    expect(fs.readFileSync(a, "utf-8")).toContain("last_edited_by: tester");
    expect(fs.readFileSync(b, "utf-8")).toContain("author: tester");
    expect(fs.readFileSync(b, "utf-8")).toContain("needs_review: true");
    expect(r.output).toBeNull(); // stamp-only here → no author-facing additionalContext (when there IS a hint it reaches codex too, §2.3)
  });

  it("relative envelope paths resolve against the event cwd", () => {
    const rel = "01_Knowledge/Относительная.md";
    note(rel);
    const ev = JSON.stringify({
      tool_name: "apply_patch",
      cwd: vault, // codex session cwd = vault root in this fixture
      tool_input: { input: `*** Begin Patch\n*** Update File: ${rel}\n@@\n*** End Patch` },
    });
    expect(runPostWrite(ev, env()).stamped).toBe(true);
    expect(fs.readFileSync(path.join(vault, rel), "utf-8")).toContain("last_edited_by: tester");
  });

  it("tool_response VERBATIM form: status string with A/M markers", () => {
    const a = note("01_Knowledge/Из respons-а.md");
    // the captured live form, letter for letter
    const resp = `Exit code: 0\nWall time: 0 seconds\nOutput:\nSuccess. Updated the following files:\nA ${a}\n`;
    const ev = JSON.stringify({ tool_name: "apply_patch", cwd: tmp, tool_response: resp });
    expect(runPostWrite(ev, env()).stamped).toBe(true);
    expect(fs.readFileSync(a, "utf-8")).toContain("last_edited_by: tester");
    // status lines never parse as paths; a D(eleted) path fails existsSync silently
    const noise = JSON.stringify({
      tool_name: "apply_patch",
      cwd: tmp,
      tool_response: "Exit code: 1\nOutput:\nFailure\nD /gone/x.md\n",
    });
    expect(runPostWrite(noise, env()).stamped).toBe(false);
  });

  it("non-vault and non-md paths are silently ignored (никогда не трогаем чужие файлы)", () => {
    const outside = path.join(tmp, "outside.md");
    fs.writeFileSync(outside, "x");
    const code = note("01_Knowledge/код.ts" as string, "let x = 1;\n");
    const ev = JSON.stringify({
      tool_name: "apply_patch",
      cwd: tmp,
      tool_input: { input: `*** Begin Patch\n*** Update File: ${outside}\n*** Update File: ${code}\n*** End Patch` },
    });
    const r = runPostWrite(ev, env());
    expect(r.stamped).toBe(false);
    expect(fs.readFileSync(outside, "utf-8")).toBe("x");
  });
});
