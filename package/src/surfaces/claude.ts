/**
 * Direct claude session surfaces — ADR-009 v1.2 (прямые per-peer
 * поверхности вместо плагина-розетки). Three surfaces are
 * merged into the PEER's cwd; nothing is written host-globally (требование
 * №3) and nothing of the user's is ever clobbered (требование №1 — only our
 * own keys/entries are read-merge-written, atomically):
 *
 *   1. hooks  — entries merged into `<cwd>/.claude/settings.json`
 *               (PostToolUse Write|Edit|MultiEdit + SessionStart). The hook
 *               command is the ABSOLUTE path of our materialised shim —
 *               ownership lives IN THE DATA: an entry
 *               whose command path contains `/iapeer-memory/hooks/` is ours,
 *               everything else in the file is somebody else's (the file
 *               also carries statusline-injector, totp-presence, the core's
 *               autoMemoryEnabled — the «last writer rolls back» class is
 *               closed by patching ONLY our entries);
 *   2. mcp    — `mcpServers["iapeer-memory"]` merged into `<cwd>/.mcp.json`,
 *               LITERAL url + ENV-SUBSTITUTED identity
 *               `${PEER_IDENTITY:-claude-<peer>}`: the per-cwd literal was a
 *               cwd-landmine (stale on rename/cwd drift), so the identity now
 *               follows the live session env (with a per-peer default fallback
 *               for envless dev sessions) — matching the codex `env_http_headers`
 *               form and the core's own 8765 migration;
 *   3. skills — `<cwd>/.claude/skills/iapeer-memory-<name>/SKILL.md`
 *               (embedded bodies, bytes-compare; the directory prefix is OUR
 *               namespace — unprovision removes every match).
 *
 * Pickup semantics (documented): hooks and MCP land on
 * the peer's NEXT session start — a live session does not re-read them (same
 * semantics the plugin form had). Skills are picked up HOT by live sessions
 * (live observation) — «next restart» is the conservative
 * guarantee for all three, exact for hooks/MCP.
 *
 * Idempotent by construction: same version re-run → `already` on every
 * surface; drift (a mangled/deleted entry) → re-written. The remove path is
 * the exact mirror: our entries/keys/directories only, empty containers are
 * swept (an empty `hooks: {}` left behind would be OUR litter in the user's
 * file).
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { SKILL_BODIES, SKILL_DIR_PREFIX, SKILL_NAMES } from "../templates/skills.js";
import { guardedWriteFileSync, guardedUnlinkSync, guardedRmSync, guardedRenameSync } from "@agfpd/iapeer-memory-core";

export const MCP_SERVER_KEY = "iapeer-memory";
/**
 * In-data ownership of our hook entries — the namespace lives in the shim
 * FILE NAME (`iapeer-memory.<verb>.sh`), NOT in the directory path. D4 live
 * catch: the first form keyed on the `/iapeer-memory/hooks/` directory
 * segment, which is DERIVED from the config-file location — a custom
 * IAPEER_MEMORY_CONFIG_FILE produced a hooksDir without the segment, so our
 * own entries read as foreign (duplicated on every update, false drift on
 * every check). A basename namespace is invariant under EVERY path
 * configuration by construction. Matching is deliberately WIDER than the
 * current expected path: an entry pointing at a STALE shim location is
 * still ours — drift to repair, not a foreign entry to preserve.
 */
export const HOOK_SHIM_PREFIX = "iapeer-memory.";

export function isOurHookCommand(command: string): boolean {
  const base = command.split("/").pop() ?? "";
  return base.startsWith(HOOK_SHIM_PREFIX) && base.endsWith(".sh");
}

export type SurfaceAction =
  | "written"
  | "already"
  | "removed"
  | "absent"
  | "failed"
  /** A live-host step suppressed by the refusing egress (test sandbox). */
  | "skipped";
export type SurfaceOutcome = {
  surface: "hooks" | "mcp" | "skills" | "trust";
  action: SurfaceAction;
  path: string;
  detail?: string;
};

// ── shims (fail-open bash, materialised into OUR territory) ──────────────────

function shimContent(verb: "post-write" | "session-start"): string {
  return [
    "#!/usr/bin/env bash",
    `# iapeer-memory hook shim — ALL logic lives in the package CLI`,
    `# (\`iapeer-memory hook ${verb}\`; testable TS, ADR-009 v1.2 direct form).`,
    "# Fail-open: no CLI on this host → silent exit 0.",
    "set -euo pipefail",
    'CLI="$(command -v iapeer-memory || true)"',
    '[ -n "$CLI" ] || CLI="$HOME/.local/bin/iapeer-memory"',
    '[ -x "$CLI" ] || exit 0',
    `exec "$CLI" hook ${verb}`,
    "",
  ].join("\n");
}

export function writeFileAtomic(filePath: string, content: string, mode?: number): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  // Unique tmp — concurrent writers must not share a truncatable tmp file
  // (audit important, the fleet.json class).
  const tmp = `${filePath}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  guardedWriteFileSync(tmp, content, "utf-8");
  if (mode !== undefined) fs.chmodSync(tmp, mode);
  guardedRenameSync(tmp, filePath);
}

/** Materialise both hook shims (package-owned, bytes-compare). provision
 *  always runs this first — the merged settings entries must never point at
 *  a void (the core's birth-hook may call provision-peer on a host where
 *  init ran long ago and the shims were swept by hand). */
export function shimPath(hooksDir: string, verb: "post-write" | "session-start"): string {
  return path.join(hooksDir, `${HOOK_SHIM_PREFIX}${verb}.sh`); // namespace IN the basename
}

export function materialiseShims(hooksDir: string): "written" | "identical" {
  let wrote = false;
  for (const verb of ["post-write", "session-start"] as const) {
    const p = shimPath(hooksDir, verb);
    const content = shimContent(verb);
    try {
      if (fs.readFileSync(p, "utf-8") === content) continue;
    } catch {
      // missing → write
    }
    writeFileAtomic(p, content, 0o755);
    wrote = true;
  }
  return wrote ? "written" : "identical";
}

// ── expected forms ───────────────────────────────────────────────────────────

/** LITERAL url + ENV-SUBSTITUTED identity header, with a per-peer DEFAULT
 *  fallback: `${PEER_IDENTITY:-claude-<personality>}`. The live session env
 *  (`PEER_IDENTITY=claude-<peer>`, same value memoryd's parser strips to the
 *  personality) is used when set — closing the cwd-landmine (a bare literal
 *  goes stale on rename / cwd drift; the env follows the live session) and
 *  matching the core's own 8765 entry. The `:-claude-<personality>` fallback
 *  keeps manual dev sessions (no PEER_IDENTITY in env) working;
 *  env-substitution proven live by iapeer (reverses the D1/D2 literal
 *  form back). Port is the host fact baked at provision; drift is repaired by
 *  the update/verify sweep. */
export function expectedMcpEntry(opts: {
  port: number;
  personality: string;
}): Record<string, unknown> {
  return {
    type: "http",
    url: `http://127.0.0.1:${opts.port}/mcp`,
    headers: {
      "X-IAPeer-Identity": `\${PEER_IDENTITY:-claude-${opts.personality}}`,
    },
  };
}

export type HookEntry = {
  matcher?: string;
  hooks: Array<{ type: string; command: string }>;
};

export function expectedHookEntries(
  hooksDir: string,
): Record<"PostToolUse" | "SessionStart", HookEntry> {
  return {
    PostToolUse: {
      // Bash is included so a shell write to the vault (which bypasses the
      // Write/Edit path) triggers the just-in-time bake-attribution reminder.
      // The bin fast-exits for the (vast majority of) bash commands that touch
      // no vault note.
      matcher: "Write|Edit|MultiEdit|Bash",
      hooks: [{ type: "command", command: shimPath(hooksDir, "post-write") }],
    },
    SessionStart: {
      hooks: [{ type: "command", command: shimPath(hooksDir, "session-start") }],
    },
  };
}

// ── json plumbing ────────────────────────────────────────────────────────────

type JsonObject = Record<string, unknown>;

/** null = unreadable-as-object (refuse to clobber); {} when absent. */
export function readJsonObject(filePath: string): JsonObject | null | "absent" {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf-8");
  } catch {
    return "absent";
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as JsonObject;
  } catch {
    return null;
  }
}

/**
 * Structural deep-equal, key-order-INSENSITIVE for objects (audit cosmetic:
 * the stringify comparison read a `claude mcp add`-reserialized .mcp.json —
 * same entry, different key order — as drift, and every verify --repair
 * rewrote the file the foreign tool would re-normalise again: perpetual
 * mutual churn on a perfectly healthy surface). Array ORDER stays significant
 * — for hooks lists it carries meaning.
 */
export function sameJson(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, i) => sameJson(item, b[i]));
  }
  if (typeof a === "object") {
    const ka = Object.keys(a as Record<string, unknown>);
    const kb = Object.keys(b as Record<string, unknown>);
    if (ka.length !== kb.length) return false;
    return ka.every((k) =>
      Object.prototype.hasOwnProperty.call(b, k) &&
      sameJson((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]),
    );
  }
  return false; // primitives already failed ===
}

export function isOurHookEntry(entry: unknown): boolean {
  if (!entry || typeof entry !== "object") return false;
  const hooks = (entry as HookEntry).hooks;
  if (!Array.isArray(hooks)) return false;
  return hooks.some(
    (h) => typeof h?.command === "string" && isOurHookCommand(h.command),
  );
}

// ── hooks surface ────────────────────────────────────────────────────────────

export function mergeClaudeHooks(opts: {
  cwd: string;
  hooksDir: string;
}): SurfaceOutcome {
  const settingsPath = path.join(opts.cwd, ".claude", "settings.json");
  const current = readJsonObject(settingsPath);
  if (current === null) {
    return {
      surface: "hooks",
      action: "failed",
      path: settingsPath,
      detail: "settings.json is not a JSON object — refusing to clobber",
    };
  }
  const obj: JsonObject = current === "absent" ? {} : current;
  const hooksRaw = obj.hooks;
  if (hooksRaw !== undefined && (typeof hooksRaw !== "object" || Array.isArray(hooksRaw) || hooksRaw === null)) {
    return {
      surface: "hooks",
      action: "failed",
      path: settingsPath,
      detail: "settings.json `hooks` is not an object — refusing to clobber",
    };
  }
  const hooks: JsonObject = (hooksRaw as JsonObject | undefined) ?? {};
  const expected = expectedHookEntries(opts.hooksDir);
  let changed = false;
  for (const event of ["PostToolUse", "SessionStart"] as const) {
    const listRaw = hooks[event];
    const list: unknown[] = Array.isArray(listRaw) ? listRaw : [];
    const ours = list.filter(isOurHookEntry);
    if (ours.length === 1 && sameJson(ours[0], expected[event])) continue;
    const foreign = list.filter((e) => !isOurHookEntry(e));
    hooks[event] = [...foreign, expected[event]];
    changed = true;
  }
  if (!changed) {
    return { surface: "hooks", action: "already", path: settingsPath };
  }
  obj.hooks = hooks;
  writeFileAtomic(settingsPath, `${JSON.stringify(obj, null, 2)}\n`);
  return { surface: "hooks", action: "written", path: settingsPath };
}

export function removeClaudeHooks(opts: { cwd: string }): SurfaceOutcome {
  const settingsPath = path.join(opts.cwd, ".claude", "settings.json");
  const current = readJsonObject(settingsPath);
  if (current === "absent") {
    return { surface: "hooks", action: "absent", path: settingsPath };
  }
  if (current === null) {
    return {
      surface: "hooks",
      action: "failed",
      path: settingsPath,
      detail: "settings.json is not a JSON object — refusing to touch",
    };
  }
  const hooksRaw = current.hooks;
  if (!hooksRaw || typeof hooksRaw !== "object" || Array.isArray(hooksRaw)) {
    return { surface: "hooks", action: "absent", path: settingsPath };
  }
  const hooks = hooksRaw as JsonObject;
  let changed = false;
  for (const event of Object.keys(hooks)) {
    const list = hooks[event];
    if (!Array.isArray(list)) continue;
    const kept = list
      .map((entry) => {
        if (!isOurHookEntry(entry)) return entry;
        // an entry may THEORETICALLY mix our hook with a foreign one in the
        // same matcher block — strip only our hook elements, keep the rest
        const e = entry as HookEntry;
        const foreignHooks = e.hooks.filter(
          (h) => !(typeof h?.command === "string" && isOurHookCommand(h.command)),
        );
        if (foreignHooks.length === 0) return null; // entirely ours → drop
        return { ...e, hooks: foreignHooks };
      })
      .filter((e): e is NonNullable<typeof e> => e !== null);
    if (kept.length !== list.length || !sameJson(kept, list)) changed = true;
    if (kept.length === 0) {
      delete hooks[event];
    } else {
      hooks[event] = kept;
    }
  }
  if (!changed) {
    return { surface: "hooks", action: "absent", path: settingsPath };
  }
  if (Object.keys(hooks).length === 0) {
    delete current.hooks; // our litter, not the user's — sweep the container
  }
  writeFileAtomic(settingsPath, `${JSON.stringify(current, null, 2)}\n`);
  return { surface: "hooks", action: "removed", path: settingsPath };
}

// ── mcp surface ──────────────────────────────────────────────────────────────

export function mergeClaudeMcp(opts: {
  cwd: string;
  port: number;
  personality: string;
}): SurfaceOutcome {
  const mcpPath = path.join(opts.cwd, ".mcp.json");
  const current = readJsonObject(mcpPath);
  if (current === null) {
    return {
      surface: "mcp",
      action: "failed",
      path: mcpPath,
      detail: ".mcp.json is not a JSON object — refusing to clobber",
    };
  }
  const obj: JsonObject = current === "absent" ? {} : current;
  const serversRaw = obj.mcpServers;
  if (serversRaw !== undefined && (typeof serversRaw !== "object" || Array.isArray(serversRaw) || serversRaw === null)) {
    return {
      surface: "mcp",
      action: "failed",
      path: mcpPath,
      detail: ".mcp.json `mcpServers` is not an object — refusing to clobber",
    };
  }
  const servers: JsonObject = (serversRaw as JsonObject | undefined) ?? {};
  const expected = expectedMcpEntry({ port: opts.port, personality: opts.personality });
  if (sameJson(servers[MCP_SERVER_KEY], expected)) {
    return { surface: "mcp", action: "already", path: mcpPath };
  }
  servers[MCP_SERVER_KEY] = expected;
  obj.mcpServers = servers;
  writeFileAtomic(mcpPath, `${JSON.stringify(obj, null, 2)}\n`);
  return { surface: "mcp", action: "written", path: mcpPath };
}

export function removeClaudeMcp(opts: { cwd: string }): SurfaceOutcome {
  const mcpPath = path.join(opts.cwd, ".mcp.json");
  const current = readJsonObject(mcpPath);
  if (current === "absent") {
    return { surface: "mcp", action: "absent", path: mcpPath };
  }
  if (current === null) {
    return {
      surface: "mcp",
      action: "failed",
      path: mcpPath,
      detail: ".mcp.json is not a JSON object — refusing to touch",
    };
  }
  const servers = current.mcpServers;
  if (!servers || typeof servers !== "object" || Array.isArray(servers) ||
      !(MCP_SERVER_KEY in (servers as JsonObject))) {
    return { surface: "mcp", action: "absent", path: mcpPath };
  }
  delete (servers as JsonObject)[MCP_SERVER_KEY];
  const serversEmpty = Object.keys(servers as JsonObject).length === 0;
  const onlyServersKey = Object.keys(current).length === 1;
  if (serversEmpty && onlyServersKey) {
    // semantically empty file — with our key gone it says nothing; a file we
    // most likely created. Removing it leaves the cwd exactly as found.
    guardedUnlinkSync(mcpPath);
    return { surface: "mcp", action: "removed", path: mcpPath, detail: "file removed (empty after our key)" };
  }
  writeFileAtomic(mcpPath, `${JSON.stringify(current, null, 2)}\n`);
  return { surface: "mcp", action: "removed", path: mcpPath };
}

// ── skills surface ───────────────────────────────────────────────────────────

export function mergeClaudeSkills(opts: { cwd: string }): SurfaceOutcome {
  const skillsDir = path.join(opts.cwd, ".claude", "skills");
  let wrote = 0;
  try {
    for (const name of SKILL_NAMES) {
      const p = path.join(skillsDir, name, "SKILL.md");
      const body = SKILL_BODIES[name];
      try {
        if (fs.readFileSync(p, "utf-8") === body) continue;
      } catch {
        // missing → write
      }
      writeFileAtomic(p, body);
      wrote++;
    }
  } catch (err) {
    return { surface: "skills", action: "failed", path: skillsDir, detail: String(err) };
  }
  return wrote
    ? { surface: "skills", action: "written", path: skillsDir, detail: `${wrote}/${SKILL_NAMES.length} skill(s) written` }
    : { surface: "skills", action: "already", path: skillsDir };
}

export function removeClaudeSkills(opts: { cwd: string }): SurfaceOutcome {
  const skillsDir = path.join(opts.cwd, ".claude", "skills");
  let entries: string[];
  try {
    entries = fs.readdirSync(skillsDir);
  } catch {
    return { surface: "skills", action: "absent", path: skillsDir };
  }
  // the `iapeer-memory-` prefix is OUR namespace (the naming promise): every
  // matching directory is ours — including stale names of older versions
  const ours = entries.filter((e) => e.startsWith(SKILL_DIR_PREFIX));
  if (ours.length === 0) {
    return { surface: "skills", action: "absent", path: skillsDir };
  }
  for (const e of ours) {
    guardedRmSync(path.join(skillsDir, e), { recursive: true, force: true });
  }
  // sweep empty containers we may have created (skills/ then .claude/)
  for (const dir of [skillsDir, path.dirname(skillsDir)]) {
    try {
      if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
    } catch {
      break;
    }
  }
  return { surface: "skills", action: "removed", path: skillsDir, detail: `${ours.length} skill dir(s) removed` };
}

// ── the per-peer verbs ───────────────────────────────────────────────────────

export function provisionClaudePeer(opts: {
  cwd: string;
  hooksDir: string;
  port: number;
  personality: string;
}): SurfaceOutcome[] {
  materialiseShims(opts.hooksDir);
  return [
    mergeClaudeHooks({ cwd: opts.cwd, hooksDir: opts.hooksDir }),
    mergeClaudeMcp({ cwd: opts.cwd, port: opts.port, personality: opts.personality }),
    mergeClaudeSkills({ cwd: opts.cwd }),
  ];
}

export function unprovisionClaudePeer(opts: { cwd: string }): SurfaceOutcome[] {
  return [
    removeClaudeHooks({ cwd: opts.cwd }),
    removeClaudeMcp({ cwd: opts.cwd }),
    removeClaudeSkills({ cwd: opts.cwd }),
  ];
}

/** Read-only drift check of one peer's claude surfaces (verify's eye; D3
 *  wires it into `verify [--repair]` across the fleet map). */
export function checkClaudePeer(opts: {
  cwd: string;
  hooksDir: string;
  port: number;
  personality: string;
}): Array<{ surface: SurfaceOutcome["surface"]; ok: boolean; detail: string }> {
  const out: Array<{ surface: SurfaceOutcome["surface"]; ok: boolean; detail: string }> = [];

  const settingsPath = path.join(opts.cwd, ".claude", "settings.json");
  const settings = readJsonObject(settingsPath);
  const expected = expectedHookEntries(opts.hooksDir);
  if (settings === "absent" || settings === null) {
    out.push({ surface: "hooks", ok: false, detail: `no readable settings at ${settingsPath}` });
  } else {
    const hooks = (settings.hooks ?? {}) as JsonObject;
    const missing = (["PostToolUse", "SessionStart"] as const).filter((event) => {
      const list = Array.isArray(hooks[event]) ? (hooks[event] as unknown[]) : [];
      const ours = list.filter(isOurHookEntry);
      return !(ours.length === 1 && sameJson(ours[0], expected[event]));
    });
    out.push(
      missing.length === 0
        ? { surface: "hooks", ok: true, detail: "both hook entries in place" }
        : { surface: "hooks", ok: false, detail: `drifted/missing: ${missing.join(", ")}` },
    );
  }

  const mcp = readJsonObject(path.join(opts.cwd, ".mcp.json"));
  const entry =
    mcp !== "absent" && mcp !== null
      ? ((mcp.mcpServers as JsonObject | undefined) ?? {})[MCP_SERVER_KEY]
      : undefined;
  out.push(
    sameJson(entry, expectedMcpEntry({ port: opts.port, personality: opts.personality }))
      ? { surface: "mcp", ok: true, detail: `${MCP_SERVER_KEY} server entry in place` }
      : { surface: "mcp", ok: false, detail: `mcpServers["${MCP_SERVER_KEY}"] missing or drifted in ${opts.cwd}/.mcp.json` },
  );

  const skillsDir = path.join(opts.cwd, ".claude", "skills");
  const drifted = SKILL_NAMES.filter((name) => {
    try {
      return fs.readFileSync(path.join(skillsDir, name, "SKILL.md"), "utf-8") !== SKILL_BODIES[name];
    } catch {
      return true;
    }
  });
  out.push(
    drifted.length === 0
      ? { surface: "skills", ok: true, detail: `${SKILL_NAMES.length} skills in place` }
      : { surface: "skills", ok: false, detail: `missing/drifted: ${drifted.join(", ")}` },
  );

  return out;
}
