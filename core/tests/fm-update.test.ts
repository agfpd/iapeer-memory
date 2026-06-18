/**
 * Parity tests for src/fm-update.ts — translation of the reference
 * `tests/python/test_fm_update.py` (38 fixtures). The CLI-subprocess block
 * of the reference is tested through the `fmUpdate` entry (same behaviour
 * contract; the argv wiring belongs to the package facade binary).
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  Frontmatter,
  FmList,
  Scalar,
  updateFile,
  fmUpdate,
  collectOps,
  type Op,
} from "../src/fm-update.js";
import { splitFrontmatter } from "../src/frontmatter-fill.js";
import { TAXONOMY_RU } from "../src/taxonomy.js";

const FIXED_NOW = new Date(2026, 4, 20, 12, 0, 0);

// ── parser ───────────────────────────────────────────────────────────────────

describe("parser: scalars", () => {
  it("simple scalars", () => {
    const fm = Frontmatter.fromText("title: X\nstatus: актуально\n");
    expect((fm.get("title") as Scalar).value).toBe("X");
    expect((fm.get("status") as Scalar).value).toBe("актуально");
  });

  it("preserves order", () => {
    const fm = Frontmatter.fromText("c: 1\na: 2\nb: 3\n");
    expect(fm.toText()).toBe("c: 1\na: 2\nb: 3\n");
  });

  it("strips quotes on read", () => {
    const fm = Frontmatter.fromText('description: "Текст: с двоеточием"\n');
    expect((fm.get("description") as Scalar).value).toBe("Текст: с двоеточием");
  });
});

describe("parser: lists", () => {
  it("block list", () => {
    const fm = Frontmatter.fromText("tags:\n  - Память\n  - LLM\n");
    const entry = fm.get("tags");
    expect(entry).toBeInstanceOf(FmList);
    expect((entry as FmList).items).toEqual(["Память", "LLM"]);
  });

  it("inline list", () => {
    const fm = Frontmatter.fromText("tags: [Память, LLM]\n");
    expect((fm.get("tags") as FmList).items).toEqual(["Память", "LLM"]);
  });

  it("inline empty list dropped", () => {
    expect(Frontmatter.fromText("tags: []\n").has("tags")).toBe(false);
  });

  it("null dropped", () => {
    expect(Frontmatter.fromText("coauthors: null\n").has("coauthors")).toBe(false);
  });

  it("empty scalar without items dropped (sed-artefact sanitisation)", () => {
    const fm = Frontmatter.fromText("tags:\n\ntitle: X\n");
    expect(fm.has("tags")).toBe(false);
    expect(fm.has("title")).toBe(true);
  });
});

describe("parser: orphan resilience (regression)", () => {
  it("orphan items dropped, not re-attached", () => {
    const fm = Frontmatter.fromText(
      "title: X\nstatus: актуально\n  - Память\n  - LLM\nauthor: boris\n",
    );
    expect((fm.get("title") as Scalar).value).toBe("X");
    expect((fm.get("status") as Scalar).value).toBe("актуально");
    expect((fm.get("author") as Scalar).value).toBe("boris");
    expect(fm.get("status")).not.toBeInstanceOf(FmList);
  });

  it("round-trip idempotent on clean input", () => {
    const text =
      "title: X\ntype: знание\ntags:\n  - Память\n  - LLM\nstatus: актуально\ncoauthors:\n  - boris\n";
    const out1 = Frontmatter.fromText(text).toText();
    const out2 = Frontmatter.fromText(out1).toText();
    expect(out1).toBe(out2);
    expect(out1).toBe(text);
  });
});

// ── structural operations ───────────────────────────────────────────────────

describe("setScalar", () => {
  it("set new", () => {
    const fm = Frontmatter.fromText("title: X\n");
    fm.setScalar("status", "принято");
    expect(fm.toText()).toBe("title: X\nstatus: принято\n");
  });

  it("set replaces", () => {
    const fm = Frontmatter.fromText("status: черновик\n");
    fm.setScalar("status", "принято");
    expect(fm.toText()).toBe("status: принято\n");
  });

  it("set preserves position when replacing", () => {
    const fm = Frontmatter.fromText("a: 1\nb: 2\nc: 3\n");
    fm.setScalar("b", "X");
    expect(fm.toText()).toBe("a: 1\nb: X\nc: 3\n");
  });
});

describe("unset", () => {
  it("unset scalar", () => {
    const fm = Frontmatter.fromText("a: 1\nb: 2\n");
    expect(fm.remove("a")).toBe(true);
    expect(fm.toText()).toBe("b: 2\n");
  });

  it("unset list removes ALL items atomically (headline property)", () => {
    const fm = Frontmatter.fromText("tags:\n  - Память\n  - LLM\ntitle: X\n");
    expect(fm.remove("tags")).toBe(true);
    const out = fm.toText();
    expect(out).not.toContain("- Память");
    expect(out).not.toContain("- LLM");
    expect(out).toBe("title: X\n");
  });

  it("unset missing returns false", () => {
    expect(Frontmatter.fromText("a: 1\n").remove("missing")).toBe(false);
  });
});

describe("listAppend", () => {
  it("creates list when absent", () => {
    const fm = Frontmatter.fromText("title: X\n");
    fm.listAppend("coauthors", "boris");
    expect(fm.toText()).toBe("title: X\ncoauthors:\n  - boris\n");
  });

  it("appends to existing", () => {
    const fm = Frontmatter.fromText("coauthors:\n  - boris\n");
    fm.listAppend("coauthors", "linus");
    expect((fm.get("coauthors") as FmList).items).toEqual(["boris", "linus"]);
  });

  it("idempotent", () => {
    const fm = Frontmatter.fromText("coauthors:\n  - boris\n");
    fm.listAppend("coauthors", "boris");
    expect((fm.get("coauthors") as FmList).items).toEqual(["boris"]);
  });

  it("promotes scalar to list (recovery scenario)", () => {
    const fm = Frontmatter.fromText("coauthors: boris\n");
    fm.listAppend("coauthors", "linus");
    const entry = fm.get("coauthors");
    expect(entry).toBeInstanceOf(FmList);
    expect((entry as FmList).items).toEqual(["boris", "linus"]);
  });
});

describe("listRemove", () => {
  it("removes an item", () => {
    const fm = Frontmatter.fromText("tags:\n  - A\n  - B\n  - C\n");
    fm.listRemove("tags", "B");
    expect((fm.get("tags") as FmList).items).toEqual(["A", "C"]);
  });

  it("removes the key when emptied", () => {
    const fm = Frontmatter.fromText("tags:\n  - A\n");
    fm.listRemove("tags", "A");
    expect(fm.has("tags")).toBe(false);
  });

  it("missing value is a no-op", () => {
    const fm = Frontmatter.fromText("tags:\n  - A\n");
    fm.listRemove("tags", "Z");
    expect((fm.get("tags") as FmList).items).toEqual(["A"]);
  });
});

// ── updateFile integration ───────────────────────────────────────────────────

describe("updateFile", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "iapeer-memory-fmu-"));
  });

  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  function write(name: string, body: string): string {
    const p = path.join(dir, name);
    fs.writeFileSync(p, body, "utf-8");
    return p;
  }

  it("set scalar through a file", () => {
    const p = write("n.md", "---\nstatus: черновик\n---\n\nBody\n");
    updateFile(p, [{ kind: "set", key: "status", value: "принято" }]);
    const out = fs.readFileSync(p, "utf-8");
    expect(out).toContain("status: принято");
    expect(out).toContain("Body");
  });

  it("unset with list leaves no orphans (regression)", () => {
    const p = write(
      "n.md",
      "---\ntitle: X\ntags:\n  - Память\n  - LLM\nstatus: актуально\n---\n\nBody\n",
    );
    updateFile(p, [{ kind: "unset", key: "tags" }]);
    const out = fs.readFileSync(p, "utf-8");
    expect(out).not.toContain("- Память");
    expect(out).not.toContain("- LLM");
    const [fmText] = splitFrontmatter(out);
    const parsed = Frontmatter.fromText(fmText);
    expect(parsed.has("title")).toBe(true);
    expect(parsed.has("status")).toBe(true);
    expect(parsed.has("tags")).toBe(false);
  });

  it("list-add idempotent, no duplicate", () => {
    const p = write("n.md", "---\ncoauthors:\n  - boris\n---\n\nBody\n");
    updateFile(p, [{ kind: "list-add", key: "coauthors", value: "boris" }]);
    const out = fs.readFileSync(p, "utf-8");
    expect(out.split("- boris").length - 1).toBe(1);
  });

  it("preserves the body (links section, headings)", () => {
    const p = write("n.md", "---\ntitle: X\n---\n\n## Связи\n\n- [[Y]]\n\n---\n\n# X\n");
    updateFile(p, [{ kind: "set", key: "title", value: "Y" }]);
    const out = fs.readFileSync(p, "utf-8");
    expect(out).toContain("## Связи");
    expect(out).toContain("[[Y]]");
    expect(out).toContain("# X");
  });

  it("creates the frontmatter block when absent", () => {
    const p = write("n.md", "Just body\n");
    updateFile(p, [{ kind: "set", key: "title", value: "X" }]);
    const out = fs.readFileSync(p, "utf-8");
    expect(out.startsWith("---\ntitle: X\n---\n")).toBe(true);
    expect(out).toContain("Just body");
  });

  it("no ops + no frontmatter → no-op", () => {
    const p = write("n.md", "Just body\n");
    expect(updateFile(p, [])).toBe(false);
    expect(fs.readFileSync(p, "utf-8")).toBe("Just body\n");
  });
});

// ── fmUpdate entry (the reference CLI behaviour contract) ───────────────────

describe("fmUpdate — structural ops + attribution stamp", () => {
  let vault: string;
  let folder: string;

  beforeEach(() => {
    vault = fs.mkdtempSync(path.join(os.tmpdir(), "iapeer-memory-fmu-vault-"));
    folder = path.join(vault, TAXONOMY_RU.folders.knowledge);
    fs.mkdirSync(folder, { recursive: true });
  });

  afterEach(() => fs.rmSync(vault, { recursive: true, force: true }));

  function write(rel: string, body: string): string {
    const p = path.join(vault, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, body, "utf-8");
    return p;
  }

  function run(files: string[], opts: Partial<Parameters<typeof fmUpdate>[0]> = {}): void {
    fmUpdate({ files, vault, taxonomy: TAXONOMY_RU, now: FIXED_NOW, ...opts });
  }

  it("set + stamp (curator emits needs_review: false — line-always-present)", () => {
    const p = write(
      "01_Знания/Тест.md",
      "---\ntitle: Тест\ntype: знание\nstatus: актуально\nauthor: linus\n---\n\nBody\n",
    );
    run([p], { agent: "index", ops: collectOps({ set: [["status", "устарело"]] }) });
    const out = fs.readFileSync(p, "utf-8");
    expect(out).toContain("status: устарело");
    expect(out).toContain("last_edited_by: index");
    expect(out).toContain("updated:");
    expect(out).toContain("needs_review: false");
  });

  it("unset with list via the entry — regression end-to-end", () => {
    const p = write(
      "01_Знания/Тест.md",
      "---\ntitle: Тест\ntype: знание\ntags:\n  - Память\n  - LLM\nstatus: актуально\nauthor: linus\n---\n\nBody\n",
    );
    run([p], { agent: "index", ops: collectOps({ unset: ["tags"] }) });
    const out = fs.readFileSync(p, "utf-8");
    expect(out).not.toContain("tags:");
    expect(out).not.toContain("- Память");
    expect(out).not.toContain("- LLM");
    const [fmText] = splitFrontmatter(out);
    expect(Frontmatter.fromText(fmText).has("title")).toBe(true);
  });

  it("stamp: false skips attribution", () => {
    const p = write(
      "01_Знания/Тест.md",
      "---\ntitle: Тест\ntype: знание\nstatus: актуально\nauthor: linus\n---\n\nBody\n",
    );
    run([p], { agent: "index", stamp: false, ops: collectOps({ set: [["status", "устарело"]] }) });
    const out = fs.readFileSync(p, "utf-8");
    expect(out).toContain("status: устарело");
    expect(out).not.toContain("last_edited_by");
  });

  it("files only (no ops) — pure stamp; non-curator gets needs_review", () => {
    const p = write(
      "01_Знания/Тест.md",
      "---\ntitle: Тест\ntype: знание\nstatus: актуально\nauthor: linus\n---\n\nBody\n",
    );
    run([p], { agent: "boris" });
    const out = fs.readFileSync(p, "utf-8");
    expect(out).toContain("last_edited_by: boris");
    expect(out).toContain("updated:");
    expect(out).toContain("needs_review: true");
  });

  it("outside the zone whitelist: ops apply, stamp is a no-op", () => {
    const p = write("Произвольная.md", "---\ntitle: X\n---\n\nBody\n");
    run([p], { agent: "boris", ops: collectOps({ set: [["title", "Y"]] }) });
    const out = fs.readFileSync(p, "utf-8");
    expect(out).toContain("title: Y");
    expect(out).not.toContain("last_edited_by");
  });
});

// ── yaml-safe serialisation ──────────────────────────────────────────────────

describe("yaml-safe serialisation (shared normaliser)", () => {
  it("setScalar with a colon is quoted", () => {
    const fm = Frontmatter.fromText("title: x\n");
    fm.setScalar("description", "Корень: двоеточие");
    expect(fm.toText()).toContain('description: "Корень: двоеточие"');
  });

  it("guillemets with a colon normalised on serialisation", () => {
    const fm = Frontmatter.fromText("description: «a: b»\n");
    expect(fm.toText()).toBe('description: "a: b"\n');
  });

  it("safe scalars stay raw", () => {
    const fm = Frontmatter.fromText("status: актуально\ntitle: foo\n");
    expect(fm.toText()).toBe("status: актуально\ntitle: foo\n");
  });

  it("double-quoted round-trip is stable", () => {
    const fm = Frontmatter.fromText('description: "Текст: двоеточие"\n');
    expect(fm.toText()).toBe('description: "Текст: двоеточие"\n');
  });
});
