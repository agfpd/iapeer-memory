import { describe, it, expect } from "bun:test";
import {
  isArchivableZone,
  statusOf,
  shouldArchive,
  archiveTargetRel,
} from "../src/archive.js";
import { TAXONOMY_RU, TAXONOMY_EN, type TaxonomyPreset } from "../src/taxonomy.js";

const LOCALES: TaxonomyPreset[] = [TAXONOMY_RU, TAXONOMY_EN];

describe("isArchivableZone", () => {
  it("the 6 content folders are archivable (incl. 03_Projects); archive/system are not", () => {
    for (const t of LOCALES) {
      const f = t.folders;
      // UNIFIED rule: 03_Projects archives like any content zone.
      for (const folder of [f.knowledge, f.decisions, f.projects, f.ideas, f.lists, f.agentMemory]) {
        expect(isArchivableZone(`${folder}/x.md`, t)).toBe(true);
      }
      for (const folder of [f.archive, f.system]) {
        expect(isArchivableZone(`${folder}/x.md`, t)).toBe(false);
      }
      // nested (agent memory subfolder) still archivable
      expect(isArchivableZone(`${f.agentMemory}/boris/n.md`, t)).toBe(true);
    }
  });
});

describe("statusOf", () => {
  it("reads status from frontmatter; null when absent", () => {
    expect(statusOf("---\ntitle: X\nstatus: устарело\n---\nbody")).toBe("устарело");
    expect(statusOf("---\ntitle: X\n---\nbody")).toBeNull();
    expect(statusOf("no frontmatter")).toBeNull();
  });
});

describe("shouldArchive", () => {
  const t = TAXONOMY_RU;
  it("stale status in a content zone → archive", () => {
    for (const s of t.statuses.stale) {
      expect(shouldArchive("01_Знания/X.md", `---\nstatus: ${s}\n---\n`, t)).toBe(true);
    }
  });

  it("active/pending status → NOT archived", () => {
    for (const s of [...t.statuses.active, ...t.statuses.pending]) {
      expect(shouldArchive("01_Знания/X.md", `---\nstatus: ${s}\n---\n`, t)).toBe(false);
    }
  });

  it("«на паузе» (resumable) is never archived", () => {
    expect(shouldArchive("03_Проекты/P.md", "---\nstatus: на паузе\n---\n", t)).toBe(false);
  });

  it("stale status but NOT a content zone (archive/system) → not archived", () => {
    expect(shouldArchive("07_Архив/X.md", "---\nstatus: устарело\n---\n", t)).toBe(false);
    expect(shouldArchive("99_Система/X.md", "---\nstatus: устарело\n---\n", t)).toBe(false);
  });

  it("completed agent-memory note is archived (operative declutter)", () => {
    expect(
      shouldArchive("06_Оперативка_агентов/boris/n.md", "---\nstatus: устарело\n---\n", t),
    ).toBe(true);
  });
});

describe("archiveTargetRel", () => {
  const t = TAXONOMY_RU;
  it("flat target under the archive folder", () => {
    expect(archiveTargetRel("X.md", t, () => false)).toBe("07_Архив/X.md");
  });

  it("numeric suffix on collision", () => {
    const taken = new Set(["07_Архив/X.md", "07_Архив/X-2.md"]);
    expect(archiveTargetRel("X.md", t, (rel) => taken.has(rel))).toBe("07_Архив/X-3.md");
  });
});
