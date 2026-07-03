import { describe, it, expect } from "bun:test";
import {
  parseDictionaryEntries,
  parseDictionaryTags,
  isTagAllowed,
  parseNoteTags,
  tagGateProblems,
  renderTagsProjection,
  DEFAULT_TAGS_BOUNDARY_MAXLEN,
} from "../src/tags-gate.js";

const DICT = `---
title: Tags
type: list
---

# Tag dictionary

## Domain tags

| Tag | Boundary (optional) |
|---|---|
| Claude_Code | the Claude Code platform: plugins, hooks, SDK |
| codex | codex-runtime as a peer runtime |
| Безопасность | threat model, identity, trust, auth |
| Бизнес | commercial track; verticals via subtags, e.g. Бизнес/Логистика |
| Финансы | — |
| Здоровье | - |
`;

describe("parseDictionaryEntries / parseDictionaryTags", () => {
  it("parses name + boundary, skips header & separator rows", () => {
    const entries = parseDictionaryEntries(DICT);
    expect(entries.map((e) => e.name)).toEqual([
      "Claude_Code",
      "codex",
      "Безопасность",
      "Бизнес",
      "Финансы",
      "Здоровье",
    ]);
  });

  it("normalises — and - to an empty (self-evident) boundary", () => {
    const entries = parseDictionaryEntries(DICT);
    expect(entries.find((e) => e.name === "Финансы")!.boundary).toBe("");
    expect(entries.find((e) => e.name === "Здоровье")!.boundary).toBe("");
    expect(entries.find((e) => e.name === "codex")!.boundary).toContain("peer runtime");
  });

  it("parseDictionaryTags returns just the names", () => {
    expect(parseDictionaryTags(DICT)).toContain("Claude_Code");
    expect(parseDictionaryTags(DICT)).not.toContain("Tag");
    expect(parseDictionaryTags(DICT)).not.toContain("---");
  });

  it("empty / non-table content → no entries", () => {
    expect(parseDictionaryEntries("")).toEqual([]);
    expect(parseDictionaryEntries("just prose\nno table")).toEqual([]);
  });
});

describe("isTagAllowed (subtag inheritance)", () => {
  const allow = new Set(parseDictionaryTags(DICT));
  it("exact match", () => {
    expect(isTagAllowed("Безопасность", allow)).toBe(true);
  });
  it("subtag inherits its root", () => {
    expect(isTagAllowed("Бизнес/Логистика", allow)).toBe(true);
  });
  it("unknown tag and unknown root are rejected", () => {
    expect(isTagAllowed("security", allow)).toBe(false);
    expect(isTagAllowed("Прочее/Хвост", allow)).toBe(false);
  });
});

describe("parseNoteTags", () => {
  it("block-list form", () => {
    expect(parseNoteTags("title: X\ntags:\n  - Память\n  - codex\nauthor: a\n")).toEqual([
      "Память",
      "codex",
    ]);
  });
  it("inline-array form, quotes stripped", () => {
    expect(parseNoteTags('tags: [Память, "codex"]\n')).toEqual(["Память", "codex"]);
  });
  it("no tags key → empty", () => {
    expect(parseNoteTags("title: X\nauthor: a\n")).toEqual([]);
  });
  it("empty block-list → empty", () => {
    expect(parseNoteTags("tags:\nauthor: a\n")).toEqual([]);
  });
  it("ZERO-indent block-list — valid YAML, the gate must not cry «no tags» (audit critical #5)", () => {
    expect(parseNoteTags("title: X\ntags:\n- Память\n- codex\nauthor: a\n")).toEqual([
      "Память",
      "codex",
    ]);
  });
});

describe("tagGateProblems", () => {
  const allow = new Set(parseDictionaryTags(DICT));
  const opts = { requireAtLeastOne: true, dictionaryRel: "99_System/Tags.md" };

  it("clean when all tags are known and ≥1 present", () => {
    expect(tagGateProblems(["Безопасность", "Бизнес/Логистика"], allow, opts)).toEqual([]);
  });

  it("flags a canon note with no tags", () => {
    const p = tagGateProblems([], allow, opts);
    expect(p).toHaveLength(1);
    expect(p[0]).toContain("no tags");
  });

  it("flags an unknown tag with a register-first teaching", () => {
    const p = tagGateProblems(["security"], allow, opts);
    expect(p.some((x) => x.includes('"security"') && x.includes("register it"))).toBe(true);
  });

  it("no ≥1 requirement when requireAtLeastOne is false (operative)", () => {
    expect(tagGateProblems([], allow, { ...opts, requireAtLeastOne: false })).toEqual([]);
  });
});

describe("renderTagsProjection (compact, budgeted)", () => {
  it("name-only for self-evident, name — boundary for overlapping domains", () => {
    const proj = renderTagsProjection(DICT);
    expect(proj).toContain("Финансы\n"); // self-evident, name only
    expect(proj.split("\n")).toContain("Здоровье");
    expect(proj).toContain("Безопасность — threat model");
    // no table chrome
    expect(proj).not.toContain("|");
    expect(proj).not.toContain("---");
  });

  it("clips an over-budget boundary with an ellipsis", () => {
    const longDict =
      "| Tag | B |\n|---|---|\n| X | " + "слово ".repeat(80).trim() + " |\n";
    const proj = renderTagsProjection(longDict, { boundaryMaxLen: 40 });
    expect(proj.length).toBeLessThan(80);
    expect(proj.endsWith("…")).toBe(true);
  });

  it("empty dict → empty string", () => {
    expect(renderTagsProjection("")).toBe("");
    expect(DEFAULT_TAGS_BOUNDARY_MAXLEN).toBeGreaterThan(0);
  });
});
