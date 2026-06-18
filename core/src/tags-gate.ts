/**
 * Tag gate + injected dictionary projection — lean §3.
 *
 * In lean the author tags canon notes THEMSELVES from a controlled vocabulary
 * (`99_System/Tags.md`). Two deterministic jobs (0 LLM) live here:
 *
 *  1. GATE (`tagGateProblems`): the guard validates a canon note's tags
 *     against the dictionary — an unknown tag is NOT accepted; the author is
 *     told to register it in the dictionary first (a deliberate step that
 *     kills drift: `security` vs `Безопасность`). ≥1 tag is required on canon;
 *     operative notes carry none. PostToolUse fires AFTER the write, so the
 *     «rejection» is: keep `needs_review` + teach the author to fix it next
 *     step (§2.3 NB).
 *
 *  2. PROJECTION (`renderTagsProjection`): the dictionary is now injected to
 *     EVERY author (pre-lean: only the Index). The injected form is a COMPACT,
 *     budgeted projection — names always, the boundary ONLY where the
 *     dictionary author wrote one (overlapping domains needing disambiguation;
 *     `—` marks self-evident tags → name only). Token cost is ×the whole
 *     fleet, so the full curator table stays the SOURCE and only this slice is
 *     injected (§3, §11).
 *
 * The dictionary is a markdown table: `| Tag | Boundary (optional) |`. Parsing
 * is locale-independent (no header label hard-coded): a header row is the one
 * immediately followed by the `|---|` separator.
 */

export const DEFAULT_TAGS_BOUNDARY_MAXLEN = 160;

/** A `|---|`-style table separator cell. */
function isSeparatorCell(cell: string): boolean {
  return /^:?-{2,}:?$/.test(cell.trim());
}

/** Split a markdown table row into trimmed cells (outer pipes dropped). */
function tableCells(line: string): string[] | null {
  const t = line.trim();
  if (!t.startsWith("|")) return null;
  // Drop the leading and (if present) trailing pipe, then split.
  const inner = t.replace(/^\|/, "").replace(/\|\s*$/, "");
  return inner.split("|").map((c) => c.trim());
}

export type DictionaryEntry = { name: string; boundary: string };

/**
 * Parse the dictionary table into entries (name + boundary). Skips header rows
 * (a row whose NEXT line is a separator) and separator rows. Generic over any
 * number of tables/sections. A `—`/`-`/empty boundary means «self-evident».
 */
export function parseDictionaryEntries(dictContent: string): DictionaryEntry[] {
  const lines = dictContent.split("\n");
  const entries: DictionaryEntry[] = [];
  for (let i = 0; i < lines.length; i++) {
    const cells = tableCells(lines[i]);
    if (!cells || cells.length === 0) continue;
    const name = cells[0];
    if (!name || isSeparatorCell(name)) continue;
    // Header row: the next non-empty line is a separator.
    const nextCells = i + 1 < lines.length ? tableCells(lines[i + 1]) : null;
    if (nextCells && nextCells.length && isSeparatorCell(nextCells[0])) continue;
    const boundaryRaw = (cells[1] ?? "").trim();
    const boundary = boundaryRaw === "—" || boundaryRaw === "-" ? "" : boundaryRaw;
    entries.push({ name, boundary });
  }
  return entries;
}

/** Just the valid tag names (the gate's allow-set). */
export function parseDictionaryTags(dictContent: string): string[] {
  return parseDictionaryEntries(dictContent).map((e) => e.name);
}

/**
 * A note tag is valid when it (or its root before `/`) is in the dictionary —
 * subtags (`Бизнес/Грузоперевозки`) inherit their root's membership (§3, the
 * `Бизнес` boundary documents the subtag convention).
 */
export function isTagAllowed(tag: string, allow: ReadonlySet<string>): boolean {
  if (allow.has(tag)) return true;
  const root = tag.split("/")[0];
  return root !== tag && allow.has(root);
}

/** Extract tags from a frontmatter block — block-list and inline-array forms. */
export function parseNoteTags(fmBlock: string): string[] {
  const lines = fmBlock.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = /^tags\s*:\s*(.*)$/.exec(lines[i]);
    if (!m) continue;
    const inline = m[1].trim();
    if (inline) {
      // inline array `[A, B]` or a bare scalar.
      const arr = inline.replace(/^\[/, "").replace(/\]$/, "");
      return arr
        .split(",")
        .map((s) => s.trim().replace(/^["']|["']$/g, ""))
        .filter(Boolean);
    }
    // block-list form: following `  - item` lines.
    const out: string[] = [];
    for (let j = i + 1; j < lines.length; j++) {
      const item = /^\s+-\s+(.*)$/.exec(lines[j]);
      if (!item) break;
      const v = item[1].trim().replace(/^["']|["']$/g, "");
      if (v) out.push(v);
    }
    return out;
  }
  return [];
}

export type TagGateOptions = {
  /** Canon requires ≥1 tag; operative/other zones do not. */
  requireAtLeastOne: boolean;
  /** Vault-relative dictionary path, for the teaching message. */
  dictionaryRel: string;
};

/**
 * Validate a note's tags against the dictionary. Returns author-facing problem
 * lines (empty = clean). The guard stays SILENT when there is nothing to fix
 * (§2.3); each line names a concrete fix.
 */
export function tagGateProblems(
  noteTags: readonly string[],
  allow: ReadonlySet<string>,
  opts: TagGateOptions,
): string[] {
  const problems: string[] = [];
  if (opts.requireAtLeastOne && noteTags.length === 0) {
    problems.push(
      `canon note has no tags — add ≥1 from the dictionary (${opts.dictionaryRel}).`,
    );
  }
  for (const tag of noteTags) {
    if (!isTagAllowed(tag, allow)) {
      problems.push(
        `tag "${tag}" is not in the dictionary — register it in ${opts.dictionaryRel} first ` +
          `(reuse an existing tag if one fits, e.g. by domain), then tag the note.`,
      );
    }
  }
  return problems;
}

/** Truncate to `max` chars on a word boundary where possible, adding `…`. */
function clip(s: string, max: number): string {
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const lastSpace = cut.lastIndexOf(" ");
  return (lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd() + "…";
}

export type ProjectionOptions = {
  /** Per-tag boundary character budget (×whole fleet, §11). */
  boundaryMaxLen?: number;
};

/**
 * Render the COMPACT injected projection of the dictionary (§3/§11): one tag
 * per line, `Name` for self-evident tags, `Name — boundary` (clipped to the
 * budget) for overlapping domains. No table chrome, no frontmatter — the full
 * curator table stays the source. Returns "" for an empty/unparseable dict.
 */
export function renderTagsProjection(dictContent: string, opts: ProjectionOptions = {}): string {
  const max = opts.boundaryMaxLen ?? DEFAULT_TAGS_BOUNDARY_MAXLEN;
  const entries = parseDictionaryEntries(dictContent);
  if (entries.length === 0) return "";
  const lines = entries.map((e) =>
    e.boundary ? `${e.name} — ${clip(e.boundary, max)}` : e.name,
  );
  return lines.join("\n");
}
