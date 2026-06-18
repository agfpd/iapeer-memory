/**
 * Role-doctrine renderer — templates → peerDoctrine (ADR-009/010, нюанс 4).
 *
 * Port of the surviving core of the reference
 * `scripts/mergemind-render-agent-files.py` (parity against
 * `tests/python/test_render_agent_files.py`, 7 fixtures). What survives and
 * what changed:
 *
 * - the ONLY render target is the peer's doctrine
 *   `<peerCwd>/.iapeer/IAPEER.md` — the `.claude/agents/*` targets are
 *   claude-специфика and are DROPPED (план адаптации / ADR-009); the
 *   per-role gate generalises from "index only" to "any role peer";
 * - the template's leading YAML frontmatter is STRIPPED (the launch layer
 *   glues its own identity block — the reference IAPEER.md branch did the
 *   same);
 * - a VERSION MARKER comment is prepended (ADR-010): `verify --repair`
 *   compares the rendered version against the package templates and
 *   re-renders on mismatch; roles pick the new doctrine up on their next
 *   cold-wake (ADR-007), no restarts;
 * - idempotent: bytes-compare before writing (no mtime churn); atomic
 *   temp + rename; a missing template is reported, never thrown.
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { guardedWriteFileSync, guardedUnlinkSync } from "./fs-guard.js";

/** `<!-- iapeer-memory doctrine v<version> -->` — machine-checkable. */
export function versionMarker(version: string): string {
  return `<!-- iapeer-memory doctrine v${version} -->`;
}

/** Extract the rendered version from a doctrine file's marker, or null. */
export function renderedVersion(content: string): string | null {
  const m = /^<!-- iapeer-memory doctrine v(.+?) -->$/m.exec(content);
  return m ? m[1] : null;
}

/** Strip a leading `---\n…\n---\n` template frontmatter block, if any. */
export function stripTemplateFrontmatter(text: string): string {
  const m = /^---[^\S\n]*\n[\s\S]*?\n---[^\S\n]*(?:\n|$)/.exec(text);
  return m ? text.slice(m[0].length).replace(/^\n+/, "") : text;
}

export type RenderOutcome = {
  action: "written" | "identical" | "missing-template";
  target: string;
};

/**
 * Render one role template into a peer's doctrine. Returns the outcome —
 * the caller (package CLI / verify) aggregates and reports.
 */
export function renderDoctrine(opts: {
  templatePath: string;
  peerCwd: string;
  version: string;
  /** Host vault root — substituted for `{{VAULT_PATH}}` in the template.
   *  a role peer that didn't KNOW the vault root
   *  guessed it with `find` and read a STALE git copy of the vault —
   *  wrong-world metadata broke the echo-breaker downstream. The doctrine
   *  must carry the host fact. */
  vaultPath?: string;
}): RenderOutcome {
  const target = path.join(opts.peerCwd, ".iapeer", "IAPEER.md");

  let template: string;
  try {
    template = fs.readFileSync(opts.templatePath, "utf-8");
  } catch {
    return { action: "missing-template", target };
  }

  const body = stripTemplateFrontmatter(template).replaceAll(
    "{{VAULT_PATH}}",
    opts.vaultPath ?? "<unknown — see IAPEER_MEMORY_VAULT_PATH in the package config.env>",
  );
  const rendered = `${versionMarker(opts.version)}\n${body.startsWith("\n") ? body.slice(1) : body}`;

  let existing: string | null = null;
  try {
    existing = fs.readFileSync(target, "utf-8");
  } catch {
    existing = null;
  }
  if (existing === rendered) {
    return { action: "identical", target };
  }

  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = path.join(
    path.dirname(target),
    `.IAPEER.md.${crypto.randomBytes(6).toString("hex")}.tmp`,
  );
  try {
    guardedWriteFileSync(tmp, rendered, "utf-8");
    fs.renameSync(tmp, target);
  } catch (err) {
    try {
      if (fs.existsSync(tmp)) guardedUnlinkSync(tmp);
    } catch {
      // best effort
    }
    throw err;
  }
  return { action: "written", target };
}

/**
 * Render a set of role doctrines (role → template path / peer cwd).
 * Missing templates are reported per-role; other roles still render
 * (parity with the reference's per-entry resilience).
 */
export function renderRoleDoctrines(opts: {
  roles: Array<{ role: string; templatePath: string; peerCwd: string }>;
  version: string;
}): Array<{ role: string } & RenderOutcome> {
  return opts.roles.map(({ role, templatePath, peerCwd }) => ({
    role,
    ...renderDoctrine({ templatePath, peerCwd, version: opts.version }),
  }));
}
