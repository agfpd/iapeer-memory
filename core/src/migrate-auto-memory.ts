/**
 * Migration of a harness's built-in per-peer auto-memory into the vault's
 * agent-memory zone (`06_Agent_Memory/<agent>/`).
 *
 * TS port of the reference `scripts/migrate-auto-memory.py` (behavioural
 * parity against `tests/python/test_migrate_auto_memory.py`, 16 fixtures).
 * Deterministic, no LLM:
 *
 * 1. parse each source `.md` frontmatter (flat parser — auto-memory is
 *    simple);
 * 2. map the harness `type` → vault `subtype` (taxonomy tokens):
 *    user → person_profile, feedback → feedback, project → context,
 *    reference → reference, anything else → context. A `feedback` note
 *    that is semantically a pitfall cannot be told apart
 *    deterministically — re-filing to `pitfall` is the agent's manual step
 *    after migration (distill phase 5);
 * 3. build the agent-memory frontmatter (title from filename, type/status
 *    tokens from the taxonomy, description through the SHARED YAML-safe
 *    serialiser, created from birthtime/mtime, author = agent);
 * 4. per-file: backup → write target (atomic) → unlink source. Idempotent:
 *    an existing target file is skipped, never overwritten.
 *
 * ADAPTER SCOPE: the ENGINE is source-agnostic — the adapter supplies the
 * source directory (claude: `~/.claude/agent-memory/<agent>/` for launchd
 * peers, `~/.claude/projects/<slug>/memory/` for project sessions). The
 * codex memories source location/format is NOT fact-checked yet — wiring
 * it up is the codex-adapter's job once verified against a live codex
 * (никогда не выдумываем формат из памяти модели).
 */

import fs from "node:fs";
import path from "node:path";
import type { TaxonomyPreset } from "./taxonomy.js";
import { yamlSafeScalar } from "./fm-update.js";
import { guardedWriteFileSync, guardedUnlinkSync } from "./fs-guard.js";

/** Source files that are backed up but never copied into the vault. */
export const SKIP_FILES: ReadonlySet<string> = new Set(["MEMORY.md"]);

/** Flat frontmatter parser — first line of each `key: value` only. */
export function parseFlatFrontmatter(text: string): [Record<string, string>, string] {
  const m = /^---[^\S\n]*\n([\s\S]*?\n)---[^\S\n]*(?:\n|$)/.exec(text);
  if (!m) return [{}, text];
  const fm: Record<string, string> = {};
  for (const line of m[1].split("\n")) {
    if (!line.trim() || line.startsWith("#")) continue;
    const i = line.indexOf(":");
    if (i === -1) continue;
    fm[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return [fm, text.slice(m[0].length)];
}

/** Harness auto-memory `type` → vault subtype token (taxonomy-driven). */
export function mapTypeToSubtype(oldType: string, taxonomy: TaxonomyPreset): string {
  const s = taxonomy.subtypes;
  switch (oldType.trim().toLowerCase()) {
    case "user":
      return s.personProfile;
    case "feedback":
      return s.feedback;
    case "project":
      return s.context;
    case "reference":
      return s.reference;
    default:
      return s.context;
  }
}

function fileCreatedDate(p: string): string {
  const st = fs.statSync(p);
  const birth = st.birthtimeMs > 0 ? st.birthtimeMs : st.mtimeMs;
  return new Date(birth).toISOString().slice(0, 10);
}

/** Agent-memory frontmatter; description through the shared YAML-safe rules. */
export function buildNewFrontmatter(opts: {
  title: string;
  subtype: string;
  description: string;
  created: string;
  author: string;
  taxonomy: TaxonomyPreset;
}): string {
  const desc = opts.description ? yamlSafeScalar(opts.description) : "''";
  return [
    "---",
    `title: ${opts.title}`,
    `type: ${opts.taxonomy.types.agentMemory}`,
    `subtype: ${opts.subtype}`,
    `status: ${opts.taxonomy.statusTokens.current}`,
    `description: ${desc}`,
    `created: ${opts.created}`,
    `author: ${opts.author}`,
    "---",
  ].join("\n") + "\n";
}

export type MigrationPlan = {
  source: string;
  target: string;
  files: Array<{ name: string; oldType?: string; subtype?: string; error?: string }>;
  skippedSystem: string[];
  skippedAlreadyInTarget: string[];
  subtypeCounts: Record<string, number>;
  totalToMigrate: number;
};

/** Scan the source and build the plan WITHOUT writing anything (dry-run). */
export function planMigration(opts: {
  sourceDir: string;
  agent: string;
  vault: string;
  taxonomy: TaxonomyPreset;
}): MigrationPlan {
  const targetDir = path.join(opts.vault, opts.taxonomy.folders.agentMemory, opts.agent);
  const files: MigrationPlan["files"] = [];
  const skippedSystem: string[] = [];
  const skippedAlreadyInTarget: string[] = [];
  const subtypeCounts: Record<string, number> = {};

  const entries = fs
    .readdirSync(opts.sourceDir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(".md"))
    .map((e) => e.name)
    .sort();

  for (const name of entries) {
    if (SKIP_FILES.has(name)) {
      skippedSystem.push(name);
      continue;
    }
    if (fs.existsSync(path.join(targetDir, name))) {
      skippedAlreadyInTarget.push(name);
      continue;
    }
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(
        fs.readFileSync(path.join(opts.sourceDir, name)),
      );
    } catch {
      files.push({ name, error: "unreadable" });
      continue;
    }
    const [fm] = parseFlatFrontmatter(text);
    const oldType = (fm.type ?? "").trim().toLowerCase();
    const subtype = mapTypeToSubtype(oldType, opts.taxonomy);
    subtypeCounts[subtype] = (subtypeCounts[subtype] ?? 0) + 1;
    files.push({ name, oldType: oldType || "(none)", subtype });
  }

  return {
    source: opts.sourceDir,
    target: targetDir,
    files,
    skippedSystem,
    skippedAlreadyInTarget,
    subtypeCounts,
    totalToMigrate: files.length,
  };
}

export type MigrationResult = {
  migrated: string[];
  skipped: string[];
  errors: string[];
  backupDir: string;
  sourceRemoved: boolean;
};

/**
 * Apply the migration: per-file backup → convert+write target → unlink
 * source. A failed write leaves the source intact (the backup already
 * exists). The source dir is removed only when it ends up empty (`rmdir`,
 * never a recursive delete).
 */
export function applyMigration(opts: {
  sourceDir: string;
  agent: string;
  vault: string;
  backupRoot: string;
  taxonomy: TaxonomyPreset;
  /** Injectable for tests. */
  now?: Date;
}): MigrationResult {
  const targetDir = path.join(opts.vault, opts.taxonomy.folders.agentMemory, opts.agent);
  fs.mkdirSync(targetDir, { recursive: true });

  const now = opts.now ?? new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const backupDir = path.join(opts.backupRoot, `${opts.agent}-${stamp}`);
  fs.mkdirSync(backupDir, { recursive: true });

  const migrated: string[] = [];
  const skipped: string[] = [];
  const errors: string[] = [];

  const entries = fs
    .readdirSync(opts.sourceDir, { withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => e.name)
    .sort();

  for (const name of entries) {
    const srcPath = path.join(opts.sourceDir, name);

    // 1. Backup BEFORE any processing.
    try {
      fs.copyFileSync(srcPath, path.join(backupDir, name));
    } catch (err) {
      errors.push(`${name}: backup failed — ${String(err)}`);
      continue;
    }

    // 2a. Non-md and SKIP_FILES: backup-only, removed from the source.
    if (!name.endsWith(".md") || SKIP_FILES.has(name)) {
      try {
        guardedUnlinkSync(srcPath);
      } catch (err) {
        errors.push(`${name}: unlink after backup failed — ${String(err)}`);
      }
      continue;
    }

    // 2b. Markdown auto-memory: convert + atomic write + unlink source.
    const targetFile = path.join(targetDir, name);
    if (fs.existsSync(targetFile)) {
      skipped.push(name);
      try {
        guardedUnlinkSync(srcPath);
      } catch (err) {
        errors.push(`${name}: unlink (already migrated) failed — ${String(err)}`);
      }
      continue;
    }

    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(fs.readFileSync(srcPath));
    } catch (err) {
      errors.push(`${name}: read failed — ${String(err)}`);
      continue;
    }

    const [fm, body] = parseFlatFrontmatter(text);
    const newFm = buildNewFrontmatter({
      title: name.slice(0, -3),
      subtype: mapTypeToSubtype(fm.type ?? "", opts.taxonomy),
      description: (fm.description ?? "").trim(),
      created: fileCreatedDate(srcPath),
      author: opts.agent,
      taxonomy: opts.taxonomy,
    });
    const newText = body
      ? body.startsWith("\n")
        ? newFm + body
        : newFm + "\n" + body
      : newFm;

    try {
      const tmp = `${targetFile}.tmp`;
      guardedWriteFileSync(tmp, newText, "utf-8");
      fs.renameSync(tmp, targetFile);
    } catch (err) {
      errors.push(`${name}: write failed — ${String(err)}`);
      continue; // source untouched — write failed
    }

    try {
      guardedUnlinkSync(srcPath);
      migrated.push(name);
    } catch (err) {
      errors.push(`${name}: written to target but source unlink failed — ${String(err)}`);
      migrated.push(name);
    }
  }

  let sourceRemoved = false;
  try {
    fs.rmdirSync(opts.sourceDir);
    sourceRemoved = true;
  } catch {
    // not empty / no rights — left in place, surfaced via errors/remnants
  }

  return { migrated, skipped, errors, backupDir, sourceRemoved };
}
