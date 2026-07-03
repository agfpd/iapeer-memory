import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  descriptionValue,
  detectBrokenRefs,
  noteFlags,
  collectNewNotes,
  readCodexSessionCwd,
  resolveClaudeTranscripts,
  indexCodexSessionsByCwd,
  resolveTranscripts,
  collect,
  gateHasWork,
  batchTasks,
  claudeProjectSlug,
  envNumber,
  type CollectedFolder,
  type CollectIo,
} from "../src/commands/dream-collect.js";

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "im-collect-"));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** Write a file and stamp its mtime to a fixed epoch (seconds). */
function writeAt(fp: string, content: string, mtimeSec: number): void {
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  fs.writeFileSync(fp, content);
  fs.utimesSync(fp, mtimeSec, mtimeSec);
}

const NOW = 1_750_000_000_000; // fixed clock (ms)
const DAY = 86_400_000;
const inWindowSec = (NOW - 1 * DAY) / 1000; // 1 day ago
const outWindowSec = (NOW - 30 * DAY) / 1000; // 30 days ago

const baseIo = (over: Partial<CollectIo> = {}): CollectIo => ({
  nowMs: NOW,
  windowDays: 7,
  descMaxLen: 250,
  transcriptCap: 0, // uncapped by default in tests
  existsSync: fs.existsSync,
  env: {},
  home: tmp,
  ...over,
});

function note(desc: string, body = "x"): string {
  return `---\ntitle: t\ndescription: ${desc}\nstatus: актуально\n---\n\n${body}\n`;
}

describe("descriptionValue", () => {
  it("reads the scalar, unwraps one quote level, empty when absent", () => {
    expect(descriptionValue(note("a short one"))).toBe("a short one");
    expect(descriptionValue(note('"quoted value"'))).toBe("quoted value");
    expect(descriptionValue("---\ntitle: t\n---\nbody")).toBe("");
    expect(descriptionValue("no frontmatter at all")).toBe("");
  });
});

describe("detectBrokenRefs", () => {
  it("flags a missing path, passes an existing one", () => {
    const real = path.join(tmp, "exists");
    fs.writeFileSync(real, "x");
    const body = `see \`${real}\` and ${path.join(tmp, "gone", "missing.ts")}`;
    const r = detectBrokenRefs(body, { existsSync: fs.existsSync, env: {}, home: tmp });
    expect(r.paths).toEqual([path.join(tmp, "gone", "missing.ts")]);
  });

  it("expands ~ against home before checking", () => {
    fs.mkdirSync(path.join(tmp, "sub"), { recursive: true });
    fs.writeFileSync(path.join(tmp, "sub", "here.md"), "x");
    const r = detectBrokenRefs("path ~/sub/here.md and ~/sub/gone.md", {
      existsSync: fs.existsSync,
      env: {},
      home: tmp,
    });
    expect(r.paths).toEqual(["~/sub/gone.md"]);
  });

  it("flags project-namespace env vars not set; ignores bare example vars", () => {
    const r = detectBrokenRefs("uses $IAPEER_GONE and $MERGEMIND_OLD but also $HOME and $FOO", {
      existsSync: () => true,
      env: { IAPEER_SET: "1" },
      home: tmp,
    });
    expect(new Set(r.envs)).toEqual(new Set(["IAPEER_GONE", "MERGEMIND_OLD"]));
  });

  it("a set project env var is not flagged", () => {
    const r = detectBrokenRefs("uses $IAPEER_MEMORY_VAULT_PATH", {
      existsSync: () => true,
      env: { IAPEER_MEMORY_VAULT_PATH: "/v" },
      home: tmp,
    });
    expect(r.envs).toEqual([]);
  });
});

describe("noteFlags", () => {
  it("long-desc when description exceeds the cap", () => {
    const long = "x".repeat(300);
    expect(noteFlags(note(long), baseIo())).toContain("long-desc");
    expect(noteFlags(note("short"), baseIo())).not.toContain("long-desc");
  });
  it("broken-ref from a missing path in the body", () => {
    const body = `ref ${path.join(tmp, "gone.ts")}`;
    expect(noteFlags(note("short", body), baseIo())).toContain("broken-ref");
  });
  it("both flags compose; clean note has none", () => {
    const long = "y".repeat(260);
    const body = `ref ${path.join(tmp, "missing.ts")}`;
    expect(noteFlags(note(long, body), baseIo()).sort()).toEqual(["broken-ref", "long-desc"]);
    expect(noteFlags(note("ok", "clean body"), baseIo())).toEqual([]);
  });
});

describe("collectNewNotes — window + flags", () => {
  it("keeps in-window .md, drops out-of-window and non-md, sorts, attaches flags", () => {
    const dir = path.join(tmp, "author");
    writeAt(path.join(dir, "b.md"), note("x".repeat(300)), inWindowSec);
    writeAt(path.join(dir, "a.md"), note("short"), inWindowSec);
    writeAt(path.join(dir, "old.md"), note("short"), outWindowSec); // out of window
    writeAt(path.join(dir, "notes.txt"), "x", inWindowSec); // not md
    fs.mkdirSync(path.join(dir, "archive"), { recursive: true }); // dirs ignored
    const got = collectNewNotes(dir, baseIo());
    expect(got.map((n) => path.basename(n.path))).toEqual(["a.md", "b.md"]);
    expect(got.find((n) => n.path.endsWith("b.md"))!.flags).toContain("long-desc");
  });
  it("missing folder → []", () => {
    expect(collectNewNotes(path.join(tmp, "nope"), baseIo())).toEqual([]);
  });
});

describe("readCodexSessionCwd — payload.cwd, large first line", () => {
  it("extracts cwd even when session_meta line is huge", () => {
    const big = "Z".repeat(50_000);
    const meta = JSON.stringify({
      type: "session_meta",
      payload: { cwd: "/private/var/x", base_instructions: { text: big } },
    });
    const fp = path.join(tmp, "rollout-x.jsonl");
    fs.writeFileSync(fp, `${meta}\n{"type":"event"}\n`);
    expect(readCodexSessionCwd(fp)).toBe("/private/var/x");
  });
  it("null on unparsable / missing cwd", () => {
    const fp = path.join(tmp, "bad.jsonl");
    fs.writeFileSync(fp, "not json\n");
    expect(readCodexSessionCwd(fp)).toBeNull();
  });
});

describe("resolveClaudeTranscripts — mtime filter", () => {
  it("keeps in-window .jsonl only, sorted", () => {
    const dir = path.join(tmp, "proj");
    writeAt(path.join(dir, "s2.jsonl"), "{}", inWindowSec);
    writeAt(path.join(dir, "s1.jsonl"), "{}", inWindowSec);
    writeAt(path.join(dir, "old.jsonl"), "{}", outWindowSec);
    const got = resolveClaudeTranscripts(dir, NOW - 7 * DAY);
    expect(got.map((t) => path.basename(t.path))).toEqual(["s1.jsonl", "s2.jsonl"]);
  });
});

describe("indexCodexSessionsByCwd — host-wide pool by cwd", () => {
  it("maps in-window rollouts to their session cwd; foreign cwd separate", () => {
    const root = path.join(tmp, "sessions");
    const mk = (rel: string, cwd: string, sec: number) => {
      const fp = path.join(root, rel);
      writeAt(
        fp,
        `${JSON.stringify({ type: "session_meta", payload: { cwd } })}\n`,
        sec,
      );
      return fp;
    };
    const a1 = mk("2026/06/01/rollout-a1.jsonl", "/peer/alpha", inWindowSec);
    const a2 = mk("2026/06/02/rollout-a2.jsonl", "/peer/alpha", inWindowSec);
    mk("2026/06/02/rollout-b1.jsonl", "/peer/beta", inWindowSec);
    mk("2026/05/01/rollout-old.jsonl", "/peer/alpha", outWindowSec); // out of window
    const idx = indexCodexSessionsByCwd(root, NOW - 7 * DAY);
    expect(idx.get("/peer/alpha")!.map((t) => t.path)).toEqual([a1, a2].sort());
    expect(idx.get("/peer/beta")).toHaveLength(1);
    expect(idx.has("/peer/gamma")).toBe(false);
  });
});

describe("resolveTranscripts — per-runtime + cap", () => {
  it("claude reads the per-peer dir; codex looks up the realpath cwd index", () => {
    const real = fs.mkdtempSync(path.join(os.tmpdir(), "im-cwd-"));
    try {
      const codexIndex = new Map([
        [fs.realpathSync(real), [{ path: "/x/rollout.jsonl", mtimeMs: NOW }]],
      ]);
      const got = resolveTranscripts(
        { personality: "p", cwd: real, runtimes: ["claude", "codex"] },
        { home: tmp, cutoffMs: NOW - 7 * DAY, codexIndex, cap: 0 },
      );
      expect(got.find((t) => t.runtime === "codex")!.files).toEqual(["/x/rollout.jsonl"]);
      expect(got.find((t) => t.runtime === "claude")!.files).toEqual([]); // no dir yet
    } finally {
      fs.rmSync(real, { recursive: true, force: true });
    }
  });

  it("caps to the most-recent N by mtime across runtimes", () => {
    const real = fs.mkdtempSync(path.join(os.tmpdir(), "im-cwd-"));
    try {
      // 5 codex sessions, mtimes 100..104; cap 2 keeps the newest two (104,103)
      const codexIndex = new Map([
        [
          fs.realpathSync(real),
          Array.from({ length: 5 }, (_, i) => ({ path: `/x/r${i}.jsonl`, mtimeMs: 100 + i })),
        ],
      ]);
      const got = resolveTranscripts(
        { personality: "p", cwd: real, runtimes: ["codex"] },
        { home: tmp, cutoffMs: 0, codexIndex, cap: 2 },
      );
      expect(got.find((t) => t.runtime === "codex")!.files.sort()).toEqual([
        "/x/r3.jsonl",
        "/x/r4.jsonl",
      ]);
    } finally {
      fs.rmSync(real, { recursive: true, force: true });
    }
  });
});

describe("collect — active vs skipped", () => {
  it("skips zero-activity folders, includes note-active and transcript-active", () => {
    const vault = tmp;
    const mem = path.join(vault, "06_agents");
    // active by notes
    writeAt(path.join(mem, "index", "n.md"), note("short"), inWindowSec);
    // inactive (note out of window, no peer)
    writeAt(path.join(mem, "ghost", "old.md"), note("short"), outWindowSec);
    // transcript-active (no notes in window, but a claude transcript)
    fs.mkdirSync(path.join(mem, "scriber"), { recursive: true });
    const peerCwd = fs.mkdtempSync(path.join(os.tmpdir(), "im-scriber-"));
    try {
      const home = path.join(tmp, "home");
      const projDir = path.join(home, ".claude", "projects", claudeProjectSlug(peerCwd));
      writeAt(path.join(projDir, "s.jsonl"), "{}", inWindowSec);

      const res = collect({
        vault,
        agentMemoryFolder: "06_agents",
        peers: [{ personality: "scriber", cwd: peerCwd, runtimes: ["claude"] }],
        home,
        io: baseIo({ home }),
      });
      const names = res.folders.map((f) => f.agent).sort();
      expect(names).toEqual(["index", "scriber"]);
      expect(res.skipped.some((s) => s.startsWith("ghost"))).toBe(true);
      const scriber = res.folders.find((f) => f.agent === "scriber")!;
      expect(scriber.newNotesCount).toBe(0);
      expect(scriber.transcripts.find((t) => t.runtime === "claude")!.files).toHaveLength(1);
    } finally {
      fs.rmSync(peerCwd, { recursive: true, force: true });
    }
  });
});

describe("gateHasWork — registry-free notes-only gate", () => {
  const mem = "06_agents";
  it("true on any in-window note, false on a dead window", () => {
    writeAt(path.join(tmp, mem, "a", "old.md"), note("x"), outWindowSec);
    expect(
      gateHasWork({ vault: tmp, agentMemoryFolder: mem, nowMs: NOW, windowDays: 7 }),
    ).toBe(false);
    writeAt(path.join(tmp, mem, "b", "fresh.md"), note("x"), inWindowSec);
    expect(
      gateHasWork({ vault: tmp, agentMemoryFolder: mem, nowMs: NOW, windowDays: 7 }),
    ).toBe(true);
  });
  it("false when the memory root is absent (unprovisioned)", () => {
    expect(
      gateHasWork({ vault: tmp, agentMemoryFolder: "nope", nowMs: NOW, windowDays: 7 }),
    ).toBe(false);
  });
});

describe("batchTasks — Q3 rule", () => {
  const folder = (agent: string, newNotesCount: number): CollectedFolder => ({
    agent,
    path: `/v/${agent}`,
    newNotes: Array.from({ length: newNotesCount }, (_, i) => ({ path: `/v/${agent}/${i}.md`, flags: [] })),
    newNotesCount,
    candidateCount: 0,
    transcripts: [],
  });

  it(">threshold → its own 1:1 folder task", () => {
    const tasks = batchTasks([folder("big", 25)], { threshold: 20, groupCap: 20 });
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ kind: "folder" });
    expect(tasks[0]!.folders[0]!.agent).toBe("big");
  });

  it("≤threshold folders group until the cap, then a new group opens", () => {
    const tasks = batchTasks(
      [folder("a", 8), folder("b", 8), folder("c", 8)],
      { threshold: 20, groupCap: 20 },
    );
    // a+b = 16 ≤ 20; adding c (→24) overflows → new group
    expect(tasks).toHaveLength(2);
    expect(tasks[0]!.folders.map((f) => f.agent)).toEqual(["a", "b"]);
    expect(tasks[1]!.folders.map((f) => f.agent)).toEqual(["c"]);
  });

  it("transcript-only folder weighs 1", () => {
    const tasks = batchTasks(
      [folder("t1", 0), folder("t2", 0), folder("n", 18)],
      { threshold: 20, groupCap: 20 },
    );
    // t1(1)+t2(1)+n(18) = 20 ≤ cap → one group
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.folders.map((f) => f.agent)).toEqual(["t1", "t2", "n"]);
  });

  it("mixed: dedicated folders interleave with groups", () => {
    const tasks = batchTasks(
      [folder("a", 5), folder("BIG", 30), folder("b", 5)],
      { threshold: 20, groupCap: 20 },
    );
    expect(tasks.map((t) => t.kind)).toEqual(["folder", "grouped"]);
    expect(tasks[1]!.folders.map((f) => f.agent)).toEqual(["a", "b"]);
  });
});

describe("envNumber — the documented «0 = uncapped» switch (audit important)", () => {
  const KEY = "IAPEER_MEMORY_TEST_ENVNUMBER";
  afterEach(() => {
    delete process.env[KEY];
  });

  it("strict mode (the other dream knobs): 0 falls back — zero is meaningless there", () => {
    process.env[KEY] = "0";
    expect(envNumber(KEY, 20)).toBe(20);
  });

  it("allowZero (TRANSCRIPT_CAP): 0 passes through — the OFF switch docs and config.env promise", () => {
    process.env[KEY] = "0";
    expect(envNumber(KEY, 20, { allowZero: true })).toBe(0);
    process.env[KEY] = "7";
    expect(envNumber(KEY, 20, { allowZero: true })).toBe(7);
    process.env[KEY] = "-1";
    expect(envNumber(KEY, 20, { allowZero: true })).toBe(20); // negatives still refused
  });
});
