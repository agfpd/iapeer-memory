/**
 * Human-edit detector — attribution of edits made OUTSIDE harness sessions
 * (external editors: Obsidian is one case, any editor works — нюанс 6: the
 * component is generic fs logic, nothing Obsidian-specific).
 *
 * TS port of the pure core of the reference
 * `scripts/mergemind-obsidian-watcher.cjs` (behavioural parity against
 * `tests/obsidian-watcher.test.ts`, 17 fixtures). In iapeer-memory this is
 * a memoryd SUBSYSTEM (ADR-004) — the daemon shell (fs.watch, debounce,
 * hash persistence) arrives with the memoryd stage; everything
 * load-bearing (the anti-loop decision core) lives here, pure.
 *
 * Canon folders (the five typed + project notes) — the human writes there
 * directly from an external editor:
 *   - `last_edited_by == human` AND `updated` fresh → echo of our own
 *     write — skip;
 *   - `last_edited_by` is an agent AND fresh → the post-write hook just
 *     ran — skip (the hook's zone);
 *   - otherwise → an external-editor edit: the shared `fillPermanentFull`
 *     completes a bare-body note and stamps `last_edited_by: <human>` +
 *     `updated` + `needs_review: true`.
 *
 * `freshEditWindowS` is CONFIG (the stage-7 review note): default 90s —
 * the reference VALUE IS 90 (bumped from the historical 30: second-
 * precision `updated` removed minute-truncation loss, while iCloud event
 * delivery can take tens of seconds under a sync storm; the asymmetry of
 * harm favours the larger window — a human edit inside the window
 * self-corrects on the next event, an agent placement mis-attributed as
 * human used to loop permanently).
 */

import crypto from "node:crypto";
import path from "node:path";
import type { TaxonomyPreset } from "./taxonomy.js";
import {
  fillPermanentFull,
  stripEmptyArrays,
  normalizeAllScalars,
  normalizeLinksBlock,
} from "./frontmatter-fill.js";
import { smartHash } from "./smart-hash.js";

export const DEFAULT_FRESH_EDIT_WINDOW_S = 90;

export function sha256(content: string): string {
  return crypto.createHash("sha256").update(content).digest("hex");
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** Second precision — symmetric with frontmatter-fill's writer stamp. */
export function formatStamp(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/**
 * Parse `updated` into ms. Strictly backward-compatible:
 * `YYYY-MM-DD HH:MM:SS` (current), `YYYY-MM-DD HH:MM` (legacy, SS=0),
 * `YYYY-MM-DD` (legacy date-only). Legacy formats are LOAD-BEARING:
 * without them every touched old note mis-attributes as a human edit.
 */
export function parseUpdated(s: string | null | undefined): number | null {
  if (!s) return null;
  const trimmed = s.trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(trimmed);
  if (m) {
    return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], m[6] ? +m[6] : 0).getTime();
  }
  m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed);
  if (m) {
    return new Date(+m[1], +m[2] - 1, +m[3]).getTime();
  }
  return null;
}

export function upsertField(fm: string, key: string, value: string): string {
  const re = new RegExp(`^${key}\\s*:.*$`, "m");
  if (re.test(fm)) {
    return fm.replace(re, () => `${key}: ${value}`);
  }
  const tail = fm.endsWith("\n") ? "" : "\n";
  return `${fm}${tail}${key}: ${value}\n`;
}

export function setIfMissing(fm: string, key: string, value: string): string {
  const re = new RegExp(`^${key}\\s*:`, "m");
  if (re.test(fm)) return fm;
  const tail = fm.endsWith("\n") ? "" : "\n";
  return `${fm}${tail}${key}: ${value}\n`;
}

export type HumanEditZone = "permanent";

/** Zone of a file for the detector: permanent (the typed canon folders) /
 *  null. The human writes straight into canon from Obsidian — the write hook
 *  completes a bare-body note via fillPermanentFull. */
export function getZone(
  filepath: string,
  vault: string,
  taxonomy: TaxonomyPreset,
): HumanEditZone | null {
  const rel = path.relative(vault, filepath);
  const first = rel.split(path.sep)[0];
  const f = taxonomy.folders;
  if (
    first === f.knowledge ||
    first === f.decisions ||
    first === f.projects ||
    first === f.ideas ||
    first === f.lists
  ) {
    return "permanent";
  }
  return null;
}

export type DecideUpdateInput = {
  content: string;
  zone: HumanEditZone;
  human: string;
  nowMs: number;
  birthtimeMs: number;
  mtimeMs: number;
  basename: string;
  /** Absolute file path — the permanent branch derives the folder's genre
   *  (type/status) from it via the shared `fillPermanentFull` (lean §2.1). */
  path: string;
  /** Vault root — folder resolution for the genre lookup. */
  vault: string;
  lastHash: string | null;
  taxonomy: TaxonomyPreset;
  /** Config (default DEFAULT_FRESH_EDIT_WINDOW_S). */
  freshEditWindowS?: number;
  /** The note's SEMANTIC hash (smart-hash) as of the carried baseline — the
   *  permanent snapshot the memoryd shell maintains. When the current semantic
   *  hash equals it, the write changed ONLY service fields (a checkbox toggle,
   *  a service-only backfill) — not content — and must NOT be re-attributed or
   *  re-flagged (parity with silentEditPass, which already skips an unmoved
   *  semantic hash). Null = no baseline (skip the guard, legacy behaviour). */
  prevSmartHash?: string | null;
};

export type DecideUpdateResult =
  | { action: "skip"; recordHash: string | null; reason: string }
  | { action: "write"; newContent: string; recordHash: string; reason: string };

/**
 * The pure core: decides what to do from file content and context. No I/O,
 * no module state — all the load-bearing anti-loop logic is here.
 * `recordHash` is what the caller must store in its last-seen map
 * (null = leave untouched, parity with the reference).
 */
export function decideUpdate(input: DecideUpdateInput): DecideUpdateResult {
  const currentHash = sha256(input.content);
  const windowS = input.freshEditWindowS ?? DEFAULT_FRESH_EDIT_WINDOW_S;

  // Content-hash guard: an iCloud mtime-only event without a content change.
  if (input.lastHash === currentHash) {
    return { action: "skip", recordHash: null, reason: "content-unchanged" };
  }

  // Service-only guard (symmetry with silentEditPass): a write that moves the
  // full hash but NOT the semantic hash changed only service fields
  // (`last_edited_by`/`updated`/`needs_review` — excluded from smart-hash). That
  // is not a content edit: a checkbox toggle (a human clears needs_review in
  // Obsidian) or a service-only backfill must persist, never be re-attributed
  // to the human nor re-flagged. Without this humanEditPass reverted such edits
  // (forced `needs_review: true` + bumped `updated`) — the asymmetry that broke
  // the checkbox convention on canon. `recordHash` advances so the re-read of
  // our own no-op is a content-unchanged skip.
  if (input.prevSmartHash != null) {
    const curSmart = smartHash(new TextEncoder().encode(input.content));
    if (curSmart === input.prevSmartHash) {
      return { action: "skip", recordHash: currentHash, reason: "service-only" };
    }
  }

  const fmMatch = /^---[^\S\n]*\n([\s\S]*?)\n---[^\S\n]*(?:\n|$)/.exec(input.content);
  let fmBlock: string;
  let body: string;
  if (fmMatch) {
    fmBlock = fmMatch[1];
    body = input.content.slice(fmMatch[0].length);
  } else {
    // Bare body (no frontmatter) — both zones BUILD it now. In lean the write
    // hook must complete a human's bare canon note, not skip it (§2.2: «голое
    // тело человека хук записи должен ДОСТРОИТЬ»; the pre-lean «permanent-no-
    // frontmatter → skip» is removed — canon frontmatter is the write hook's
    // job now, not the Index's on placement).
    fmBlock = "";
    body = input.content;
  }

  const lebMatch = /^last_edited_by\s*:\s*(.+?)\s*$/m.exec(fmBlock);
  const updMatch = /^updated\s*:\s*(.+?)\s*$/m.exec(fmBlock);
  const currentLeb = lebMatch ? lebMatch[1].trim() : null;
  const currentUpd = updMatch ? updMatch[1].trim() : null;

  const editAt = parseUpdated(currentUpd);
  const isFresh = editAt !== null && (input.nowMs - editAt) / 1000 < windowS;

  // Case 1: our own echo — our write came back through the fs watch.
  if (currentLeb === input.human && isFresh) {
    return { action: "skip", recordHash: currentHash, reason: "echo-human" };
  }
  // Case 2: a fresh agent edit — the post-write hook just ran.
  if (currentLeb && currentLeb !== input.human && isFresh) {
    return { action: "skip", recordHash: currentHash, reason: "echo-agent" };
  }

  // Otherwise — an external-editor edit of a canon note. The SHARED write-hook
  // fill (mandate §2: identical to the hook path). Existing notes: stamp-only
  // no-op on the constants; a human's bare-body canon note: full frontmatter
  // (title/type-from-folder/status/created/author). `created` ← birthtime
  // (file creation, not edit time).
  const nowStamp = formatStamp(new Date(input.nowMs));
  const createdSource =
    input.birthtimeMs > 0 ? new Date(input.birthtimeMs) : new Date(input.mtimeMs);
  // LOCAL date (symmetric with the hook path's localDateIso) — `.toISOString()`
  // is UTC and would shift `created` by a day for early-local-time creations.
  const createdDate = `${createdSource.getFullYear()}-${pad(createdSource.getMonth() + 1)}-${pad(createdSource.getDate())}`;
  let newFm = fillPermanentFull(fmBlock, {
    path: input.path,
    agent: input.human,
    vault: input.vault,
    today: createdDate,
    nowStamp,
    ctx: { taxonomy: input.taxonomy },
  });

  if (newFm === fmBlock) {
    return { action: "skip", recordHash: currentHash, reason: "noop" };
  }

  // Mirror the hook path's normalization (mandate §2: the write hook is IDENTICAL on
  // both paths) — YAML-safety on every scalar + ## Связи structural validity, so
  // a human's colon-bearing scalar never produces unparseable YAML that silently
  // drops the note from the index.
  newFm = normalizeAllScalars(stripEmptyArrays(newFm));
  const newBody = normalizeLinksBlock(body, input.taxonomy);
  const fmTail = newFm.endsWith("\n") ? "" : "\n";
  const bodyPrefix = newBody.startsWith("\n") ? "" : "\n";
  const newContent = `---\n${newFm}${fmTail}---${bodyPrefix}${newBody}`;
  return {
    action: "write",
    newContent,
    recordHash: sha256(newContent),
    reason: "stamp",
  };
}
