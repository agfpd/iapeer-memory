/**
 * Deterministic archiving — lean §2.2a.
 *
 * In lean, archiving leaves the Index overlay and becomes BASE (0 LLM): a
 * note whose `status` is a FINAL token (`isStale` — устарело/завершён/…; «на
 * паузе» is PENDING, not stale → a resumable note is never archived) is moved
 * to the archive folder by memoryd. The decision is taxonomy, not judgement.
 *
 * Wikilinks resolve by TITLE, so the graph survives the move (edges are
 * reindexed); the archive is NOT excluded from search (it stays findable with
 * the stale boost). The move is flat (`07_Archive/<basename>`), collisions
 * resolved with a numeric suffix.
 */

import { isStale, type TaxonomyPreset } from "./taxonomy.js";

/** First path segment of a vault-relative path. */
function firstSegment(relPath: string): string {
  return relPath.split(/[\\/]/)[0] ?? "";
}

/**
 * Folders whose notes are subject to archiving — UNIFIED rule, no exceptions
 * (§2.2a): the six monitored content folders (five
 * canonical permanent + agent memory + `03_Projects`). NOT the archive
 * itself or the system folder. A completed phase/project
 * (status `completed`/`cancelled`) is stale like any other note and moves to
 * the archive; active `03_Projects` then shows only live work. Wikilinks
 * survive by title; the archive stays searchable.
 */
export function isArchivableZone(relPath: string, taxonomy: TaxonomyPreset): boolean {
  const f = taxonomy.folders;
  const head = firstSegment(relPath);
  return (
    head === f.knowledge ||
    head === f.decisions ||
    head === f.projects ||
    head === f.ideas ||
    head === f.lists ||
    head === f.agentMemory
  );
}

/** Read `status` from a note's frontmatter (null when absent/no frontmatter). */
export function statusOf(content: string): string | null {
  const fm = /^---[^\S\n]*\n([\s\S]*?)\n---/.exec(content);
  if (!fm) return null;
  const m = /^status\s*:\s*(.+?)\s*$/m.exec(fm[1]);
  return m ? m[1].trim() : null;
}

/**
 * Should this note be archived? In an archivable content zone AND carrying a
 * final (stale) status. Notes already in the archive are excluded by
 * `isArchivableZone` (the archive folder is not in the set).
 */
export function shouldArchive(
  relPath: string,
  content: string,
  taxonomy: TaxonomyPreset,
): boolean {
  if (!isArchivableZone(relPath, taxonomy)) return false;
  return isStale(taxonomy, statusOf(content));
}

/**
 * Flat archive target (vault-relative): `<archive>/<basename>`, with a numeric
 * suffix on collision (`<stem>-2.md`, `-3.md`, …). `exists` answers whether a
 * vault-relative path is already taken.
 */
export function archiveTargetRel(
  basename: string,
  taxonomy: TaxonomyPreset,
  exists: (rel: string) => boolean,
): string {
  const arch = taxonomy.folders.archive;
  const isMd = basename.endsWith(".md");
  const stem = isMd ? basename.slice(0, -3) : basename;
  const ext = isMd ? ".md" : "";
  let candidate = `${arch}/${basename}`;
  let n = 2;
  while (exists(candidate)) {
    candidate = `${arch}/${stem}-${n}${ext}`;
    n += 1;
  }
  return candidate;
}
