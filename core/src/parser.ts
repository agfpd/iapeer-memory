import matter from "gray-matter";
import { noteTitleFromPath } from "./utils.js";
import { linksSectionPattern, type TaxonomyPreset } from "./taxonomy.js";

/**
 * Parser fingerprint — bump MANUALLY when the chunking/parsing algorithm
 * changes in a way that affects what is STORED on disk (chunk boundaries, a
 * chunk-title prefix, normalization of stored text). On a bump, memoryd's
 * writer startup runs `checkParserChanged(db, PARSER_VERSION)`, which nulls
 * every `documents.content_hash` so the next `indexAll` re-parses all notes
 * under the new algorithm. Pure ranking/query changes that don't alter the
 * stored chunks do NOT need a bump.
 */
export const PARSER_VERSION = "2";

const WIKILINK_RE = /\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g;

/**
 * Strip a wikilink target down to its stored form, KEEPING the path.
 *
 * Obsidian allows four wikilink shapes:
 *   [[Name]]
 *   [[Name|alias]]
 *   [[Folder/Subfolder/Name]]
 *   [[Folder/Subfolder/Name|alias]]
 *
 * The regex above already strips the `|alias` part. We only strip a trailing
 * `.md` and trim — the folder path is deliberately preserved so the resolver
 * (indexer.resolveWikilinks) can do path-aware resolution: an explicit
 * `[[03_Проекты/A/Фаза]]` must NOT collapse to the bare basename and risk
 * resolving to a same-named note in another project.
 */
function stripWikilinkTarget(raw: string): string {
  return raw.replace(/\.md$/i, "").trim();
}

/**
 * Last path segment of a (possibly path-qualified) wikilink target. Used by
 * the resolver for the basename-uniqueness fallback when there is no path.
 */
export function wikilinkBasename(target: string): string {
  const seg = target.includes("/") ? (target.split("/").pop() ?? target) : target;
  return seg.trim();
}

export type ParsedChunk = {
  chunkIndex: number;
  text: string;
};

export type ParsedWikilink = {
  target: string;
  contextSnippet: string;
};

export type ParsedDocument = {
  title: string;
  body: string;
  text: string;
  frontmatter: Record<string, unknown>;
  type: string | null;
  status: string | null;
  tags: string[];
  created: string | null;
  updated: string | null;
  wikilinks: ParsedWikilink[];
  chunks: ParsedChunk[];
};

export function parseMarkdown(content: string, relativePath: string, chunkSize: number, chunkOverlap: number, taxonomy: TaxonomyPreset): ParsedDocument {
  const parsed = matter(content);
  const frontmatter = normalizeFrontmatter(parsed.data);
  const body = parsed.content.trim();
  const title = typeof frontmatter.title === "string" ? frontmatter.title : noteTitleFromPath(relativePath);

  // Wikilinks are still extracted from the FULL body (including the "## Связи"
  // block) so the graph stays correct. But the indexed/embedded text is the
  // note's actual content — without the links section the wikilinks would
  // otherwise pollute BM25 hits and steal snippet fallback.
  const indexableBody = stripLinksSection(body, taxonomy);

  return {
    title,
    body,
    text: content,
    frontmatter,
    type: asNullableString(frontmatter.type),
    status: asNullableString(frontmatter.status),
    tags: Array.isArray(frontmatter.tags) ? frontmatter.tags.filter((tag): tag is string => typeof tag === "string") : [],
    created: asNullableString(frontmatter.created),
    updated: asNullableString(frontmatter.updated),
    wikilinks: extractWikilinks(body),
    chunks: chunkText(indexableBody, chunkSize, chunkOverlap, title),
  };
}

/**
 * Strip the links-section block (taxonomy.linksSection heading + its [[wikilink]]
 * list) from a note body before chunking. The links section is graph metadata,
 * not semantic content — feeding it to BM25/embeddings produces false hits on
 * every note that mentions a popular wikilink target, and the snippet fallback
 * in search.ts pulls the first chunk which (without this strip) is just links.
 *
 * Two positions are tolerated (the canon convention is the block at the BOTTOM;
 * the TOP form stays recognised for notes not yet migrated):
 *   LEADING — body starts with the heading AND a "---" divider follows; the
 *     indexable content is everything after the divider.
 *   TRAILING — a heading at the END whose following lines are all link items /
 *     blanks; the indexable content is everything before it (and before a "---"
 *     divider sitting directly above it, if any).
 * Notes without either structure pass through unchanged. The wikilinks
 * themselves are still extracted from the FULL body (graph edges are unaffected
 * by this strip) — see extractWikilinks.
 */
export function stripLinksSection(body: string, taxonomy: TaxonomyPreset): string {
  // The heading pattern comes from the taxonomy preset (ADR-002): `## Links`
  // for the EN base, `## Связи` for RU. linksSectionPattern uses (?:\s|$)
  // instead of `\b` — JS \b is ASCII-only and useless after a cyrillic
  // letter (the strip silently no-op'd on every RU note before this fix).
  if (linksSectionPattern(taxonomy).test(body)) {
    const dividerMatch = body.match(/\n---\s*\n/);
    if (!dividerMatch || dividerMatch.index === undefined) return body;
    return body.slice(dividerMatch.index + dividerMatch[0].length).trim();
  }
  // Trailing block: scan up from the end over link-list items / blanks; a
  // links heading there delimits a bottom block, a content line means there
  // is none.
  const lines = body.split("\n");
  let h = -1;
  for (let k = lines.length - 1; k >= 0; k--) {
    const t = lines[k].trim();
    if (t === "") continue;
    if (linksSectionPattern(taxonomy).test(lines[k])) {
      h = k;
      break;
    }
    if (t.startsWith("-") || t.startsWith("*")) continue;
    break;
  }
  if (h === -1) return body;
  let cut = h;
  let p = h - 1;
  while (p >= 0 && lines[p].trim() === "") p--;
  if (p >= 0 && /^[ \t]*-{3,}[ \t]*$/.test(lines[p])) cut = p;
  return lines.slice(0, cut).join("\n").trim();
}

/**
 * Маскирует содержимое markdown code-областей пробелами равной длины. Это
 * подавляет `[[X]]` внутри `\`код\`` и ```fenced ...``` от попадания в граф
 * как реальные wikilinks — раньше шаблонные placeholder'ы из инструкций
 * Индекса/копирайтера (`\`[[X]]\``, ```\n[[Связанная заметка]]\n```) шли в
 * `edges` как broken links, забивая `unresolved_links` фолс-orphan'ами.
 *
 * Замена ПРОБЕЛАМИ (не удаление) — offset'ы остального текста не сдвигаются,
 * `contextSnippet` ниже строится из ОРИГИНАЛЬНОГО body, окно вокруг wikilink
 * остаётся правильным.
 *
 * Порядок: сначала fenced (3+ backticks/tildes на отдельных строках) — они
 * длиннее и могут содержать внутри одиночные backticks; потом многократные
 * inline (\`\`escape\`\`) и одиночные (\`code\`). Не покрывает edge-cases
 * CommonMark с N-backtick парами (N≥3 inline) — в наших нотах не встречаются.
 */
function maskCodeRegions(body: string): string {
  let masked = body;
  // Fenced ```...``` или ~~~...~~~ (включая многострочное содержимое).
  masked = masked.replace(/```[\s\S]*?```|~~~[\s\S]*?~~~/g, (m) => " ".repeat(m.length));
  // Inline ``escape`` (double backtick — для строк с backtick внутри).
  masked = masked.replace(/``[^`\n]+``/g, (m) => " ".repeat(m.length));
  // Inline `code` (single backtick). [^`\n] — не переносить строку, и не есть
  // вложенные backticks (CommonMark inline code не пересекает строку без
  // явной обёртки).
  masked = masked.replace(/`[^`\n]+`/g, (m) => " ".repeat(m.length));
  return masked;
}

export function extractWikilinks(body: string): ParsedWikilink[] {
  const masked = maskCodeRegions(body);
  const matches: ParsedWikilink[] = [];
  for (const match of masked.matchAll(WIKILINK_RE)) {
    const rawTarget = match[1]?.trim();
    if (!rawTarget) continue;
    const start = Math.max(0, (match.index ?? 0) - 50);
    const end = Math.min(body.length, (match.index ?? 0) + match[0].length + 50);
    matches.push({
      // Path-preserving: [[Name]] → "Name", [[Folder/Name]] → "Folder/Name",
      // [[Folder/Name.md]] → "Folder/Name". The resolver decides path-exact
      // vs basename-unique — it must see the path the author actually wrote.
      target: stripWikilinkTarget(rawTarget),
      // contextSnippet строим из оригинального body, не masked — иначе
      // пользователь увидит пустоту вместо реального окружения wikilink'а.
      contextSnippet: body.slice(start, end).replace(/\s+/g, " ").trim(),
    });
  }
  return matches;
}

export function chunkText(
  body: string,
  chunkSize: number,
  chunkOverlap: number,
  title?: string,
): ParsedChunk[] {
  const normalized = body.replace(/\r\n/g, "\n").trim();
  // Title prefix: BM25 (FTS5) and the embedding model both index chunk_text
  // verbatim, so a note's title was effectively invisible to search. We
  // prepend the title to the first chunk only — that's enough for both the
  // keyword and semantic paths to "see" the note name without bloating every
  // chunk and skewing BM25 with repeated matches.
  const titlePrefix = title?.trim() ? `${title.trim()}\n\n` : "";

  if (!normalized) {
    // Empty body still indexes by title alone — otherwise a freshly-created
    // note (frontmatter only) is unsearchable until first content edit.
    return titlePrefix
      ? [{ chunkIndex: 0, text: titlePrefix.trim() }]
      : [];
  }

  const paragraphs = normalized
    .split(/\n{2,}/)
    .map((part) => part.trim())
    .filter(Boolean);

  // We accumulate text-only entries here and assign sequential chunkIndex
  // values in the final map below. Internal type kept narrow so pushChunk's
  // signature lines up.
  const chunks: { text: string }[] = [];
  let current = "";

  for (const paragraph of paragraphs) {
    if (!current) {
      current = paragraph;
      continue;
    }

    const candidate = `${current}\n\n${paragraph}`;
    if (candidate.length <= chunkSize) {
      current = candidate;
      continue;
    }

    pushChunk(chunks, current);
    current = mergeOverlap(current, paragraph, chunkOverlap);

    // Infinite-loop guard: a paragraph longer than chunkSize with no
    // splittable whitespace can make findSplitIndex return chunkSize and the
    // post-slice tail can stay >chunkSize indefinitely. Bail when a pass
    // doesn't shorten `current`.
    while (current.length > chunkSize) {
      const before = current.length;
      const splitIndex = findSplitIndex(current, chunkSize);
      pushChunk(chunks, current.slice(0, splitIndex).trim());
      current = current.slice(Math.max(0, splitIndex - chunkOverlap)).trim();
      if (current.length >= before) {
        // Hard cut: drop the consumed prefix outright. Better a too-large
        // last chunk than a wedged indexer.
        pushChunk(chunks, current.slice(0, chunkSize));
        current = current.slice(chunkSize);
        break;
      }
    }
  }

  if (current) {
    pushChunk(chunks, current);
  }

  // Prepend the title to chunk[0] in place — keeps chunkIndex sequencing
  // intact and preserves the per-chunk size budget for the rest.
  if (titlePrefix && chunks.length > 0) {
    chunks[0] = { text: `${titlePrefix}${chunks[0].text}` };
  }

  return chunks.map((chunk, index) => ({ chunkIndex: index, text: chunk.text }));
}

function pushChunk(chunks: { text: string }[], text: string): void {
  const normalized = text.trim();
  if (normalized) chunks.push({ text: normalized });
}

function mergeOverlap(previous: string, next: string, overlap: number): string {
  const tail = previous.slice(Math.max(0, previous.length - overlap)).trim();
  return [tail, next].filter(Boolean).join("\n\n").trim();
}

function findSplitIndex(input: string, target: number): number {
  const candidates = [input.lastIndexOf("\n", target), input.lastIndexOf(" ", target)].filter((index) => index > 0);
  return Math.max(...candidates, Math.min(target, input.length));
}

function normalizeFrontmatter(data: unknown): Record<string, unknown> {
  return data && typeof data === "object" && !Array.isArray(data) ? { ...(data as Record<string, unknown>) } : {};
}

function asNullableString(value: unknown): string | null {
  if (typeof value === "string") return value;
  // gray-matter parses YAML date scalars (e.g. `created: 2026-03-30`) into
  // Date objects. Without this branch the meta we surface from vault_read
  // would silently drop them as null.
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString().slice(0, 10);
  }
  return null;
}
