/**
 * Direct codex session surface — per-peer MCP via the PROJECT-LOCAL
 * `<cwd>/.codex/config.toml` (ADR-009 v1.2; требование №3 «глобально
 * не класть» — proven satisfiable by the iapeer smoke: a
 * project-local `[mcp_servers]` block in a TRUSTED cwd is read by
 * `codex mcp list` AND imported end-to-end into exec sessions; the trust
 * record is written by the core's provision, keyed on the realpath).
 *
 * Block form mirrors the core's PROVEN host-wide `[mcp_servers.iapeer]`
 * block (iapeer src/init/index.ts writeCodexMcpConfig — live on the whole
 * codex fleet), pointed at memoryd:
 *
 *   - `url` — the memoryd HTTP-MCP endpoint. TOML carries no env
 *     substitution: the LITERAL port is baked at provision time from the
 *     host config (IAPEER_MEMORY_MCP_PORT, default 8766); a port change is
 *     re-baked by the update/verify sweep;
 *   - `default_tools_approval_mode = "approve"` — no per-tool dialog;
 *   - `bearer_token_env_var = "IAPEER_BEARER"` — flips codex's authStatus
 *     so the tools import (#21532/#4707 workaround); the value is the
 *     NON-SECRET dummy the core's launch exports to EVERY codex peer;
 *   - `env_http_headers."X-IAPeer-Identity" = "PEER_IDENTITY"` — per-peer
 *     identity from the launch env (`codex-<personality>`; memoryd's parser
 *     strips the runtime prefix). A codex session started OUTSIDE an iapeer
 *     launch carries no PEER_IDENTITY — same unattributed fallback the
 *     claude env form has.
 *
 * The file CARRIES FOREIGN CONTENT — the core's native-memory lever writes
 * `[features] memories = false` here, the operator may keep own sections.
 * Merge = line-based section surgery on OUR header namespace only
 * (`[mcp_servers.iapeer-memory]` + its subsections), atomic write; unlike
 * the core's append-if-absent we REPLACE a drifted block (repair duty,
 * требование №2). Hooks (Ш2) live in `<cwd>/.codex/hooks.json` below;
 * skills for codex are deliberately NOT delivered (P5 §4.2).
 */

import fs from "node:fs";
import path from "node:path";
import { IAPEER_BIN, type Egress } from "../egress.js";
import {
  isOurHookEntry,
  materialiseShims,
  readJsonObject,
  sameJson,
  shimPath,
  type HookEntry,
  type SurfaceOutcome,
} from "./claude.js";
import { guardedWriteFileSync, guardedUnlinkSync } from "@agfpd/iapeer-memory-core";

export const CODEX_MCP_SECTION = "mcp_servers.iapeer-memory";
const SECTION_HEADER_RE = /^\s*\[/;
const OUR_HEADER_RE = /^\s*\[mcp_servers\.iapeer-memory(\.[A-Za-z0-9_.-]+)?\]\s*$/;

export function codexConfigPath(cwd: string): string {
  return path.join(cwd, ".codex", "config.toml");
}

export function expectedCodexBlock(port: number): string {
  return [
    `[${CODEX_MCP_SECTION}]`,
    `url = "http://127.0.0.1:${port}/mcp"`,
    `default_tools_approval_mode = "approve"`,
    `bearer_token_env_var = "IAPEER_BEARER"`,
    "",
    `[${CODEX_MCP_SECTION}.env_http_headers]`,
    `"X-IAPeer-Identity" = "PEER_IDENTITY"`,
    "",
  ].join("\n");
}

function writeFileAtomic(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp`;
  guardedWriteFileSync(tmp, content, "utf-8");
  fs.renameSync(tmp, filePath);
}

/** Strip every section under OUR header namespace; foreign lines unchanged. */
function withoutOurSections(lines: string[]): string[] {
  const kept: string[] = [];
  let inOurs = false;
  for (const line of lines) {
    if (SECTION_HEADER_RE.test(line)) inOurs = OUR_HEADER_RE.test(line);
    if (!inOurs) kept.push(line);
  }
  // drop the trailing blank run our removal may have exposed
  while (kept.length > 0 && kept[kept.length - 1].trim() === "") kept.pop();
  return kept;
}

function hasOurSection(text: string): boolean {
  return text.split("\n").some((l) => OUR_HEADER_RE.test(l));
}

export function mergeCodexMcp(opts: { cwd: string; port: number }): SurfaceOutcome {
  const configPath = codexConfigPath(opts.cwd);
  let text = "";
  try {
    text = fs.readFileSync(configPath, "utf-8");
  } catch {
    // no config yet → create
  }
  const lines = text.length ? text.split("\n") : [];
  const foreign = withoutOurSections(lines);
  const next =
    (foreign.length ? `${foreign.join("\n")}\n\n` : "") + expectedCodexBlock(opts.port);
  if (next === text) {
    return { surface: "mcp", action: "already", path: configPath };
  }
  writeFileAtomic(configPath, next);
  return { surface: "mcp", action: "written", path: configPath };
}

export function removeCodexMcp(opts: { cwd: string }): SurfaceOutcome {
  const configPath = codexConfigPath(opts.cwd);
  let text: string;
  try {
    text = fs.readFileSync(configPath, "utf-8");
  } catch {
    return { surface: "mcp", action: "absent", path: configPath };
  }
  if (!hasOurSection(text)) {
    return { surface: "mcp", action: "absent", path: configPath };
  }
  const foreign = withoutOurSections(text.split("\n"));
  if (foreign.every((l) => l.trim() === "")) {
    // nothing but our block lived here — leave the cwd exactly as found
    guardedUnlinkSync(configPath);
    return { surface: "mcp", action: "removed", path: configPath, detail: "file removed (empty after our block)" };
  }
  writeFileAtomic(configPath, `${foreign.join("\n")}\n`);
  return { surface: "mcp", action: "removed", path: configPath };
}

// ── hooks surface (Ш2, P5_CODEX_ADAPTER_DESIGN §4.1) ────────────────────────
//
// File-based (non-plugin) hooks — live-proven by the iapeer smoke
// (codex-cli 0.138.0): `<cwd>/.codex/hooks.json` of a TRUSTED cwd, format
// Claude-compatible. The SAME shims serve both runtimes (all logic lives in
// the CLI verbs; codex stdin-JSON is Claude-compatible — canon note
// «Поверхности конфигурации codex» §Хуки).
//
// NO matcher ON PURPOSE: matcher inclusion in the upstream trust-hash
// identity is unverified (canon note) and an untrusted hook in headless
// exec SKIPS SILENTLY — the worst failure mode. Without a matcher the
// identity walks the verified algorithm branch; the CLI's cheap tool_name
// gate (hook.ts) filters the per-tool noise instead.
//
// Trust pre-seed: `iapeer trust-hooks <realpath>` (core ≥0.2.32) — the verb
// owns the hash algorithm; we never compute it (agreed: one point of
// truth). Cleanup of [hooks.state] on peer REMOVAL is the core's rail;
// off-peer/off-all leave orphan records — harmless (keyed on the realpath
// of a file we just removed; codex finds nothing to run).

export function codexHooksJsonPath(cwd: string): string {
  return path.join(cwd, ".codex", "hooks.json");
}

export function expectedCodexHookEntries(
  hooksDir: string,
): Record<"PostToolUse" | "SessionStart", HookEntry> {
  return {
    PostToolUse: {
      hooks: [{ type: "command", command: shimPath(hooksDir, "post-write") }],
    },
    SessionStart: {
      hooks: [{ type: "command", command: shimPath(hooksDir, "session-start") }],
    },
  };
}

export function mergeCodexHooks(opts: { cwd: string; hooksDir: string }): SurfaceOutcome {
  const hooksJson = codexHooksJsonPath(opts.cwd);
  const current = readJsonObject(hooksJson);
  if (current === null) {
    return {
      surface: "hooks",
      action: "failed",
      path: hooksJson,
      detail: "hooks.json is not a JSON object — refusing to clobber",
    };
  }
  const obj: Record<string, unknown> = current === "absent" ? {} : current;
  const hooksRaw = obj.hooks;
  if (
    hooksRaw !== undefined &&
    (typeof hooksRaw !== "object" || Array.isArray(hooksRaw) || hooksRaw === null)
  ) {
    return {
      surface: "hooks",
      action: "failed",
      path: hooksJson,
      detail: "hooks.json `hooks` is not an object — refusing to clobber",
    };
  }
  const hooks: Record<string, unknown> = (hooksRaw as Record<string, unknown> | undefined) ?? {};
  const expected = expectedCodexHookEntries(opts.hooksDir);
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
    return { surface: "hooks", action: "already", path: hooksJson };
  }
  obj.hooks = hooks;
  writeFileAtomic(hooksJson, `${JSON.stringify(obj, null, 2)}\n`);
  return { surface: "hooks", action: "written", path: hooksJson };
}

export function removeCodexHooks(opts: { cwd: string }): SurfaceOutcome {
  const hooksJson = codexHooksJsonPath(opts.cwd);
  const current = readJsonObject(hooksJson);
  if (current === "absent") {
    return { surface: "hooks", action: "absent", path: hooksJson };
  }
  if (current === null) {
    return {
      surface: "hooks",
      action: "failed",
      path: hooksJson,
      detail: "hooks.json is not a JSON object — refusing to touch",
    };
  }
  const hooksRaw = current.hooks;
  if (!hooksRaw || typeof hooksRaw !== "object" || Array.isArray(hooksRaw)) {
    return { surface: "hooks", action: "absent", path: hooksJson };
  }
  const hooks = hooksRaw as Record<string, unknown>;
  let changed = false;
  for (const event of Object.keys(hooks)) {
    const list = hooks[event];
    if (!Array.isArray(list)) continue;
    const kept = list
      .map((entry) => {
        if (!isOurHookEntry(entry)) return entry;
        const e = entry as HookEntry;
        const foreignHooks = e.hooks.filter(
          (h) => !(typeof h?.command === "string" && h.command.split("/").pop()?.startsWith("iapeer-memory.")),
        );
        if (foreignHooks.length === 0) return null;
        return { ...e, hooks: foreignHooks };
      })
      .filter((e): e is NonNullable<typeof e> => e !== null);
    if (kept.length !== list.length || !sameJson(kept, list)) changed = true;
    if (kept.length === 0) delete hooks[event];
    else hooks[event] = kept;
  }
  if (!changed) {
    return { surface: "hooks", action: "absent", path: hooksJson };
  }
  if (Object.keys(hooks).length === 0) delete current.hooks;
  if (Object.keys(current).length === 0) {
    // nothing but our hooks lived here — leave the cwd exactly as found
    guardedUnlinkSync(hooksJson);
    return { surface: "hooks", action: "removed", path: hooksJson, detail: "file removed (empty after our entries)" };
  }
  writeFileAtomic(hooksJson, `${JSON.stringify(current, null, 2)}\n`);
  return { surface: "hooks", action: "removed", path: hooksJson };
}

/** Trust pre-seed via the core verb (≥0.2.32). The refusing egress maps to
 *  a SKIP (sandbox never touches the live host config); a failed verb is a
 *  LOUD failure — an untrusted hook skips silently in headless, the worst
 *  degradation mode (acceptance condition: visible only). */
export function trustCodexHooks(
  egress: Egress,
  opts: { hooksJsonPath: string; iapeerBin?: string },
): SurfaceOutcome {
  let real: string;
  try {
    real = fs.realpathSync(opts.hooksJsonPath); // trust keys on the REALPATH (core contract)
  } catch {
    return {
      surface: "trust",
      action: "failed",
      path: opts.hooksJsonPath,
      detail: "hooks.json unreadable for realpath — trust not attempted",
    };
  }
  const bin = opts.iapeerBin ?? IAPEER_BIN;
  const proc = egress.spawnSync([bin, "trust-hooks", real], {
    explicitBin: opts.iapeerBin !== undefined,
  });
  if (proc.refused) {
    return {
      surface: "trust",
      action: "skipped",
      path: real,
      detail: "suppressed (test sandbox) — live pre-seed runs on the host",
    };
  }
  if (proc.spawnError) {
    return { surface: "trust", action: "failed", path: real, detail: `${bin} unavailable: ${proc.spawnError}` };
  }
  if (proc.exitCode !== 0) {
    return {
      surface: "trust",
      action: "failed",
      path: real,
      detail:
        (proc.stderr.trim() || proc.stdout.trim() || `trust-hooks exited ${proc.exitCode}`).slice(0, 200) +
        " — hooks stay UNTRUSTED (headless codex skips them silently); core ≥0.2.32 required",
    };
  }
  const line = proc.stdout.trim().split("\n")[0] ?? "";
  return {
    surface: "trust",
    action: line.toLowerCase().includes("already") ? "already" : "written",
    path: real,
    detail: line || undefined,
  };
}

export function provisionCodexPeer(
  egress: Egress,
  opts: { cwd: string; port: number; hooksDir: string; iapeerBin?: string },
): SurfaceOutcome[] {
  // Shims first — the merged hooks.json must never point at a void (same
  // ordering duty as the claude provision).
  materialiseShims(opts.hooksDir);
  const mcp = mergeCodexMcp({ cwd: opts.cwd, port: opts.port });
  const hooks = mergeCodexHooks({ cwd: opts.cwd, hooksDir: opts.hooksDir });
  const trust =
    hooks.action === "failed"
      ? ({
          surface: "trust",
          action: "failed",
          path: codexHooksJsonPath(opts.cwd),
          detail: "hooks surface failed — trust not attempted",
        } as SurfaceOutcome)
      : trustCodexHooks(egress, {
          hooksJsonPath: codexHooksJsonPath(opts.cwd),
          iapeerBin: opts.iapeerBin,
        });
  return [mcp, hooks, trust];
}

export function unprovisionCodexPeer(opts: { cwd: string }): SurfaceOutcome[] {
  // [hooks.state] cleanup is the core's rail (`iapeer remove`); off-peer/
  // off-all leave orphan records keyed on a now-absent file — harmless.
  return [removeCodexMcp(opts), removeCodexHooks(opts)];
}

/** Read-only drift check (verify's eye, D3 + Ш2): the MCP block byte-exact,
 *  our hook entries in hooks.json, and the trust state via the core's
 *  `trust-hooks --check` (the hash algorithm lives in ONE place — the core;
 *  we render its verdict, never compute it). Degradation is VISIBLE by
 *  acceptance condition: an untrusted hook skips silently in headless. */
export function checkCodexPeer(
  egress: Egress,
  opts: {
    cwd: string;
    port: number;
    hooksDir: string;
    iapeerBin?: string;
  },
): Array<{ surface: SurfaceOutcome["surface"]; ok: boolean; detail: string }> {
  const checks: Array<{ surface: SurfaceOutcome["surface"]; ok: boolean; detail: string }> = [];

  const configPath = codexConfigPath(opts.cwd);
  let text: string | null = null;
  try {
    text = fs.readFileSync(configPath, "utf-8");
  } catch {
    checks.push({ surface: "mcp", ok: false, detail: `no codex config at ${configPath}` });
  }
  if (text !== null) {
    const expected = expectedCodexBlock(opts.port);
    checks.push(
      text.includes(expected)
        ? { surface: "mcp", ok: true, detail: `[${CODEX_MCP_SECTION}] block in place` }
        : hasOurSection(text)
          ? { surface: "mcp", ok: false, detail: `[${CODEX_MCP_SECTION}] block drifted in ${configPath}` }
          : { surface: "mcp", ok: false, detail: `[${CODEX_MCP_SECTION}] block missing in ${configPath}` },
    );
  }

  // hooks.json: exactly our entry per event (in-data ownership, shim basename)
  const hooksJson = codexHooksJsonPath(opts.cwd);
  const current = readJsonObject(hooksJson);
  if (current === "absent" || current === null) {
    checks.push({
      surface: "hooks",
      ok: false,
      detail:
        current === null
          ? `hooks.json unreadable as object (${hooksJson})`
          : `hooks.json missing (${hooksJson})`,
    });
  } else {
    const expected = expectedCodexHookEntries(opts.hooksDir);
    const hooks = (current.hooks ?? {}) as Record<string, unknown>;
    const bad: string[] = [];
    for (const event of ["PostToolUse", "SessionStart"] as const) {
      const list: unknown[] = Array.isArray(hooks[event]) ? (hooks[event] as unknown[]) : [];
      const ours = list.filter(isOurHookEntry);
      if (!(ours.length === 1 && sameJson(ours[0], expected[event]))) bad.push(event);
    }
    checks.push(
      bad.length === 0
        ? { surface: "hooks", ok: true, detail: "our hook entries in place" }
        : { surface: "hooks", ok: false, detail: `hook entries drifted/missing: ${bad.join(", ")} (${hooksJson})` },
    );

    // trust state — only meaningful when the entries are in place
    if (bad.length === 0) {
      let real: string | null = null;
      try {
        real = fs.realpathSync(hooksJson);
      } catch {
        real = null;
      }
      if (real === null) {
        checks.push({ surface: "trust", ok: false, detail: "hooks.json vanished mid-check" });
      } else {
        const bin = opts.iapeerBin ?? IAPEER_BIN;
        const proc = egress.spawnSync([bin, "trust-hooks", real, "--check"], {
          explicitBin: opts.iapeerBin !== undefined,
        });
        if (proc.refused) {
          checks.push({
            surface: "trust",
            ok: true,
            detail: "trust check skipped (test sandbox)",
          });
        } else if (proc.spawnError) {
          checks.push({
            surface: "trust",
            ok: false,
            detail: `trust state UNKNOWN — ${bin} unavailable (${proc.spawnError}); untrusted hooks skip silently in headless`,
          });
        } else if (proc.exitCode === 0) {
          checks.push({ surface: "trust", ok: true, detail: "hooks trusted (trust-hooks --check)" });
        } else {
          checks.push({
            surface: "trust",
            ok: false,
            detail:
              `hooks NOT trusted (drift/missing per trust-hooks --check): ` +
              `${(proc.stdout.trim() || proc.stderr.trim()).slice(0, 160)} — repair: provision-peer / update`,
          });
        }
      }
    }
  }

  return checks;
}
