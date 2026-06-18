/**
 * `iapeer-memory dream-collect [--gate] [--iapeer-bin P]` — the DETERMINISTIC
 * pre-filter of the weekly dream-tick (Фаза «Оптимизация dream-tick
 * детерминированным предфильтром»).
 *
 * Zero LLM. It discovers WHAT to consolidate so the LLM only JUDGES:
 *   - a fixed time window `now − windowDays` (default 7d) BY MTIME — not
 *     «since last tick» (the host powers off; last-tick lies, the Фаза's
 *     accepted edge case);
 *   - per author (= each agent-memory subfolder): the in-window notes, the
 *     author's in-window session transcripts RESOLVED TO CONCRETE FILES
 *     (claude per-peer dir; codex host-wide pool filtered by the payload's
 *     `session_meta.payload.cwd` == realpath(cwd) — host fact, verified
 *     against a live rollout), and deterministic candidate flags inside the
 *     in-window notes (long `description`; broken path/env references);
 *   - a folder with no in-window activity is SKIPPED — it never reaches an
 *     LLM (the «папка без работы → ноль LLM» criterion).
 *
 * OUTPUT is Q1-AGNOSTIC and FLAT: `{vault, windowDays, folders[], skipped[]}`.
 * It deliberately does NOT pre-package task-units / batching: whether
 * DreamWeaver processes the folders sequentially in one window or fans out
 * subagents (open question Q1) is a LAST layer that sits
 * on this structure without touching the deterministic core.
 *
 * `--gate` runs the same collection but suppresses stdout and exits 0 iff
 * there is ANY active folder (1 ⇔ a dead week). It is the notifier `check`
 * gate: a closed gate means DreamWeaver is NEVER woken — true zero-LLM.
 *
 * SOURCE = the LIVE registry (`iapeer list --json`), not fleet.json — same
 * freshness proof as dream-paths (birth does not touch fleet.json; the
 * SessionStart kick is heartbeat-gated, so a newborn is invisible to the map
 * for weeks). READ-ONLY: one registry spawn + vault/transcript readdir +
 * realpath. No writes, no signals.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getTaxonomy, isLocaleId, splitFrontmatter } from "@agfpd/iapeer-memory-core";
import type { Egress } from "../egress.js";
import { queryRegistry, type FleetPeer } from "../fleet.js";

const DAY_MS = 86_400_000;

/** Claude projects-dir slug — every non-alphanumeric of the REGISTRY cwd → '-'
 *  (the live disk form, e.g. `/Users/x/.iapeer/peers/index` →
 *  `-Users-x--iapeer-peers-index`; the dot yields the double dash). Claude
 *  slugs the path the session launched in, verbatim — NOT realpath. */
export function claudeProjectSlug(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, "-");
}

export const DEFAULT_WINDOW_DAYS = 7;
export const DEFAULT_DESC_MAXLEN = 250;
/** >threshold new notes in a week → a dedicated 1:1 subagent (Q3). */
export const DEFAULT_BATCH_THRESHOLD = 20;
/** Cap on a grouped subagent's volume (sum of per-folder weights) — small
 *  folders accrete up to it, then a new group opens (Q3). */
export const DEFAULT_GROUP_CAP = 20;
/** Per-folder cap on transcript files handed to phase D — the MOST RECENT N
 *  by mtime (an ephemeral worker emits hundreds of mechanical
 *  sessions a week; scanning all is costly and low-value). Cap by N, never by
 *  role name — universal, no hardcode. */
export const DEFAULT_TRANSCRIPT_CAP = 20;

export type CandidateFlag = "long-desc" | "broken-ref";

export type NoteCandidate = {
  /** Absolute path of the in-window note. */
  path: string;
  /** Deterministic flags — `[]` means «new but nothing obvious to fix»
   *  (still part of the dedup working set). */
  flags: CandidateFlag[];
};

export type ResolvedTranscripts = {
  runtime: "claude" | "codex";
  /** Concrete files in window — the LLM never globs, it reads this list. */
  files: string[];
};

export type CollectedFolder = {
  agent: string;
  path: string;
  /** All in-window notes — the batching basis (Фаза: «по числу НОВЫХ
   *  заметок за неделю») and the dedup working set. */
  newNotes: NoteCandidate[];
  /** Convenience counts (consumer batches on newNotesCount). */
  newNotesCount: number;
  candidateCount: number;
  transcripts: ResolvedTranscripts[];
};

export type CollectResult = {
  vault: string;
  windowDays: number;
  folders: CollectedFolder[];
  /** Authors skipped for zero in-window activity — legibility, not work. */
  skipped: string[];
};

// ── candidate detection (pure) ─────────────────────────────────────────────

/** The `description` scalar from a note's frontmatter (one level of quote
 *  unwrap; multi-line block scalars are not used in our notes). */
export function descriptionValue(content: string): string {
  const [fm] = splitFrontmatter(content);
  if (!fm) return "";
  const m = /^description:[^\S\n]*(.*)$/m.exec(fm);
  if (!m) return "";
  let v = m[1].trim();
  if (v.length >= 2 && (v[0] === '"' || v[0] === "'") && v.endsWith(v[0])) {
    v = v.slice(1, -1);
  }
  return v;
}

/** Path-like tokens anchored to common absolute roots (host-portable set) or
 *  a leading `~`. Inclusive by design — a false positive is a FLAG, the
 *  subagent judges it (tolerant). */
const PATH_TOKEN_RE =
  /(~|\/(?:Users|home|root|private|tmp|var|opt|usr|etc|Volumes|Applications|mnt|srv))\/[A-Za-z0-9._\-/]+/g;
/** Env references scoped to the PROJECT namespaces — the ones notes document
 *  and that go stale on a rename (a bare `$VAR` example is too noisy to flag;
 *  `IAPEER_*`/`MERGEMIND_*` not set in the env is a real stale-config signal). */
const ENV_TOKEN_RE = /\$\{?((?:IAPEER|MERGEMIND)[A-Z0-9_]*)\}?/g;

export type RefIo = {
  existsSync: (p: string) => boolean;
  env: Record<string, string | undefined>;
  home: string;
};

/** Broken path/env references in a note body. Paths: existence-checked
 *  (`~` expanded); envs: undefined-in-env. Returns the offending tokens. */
export function detectBrokenRefs(
  body: string,
  io: RefIo,
): { paths: string[]; envs: string[] } {
  const paths = new Set<string>();
  for (const m of body.matchAll(PATH_TOKEN_RE)) {
    const tok = m[0].replace(/[.,;:)`'"]+$/, "");
    if (tok === "~" || tok.length < 4) continue;
    const abs = tok.startsWith("~") ? path.join(io.home, tok.slice(1)) : tok;
    if (!io.existsSync(abs)) paths.add(tok);
  }
  const envs = new Set<string>();
  for (const m of body.matchAll(ENV_TOKEN_RE)) {
    const name = m[1];
    const val = io.env[name];
    if (!(typeof val === "string" && val.length > 0)) envs.add(name);
  }
  return { paths: [...paths], envs: [...envs] };
}

export function noteFlags(
  content: string,
  io: RefIo & { descMaxLen: number },
): CandidateFlag[] {
  const flags: CandidateFlag[] = [];
  if (descriptionValue(content).length > io.descMaxLen) flags.push("long-desc");
  const [, body] = splitFrontmatter(content);
  const broken = detectBrokenRefs(body || content, io);
  if (broken.paths.length > 0 || broken.envs.length > 0) flags.push("broken-ref");
  return flags;
}

// ── note + transcript collection (filesystem) ──────────────────────────────

export type CollectIo = RefIo & {
  nowMs: number;
  windowDays: number;
  descMaxLen: number;
  /** Per-folder transcript cap (most-recent N by mtime; ≤0 = uncapped). */
  transcriptCap: number;
};

/** Top-level in-window `.md` notes of one author folder (no recursion — the
 *  `archive` subfolder and any nested dirs are out of scope). */
export function collectNewNotes(folderPath: string, io: CollectIo): NoteCandidate[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(folderPath, { withFileTypes: true });
  } catch {
    return [];
  }
  const cutoff = io.nowMs - io.windowDays * DAY_MS;
  const out: NoteCandidate[] = [];
  for (const e of entries) {
    if (!e.isFile() || e.name.startsWith(".") || !e.name.endsWith(".md")) continue;
    const fp = path.join(folderPath, e.name);
    let mtimeMs: number;
    try {
      mtimeMs = fs.statSync(fp).mtimeMs;
    } catch {
      continue;
    }
    if (mtimeMs < cutoff) continue;
    let content = "";
    try {
      content = fs.readFileSync(fp, "utf-8");
    } catch {
      // unreadable — still a candidate (no flags), the subagent will see it
    }
    out.push({ path: fp, flags: noteFlags(content, io) });
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

/** Read just the first JSONL line of a rollout file (the session_meta record);
 *  `base_instructions` can make that line large, so read until the newline
 *  with a cap rather than slurping the whole session. */
function readFirstLine(fp: string, capBytes = 1_048_576): string | null {
  let fd: number;
  try {
    fd = fs.openSync(fp, "r");
  } catch {
    return null;
  }
  try {
    const chunk = Buffer.alloc(65_536);
    const parts: Buffer[] = [];
    let total = 0;
    let pos = 0;
    while (total < capBytes) {
      const n = fs.readSync(fd, chunk, 0, chunk.length, pos);
      if (n <= 0) break;
      pos += n;
      const nl = chunk.indexOf(0x0a);
      if (nl >= 0 && nl < n) {
        parts.push(Buffer.from(chunk.subarray(0, nl)));
        return Buffer.concat(parts).toString("utf-8");
      }
      parts.push(Buffer.from(chunk.subarray(0, n)));
      total += n;
    }
    return Buffer.concat(parts).toString("utf-8");
  } catch {
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

/** The codex session's working directory (`session_meta.payload.cwd`) — the
 *  realpath the session launched in (host fact, verified live). */
export function readCodexSessionCwd(fp: string): string | null {
  const line = readFirstLine(fp);
  if (line === null) return null;
  try {
    const obj = JSON.parse(line) as { payload?: { cwd?: unknown } };
    const cwd = obj?.payload?.cwd;
    return typeof cwd === "string" ? cwd : null;
  } catch {
    return null;
  }
}

/** A transcript file with its mtime — carried so the per-folder cap can keep
 *  the MOST RECENT N across runtimes. */
export type TFile = { path: string; mtimeMs: number };

/** Claude per-peer transcripts in window: readdir one projects dir. */
export function resolveClaudeTranscripts(projectsDir: string, cutoffMs: number): TFile[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(projectsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: TFile[] = [];
  for (const e of entries) {
    if (!e.isFile() || !e.name.endsWith(".jsonl")) continue;
    const fp = path.join(projectsDir, e.name);
    try {
      const mtimeMs = fs.statSync(fp).mtimeMs;
      if (mtimeMs >= cutoffMs) out.push({ path: fp, mtimeMs });
    } catch {
      // vanished mid-walk — skip
    }
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

/** Codex pool is HOST-WIDE: index every in-window rollout by its session cwd
 *  ONCE (a single recursive walk), so per-author lookup is O(1). Returns a
 *  realpath(cwd) → files map. */
export function indexCodexSessionsByCwd(
  sessionsRoot: string,
  cutoffMs: number,
): Map<string, TFile[]> {
  const byCwd = new Map<string, TFile[]>();
  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const fp = path.join(dir, e.name);
      if (e.isDirectory()) {
        walk(fp);
        continue;
      }
      if (!e.isFile() || !e.name.startsWith("rollout-") || !e.name.endsWith(".jsonl")) {
        continue;
      }
      let mtimeMs: number;
      try {
        mtimeMs = fs.statSync(fp).mtimeMs;
      } catch {
        continue;
      }
      if (mtimeMs < cutoffMs) continue;
      const cwd = readCodexSessionCwd(fp);
      if (cwd === null) continue;
      const entry = { path: fp, mtimeMs };
      const list = byCwd.get(cwd);
      if (list) list.push(entry);
      else byCwd.set(cwd, [entry]);
    }
  };
  walk(sessionsRoot);
  for (const list of byCwd.values()) list.sort((a, b) => a.path.localeCompare(b.path));
  return byCwd;
}

function realpathOrSelf(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}

/** Resolve a peer's in-window transcripts, capped per FOLDER to the most
 *  recent `cap` by mtime ACROSS runtimes (`cap ≤ 0` = uncapped), then grouped
 *  back per runtime (files sorted by path for deterministic output). An
 *  entry is emitted for every runtime the peer declares, even if the cap left
 *  it empty — the consumer sees which runtimes were considered. */
export function resolveTranscripts(
  peer: FleetPeer,
  opts: { home: string; cutoffMs: number; codexIndex: Map<string, TFile[]>; cap: number },
): ResolvedTranscripts[] {
  const tagged: Array<{ runtime: "claude" | "codex"; file: TFile }> = [];
  const runtimes: Array<"claude" | "codex"> = [];
  if (peer.runtimes.includes("claude")) {
    runtimes.push("claude");
    const dir = path.join(opts.home, ".claude", "projects", claudeProjectSlug(peer.cwd));
    for (const file of resolveClaudeTranscripts(dir, opts.cutoffMs)) {
      tagged.push({ runtime: "claude", file });
    }
  }
  if (peer.runtimes.includes("codex")) {
    runtimes.push("codex");
    for (const file of opts.codexIndex.get(realpathOrSelf(peer.cwd)) ?? []) {
      tagged.push({ runtime: "codex", file });
    }
  }
  // Keep the most recent `cap` across BOTH runtimes (the heavy ephemeral case
  // is a single runtime flooding phase D).
  let kept = tagged;
  if (opts.cap > 0 && tagged.length > opts.cap) {
    kept = [...tagged].sort((a, b) => b.file.mtimeMs - a.file.mtimeMs).slice(0, opts.cap);
  }
  return runtimes.map((runtime) => ({
    runtime,
    files: kept
      .filter((t) => t.runtime === runtime)
      .map((t) => t.file.path)
      .sort(),
  }));
}

// ── orchestration ──────────────────────────────────────────────────────────

export function collect(opts: {
  vault: string;
  agentMemoryFolder: string;
  peers: FleetPeer[];
  home: string;
  io: CollectIo;
}): CollectResult {
  const memoryRoot = path.join(opts.vault, opts.agentMemoryFolder);
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(memoryRoot, { withFileTypes: true });
  } catch {
    return { vault: opts.vault, windowDays: opts.io.windowDays, folders: [], skipped: [] };
  }
  const cutoffMs = opts.io.nowMs - opts.io.windowDays * DAY_MS;
  const byPersonality = new Map(opts.peers.map((p) => [p.personality, p]));
  // Build the codex pool index once iff any peer runs codex.
  const codexIndex = opts.peers.some((p) => p.runtimes.includes("codex"))
    ? indexCodexSessionsByCwd(path.join(opts.home, ".codex", "sessions"), cutoffMs)
    : new Map<string, TFile[]>();

  const folders: CollectedFolder[] = [];
  const skipped: string[] = [];
  const dirs = entries
    .filter((e) => e.isDirectory() && !e.name.startsWith("."))
    .sort((a, b) => a.name.localeCompare(b.name));

  for (const e of dirs) {
    const agent = e.name;
    const folderPath = path.join(memoryRoot, agent);
    const newNotes = collectNewNotes(folderPath, opts.io);
    const peer = byPersonality.get(agent);
    const transcripts = peer
      ? resolveTranscripts(peer, {
          home: opts.home,
          cutoffMs,
          codexIndex,
          cap: opts.io.transcriptCap,
        })
      : [];
    const hasTranscripts = transcripts.some((t) => t.files.length > 0);
    if (newNotes.length === 0 && !hasTranscripts) {
      skipped.push(`${agent} (no activity in window)`);
      continue;
    }
    folders.push({
      agent,
      path: folderPath,
      newNotes,
      newNotesCount: newNotes.length,
      candidateCount: newNotes.filter((n) => n.flags.length > 0).length,
      transcripts,
    });
  }
  return { vault: opts.vault, windowDays: opts.io.windowDays, folders, skipped };
}

/**
 * The notifier `check` gate — REGISTRY-FREE on purpose. It runs in the
 * NOTIFIER's launchd env, where spawning `iapeer list` is unproven (no other
 * notifier-env script does it; the sweep check is pure bash). Depending on the
 * registry here would silently fail the gate closed and the whole tick would
 * never fire. So the gate answers a narrower, robust question with vault
 * readdir + mtime ALONE: «is there ANY in-window agent-memory note?» — short-
 * circuiting on the first hit.
 *
 * Semantic gap accepted: a week with NO new notes but fresh sessions
 * (transcript-only activity) does NOT open the gate, so phase D waits a week.
 * Rare, bounded, and errs toward NOT waking — the token-minimisation side.
 * The FULL `collect()` (run by DreamWeaver in a real peer shell WITH PATH)
 * still resolves transcripts via the registry.
 */
export function gateHasWork(opts: {
  vault: string;
  agentMemoryFolder: string;
  nowMs: number;
  windowDays: number;
}): boolean {
  const memoryRoot = path.join(opts.vault, opts.agentMemoryFolder);
  let dirs: fs.Dirent[];
  try {
    dirs = fs.readdirSync(memoryRoot, { withFileTypes: true });
  } catch {
    return false;
  }
  const cutoff = opts.nowMs - opts.windowDays * DAY_MS;
  for (const d of dirs) {
    if (!d.isDirectory() || d.name.startsWith(".")) continue;
    const sub = path.join(memoryRoot, d.name);
    let files: fs.Dirent[];
    try {
      files = fs.readdirSync(sub, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const f of files) {
      if (!f.isFile() || f.name.startsWith(".") || !f.name.endsWith(".md")) continue;
      try {
        if (fs.statSync(path.join(sub, f.name)).mtimeMs >= cutoff) return true;
      } catch {
        // vanished — keep scanning
      }
    }
  }
  return false;
}

// ── batching (the packaging layer; Q1 fan-out + Q3 rule) ───────
//
// DETERMINISTIC, sits ON TOP of the flat core — DreamWeaver fans out exactly
// one subagent per task. The core `collect()` stays batching-agnostic; this
// layer is the only place the >threshold/group rule lives, so a change to the
// fan-out shape never touches discovery.

export type DreamTask = {
  /** `folder` — a single >threshold folder gets the whole subagent (1:1);
   *  `grouped` — several ≤threshold folders share one subagent (up to cap). */
  kind: "folder" | "grouped";
  folders: CollectedFolder[];
};

/** Weight of one folder toward a group's cap: its in-window note count, but
 *  at least 1 so a transcript-only folder still consumes a slot (its subagent
 *  reads the transcripts — real context load). */
function folderWeight(f: CollectedFolder): number {
  return Math.max(f.newNotesCount, 1);
}

export function batchTasks(
  folders: CollectedFolder[],
  opts: { threshold: number; groupCap: number },
): DreamTask[] {
  const tasks: DreamTask[] = [];
  let group: CollectedFolder[] = [];
  let groupWeight = 0;
  const flush = (): void => {
    if (group.length > 0) {
      tasks.push({ kind: "grouped", folders: group });
      group = [];
      groupWeight = 0;
    }
  };
  for (const f of folders) {
    if (f.newNotesCount > opts.threshold) {
      tasks.push({ kind: "folder", folders: [f] });
      continue;
    }
    const w = folderWeight(f);
    // Close a non-empty group before it would overflow (a single folder
    // already at/over the cap becomes its own group of one).
    if (group.length > 0 && groupWeight + w > opts.groupCap) flush();
    group.push(f);
    groupWeight += w;
  }
  flush();
  return tasks;
}

// ── CLI ────────────────────────────────────────────────────────────────────

function envNumber(name: string, fallback: number): number {
  const v = process.env[name];
  if (typeof v !== "string" || v.length === 0) return fallback;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * Write the whole payload to stdout SYNCHRONOUSLY. The collector's JSON is
 * large (140KB+ on a real fleet) and DreamWeaver CAPTURES it through a PIPE;
 * `console.log` to a pipe is an async write that the runtime may truncate on
 * exit (observed: 141KB written to a file, cut to ~128KB through a pipe —
 * invalid JSON would break the whole tick). `writeSync(1, …)` guarantees the
 * bytes land before the process returns; EAGAIN (a full non-blocking pipe) is
 * retried, partial writes are looped.
 */
function writeStdout(s: string): void {
  const buf = Buffer.from(s, "utf-8");
  let off = 0;
  while (off < buf.length) {
    try {
      off += fs.writeSync(1, buf, off, buf.length - off);
    } catch (err) {
      if ((err as { code?: string }).code === "EAGAIN") continue;
      throw err;
    }
  }
}

export function cmdDreamCollect(argv: string[], egress: Egress): number {
  let iapeerBin: string | undefined;
  let gate = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--iapeer-bin") iapeerBin = argv[++i];
    else if (a === "--gate") gate = true;
    else {
      console.error(`iapeer-memory dream-collect: unknown flag: ${a}`);
      return 2;
    }
  }

  const vault = process.env.IAPEER_MEMORY_VAULT_PATH ?? "";
  if (!vault) {
    console.error(
      "iapeer-memory dream-collect: IAPEER_MEMORY_VAULT_PATH is not set — not provisioned",
    );
    return 1;
  }
  const localeRaw = process.env.IAPEER_MEMORY_LOCALE || "en";
  if (!isLocaleId(localeRaw)) {
    console.error(`iapeer-memory dream-collect: unknown locale "${localeRaw}"`);
    return 1;
  }
  const agentMemoryFolder = getTaxonomy(localeRaw).folders.agentMemory;
  const windowDays = envNumber("IAPEER_MEMORY_DREAM_WINDOW_DAYS", DEFAULT_WINDOW_DAYS);

  if (gate) {
    // REGISTRY-FREE (runs in the notifier's env): exit 0 ⇔ there is an
    // in-window note (the notifier fires DreamWeaver); exit 1 ⇔ a dead week
    // (NOBODY is woken — true zero-LLM).
    const work = gateHasWork({ vault, agentMemoryFolder, nowMs: Date.now(), windowDays });
    return work ? 0 : 1;
  }

  const q = queryRegistry(egress, { iapeerBin });
  if ("error" in q) {
    // LOUD: a silent empty collection would re-create the masked-dead-phase
    // class — the caller reports instead of guessing the fleet.
    console.error(`iapeer-memory dream-collect: live registry unavailable — ${q.error}`);
    return 1;
  }

  const result = collect({
    vault,
    agentMemoryFolder,
    peers: q.peers,
    home: os.homedir(),
    io: {
      nowMs: Date.now(),
      windowDays,
      descMaxLen: envNumber("IAPEER_MEMORY_DREAM_DESC_MAXLEN", DEFAULT_DESC_MAXLEN),
      transcriptCap: envNumber("IAPEER_MEMORY_DREAM_TRANSCRIPT_CAP", DEFAULT_TRANSCRIPT_CAP),
      existsSync: fs.existsSync,
      env: process.env,
      home: os.homedir(),
    },
  });

  const batchThreshold = envNumber("IAPEER_MEMORY_DREAM_BATCH_THRESHOLD", DEFAULT_BATCH_THRESHOLD);
  const groupCap = envNumber("IAPEER_MEMORY_DREAM_GROUP_CAP", DEFAULT_GROUP_CAP);
  const tasks = batchTasks(result.folders, { threshold: batchThreshold, groupCap });
  writeStdout(
    `${JSON.stringify(
      {
        vault: result.vault,
        windowDays: result.windowDays,
        batchThreshold,
        groupCap,
        tasks,
        skipped: result.skipped,
      },
      null,
      2,
    )}\n`,
  );
  return 0;
}
