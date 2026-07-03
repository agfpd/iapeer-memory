/**
 * Author vault-index renderer.
 *
 * TS port of the reference `scripts/mergemind-regenerate-vault-index.py`
 * (behavioural parity against `tests/python/test_regenerate_vault_index.py`,
 * 84 fixtures) with the deliberate ADR deviations:
 *
 * - **taxonomy/ranking config instead of constants** (ADR-002/011): folder
 *   names, type/subtype tokens, status boost GROUPS and coefficients come
 *   from the same config the search pipeline uses — bucket synchronisation
 *   with `memory_search` holds BY CONSTRUCTION (one source), where the
 *   reference kept two hand-synchronised constant sets.
 * - **personality is a parameter**: identity resolution (PEER_PERSONALITY
 *   first) happens at the call level, never inside the renderer.
 * - **projectsRoot is a parameter**: the reference read
 *   PM_AGENT_PROJECTS_ROOT from env inside build_output; here the caller
 *   resolves it (env IAPEER_MEMORY_PROJECTS_ROOT at the CLI level).
 * - **render strings are locale data** (taxonomy.indexStrings): the RU
 *   preset reproduces the reference strings verbatim; EN is the base.
 *
 * The output format, sorting policy and caps follow the «Индекс заметок
 * автора» contract.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import type { RankingConfig, TaxonomyPreset } from "./taxonomy.js";
import { statusGroup as taxonomyStatusGroup } from "./taxonomy.js";
import { guardedWriteFileSync, guardedUnlinkSync, guardedRenameSync } from "./fs-guard.js";

const WIKILINK_RE = /\[\[([^\]|#]+)/g;
const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---\n/;

export type IndexNote = {
  path: string;
  title: string;
  author: string;
  coauthors: string[];
  type: string;
  status: string;
  tags: string[];
  subtype: string;
  description: string;
  created: string;
  updated: string;
  nOutgoing: number;
};

export type FilteredNote = IndexNote & { nLinks: number; score: number };

export type RenderContext = {
  taxonomy: TaxonomyPreset;
  ranking: RankingConfig;
};

// ── frontmatter field parsing (line-based, mirrors the reference) ───────────

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** `key: value` (single line); strips paired quotes and «guillemets». */
export function scalarField(fm: string, key: string): string | null {
  const m = new RegExp(`^${escapeRe(key)}\\s*:\\s*(.+?)\\s*$`, "m").exec(fm);
  if (!m) return null;
  let v = m[1].trim();
  if (
    (v.startsWith('"') && v.endsWith('"')) ||
    (v.startsWith("'") && v.endsWith("'"))
  ) {
    v = v.slice(1, -1);
  } else if (v.startsWith("«") && v.endsWith("»")) {
    v = v.slice(1, -1);
  }
  return v;
}

function parseYamlList(fm: string, key: string): string[] {
  const inline = new RegExp(`^${escapeRe(key)}\\s*:\\s*\\[(.*?)\\]\\s*$`, "m").exec(fm);
  if (inline) {
    return inline[1]
      .split(",")
      .map((t) => t.trim().replace(/^["']|["']$/g, ""))
      .filter(Boolean);
  }
  const block = new RegExp(
    `^${escapeRe(key)}\\s*:\\s*\\n((?:[ \\t]+-\\s*.+\\n?)+)`,
    "m",
  ).exec(fm);
  if (block) {
    const items = [...block[1].matchAll(/^[ \t]+-\s*(.+?)\s*$/gm)].map((m) => m[1]);
    return items.map((i) => i.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
  }
  return [];
}

/** `tags:` — inline `[a, b]` or block list. */
export function parseTags(fm: string): string[] {
  return parseYamlList(fm, "tags");
}

/** `coauthors:` — same syntax as tags. */
export function parseCoauthors(fm: string): string[] {
  return parseYamlList(fm, "coauthors");
}

// ── project working-dir resolution ──────────────────────────────────────────

/**
 * For a project note at `<vault>/<projectsFolder>/<name>/.../file.md`,
 * return [absDir, name] — the project's working directory (ADR-014):
 *
 * 1. the `dir:` field in the project's Overview frontmatter is the SOURCE
 *    OF TRUTH (absolute or `~`-relative; set by the author/Index) —
 *    arbitrary layouts and project moves survive;
 * 2. no field (or its path is gone) → the `<projectsRoot>/<name>`
 *    convention (backward compatible — existing projects need no
 *    migration);
 * 3. neither exists on disk → graceful no-op (null), as before.
 */
export function resolveProjectDir(
  notePath: string,
  projectsRoot: string,
  taxonomy: TaxonomyPreset,
): [string, string] | null {
  if (!notePath) return null;
  const parts = notePath.split(path.sep);
  const i = parts.indexOf(taxonomy.folders.projects);
  if (i === -1) return null;
  // parts[i+1] must be a project subfolder with the note file after it —
  // guard against a note placed directly in the projects folder.
  if (i + 2 >= parts.length) return null;
  const name = parts[i + 1];
  if (!name) return null;

  // 1. dir: from the Overview frontmatter (ADR-014).
  const overviewPath = path.join(
    parts.slice(0, i + 2).join(path.sep),
    `${taxonomy.projectFiles.overviewPrefix}${name}.md`,
  );
  let declared: string | null = null;
  try {
    const text = fs.readFileSync(overviewPath, "utf-8");
    const m = FRONTMATTER_RE.exec(text);
    declared = m ? scalarField(m[1], "dir") : null;
  } catch {
    declared = null;
  }
  if (declared) {
    const expanded = declared.startsWith("~")
      ? path.join(process.env.HOME ?? os.homedir(), declared.slice(1))
      : declared;
    try {
      if (fs.statSync(expanded).isDirectory()) return [expanded, name];
    } catch {
      // declared path gone (project moved without updating dir:) — fall
      // through to the convention rather than silently losing the line.
    }
  }

  // 2. convention fallback.
  const pdir = path.join(projectsRoot, name);
  try {
    if (!fs.statSync(pdir).isDirectory()) return null;
  } catch {
    return null;
  }
  return [pdir, name];
}

// ── status groups & boosts — from the SHARED config (ADR-002) ───────────────

export function statusBoost(status: string | null, ctx: RenderContext): number {
  if (status === null || status === undefined) return 1.0;
  const group = taxonomyStatusGroup(ctx.taxonomy, status.toLowerCase());
  if (group === "active") return ctx.ranking.activeBoost;
  if (group === "pending") return ctx.ranking.pendingPenalty;
  if (group === "stale") return ctx.ranking.stalePenalty;
  return 1.0;
}

/** active=0, pending=1, stale=2, unknown=3 — ascending sort rank. */
export function statusGroupRank(status: string | null, ctx: RenderContext): number {
  const group = taxonomyStatusGroup(ctx.taxonomy, (status ?? "").toLowerCase());
  if (group === "active") return 0;
  if (group === "pending") return 1;
  if (group === "stale") return 2;
  return 3;
}

export function isStale(status: string | null, ctx: RenderContext): boolean {
  return taxonomyStatusGroup(ctx.taxonomy, (status ?? "").toLowerCase()) === "stale";
}

/** Subtype render rank within the agent-memory section. Unknown → 99. */
export function subtypeRank(subtype: string | null | undefined, ctx: RenderContext): number {
  if (!subtype) return 99;
  const i = ctx.taxonomy.subtypeOrder.indexOf(subtype.trim().toLowerCase());
  return i === -1 ? 99 : i;
}

/** Parse `YYYY-MM-DD HH:MM` or `YYYY-MM-DD` → 5-tuple; malformed → zeros. */
export function datetimeKey(s: string | null | undefined): number[] {
  if (!s) return [0, 0, 0, 0, 0];
  const parts = s.trim().split(/\s+/);
  const dateParts = parts[0].split("-");
  const y = Number(dateParts[0]);
  const mo = Number(dateParts[1]);
  const d = Number(dateParts[2]);
  if (
    dateParts.length < 3 ||
    !Number.isInteger(y) || !Number.isInteger(mo) || !Number.isInteger(d)
  ) {
    return [0, 0, 0, 0, 0];
  }
  let h = 0;
  let mi = 0;
  if (parts.length > 1) {
    const t = parts[1].split(":");
    const th = Number(t[0]);
    const tm = Number(t[1]);
    if (Number.isInteger(th) && Number.isInteger(tm)) {
      h = th;
      mi = tm;
    }
  }
  return [y, mo, d, h, mi];
}

// ── sort keys (python tuples → arrays + lexicographic compare) ──────────────

export type SortKey = Array<number | string>;

export function compareKeys(a: SortKey, b: SortKey): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a[i];
    const y = b[i];
    if (x < y) return -1;
    if (x > y) return 1;
  }
  return a.length - b.length;
}

/**
 * Global sort key: status_group asc → (subtype rank for memory / -score for
 * canon) → updated desc → title asc.
 */
export function sortKeyGlobal(
  item: { type: string; status: string; subtype?: string; score?: number; updated?: string; created?: string; title: string },
  ctx: RenderContext,
): SortKey {
  const dtStr = item.updated || item.created || "";
  const isMemory = item.type === ctx.taxonomy.types.agentMemory;
  return [
    statusGroupRank(item.status, ctx),
    isMemory ? subtypeRank(item.subtype, ctx) : -(item.score ?? 0),
    ...datetimeKey(dtStr).map((v) => -v),
    item.title,
  ];
}

function memoryIntraKey(
  item: { status: string; updated?: string; created?: string; title: string },
  ctx: RenderContext,
): SortKey {
  const dt = item.updated || item.created || "";
  return [statusGroupRank(item.status, ctx), ...datetimeKey(dt).map((v) => -v), item.title];
}

function canonIntraKey(
  item: { status: string; score?: number; updated?: string; created?: string; title: string },
  ctx: RenderContext,
): SortKey {
  const dt = item.updated || item.created || "";
  return [
    statusGroupRank(item.status, ctx),
    -(item.score ?? 0),
    ...datetimeKey(dt).map((v) => -v),
    item.title,
  ];
}

/**
 * Order within a project group: Overview → Plan → Phases (by the
 * locale's phase status order). Tie-breaker — n_links desc, title asc.
 */
export function projectIntraSortKey(
  item: { title: string; status: string; nLinks: number },
  ctx: RenderContext,
): SortKey {
  const t = ctx.taxonomy.projectFiles;
  let order: number;
  if (item.title.startsWith(t.overviewPrefix.trimEnd())) {
    order = 0.0;
  } else if (item.title.startsWith(t.planPrefix.trimEnd())) {
    order = 1.0;
  } else if (item.title.startsWith(t.phasePrefix.trimEnd())) {
    const rank = ctx.taxonomy.phaseStatusOrder.indexOf((item.status || "").toLowerCase());
    order = 2.0 + (rank === -1 ? 9 : rank) * 0.1;
  } else {
    order = 9.0;
  }
  return [order, -item.nLinks, item.title];
}

// ── collection & filtering ───────────────────────────────────────────────────

export type CollectResult = {
  notes: Map<string, IndexNote>;
  incomingCount: Map<string, number>;
  skipped: Array<[string, string]>;
};

function* walkMdFiles(dir: string): Generator<string> {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      yield* walkMdFiles(full);
    } else if (e.isFile() && e.name.endsWith(".md")) {
      yield full;
    }
  }
}

/**
 * Walk the permanent folders, parse frontmatter + wikilinks.
 * `incomingCount[title]` = number of UNIQUE source notes linking to the
 * title (3 mentions in one note = +1 source, not +3). Each note carries
 * `nOutgoing` — unique outgoing targets, self-references excluded.
 */
export function collectNotes(vault: string, ctx: RenderContext): CollectResult {
  const f = ctx.taxonomy.folders;
  const permanentDirs = [
    f.knowledge, f.decisions, f.projects, f.ideas, f.lists, f.agentMemory,
  ];
  const notes = new Map<string, IndexNote>();
  const incomingSources = new Map<string, Set<string>>();
  const skipped: Array<[string, string]> = [];
  const decoder = new TextDecoder("utf-8", { fatal: true });

  for (const d of permanentDirs) {
    const full = path.join(vault, d);
    for (const filePath of walkMdFiles(full)) {
      let text: string;
      try {
        text = decoder.decode(fs.readFileSync(filePath));
      } catch (err) {
        const name =
          err instanceof TypeError ? "UnicodeDecodeError" : ((err as Error).name || "OSError");
        skipped.push([filePath, name]);
        continue;
      }

      const m = FRONTMATTER_RE.exec(text);
      if (!m) continue;
      const fm = m[1];

      const author = scalarField(fm, "author");
      if (!author) continue;

      const title = scalarField(fm, "title") || path.basename(filePath, ".md");

      const outgoing = new Set(
        [...text.matchAll(WIKILINK_RE)].map((w) => w[1].trim()),
      );
      outgoing.delete(title);

      notes.set(filePath, {
        path: filePath,
        title,
        author,
        coauthors: parseCoauthors(fm),
        type: scalarField(fm, "type") ?? "",
        status: scalarField(fm, "status") ?? "",
        tags: parseTags(fm),
        subtype: scalarField(fm, "subtype") ?? "",
        description: scalarField(fm, "description") ?? "",
        created: scalarField(fm, "created") ?? "",
        updated: scalarField(fm, "updated") ?? "",
        nOutgoing: outgoing.size,
      });

      for (const target of outgoing) {
        if (!incomingSources.has(target)) incomingSources.set(target, new Set());
        incomingSources.get(target)!.add(filePath);
      }
    }
  }

  const incomingCount = new Map<string, number>();
  for (const [title, sources] of incomingSources) incomingCount.set(title, sources.size);
  return { notes, incomingCount, skipped };
}

/**
 * Keep notes where the agent is author or coauthor; drop STALE; compute
 * `nLinks = incoming(unique sources) + outgoing(unique targets)` and
 * `score = nLinks × statusBoost`.
 */
export function filterAgentNotes(
  notes: Map<string, IndexNote>,
  incomingCount: Map<string, number>,
  agent: string,
  ctx: RenderContext,
): FilteredNote[] {
  const mine: FilteredNote[] = [];
  for (const data of notes.values()) {
    if (data.author !== agent && !data.coauthors.includes(agent)) continue;
    if (isStale(data.status, ctx)) continue;
    const nIn = incomingCount.get(data.title) ?? 0;
    const nLinks = nIn + data.nOutgoing;
    mine.push({ ...data, nLinks, score: nLinks * statusBoost(data.status, ctx) });
  }
  return mine;
}

// ── line formatting ──────────────────────────────────────────────────────────

export const DESCRIPTION_MAX_LEN = 120;

/**
 * Compress a description for the index: first sentence, falling back to a
 * word-boundary cut at maxLen. The `…` marker appears ONLY when content was
 * actually cut — no marker means the description is shown in full.
 */
export function truncateDescription(
  desc: string,
  maxLen: number = DESCRIPTION_MAX_LEN,
): string {
  if (!desc) return desc;
  desc = desc.trim();
  const sentMatch = /[.!?]\s/.exec(desc);
  if (sentMatch) {
    const sentenceEnd = sentMatch.index + 1; // including the punctuation
    if (sentenceEnd <= maxLen) {
      if (sentenceEnd < desc.replace(/[.!? ]+$/, "").length) {
        return desc.slice(0, sentenceEnd) + "…";
      }
      return desc;
    }
  }
  if (desc.length <= maxLen) return desc;
  let truncated = desc.slice(0, maxLen);
  const lastSpace = truncated.lastIndexOf(" ");
  if (lastSpace > Math.floor(maxLen / 2)) {
    truncated = truncated.slice(0, lastSpace);
  }
  return truncated.replace(/[,;:\-— ]+$/, "") + "…";
}

/** `- [[Title]] · status · tag(s) · N св. · YYYY-MM-DD` */
export function fmtCanonical(
  item: { title: string; status: string; tags: string[]; nLinks: number; created?: string; updated?: string },
  ctx: RenderContext,
): string {
  const parts = [`[[${item.title}]]`];
  if (item.status) parts.push(item.status);
  if (item.tags.length) parts.push(item.tags.join(", "));
  if (item.nLinks > 0) parts.push(`${item.nLinks} ${ctx.taxonomy.indexStrings.linksSuffix}`);
  const upd = item.updated || item.created || "";
  if (upd) parts.push(upd.split(/\s+/)[0]);
  return "- " + parts.join(" · ");
}

/** `- [[Title]] · subtype · status · «description» · N св. · YYYY-MM-DD` */
export function fmtMemory(
  item: { title: string; subtype: string; status: string; description: string; nLinks: number; created?: string; updated?: string },
  ctx: RenderContext,
): string {
  const parts = [`[[${item.title}]]`];
  if (item.subtype) parts.push(item.subtype);
  if (item.status) parts.push(item.status);
  if (item.description) parts.push(`«${truncateDescription(item.description)}»`);
  if (item.nLinks > 0) parts.push(`${item.nLinks} ${ctx.taxonomy.indexStrings.linksSuffix}`);
  const upd = item.updated || item.created || "";
  if (upd) parts.push(upd.split(/\s+/)[0]);
  return "- " + parts.join(" · ");
}

// ── caps & selection ─────────────────────────────────────────────────────────

export const MEMORY_CAP = 50;
export const CANON_CAP = 50;
export const PROJECT_SECTION_CAP = 15;
export const PROJECT_HARD_CAP = 50;
export const MEMORY_DEFAULT_QUOTA = 10;
export const CANON_DEFAULT_QUOTA = 10;

function memorySubtypeQuotas(ctx: RenderContext): Map<string, number> {
  const s = ctx.taxonomy.subtypes;
  return new Map([
    [s.feedback, 10],
    [s.context, 10],
    [s.reference, 10],
    [s.pitfall, 10],
    [s.personProfile, 1],
  ]);
}

function memorySubtypeCeilings(ctx: RenderContext): Map<string, number> {
  // person_profile: max 3 in the index — facts about the owner are compact,
  // further notes of this genre are likely duplicates or minor context.
  return new Map([[ctx.taxonomy.subtypes.personProfile, 3]]);
}

function canonQuotas(ctx: RenderContext): Map<string, number> {
  const t = ctx.taxonomy.types;
  return new Map([
    [t.knowledge, 10],
    [t.decision, 10],
    [t.idea, 10],
    [t.list, 10],
  ]);
}

/**
 * Soft-trim PENDING notes of the whole projects section when over cap —
 * across all projects, oldest `updated` first. ACTIVE notes are
 * untouchable. Returns [kept (input order preserved), removedCount].
 */
export function trimProjectSectionPending(
  notes: FilteredNote[],
  ctx: RenderContext,
  cap: number = PROJECT_SECTION_CAP,
): [FilteredNote[], number] {
  if (notes.length <= cap) return [[...notes], 0];
  const excess = notes.length - cap;
  const pendingIndices = notes
    .map((n, i) => ({ n, i }))
    .filter(({ n }) => statusGroupRank(n.status, ctx) === 1)
    .sort((a, b) =>
      compareKeys(
        datetimeKey(a.n.updated || a.n.created || ""),
        datetimeKey(b.n.updated || b.n.created || ""),
      ),
    )
    .map(({ i }) => i);
  const toDrop = new Set(pendingIndices.slice(0, excess));
  const kept = notes.filter((_, i) => !toDrop.has(i));
  return [kept, toDrop.size];
}

/**
 * Per-type canon quotas with overflow up to the shared cap.
 * cap=null disables quotas (full index).
 */
export function selectCanon(
  canonPool: FilteredNote[],
  ctx: RenderContext,
  cap: number | null = CANON_CAP,
): FilteredNote[] {
  if (cap === null) return [...canonPool];

  const quotas = canonQuotas(ctx);
  const byType = new Map<string, FilteredNote[]>();
  for (const n of canonPool) {
    if (!byType.has(n.type)) byType.set(n.type, []);
    byType.get(n.type)!.push(n);
  }
  for (const list of byType.values()) {
    list.sort((a, b) => compareKeys(canonIntraKey(a, ctx), canonIntraKey(b, ctx)));
  }

  const selected: FilteredNote[] = [];
  const overflowPool: FilteredNote[] = [];
  for (const [t, list] of byType) {
    const quota = quotas.get(t) ?? CANON_DEFAULT_QUOTA;
    const take = Math.min(quota, list.length);
    selected.push(...list.slice(0, take));
    overflowPool.push(...list.slice(take));
  }

  const remaining = cap - selected.length;
  if (remaining > 0 && overflowPool.length) {
    overflowPool.sort((a, b) => compareKeys(canonIntraKey(a, ctx), canonIntraKey(b, ctx)));
    selected.push(...overflowPool.slice(0, remaining));
  }
  return selected;
}

/**
 * Per-subtype memory quotas with overflow up to the shared cap; hard
 * ceilings respected (person_profile ≤ 3). cap=null returns everything.
 */
export function selectMemory(
  memoryPool: FilteredNote[],
  ctx: RenderContext,
  cap: number | null = MEMORY_CAP,
): FilteredNote[] {
  if (cap === null) return [...memoryPool];

  const quotas = memorySubtypeQuotas(ctx);
  const ceilings = memorySubtypeCeilings(ctx);
  const bySubtype = new Map<string, FilteredNote[]>();
  for (const n of memoryPool) {
    const st = (n.subtype || "").trim().toLowerCase() || "unknown";
    if (!bySubtype.has(st)) bySubtype.set(st, []);
    bySubtype.get(st)!.push(n);
  }
  for (const list of bySubtype.values()) {
    list.sort((a, b) => compareKeys(memoryIntraKey(a, ctx), memoryIntraKey(b, ctx)));
  }

  const selected: FilteredNote[] = [];
  const overflowPool: FilteredNote[] = [];
  for (const [st, list] of bySubtype) {
    const quota = quotas.get(st) ?? MEMORY_DEFAULT_QUOTA;
    const ceiling = ceilings.get(st);
    const take = Math.min(quota, list.length);
    selected.push(...list.slice(0, take));
    let leftover = list.slice(take);
    if (ceiling !== undefined) {
      const extraAllowed = Math.max(0, ceiling - take);
      leftover = leftover.slice(0, extraAllowed);
    }
    overflowPool.push(...leftover);
  }

  const remaining = cap - selected.length;
  if (remaining > 0 && overflowPool.length) {
    overflowPool.sort((a, b) => compareKeys(memoryIntraKey(a, ctx), memoryIntraKey(b, ctx)));
    selected.push(...overflowPool.slice(0, remaining));
  }
  return selected;
}

// ── output assembly ──────────────────────────────────────────────────────────

function fmtTemplate(tpl: string, vars: Record<string, string | number>): string {
  return tpl.replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? ""));
}

export type BuildOutputOptions = {
  ctx: RenderContext;
  projectsRoot?: string;
  memoryCap?: number | null;
  canonCap?: number | null;
  projectHardCap?: number | null;
  fullIndexPath?: string | null;
};

/**
 * Build the final markdown body from filtered notes.
 * Returns [text, total, truncated].
 */
export function buildOutput(
  mine: FilteredNote[],
  agent: string,
  opts: BuildOutputOptions,
): [string, number, boolean] {
  const { ctx } = opts;
  const T = ctx.taxonomy;
  const S = T.indexStrings;
  const projectsRoot = opts.projectsRoot ?? path.join(os.homedir(), "Projects");
  const memoryCap = opts.memoryCap === undefined ? MEMORY_CAP : opts.memoryCap;
  const canonCap = opts.canonCap === undefined ? CANON_CAP : opts.canonCap;
  const projectHardCap =
    opts.projectHardCap === undefined ? PROJECT_HARD_CAP : opts.projectHardCap;
  const fullIndexPath = opts.fullIndexPath ?? null;

  const memoryPool = mine.filter((n) => n.type === T.types.agentMemory);
  // Projects are immune — no cap, only the STALE filter (already applied
  // in filterAgentNotes). Overview + Plan + Phases land as one group.
  const projectPool = mine.filter((n) => n.type === T.types.project);
  const canonPool = mine.filter(
    (n) => n.type !== T.types.agentMemory && n.type !== T.types.project,
  );
  const memoryTotal = memoryPool.length;
  const canonTotal = canonPool.length;
  const projectTotal = projectPool.length;

  const memoryKept = selectMemory(memoryPool, ctx, memoryCap);
  // Final render order: subtype grouping for readability, freshness inside.
  memoryKept.sort((a, b) => compareKeys(sortKeyGlobal(a, ctx), sortKeyGlobal(b, ctx)));
  const canonKept = selectCanon(canonPool, ctx, canonCap);
  canonKept.sort((a, b) => compareKeys(sortKeyGlobal(a, ctx), sortKeyGlobal(b, ctx)));

  const projectSorted = [...projectPool].sort((a, b) =>
    compareKeys(sortKeyGlobal(a, ctx), sortKeyGlobal(b, ctx)),
  );
  let [projectKept, projectsTrimmedCount] = trimProjectSectionPending(projectSorted, ctx);
  // Hard ceiling AFTER the soft-trim: deterministic index ceiling.
  let projectsHardTrimmedCount = 0;
  if (projectHardCap !== null && projectKept.length > projectHardCap) {
    projectsHardTrimmedCount = projectKept.length - projectHardCap;
    projectKept = projectKept.slice(0, projectHardCap);
  }

  const memoryTruncated = memoryCap !== null && memoryTotal > memoryKept.length;
  const canonTruncated = canonCap !== null && canonTotal > canonKept.length;
  const projectsTrimmed = projectsTrimmedCount > 0 || projectsHardTrimmedCount > 0;

  const f = T.folders;
  const sectionOrder: Array<[string, string, string]> = [
    [S.sections.agentMemory, T.types.agentMemory, `${f.agentMemory}/${agent}/`],
    [S.sections.knowledge, T.types.knowledge, `${f.knowledge}/`],
    [S.sections.decisions, T.types.decision, `${f.decisions}/`],
    [S.sections.projects, T.types.project, `${f.projects}/${S.namePlaceholder}/`],
    [S.sections.ideas, T.types.idea, `${f.ideas}/`],
    [S.sections.lists, T.types.list, `${f.lists}/`],
  ];

  const sections = new Map<string, FilteredNote[]>(
    sectionOrder.map(([, key]) => [key, []]),
  );
  for (const item of memoryKept) sections.get(T.types.agentMemory)!.push(item);
  for (const item of canonKept) {
    if (sections.has(item.type)) sections.get(item.type)!.push(item);
  }
  sections.get(T.types.project)!.push(...projectKept);

  const lines: string[] = [
    `# ${S.header} \`${agent}\``,
    "",
    S.generatedComment,
    "",
  ];
  for (const [sectionTitle, typeKey, folder] of sectionOrder) {
    const items = sections.get(typeKey) ?? [];
    lines.push(`## ${sectionTitle} — \`${folder}\``);
    lines.push("");
    if (!items.length) {
      lines.push(S.emptySection);
      lines.push("");
      continue;
    }
    const fmt =
      typeKey === T.types.agentMemory
        ? (it: FilteredNote) => fmtMemory(it, ctx)
        : (it: FilteredNote) => fmtCanonical(it, ctx);
    if (typeKey === T.types.project) {
      // Group by project: one path in the H3 group header, Overview → Plan
      // → Phases inside.
      const byProject = new Map<string, { pdir: string; items: FilteredNote[] }>();
      const noProject: FilteredNote[] = [];
      for (const item of items) {
        const resolved = resolveProjectDir(item.path ?? "", projectsRoot, T);
        if (resolved) {
          const [pdir, pname] = resolved;
          if (!byProject.has(pname)) byProject.set(pname, { pdir, items: [] });
          byProject.get(pname)!.items.push(item);
        } else {
          noProject.push(item);
        }
      }
      const sortedProjects = [...byProject.entries()].sort(
        (a, b) =>
          Math.max(...b[1].items.map((it) => it.score)) -
          Math.max(...a[1].items.map((it) => it.score)),
      );
      for (const [pname, group] of sortedProjects) {
        lines.push(`### ${pname} — ${group.pdir}/`);
        const ordered = [...group.items].sort((a, b) =>
          compareKeys(projectIntraSortKey(a, ctx), projectIntraSortKey(b, ctx)),
        );
        for (const it of ordered) lines.push(fmt(it));
        lines.push("");
      }
      if (noProject.length) {
        for (const it of noProject) lines.push(fmt(it));
        lines.push("");
      }
    } else {
      for (const item of items) lines.push(fmt(item));
      lines.push("");
    }
  }

  const truncated = memoryTruncated || canonTruncated || projectsTrimmed;
  const total = memoryTotal + canonTotal + projectTotal;

  if (truncated) {
    const home = os.homedir();
    let pathDisplay: string;
    if (fullIndexPath && fullIndexPath.startsWith(home + "/")) {
      pathDisplay = "~" + fullIndexPath.slice(home.length);
    } else {
      pathDisplay = fullIndexPath || "<full index not generated>";
    }
    const bits: string[] = [];
    if (memoryTruncated) bits.push(`${S.memoryLabel} ${memoryKept.length}/${memoryTotal}`);
    if (canonTruncated) bits.push(`${S.canonLabel} ${canonKept.length}/${canonTotal}`);
    if (projectsTrimmed) {
      const partsProj: string[] = [];
      if (projectsTrimmedCount) {
        partsProj.push(
          fmtTemplate(S.pendingPhases, { n: projectsTrimmedCount, cap: PROJECT_SECTION_CAP }),
        );
      }
      if (projectsHardTrimmedCount) {
        partsProj.push(
          fmtTemplate(S.overHardCap, { n: projectsHardTrimmedCount, cap: projectHardCap ?? 0 }),
        );
      }
      bits.push(fmtTemplate(S.projectsTrimmed, { parts: partsProj.join(", ") }));
    }
    lines.push("---");
    lines.push("");
    lines.push(fmtTemplate(S.truncatedMarker, { bits: bits.join(", "), path: pathDisplay }));
  }

  return [lines.join("\n") + "\n", total, truncated];
}

// ── files ────────────────────────────────────────────────────────────────────

/**
 * temp file + rename — atomic write. Load-bearing: the out file is written
 * by memoryd while peers' system-prompt assembly reads it concurrently;
 * rename means a reader only ever sees old-complete or new-complete.
 */
export function atomicWrite(filePath: string, content: string): void {
  const dir = path.dirname(filePath) || ".";
  const tmp = path.join(dir, `.vault-index-${crypto.randomBytes(6).toString("hex")}.tmp`);
  try {
    guardedWriteFileSync(tmp, content, "utf-8");
    guardedRenameSync(tmp, filePath);
  } catch (err) {
    try {
      if (fs.existsSync(tmp)) guardedUnlinkSync(tmp);
    } catch {
      // best effort
    }
    throw err;
  }
}

/** `<peer>-vault-index.md` → `<peer>-vault-index-full.md` (same directory). */
export function fullIndexPathFor(outFile: string): string {
  const ext = path.extname(outFile);
  const base = outFile.slice(0, outFile.length - ext.length);
  return `${base}-full${ext}`;
}

/**
 * Render both index files (capped + full) for an agent. The personality is
 * a PARAMETER — identity resolution (PEER_PERSONALITY first) is the
 * caller's job (нюанс 10), never guessed here.
 */
export function regenerateVaultIndex(opts: {
  vault: string;
  agent: string;
  outFile: string;
  ctx: RenderContext;
  projectsRoot?: string;
}): { total: number; truncated: boolean; skipped: Array<[string, string]> } {
  const { notes, incomingCount, skipped } = collectNotes(opts.vault, opts.ctx);
  const mine = filterAgentNotes(notes, incomingCount, opts.agent, opts.ctx);
  const fullOut = fullIndexPathFor(opts.outFile);

  const [text, total, truncated] = buildOutput(mine, opts.agent, {
    ctx: opts.ctx,
    projectsRoot: opts.projectsRoot,
    fullIndexPath: fullOut,
  });
  atomicWrite(opts.outFile, text);

  const [fullText] = buildOutput(mine, opts.agent, {
    ctx: opts.ctx,
    projectsRoot: opts.projectsRoot,
    memoryCap: null,
    canonCap: null,
    projectHardCap: null,
  });
  atomicWrite(fullOut, fullText);

  return { total, truncated, skipped };
}
