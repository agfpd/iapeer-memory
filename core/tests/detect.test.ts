/**
 * Tests for the memoryd detect subsystems (stage 8):
 * - human-edit-detect — translation of the reference
 *   `tests/obsidian-watcher.test.ts` (17 fixtures);
 * - tags-mirror — translation of `tests/tags-mirror.test.ts` (6 fixtures,
 *   the constants fixture became taxonomy-driven for both locales);
 * - permanent-detect — NEW tests (the reference monitor was an untested
 *   bash loop; its load-bearing smart hash is covered in smart-hash.test);
 * - the stage acceptance smoke (human edit → event; fresh agent edit →
 *   no event; service-field-only change → no event).
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  sha256,
  formatStamp,
  parseUpdated,
  upsertField,
  setIfMissing,
  getZone,
  decideUpdate,
  DEFAULT_FRESH_EDIT_WINDOW_S,
  type DecideUpdateInput,
} from "../src/human-edit-detect.js";
import { smartHash } from "../src/smart-hash.js";
import { decideMirror, tagsDictionarySourceRel } from "../src/tags-mirror.js";
import {
  snapshotVault,
  diffSnapshots,
  collectNeedsReview,
} from "../src/permanent-detect.js";
import { processFile } from "../src/frontmatter-fill.js";
import { TAXONOMY_RU, TAXONOMY_EN } from "../src/taxonomy.js";

const HUMAN = "artur";
// Local time → formatStamp round-trips through parseUpdated exactly.
const NOW = new Date(2026, 4, 15, 12, 30, 20, 0).getTime();
const FRESH_UPD = formatStamp(new Date(NOW));
const STALE_UPD = formatStamp(new Date(NOW - 120_000)); // 120s > 90s window
const LEGACY_FRESH_UPD = "2026-05-15 12:30"; // 20s back, minute precision

function decide(over: Partial<DecideUpdateInput>) {
  return decideUpdate({
    content: "",
    zone: "permanent",
    human: HUMAN,
    nowMs: NOW,
    birthtimeMs: Date.UTC(2026, 0, 2, 0, 0, 0),
    mtimeMs: Date.UTC(2026, 2, 3, 0, 0, 0),
    basename: "Заметка.md",
    path: "/vault/01_Знания/Заметка.md",
    vault: "/vault",
    lastHash: null,
    taxonomy: TAXONOMY_RU,
    ...over,
  });
}

describe("human-edit-detect: service-only guard (smart-hash symmetry)", () => {
  // A write that moves the full hash but NOT the semantic hash changed only
  // service fields (checkbox toggle / service backfill) — humanEditPass must
  // skip it (no revert, no bump), in parity with silentEditPass.
  const sh = (s: string) => smartHash(new TextEncoder().encode(s));

  it("service-only change (smart-hash unchanged) → skip 'service-only'", () => {
    const content = `---\ntitle: X\nstatus: актуально\nauthor: boris\nlast_edited_by: boris\nupdated: ${STALE_UPD}\nneeds_review: false\n---\n\nbody`;
    const r = decide({ content, lastHash: "stale-full-hash", prevSmartHash: sh(content) });
    expect(r.action).toBe("skip");
    expect(r.reason).toBe("service-only");
  });

  it("content change (smart-hash moved) → NOT masked, still a write", () => {
    const prev = sh(`---\ntitle: X\nstatus: актуально\nauthor: boris\n---\n\nOLD body`);
    const content = `---\ntitle: X\nstatus: актуально\nauthor: boris\nlast_edited_by: boris\nupdated: ${STALE_UPD}\n---\n\nNEW body`;
    const r = decide({ content, lastHash: "stale-full-hash", prevSmartHash: prev });
    expect(r.action).toBe("write");
  });

  it("no baseline (prevSmartHash null) → legacy behaviour, guard inert", () => {
    const content = `---\ntitle: X\nstatus: актуально\nauthor: boris\nlast_edited_by: boris\nupdated: ${STALE_UPD}\nneeds_review: false\n---\n\nbody`;
    const r = decide({ content, lastHash: "stale-full-hash", prevSmartHash: null });
    expect(r.reason).not.toBe("service-only");
  });
});

describe("human-edit-detect: pure helpers", () => {
  it("parseUpdated accepts seconds + legacy minute + legacy date, rejects junk", () => {
    expect(parseUpdated("2026-05-15 12:30:45")).toBe(
      new Date(2026, 4, 15, 12, 30, 45).getTime(),
    );
    expect(parseUpdated("2026-05-15 12:30")).toBe(
      new Date(2026, 4, 15, 12, 30, 0).getTime(),
    );
    expect(parseUpdated("2026-05-15")).toBe(new Date(2026, 4, 15).getTime());
    expect(parseUpdated("")).toBeNull();
    expect(parseUpdated(null)).toBeNull();
    expect(parseUpdated("not a date")).toBeNull();
    expect(parseUpdated("2026-05-15 12:30:99extra")).toBeNull();
  });

  it("upsertField replaces existing, appends when missing", () => {
    expect(upsertField("a: 1\nb: 2", "a", "9")).toBe("a: 9\nb: 2");
    expect(upsertField("a: 1", "c", "3")).toBe("a: 1\nc: 3\n");
    expect(upsertField("", "x", "y")).toBe("\nx: y\n");
  });

  it("setIfMissing keeps existing, adds when absent", () => {
    expect(setIfMissing("title: keep", "title", "new")).toBe("title: keep");
    expect(setIfMissing("a: 1", "title", "T")).toBe("a: 1\ntitle: T\n");
  });

  it("getZone maps folders correctly (taxonomy-driven, both locales)", () => {
    for (const T of [TAXONOMY_RU, TAXONOMY_EN]) {
      const v = "/vault";
      expect(getZone(`/vault/${T.folders.knowledge}/x.md`, v, T)).toBe("permanent");
      expect(getZone(`/vault/${T.folders.decisions}/x.md`, v, T)).toBe("permanent");
      expect(getZone(`/vault/${T.folders.agentMemory}/b/x.md`, v, T)).toBeNull();
      expect(getZone(`/vault/${T.folders.system}/x.md`, v, T)).toBeNull();
    }
  });
});

describe("human-edit-detect: skip paths (anti-loop, load-bearing)", () => {
  it("content-unchanged: lastHash === current → skip, hash untouched", () => {
    const content = "---\ntitle: X\n---\n\nbody";
    const r = decide({ content, lastHash: sha256(content) });
    expect(r.action).toBe("skip");
    expect(r.reason).toBe("content-unchanged");
    expect(r.recordHash).toBeNull();
  });

  it("permanent without frontmatter → BUILT, not skipped (lean §2.2)", () => {
    // The guard completes a human's bare-body canon note instead of skipping
    // it — canon frontmatter is the guard's job in lean, not the Index's.
    const r = decide({ content: "no frontmatter here", zone: "permanent" });
    expect(r.action).toBe("write");
    if (r.action !== "write") throw new Error("unreachable");
    expect(r.newContent).toContain("title: Заметка");
    expect(r.newContent).toContain(`type: ${TAXONOMY_RU.types.knowledge}`); // folder → genre
    expect(r.newContent).toContain("status: актуально"); // knowledge initial
    expect(r.newContent).toContain(`author: ${HUMAN}`);
    expect(r.newContent).toContain("needs_review: true");
    expect(r.newContent).toContain(`last_edited_by: ${HUMAN}`);
    expect(r.newContent).toContain("no frontmatter here"); // body preserved
    expect(r.recordHash).toBe(sha256(r.newContent));
  });

  it("echo from human (fresh) → skip, record current hash", () => {
    const content = `---\ntitle: X\nlast_edited_by: ${HUMAN}\nupdated: ${FRESH_UPD}\n---\n\nbody`;
    const r = decide({ content });
    expect(r.action).toBe("skip");
    expect(r.reason).toBe("echo-human");
    expect(r.recordHash).toBe(sha256(content));
  });

  it("echo from an agent (fresh) → skip (hook just ran)", () => {
    const content = `---\ntitle: X\nlast_edited_by: boris\nupdated: ${FRESH_UPD}\n---\n\nbody`;
    const r = decide({ content });
    expect(r.action).toBe("skip");
    expect(r.reason).toBe("echo-agent");
  });

  it("NOT an echo when updated is stale → proceeds to write", () => {
    const content = `---\ntitle: X\nlast_edited_by: boris\nupdated: ${STALE_UPD}\n---\n\nbody`;
    expect(decide({ content }).action).toBe("write");
  });

  it("BACKWARD-COMPAT: legacy minute-precision updated (fresh) still echo-suppressed", () => {
    const content = `---\ntitle: X\nlast_edited_by: boris\nupdated: ${LEGACY_FRESH_UPD}\n---\n\nbody`;
    const r = decide({ content });
    expect(r.action).toBe("skip");
    expect(r.reason).toBe("echo-agent");
  });

  it("window (default 90s, FACT of the reference): 80s ago → echo; 100s ago → write; config shrinks it", () => {
    expect(DEFAULT_FRESH_EDIT_WINDOW_S).toBe(90);
    const within = formatStamp(new Date(NOW - 80_000));
    const beyond = formatStamp(new Date(NOW - 100_000));
    const mk = (u: string) =>
      `---\ntitle: X\nlast_edited_by: boris\nupdated: ${u}\n---\n\nbody`;
    expect(decide({ content: mk(within) }).action).toBe("skip");
    expect(decide({ content: mk(within) }).reason).toBe("echo-agent");
    expect(decide({ content: mk(beyond) }).action).toBe("write");
    // The window is CONFIG (stage-7 review note): 30s window → 80s is stale.
    expect(decide({ content: mk(within), freshEditWindowS: 30 }).action).toBe("write");
  });

});

describe("human-edit-detect: write paths", () => {
  it("permanent stamp: last_edited_by/updated/needs_review, body preserved", () => {
    const content = `---\ntitle: X\nauthor: boris\n---\n\n## Связи\n\n---\n\n# Тело`;
    const r = decide({ content, zone: "permanent" });
    expect(r.action).toBe("write");
    expect(r.reason).toBe("stamp");
    if (r.action !== "write") throw new Error("unreachable");
    expect(r.newContent).toContain(`last_edited_by: ${HUMAN}`);
    expect(r.newContent).toContain(`updated: ${formatStamp(new Date(NOW))}`);
    expect(r.newContent).toContain("needs_review: true");
    expect(r.newContent).toContain("# Тело");
    expect(r.newContent).toContain("author: boris");
    expect(r.recordHash).toBe(sha256(r.newContent));
  });

  it("permanent fill of a human's bare-body canon note: title/type/status/author/created", () => {
    const r = decide({
      content: "Просто текст без шапки",
      zone: "permanent",
      basename: "Моя идея.md",
      path: "/vault/01_Знания/Моя идея.md",
      birthtimeMs: Date.UTC(2026, 0, 2),
      mtimeMs: Date.UTC(2026, 5, 9),
    });
    expect(r.action).toBe("write");
    expect(r.reason).toBe("stamp");
    if (r.action !== "write") throw new Error("unreachable");
    expect(r.newContent).toContain("title: Моя идея");
    expect(r.newContent).toContain("type: знание"); // type from folder
    expect(r.newContent).toContain("status: актуально"); // knowledge initial status
    expect(r.newContent).toContain("created: 2026-01-02"); // birthtime wins
    expect(r.newContent).toContain(`author: ${HUMAN}`);
    expect(r.newContent).toContain("Просто текст без шапки");
    expect(r.newContent.startsWith("---\n")).toBe(true);
  });

  it("permanent fill keeps an existing author (setIfMissing)", () => {
    const content = `---\nauthor: someoneElse\n---\nтело`;
    const r = decide({
      content,
      zone: "permanent",
      basename: "N.md",
      path: "/vault/01_Знания/N.md",
    });
    expect(r.action).toBe("write");
    if (r.action !== "write") throw new Error("unreachable");
    expect(r.newContent).toContain("author: someoneElse");
    expect(r.newContent).toContain("title: N");
  });

  it("created falls back to mtime when birthtime is 0", () => {
    const r = decide({
      content: "x",
      zone: "permanent",
      basename: "n.md",
      path: "/vault/01_Знания/n.md",
      birthtimeMs: 0,
      mtimeMs: Date.UTC(2026, 6, 20),
    });
    if (r.action !== "write") throw new Error("expected write");
    expect(r.newContent).toContain("created: 2026-07-20");
  });

  it("permanent stamp overwrites a stale last_edited_by/updated", () => {
    const content = `---\nlast_edited_by: oldagent\nupdated: ${STALE_UPD}\n---\n\nтело`;
    const r = decide({ content, zone: "permanent" });
    expect(r.action).toBe("write");
    if (r.action !== "write") throw new Error("unreachable");
    expect(r.newContent).toContain(`last_edited_by: ${HUMAN}`);
    expect(r.newContent).not.toContain("last_edited_by: oldagent");
    expect(r.newContent).not.toContain(STALE_UPD);
  });

  it("EN locale: permanent fill emits the folder's initial status", () => {
    const r = decide({
      content: "plain body",
      zone: "permanent",
      basename: "Idea.md",
      path: "/vault/01_Knowledge/Idea.md",
      taxonomy: TAXONOMY_EN,
    });
    if (r.action !== "write") throw new Error("expected write");
    expect(r.newContent).toContain("status: current"); // knowledge initial status (EN)
  });
});

// ── tags-mirror ──────────────────────────────────────────────────────────────

describe("tags-mirror decideMirror", () => {
  it("source unreadable (null) → skip, never clobbers mirror", () => {
    expect(decideMirror({ srcContent: null, mirrorContent: "dict" })).toEqual({
      action: "skip",
      reason: "source-unreadable",
    });
    expect(decideMirror({ srcContent: null, mirrorContent: null })).toEqual({
      action: "skip",
      reason: "source-unreadable",
    });
  });

  it("LOAD-BEARING: empty/whitespace source never overwrites a populated mirror", () => {
    expect(decideMirror({ srcContent: "", mirrorContent: "real dictionary" })).toEqual({
      action: "skip",
      reason: "source-empty-keep-mirror",
    });
    expect(decideMirror({ srcContent: "   \n\t  \n", mirrorContent: "real dict" })).toEqual({
      action: "skip",
      reason: "source-empty-keep-mirror",
    });
    expect(decideMirror({ srcContent: "", mirrorContent: null })).toEqual({
      action: "skip",
      reason: "source-empty-keep-mirror",
    });
  });

  it("identical content → skip (no churn)", () => {
    const dict = "# Словарь тегов\n\n- инфраструктура\n";
    expect(decideMirror({ srcContent: dict, mirrorContent: dict })).toEqual({
      action: "skip",
      reason: "identical",
    });
  });

  it("changed content → write", () => {
    expect(decideMirror({ srcContent: "v2 dict", mirrorContent: "v1 dict" })).toEqual({
      action: "write",
      reason: "changed",
    });
  });

  it("mirror absent but source non-empty → write (first materialisation)", () => {
    expect(decideMirror({ srcContent: "fresh dict", mirrorContent: null })).toEqual({
      action: "write",
      reason: "mirror-absent",
    });
  });

  it("dictionary source path is taxonomy-driven (both locales)", () => {
    expect(tagsDictionarySourceRel(TAXONOMY_RU)).toBe("99_Система/Теги.md");
    expect(tagsDictionarySourceRel(TAXONOMY_EN)).toBe("99_System/Tags.md");
  });
});

// ── permanent-detect ─────────────────────────────────────────────────────────

describe("permanent-detect (smart-hash diff, coalesced)", () => {
  let tmpdir: string;
  let vault: string;

  beforeEach(() => {
    tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), "iapeer-memory-det-"));
    vault = path.join(tmpdir, "vault");
    fs.mkdirSync(vault, { recursive: true });
  });

  afterEach(() => fs.rmSync(tmpdir, { recursive: true, force: true }));

  function writeNote(rel: string, content: string): string {
    const full = path.join(vault, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, "utf-8");
    return full;
  }

  it("body change is detected; coalesced into ONE sorted path list (curator tick)", () => {
    writeNote("01_Знания/A.md", "---\ntitle: A\n---\n\nстарое тело\n");
    writeNote("01_Знания/B.md", "---\ntitle: B\n---\n\nтело B\n");
    const prev = snapshotVault(vault, TAXONOMY_RU);
    writeNote("01_Знания/A.md", "---\ntitle: A\n---\n\nновое тело\n");
    writeNote("02_Решения/C.md", "---\ntitle: C\n---\n\nновая заметка\n");
    const changed = diffSnapshots(prev, snapshotVault(vault, TAXONOMY_RU));
    expect(changed).toEqual(["01_Знания/A.md", "02_Решения/C.md"]);
  });

  it("collectNeedsReview: the curation queue = needs_review:true in monitored folders, sorted", () => {
    writeNote("01_Знания/Flagged.md", "---\ntitle: Flagged\nneeds_review: true\n---\n\nтело\n");
    writeNote("06_Оперативка_агентов/boris/Flag2.md", "---\ntitle: Flag2\nneeds_review: true\n---\n\nт\n");
    writeNote("01_Знания/Cleared.md", "---\ntitle: Cleared\nneeds_review: false\n---\n\nтело\n");
    writeNote("01_Знания/NoFlag.md", "---\ntitle: NoFlag\n---\n\nтело\n");
    // archive is NOT monitored — a flagged archived note never enters the queue
    writeNote("07_Архив/Archived.md", "---\ntitle: Archived\nneeds_review: true\n---\n\nт\n");
    expect(collectNeedsReview(vault, TAXONOMY_RU)).toEqual([
      "01_Знания/Flagged.md",
      "06_Оперативка_агентов/boris/Flag2.md",
    ]);
  });

  it("service-field-only change does NOT produce a change (anti echo-loop)", () => {
    const p = writeNote(
      "01_Знания/A.md",
      "---\ntitle: A\nauthor: boris\n---\n\nтело\n",
    );
    const prev = snapshotVault(vault, TAXONOMY_RU);
    fs.writeFileSync(
      p,
      "---\ntitle: A\nauthor: boris\nlast_edited_by: index\nupdated: 2026-05-15 12:30:00\nneeds_review: true\n---\n\nтело\n",
      "utf-8",
    );
    expect(diffSnapshots(prev, snapshotVault(vault, TAXONOMY_RU))).toEqual([]);
  });

  it("deletions are ignored (archive moves are base infra)", () => {
    const p = writeNote("01_Знания/A.md", "---\ntitle: A\n---\n\nтело\n");
    const prev = snapshotVault(vault, TAXONOMY_RU);
    fs.unlinkSync(p);
    expect(diffSnapshots(prev, snapshotVault(vault, TAXONOMY_RU))).toEqual([]);
  });

  it("agent-memory subfolders are monitored; archive and system are not", () => {
    writeNote("06_Оперативка_агентов/boris/n.md", "---\nsubtype: справка\n---\nx\n");
    writeNote("07_Архив/01_Знания/old.md", "---\ntitle: old\n---\nx\n");
    writeNote("99_Система/Tags.md", "словарь\n");
    const snap = snapshotVault(vault, TAXONOMY_RU);
    expect([...snap.keys()]).toEqual(["06_Оперативка_агентов/boris/n.md"]);
  });

  it("no-change pass yields a stable snapshot", () => {
    writeNote("01_Знания/A.md", "---\ntitle: A\n---\nтело\n");
    const prev = snapshotVault(vault, TAXONOMY_RU);
    expect(diffSnapshots(prev, snapshotVault(vault, TAXONOMY_RU))).toEqual([]);
  });
});

// ── stage acceptance smoke ───────────────────────────────────────────────────

describe("smoke: detect pipeline on a test vault", () => {
  let tmpdir: string;
  let vault: string;

  beforeEach(() => {
    tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), "iapeer-memory-detsmoke-"));
    vault = path.join(tmpdir, "vault");
    fs.mkdirSync(path.join(vault, TAXONOMY_RU.folders.knowledge), { recursive: true });
  });

  afterEach(() => fs.rmSync(tmpdir, { recursive: true, force: true }));

  it("«human» edit (no fresh agent stamp) → write decision → PERMANENT event", () => {
    const p = path.join(vault, "01_Знания", "X.md");
    fs.writeFileSync(p, "---\ntitle: X\nauthor: boris\n---\n\nтело\n", "utf-8");
    const prev = snapshotVault(vault, TAXONOMY_RU);

    // The human edits the body in an external editor (no agent stamp).
    fs.writeFileSync(p, "---\ntitle: X\nauthor: boris\n---\n\nправка человека\n", "utf-8");
    const content = fs.readFileSync(p, "utf-8");
    const d = decideUpdate({
      content,
      zone: "permanent",
      human: HUMAN,
      nowMs: NOW,
      birthtimeMs: 0,
      mtimeMs: NOW,
      basename: "X.md",
      path: p,
      vault,
      lastHash: null,
      taxonomy: TAXONOMY_RU,
    });
    expect(d.action).toBe("write"); // human-edit attribution fires
    if (d.action !== "write") throw new Error("unreachable");
    fs.writeFileSync(p, d.newContent, "utf-8");

    // The semantic body change produces the coalesced change list.
    const changed = diffSnapshots(prev, snapshotVault(vault, TAXONOMY_RU));
    expect(changed).toEqual(["01_Знания/X.md"]);
  });

  it("agent edit with a fresh stamp inside the window → NO human stamp (echo-loop closed)", () => {
    const p = path.join(vault, "01_Знания", "Y.md");
    // The post-write hook just stamped this edit (fresh agent attribution).
    fs.writeFileSync(p, "---\ntitle: Y\nauthor: boris\n---\n\nтело\n", "utf-8");
    processFile(p, {
      zone: "permanent",
      agent: "boris",
      vault,
      now: new Date(NOW - 10_000), // 10s ago — inside the 90s window
      taxonomy: TAXONOMY_RU,
    });
    const content = fs.readFileSync(p, "utf-8");
    const d = decideUpdate({
      content,
      zone: "permanent",
      human: HUMAN,
      nowMs: NOW,
      birthtimeMs: 0,
      mtimeMs: NOW,
      basename: "Y.md",
      path: p,
      vault,
      lastHash: null,
      taxonomy: TAXONOMY_RU,
    });
    expect(d.action).toBe("skip");
    expect(d.reason).toBe("echo-agent"); // no loop: the hook's stamp is respected
  });

  it("service-field-only re-stamp does not wake the Index (smart-hash silence)", () => {
    const p = path.join(vault, "01_Знания", "Z.md");
    // Complete canon frontmatter (lean steady state): the index re-stamp is
    // then truly service-only (leb/updated), so smart-hash stays silent. A
    // legacy note missing type/status would get a ONE-TIME backfill event.
    fs.writeFileSync(
      p,
      "---\ntitle: Z\nauthor: boris\ntype: знание\nstatus: актуально\ncreated: 2026-05-01\n---\n\nтело\n",
      "utf-8",
    );
    const prev = snapshotVault(vault, TAXONOMY_RU);
    // The hook re-stamps service fields only (e.g. an Index pass).
    processFile(p, {
      zone: "permanent",
      agent: "index",
      vault,
      now: new Date(NOW),
      taxonomy: TAXONOMY_RU,
    });
    expect(diffSnapshots(prev, snapshotVault(vault, TAXONOMY_RU))).toEqual([]);
  });
});
