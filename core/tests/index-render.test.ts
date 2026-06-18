/**
 * Parity tests for src/index-render.ts — translation of the reference
 * `tests/python/test_regenerate_vault_index.py` (84 fixtures, RU preset =
 * verbatim reference literals) + both-locale render smoke + the
 * boost-bucket↔memory_search synchronisation assert (by construction from
 * the shared taxonomy/ranking config — now an assert, not a discipline).
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  scalarField,
  parseTags,
  parseCoauthors,
  resolveProjectDir,
  statusBoost,
  subtypeRank,
  datetimeKey,
  sortKeyGlobal,
  compareKeys,
  collectNotes,
  filterAgentNotes,
  fmtCanonical,
  fmtMemory,
  truncateDescription,
  selectCanon,
  selectMemory,
  buildOutput,
  fullIndexPathFor,
  regenerateVaultIndex,
  MEMORY_CAP,
  CANON_CAP,
  PROJECT_SECTION_CAP,
  PROJECT_HARD_CAP,
  DESCRIPTION_MAX_LEN,
  type RenderContext,
  type FilteredNote,
} from "../src/index-render.js";
import { openDatabase } from "../src/db.js";
import { indexAll } from "../src/indexer.js";
import { runVaultSearch } from "../src/search.js";
import {
  TAXONOMY_RU,
  TAXONOMY_EN,
  getTaxonomy,
  defaultExcludeFolders,
  DEFAULT_RANKING,
  type LocaleId,
} from "../src/taxonomy.js";

const RU: RenderContext = { taxonomy: TAXONOMY_RU, ranking: { ...DEFAULT_RANKING } };
const pad3 = (n: number) => String(n).padStart(3, "0");
const pad2 = (n: number) => String(n).padStart(2, "0");

describe("scalarField", () => {
  it("basic", () => expect(scalarField("title: X\n", "title")).toBe("X"));
  it("strips double quotes", () => expect(scalarField('title: "X Y"\n', "title")).toBe("X Y"));
  it("strips single quotes", () => expect(scalarField("title: 'X Y'\n", "title")).toBe("X Y"));
  it("strips guillemets", () =>
    expect(scalarField("description: «foo»\n", "description")).toBe("foo"));
  it("absent returns null", () => expect(scalarField("title: X\n", "author")).toBeNull());
  it("multiline frontmatter", () => {
    expect(scalarField("title: X\nauthor: boris\nstatus: актуально\n", "author")).toBe("boris");
  });
});

describe("parseTags / parseCoauthors", () => {
  it("tags inline", () =>
    expect(parseTags("tags: [инфраструктура, безопасность]\n")).toEqual([
      "инфраструктура", "безопасность",
    ]));
  it("tags block", () =>
    expect(parseTags("tags:\n  - инфраструктура\n  - безопасность\n")).toEqual([
      "инфраструктура", "безопасность",
    ]));
  it("tags absent → empty", () => expect(parseTags("title: X\n")).toEqual([]));
  it("coauthors inline", () =>
    expect(parseCoauthors("coauthors: [boris, linus]\n")).toEqual(["boris", "linus"]));
  it("coauthors block", () =>
    expect(parseCoauthors("coauthors:\n  - boris\n  - linus\n")).toEqual(["boris", "linus"]));
  it("coauthors absent → empty", () => expect(parseCoauthors("author: artur\n")).toEqual([]));
});

describe("statusBoost — from the shared ranking config", () => {
  it("active statuses", () => {
    for (const s of ["актуально", "активный", "принято", "новая"]) {
      expect(statusBoost(s, RU)).toBe(1.2);
    }
  });
  it("pending statuses", () => {
    for (const s of ["черновик", "запланирована", "на паузе"]) {
      expect(statusBoost(s, RU)).toBe(0.8);
    }
  });
  it("stale statuses", () => {
    for (const s of ["устарело", "заменено", "отброшена", "завершён"]) {
      expect(statusBoost(s, RU)).toBe(0.5);
    }
  });
  it("unknown / null → 1.0", () => {
    expect(statusBoost("неведомое", RU)).toBe(1.0);
    expect(statusBoost(null, RU)).toBe(1.0);
  });
});

describe("subtypeRank", () => {
  it("all five subtypes ranked in order", () => {
    expect(
      ["обратная_связь", "контекст", "справка", "профиль_человека", "грабли"].map((s) =>
        subtypeRank(s, RU),
      ),
    ).toEqual([0, 1, 2, 3, 4]);
  });
  it("unknown / empty / null → 99", () => {
    expect(subtypeRank("неведомое", RU)).toBe(99);
    expect(subtypeRank("", RU)).toBe(99);
    expect(subtypeRank(null, RU)).toBe(99);
  });
  it("whitespace and case normalised", () => {
    expect(subtypeRank("  грабли  ", RU)).toBe(4);
    expect(subtypeRank("ГРАБЛИ", RU)).toBe(4);
  });
});

describe("datetimeKey", () => {
  it("full datetime", () => expect(datetimeKey("2026-05-15 12:30")).toEqual([2026, 5, 15, 12, 30]));
  it("date only", () => expect(datetimeKey("2026-05-15")).toEqual([2026, 5, 15, 0, 0]));
  it("empty", () => expect(datetimeKey("")).toEqual([0, 0, 0, 0, 0]));
  it("malformed", () => expect(datetimeKey("bogus")).toEqual([0, 0, 0, 0, 0]));
});

describe("fmtCanonical / fmtMemory", () => {
  it("canonical full line", () => {
    const s = fmtCanonical(
      {
        title: "X", status: "актуально", tags: ["инфраструктура"],
        nLinks: 3, created: "2026-05-10", updated: "2026-05-15 12:00",
      },
      RU,
    );
    expect(s).toContain("[[X]]");
    expect(s).not.toContain("знание");
    expect(s).toContain("актуально");
    expect(s).toContain("инфраструктура");
    expect(s).toContain("3 св.");
    expect(s).not.toContain("связей");
    expect(s).toContain("2026-05-15");
    expect(s).not.toContain("12:00");
    expect(s).not.toContain("upd");
    expect(s).not.toContain("2026-05-10");
  });

  it("nLinks=0 omitted", () => {
    const s = fmtCanonical(
      { title: "Orphan", status: "актуально", tags: [], nLinks: 0, created: "2026-05-15", updated: "" },
      RU,
    );
    expect(s).not.toContain("св.");
    expect(s).not.toContain("0 ");
  });

  it("updated rendered date-only", () => {
    const s = fmtCanonical(
      { title: "X", status: "актуально", tags: [], nLinks: 0, created: "2026-05-15", updated: "2026-05-15 12:00:30" },
      RU,
    );
    expect(s).toContain("2026-05-15");
    expect(s).not.toContain("12:00");
  });

  it("fallback to created when no updated", () => {
    const s = fmtCanonical(
      { title: "X", status: "актуально", tags: [], nLinks: 0, created: "2026-05-15", updated: "" },
      RU,
    );
    expect(s).toContain("2026-05-15");
  });

  it("memory full line", () => {
    const s = fmtMemory(
      { title: "X", subtype: "грабли", status: "актуально", description: "test rule", nLinks: 0, created: "2026-05-15", updated: "" },
      RU,
    );
    expect(s).toContain("[[X]]");
    expect(s).toContain("грабли");
    expect(s).toContain("«test rule»");
    expect(s).not.toContain("св.");
  });

  it("memory with links", () => {
    const s = fmtMemory(
      { title: "X", subtype: "контекст", status: "актуально", description: "d", nLinks: 5, created: "", updated: "2026-05-20 10:00" },
      RU,
    );
    expect(s).toContain("5 св.");
    expect(s).not.toContain("связей");
  });
});

describe("truncateDescription", () => {
  it("short, no sentence end → as is", () => {
    const s = "Личность, предпочтения, стиль работы пользователя";
    expect(truncateDescription(s)).toBe(s);
  });
  it("first sentence fits and has continuation → sentence + …", () => {
    const out = truncateDescription("Сначала первое предложение. Потом второе которое не нужно.");
    expect(out).toBe("Сначала первое предложение.…");
  });
  it("first sentence is the whole desc → as is", () => {
    const s = "Только одно предложение.";
    const out = truncateDescription(s);
    expect(out).toBe(s);
    expect(out.endsWith("…")).toBe(false);
  });
  it("long first sentence → word-boundary cut + …", () => {
    const s = "А" + " слово".repeat(30) + ". Дальше неважно.";
    const out = truncateDescription(s);
    expect(out.endsWith("…")).toBe(true);
    expect(out.length).toBeLessThanOrEqual(DESCRIPTION_MAX_LEN + 5);
    expect(out.slice(0, -1).endsWith(" ")).toBe(false);
  });
  it("long without sentence end → word-boundary cut + …", () => {
    const out = truncateDescription("Слово ".repeat(30));
    expect(out.endsWith("…")).toBe(true);
    expect(out.length).toBeLessThanOrEqual(DESCRIPTION_MAX_LEN + 5);
  });
  it("empty string", () => expect(truncateDescription("")).toBe(""));
  it("trailing punctuation cleaned before …", () => {
    const out = truncateDescription("А".repeat(110) + ", потом ещё текста");
    expect(/[,;:—\s]…$/.test(out)).toBe(false);
  });
  it("? and ! end a sentence", () => {
    expect(truncateDescription("Вопрос? Ответ.")).toBe("Вопрос?…");
    expect(truncateDescription("Восклицание! И продолжение.")).toBe("Восклицание!…");
  });
  it("fmtMemory uses truncation", () => {
    const s = fmtMemory(
      {
        title: "X", subtype: "контекст", status: "актуально",
        description: "Первое. " + "Длинный хвост ".repeat(20),
        nLinks: 1, created: "", updated: "2026-05-20",
      },
      RU,
    );
    expect(s).toContain("«Первое.…»");
  });
});

describe("sortKeyGlobal", () => {
  function make(over: Partial<FilteredNote> = {}) {
    return {
      title: "X", type: "знание", status: "актуально", subtype: "",
      score: 1.0, created: "2026-05-15", updated: "", ...over,
    };
  }
  it("active before pending", () => {
    const a = make({ status: "актуально", score: 1.0 });
    const p = make({ status: "черновик", score: 5.0 });
    expect(compareKeys(sortKeyGlobal(a, RU), sortKeyGlobal(p, RU))).toBeLessThan(0);
  });
  it("pending before stale", () => {
    const p = make({ status: "черновик", score: 1.0 });
    const s = make({ status: "устарело", score: 5.0 });
    expect(compareKeys(sortKeyGlobal(p, RU), sortKeyGlobal(s, RU))).toBeLessThan(0);
  });
  it("within canon: higher score first", () => {
    const high = make({ score: 10.0 });
    const low = make({ score: 1.0 });
    expect(compareKeys(sortKeyGlobal(high, RU), sortKeyGlobal(low, RU))).toBeLessThan(0);
  });
  it("within memory: subtype order", () => {
    const fb = make({ type: "оперативка агентов", subtype: "обратная_связь" });
    const rakes = make({ type: "оперативка агентов", subtype: "грабли" });
    expect(compareKeys(sortKeyGlobal(fb, RU), sortKeyGlobal(rakes, RU))).toBeLessThan(0);
  });
});

// ── integration on a tmp vault (RU = reference literals) ────────────────────

describe("integration: collect + filter + buildOutput", () => {
  let tmpdir: string;
  let vault: string;

  beforeEach(() => {
    tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), "iapeer-memory-regen-"));
    vault = path.join(tmpdir, "vault");
    for (const d of [
      TAXONOMY_RU.folders.knowledge, TAXONOMY_RU.folders.decisions,
      TAXONOMY_RU.folders.projects, TAXONOMY_RU.folders.ideas,
      TAXONOMY_RU.folders.lists, TAXONOMY_RU.folders.agentMemory,
    ]) {
      fs.mkdirSync(path.join(vault, d), { recursive: true });
    }
  });

  afterEach(() => fs.rmSync(tmpdir, { recursive: true, force: true }));

  function writeNote(rel: string, frontmatter: string, body = ""): void {
    const full = path.join(vault, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, `---\n${frontmatter}---\n${body}`, "utf-8");
  }

  function collectMine(agent = "boris") {
    const { notes, incomingCount, skipped } = collectNotes(vault, RU);
    return { notes, incomingCount, skipped, mine: filterAgentNotes(notes, incomingCount, agent, RU) };
  }

  it("basic collect + filter", () => {
    writeNote("01_Знания/X.md", "title: X\nauthor: boris\ntype: знание\nstatus: актуально\n");
    writeNote("01_Знания/Y.md", "title: Y\nauthor: linus\ntype: знание\nstatus: актуально\n");
    const { notes, skipped, mine } = collectMine();
    expect(notes.size).toBe(2);
    expect(skipped).toEqual([]);
    const titles = mine.map((n) => n.title);
    expect(titles).toContain("X");
    expect(titles).not.toContain("Y");
  });

  it("coauthor inclusion", () => {
    writeNote(
      "02_Решения/D.md",
      "title: D\nauthor: linus\ncoauthors:\n  - boris\ntype: решение\nstatus: принято\n",
    );
    const { mine } = collectMine();
    expect(mine).toHaveLength(1);
    expect(mine[0]!.title).toBe("D");
  });

  it("wikilinks counted (incoming by source + outgoing unique)", () => {
    writeNote("01_Знания/X.md", "title: X\nauthor: boris\ntype: знание\nstatus: актуально\n", "See [[Y]] and [[Z]]\n");
    writeNote("01_Знания/Y.md", "title: Y\nauthor: boris\ntype: знание\nstatus: актуально\n");
    const { notes, incomingCount } = collectMine();
    expect(incomingCount.get("Y")).toBe(1);
    expect(incomingCount.get("Z")).toBe(1);
    const x = [...notes.values()].find((d) => d.title === "X")!;
    expect(x.nOutgoing).toBe(2);
  });

  it("incoming unique by source (3 mentions = 1 source)", () => {
    writeNote("01_Знания/A.md", "title: A\nauthor: boris\ntype: знание\nstatus: актуально\n", "[[X]] then again [[X]] and one more [[X]]\n");
    writeNote("01_Знания/X.md", "title: X\nauthor: boris\ntype: знание\nstatus: актуально\n");
    const { incomingCount } = collectMine();
    expect(incomingCount.get("X")).toBe(1);
  });

  it("nLinks includes outgoing", () => {
    writeNote(
      "03_Проекты/foo/План foo.md",
      "title: План foo\nauthor: boris\ntype: проект\nstatus: активный\n",
      "Состоит из [[Описание foo]], [[Фаза — A]], [[Фаза — B]]\n",
    );
    writeNote("03_Проекты/foo/Описание foo.md", "title: Описание foo\nauthor: boris\ntype: проект\nstatus: активный\n");
    const { mine } = collectMine();
    const byTitle = new Map(mine.map((n) => [n.title, n]));
    expect(byTitle.get("План foo")!.nLinks).toBe(3);
    expect(byTitle.get("Описание foo")!.nLinks).toBe(1);
  });

  it("self-reference not counted", () => {
    writeNote("01_Знания/Loop.md", "title: Loop\nauthor: boris\ntype: знание\nstatus: актуально\n", "See [[Loop]] itself, and [[Other]]\n");
    const { notes, incomingCount } = collectMine();
    const loop = [...notes.values()].find((d) => d.title === "Loop")!;
    expect(loop.nOutgoing).toBe(1);
    expect(incomingCount.has("Loop")).toBe(false);
  });

  it("stale notes excluded entirely", () => {
    const staleCases: Array<[string, string, string]> = [
      ["01_Знания/old1.md", "знание", "устарело"],
      ["02_Решения/old2.md", "решение", "заменено"],
      ["04_Идеи/old3.md", "идея", "отброшена"],
      ["03_Проекты/foo/Фаза — закрытая.md", "проект", "завершена"],
      ["03_Проекты/foo/Фаза — отменённая.md", "проект", "отменена"],
    ];
    for (const [rel, type, status] of staleCases) {
      const title = path.basename(rel, ".md");
      writeNote(rel, `title: ${title}\nauthor: boris\ntype: ${type}\nstatus: ${status}\n`);
    }
    writeNote("01_Знания/alive.md", "title: alive\nauthor: boris\ntype: знание\nstatus: актуально\n");
    const { mine } = collectMine();
    expect(mine.map((n) => n.title)).toEqual(["alive"]);
  });

  it("pending notes kept", () => {
    for (const [rel, type, status] of [
      ["01_Знания/draft.md", "знание", "черновик"],
      ["03_Проекты/foo/Описание foo.md", "проект", "на паузе"],
      ["03_Проекты/foo/Фаза — будущая.md", "проект", "запланирована"],
    ] as const) {
      const title = path.basename(rel, ".md");
      writeNote(rel, `title: ${title}\nauthor: boris\ntype: ${type}\nstatus: ${status}\n`);
    }
    expect(collectMine().mine).toHaveLength(3);
  });

  it("buildOutput renders six sections", () => {
    writeNote(
      "06_Оперативка_агентов/boris/feedback_x.md",
      "title: feedback_x\nauthor: boris\ntype: оперативка агентов\nsubtype: грабли\ndescription: test\nstatus: актуально\n",
    );
    const { mine } = collectMine();
    const [text, total, truncated] = buildOutput(mine, "boris", { ctx: RU });
    for (const h of ["## Оперативка агентов", "## Знания", "## Решения", "## Проекты", "## Идеи", "## Списки"]) {
      expect(text).toContain(h);
    }
    expect(text).toContain("[[feedback_x]]");
    expect(text).toContain("грабли");
    expect(total).toBe(1);
    expect(truncated).toBe(false);
  });

  it("canon cap", () => {
    for (let i = 0; i < CANON_CAP + 10; i++) {
      writeNote(`01_Знания/N${pad3(i)}.md`, `title: N${pad3(i)}\nauthor: boris\ntype: знание\nstatus: актуально\n`);
    }
    const { mine } = collectMine();
    const [text, total, truncated] = buildOutput(mine, "boris", {
      ctx: RU, fullIndexPath: "/tmp/boris-vault-index-full.md",
    });
    expect(total).toBe(CANON_CAP + 10);
    expect(truncated).toBe(true);
    const noteLines = text.split("\n").filter((l) => l.startsWith("- [[N"));
    expect(noteLines).toHaveLength(CANON_CAP);
    expect(text).toContain("Индекс обрезан");
    expect(text).toContain(`канон ${CANON_CAP}/${CANON_CAP + 10}`);
    expect(text).toContain("/tmp/boris-vault-index-full.md");
  });

  it("memory cap", () => {
    for (let i = 0; i < MEMORY_CAP + 5; i++) {
      writeNote(
        `06_Оперативка_агентов/boris/note${pad3(i)}.md`,
        `title: note${pad3(i)}\nauthor: boris\ntype: оперативка агентов\nsubtype: контекст\nstatus: актуально\ndescription: '${i}'\n`,
      );
    }
    const { mine } = collectMine();
    const [text, total, truncated] = buildOutput(mine, "boris", {
      ctx: RU, fullIndexPath: "/tmp/boris-vault-index-full.md",
    });
    expect(total).toBe(MEMORY_CAP + 5);
    expect(truncated).toBe(true);
    const noteLines = text.split("\n").filter((l) => l.startsWith("- [[note"));
    expect(noteLines).toHaveLength(MEMORY_CAP);
    expect(text).toContain(`оперативка ${MEMORY_CAP}/${MEMORY_CAP + 5}`);
  });

  it("caps disabled for the full index", () => {
    for (let i = 0; i < CANON_CAP + 10; i++) {
      writeNote(`01_Знания/N${pad3(i)}.md`, `title: N${pad3(i)}\nauthor: boris\ntype: знание\nstatus: актуально\n`);
    }
    const { mine } = collectMine();
    const [text, total, truncated] = buildOutput(mine, "boris", {
      ctx: RU, memoryCap: null, canonCap: null,
    });
    expect(total).toBe(CANON_CAP + 10);
    expect(truncated).toBe(false);
    expect(text.split("\n").filter((l) => l.startsWith("- [[N"))).toHaveLength(CANON_CAP + 10);
    expect(text).not.toContain("Индекс обрезан");
  });

  it("fullIndexPathFor adds -full before the extension", () => {
    expect(fullIndexPathFor("/x/y/boris-vault-index.md")).toBe("/x/y/boris-vault-index-full.md");
  });

  it("unreadable file logged to skipped", () => {
    const bad = path.join(vault, "01_Знания", "broken.md");
    fs.writeFileSync(bad, Buffer.from([0x2d, 0x2d, 0x2d, 0x0a, 0xff, 0xfe, 0x0a]));
    const { skipped } = collectNotes(vault, RU);
    expect(skipped).toHaveLength(1);
    expect(skipped[0]![1]).toBe("UnicodeDecodeError");
  });
});

// ── selectMemory / selectCanon ───────────────────────────────────────────────

function memNote(subtype: string, idx: number, status = "актуально", updated = "2026-05-20"): FilteredNote {
  return {
    path: "", author: "boris", coauthors: [], tags: [], description: "",
    title: `${subtype}-${pad3(idx)}`, type: "оперативка агентов", subtype,
    status, nLinks: 0, score: 0, created: "", updated, nOutgoing: 0,
  };
}

describe("selectMemory — per-subtype quotas + overflow", () => {
  it("all within quotas → returns all", () => {
    const pool: FilteredNote[] = [];
    for (const st of ["обратная_связь", "контекст", "справка", "грабли"]) {
      for (let i = 0; i < 5; i++) pool.push(memNote(st, i));
    }
    pool.push(memNote("профиль_человека", 0));
    expect(selectMemory(pool, RU)).toHaveLength(21);
  });

  it("quota + overflow fill the cap", () => {
    const pool = Array.from({ length: 50 }, (_, i) =>
      memNote("справка", i, "актуально", `2026-05-${pad2((i % 28) + 1)}`),
    );
    expect(selectMemory(pool, RU)).toHaveLength(50);
  });

  it("person_profile hard ceiling 3", () => {
    const pool = Array.from({ length: 10 }, (_, i) => memNote("профиль_человека", i));
    const selected = selectMemory(pool, RU);
    expect(selected).toHaveLength(3);
    expect(selected.map((n) => n.title).sort()).toEqual([
      "профиль_человека-000", "профиль_человека-001", "профиль_человека-002",
    ]);
  });

  it("overflow goes to freshest across subtypes", () => {
    const pool: FilteredNote[] = [];
    for (const st of ["обратная_связь", "контекст", "грабли"]) {
      for (let i = 0; i < 10; i++) pool.push(memNote(st, i, "актуально", "2026-05-10"));
    }
    for (let i = 0; i < 15; i++) {
      pool.push(memNote("справка", i, "актуально", `2026-05-${pad2((i % 28) + 1)}`));
    }
    for (let i = 10; i < 15; i++) pool.push(memNote("грабли", i, "актуально", "2026-04-01"));
    expect(selectMemory(pool, RU)).toHaveLength(50);
  });

  it("overflow prefers freshest when constrained", () => {
    const pool: FilteredNote[] = [];
    for (const st of ["обратная_связь", "контекст", "грабли"]) {
      for (let i = 0; i < 10; i++) pool.push(memNote(st, i, "актуально", "2026-05-10"));
    }
    for (let i = 0; i < 30; i++) {
      pool.push(memNote("справка", i, "актуально", i < 15 ? "2026-05-25" : "2026-04-01"));
    }
    const selected = selectMemory(pool, RU);
    expect(selected).toHaveLength(50);
    expect(selected.filter((n) => n.subtype === "справка")).toHaveLength(20);
  });

  it("cap=null returns all", () => {
    const pool = Array.from({ length: 10 }, (_, i) => memNote("профиль_человека", i));
    expect(selectMemory(pool, RU, null)).toHaveLength(10);
  });

  it("unknown subtype uses the default quota", () => {
    const pool = Array.from({ length: 15 }, (_, i) => memNote("новый_subtype", i));
    expect(selectMemory(pool, RU)).toHaveLength(15);
  });
});

function canonNote(type: string, idx: number, nLinks = 0, status = "актуально", updated = "2026-05-20"): FilteredNote {
  return {
    path: "", author: "boris", coauthors: [], tags: [], description: "", subtype: "",
    title: `${type}-${pad3(idx)}`, type, status,
    nLinks, score: nLinks * 1.2, created: "", updated, nOutgoing: 0,
  };
}

describe("selectCanon — per-type quotas + overflow", () => {
  it("each type gets its quota, overflow by score", () => {
    const pool: FilteredNote[] = [];
    for (const t of ["знание", "решение", "идея", "список"]) {
      for (let i = 0; i < 20; i++) pool.push(canonNote(t, i, i));
    }
    const selected = selectCanon(pool, RU);
    expect(selected).toHaveLength(50);
    const byType = new Map<string, number>();
    for (const n of selected) byType.set(n.type, (byType.get(n.type) ?? 0) + 1);
    for (const t of ["знание", "решение", "идея", "список"]) {
      expect(byType.get(t)!).toBeGreaterThanOrEqual(10);
    }
  });

  it("overflow by score, no type fairness", () => {
    const pool = Array.from({ length: 30 }, (_, i) => canonNote("знание", i, i));
    const selected = selectCanon(pool, RU);
    expect(selected).toHaveLength(30);
    expect(selected.filter((n) => n.type === "знание")).toHaveLength(30);
  });

  it("cap constrains overflow", () => {
    const pool: FilteredNote[] = [];
    for (const t of ["знание", "идея"]) {
      for (let i = 0; i < 30; i++) pool.push(canonNote(t, i, i));
    }
    expect(selectCanon(pool, RU)).toHaveLength(50);
  });

  it("cap=null returns all", () => {
    const pool = Array.from({ length: 100 }, (_, i) => canonNote("знание", i, i));
    expect(selectCanon(pool, RU, null)).toHaveLength(100);
  });
});

// ── project immunity / caps / H3 groups ─────────────────────────────────────

describe("project immunity, soft/hard caps, H3 groups", () => {
  let tmpdir: string;
  let vault: string;
  let proot: string;

  beforeEach(() => {
    tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), "iapeer-memory-proj-"));
    vault = path.join(tmpdir, "vault");
    fs.mkdirSync(vault, { recursive: true });
    proot = path.join(tmpdir, "projects");
    fs.mkdirSync(proot);
  });

  afterEach(() => fs.rmSync(tmpdir, { recursive: true, force: true }));

  function writeNote(rel: string, frontmatter: string, body = ""): void {
    const full = path.join(vault, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, `---\n${frontmatter}---\n${body}`, "utf-8");
  }

  function build(opts: Partial<Parameters<typeof buildOutput>[2]> = {}) {
    const { notes, incomingCount } = collectNotes(vault, RU);
    const mine = filterAgentNotes(notes, incomingCount, "boris", RU);
    return buildOutput(mine, "boris", { ctx: RU, projectsRoot: proot, ...opts });
  }

  it("100 ACTIVE project notes → hard-capped to PROJECT_HARD_CAP", () => {
    fs.mkdirSync(path.join(proot, "p1"));
    for (let i = 0; i < 100; i++) {
      writeNote(`03_Проекты/p1/note${pad3(i)}.md`, `title: note${pad3(i)}\nauthor: boris\ntype: проект\nstatus: активная\n`);
    }
    const [text, total, truncated] = build();
    expect(total).toBe(100);
    expect(truncated).toBe(true);
    expect(text.split("\n").filter((l) => l.startsWith("- [[note"))).toHaveLength(PROJECT_HARD_CAP);
    expect(text).toContain(`сверх лимита ${PROJECT_HARD_CAP}`);
  });

  it("full index (projectHardCap=null) keeps all projects", () => {
    fs.mkdirSync(path.join(proot, "p1"));
    for (let i = 0; i < 100; i++) {
      writeNote(`03_Проекты/p1/note${pad3(i)}.md`, `title: note${pad3(i)}\nauthor: boris\ntype: проект\nstatus: активная\n`);
    }
    const [text] = build({ memoryCap: null, canonCap: null, projectHardCap: null });
    expect(text.split("\n").filter((l) => l.startsWith("- [[note"))).toHaveLength(100);
  });

  it("canon capped, projects kept in full", () => {
    for (let i = 0; i < 60; i++) {
      writeNote(`01_Знания/N${pad3(i)}.md`, `title: N${pad3(i)}\nauthor: boris\ntype: знание\nstatus: актуально\n`);
    }
    fs.mkdirSync(path.join(proot, "p1"));
    for (let i = 0; i < 20; i++) {
      writeNote(`03_Проекты/p1/proj${pad3(i)}.md`, `title: proj${pad3(i)}\nauthor: boris\ntype: проект\nstatus: активный\n`);
    }
    const [text, , truncated] = build();
    expect(text.split("\n").filter((l) => l.startsWith("- [[N"))).toHaveLength(50);
    expect(text.split("\n").filter((l) => l.startsWith("- [[proj"))).toHaveLength(20);
    expect(truncated).toBe(true);
  });

  it("section cap trims PENDING across projects, ACTIVE untouchable", () => {
    for (const proj of ["alpha", "beta"]) {
      fs.mkdirSync(path.join(proot, proj));
      for (let i = 0; i < 3; i++) {
        writeNote(`03_Проекты/${proj}/a${pad2(i)}.md`, `title: a${pad2(i)}-${proj}\nauthor: boris\ntype: проект\nstatus: активная\n`);
      }
      for (let i = 0; i < 5; i++) {
        const updated = `2026-05-${pad2((i % 28) + 1)}`;
        writeNote(`03_Проекты/${proj}/p${pad2(i)}.md`, `title: p${pad2(i)}-${proj}\nauthor: boris\ntype: проект\nstatus: запланирована\nupdated: '${updated}'\n`);
      }
    }
    const [text, , truncated] = build();
    for (const proj of ["alpha", "beta"]) {
      for (let i = 0; i < 3; i++) expect(text).toContain(`[[a${pad2(i)}-${proj}]]`);
    }
    let pendingInText = 0;
    for (const proj of ["alpha", "beta"]) {
      for (let i = 0; i < 5; i++) {
        if (text.includes(`[[p${pad2(i)}-${proj}]]`)) pendingInText += 1;
      }
    }
    expect(pendingInText).toBe(9);
    expect(truncated).toBe(true);
    expect(text).toContain("PENDING-фаз");
    expect(text).toContain(`секция > ${PROJECT_SECTION_CAP}`);
  });

  it("section under cap untouched", () => {
    fs.mkdirSync(path.join(proot, "small"));
    for (let i = 0; i < 10; i++) {
      writeNote(`03_Проекты/small/n${pad2(i)}.md`, `title: n${pad2(i)}\nauthor: boris\ntype: проект\nstatus: ${i < 5 ? "активная" : "запланирована"}\n`);
    }
    const [text, , truncated] = build();
    for (let i = 0; i < 10; i++) expect(text).toContain(`[[n${pad2(i)}]]`);
    expect(truncated).toBe(false);
  });

  it("section over cap but all ACTIVE → no trim", () => {
    for (const proj of ["a", "b", "c"]) {
      fs.mkdirSync(path.join(proot, proj));
      for (let i = 0; i < 10; i++) {
        writeNote(`03_Проекты/${proj}/n${pad2(i)}.md`, `title: n${pad2(i)}-${proj}\nauthor: boris\ntype: проект\nstatus: активная\n`);
      }
    }
    const [text, , truncated] = build();
    for (const proj of ["a", "b", "c"]) {
      for (let i = 0; i < 10; i++) expect(text).toContain(`[[n${pad2(i)}-${proj}]]`);
    }
    expect(truncated).toBe(false);
  });

  it("oldest PENDING dropped first", () => {
    fs.mkdirSync(path.join(proot, "p"));
    writeNote("03_Проекты/p/a.md", "title: a\nauthor: boris\ntype: проект\nstatus: активная\n");
    for (let i = 0; i < 10; i++) {
      writeNote(`03_Проекты/p/old${pad2(i)}.md`, `title: old${pad2(i)}\nauthor: boris\ntype: проект\nstatus: запланирована\nupdated: '2026-01-${pad2(i + 1)}'\n`);
    }
    for (let i = 0; i < 10; i++) {
      writeNote(`03_Проекты/p/new${pad2(i)}.md`, `title: new${pad2(i)}\nauthor: boris\ntype: проект\nstatus: запланирована\nupdated: '2026-05-${pad2(i + 1)}'\n`);
    }
    const [text] = build();
    expect(text).toContain("[[a]]");
    const oldKept = Array.from({ length: 10 }, (_, i) => text.includes(`[[old${pad2(i)}]]`)).filter(Boolean).length;
    const newKept = Array.from({ length: 10 }, (_, i) => text.includes(`[[new${pad2(i)}]]`)).filter(Boolean).length;
    expect(newKept).toBe(10);
    expect(oldKept).toBe(4);
  });

  it("stale project phases excluded", () => {
    fs.mkdirSync(path.join(proot, "p1"));
    writeNote("03_Проекты/p1/Описание p1.md", "title: Описание p1\nauthor: boris\ntype: проект\nstatus: активный\n");
    writeNote("03_Проекты/p1/Фаза — завершённая.md", "title: Фаза — завершённая\nauthor: boris\ntype: проект\nstatus: завершена\n");
    const [text] = build();
    expect(text).toContain("[[Описание p1]]");
    expect(text).not.toContain("[[Фаза — завершённая]]");
  });

  it("resolveProjectDir unit cases", () => {
    fs.mkdirSync(path.join(proot, "foo"));
    expect(resolveProjectDir("/vault/03_Проекты/foo/Описание - foo.md", proot, TAXONOMY_RU))
      .toEqual([path.join(proot, "foo"), "foo"]);
    expect(resolveProjectDir("/vault/03_Проекты/bar/Описание - bar.md", proot, TAXONOMY_RU)).toBeNull();
    expect(resolveProjectDir("/vault/01_Знания/foo.md", proot, TAXONOMY_RU)).toBeNull();
    expect(resolveProjectDir("/vault/03_Проекты/foo.md", proot, TAXONOMY_RU)).toBeNull();
    expect(resolveProjectDir("", proot, TAXONOMY_RU)).toBeNull();
  });

  it("resolveProjectDir: dir: in the Overview is the source of truth (ADR-014)", () => {
    // a project living OUTSIDE projectsRoot, declared via dir:
    const custom = path.join(tmpdir, "elsewhere", "ext-code");
    fs.mkdirSync(custom, { recursive: true });
    writeNote(
      "03_Проекты/ext/Описание ext.md",
      `title: Описание ext\nauthor: boris\ntype: проект\nstatus: активный\ndir: ${custom}\n`,
    );
    const phasePath = path.join(vault, "03_Проекты", "ext", "Фаза — х.md");
    expect(resolveProjectDir(phasePath, proot, TAXONOMY_RU)).toEqual([custom, "ext"]);

    // ~-relative dir expands against HOME
    const savedHome = process.env.HOME;
    try {
      process.env.HOME = tmpdir;
      fs.mkdirSync(path.join(tmpdir, "code", "tilde-proj"), { recursive: true });
      writeNote(
        "03_Проекты/tilde/Описание tilde.md",
        "title: Описание tilde\nauthor: boris\ntype: проект\nstatus: активный\ndir: ~/code/tilde-proj\n",
      );
      expect(
        resolveProjectDir(path.join(vault, "03_Проекты", "tilde", "x.md"), proot, TAXONOMY_RU),
      ).toEqual([path.join(tmpdir, "code", "tilde-proj"), "tilde"]);
    } finally {
      process.env.HOME = savedHome;
    }

    // declared path gone → convention fallback still works (no migration needed)
    fs.mkdirSync(path.join(proot, "moved"));
    writeNote(
      "03_Проекты/moved/Описание moved.md",
      "title: Описание moved\nauthor: boris\ntype: проект\nstatus: активный\ndir: /nonexistent/moved\n",
    );
    expect(
      resolveProjectDir(path.join(vault, "03_Проекты", "moved", "x.md"), proot, TAXONOMY_RU),
    ).toEqual([path.join(proot, "moved"), "moved"]);

    // declared gone + no convention dir → graceful null
    writeNote(
      "03_Проекты/lost/Описание lost.md",
      "title: Описание lost\nauthor: boris\ntype: проект\nstatus: активный\ndir: /nonexistent/lost\n",
    );
    expect(
      resolveProjectDir(path.join(vault, "03_Проекты", "lost", "x.md"), proot, TAXONOMY_RU),
    ).toBeNull();
  });

  it("dir: drives the H3 project-group path end-to-end through buildOutput", () => {
    const custom = path.join(tmpdir, "custom-layout", "myproj");
    fs.mkdirSync(custom, { recursive: true });
    writeNote(
      "03_Проекты/myproj/Описание myproj.md",
      `title: Описание myproj\nauthor: boris\ntype: проект\nstatus: активный\ndir: ${custom}\n`,
    );
    const [text] = build();
    expect(text).toContain(`### myproj — ${custom}/`);
  });

  it("dir in the H3 header, not on note lines", () => {
    fs.mkdirSync(path.join(proot, "foo"));
    writeNote("03_Проекты/foo/Описание - foo.md", "title: Описание - foo\nauthor: boris\ntype: проект\nstatus: актуально\n");
    const [text] = build();
    expect(text).toContain(`### foo — ${path.join(proot, "foo")}/`);
    expect(text).not.toContain("· dir:");
    expect(text).not.toContain("identity: claude-");
  });

  it("graceful no-op when the working dir is missing", () => {
    writeNote("03_Проекты/foo/Описание - foo.md", "title: Описание - foo\nauthor: boris\ntype: проект\nstatus: актуально\n");
    const [text] = build();
    expect(text).toContain("[[Описание - foo]]");
    expect(text).not.toContain("### foo —");
  });

  it("non-project note never gets a dir/group", () => {
    fs.mkdirSync(path.join(proot, "X"));
    writeNote("01_Знания/X.md", "title: X\nauthor: boris\ntype: знание\nstatus: актуально\n");
    const [text] = build();
    expect(text).toContain("[[X]]");
    expect(text).not.toContain("· dir:");
    expect(text).not.toContain("### X —");
  });

  it("project intra-sort: Overview → Plan → Phases by phase order; STALE filtered", () => {
    fs.mkdirSync(path.join(proot, "proj"));
    const notes: Array<[string, string]> = [
      ["Фаза — отменённая", "отменена"],
      ["Фаза — завершённая", "завершена"],
      ["Фаза — на паузе", "на паузе"],
      ["Фаза — активная", "активная"],
      ["Фаза — запланированная", "запланирована"],
      ["План proj", "активный"],
      ["Описание proj", "активный"],
    ];
    for (const [title, status] of notes) {
      writeNote(`03_Проекты/proj/${title}.md`, `title: ${title}\nauthor: boris\ntype: проект\nstatus: ${status}\n`);
    }
    const [text] = build();
    const order = ["Описание proj", "План proj", "Фаза — запланированная", "Фаза — активная", "Фаза — на паузе"];
    const positions = order.map((t) => text.indexOf(`[[${t}]]`));
    for (const p of positions) expect(p).toBeGreaterThan(-1);
    for (let i = 1; i < positions.length; i++) {
      expect(positions[i]!).toBeGreaterThan(positions[i - 1]!);
    }
    expect(text).not.toContain("[[Фаза — завершённая]]");
    expect(text).not.toContain("[[Фаза — отменённая]]");
  });
});

// ── acceptance smokes ────────────────────────────────────────────────────────

for (const locale of ["ru", "en"] as LocaleId[]) {
  const T = getTaxonomy(locale);
  const ctx: RenderContext = { taxonomy: T, ranking: { ...DEFAULT_RANKING } };

  describe(`smoke: render on a test vault [${locale}]`, () => {
    let tmpdir: string;
    let vault: string;

    beforeEach(() => {
      tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), `iapeer-memory-rsmoke-${locale}-`));
      vault = path.join(tmpdir, "vault");
      fs.mkdirSync(vault, { recursive: true });
    });

    afterEach(() => fs.rmSync(tmpdir, { recursive: true, force: true }));

    function writeNote(rel: string, frontmatter: string, body = ""): void {
      const full = path.join(vault, rel);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, `---\n${frontmatter}---\n${body}`, "utf-8");
    }

    it("renders capped + full files atomically with locale strings", () => {
      const ACTIVE = T.statusTokens.current;
      writeNote(
        `${T.folders.knowledge}/Заметка.md`,
        `title: Заметка\nauthor: boris\ntype: ${T.types.knowledge}\nstatus: ${ACTIVE}\n`,
      );
      writeNote(
        `${T.folders.agentMemory}/boris/Памятка.md`,
        `title: Памятка\nauthor: boris\ntype: ${T.types.agentMemory}\nsubtype: ${T.subtypes.pitfall}\nstatus: ${ACTIVE}\ndescription: тест\n`,
      );
      const outFile = path.join(tmpdir, "boris-vault-index.md");
      const { total, truncated } = regenerateVaultIndex({
        vault, agent: "boris", outFile, ctx, projectsRoot: path.join(tmpdir, "projects"),
      });
      expect(total).toBe(2);
      expect(truncated).toBe(false);
      const text = fs.readFileSync(outFile, "utf-8");
      expect(text).toContain(`# ${T.indexStrings.header} \`boris\``);
      expect(text).toContain(`## ${T.indexStrings.sections.agentMemory} — \`${T.folders.agentMemory}/boris/\``);
      expect(text).toContain(`## ${T.indexStrings.sections.knowledge} — \`${T.folders.knowledge}/\``);
      expect(text).toContain("[[Заметка]]");
      expect(text).toContain("[[Памятка]]");
      // Empty sections are still rendered (full structure picture).
      expect(text).toContain(T.indexStrings.emptySection);
      // The full twin exists next to the capped file.
      expect(fs.existsSync(path.join(tmpdir, "boris-vault-index-full.md"))).toBe(true);
    });
  });

  describe(`smoke: boost-bucket order ≡ memory_search order [${locale}]`, () => {
    it("index buckets and search ranking agree on the same corpus (one config source)", async () => {
      const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), `iapeer-memory-sync-${locale}-`));
      try {
        const vault = path.join(tmpdir, "vault");
        fs.mkdirSync(vault, { recursive: true });
        const K = T.folders.knowledge;
        const ACTIVE = T.statusTokens.current;
        const PENDING = T.statuses.pending[0]; // draft / черновик
        const STALE = T.statuses.stale[0]; // outdated / устарело
        const body = "Одинаковый текст про настройку синхронного поиска.";
        const w = (name: string, status: string) => {
          const full = path.join(vault, K, `${name}.md`);
          fs.mkdirSync(path.dirname(full), { recursive: true });
          fs.writeFileSync(
            full,
            `---\ntitle: ${name}\nauthor: boris\ntype: ${T.types.knowledge}\nstatus: ${status}\n---\n\n${body}\n`,
            "utf-8",
          );
        };
        w("Активная", ACTIVE);
        w("Ожидающая", PENDING);
        w("Устаревшая", STALE);

        const config = {
          vaultPath: vault, locale, taxonomy: T,
          ranking: { ...DEFAULT_RANKING },
          curatorSet: ["index", "scriber", "dreamweaver"],
          callerAgent: null,
          excludeFolders: defaultExcludeFolders(T),
          search: { chunkSize: 500, chunkOverlap: 80, maxResults: 6, rrfK: 60 },
          index: { dbPath: path.join(tmpdir, "i.db"), fullScanOnStartup: true },
    batch: { curatorMs: 6 * 3600_000 },
    mcp: { port: 0 },
          embedding: null, reranker: null,
        };
        const db = openDatabase(config);
        await indexAll({ db, config, logger: { info: () => {}, warn: () => {}, error: () => {} } });

        // Search order on identical bodies = boost buckets: active > pending > stale.
        const { results } = await runVaultSearch({ db, config, query: "синхронного поиска настройку" });
        const nfd = (x: string) => x.normalize("NFD");
        const sIdx = (name: string) =>
          results.findIndex((r) => nfd(r.path).endsWith(nfd(`${name}.md`)));
        expect(sIdx("Активная")).toBeGreaterThanOrEqual(0);
        expect(sIdx("Активная")).toBeLessThan(sIdx("Ожидающая"));
        expect(sIdx("Ожидающая")).toBeLessThan(sIdx("Устаревшая"));
        db.close();

        // Index render on the SAME corpus: active bucket above pending,
        // stale excluded entirely — same groups, same source config.
        const { notes, incomingCount } = collectNotes(vault, ctx);
        const mine = filterAgentNotes(notes, incomingCount, "boris", ctx);
        const [text] = buildOutput(mine, "boris", { ctx, projectsRoot: tmpdir });
        const iIdx = (name: string) => text.indexOf(`[[${name}]]`);
        expect(iIdx("Активная")).toBeGreaterThan(-1);
        expect(iIdx("Ожидающая")).toBeGreaterThan(-1);
        expect(iIdx("Активная")).toBeLessThan(iIdx("Ожидающая"));
        expect(iIdx("Устаревшая")).toBe(-1); // STALE: out of the index, search-only
      } finally {
        fs.rmSync(tmpdir, { recursive: true, force: true });
      }
    });
  });
}
