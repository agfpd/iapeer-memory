import crypto from "node:crypto";
import path from "node:path";

// Hash the FULL file content. Was a 4096-char prefix hash — that skipped
// reindexing whenever an append-only note (План / Фаза / Список — a
// first-class vault genre that grows downward) changed below the prefix
// window, leaving memory_search / embeddings on the stale tail. Markdown is
// cheap; correctness over the micro-optimisation. If profiling ever demands
// it, gate a full hash behind size+mtime, never trust a prefix as the source
// of truth.
export function hashContent(content: string): string {
  return crypto.createHash("sha256").update(content).digest("hex");
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function normalizeRelativePath(input: string): string {
  return input.split(path.sep).join("/").normalize("NFD");
}

/**
 * Normalize a path to NFD for iCloud/macOS compatibility.
 * macOS stores filenames in NFD (decomposed), but user input and code often uses NFC.
 */
export function normalizePath(input: string): string {
  return input.normalize("NFD");
}

export function noteTitleFromPath(relativePath: string): string {
  const base = path.basename(relativePath, path.extname(relativePath));
  return base.trim();
}

export function toJson(value: unknown): string {
  return JSON.stringify(value ?? null);
}

export function fromJson<T>(value: string | null, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

/**
 * Split a raw user query into the bare search tokens — same normalisation the
 * FTS path uses (strip control chars + FTS-significant punctuation, split on
 * whitespace), minus the `"tok"*` wrapping. Shared so the FTS query and the
 * query-aware snippet builder tokenise identically: the snippet highlights
 * exactly the words FTS treated as terms, без расхождений.
 *
 * Tokens with NO letter/number at all («—», «→», «…», lone emoji) are dropped:
 * unicode61 tokenises such a quoted phrase into ZERO terms, and in FTS5 a
 * zero-term phrase matches zero rows — one stray «—» (routine in Russian
 * queries and in this vault's own «Фаза — X» naming) would AND the whole
 * MATCH query down to empty. A token that merely CONTAINS a separator
 * («Фаза—MVP») is kept: FTS treats it as an adjacent-tokens phrase, which
 * still matches.
 */
export function queryTokens(query: string): string[] {
  return query
    .replace(/[\x00-\x1f]/g, " ")
    .replace(/["(){}[\]:!^~@#$%&|\\<>=+;,./\-]/g, " ")
    .trim()
    .split(/\s+/)
    .filter((token) => /[\p{L}\p{N}]/u.test(token));
}

export function escapeFtsQuery(query: string): string {
  return queryTokens(query)
    .map((token) => `"${token}"*`)
    .join(" ");
}
