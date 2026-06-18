import { describe, it, expect } from "bun:test";
import {
  TAXONOMY_EN,
  TAXONOMY_RU,
  getTaxonomy,
  isLocaleId,
  agentMemoryFolderMarker,
  statusGroup,
  defaultExcludeFolders,
  linksSectionPattern,
  genreForFolder,
  isStale,
  DEFAULT_RANKING,
  type TaxonomyPreset,
} from "../src/taxonomy.js";

const LOCALES: TaxonomyPreset[] = [TAXONOMY_EN, TAXONOMY_RU];

describe("preset shape parity (EN base ↔ RU preset)", () => {
  it("folders carry the same keys", () => {
    expect(Object.keys(TAXONOMY_RU.folders).sort()).toEqual(
      Object.keys(TAXONOMY_EN.folders).sort(),
    );
  });

  it("types carry the same keys", () => {
    expect(Object.keys(TAXONOMY_RU.types).sort()).toEqual(
      Object.keys(TAXONOMY_EN.types).sort(),
    );
  });

  it("subtypes carry the same keys and both presets order all five", () => {
    expect(Object.keys(TAXONOMY_RU.subtypes).sort()).toEqual(
      Object.keys(TAXONOMY_EN.subtypes).sort(),
    );
    for (const t of LOCALES) {
      expect(t.subtypeOrder).toHaveLength(5);
      expect(new Set(t.subtypeOrder)).toEqual(new Set(Object.values(t.subtypes)));
    }
  });

  it("every status belongs to exactly one group", () => {
    for (const t of LOCALES) {
      const all = [...t.statuses.active, ...t.statuses.pending, ...t.statuses.stale];
      expect(new Set(all).size).toBe(all.length);
    }
  });

  it("folders are 8 distinct names per preset", () => {
    for (const t of LOCALES) {
      const names = Object.values(t.folders);
      expect(names).toHaveLength(8);
      expect(new Set(names).size).toBe(8);
    }
  });
});

describe("RU preset matches the frozen reference constants verbatim", () => {
  it("status sets equal reference search.ts sets", () => {
    expect(TAXONOMY_RU.statuses.active).toEqual([
      "актуально", "активный", "активная", "принято", "новая", "реализуется",
    ]);
    expect(TAXONOMY_RU.statuses.pending).toEqual([
      "черновик", "запланирована", "на паузе",
    ]);
    expect(TAXONOMY_RU.statuses.stale).toEqual([
      "устарело", "заменено", "отброшена", "завершён", "завершена", "отменена",
    ]);
  });

  it("agent-memory marker equals reference OPERATIVE_FOLDER_MARKER", () => {
    expect(agentMemoryFolderMarker(TAXONOMY_RU)).toBe("06_Оперативка_агентов/");
  });

  it("default exclude folders = the system folder only (archive stays searchable)", () => {
    expect(defaultExcludeFolders(TAXONOMY_RU)).toEqual(["99_Система"]);
  });

  it("links section equals reference parser heading", () => {
    expect(TAXONOMY_RU.linksSection).toBe("## Связи");
  });
});

// The acceptance smoke: the SAME helpers behave identically over both
// locale presets — taxonomy is data, logic is shared.
describe("locale smoke — same module, two locales", () => {
  it.each([
    [TAXONOMY_EN, "current"],
    [TAXONOMY_RU, "актуально"],
  ] as const)("statusGroup → active (%#)", (t, status) => {
    expect(statusGroup(t, status)).toBe("active");
  });

  it.each([
    [TAXONOMY_EN, "draft"],
    [TAXONOMY_RU, "черновик"],
  ] as const)("statusGroup → pending (%#)", (t, status) => {
    expect(statusGroup(t, status)).toBe("pending");
  });

  it.each([
    [TAXONOMY_EN, "superseded"],
    [TAXONOMY_RU, "заменено"],
  ] as const)("statusGroup → stale (%#)", (t, status) => {
    expect(statusGroup(t, status)).toBe("stale");
  });

  it("unknown status is neutral (null) in both locales", () => {
    for (const t of LOCALES) expect(statusGroup(t, "nonsense")).toBeNull();
  });

  it("marker ends with slash in both locales (README false-positive guard)", () => {
    for (const t of LOCALES) {
      const marker = agentMemoryFolderMarker(t);
      expect(marker.endsWith("/")).toBe(true);
      expect(marker.startsWith("/")).toBe(false);
      expect(`${t.folders.agentMemory}/boris/diary.md`.includes(marker)).toBe(true);
      expect(`${t.folders.agentMemory}_README.md`.includes(marker)).toBe(false);
    }
  });

  it("linksSectionPattern matches a body starting with the heading", () => {
    expect(linksSectionPattern(TAXONOMY_RU).test("## Связи\n- [[A]] — why")).toBe(true);
    expect(linksSectionPattern(TAXONOMY_EN).test("## Links\n- [[A]] — why")).toBe(true);
    // bare heading with nothing after it
    expect(linksSectionPattern(TAXONOMY_RU).test("## Связи")).toBe(true);
    // prefix collisions must NOT match (ASCII \b is useless after cyrillic —
    // the reference uses (?:\s|$) for exactly this reason)
    expect(linksSectionPattern(TAXONOMY_RU).test("## Связи_прочее")).toBe(false);
    expect(linksSectionPattern(TAXONOMY_EN).test("## Linksology")).toBe(false);
    // heading not at the start of the body
    expect(linksSectionPattern(TAXONOMY_EN).test("intro\n## Links")).toBe(false);
  });

  it("defaultExcludeFolders excludes the system folder, never the archive", () => {
    for (const t of LOCALES) {
      const excluded = defaultExcludeFolders(t);
      expect(excluded).toContain(t.folders.system);
      expect(excluded).not.toContain(t.folders.archive);
    }
  });
});

describe("lean §2.1 — per-type initial status + folder→genre alignment", () => {
  it("initialStatus carries the same keys as types (both presets)", () => {
    for (const t of LOCALES) {
      expect(Object.keys(t.initialStatus).sort()).toEqual(Object.keys(t.types).sort());
    }
  });

  it("every initial status is a member of statuses.active (a live token)", () => {
    for (const t of LOCALES) {
      for (const status of Object.values(t.initialStatus)) {
        expect(t.statuses.active).toContain(status);
      }
    }
  });

  it("RU initial statuses match the live vault", () => {
    expect(TAXONOMY_RU.initialStatus).toEqual({
      knowledge: "актуально",
      decision: "принято",
      idea: "новая",
      project: "активный",
      list: "актуально",
      agentMemory: "актуально",
    });
  });

  it("genreForFolder aligns each canonical folder to its type + initial status", () => {
    for (const t of LOCALES) {
      const pairs: Array<[string, keyof typeof t.types]> = [
        [t.folders.knowledge, "knowledge"],
        [t.folders.decisions, "decision"],
        [t.folders.projects, "project"],
        [t.folders.ideas, "idea"],
        [t.folders.lists, "list"],
        [t.folders.agentMemory, "agentMemory"],
      ];
      for (const [folder, typeKey] of pairs) {
        expect(genreForFolder(t, folder)).toEqual({
          type: t.types[typeKey],
          initialStatus: t.initialStatus[typeKey],
        });
      }
    }
  });

  it("genreForFolder returns null for folders without a canonical type", () => {
    for (const t of LOCALES) {
      for (const folder of [t.folders.archive, t.folders.system]) {
        expect(genreForFolder(t, folder)).toBeNull();
      }
      expect(genreForFolder(t, "not-a-folder")).toBeNull();
    }
  });

  it("isStale is true only for final tokens; paused/active/pending and null are not", () => {
    for (const t of LOCALES) {
      for (const s of t.statuses.stale) expect(isStale(t, s)).toBe(true);
      for (const s of t.statuses.active) expect(isStale(t, s)).toBe(false);
      for (const s of t.statuses.pending) expect(isStale(t, s)).toBe(false);
      expect(isStale(t, null)).toBe(false);
      expect(isStale(t, undefined)).toBe(false);
      expect(isStale(t, "")).toBe(false);
    }
    // «на паузе»/«paused» is resumable → PENDING, never archived
    expect(isStale(TAXONOMY_RU, "на паузе")).toBe(false);
    expect(isStale(TAXONOMY_EN, "paused")).toBe(false);
  });
});

describe("getTaxonomy / isLocaleId", () => {
  it("resolves both locales", () => {
    expect(getTaxonomy("en").locale).toBe("en");
    expect(getTaxonomy("ru").locale).toBe("ru");
  });

  it("isLocaleId accepts only known locales", () => {
    expect(isLocaleId("en")).toBe(true);
    expect(isLocaleId("ru")).toBe(true);
    expect(isLocaleId("de")).toBe(false);
    expect(isLocaleId("")).toBe(false);
  });
});

describe("DEFAULT_RANKING equals reference search.ts coefficients", () => {
  it("verbatim values", () => {
    expect(DEFAULT_RANKING).toEqual({
      activeBoost: 1.2,
      pendingPenalty: 0.8,
      stalePenalty: 0.5,
      foreignAgentMemoryPenalty: 0.7,
      graphExpandPenalty: 0.4,
      backlinkHubThreshold: 5,
      backlinkHubBoost: 1.15,
    });
  });
});
