/**
 * Fill a vault note's frontmatter according to its zone
 * (permanent / memory). The write hook is the SHARED fill logic — the same
 * functions run the agent hook path (processFile) and the human path
 * (decideUpdate, human-edit-detect.ts). Inbox zones were removed with the
 * direct-to-canon model: authors write straight into the typed canon folders.
 *
 * TS port of the reference `scripts/mergemind-frontmatter-fill.py`
 * (behavioural parity against `tests/python/test_frontmatter_fill.py`,
 * 73 fixtures) with the deliberate ADR deviations:
 *
 * - **curator-set instead of hard-coded `index`** (ADR-006): `needs_review`
 *   is NOT stamped when the writing agent belongs to the configured curator
 *   set (`index`, `scriber`, `dreamweaver` by default) — curators'
 *   edits are sanctioned curation, not author edits awaiting review.
 * - **taxonomy-driven zone routing** (ADR-002/011): folder names, the
 *   agent-memory type token and emitted status tokens come from the locale
 *   preset, not constants — the same logic runs the RU vault and the EN base.
 * - **identity = peer personality** (нюанс 10): `resolveAgentName` prefers
 *   `PEER_PERSONALITY`, falling back to `IAPEER_MEMORY_AGENT_NAME`.
 *
 * Zone behaviour:
 * - permanent: FULL canon fill (`fillPermanentFull`) — title ← filename,
 *              type/status ← the folder's genre (§2.1), created, author for
 *              non-curators + needs_review, and an UPSERT of the stamp pair
 *              (last_edited_by, updated). The author now hand-writes only
 *              body + tags + inline links + title; the rest is deterministic.
 * - memory:    service-field semantics + idempotent fill of the constants.
 *              `author` is parsed from the subfolder name, NOT from the caller
 *              identity — load-bearing for DreamWeaver writing into a foreign
 *              subfolder on an Index task.
 *
 * The YAML-safe normalisation of `description` is load-bearing: typographic
 * guillemets `«…»` are a display convention, not YAML quotes; any `: ` inside
 * such a plain scalar breaks every real YAML parser downstream (a scan
 * once found 49/538 notes unparseable on exactly this field; `sed`
 * editing of frontmatter is banned).
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { TaxonomyPreset } from "./taxonomy.js";
import { DEFAULT_CURATOR_SET, genreForFolder, linksSectionPattern } from "./taxonomy.js";
import { guardedWriteFileSync, guardedUnlinkSync } from "./fs-guard.js";

const FRONTMATTER_RE = /^---[^\S\n]*\n([\s\S]*?\n)---[^\S\n]*(?:\n|$)/;

export const VALID_ZONES = ["permanent", "memory"] as const;
export type Zone = (typeof VALID_ZONES)[number];

/**
 * Array fields for which an empty value is meaningless and gets sanitised.
 * Source of emptiness: the Index may have edited `coauthors:` without a
 * following `  - <name>` item, or a draft arrived
 * with a truncated value. The hook removes such keys idempotently.
 */
export const EMPTY_ARRAY_KEYS = ["tags", "coauthors"] as const;

/** Fields rewritten into valid YAML by `normalizeFields`. */
export const NORMALIZE_KEYS = ["description"] as const;

export type FillContext = {
  taxonomy: TaxonomyPreset;
  /** ADR-006 curator set; defaults to DEFAULT_CURATOR_SET. */
  curatorSet?: readonly string[];
};

function isCurator(agent: string, ctx: FillContext): boolean {
  return (ctx.curatorSet ?? DEFAULT_CURATOR_SET).includes(agent);
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function hasField(block: string, key: string): boolean {
  return new RegExp(`^${escapeRe(key)}\\s*:`, "m").test(block);
}

/** Update or insert — always sets to value. */
export function upsert(block: string, key: string, value: string): string {
  const pattern = new RegExp(`^${escapeRe(key)}\\s*:.*$`, "m");
  if (pattern.test(block)) {
    return block.replace(pattern, () => `${key}: ${value}`);
  }
  if (block && !block.endsWith("\n")) block += "\n";
  return `${block}${key}: ${value}\n`;
}

/** Set only if the field is absent — preserves the author's explicit override. */
export function setIfMissing(block: string, key: string, value: string): string {
  if (hasField(block, key)) return block;
  if (block && !block.endsWith("\n")) block += "\n";
  return `${block}${key}: ${value}\n`;
}

/** Read a scalar field value, or null when absent. */
export function readScalar(block: string, key: string): string | null {
  const m = new RegExp(`^${escapeRe(key)}\\s*:\\s*(.+?)\\s*$`, "m").exec(block);
  return m ? m[1].trim() : null;
}

/** Parse a YAML list field (block-list `  - item` or inline `[a, b]`). */
export function parseListField(block: string, key: string): string[] {
  const lines = block.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = new RegExp(`^${escapeRe(key)}\\s*:\\s*(.*)$`).exec(lines[i]);
    if (!m) continue;
    const inline = m[1].trim();
    if (inline) {
      return inline
        .replace(/^\[/, "")
        .replace(/\]$/, "")
        .split(",")
        .map((s) => s.trim().replace(/^["']|["']$/g, ""))
        .filter(Boolean);
    }
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

/** Remove a list field entirely (its `key:` line + any `  - item` lines). */
function removeListField(block: string, key: string): string {
  const lines = block.split("\n");
  const out: string[] = [];
  const head = new RegExp(`^${escapeRe(key)}\\s*:`);
  for (let i = 0; i < lines.length; i++) {
    if (head.test(lines[i])) {
      // skip the key line and the following block-list items
      while (i + 1 < lines.length && /^\s+-\s/.test(lines[i + 1])) i++;
      continue;
    }
    out.push(lines[i]);
  }
  return out.join("\n");
}

/**
 * Append `name` to `coauthors` (lean §3a auto-coauthor). No-op if already
 * present. Rewrites the field as a normalised block-list at the end of the
 * frontmatter — idempotent once the name is in the list.
 */
export function addCoauthor(block: string, name: string): string {
  const existing = parseListField(block, "coauthors");
  if (existing.includes(name)) return block;
  let b = removeListField(block, "coauthors");
  if (b && !b.endsWith("\n")) b += "\n";
  const all = [...existing, name];
  b += "coauthors:\n" + all.map((n) => `  - ${n}`).join("\n") + "\n";
  return b;
}

/** Returns [fmBlock, rest]. No frontmatter → ["", content]. */
export function splitFrontmatter(content: string): [string, string] {
  const m = FRONTMATTER_RE.exec(content);
  if (m) {
    return [m[1], content.slice(m[0].length)];
  }
  return ["", content];
}

export function basenameNoExt(filePath: string): string {
  const base = path.basename(filePath);
  return base.endsWith(".md") ? base.slice(0, -3) : base;
}

function relParts(filePath: string, vault: string): string[] | null {
  const rel = path.relative(vault, filePath);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return null;
  return rel.split(path.sep);
}

/**
 * Extract the owner subfolder name from a path of the form
 * `<vault>/<agentMemoryFolder>/<owner>/...`. Returns null when the path is
 * outside the expected structure — the caller must abort (not our zone).
 */
export function parseMemoryAuthor(
  filePath: string,
  vault: string,
  taxonomy: TaxonomyPreset,
): string | null {
  const parts = relParts(filePath, vault);
  if (!parts || parts.length < 3 || parts[0] !== taxonomy.folders.agentMemory) {
    return null;
  }
  const owner = parts[1].trim();
  return owner || null;
}

/**
 * Zone of a file by the first path segment relative to the vault — the
 * single source of truth for zone routing (the reference de-duplicated a
 * bash `case` into exactly this function). Folder whitelist comes from the
 * taxonomy preset (ADR-002): archive and system are NOT in the whitelist →
 * null → caller no-ops. (Inbox zones removed with the direct-to-canon model:
 * authors write straight into the typed canon folders, the write hook fills.)
 */
export function resolveZone(
  filePath: string,
  vault: string,
  taxonomy: TaxonomyPreset,
): Zone | null {
  if (!vault) return null;
  const parts = relParts(filePath, vault);
  if (!parts || parts.length === 0) return null;
  const head = parts[0];
  const f = taxonomy.folders;
  if (
    head === f.knowledge ||
    head === f.decisions ||
    head === f.projects ||
    head === f.ideas ||
    head === f.lists
  ) {
    return "permanent";
  }
  if (head === f.agentMemory) return "memory";
  return null;
}

/**
 * Full permanent-zone (canon) fill — the lean §2 write-hook core, SHARED between
 * the post-write hook (`processFile`) and the human-edit detector
 * (`decideUpdate`), so an agent's write and a human's external write get
 * identical deterministic frontmatter (mandate §2: «ОБЩАЯ логика из 2 путей»).
 *
 * Before lean the permanent branch was a near-empty stamp (canon frontmatter
 * was supplied by the Index on placement). In lean the author writes only
 * body + tags + organic inline links + a self-describing title; everything
 * here is derived deterministically (0 LLM):
 *   - `title` ← file name; `type`/`status` ← the FOLDER's genre (§2.1);
 *     `created` ← today; `author` ← the writer (non-curator);
 *   - `last_edited_by`/`updated` ← the stamp pair (always upserted).
 */
export function fillPermanentFull(
  fmBlock: string,
  opts: {
    path: string;
    agent: string;
    vault: string;
    today: string;
    nowStamp: string;
    ctx: FillContext;
  },
): string {
  const { taxonomy } = opts.ctx;
  // Service stamp (always) — load-bearing for smart-hash echo-safety and the
  // unstamped detector, symmetric with fillMemory.
  fmBlock = upsert(fmBlock, "last_edited_by", opts.agent);
  fmBlock = upsert(fmBlock, "updated", opts.nowStamp);
  // Canon frontmatter the author no longer hand-writes (§2.1). setIfMissing —
  // an explicit author value is never clobbered; a re-edit of an existing note
  // is a stamp-only no-op on these.
  fmBlock = setIfMissing(fmBlock, "title", basenameNoExt(opts.path));
  const folder = opts.vault ? relParts(opts.path, opts.vault)?.[0] : undefined;
  const genre = folder ? genreForFolder(taxonomy, folder) : null;
  if (genre) {
    fmBlock = setIfMissing(fmBlock, "type", genre.type);
    fmBlock = setIfMissing(fmBlock, "status", genre.initialStatus);
  }
  fmBlock = setIfMissing(fmBlock, "created", opts.today);
  // AUTHOR GUARD (invariant, §3a): a
  // curator (Index/Scriber/DreamWeaver) edits canon STRUCTURE, never authors
  // content — it never becomes `author` (nor, L2, `coauthors`). Same guard as
  // the inbox branch. A non-curator writing canon IS the author. `needs_review`
  // is the guard's flag, lifted only by Index/human.
  if (!isCurator(opts.agent, opts.ctx)) {
    fmBlock = setIfMissing(fmBlock, "author", opts.agent);
    fmBlock = upsert(fmBlock, "needs_review", "true");
    // §3a auto-coauthor: a non-curator who edits a canon note authored by
    // SOMEONE ELSE is recorded as a coauthor — content collaboration that
    // kills duplicates. Curators are excluded (they edit
    // STRUCTURE, not content — same guard as the author guard). `author` is
    // immutable; only `coauthors` grows. On a NEW note author===agent → no-op.
    const author = readScalar(fmBlock, "author");
    if (author && author !== opts.agent) {
      fmBlock = addCoauthor(fmBlock, opts.agent);
    }
  } else {
    // Curator branch (Index/Scriber/DreamWeaver): never authors, never raises
    // the flag — but EMITS the boolean when absent so the line is always
    // present (checkbox convention: needs_review must
    // always render as an Obsidian checkbox). setIfMissing — a standing `true`
    // on a note the curator only edits structurally is never cleared here
    // (clearing is the curator's explicit act, not a side-effect of any edit).
    fmBlock = setIfMissing(fmBlock, "needs_review", "false");
  }
  return moveServiceFieldsToEnd(fmBlock);
}

/**
 * Returns the updated block, or null when the path is outside the expected
 * `<agentMemoryFolder>/<owner>/...` structure while a vault is provided
 * (caller aborts processing).
 */
export function fillMemory(
  fmBlock: string,
  opts: {
    path: string;
    agent: string;
    vault: string;
    today: string;
    nowStamp: string;
    ctx: FillContext;
  },
): string | null {
  const { taxonomy } = opts.ctx;
  fmBlock = upsert(fmBlock, "last_edited_by", opts.agent);
  fmBlock = upsert(fmBlock, "updated", opts.nowStamp);
  if (!isCurator(opts.agent, opts.ctx)) {
    fmBlock = upsert(fmBlock, "needs_review", "true");
  } else {
    // Curator branch: emit the boolean when absent so the line is always
    // present (checkbox convention) — setIfMissing never clears a
    // standing `true`.
    fmBlock = setIfMissing(fmBlock, "needs_review", "false");
  }

  let authorForConstants: string;
  if (opts.vault) {
    const parsed = parseMemoryAuthor(opts.path, opts.vault, taxonomy);
    if (parsed === null) return null;
    authorForConstants = parsed;
  } else {
    authorForConstants = opts.agent;
  }

  fmBlock = setIfMissing(fmBlock, "title", basenameNoExt(opts.path));
  fmBlock = setIfMissing(fmBlock, "type", taxonomy.types.agentMemory);
  fmBlock = setIfMissing(fmBlock, "status", taxonomy.statusTokens.current);
  fmBlock = setIfMissing(fmBlock, "created", opts.today);
  fmBlock = setIfMissing(fmBlock, "author", authorForConstants);
  return moveServiceFieldsToEnd(fmBlock);
}

/**
 * Remove keys whose value is an empty YAML array. Recognises three forms of
 * emptiness, leaves everything else intact:
 * - `key:` with no value and no following `  - item` lines (empty block form);
 * - `key: []` — inline empty array;
 * - `key: null` / `key: ~` — explicit null.
 */
export function stripEmptyArrays(
  fmBlock: string,
  keys: readonly string[] = EMPTY_ARRAY_KEYS,
): string {
  const lines = fmBlock.split("\n");
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const m = /^([A-Za-z_][\w-]*)\s*:\s*(.*?)\s*$/.exec(line);
    if (m && keys.includes(m[1])) {
      const value = m[2];
      if (value === "[]" || value === "null" || value === "~") {
        i += 1;
        continue;
      }
      if (value === "") {
        const nxt = i + 1 < lines.length ? lines[i + 1] : "";
        if (!/^\s+-\s/.test(nxt)) {
          i += 1;
          continue;
        }
      }
    }
    out.push(line);
    i += 1;
  }
  return out.join("\n");
}

// --- YAML-safe scalar normalisation (load-bearing) --------------------------

/** Leading characters that make a plain scalar invalid/ambiguous in YAML. */
const YAML_INDICATORS = new Set([..."!&*?|>%@`\"'#,[]{}"]);

/** v is a well-formed, terminated double-quoted YAML scalar. */
export function isCleanDoubleQuoted(v: string): boolean {
  if (v.length < 2 || v[0] !== '"') return false;
  let i = 1;
  const n = v.length;
  while (i < n) {
    if (v[i] === "\\") {
      i += 2;
      continue;
    }
    if (v[i] === '"') return i === n - 1;
    i += 1;
  }
  return false;
}

/** v is a well-formed, terminated single-quoted YAML scalar (escape is `''`). */
export function isCleanSingleQuoted(v: string): boolean {
  if (v.length < 2 || v[0] !== "'") return false;
  let i = 1;
  const n = v.length;
  while (i < n) {
    if (v[i] === "'") {
      if (i + 1 < n && v[i + 1] === "'") {
        i += 2;
        continue;
      }
      return i === n - 1;
    }
    i += 1;
  }
  return false;
}

/**
 * Plain scalar `v` is unsafe (would parse as something other than a string
 * literal, or crash the parser). Empty and block scalars (`|`/`>`) never
 * reach this — filtered earlier.
 */
export function yamlNeedsQuoting(v: string): boolean {
  if (!v) return false;
  if (YAML_INDICATORS.has(v[0]) || v[0] === ":") return true;
  if (v[0] === "-" && (v.length === 1 || v[1] === " " || v[1] === "\t")) return true;
  if (v.includes(": ") || v.endsWith(":")) return true;
  if (v.includes(" #")) return true;
  if (v.includes("\t")) return true;
  return false;
}

/** Serialise string `s` as a valid double-quoted YAML scalar. */
export function yamlDoubleQuote(s: string): string {
  const out: string[] = ['"'];
  for (const ch of s) {
    if (ch === "\\") out.push("\\\\");
    else if (ch === '"') out.push('\\"');
    else if (ch === "\n") out.push("\\n");
    else if (ch === "\t") out.push("\\t");
    else if (ch === "\r") out.push("\\r");
    else if (ch.codePointAt(0)! < 0x20) {
      out.push(`\\x${ch.codePointAt(0)!.toString(16).padStart(2, "0")}`);
    } else out.push(ch);
  }
  out.push('"');
  return out.join("");
}

/**
 * Strip convention delimiters that YAML does not recognise as quotes,
 * keeping the logical content. `«…»` — the description convention pair.
 * A dangling (unterminated) leading `'`/`"` is an artefact of a truncated
 * quoted value: strip the leading one and the paired trailing one if present.
 */
export function stripBrokenDelims(v: string): string {
  v = v.trim();
  if (v.length >= 2 && v[0] === "«" && v[v.length - 1] === "»") {
    return v.slice(1, -1).trim();
  }
  if (v.startsWith("'")) {
    v = v.slice(1);
    if (v.endsWith("'")) v = v.slice(0, -1);
    return v.replaceAll("''", "'").trim();
  }
  if (v.startsWith('"')) {
    v = v.slice(1);
    if (v.endsWith('"')) v = v.slice(0, -1);
    return v.trim();
  }
  return v;
}

/**
 * Return the YAML-safe representation of a scalar value, or null when no
 * edit is needed (already valid / empty / block scalar). `raw` is the text
 * after `key:`.
 */
export function normalizeScalarValue(raw: string): string | null {
  const v = raw.trim();
  if (!v || v[0] === "|" || v[0] === ">") return null;
  if (isCleanDoubleQuoted(v) || isCleanSingleQuoted(v)) return null;
  if (!yamlNeedsQuoting(v)) return null;
  return yamlDoubleQuote(stripBrokenDelims(v));
}

const NORMALIZE_LINE_RE = /^([A-Za-z_][\w-]*):[ \t]?(.*)$/;

/**
 * Rewrite the values of `keys` fields into valid YAML. Line-based: vault
 * frontmatter is flat (one `key: value` per line); block-list fields
 * (tags/coauthors) are not in `keys`. Idempotent.
 */
export function normalizeFields(
  fmBlock: string,
  keys: readonly string[] = NORMALIZE_KEYS,
): string {
  const lines = fmBlock.split("\n");
  for (let idx = 0; idx < lines.length; idx++) {
    const m = NORMALIZE_LINE_RE.exec(lines[idx]);
    if (!m || !keys.includes(m[1])) continue;
    const newVal = normalizeScalarValue(m[2]);
    if (newVal !== null) {
      lines[idx] = `${m[1]}: ${newVal}`;
    }
  }
  return lines.join("\n");
}

/**
 * YAML-safe normalisation of EVERY scalar frontmatter field (lean §2.2). Before
 * lean only `description` was normalised; the «`: ` inside a plain scalar»
 * failure (incident 49/538 unparseable) applies to ANY field — title, status,
 * author, etc. Block-list fields (`tags`, `coauthors`) are EXCLUDED: they use
 * the `  - item` form, and the inline `[..]`/`: ` heuristic would corrupt them.
 * Idempotent (a clean-quoted value is left untouched).
 */
export function normalizeAllScalars(
  fmBlock: string,
  excludeKeys: readonly string[] = EMPTY_ARRAY_KEYS,
): string {
  const lines = fmBlock.split("\n");
  for (let idx = 0; idx < lines.length; idx++) {
    const m = NORMALIZE_LINE_RE.exec(lines[idx]);
    if (!m || excludeKeys.includes(m[1])) continue;
    const newVal = normalizeScalarValue(m[2]);
    if (newVal !== null) lines[idx] = `${m[1]}: ${newVal}`;
  }
  return lines.join("\n");
}

/** Markdown thematic break: `---`, `***`, `___`, optionally spaced. */
const HR_LINE_RE = /^[ \t]*([-*_])(?:[ \t]*\1){2,}[ \t]*$/;

/**
 * A line that is a fuzzy match of the links-section heading: any `#` level,
 * any spacing, any case, but the section text EXACTLY (so `## Связанные…`
 * never matches `## Связи`).
 */
function isFuzzyLinksHeading(line: string, taxonomy: TaxonomyPreset): boolean {
  const sectionText = taxonomy.linksSection.replace(/^#+\s*/, "");
  const esc = sectionText.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^#{1,6}\\s*${esc}\\s*$`, "i").test(line.trim());
}

/**
 * Make a leading links-section block recognisable to the parser's
 * `stripLinksSection` (heading at body start + a `---` divider), so the block
 * is cut from search/embedding content instead of polluting BM25 with
 * popular-target false hits (lean §2.2). CONSERVATIVE and mechanical (§10.2):
 * only the heading line FORM and the block's HR divider are rewritten — never
 * content, nothing inserted or moved. Body without a leading links heading →
 * no-op. Idempotent.
 */
export function normalizeLinksBlock(body: string, taxonomy: TaxonomyPreset): string {
  const lines = body.split("\n");
  let i = 0;
  while (i < lines.length && lines[i].trim() === "") i++;
  if (i >= lines.length || !isFuzzyLinksHeading(lines[i], taxonomy)) return body;
  if (lines[i] !== taxonomy.linksSection) lines[i] = taxonomy.linksSection;
  // Normalise the block's first HR divider to `---`. Scan only across the link
  // list (`- …` / `* …` items and blanks); a content line means no divider —
  // leave it (the heading fix alone is the safe part).
  for (let j = i + 1; j < lines.length; j++) {
    if (HR_LINE_RE.test(lines[j])) {
      if (lines[j].trim() !== "---") lines[j] = "---";
      break;
    }
    const t = lines[j].trim();
    if (t !== "" && !t.startsWith("-") && !t.startsWith("*")) break;
  }
  return lines.join("\n");
}

/**
 * Service fields in their canonical trailing order (frontmatter
 * convention): the hook-owned service trio lives at the END of
 * the frontmatter, after the author-facing fields. They are all scalars (never
 * block-lists), so a line-based move is structurally safe — a block-list key
 * (`tags`/`coauthors`) and its `  - item` children are non-service and stay
 * put. Reordering only service lines leaves the SEMANTIC hash unchanged (the
 * trio is excluded from smart-hash), so this normalisation is service-only and
 * never trips humanEditPass.
 */
export const SERVICE_FIELDS_TRAILING_ORDER: readonly string[] = [
  "last_edited_by",
  "updated",
  "needs_review",
];

export function moveServiceFieldsToEnd(fmBlock: string): string {
  const hadTrailingNl = fmBlock.endsWith("\n");
  const lines = fmBlock.replace(/\n+$/, "").split("\n");
  const service = new Map<string, string>();
  const kept: string[] = [];
  for (const line of lines) {
    const m = /^([A-Za-z_][\w-]*)\s*:/.exec(line);
    if (m && SERVICE_FIELDS_TRAILING_ORDER.includes(m[1])) {
      service.set(m[1], line); // scalar — no trailing list items to carry
      continue;
    }
    kept.push(line);
  }
  if (service.size === 0) return fmBlock;
  const tail = SERVICE_FIELDS_TRAILING_ORDER.filter((k) => service.has(k)).map(
    (k) => service.get(k)!,
  );
  const out = [...kept, ...tail].join("\n");
  return hadTrailingNl ? out + "\n" : out;
}

/**
 * Assemble the new file. A body not starting with a newline gets one, so the
 * markdown parser sees the frontmatter separately from the first paragraph.
 */
export function assemble(fmBlock: string, rest: string): string {
  if (rest && !rest.startsWith("\n")) rest = "\n" + rest;
  return "---\n" + fmBlock + "---\n" + rest;
}

/** temp file + rename — atomic write on POSIX. */
export function atomicWrite(filePath: string, content: string): void {
  const tmp = path.join(
    path.dirname(filePath),
    `.fm-${crypto.randomBytes(6).toString("hex")}.tmp`,
  );
  try {
    guardedWriteFileSync(tmp, content, "utf-8");
    fs.renameSync(tmp, filePath);
  } catch (err) {
    try {
      if (fs.existsSync(tmp)) guardedUnlinkSync(tmp);
    } catch {
      // best effort
    }
    throw err;
  }
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function localDateIso(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * `YYYY-MM-DD HH:MM:SS` — second precision is deliberate: the human-edit
 * detector tells an agent edit (hook just ran) from an external-editor edit
 * by the freshness of `updated` relative to a window; minute truncation ate
 * up to 59s of that window and caused mis-attribution loops. Parsers accept
 * the legacy `YYYY-MM-DD HH:MM` too.
 */
function localStamp(d: Date): string {
  return `${localDateIso(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export type ProcessOptions = {
  zone: Zone | "auto";
  agent: string;
  vault?: string;
  /** Injectable for tests; defaults to new Date(). */
  now?: Date;
  taxonomy: TaxonomyPreset;
  curatorSet?: readonly string[];
};

/**
 * Main entry. Returns true when the file was changed, false on no-op.
 * zone === "auto" resolves the zone from the path (whitelist of canonical
 * folders); a path outside the whitelist is a no-op.
 */
export function processFile(filePath: string, opts: ProcessOptions): boolean {
  const ctx: FillContext = { taxonomy: opts.taxonomy, curatorSet: opts.curatorSet };
  const vault = opts.vault ?? "";

  let zone: Zone;
  if (opts.zone === "auto") {
    const resolved = resolveZone(filePath, vault, opts.taxonomy);
    if (resolved === null) return false;
    zone = resolved;
  } else {
    zone = opts.zone;
  }
  if (!VALID_ZONES.includes(zone)) return false;
  if (!opts.agent) return false;
  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return false;
  }
  if (!stat.isFile()) return false;

  const now = opts.now ?? new Date();
  const today = localDateIso(now);
  const nowStamp = localStamp(now);

  const content = fs.readFileSync(filePath, "utf-8");
  const [fmBlock, rest] = splitFrontmatter(content);

  let newFm: string | null;
  let newBody = rest;
  if (zone === "permanent") {
    newFm = fillPermanentFull(fmBlock, {
      path: filePath,
      agent: opts.agent,
      vault,
      today,
      nowStamp,
      ctx,
    });
    newBody = normalizeLinksBlock(rest, opts.taxonomy);
  } else {
    newFm = fillMemory(fmBlock, {
      path: filePath,
      agent: opts.agent,
      vault,
      today,
      nowStamp,
      ctx,
    });
    if (newFm === null) return false;
    newBody = normalizeLinksBlock(rest, opts.taxonomy);
  }

  newFm = stripEmptyArrays(newFm);
  newFm = normalizeAllScalars(newFm);
  const newContent = assemble(newFm, newBody);
  if (newContent === content) return false;
  atomicWrite(filePath, newContent);
  return true;
}

/**
 * Resolve the writing identity (нюанс 10): explicit value first, then the
 * stable iapeer identity `PEER_PERSONALITY`, then the namespace fallback
 * `IAPEER_MEMORY_AGENT_NAME` (non-peer sessions). Null when nothing is set —
 * the caller must no-op, never guess from cwd.
 */
export function resolveAgentName(
  explicit?: string | null,
  env: Record<string, string | undefined> = process.env,
): string | null {
  const candidates = [explicit, env.PEER_PERSONALITY, env.IAPEER_MEMORY_AGENT_NAME];
  for (const c of candidates) {
    const v = (c ?? "").trim();
    if (v) return v;
  }
  return null;
}
