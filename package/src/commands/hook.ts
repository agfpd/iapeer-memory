/**
 * `iapeer-memory hook <event>` — the TESTABLE engine of the session hooks
 * (ADR-009: the session hook surface is thin; its bash hooks are 3-line
 * shims that exec this CLI). All parsing/gating logic lives here under
 * tests — the reference's bash/python JSON juggling is deliberately not
 * ported.
 *
 *   hook post-write     stdin: PostToolUse event JSON. Claude tools
 *                       Write|Edit|MultiEdit (the codex `apply_patch`
 *                       branch lands in P5 behind the live-format gate).
 *                       Stamps vault-note frontmatter through the SAME
 *                       core fill the fm-update path uses; a NEW note
 *                       (Write) in the author's own agent-memory folder
 *                       additionally emits the "team material?" reminder.
 *                       Reference fact: PostToolUse plain stdout is NOT
 *                       injected — the reminder goes out as
 *                       hookSpecificOutput.additionalContext JSON.
 *
 *   hook session-start  SessionStart health-check (ADR-009 п.3): NEVER a
 *                       content inject. Provisioned + fresh heartbeat →
 *                       silent. Unprovisioned → one-line hint. Missing /
 *                       stale heartbeat → one-line degraded warning
 *                       (SessionStart plain stdout IS injected — reference
 *                       fact) + a DEBOUNCED background kick of
 *                       `verify --repair` (stamp file in state dir — many
 *                       peers waking at once must not storm repairs).
 *
 * Both verbs are FAIL-OPEN: any internal error is appended to
 * `<logs>/hook-errors.log` and the exit code stays 0 — a memory hook must
 * never block the author's tool flow or session start.
 */

import fs from "node:fs";
import path from "node:path";
import type { Egress } from "../egress.js";
import {
  DEFAULT_CURATOR_SET,
  fmUpdate,
  getTaxonomy,
  isLocaleId,
  resolveAgentName,
  resolveZone,
  splitFrontmatter,
  parseNoteTags,
  parseDictionaryTags,
  tagGateProblems,
  tagsDictionarySourceRel,
  DEFAULT_DEDUP_THRESHOLD,
  DEFAULT_LINK_HINT_THRESHOLD,
  type TaxonomyPreset,
} from "@agfpd/iapeer-memory-core";
import { memoryPaths, type MemoryPaths } from "../paths.js";
import { isCompiledRuntime } from "../binary.js";
import { DEFAULT_HEARTBEAT_STALE_MS } from "./verify.js";
import { guardedWriteFileSync } from "@agfpd/iapeer-memory-core";

/** Tools whose writes stamp frontmatter: claude Write|Edit|MultiEdit +
 *  codex apply_patch (Ш2; stdin-JSON is Claude-compatible — canon
 *  «Поверхности конфигурации codex» §Хуки). */
export const POST_WRITE_TOOLS: ReadonlySet<string> = new Set([
  "Write",
  "Edit",
  "MultiEdit",
  "apply_patch",
]);

/** apply_patch envelope markers (the public codex patch format) — the
 *  deterministic path source from tool_input's patch text. */
const PATCH_FILE_RE = /^\*\*\* (?:Update|Add) File: (.+)$/gm;

/** `tool_response` status lines — the VERBATIM form established by the live
 *  Ш2 e2e (codex-cli 0.138.0, gpt-5.5):
 *  a single STRING `"Exit code: 0\nWall time: …\nOutput:\nSuccess. Updated
 *  the following files:\nA /abs/path.md\n"` — `A`/`M`/`D` markers per file. */
const RESPONSE_FILE_RE = /^[AMD]\s+(.+)$/;

/**
 * File-path candidates of a codex apply_patch event. Two sources, union:
 * the envelope markers inside the patch text (scans every string value of
 * tool_input — the live field is `command`, the name is not load-bearing)
 * and the `A/M/D <path>` lines of the tool_response string (verbatim form
 * above; a D path simply fails the existsSync gate downstream). Relative
 * paths resolve against the event's `cwd` (stdin carries it — live fact).
 */
export function applyPatchPaths(event: {
  cwd?: string;
  tool_input?: unknown;
  tool_response?: unknown;
}): string[] {
  const found = new Set<string>();
  const add = (raw: string): void => {
    const p = raw.trim();
    if (!p) return;
    found.add(path.isAbsolute(p) ? p : path.resolve(event.cwd ?? process.cwd(), p));
  };
  const input = event.tool_input;
  if (input && typeof input === "object") {
    for (const v of Object.values(input as Record<string, unknown>)) {
      if (typeof v !== "string") continue;
      for (const m of v.matchAll(PATCH_FILE_RE)) add(m[1]);
    }
  } else if (typeof input === "string") {
    for (const m of input.matchAll(PATCH_FILE_RE)) add(m[1]);
  }
  const resp = event.tool_response;
  if (typeof resp === "string") {
    for (const line of resp.split("\n")) {
      const m = RESPONSE_FILE_RE.exec(line);
      if (m) add(m[1]);
    }
  }
  return [...found];
}

/** Min interval between background verify-kicks (anti-storm). */
export const KICK_DEBOUNCE_MS = 5 * 60_000;

// ── post-write ───────────────────────────────────────────────────────────────

export type PostWriteResult = {
  stamped: boolean;
  /** JSON string for stdout (hookSpecificOutput), or null for silence. */
  output: string | null;
};

export function runPostWrite(
  eventJson: string,
  env: Record<string, string | undefined> = process.env,
): PostWriteResult {
  const silent: PostWriteResult = { stamped: false, output: null };

  let event: {
    tool_name?: string;
    cwd?: string;
    tool_input?: { file_path?: string };
    tool_response?: unknown;
  };
  try {
    event = JSON.parse(eventJson) as typeof event;
  } catch {
    return silent; // malformed event — not our problem to escalate
  }
  const tool = event.tool_name ?? "";
  // Cheap tool gate FIRST (codex sends post_tool_use for EVERY tool —
  // reference live-smoke fact; the same ordering keeps claude cheap too).
  if (!POST_WRITE_TOOLS.has(tool)) return silent;

  // Path candidates: claude tools carry ONE file_path; codex apply_patch
  // carries a patch over possibly MANY files (Ш2).
  const candidates =
    tool === "apply_patch"
      ? applyPatchPaths(event)
      : [event.tool_input?.file_path ?? ""];

  const vault = env.IAPEER_MEMORY_VAULT_PATH ?? "";
  if (!vault) return silent; // socket without a provisioned system
  const vaultPrefix = vault.endsWith(path.sep) ? vault : vault + path.sep;
  const files = candidates.filter(
    (p) => p.endsWith(".md") && p.startsWith(vaultPrefix) && fs.existsSync(p),
  );
  if (files.length === 0) return silent;

  // Identity: PEER_PERSONALITY → IAPEER_MEMORY_AGENT_NAME. NO cwd guessing
  // (нюанс 10 — deliberate divergence from the reference basename(PWD)).
  const agent = resolveAgentName(null, env);
  if (!agent) return silent;

  const localeRaw = env.IAPEER_MEMORY_LOCALE || "en";
  if (!isLocaleId(localeRaw)) return silent;
  const taxonomy = getTaxonomy(localeRaw);
  const curatorSet = (env.IAPEER_MEMORY_CURATOR_SET || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  fmUpdate({
    files,
    ops: [],
    agent,
    vault,
    taxonomy,
    curatorSet: curatorSet.length ? curatorSet : DEFAULT_CURATOR_SET,
    stamp: true,
  });

  // TAG GATE (lean §3): validate the canon note's tags against the dictionary
  // and teach the author to fix any problem (unknown tag / no tag). The guard
  // stays SILENT on a clean write (§2.3) — output is non-null ONLY on a
  // problem. RUNTIME-AGNOSTIC: codex supports PostToolUse `additionalContext`
  // too (official codex hooks docs — the earlier «claude-only» was wrong), so
  // the SAME schema reaches both runtimes. `files` already covers claude
  // Write/Edit and codex apply_patch (multi-file).
  const problems = collectTagProblems(files, vault, taxonomy, memoryPaths(env).tagsMirrorPath);
  const output = problems.length
    ? JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PostToolUse",
          additionalContext: tagTeaching(problems),
        },
      })
    : null;
  return { stamped: true, output };
}

/**
 * Tag-gate problems across the just-written CANON files (lean §3). Reads the
 * dictionary from the LOCAL MIRROR first (audit cosmetic: the mirror exists
 * exactly because reading the iCloud source risks a dataless placeholder —
 * fail-open on an evicted source silently disarmed the gate), falling back
 * to the vault source while the mirror is not yet materialised. FAIL-OPEN —
 * an unreadable/empty dictionary yields no problems rather than rejecting
 * every tag. The agent-memory (operative) zone is not gated (canon only).
 */
export function collectTagProblems(
  files: string[],
  vault: string,
  taxonomy: TaxonomyPreset,
  mirrorPath?: string,
): string[] {
  const dictRel = tagsDictionarySourceRel(taxonomy);
  let allow: Set<string> | null = null;
  let dict = "";
  if (mirrorPath) {
    try {
      dict = fs.readFileSync(mirrorPath, "utf-8");
    } catch {
      // mirror not materialised yet — fall back to the source
    }
  }
  if (!dict.trim()) {
    try {
      dict = fs.readFileSync(path.join(vault, dictRel), "utf-8");
    } catch {
      // fail-open
    }
  }
  if (dict.trim()) allow = new Set(parseDictionaryTags(dict));
  if (!allow) return [];
  const out: string[] = [];
  for (const f of files) {
    if (resolveZone(f, vault, taxonomy) !== "permanent") continue;
    let fm: string;
    try {
      fm = splitFrontmatter(fs.readFileSync(f, "utf-8"))[0];
    } catch {
      continue;
    }
    const problems = tagGateProblems(parseNoteTags(fm), allow, {
      requireAtLeastOne: true,
      dictionaryRel: dictRel,
    });
    for (const p of problems) out.push(`${path.basename(f)}: ${p}`);
  }
  return out;
}

export function tagTeaching(problems: string[]): string {
  return (
    "[iapeer-memory] tag check — fix so this canon note indexes cleanly:\n" +
    problems.map((p) => `- ${p}`).join("\n")
  );
}

// ── dedup hint (lean §3a) ──────────────────────────────────────────────────────

/** Short fail-open budget for the dedup RPC — a slow/down memoryd must never
 *  hang a write-hook (same posture as the embedding circuit-breaker). */
export const DEDUP_TIMEOUT_MS = 1500;

type DedupResponse = {
  enabled: boolean;
  matches: Array<{ path: string; title: string; similarity: number }>;
};

/** Dedup band (≥ DEDUP_THRESHOLD → «possible duplicate», §3a) and link-hint
 *  band ([LINK_HINT_THRESHOLD, DEDUP_THRESHOLD) → «maybe link», §3b) for a
 *  canon write. One `/dedup` query, classified here. */
export type WriteHints = { dup: string[]; link: string[] };

function numEnv(v: string | undefined, fallback: number): number {
  const n = Number(v);
  return v !== undefined && !Number.isNaN(n) ? n : fallback;
}

/** POST the note body to memoryd's loopback /dedup RPC through the egress hub
 *  (loopback allowance — П6 topology), asking for matches ≥ queryThreshold.
 *  Fail-open: any error (timeout, refused, bad JSON) → null → silent. */
async function dedupFetch(
  egress: Egress,
  env: Record<string, string | undefined>,
  content: string,
  dupThreshold: number,
  linkThreshold: number,
): Promise<DedupResponse | null> {
  const port = env.IAPEER_MEMORY_MCP_PORT || "8766";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEDUP_TIMEOUT_MS);
  try {
    const res = await egress.fetch(`http://127.0.0.1:${port}/dedup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // Send BOTH band bounds so the daemon caps each band independently and
      // the §3b link band is never starved by a burst of §3a dup matches.
      body: JSON.stringify({ content, threshold: dupThreshold, linkThreshold }),
      signal: controller.signal,
    });
    if (!res.ok) return null;
    return (await res.json()) as DedupResponse;
  } catch {
    return null; // fail-open
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Dedup + link hints for a just-written CANON note (lean §3a + §3b). ONE
 * `/dedup` query (threshold = the lower band bound), classified into two
 * contiguous bands: cosine ≥ DEDUP_THRESHOLD → «possible duplicate» (§3a);
 * [LINK_HINT_THRESHOLD, DEDUP_THRESHOLD) → «maybe link» (§3b). Re-parses the
 * event independently of `runPostWrite` (keeps that sync contract). Runtime-
 * agnostic (Write/Edit + codex apply_patch). Canon-zone only. Embeddings-off →
 * memoryd returns enabled:false → both bands empty (silent).
 */
export async function collectDedupAndLinkHints(
  eventJson: string,
  egress: Egress,
  env: Record<string, string | undefined> = process.env,
): Promise<WriteHints> {
  const empty: WriteHints = { dup: [], link: [] };
  let event: {
    tool_name?: string;
    cwd?: string;
    tool_input?: { file_path?: string };
    tool_response?: unknown;
  };
  try {
    event = JSON.parse(eventJson) as typeof event;
  } catch {
    return empty;
  }
  const tool = event.tool_name ?? "";
  if (!POST_WRITE_TOOLS.has(tool)) return empty;
  const vault = env.IAPEER_MEMORY_VAULT_PATH ?? "";
  if (!vault) return empty;
  const localeRaw = env.IAPEER_MEMORY_LOCALE || "en";
  if (!isLocaleId(localeRaw)) return empty;
  const taxonomy = getTaxonomy(localeRaw);

  const dupThreshold = numEnv(env.IAPEER_MEMORY_DEDUP_THRESHOLD, DEFAULT_DEDUP_THRESHOLD);
  const linkLow = numEnv(env.IAPEER_MEMORY_LINK_HINT_THRESHOLD, DEFAULT_LINK_HINT_THRESHOLD);

  // Candidate files: claude Write/Edit carry one file_path; codex apply_patch
  // carries a patch over possibly many (RUNTIME-AGNOSTIC — the additionalContext
  // hint reaches both runtimes via the same channel).
  const candidates =
    tool === "apply_patch" ? applyPatchPaths(event) : [event.tool_input?.file_path ?? ""];
  const vaultPrefix = vault.endsWith(path.sep) ? vault : vault + path.sep;
  const files = candidates.filter(
    (p) => p.endsWith(".md") && p.startsWith(vaultPrefix) && fs.existsSync(p),
  );
  const dup: string[] = [];
  const link: string[] = [];
  for (const file of files) {
    if (resolveZone(file, vault, taxonomy) !== "permanent") continue; // canon only
    let body: string;
    try {
      body = splitFrontmatter(fs.readFileSync(file, "utf-8"))[1];
    } catch {
      continue;
    }
    if (!body.trim()) continue;
    const result = await dedupFetch(egress, env, body, dupThreshold, linkLow);
    if (!result?.enabled || !result.matches?.length) continue;
    for (const m of result.matches) {
      // self-guard: skip the querying note itself. macOS/iCloud stores paths in
      // NFD, the tool's file_path arrives NFC (как в indexer.ts) — a raw === leaked
      // a self-match for EVERY non-ASCII filename. Normalize both basenames.
      if (path.basename(m.path).normalize("NFD") === path.basename(file).normalize("NFD")) continue;
      const entry = `[[${m.title}]] (${Math.round(m.similarity * 100)}%)`;
      if (m.similarity >= dupThreshold) dup.push(entry);
      else if (m.similarity >= linkLow) link.push(entry);
    }
  }
  return { dup, link };
}

/** Combine the sync tag-teaching output with the async dedup + link hints into
 *  one additionalContext blob (or null when all empty). */
export function mergeHookOutput(tagOutput: string | null, hints: WriteHints): string | null {
  let ctx = "";
  if (tagOutput) {
    try {
      ctx = (JSON.parse(tagOutput).hookSpecificOutput?.additionalContext as string) ?? "";
    } catch {
      ctx = "";
    }
  }
  const add = (section: string) => {
    ctx = ctx ? `${ctx}\n\n${section}` : section;
  };
  if (hints.dup.length) {
    add(
      "[iapeer-memory] possible duplicate(s) of this canon note — verify, then extend " +
        "the existing note or keep only new material:\n" +
        hints.dup.map((h) => `- ${h}`).join("\n"),
    );
  }
  if (hints.link.length) {
    add(
      "[iapeer-memory] semantically close note(s) — consider linking [[…]] in the text " +
        "if related (you decide; not every close note belongs):\n" +
        hints.link.map((h) => `- ${h}`).join("\n"),
    );
  }
  if (!ctx) return null;
  return JSON.stringify({
    hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: ctx },
  });
}

// ── session-start ────────────────────────────────────────────────────────────

export type SessionStartResult = {
  /** One-line context message, or null for a healthy silent start. */
  output: string | null;
  kicked: boolean;
};

export function runSessionStart(opts: {
  paths?: MemoryPaths;
  env?: Record<string, string | undefined>;
  nowMs?: number;
  staleMs?: number;
  /** Injectable background-kicker (the CLI glue spawns verify --repair). */
  kick?: () => void;
}): SessionStartResult {
  const env = opts.env ?? process.env;
  const paths = opts.paths ?? memoryPaths(env);
  const nowMs = opts.nowMs ?? Date.now();
  const staleMs = opts.staleMs ?? DEFAULT_HEARTBEAT_STALE_MS;

  // Not provisioned at all (no config file AND no env context): one hint,
  // no repair kick — there is nothing to repair yet.
  const vault = env.IAPEER_MEMORY_VAULT_PATH ?? "";
  if (!vault && !fs.existsSync(paths.configFile)) {
    return {
      output:
        "[iapeer-memory] plugin is installed but the system is not " +
        "provisioned on this host — run: npx @agfpd/iapeer-memory init",
      kicked: false,
    };
  }

  let problem: string | null = null;
  try {
    const ageMs = nowMs - fs.statSync(paths.heartbeatPath).mtimeMs;
    if (ageMs > staleMs) {
      problem = `memoryd heartbeat is stale (${Math.round(ageMs / 1000)}s old) — the daemon looks hung`;
    }
  } catch {
    problem = "memoryd is not running (no heartbeat)";
  }
  if (!problem) return { output: null, kicked: false };

  // Debounced self-repair kick (ADR-010: the system is repaired by whichever
  // peer is alive). The stamp file gates the storm of simultaneous wakes.
  let kicked = false;
  const stamp = path.join(paths.stateDir, "verify-kick.stamp");
  let recentKick = false;
  try {
    recentKick = nowMs - fs.statSync(stamp).mtimeMs < KICK_DEBOUNCE_MS;
  } catch {
    recentKick = false;
  }
  if (!recentKick) {
    try {
      fs.mkdirSync(paths.stateDir, { recursive: true });
      guardedWriteFileSync(stamp, `${new Date(nowMs).toISOString()}\n`);
      opts.kick?.();
      kicked = true;
    } catch {
      // best effort — the warning still reaches the context
    }
  }

  return {
    output:
      `[iapeer-memory] degraded: ${problem}. ` +
      (kicked
        ? "Kicked `verify --repair` in the background; "
        : "Repair was kicked recently; ") +
      "check with: iapeer-memory verify",
    kicked,
  };
}

// ── CLI glue ─────────────────────────────────────────────────────────────────

// Bound this file: a hook that misfires on a 24/7 host (broken bin path,
// permissions) appends on every error path, so without a cap it would grow
// without limit. Single-file roll: when it crosses MAX, keep the tail.
const HOOK_LOG_MAX_BYTES = 256 * 1024;
const HOOK_LOG_KEEP_BYTES = 128 * 1024;

function logHookError(err: unknown): void {
  try {
    const dir = memoryPaths().logsDir;
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "hook-errors.log");
    try {
      if (fs.statSync(file).size > HOOK_LOG_MAX_BYTES) {
        const tail = fs.readFileSync(file, "utf-8").slice(-HOOK_LOG_KEEP_BYTES);
        guardedWriteFileSync(file, tail);
      }
    } catch {
      // no file yet (or unreadable) — nothing to bound
    }
    fs.appendFileSync(file, `${new Date().toISOString()} ${String(err)}\n`);
  } catch {
    // truly nowhere to report — stay silent, stay fail-open
  }
}

// ── bash-write attribution reminder (just-in-time design) ────────────
// A shell/bash write to the vault bypasses this hook's Write/Edit path, so
// memoryd sees only the fs-change with no identity and mis-attributes it to the
// human. When a Bash command WRITES to a vault `.md`, remind the agent to
// re-stamp its authorship via `iapeer-memory bake`. There is NO standing rule
// the reminder is the ONLY carrier, emitted just-in-time. Detection is
// best-effort — obscure forms are missed; the one false positive we must avoid
// is read-then-redirect-elsewhere (`cat note.md > /tmp/x`), so we capture the
// write-TARGET of each operator, never every vault path mentioned.

// One path token: "double-quoted" | 'single-quoted' | bare (no shell metachars).
// Quotes are REQUIRED to carry spaces — the real vault path has them
// ("…/Mobile Documents/…"), so a space-blind matcher would miss every write.
const PATH_TOKEN = String.raw`(?:"([^"]*)"|'([^']*)'|([^\s'"|&;<>()]+))`;
/** The matched path value from a PATH_TOKEN match starting at group `i`. */
function pathVal(m: RegExpMatchArray, i: number): string {
  return m[i] ?? m[i + 1] ?? m[i + 2] ?? "";
}

/** Write-TARGET paths of a bash command (best-effort): the path each write
 *  operator writes TO (never a read arg). Covers `>`/`>>`, `tee`, `sed -i`,
 *  `cp`/`mv`; handles quoted paths with spaces. */
export function bashWriteTargets(cmd: string): string[] {
  const targets: string[] = [];
  // redirection `>`/`>>` TARGET — excludes `2>` (fd), `>&` and `>(...)`.
  for (const m of cmd.matchAll(new RegExp(String.raw`(?<![0-9&])>>?\s*(?![&(])` + PATH_TOKEN, "g"))) {
    const t = pathVal(m, 1);
    if (t) targets.push(t);
  }
  // `tee [-a] FILE...` — path tokens until a pipe / terminator.
  for (const seg of cmd.matchAll(/\btee\b([^|&;]*)/g)) {
    for (const m of seg[1].matchAll(new RegExp(PATH_TOKEN, "g"))) {
      const t = pathVal(m, 1);
      if (t && !t.startsWith("-")) targets.push(t);
    }
  }
  // `sed -i…` / `--in-place` edits its file args in place → any `.md` token.
  if (/\bsed\b\s+(?:-\S*i\S*|--in-place)/.test(cmd)) {
    for (const m of cmd.matchAll(new RegExp(PATH_TOKEN, "g"))) {
      const t = pathVal(m, 1);
      if (t.endsWith(".md")) targets.push(t);
    }
  }
  // `cp`/`mv SRC… DEST` — the last path token of the segment is the destination.
  for (const seg of cmd.matchAll(/\b(?:cp|mv)\b([^|&;]*)/g)) {
    const toks: string[] = [];
    for (const m of seg[1].matchAll(new RegExp(PATH_TOKEN, "g"))) {
      const t = pathVal(m, 1);
      if (t && !t.startsWith("-")) toks.push(t);
    }
    if (toks.length >= 2) targets.push(toks[toks.length - 1]);
  }
  return targets;
}

/** A bake-reminder additionalContext when a Bash event wrote to a vault `.md`,
 *  else null. */
export function bashVaultWriteReminder(
  text: string,
  env: Record<string, string | undefined> = process.env,
): string | null {
  let event: { tool_name?: string; tool_input?: { command?: string }; cwd?: string };
  try {
    event = JSON.parse(text);
  } catch {
    return null;
  }
  if (event.tool_name !== "Bash") return null;
  const cmd = event.tool_input?.command ?? "";
  const vault = env.IAPEER_MEMORY_VAULT_PATH ?? "";
  if (!cmd || !vault) return null;
  const vaultRoot = path.resolve(vault);
  const cwd = event.cwd && path.isAbsolute(event.cwd) ? event.cwd : null;
  const hits: string[] = [];
  for (const raw of bashWriteTargets(cmd)) {
    if (!raw.endsWith(".md")) continue;
    let abs: string;
    if (path.isAbsolute(raw)) abs = path.resolve(raw);
    else if (cwd) abs = path.resolve(cwd, raw);
    else continue; // relative + unknown cwd → best-effort skip
    if (abs === vaultRoot || abs.startsWith(vaultRoot + path.sep)) hits.push(raw);
  }
  if (!hits.length) return null;
  const list = hits
    .map((h) => (/[\s'"]/.test(h) ? `'${h.replace(/'/g, "'\\''")}'` : h))
    .join(" ");
  return (
    "[iapeer-memory] you wrote a vault note via bash — the post-write hook didn't see it, " +
    "so memoryd would mis-attribute the edit to the human. Re-stamp yourself as the editor:\n" +
    `  iapeer-memory bake ${list}\n` +
    "(bake fixes last_edited_by; for a BRAND-NEW note, create it via Write so the write hook " +
    "also sets author from your identity.)"
  );
}

export async function cmdHook(argv: string[], egress: Egress): Promise<number> {
  const [event] = argv;
  try {
    switch (event) {
      case "post-write": {
        const text = await Bun.stdin.text();
        const result = runPostWrite(text); // sync: stamp + tag gate (Write/Edit)
        const hints = await collectDedupAndLinkHints(text, egress); // async, fail-open §3a/§3b
        let output = mergeHookOutput(result.output, hints);
        // Bash events have no stamp/dedup output — instead, a just-in-time bake
        // reminder when the command wrote to a vault note (mutually exclusive
        // with the Write/Edit path above; both never fire for one event).
        if (!output) {
          const bake = bashVaultWriteReminder(text);
          if (bake) {
            output = JSON.stringify({
              hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: bake },
            });
          }
        }
        if (output) console.log(output);
        return 0;
      }
      case "session-start": {
        const result = runSessionStart({
          kick: () => {
            // Self-runtime detached spawn (egress allowance 2): the child
            // re-enters main() with its own egress — sandbox env inherits.
            // COMPILED runtime (the production hook path — the shims exec the
            // installed binary): the binary always runs its embedded entry
            // and puts user args at argv[2..], so the cli.ts path must NOT
            // be passed — pre-fix the child got cmd="/$bunfs/…/cli.ts" →
            // «unknown command», and self-repair NEVER ran while the hook
            // printed «Kicked … in the background» (audit important).
            const args = isCompiledRuntime()
              ? [process.execPath, "verify", "--repair"]
              : [process.execPath, new URL("../cli.ts", import.meta.url).pathname, "verify", "--repair"];
            egress.spawnDetached(args);
          },
        });
        if (result.output) console.log(result.output);
        return 0;
      }
      default:
        console.error(
          `iapeer-memory hook: unknown event: ${event ?? "(none)"} (expected post-write | session-start)`,
        );
        return 2;
    }
  } catch (err) {
    logHookError(err);
    return 0; // fail-open by contract
  }
}
