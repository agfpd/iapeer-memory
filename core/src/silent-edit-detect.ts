/**
 * Silent-edit detector — the unstamped-write belt
 * (docs/_planning/UNSTAMPED_EDIT_DETECTOR_DESIGN.md;
 * precedent: the Index's catch — a Bash-heredoc edit of a canon
 * note 52 s after a curator stamp was swallowed FOREVER by the human-edit
 * echo window, masquerading as the curator for the source filters).
 *
 * A vault write that bypasses the PostToolUse hook (Bash, python-heredoc,
 * any non-Write/Edit tool) leaves the stamp untouched. The discriminator
 * is the SEMANTIC hash (smart-hash: frontmatter minus service fields +
 * body) — the battle-proven anti-echo of permanent-detect: a hook echo
 * changes ONLY service fields (semantic hash still), a silent edit moves
 * the semantic hash while the stamp stands still. The same property makes
 * our response re-stamp echo-safe BY CONSTRUCTION: a re-stamp touches only
 * service fields, so it never re-triggers the detector or the batch diffs.
 *
 * ZONED rule (the humanEditPass intersection, §3a of the design): the canon
 * folders (five typed + project notes + agent memory) — ONLY the fresh-window
 * case (stamp ≤ FRESH_EDIT_WINDOW_S): that is exactly the echo-window swallow;
 * STALE cases stay with humanEditPass (human attribution — the Obsidian main
 * case; a wider rule would regress «человек правит кураторскую заметку»).
 *
 * Attribution token: `unstamped` — NEUTRAL on purpose (the mechanism
 * cannot tell a Bash agent from a human outside Obsidian; a false «agent»
 * on the human's edit is worse than an honest «don't know» — the
 * author-guard symmetry: a visible anomaly beats a silently assigned
 * identity). The Index resolves it by context; needs_review rides along.
 *
 * Pure decision core — no I/O; the memoryd shell owns reading, the atomic
 * write and the persisted stamp baseline (first-sight warm-up: a file
 * without a baseline record is recorded, never judged — the 0.1.8 guard).
 */

import {
  formatStamp,
  parseUpdated,
  upsertField,
  DEFAULT_FRESH_EDIT_WINDOW_S,
} from "./human-edit-detect.js";
import { smartHash } from "./smart-hash.js";

export const UNSTAMPED_TOKEN = "unstamped";

export type SilentZone = "permanent";

/** The per-file baseline record (design §4): the SEMANTIC hash (the BASE
 *  precondition — without it an iCloud mtime-echo inside the fresh window
 *  would false-trigger a re-stamp on identical content) + the stamp pair
 *  compared verbatim between passes. */
export type StampRecord = {
  hash: string;
  updated: string | null;
  leb: string | null;
};

const FM_RE = /^---[^\S\n]*\n([\s\S]*?)\n---[^\S\n]*(?:\n|$)/;

/** Read the baseline record from note content. No frontmatter → null stamps. */
export function readStampRecord(content: string): StampRecord {
  const fm = FM_RE.exec(content);
  const hash = smartHash(new TextEncoder().encode(content));
  if (!fm) return { hash, updated: null, leb: null };
  const upd = /^updated\s*:\s*(.+?)\s*$/m.exec(fm[1]);
  const leb = /^last_edited_by\s*:\s*(.+?)\s*$/m.exec(fm[1]);
  return {
    hash,
    updated: upd ? upd[1].trim() : null,
    leb: leb ? leb[1].trim() : null,
  };
}

export type DecideSilentInput = {
  /** Baseline record (the PREVIOUS pass). */
  prev: StampRecord;
  curr: StampRecord;
  nowMs: number;
  freshEditWindowS?: number;
};

/**
 * BASE: the semantic hash MOVED ∧ the stamp pair did not move verbatim,
 * and only when the standing stamp is FRESH (the echo-window swallow). A
 * service-only change (hook echo, our own re-stamp) keeps the semantic hash
 * still → never silent; an mtime-only event keeps content identical → never
 * silent.
 */
export function isSilentEdit(input: DecideSilentInput): boolean {
  if (input.prev.hash === input.curr.hash) return false; // BASE: no semantic move
  const stampUnmoved =
    input.prev.updated === input.curr.updated && input.prev.leb === input.curr.leb;
  if (!stampUnmoved) return false;
  const windowS = input.freshEditWindowS ?? DEFAULT_FRESH_EDIT_WINDOW_S;
  const editAt = parseUpdated(input.curr.updated);
  return editAt !== null && (input.nowMs - editAt) / 1000 < windowS;
}

/**
 * The response re-stamp: `last_edited_by: unstamped` + fresh `updated` +
 * `needs_review: true`. Content without frontmatter → null (a bare draft
 * is the fill machinery's job, not ours).
 *
 * SURGICAL splice: only the captured frontmatter block is replaced — the
 * rest of the file (the `---` fences, the blank line after them, the body)
 * stays byte-exact. That is what makes the re-stamp service-fields-only
 * and therefore echo-safe (a reassembly once ate the post-fence blank
 * line, moved the semantic hash and broke the no-loop property — caught
 * by the test, fixed by construction).
 */
export function restampUnstamped(content: string, nowMs: number): string | null {
  const fm = FM_RE.exec(content);
  if (!fm) return null;
  let block = fm[1];
  block = upsertField(block, "last_edited_by", UNSTAMPED_TOKEN);
  block = upsertField(block, "updated", formatStamp(new Date(nowMs)));
  block = upsertField(block, "needs_review", "true");
  block = block.replace(/\n$/, ""); // the capture carries no trailing \n
  const blockStart = fm[0].indexOf("\n") + 1; // right after the opening fence line
  const blockEnd = blockStart + fm[1].length;
  return content.slice(0, blockStart) + block + content.slice(blockEnd);
}

/**
 * Auto-clear (needs_review closure, Release 3): set `needs_review: false`
 * IN PLACE — service-field-only, touching neither `last_edited_by`/`updated`
 * (the curator's attribution stamp from the hook stays) nor the field's
 * position. The SAME surgical splice as restampUnstamped (only the captured
 * frontmatter block is rewritten), so the semantic hash does not move and the
 * write is echo-safe. Returns null when there is no frontmatter, no
 * `needs_review` line, or the value is already `false` (nothing to do).
 */
export function setNeedsReviewFalse(content: string): string | null {
  const fm = FM_RE.exec(content);
  if (!fm) return null;
  if (!/^needs_review\s*:/m.test(fm[1])) return null;
  let block = upsertField(fm[1], "needs_review", "false");
  block = block.replace(/\n$/, "");
  const blockStart = fm[0].indexOf("\n") + 1;
  const blockEnd = blockStart + fm[1].length;
  const out = content.slice(0, blockStart) + block + content.slice(blockEnd);
  return out === content ? null : out;
}
