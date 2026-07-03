/**
 * Parity tests for src/frontmatter-fill.ts — translation of the reference
 * `tests/python/test_frontmatter_fill.py` (73 fixtures), parametrised over
 * BOTH taxonomy locales where behaviour touches folder/enum tokens
 * (ADR-002/011). Deliberate ADR deviations from the reference are tested in
 * the dedicated `curator-set (ADR-006)` block.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import matter from "gray-matter";

import {
  hasField,
  upsert,
  setIfMissing,
  splitFrontmatter,
  basenameNoExt,
  parseMemoryAuthor,
  resolveZone,
  fillPermanentFull,
  fillMemory,
  stripEmptyArrays,
  isCleanDoubleQuoted,
  isCleanSingleQuoted,
  yamlNeedsQuoting,
  yamlDoubleQuote,
  stripBrokenDelims,
  normalizeScalarValue,
  normalizeFields,
  normalizeAllScalars,
  normalizeLinksBlock,
  readScalar,
  parseListField,
  addCoauthor,
  processFile,
  resolveAgentName,
  moveServiceFieldsToEnd,
  type FillContext,
} from "../src/frontmatter-fill.js";
import { TAXONOMY_EN, TAXONOMY_RU, type TaxonomyPreset } from "../src/taxonomy.js";

const FIXED_NOW = new Date(2026, 4, 15, 12, 30, 0);

function ctx(taxonomy: TaxonomyPreset): FillContext {
  return { taxonomy };
}

// ── Pure helpers (locale-independent) ──────────────────────────────────────

describe("moveServiceFieldsToEnd (service-trio frontmatter convention)", () => {
  it("moves the service trio to the end in canonical order", () => {
    const fm =
      "title: X\nlast_edited_by: boris\nstatus: актуально\nupdated: 2026-06-16 12:00:00\nauthor: linus\nneeds_review: false\n";
    const out = moveServiceFieldsToEnd(fm);
    expect(out).toBe(
      "title: X\nstatus: актуально\nauthor: linus\nlast_edited_by: boris\nupdated: 2026-06-16 12:00:00\nneeds_review: false\n",
    );
  });

  it("preserves a block-list field and its items (structural safety)", () => {
    const fm =
      "title: X\nupdated: 2026-06-16 12:00:00\ntags:\n  - Память\n  - LLM\nneeds_review: true\nauthor: boris\n";
    const out = moveServiceFieldsToEnd(fm);
    // tags block intact and before the trailing service fields; non-service order kept
    expect(out).toBe(
      "title: X\ntags:\n  - Память\n  - LLM\nauthor: boris\nupdated: 2026-06-16 12:00:00\nneeds_review: true\n",
    );
  });

  it("no service fields → returned unchanged", () => {
    const fm = "title: X\nauthor: boris\n";
    expect(moveServiceFieldsToEnd(fm)).toBe(fm);
  });
});

describe("pure helpers", () => {
  it("hasField: present", () => {
    expect(hasField("title: X\nauthor: Y\n", "title")).toBe(true);
    expect(hasField("title: X\nauthor: Y\n", "author")).toBe(true);
  });

  it("hasField: absent", () => {
    expect(hasField("title: X\n", "author")).toBe(false);
  });

  it("upsert inserts when absent", () => {
    const result = upsert("title: X\n", "author", "boris");
    expect(result).toContain("title: X");
    expect(result).toContain("author: boris");
  });

  it("upsert replaces when present", () => {
    const result = upsert("author: old\nother: Z\n", "author", "new");
    expect(result).toContain("author: new");
    expect(result).not.toContain("author: old");
    expect(result).toContain("other: Z");
  });

  it("setIfMissing skips existing", () => {
    const result = setIfMissing("author: original\n", "author", "new");
    expect(result).toContain("author: original");
    expect(result).not.toContain("author: new");
  });

  it("setIfMissing inserts when absent", () => {
    expect(setIfMissing("title: X\n", "author", "boris")).toContain("author: boris");
  });

  it("splitFrontmatter with block", () => {
    const [fm, rest] = splitFrontmatter("---\ntitle: X\n---\n\nBody\n");
    expect(fm).toContain("title: X");
    expect(rest).toContain("Body");
  });

  it("splitFrontmatter without block", () => {
    const [fm, rest] = splitFrontmatter("Plain text only\n");
    expect(fm).toBe("");
    expect(rest).toBe("Plain text only\n");
  });

  it("basenameNoExt", () => {
    expect(basenameNoExt("/path/to/Заметка.md")).toBe("Заметка");
    expect(basenameNoExt("noext")).toBe("noext");
  });
});

// ── Locale-parametrised behaviour (ADR-002/011) ─────────────────────────────

for (const T of [TAXONOMY_RU, TAXONOMY_EN]) {
  const L = T.locale;
  const F = T.folders;

  describe(`parseMemoryAuthor [${L}] — author from path, not from caller`, () => {
    it("valid memory path", () => {
      expect(
        parseMemoryAuthor(`/vault/${F.agentMemory}/boris/feedback_x.md`, "/vault", T),
      ).toBe("boris");
    });

    it("path outside memory returns null", () => {
      expect(parseMemoryAuthor(`/vault/${F.knowledge}/X.md`, "/vault", T)).toBeNull();
    });

    it("path without owner subfolder returns null", () => {
      expect(parseMemoryAuthor(`/vault/${F.agentMemory}/X.md`, "/vault", T)).toBeNull();
    });
  });

  describe(`fillPermanentFull [${L}]`, () => {
    const KPATH = `/vault/${F.knowledge}/X.md`;
    const VAULT = "/vault";
    const TODAY = "2026-06-15";

    it("flag model: the index's clearing of needs_review SURVIVES its attribution pass", () => {
      // The index unsets the flag as the last curation step; being
      // curator-set, its stamping must not re-introduce it (ADR-006). It also
      // never authors content (fork-1, §3a) — author: linus is preserved.
      const fm = fillPermanentFull("title: X\nauthor: linus\n", {
        path: KPATH,
        agent: "index",
        vault: VAULT,
        today: TODAY,
        nowStamp: "2026-06-10 12:00",
        ctx: ctx(T),
      });
      expect(fm).toContain("needs_review: false");
      expect(fm).toContain("last_edited_by: index");
      expect(fm).toContain("author: linus");
    });

    it("full canon fill: title + folder-genre type/status + author + stamp (lean §2.1)", () => {
      const fm = fillPermanentFull("", {
        path: KPATH,
        agent: "boris",
        vault: VAULT,
        today: TODAY,
        nowStamp: "2026-05-15 12:30",
        ctx: ctx(T),
      });
      expect(fm).toContain("title: X");
      expect(fm).toContain(`type: ${T.types.knowledge}`);
      expect(fm).toContain(`status: ${T.initialStatus.knowledge}`);
      expect(fm).toContain("created: 2026-06-15");
      expect(fm).toContain("author: boris");
      expect(fm).toContain("last_edited_by: boris");
      expect(fm).toContain("updated: 2026-05-15 12:30");
      expect(fm).toContain("needs_review: true");
    });

    it("type/status follow the FOLDER genre, not a constant (decision → accepted)", () => {
      const fm = fillPermanentFull("", {
        path: `/vault/${F.decisions}/D.md`,
        agent: "boris",
        vault: VAULT,
        today: TODAY,
        nowStamp: "2026-05-15 12:30",
        ctx: ctx(T),
      });
      expect(fm).toContain(`type: ${T.types.decision}`);
      expect(fm).toContain(`status: ${T.initialStatus.decision}`);
    });

    it("setIfMissing preserves explicit author/type/status/created (re-edit no-op)", () => {
      const fm = fillPermanentFull(
        "title: X\nauthor: linus\ntype: sometype\nstatus: somestatus\ncreated: 2020-01-01\n",
        { path: KPATH, agent: "boris", vault: VAULT, today: TODAY, nowStamp: "2026-05-15 12:30", ctx: ctx(T) },
      );
      expect(fm).toContain("author: linus");
      expect(fm).toContain("type: sometype");
      expect(fm).toContain("status: somestatus"); // a stale-marked note keeps its status
      expect(fm).toContain("created: 2020-01-01");
    });

    it("index gets no needs_review and never becomes author", () => {
      const fm = fillPermanentFull("", {
        path: KPATH,
        agent: "index",
        vault: VAULT,
        today: TODAY,
        nowStamp: "2026-05-15 12:30",
        ctx: ctx(T),
      });
      expect(fm).toContain("needs_review: false");
      expect(fm).not.toMatch(/(^|\n)author:/);
    });

    it("overwrites stale last_edited_by", () => {
      const fm = fillPermanentFull("last_edited_by: old\nupdated: 2024-01-01 00:00\n", {
        path: KPATH,
        agent: "boris",
        vault: VAULT,
        today: TODAY,
        nowStamp: "2026-05-15 12:30",
        ctx: ctx(T),
      });
      expect(fm).toContain("last_edited_by: boris");
      expect(fm).not.toContain("last_edited_by: old");
    });
  });

  describe(`fillMemory [${L}]`, () => {
    it("basic", () => {
      const fm = fillMemory("", {
        path: `/vault/${F.agentMemory}/boris/feedback_x.md`,
        agent: "boris",
        vault: "/vault",
        today: "2026-05-15",
        nowStamp: "2026-05-15 12:30",
        ctx: ctx(T),
      });
      expect(fm).toContain("title: feedback_x");
      expect(fm).toContain(`type: ${T.types.agentMemory}`);
      expect(fm).toContain(`status: ${T.statusTokens.current}`);
      expect(fm).toContain("created: 2026-05-15");
      expect(fm).toContain("author: boris");
      expect(fm).toContain("last_edited_by: boris");
      expect(fm).toContain("updated: 2026-05-15 12:30");
      expect(fm).toContain("needs_review: true");
    });

    it("dreamweaver-style write into foreign subfolder: author from path", () => {
      const fm = fillMemory("", {
        path: `/vault/${F.agentMemory}/linus/x.md`,
        agent: "index",
        vault: "/vault",
        today: "2026-05-15",
        nowStamp: "2026-05-15 12:30",
        ctx: ctx(T),
      });
      expect(fm).toContain("author: linus");
      expect(fm).toContain("last_edited_by: index");
      expect(fm).toContain("needs_review: false");
    });

    it("path outside structure returns null", () => {
      const fm = fillMemory("", {
        path: `/vault/${F.knowledge}/X.md`,
        agent: "boris",
        vault: "/vault",
        today: "2026-05-15",
        nowStamp: "2026-05-15 12:30",
        ctx: ctx(T),
      });
      expect(fm).toBeNull();
    });

    it("preserves explicit subtype and description (author's zone)", () => {
      const fm = fillMemory(`subtype: ${T.subtypes.pitfall}\ndescription: коротко\n`, {
        path: `/vault/${F.agentMemory}/boris/x.md`,
        agent: "boris",
        vault: "/vault",
        today: "2026-05-15",
        nowStamp: "2026-05-15 12:30",
        ctx: ctx(T),
      });
      expect(fm).toContain(`subtype: ${T.subtypes.pitfall}`);
      expect(fm).toContain("description: коротко");
    });
  });

  describe(`resolveZone [${L}]`, () => {
    it("permanent folders", () => {
      for (const folder of [F.knowledge, F.decisions, F.projects, F.ideas, F.lists]) {
        expect(resolveZone(`/v/${folder}/sub/x.md`, "/v", T)).toBe("permanent");
      }
    });

    it("memory — exact folder name required", () => {
      expect(resolveZone(`/v/${F.agentMemory.slice(0, -2)}xx/x.md`, "/v", T)).toBeNull();
      expect(resolveZone(`/v/${F.agentMemory}/boris/x.md`, "/v", T)).toBe("memory");
    });

    it("outside whitelist", () => {
      expect(resolveZone(`/v/${F.system}/${T.systemFiles.tagsDictionary}`, "/v", T)).toBeNull();
      expect(resolveZone(`/v/${F.archive}/${F.knowledge}/x.md`, "/v", T)).toBeNull();
    });

    it("outside vault", () => {
      expect(resolveZone(`/other/${F.knowledge}/x.md`, "/v", T)).toBeNull();
    });

    it("no vault", () => {
      expect(resolveZone(`/v/${F.knowledge}/x.md`, "", T)).toBeNull();
    });
  });

  describe(`processFile integration [${L}]`, () => {
    let tmpdir: string;
    let vault: string;

    beforeEach(() => {
      tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), "iapeer-memory-fill-"));
      vault = path.join(tmpdir, "vault");
      fs.mkdirSync(vault);
    });

    afterEach(() => {
      fs.rmSync(tmpdir, { recursive: true, force: true });
    });

    function writeFile(rel: string, content: string): string {
      const full = path.join(vault, rel);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, content, "utf-8");
      return full;
    }

    function run(p: string, zone: "permanent" | "memory" | "auto", agent: string, vaultArg = vault): boolean {
      return processFile(p, { zone, agent, vault: vaultArg, now: FIXED_NOW, taxonomy: T });
    }

    it("permanent fills full canon frontmatter from a bare body", () => {
      const p = writeFile(`${F.knowledge}/Заметка.md`, "Body only\n");
      expect(run(p, "permanent", "boris")).toBe(true);
      const text = fs.readFileSync(p, "utf-8");
      expect(text).toContain("title: Заметка");
      expect(text).toContain(`type: ${T.types.knowledge}`); // type from folder
      expect(text).toContain(`status: ${T.initialStatus.knowledge}`);
      expect(text).toContain("created: 2026-05-15");
      expect(text).toContain("author: boris");
      expect(text).toContain("last_edited_by: boris");
      expect(text).toContain("updated: 2026-05-15 12:30:00");
      expect(text).toContain("Body only");
    });

    it("permanent upserts service fields with second precision", () => {
      const p = writeFile(`${F.knowledge}/X.md`, "---\ntitle: X\nauthor: linus\n---\nBody\n");
      expect(run(p, "permanent", "boris")).toBe(true);
      const text = fs.readFileSync(p, "utf-8");
      expect(text).toContain("last_edited_by: boris");
      // Explicit `:00` — a substring like «12:30» would match the legacy
      // minute format too and let a format regression pass unnoticed.
      expect(text).toContain("updated: 2026-05-15 12:30:00");
      expect(text).toContain("needs_review: true");
    });

    it("ZERO-indent tags survive processFile as parseable YAML (audit critical #5 worst case)", () => {
      // Pre-fix: stripEmptyArrays deleted the `tags:` key, orphaning the
      // zero-indent items → js-yaml threw → the note NEVER reached the index.
      const p = writeFile(
        `${F.knowledge}/Z.md`,
        "---\ntitle: Z\ntags:\n- security\n- ops\n---\nBody\n",
      );
      run(p, "permanent", "boris"); // fills the rest of the canon frontmatter
      const text = fs.readFileSync(p, "utf-8");
      const parsed = matter(text); // must not throw
      expect(parsed.data.tags).toEqual(["security", "ops"]);
    });

    it("memory: curator writes foreign subfolder, author parsed from path", () => {
      const p = writeFile(
        `${F.agentMemory}/linus/Грабли.md`,
        `---\nsubtype: ${T.subtypes.pitfall}\ndescription: test\n---\nBody\n`,
      );
      expect(run(p, "memory", "index")).toBe(true);
      const text = fs.readFileSync(p, "utf-8");
      expect(text).toContain("author: linus");
      expect(text).toContain("last_edited_by: index");
      expect(text).toContain(`subtype: ${T.subtypes.pitfall}`);
    });

    it("idempotent no-op when already filled (stamp pair included)", () => {
      const p = writeFile(
        `${F.knowledge}/N.md`,
        `---\ntitle: N\ntype: ${T.types.knowledge}\nstatus: ${T.initialStatus.knowledge}\ncreated: 2026-05-15\nauthor: boris\nlast_edited_by: boris\nupdated: 2026-05-15 12:30:00\nneeds_review: true\n---\n\nBody\n`,
      );
      const original = fs.readFileSync(p, "utf-8");
      expect(run(p, "permanent", "boris")).toBe(false);
      expect(fs.readFileSync(p, "utf-8")).toBe(original);
    });

    it("normalizes missing blank line after frontmatter", () => {
      const p = writeFile(
        `${F.knowledge}/N.md`,
        `---\ntitle: N\ntype: ${T.types.knowledge}\nstatus: ${T.initialStatus.knowledge}\ncreated: 2026-05-15\nauthor: boris\n---\nBody\n`,
      );
      expect(run(p, "permanent", "boris")).toBe(true);
      expect(fs.readFileSync(p, "utf-8")).toContain("---\n\nBody");
    });

    it("invalid zone skipped", () => {
      const p = writeFile(`${F.knowledge}/x.md`, "body\n");
      expect(
        processFile(p, {
          // deliberately invalid — runtime guard, cast past the type
          zone: "invalid_zone" as never,
          agent: "boris",
          vault,
          now: FIXED_NOW,
          taxonomy: T,
        }),
      ).toBe(false);
    });

    it("missing agent skipped", () => {
      const p = writeFile(`${F.knowledge}/x.md`, "body\n");
      expect(run(p, "permanent", "")).toBe(false);
    });

    it("missing file skipped", () => {
      expect(run(path.join(vault, `${F.knowledge}/nope.md`), "permanent", "boris")).toBe(false);
    });

    it("auto resolves permanent", () => {
      const p = writeFile(`${F.knowledge}/X.md`, "---\ntitle: X\nauthor: linus\n---\nBody\n");
      expect(run(p, "auto", "boris")).toBe(true);
      const text = fs.readFileSync(p, "utf-8");
      expect(text).toContain("last_edited_by: boris");
      expect(text).toContain("updated: 2026-05-15 12:30:00");
      expect(text).toContain("needs_review: true");
    });

    it("auto: index bash-path attribution (echo-agent signal)", () => {
      const p = writeFile(
        `${F.knowledge}/X.md`,
        "---\ntitle: X\nauthor: linus\nlast_edited_by: artur\n---\nBody\n",
      );
      expect(run(p, "auto", "index")).toBe(true);
      const text = fs.readFileSync(p, "utf-8");
      expect(text).toContain("last_edited_by: index");
      expect(text).not.toContain("last_edited_by: artur");
      expect(text).toContain("updated: 2026-05-15 12:30:00");
      expect(text).toContain("needs_review: false");
    });

    it("auto resolves memory", () => {
      const p = writeFile(`${F.agentMemory}/boris/Грабли.md`, "---\ntitle: Грабли\n---\nBody\n");
      expect(run(p, "auto", "index")).toBe(true);
      const text = fs.readFileSync(p, "utf-8");
      expect(text).toContain(`type: ${T.types.agentMemory}`);
      expect(text).toContain("author: boris"); // from subfolder, not caller
    });

    it("auto outside whitelist is a no-op", () => {
      const p = writeFile(`${F.system}/${T.systemFiles.tagsDictionary}`, "---\ntitle: Теги\n---\nx\n");
      const before = fs.readFileSync(p, "utf-8");
      expect(run(p, "auto", "boris")).toBe(false);
      expect(fs.readFileSync(p, "utf-8")).toBe(before);
    });

    it("auto without vault is a no-op", () => {
      const p = writeFile(`${F.knowledge}/X.md`, "---\ntitle: X\n---\nBody\n");
      expect(run(p, "auto", "boris", "")).toBe(false);
    });
  });
}

// ── stripEmptyArrays (locale-independent) ───────────────────────────────────

describe("stripEmptyArrays", () => {
  it("strips block-form empty", () => {
    expect(stripEmptyArrays("tags:\nstatus: x\n")).toBe("status: x\n");
  });

  it("strips inline empty", () => {
    expect(stripEmptyArrays("tags: []\nstatus: x\n")).toBe("status: x\n");
  });

  it("strips null", () => {
    expect(stripEmptyArrays("tags: null\nstatus: x\n")).toBe("status: x\n");
  });

  it("strips tilde", () => {
    expect(stripEmptyArrays("tags: ~\nstatus: x\n")).toBe("status: x\n");
  });

  it("keeps list with items", () => {
    const fm = "tags:\n  - foo\n  - bar\nstatus: x\n";
    expect(stripEmptyArrays(fm)).toBe(fm);
  });

  it("keeps inline list with items", () => {
    const fm = "tags: [foo, bar]\nstatus: x\n";
    expect(stripEmptyArrays(fm)).toBe(fm);
  });

  it("strips empty coauthors", () => {
    expect(stripEmptyArrays("title: x\ncoauthors:\nstatus: y\n")).toBe("title: x\nstatus: y\n");
  });

  it("keeps coauthors with items", () => {
    const fm = "title: x\ncoauthors:\n  - boris\nstatus: y\n";
    expect(stripEmptyArrays(fm)).toBe(fm);
  });

  it("strips both empty adjacent", () => {
    expect(stripEmptyArrays("tags:\ncoauthors:\ntitle: x\n")).toBe("title: x\n");
  });

  it("strips one, keeps the other", () => {
    expect(stripEmptyArrays("tags:\ncoauthors:\n  - boris\ntitle: x\n")).toBe(
      "coauthors:\n  - boris\ntitle: x\n",
    );
  });

  it("other keys untouched", () => {
    const fm = "title:\nstatus:\nauthor: boris\n";
    expect(stripEmptyArrays(fm)).toBe(fm);
  });

  it("idempotent", () => {
    const once = stripEmptyArrays("tags:\ncoauthors: []\nstatus: x\n");
    expect(stripEmptyArrays(once)).toBe(once);
  });

  // ── zero-indent block lists (audit critical #5) ──
  // `tags:\n- security` is valid YAML (PyYAML's default serialisation).
  // Deleting the key while its items stay behind orphans the items →
  // js-yaml throws → the note silently drops out of the index.

  it("keeps a key whose items are at ZERO indent", () => {
    const fm = "tags:\n- security\n- ops\nstatus: x\n";
    expect(stripEmptyArrays(fm)).toBe(fm);
  });

  it("keeps a key whose first item follows a blank line", () => {
    const fm = "tags:\n\n  - security\nstatus: x\n";
    expect(stripEmptyArrays(fm)).toBe(fm);
  });

  it("still strips a genuinely empty key followed by a blank line", () => {
    expect(stripEmptyArrays("tags:\n\nstatus: x\n")).toBe("\nstatus: x\n");
  });

  it("processFile strips empty coauthors (integration)", () => {
    const td = fs.mkdtempSync(path.join(os.tmpdir(), "iapeer-memory-strip-"));
    try {
      const p = path.join(td, TAXONOMY_RU.folders.knowledge, "x.md");
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(
        p,
        "---\ntitle: x\ntype: знание\ntags:\n  - Память\nstatus: актуально\n" +
          "created: 2026-05-20\nauthor: artur\ncoauthors:\n---\n\n# x\n",
        "utf-8",
      );
      processFile(p, {
        zone: "permanent",
        agent: "index",
        vault: td,
        now: new Date(2026, 4, 20, 12, 0, 0),
        taxonomy: TAXONOMY_RU,
      });
      const text = fs.readFileSync(p, "utf-8");
      expect(text).not.toContain("coauthors:");
      expect(text).toContain("tags:"); // non-empty tags stay
    } finally {
      fs.rmSync(td, { recursive: true, force: true });
    }
  });
});

// ── YAML scalar helpers ─────────────────────────────────────────────────────

describe("yaml scalar helpers", () => {
  it("isCleanDoubleQuoted", () => {
    expect(isCleanDoubleQuoted('"foo"')).toBe(true);
    expect(isCleanDoubleQuoted('"a\\"b"')).toBe(true);
    expect(isCleanDoubleQuoted('"foo')).toBe(false); // unterminated
    expect(isCleanDoubleQuoted('"a\\"')).toBe(false); // closing quote escaped
    expect(isCleanDoubleQuoted("foo")).toBe(false);
  });

  it("isCleanSingleQuoted", () => {
    expect(isCleanSingleQuoted("'foo'")).toBe(true);
    expect(isCleanSingleQuoted("'a''b'")).toBe(true);
    expect(isCleanSingleQuoted("'foo")).toBe(false); // dangling
    expect(isCleanSingleQuoted("foo")).toBe(false);
  });

  it("yamlNeedsQuoting: true cases", () => {
    for (const v of ["foo: bar", "foo:", "'висячая", "- item", "foo # bar", "\tтаб"]) {
      expect(yamlNeedsQuoting(v)).toBe(true);
    }
  });

  it("yamlNeedsQuoting: false cases", () => {
    for (const v of ["просто текст", "«ёлочки без двоеточия»", "2026-05-26 03:06:39", ""]) {
      expect(yamlNeedsQuoting(v)).toBe(false);
    }
  });

  it("yamlDoubleQuote escapes", () => {
    expect(yamlDoubleQuote("plain")).toBe('"plain"');
    expect(yamlDoubleQuote('a"b')).toBe('"a\\"b"');
    expect(yamlDoubleQuote("a\\b")).toBe('"a\\\\b"');
  });

  it("stripBrokenDelims", () => {
    expect(stripBrokenDelims("«foo: bar»")).toBe("foo: bar");
    expect(stripBrokenDelims("'висячая: x")).toBe("висячая: x");
    expect(stripBrokenDelims("plain: x")).toBe("plain: x");
  });
});

describe("normalizeScalarValue", () => {
  it("guillemets with colon requoted", () => {
    expect(normalizeScalarValue("«Запуск: фаза 1»")).toBe('"Запуск: фаза 1"');
  });

  it("guillemets without colon left as-is", () => {
    expect(normalizeScalarValue("«текст без двоеточия»")).toBeNull();
  });

  it("plain with colon requoted", () => {
    expect(normalizeScalarValue("ЗАКРЫТО: telegram-runtime")).toBe(
      '"ЗАКРЫТО: telegram-runtime"',
    );
  });

  it("dangling single quote requoted", () => {
    expect(normalizeScalarValue("'Сводно: cache-snapshot")).toBe(
      '"Сводно: cache-snapshot"',
    );
  });

  it("already quoted left", () => {
    expect(normalizeScalarValue('"Текст: с двоеточием"')).toBeNull();
    expect(normalizeScalarValue("'нормальный: текст'")).toBeNull();
  });

  it("safe / empty / block left", () => {
    expect(normalizeScalarValue("Просто текст")).toBeNull();
    expect(normalizeScalarValue("")).toBeNull();
    expect(normalizeScalarValue("|")).toBeNull();
    expect(normalizeScalarValue(">")).toBeNull();
  });

  it("inner double quotes escaped", () => {
    expect(normalizeScalarValue('«Цитата "X": детали»')).toBe(
      '"Цитата \\"X\\": детали"',
    );
  });

  it("live-failure class (writerd 06.2026): long handoff-style value — guillemets + leading colon segment", () => {
    // Синтетический эквивалент двух реально падавших заметок прод-vault
    // (класс «ёлочки + двоеточие», длинное многосегментное значение).
    // Проверено против живых файлов read-only: нормализатор чинит 2/2.
    const v = "«Handoff: статус работ. Сделано/запушено, gate СНЯТ, осталось: протокол. Волна 08.06»";
    const out = normalizeScalarValue(v);
    expect(out).toBe('"Handoff: статус работ. Сделано/запушено, gate СНЯТ, осталось: протокол. Волна 08.06"');
  });
});

describe("normalizeFields", () => {
  it("normalizes only whitelisted keys", () => {
    const fm = "title: foo: bar\ndescription: «a: b»\nstatus: x\n";
    const out = normalizeFields(fm);
    expect(out).toContain('description: "a: b"');
    expect(out).toContain("title: foo: bar");
  });

  it("idempotent", () => {
    const once = normalizeFields("description: «a: b»\n");
    expect(once).toBe('description: "a: b"\n');
    expect(normalizeFields(once)).toBe(once);
  });

  it("dangling quote recovers following fields", () => {
    const fm =
      "subtype: справка\n" +
      "description: 'Сводно: cache-snapshot\n" +
      "last_edited_by: index\n" +
      "author: boris\n";
    const out = normalizeFields(fm);
    expect(out).toContain('description: "Сводно: cache-snapshot"');
    expect(out).toContain("last_edited_by: index");
    expect(out).toContain("author: boris");
  });

  it("no-op when clean", () => {
    const fm = "title: x\nstatus: актуально\n";
    expect(normalizeFields(fm)).toBe(fm);
  });
});

describe("normalizeAllScalars (lean §2.2 — YAML-safety on every scalar)", () => {
  it("quotes a colon-bearing title/author, not just description", () => {
    const fm = "title: Слот памяти: контракт\nauthor: boris\ndescription: «a: b»\n";
    const out = normalizeAllScalars(fm);
    expect(out).toContain('title: "Слот памяти: контракт"');
    expect(out).toContain('description: "a: b"');
    expect(out).toContain("author: boris");
  });

  it("leaves block-list fields (tags/coauthors) untouched", () => {
    const fm = "tags:\n  - Безопасность\n  - Память\ncoauthors:\n  - boris\ntitle: x\n";
    const out = normalizeAllScalars(fm);
    expect(out).toBe(fm);
  });

  it("does not corrupt the stamp (no colon-space in HH:MM:SS)", () => {
    const fm = "updated: 2026-06-15 12:30:00\ncreated: 2026-06-15\n";
    expect(normalizeAllScalars(fm)).toBe(fm);
  });

  it("idempotent", () => {
    const once = normalizeAllScalars("title: a: b\n");
    expect(once).toBe('title: "a: b"\n');
    expect(normalizeAllScalars(once)).toBe(once);
  });
});

describe("normalizeLinksBlock (lean §2.2 — parser recognises the block)", () => {
  const ru = TAXONOMY_RU;

  it("canonicalises a malformed heading (##Связи → ## Связи)", () => {
    const body = "##Связи\n- [[A]] — why\n\n---\n\nконтент";
    expect(normalizeLinksBlock(body, ru)).toBe("## Связи\n- [[A]] — why\n\n---\n\nконтент");
  });

  it("normalises a *** / ___ divider to --- so stripLinksSection cuts it", () => {
    const body = "## Связи\n- [[A]]\n***\nконтент";
    expect(normalizeLinksBlock(body, ru)).toBe("## Связи\n- [[A]]\n---\nконтент");
  });

  it("no-op when the body has no leading links heading", () => {
    const body = "# Заголовок\n\nтекст с [[inline]] ссылкой";
    expect(normalizeLinksBlock(body, ru)).toBe(body);
  });

  it("does not match a different heading that merely starts like Связи", () => {
    const body = "## Связанные системы\n\nтекст";
    expect(normalizeLinksBlock(body, ru)).toBe(body);
  });

  it("idempotent on an already-canonical block", () => {
    const body = "## Связи\n- [[A]] — why\n\n---\n\nтело";
    expect(normalizeLinksBlock(body, ru)).toBe(body);
  });

  it("leaves the body alone when a links heading has no divider (conservative)", () => {
    const body = "## Связи\n- [[A]]\nконтент без разделителя";
    expect(normalizeLinksBlock(body, ru)).toBe(body);
  });

  it("canonicalises a malformed TRAILING heading (##Связи → ## Связи)", () => {
    const body = "контент\n\n##Связи\n- [[A]] — why";
    expect(normalizeLinksBlock(body, ru)).toBe("контент\n\n## Связи\n- [[A]] — why");
  });

  it("idempotent on an already-canonical trailing block", () => {
    const body = "тело заметки\n\n## Связи\n- [[A]] — why";
    expect(normalizeLinksBlock(body, ru)).toBe(body);
  });

  it("does not touch a trailing bullet list with no links heading", () => {
    const body = "шаги:\n- первый\n- второй";
    expect(normalizeLinksBlock(body, ru)).toBe(body);
  });
});

describe("list/coauthor helpers (lean §3a)", () => {
  it("readScalar reads a value, null when absent", () => {
    expect(readScalar("author: linus\ntitle: X\n", "author")).toBe("linus");
    expect(readScalar("title: X\n", "author")).toBeNull();
  });

  it("parseListField reads block-list and inline forms", () => {
    expect(parseListField("coauthors:\n  - a\n  - b\ntitle: X\n", "coauthors")).toEqual(["a", "b"]);
    expect(parseListField('coauthors: [a, "b"]\n', "coauthors")).toEqual(["a", "b"]);
    expect(parseListField("title: X\n", "coauthors")).toEqual([]);
  });

  it("parseListField reads ZERO-indent block lists and stops at the next key (audit critical #5)", () => {
    expect(parseListField("coauthors:\n- a\n- b\ntitle: X\n", "coauthors")).toEqual(["a", "b"]);
  });

  it("addCoauthor does not orphan ZERO-indent items (removeListField at any indent)", () => {
    // Pre-fix removeListField skipped only INDENTED items: the key line died,
    // `- a` stayed behind orphaned → broken frontmatter on the coauthor path.
    const out = addCoauthor("author: linus\ncoauthors:\n- a\ntitle: X\n", "boris");
    expect(parseListField(out, "coauthors")).toEqual(["a", "boris"]);
    expect(out).not.toMatch(/^- a$/m); // no orphaned zero-indent leftover
  });

  it("addCoauthor appends, is idempotent, normalises to a block-list", () => {
    const once = addCoauthor("author: linus\n", "boris");
    expect(parseListField(once, "coauthors")).toEqual(["boris"]);
    expect(addCoauthor(once, "boris")).toBe(once); // idempotent
    expect(parseListField(addCoauthor(once, "darwin"), "coauthors")).toEqual(["boris", "darwin"]);
  });
});

describe("fillPermanentFull — §3a auto-coauthor (non-curator only)", () => {
  const ctxRu = { taxonomy: TAXONOMY_RU };
  const base = {
    path: `/v/${TAXONOMY_RU.folders.knowledge}/N.md`,
    vault: "/v",
    today: "2026-06-15",
    nowStamp: "2026-06-15 12:00:00",
  };

  it("non-curator editing a foreign-authored canon note → added to coauthors, author immutable", () => {
    const fm = fillPermanentFull("title: N\nauthor: linus\n", { ...base, agent: "boris", ctx: ctxRu });
    expect(readScalar(fm, "author")).toBe("linus"); // immutable
    expect(parseListField(fm, "coauthors")).toEqual(["boris"]);
  });

  it("a curator (index) editing a foreign canon note is NOT added to coauthors (fork-1)", () => {
    const fm = fillPermanentFull("title: N\nauthor: linus\n", { ...base, agent: "index", ctx: ctxRu });
    expect(parseListField(fm, "coauthors")).toEqual([]);
    expect(readScalar(fm, "author")).toBe("linus");
  });

  it("the author editing their OWN note → no coauthor", () => {
    const fm = fillPermanentFull("title: N\nauthor: boris\n", { ...base, agent: "boris", ctx: ctxRu });
    expect(parseListField(fm, "coauthors")).toEqual([]);
  });

  it("a new note (no author yet) → author=agent, no coauthor", () => {
    const fm = fillPermanentFull("", { ...base, agent: "boris", ctx: ctxRu });
    expect(readScalar(fm, "author")).toBe("boris");
    expect(parseListField(fm, "coauthors")).toEqual([]);
  });

  it("an existing coauthor editing again → no duplicate", () => {
    const fm = fillPermanentFull("title: N\nauthor: linus\ncoauthors:\n  - boris\n", {
      ...base,
      agent: "boris",
      ctx: ctxRu,
    });
    expect(parseListField(fm, "coauthors")).toEqual(["boris"]);
  });
});

describe("processFile normalizes description (integration)", () => {
  it("fixes guillemets+colon on the write path, preserves body and fields", () => {
    const td = fs.mkdtempSync(path.join(os.tmpdir(), "iapeer-memory-norm-"));
    try {
      const p = path.join(td, TAXONOMY_RU.folders.agentMemory, "boris", "x.md");
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(
        p,
        "---\nsubtype: справка\n" +
          "description: «Корень: двоеточие ломает YAML»\n---\n\nтело заметки\n",
        "utf-8",
      );
      processFile(p, {
        zone: "auto",
        agent: "boris",
        vault: td,
        now: new Date(2026, 5, 1, 12, 0, 0),
        taxonomy: TAXONOMY_RU,
      });
      const text = fs.readFileSync(p, "utf-8");
      expect(text).toContain('description: "Корень: двоеточие ломает YAML"');
      expect(text).not.toContain("«Корень");
      expect(text).toContain("тело заметки");
    } finally {
      fs.rmSync(td, { recursive: true, force: true });
    }
  });
});

// ── ADR deviations against the reference (deliberate) ───────────────────────

describe("curator-set (ADR-006) — deviation from reference `agent != index`", () => {
  let tmpdir: string;
  let vault: string;

  beforeEach(() => {
    tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), "iapeer-memory-curator-"));
    vault = path.join(tmpdir, "vault");
    fs.mkdirSync(vault);
  });

  afterEach(() => {
    fs.rmSync(tmpdir, { recursive: true, force: true });
  });

  function writePermanent(taxonomy: TaxonomyPreset): string {
    const p = path.join(vault, taxonomy.folders.knowledge, "X.md");
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, "---\ntitle: X\nauthor: linus\n---\nBody\n", "utf-8");
    return p;
  }

  // Smoke (б) приёмки: curator → нет needs_review; обычный агент ≠ автора → есть.
  for (const curator of ["index", "scriber", "dreamweaver"]) {
    it(`edit by curator '${curator}' does NOT stamp needs_review`, () => {
      const p = writePermanent(TAXONOMY_RU);
      processFile(p, {
        zone: "permanent",
        agent: curator,
        vault,
        now: FIXED_NOW,
        taxonomy: TAXONOMY_RU,
      });
      const text = fs.readFileSync(p, "utf-8");
      expect(text).toContain(`last_edited_by: ${curator}`);
      expect(text).toContain("needs_review: false");
    });
  }

  it("edit by an ordinary agent (≠ author) stamps needs_review", () => {
    const p = writePermanent(TAXONOMY_RU);
    processFile(p, {
      zone: "permanent",
      agent: "boris",
      vault,
      now: FIXED_NOW,
      taxonomy: TAXONOMY_RU,
    });
    expect(fs.readFileSync(p, "utf-8")).toContain("needs_review: true");
  });

  it("custom curator set from config is honoured", () => {
    const p = writePermanent(TAXONOMY_RU);
    processFile(p, {
      zone: "permanent",
      agent: "scriber-2",
      vault,
      now: FIXED_NOW,
      taxonomy: TAXONOMY_RU,
      curatorSet: ["index", "scriber", "scriber-2", "dreamweaver"],
    });
    expect(fs.readFileSync(p, "utf-8")).toContain("needs_review: false");
  });

  it("memory zone honours curator-set the same way", () => {
    const p = path.join(vault, TAXONOMY_RU.folders.agentMemory, "boris", "x.md");
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, "---\nsubtype: справка\ndescription: т\n---\nBody\n", "utf-8");
    processFile(p, {
      zone: "memory",
      agent: "dreamweaver",
      vault,
      now: FIXED_NOW,
      taxonomy: TAXONOMY_RU,
    });
    const text = fs.readFileSync(p, "utf-8");
    expect(text).toContain("last_edited_by: dreamweaver");
    expect(text).toContain("author: boris");
    expect(text).toContain("needs_review: false");
  });
});

// Smoke (а) приёмки: черновик с двоеточием и ёлочками в description →
// после fill файл парсится НАСТОЯЩИМ YAML-парсером (gray-matter/js-yaml).
describe("smoke: YAML validity after fill (real parser)", () => {
  it("draft with guillemets+colon in description parses as valid YAML", () => {
    const td = fs.mkdtempSync(path.join(os.tmpdir(), "iapeer-memory-yaml-"));
    try {
      const p = path.join(td, TAXONOMY_RU.folders.agentMemory, "boris", "Заметка.md");
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(
        p,
        "---\nsubtype: справка\n" +
          "description: «Сводка: статусы, пути и «вложенные» кавычки»\n---\n\nТело\n",
        "utf-8",
      );
      processFile(p, {
        zone: "auto",
        agent: "boris",
        vault: td,
        now: FIXED_NOW,
        taxonomy: TAXONOMY_RU,
      });
      // Must not throw and must round-trip the inner text verbatim.
      const parsed = matter(fs.readFileSync(p, "utf-8"));
      expect(parsed.data.description).toBe("Сводка: статусы, пути и «вложенные» кавычки");
      expect(parsed.data.author).toBe("boris");
      expect(parsed.content).toContain("Тело");
    } finally {
      fs.rmSync(td, { recursive: true, force: true });
    }
  });
});

// ── resolveAgentName (нюанс 10) ─────────────────────────────────────────────

describe("resolveAgentName — PEER_PERSONALITY first", () => {
  it("explicit value wins", () => {
    expect(resolveAgentName("boris", { PEER_PERSONALITY: "linus" })).toBe("boris");
  });

  it("PEER_PERSONALITY beats namespace fallback", () => {
    expect(
      resolveAgentName(null, {
        PEER_PERSONALITY: "linus",
        IAPEER_MEMORY_AGENT_NAME: "boris",
      }),
    ).toBe("linus");
  });

  it("namespace fallback used when no personality", () => {
    expect(resolveAgentName(null, { IAPEER_MEMORY_AGENT_NAME: "boris" })).toBe("boris");
  });

  it("nothing set → null (never guess from cwd)", () => {
    expect(resolveAgentName(null, {})).toBeNull();
    expect(resolveAgentName("  ", { PEER_PERSONALITY: " " })).toBeNull();
  });
});

describe("normalizeScalarValue — flow collections stay collections (audit important)", () => {
  it("a balanced inline array is left untouched (Obsidian aliases class)", () => {
    expect(normalizeScalarValue("[Сокращение, Синоним]")).toBeNull();
    expect(normalizeScalarValue("{k: v, k2: v2}")).toBeNull();
  });

  it("a dangling opener is still quoted (the broken-scalar class the heuristic exists for)", () => {
    expect(normalizeScalarValue("[висячая")).toBe('"[висячая"');
  });

  it("a [[wikilink]] value keeps being quoted — wikilink intent, not a nested array", () => {
    expect(normalizeScalarValue("[[Заметка]]")).toBe('"[[Заметка]]"');
  });

  it("normalizeAllScalars end-to-end: aliases survive as an array", () => {
    const fm = "title: X\naliases: [Сокращение, Синоним]\nstatus: актуально\n";
    expect(normalizeAllScalars(fm)).toBe(fm);
  });
});
