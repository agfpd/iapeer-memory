import { describe, it, expect } from "bun:test";
import {
  isSilentEdit,
  readStampRecord,
  restampUnstamped,
  setNeedsReviewFalse,
  UNSTAMPED_TOKEN,
  type StampRecord,
} from "../src/silent-edit-detect.js";
import { formatStamp } from "../src/human-edit-detect.js";
import { smartHash } from "../src/smart-hash.js";

// The boris precedent verbatim (design §1): a canon note stamped by the
// index at 10:51:33; a Bash-heredoc body edit lands 52 s later — inside
// the 90 s echo window, stamp untouched.
const NOW = new Date("2026-06-11T10:52:25").getTime();
const STAMP = "2026-06-11 10:51:33"; // 52 s before NOW — fresh
const STALE_STAMP = "2026-06-11 10:40:00"; // far outside the window

function note(body: string, opts?: { leb?: string; updated?: string }): string {
  return [
    "---",
    "title: Тест",
    `last_edited_by: ${opts?.leb ?? "index"}`,
    `updated: ${opts?.updated ?? STAMP}`,
    "---",
    "",
    body,
  ].join("\n");
}

describe("readStampRecord", () => {
  it("reads the stamp pair + the semantic hash", () => {
    const r = readStampRecord(note("body"));
    expect(r.leb).toBe("index");
    expect(r.updated).toBe(STAMP);
    expect(r.hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("no frontmatter → null stamps, hash still present", () => {
    const r = readStampRecord("bare body\n");
    expect(r.leb).toBeNull();
    expect(r.updated).toBeNull();
    expect(r.hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("service-only difference yields the SAME semantic hash (smart-hash blindness = echo safety)", () => {
    const a = readStampRecord(note("same body"));
    const b = readStampRecord(note("same body", { leb: "boris", updated: STALE_STAMP }));
    expect(a.hash).toBe(b.hash);
  });
});

describe("isSilentEdit — the zoned rule (design §3)", () => {
  const prev = readStampRecord(note("original body"));

  it("THE PRECEDENT: body moved, stamp stood, 52 s window, permanent → SILENT", () => {
    const curr = readStampRecord(note("edited body — silent Bash write"));
    expect(isSilentEdit({ prev, curr, nowMs: NOW })).toBe(true);
  });

  it("hook echo: service-only change → semantic hash still → NOT silent", () => {
    const curr = readStampRecord(note("original body", { leb: "boris", updated: STALE_STAMP }));
    // same semantic hash as prev — BASE fails before stamps are even compared
    expect(curr.hash).toBe(prev.hash);
    expect(isSilentEdit({ prev, curr, nowMs: NOW })).toBe(false);
  });

  it("mtime-only event: identical content → NOT silent (iCloud echo class)", () => {
    const curr = readStampRecord(note("original body"));
    expect(isSilentEdit({ prev, curr, nowMs: NOW })).toBe(false);
  });

  it("honest stamped write: body AND stamp moved → NOT silent", () => {
    const curr = readStampRecord(
      note("edited body", { leb: "boris", updated: formatStamp(new Date(NOW)) }),
    );
    expect(isSilentEdit({ prev, curr, nowMs: NOW })).toBe(false);
  });

  it("permanent + STALE standing stamp → NOT silent (humanEditPass territory — the Obsidian case keeps its human attribution)", () => {
    const stalePrev = readStampRecord(note("original body", { updated: STALE_STAMP }));
    const curr = readStampRecord(note("edited body", { updated: STALE_STAMP }));
    expect(isSilentEdit({ prev: stalePrev, curr, nowMs: NOW })).toBe(false);
  });

  it("permanent with NO stamp at all (updated null) → not silent (nothing to be fresh against)", () => {
    const p = readStampRecord("---\ntitle: x\n---\nbody a\n");
    const c = readStampRecord("---\ntitle: x\n---\nbody b\n");
    expect(isSilentEdit({ prev: p, curr: c, nowMs: NOW })).toBe(false);
  });
});

describe("restampUnstamped — the response", () => {
  it("re-stamps leb/updated/needs_review, body untouched", () => {
    const out = restampUnstamped(note("the body survives"), NOW)!;
    expect(out).toContain(`last_edited_by: ${UNSTAMPED_TOKEN}`);
    expect(out).toContain(`updated: ${formatStamp(new Date(NOW))}`);
    expect(out).toContain("needs_review: true");
    expect(out).toContain("the body survives");
    expect(out).toContain("title: Тест"); // foreign fm fields intact
  });

  it("no frontmatter → null (a bare draft is the fill machinery's job)", () => {
    expect(restampUnstamped("bare body\n", NOW)).toBeNull();
  });

  it("NO LOOP by construction: the re-stamp is service-only (hash still) and moves the stamp", () => {
    const original = note("silently edited");
    const restamped = restampUnstamped(original, NOW)!;
    const before: StampRecord = readStampRecord(original);
    const after: StampRecord = readStampRecord(restamped);
    expect(after.hash).toBe(before.hash); // semantic hash untouched
    // next pass: prev=after, curr=after → identical → never silent again
    expect(isSilentEdit({ prev: after, curr: after, nowMs: NOW })).toBe(false);
    // and even vs the pre-restamp record the stamp HAS moved → not silent
    expect(
      isSilentEdit({ prev: before, curr: after, nowMs: NOW }),
    ).toBe(false);
  });
});

describe("setNeedsReviewFalse — needs_review closure auto-clear", () => {
  it("flips true → false IN PLACE, leb/updated untouched, semantic hash unmoved", () => {
    const original = note("the body is curation work", { leb: "index" });
    const withFlag = original.replace("---\n\n", "needs_review: true\n---\n\n");
    const cleared = setNeedsReviewFalse(withFlag)!;
    expect(cleared).toContain("needs_review: false");
    expect(cleared).not.toContain("needs_review: true");
    expect(cleared).toContain("last_edited_by: index"); // service stamp preserved
    expect(cleared).toContain(`updated: ${STAMP}`); // not bumped
    // service-field-only → semantic hash unchanged → echo-safe
    expect(smartHash(new TextEncoder().encode(cleared))).toBe(
      smartHash(new TextEncoder().encode(withFlag)),
    );
  });

  it("no needs_review line → null (nothing to clear)", () => {
    expect(setNeedsReviewFalse(note("body"))).toBeNull();
  });

  it("already false → null (no redundant write)", () => {
    const already = note("body").replace("---\n\n", "needs_review: false\n---\n\n");
    expect(setNeedsReviewFalse(already)).toBeNull();
  });

  it("no frontmatter → null", () => {
    expect(setNeedsReviewFalse("bare body\n")).toBeNull();
  });
});
