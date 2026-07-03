import { describe, it, expect } from "bun:test";
import {
  hashContent,
  nowIso,
  normalizeRelativePath,
  normalizePath,
  noteTitleFromPath,
  toJson,
  fromJson,
  escapeFtsQuery,
} from "../src/utils.js";

describe("hashContent", () => {
  it("hashes the full content — a changed tail past 4096 chars must change the hash", () => {
    // Regression for the append-only blind spot: identical first 4096 chars,
    // different tail (e.g. a new phase appended to a long План) MUST reindex.
    const head = "a".repeat(4096);
    expect(hashContent(head + "first tail")).not.toBe(
      hashContent(head + "second tail"),
    );
  });

  it("changes when content changes", () => {
    expect(hashContent("hello")).not.toBe(hashContent("world"));
  });

  it("is sha256-hex (64 hex chars)", () => {
    expect(hashContent("anything")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("returns the same hash for the same input", () => {
    expect(hashContent("hello")).toBe(hashContent("hello"));
  });
});

describe("nowIso", () => {
  it("returns ISO-8601 with Z suffix", () => {
    const v = nowIso();
    expect(v).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it("is round-trippable through Date", () => {
    const v = nowIso();
    expect(new Date(v).toISOString()).toBe(v);
  });
});

describe("normalizeRelativePath", () => {
  it("uses forward slashes", () => {
    expect(normalizeRelativePath("a/b/c.md")).toBe("a/b/c.md");
  });

  it("NFD-normalises composed Cyrillic", () => {
    // У = U + combining diaeresis when in NFD; pre-composed in NFC.
    const composed = "Я";
    const out = normalizeRelativePath(composed);
    expect(out.normalize("NFC")).toBe(composed);
  });
});

describe("normalizePath", () => {
  it("decomposes Cyrillic to NFD", () => {
    const composed = "Москва";
    expect(normalizePath(composed)).toBe(composed.normalize("NFD"));
  });
});

describe("noteTitleFromPath", () => {
  it("strips folder + extension", () => {
    expect(noteTitleFromPath("01_Знания/MergeMind.md")).toBe("MergeMind");
  });

  it("trims whitespace", () => {
    expect(noteTitleFromPath("  spaced.md  ")).toBe("spaced");
  });

  it("handles files without extension", () => {
    expect(noteTitleFromPath("README")).toBe("README");
  });
});


describe("toJson + fromJson", () => {
  it("round-trips objects", () => {
    const obj = { a: 1, b: ["x", "y"], c: { nested: true } };
    expect(fromJson(toJson(obj), {})).toEqual(obj);
  });

  it("toJson stringifies null for nullish input", () => {
    expect(toJson(undefined)).toBe("null");
    expect(toJson(null)).toBe("null");
  });

  it("fromJson returns fallback on null/empty", () => {
    expect(fromJson<number[]>(null, [])).toEqual([]);
    expect(fromJson<number[]>("", [])).toEqual([]);
  });

  it("fromJson returns fallback on parse error", () => {
    expect(fromJson<number[]>("not json", [42])).toEqual([42]);
  });
});

describe("escapeFtsQuery", () => {
  it("wraps tokens in quotes with prefix-match wildcard", () => {
    expect(escapeFtsQuery("foo")).toBe('"foo"*');
  });

  it("splits on whitespace and ORs tokens by space", () => {
    expect(escapeFtsQuery("foo bar")).toBe('"foo"* "bar"*');
  });

  it("strips FTS5 metacharacters", () => {
    // Quotes, parens, colon, NEAR/MATCH operators — all must not leak.
    const dangerous = 'foo"bar:baz(qux)';
    const out = escapeFtsQuery(dangerous);
    expect(out).not.toContain('"bar:');
    expect(out).not.toContain("(");
    expect(out).not.toContain(")");
    // All payload tokens still wrapped in quotes.
    expect(out.startsWith('"')).toBe(true);
  });

  it("handles cyrillic", () => {
    expect(escapeFtsQuery("привет мир")).toBe('"привет"* "мир"*');
  });

  it("returns empty string on whitespace-only input", () => {
    expect(escapeFtsQuery("   ")).toBe("");
  });

  it("strips control characters", () => {
    expect(escapeFtsQuery("a\x00b\x1fc")).toBe('"a"* "b"* "c"*');
  });

  // Unicode separator tokens: a standalone «—»/«→»/«…»/emoji token tokenises
  // to a ZERO-term FTS5 phrase, which matches zero rows and (via implicit AND)
  // zeroes the WHOLE query. Routine in Russian queries and in the vault's own
  // canonical «Фаза — X» note names.
  it("drops a standalone em-dash token (canonical «Фаза — X» names must match)", () => {
    expect(escapeFtsQuery("Фаза — MVP")).toBe('"Фаза"* "MVP"*');
  });

  it("drops arrow / ellipsis / emoji-only tokens", () => {
    expect(escapeFtsQuery("flush → render")).toBe('"flush"* "render"*');
    expect(escapeFtsQuery("итог …")).toBe('"итог"*');
    expect(escapeFtsQuery("🔥")).toBe("");
  });

  it("returns empty string when ALL tokens are separators", () => {
    expect(escapeFtsQuery("— → …")).toBe("");
  });

  it("keeps tokens that merely CONTAIN a separator", () => {
    // Adjacent-tokens phrase match still works for these in FTS5.
    expect(escapeFtsQuery("Фаза—MVP")).toBe('"Фаза—MVP"*');
  });
});
