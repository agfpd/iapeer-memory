import { describe, it, expect } from "bun:test";
import {
  parseMarkdown,
  stripLinksSection,
  extractWikilinks,
  chunkText,
  wikilinkBasename,
} from "../src/parser.js";
import { TAXONOMY_EN, TAXONOMY_RU } from "../src/taxonomy.js";

describe("parseMarkdown — frontmatter", () => {
  it("extracts title/type/status/tags from frontmatter", () => {
    const md = `---
title: Test Note
type: знание
status: актуально
tags: [foo, bar]
---

Body here.
`;
    const out = parseMarkdown(md, "01_Знания/test.md", 500, 80, TAXONOMY_RU);
    expect(out.title).toBe("Test Note");
    expect(out.type).toBe("знание");
    expect(out.status).toBe("актуально");
    expect(out.tags).toEqual(["foo", "bar"]);
  });

  it("falls back to filename when title is absent", () => {
    const out = parseMarkdown("body only", "01_Знания/Без_заголовка.md", 500, 80, TAXONOMY_RU);
    expect(out.title).toBe("Без_заголовка");
  });

  it("converts YAML date scalars to ISO date strings", () => {
    const md = `---
title: T
created: 2026-03-30
---

x
`;
    const out = parseMarkdown(md, "x.md", 500, 80, TAXONOMY_RU);
    expect(out.created).toBe("2026-03-30");
  });

  it("returns empty tags when frontmatter.tags is missing", () => {
    const out = parseMarkdown("body", "x.md", 500, 80, TAXONOMY_RU);
    expect(out.tags).toEqual([]);
  });

  it("filters non-string tags out", () => {
    const md = `---
title: T
tags:
  - foo
  - 42
  - bar
---

x
`;
    const out = parseMarkdown(md, "x.md", 500, 80, TAXONOMY_RU);
    expect(out.tags).toEqual(["foo", "bar"]);
  });
});

for (const T of [TAXONOMY_RU, TAXONOMY_EN]) {
  describe(`stripLinksSection [${T.locale}]`, () => {
    it("strips the leading links block when divider follows", () => {
      const body = `${T.linksSection}\n- [[Foo]]\n- [[Bar]]\n\n---\n\nActual content.`;
      expect(stripLinksSection(body, T)).toBe("Actual content.");
    });

    it("passes through when there's no links header", () => {
      const body = "# Note\n\nNo links section here.";
      expect(stripLinksSection(body, T)).toBe(body);
    });

    it("passes through when header exists but no --- divider", () => {
      const body = `${T.linksSection}\n[[Foo]]\nNo divider.`;
      expect(stripLinksSection(body, T)).toBe(body);
    });
  });
}

describe("extractWikilinks", () => {
  it("extracts basic wikilinks", () => {
    const out = extractWikilinks("See [[Foo]] and [[Bar]].");
    expect(out.map((w) => w.target)).toEqual(["Foo", "Bar"]);
  });

  it("PRESERVES the folder path in target (path-aware resolution needs it)", () => {
    const out = extractWikilinks("[[01_Знания/MergeMind]]");
    expect(out[0]?.target).toBe("01_Знания/MergeMind");
  });

  it("strips trailing .md but keeps the path", () => {
    const out = extractWikilinks("[[01_Знания/MergeMind.md]]");
    expect(out[0]?.target).toBe("01_Знания/MergeMind");
  });

  it("strips |alias display name", () => {
    const out = extractWikilinks("[[MergeMind|see this]]");
    expect(out[0]?.target).toBe("MergeMind");
  });

  it("captures context snippet around the link", () => {
    const body = "Some leading text. [[Target]] some trailing text.";
    const out = extractWikilinks(body);
    expect(out[0]?.contextSnippet).toContain("Target");
    expect(out[0]?.contextSnippet).toContain("Some leading text");
  });

  it("returns empty for body without wikilinks", () => {
    expect(extractWikilinks("plain text")).toEqual([]);
  });

  // Backtick-context skip — placeholder'ы из инструкций/шаблонов не
  // попадают в граф. Источник #2 фолс-orphan'ов из «Фазы — Устранение
  // багов после релиза в проде».
  it("ignores wikilinks inside inline backticks", () => {
    const out = extractWikilinks("Шаблон wikilink: `[[X]]` — пиши так. Реальная ссылка: [[Foo]].");
    expect(out.map((w) => w.target)).toEqual(["Foo"]);
  });

  it("ignores wikilinks inside double-backtick inline code", () => {
    const out = extractWikilinks("Пример с backtick внутри: ``[[`X`]]`` — не ссылка. Реальная: [[Bar]].");
    expect(out.map((w) => w.target)).toEqual(["Bar"]);
  });

  it("ignores wikilinks inside fenced code blocks (triple backtick)", () => {
    const body = "До:\n```\n- [[Связанная заметка]]\n- [[Placeholder]]\n```\nПосле: [[RealLink]].";
    const out = extractWikilinks(body);
    expect(out.map((w) => w.target)).toEqual(["RealLink"]);
  });

  it("ignores wikilinks inside tilde-fenced code blocks", () => {
    const body = "~~~\n[[InsideTilde]]\n~~~\n[[Real]]";
    const out = extractWikilinks(body);
    expect(out.map((w) => w.target)).toEqual(["Real"]);
  });

  it("real wikilinks adjacent to code-block placeholders still extracted", () => {
    // Реалистичный кейс из инструкции Индекса: блок с шаблоном связи + потом
    // реальные wikilinks в обычном тексте.
    const body =
      "Формат связей:\n```markdown\n- [[Связанная заметка]] — короткое объяснение\n```\n\nСсылки: [[A]], [[B]], [[C]].";
    const out = extractWikilinks(body);
    expect(out.map((w) => w.target)).toEqual(["A", "B", "C"]);
  });

  it("preserves context snippet from original body (not masked)", () => {
    // Маскирование code-областей не должно «съесть» контекст соседних
    // реальных wikilinks — snippet строится из оригинального body.
    const body = "Перед `code` [[Foo]] после.";
    const out = extractWikilinks(body);
    expect(out[0]?.target).toBe("Foo");
    expect(out[0]?.contextSnippet).toContain("code");
  });
});

describe("wikilinkBasename", () => {
  it("returns the last segment of a path-qualified target", () => {
    expect(wikilinkBasename("03_Проекты/A/Фаза — MVP")).toBe("Фаза — MVP");
  });

  it("returns the target unchanged when there is no path", () => {
    expect(wikilinkBasename("MergeMind")).toBe("MergeMind");
  });
});

describe("chunkText", () => {
  it("returns title-only chunk for empty body when title given", () => {
    const chunks = chunkText("", 500, 80, "My Title");
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.text).toBe("My Title");
  });

  it("returns no chunks for empty body without title", () => {
    expect(chunkText("", 500, 80)).toEqual([]);
  });

  it("prepends title to chunk[0] only", () => {
    const body = "para one.\n\npara two.\n\npara three.";
    const chunks = chunkText(body, 20, 5, "TITLE");
    expect(chunks[0]!.text.startsWith("TITLE\n\n")).toBe(true);
    for (let i = 1; i < chunks.length; i++) {
      expect(chunks[i]!.text.startsWith("TITLE")).toBe(false);
    }
  });

  it("respects chunk size by splitting at paragraph boundaries", () => {
    const big = Array.from({ length: 5 }, (_, i) => `paragraph ${i}`).join("\n\n");
    const chunks = chunkText(big, 25, 5);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      // Some headroom allowed when a single paragraph is large; but each
      // produced chunk should be near or under chunkSize.
      expect(c.text.length).toBeLessThanOrEqual(50);
    }
  });

  it("emits sequential chunkIndex", () => {
    const big = Array.from({ length: 4 }, (_, i) => `p${i}`).join("\n\n");
    const chunks = chunkText(big, 6, 1);
    expect(chunks.map((c) => c.chunkIndex)).toEqual(
      chunks.map((_, i) => i),
    );
  });

  it("does not hang on a single paragraph that overflows chunkSize", () => {
    // No splittable whitespace + tiny chunkSize would loop forever without the
    // guard inside chunkText. If this test ever hangs, the guard regressed.
    const monolith = "a".repeat(200);
    const chunks = chunkText(monolith, 50, 10);
    expect(chunks.length).toBeGreaterThan(0);
  });
});

describe("parseMarkdown — chunks", () => {
  it("strips ## Связи + divider before chunking", () => {
    const md = `---
title: Linked
---

## Связи
- [[Foo]]

---

Real content here.`;
    const out = parseMarkdown(md, "x.md", 500, 80, TAXONOMY_RU);
    // Chunk[0] gets the title prefix; the body part must be the real content,
    // not the Связи block.
    expect(out.chunks[0]?.text).toContain("Real content here.");
    expect(out.chunks[0]?.text).not.toContain("## Связи");
  });

  it("wikilinks are extracted from full body (including Связи)", () => {
    const md = `---
title: T
---

## Связи
- [[Foo]]

---

Body without inline links.`;
    const out = parseMarkdown(md, "x.md", 500, 80, TAXONOMY_RU);
    expect(out.wikilinks.map((w) => w.target)).toContain("Foo");
  });
});
