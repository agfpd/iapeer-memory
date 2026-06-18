/**
 * Permanent-change detector core — a memoryd subsystem (ADR-004).
 *
 * Carries over the detection SEMANTICS of the reference
 * `mergemind-permanent-monitor.sh` (a bash poll loop; no direct unit
 * fixtures existed — the load-bearing part, the smart hash, is ported and
 * tested in `smart-hash.ts`):
 *
 * - watches the SIX permanent folders (five canonical + agent memory),
 *   recursively; the archive is deliberately ignored (frozen notes);
 * - compares by the sha256 of the SEMANTIC part of each file (frontmatter
 *   minus service fields + body, `smart-hash.ts`) — NOT raw bytes, NOT
 *   mtime. This kills both noisy-event classes: iCloud mtime-only syncs
 *   and the hook-induced loop (service-field re-stamps are invisible);
 * - deletions are ignored (an archive move by the Index, not a change);
 * - events are COALESCED (ADR-004): one diff pass yields ONE event
 *   carrying the list of changed paths, not N wake-ups.
 *
 * The fs-watch/debounce shell and the stdout signal line belong to the
 * memoryd daemon stage; this module is the pure snapshot/diff core.
 */

import fs from "node:fs";
import path from "node:path";
import { hashFile } from "./smart-hash.js";
import type { TaxonomyPreset } from "./taxonomy.js";

/** rel path → smart hash. */
export type VaultSnapshot = Map<string, string>;

function* walkMdFiles(dir: string): Generator<string> {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) yield* walkMdFiles(full);
    else if (e.isFile() && e.name.endsWith(".md")) yield full;
  }
}

/** The six monitored folders (five canonical + agent memory). */
export function monitoredFolders(taxonomy: TaxonomyPreset): string[] {
  const f = taxonomy.folders;
  return [f.knowledge, f.decisions, f.projects, f.ideas, f.lists, f.agentMemory];
}

/**
 * Snapshot the monitored folders: rel path → smart hash. Unreadable files
 * are skipped silently (parity with the hash helper's CLI contract).
 */
export function snapshotVault(vault: string, taxonomy: TaxonomyPreset): VaultSnapshot {
  const snapshot: VaultSnapshot = new Map();
  for (const folder of monitoredFolders(taxonomy)) {
    for (const filePath of walkMdFiles(path.join(vault, folder))) {
      const h = hashFile(filePath);
      if (h) snapshot.set(path.relative(vault, filePath), h);
    }
  }
  return snapshot;
}

const FM_BLOCK_RE = /^---[^\S\n]*\n([\s\S]*?)\n---/;

/**
 * The curation QUEUE (needs_review closure, Release 3): rel paths of monitored
 * notes carrying `needs_review: true`. This — not the smart-hash diff — is the
 * curator's work-set: a note stays in the queue until the flag is cleared
 * (self-returning), so the cycle closes in code, not on LLM discipline. Scanned
 * from frontmatter (not a DB column) — zero schema migration, no dependency on
 * the dormant parser-reparse trigger. Sorted; unreadable files skipped.
 */
export function collectNeedsReview(vault: string, taxonomy: TaxonomyPreset): string[] {
  const out: string[] = [];
  for (const folder of monitoredFolders(taxonomy)) {
    for (const filePath of walkMdFiles(path.join(vault, folder))) {
      let content: string;
      try {
        content = fs.readFileSync(filePath, "utf-8");
      } catch {
        continue;
      }
      const fm = FM_BLOCK_RE.exec(content);
      if (!fm) continue;
      const m = /^needs_review\s*:\s*(\S+)/m.exec(fm[1]);
      if (m && m[1].replace(/#.*$/, "").trim() === "true") {
        out.push(path.relative(vault, filePath));
      }
    }
  }
  return out.sort();
}

/**
 * Semantic diff of two snapshots: added or changed paths, sorted.
 * Deletions are ignored by design.
 */
export function diffSnapshots(prev: VaultSnapshot, next: VaultSnapshot): string[] {
  const changed: string[] = [];
  for (const [rel, hash] of next) {
    if (prev.get(rel) !== hash) changed.push(rel);
  }
  return changed.sort();
}

// The daemon coalesces a detection pass into ONE batch event (CURATOR_TICK)
// by diffing `snapshotVault` against the carried baseline directly — see
// `runCuratorTick` in memoryd.ts. The earlier per-line event helper was
// vestigial and removed with the inbox pipeline.
