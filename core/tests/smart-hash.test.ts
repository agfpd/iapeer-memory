/**
 * Parity tests for src/smart-hash.ts — translation of the reference
 * `tests/python/test_frontmatter_hash.py` (12 fixtures).
 *
 * The headline property: service frontmatter fields (`last_edited_by`,
 * `updated`, `needs_review`) do NOT affect the hash. Without it the change
 * detector would fire on every hook re-stamp → echo loop.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { hashFile } from "../src/smart-hash.js";

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "iapeer-memory-hash-"));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function write(name: string, content: string): string {
  const p = path.join(tmp, name);
  fs.writeFileSync(p, content, "utf-8");
  return p;
}

function sha256(data: string | Uint8Array): string {
  return crypto.createHash("sha256").update(data).digest("hex");
}

describe("hashFile basics", () => {
  it("nonexistent file returns empty string", () => {
    expect(hashFile(path.join(tmp, "nope.md"))).toBe("");
  });

  it("no frontmatter hashes raw content", () => {
    const p = write("a.md", "Just body, no frontmatter.\n");
    expect(hashFile(p)).toBe(sha256("Just body, no frontmatter.\n"));
  });

  it("deterministic", () => {
    const p = write("a.md", "---\ntitle: X\n---\n\nBody\n");
    expect(hashFile(p)).toBe(hashFile(p));
  });
});

describe("service fields stripped (headline property)", () => {
  it("last_edited_by ignored", () => {
    const a = write("a.md", "---\ntitle: X\nauthor: boris\n---\n\nBody\n");
    const b = write("b.md", "---\ntitle: X\nauthor: boris\nlast_edited_by: index\n---\n\nBody\n");
    expect(hashFile(a)).toBe(hashFile(b));
  });

  it("updated ignored", () => {
    const a = write("a.md", "---\ntitle: X\nauthor: boris\n---\n\nBody\n");
    const b = write("b.md", "---\ntitle: X\nauthor: boris\nupdated: 2026-05-15 00:30\n---\n\nBody\n");
    expect(hashFile(a)).toBe(hashFile(b));
  });

  it("needs_review ignored", () => {
    const a = write("a.md", "---\ntitle: X\nauthor: boris\n---\n\nBody\n");
    const b = write("b.md", "---\ntitle: X\nauthor: boris\nneeds_review: true\n---\n\nBody\n");
    expect(hashFile(a)).toBe(hashFile(b));
  });

  it("all three service fields ignored together", () => {
    const a = write("a.md", "---\ntitle: X\nauthor: boris\n---\n\nBody\n");
    const b = write(
      "b.md",
      "---\ntitle: X\nauthor: boris\nlast_edited_by: linus\nupdated: 2026-05-15 00:30\nneeds_review: true\n---\n\nBody\n",
    );
    expect(hashFile(a)).toBe(hashFile(b));
  });
});

describe("semantic fields affect the hash", () => {
  it("title change changes hash", () => {
    const a = write("a.md", "---\ntitle: X\n---\n\nBody\n");
    const b = write("b.md", "---\ntitle: Y\n---\n\nBody\n");
    expect(hashFile(a)).not.toBe(hashFile(b));
  });

  it("body change changes hash", () => {
    const a = write("a.md", "---\ntitle: X\n---\n\nBody A\n");
    const b = write("b.md", "---\ntitle: X\n---\n\nBody B\n");
    expect(hashFile(a)).not.toBe(hashFile(b));
  });

  it("subtype change changes hash", () => {
    const a = write("a.md", "---\nsubtype: грабли\n---\n\nBody\n");
    const b = write("b.md", "---\nsubtype: обратная_связь\n---\n\nBody\n");
    expect(hashFile(a)).not.toBe(hashFile(b));
  });

  it("tags change changes hash", () => {
    const a = write("a.md", "---\ntags:\n  - X\n---\n\nBody\n");
    const b = write("b.md", "---\ntags:\n  - Y\n---\n\nBody\n");
    expect(hashFile(a)).not.toBe(hashFile(b));
  });
});

describe("binary fallback", () => {
  it("invalid utf-8 falls back to raw-bytes hash", () => {
    const p = path.join(tmp, "bin.md");
    const bytes = Buffer.from([0xff, 0xfe, 0x00, 0x00, ...Buffer.from(" not utf-8")]);
    fs.writeFileSync(p, bytes);
    expect(hashFile(p)).toBe(sha256(bytes));
  });
});
