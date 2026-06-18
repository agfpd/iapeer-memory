import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { syncDocs } from "../src/sync-docs.js";

let root: string;
let pkgDir: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "im-syncdocs-"));
  pkgDir = path.join(root, "package");
  fs.mkdirSync(pkgDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function writeDoc(rel: string, body = "x"): void {
  const file = path.join(root, "docs", rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
}

describe("syncDocs", () => {
  it("copies the docs tree (incl. nested) into package/docs", () => {
    writeDoc("README.md", "hello");
    writeDoc("01-overview.md");
    writeDoc("ru/01-overview.md");

    const { destDir, files } = syncDocs({ rootDir: root, pkgDir });

    expect(destDir).toBe(path.join(pkgDir, "docs"));
    expect(files).toBe(3);
    expect(fs.readFileSync(path.join(destDir, "README.md"), "utf-8")).toBe("hello");
    expect(fs.existsSync(path.join(destDir, "ru", "01-overview.md"))).toBe(true);
  });

  it("prunes local-only material — internals/ and root ТЗ-*.md never leak", () => {
    writeDoc("README.md");
    writeDoc("internals/mechanics.md");
    writeDoc("internals/deep/note.md");
    writeDoc("ТЗ-lean-режим.md");

    const { destDir, files } = syncDocs({ rootDir: root, pkgDir });

    expect(fs.existsSync(path.join(destDir, "internals"))).toBe(false);
    expect(fs.existsSync(path.join(destDir, "ТЗ-lean-режим.md"))).toBe(false);
    expect(fs.existsSync(path.join(destDir, "README.md"))).toBe(true);
    expect(files).toBe(1);
  });

  it("is idempotent — rebuilds cleanly, dropping files removed from source", () => {
    writeDoc("README.md");
    writeDoc("stale.md");
    syncDocs({ rootDir: root, pkgDir });

    fs.rmSync(path.join(root, "docs", "stale.md"));
    const { files } = syncDocs({ rootDir: root, pkgDir });

    expect(fs.existsSync(path.join(pkgDir, "docs", "stale.md"))).toBe(false);
    expect(files).toBe(1);
  });
});
