import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { scaffoldHostDocs } from "../src/host-docs.js";

let root: string;
let src: string;
let dest: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "im-hostdocs-"));
  src = path.join(root, "src-docs");
  dest = path.join(root, "host", "docs", "iapeer-memory");
  fs.mkdirSync(src, { recursive: true });
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function write(rel: string, body = "x"): void {
  const f = path.join(src, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, body);
}

describe("scaffoldHostDocs", () => {
  it("mirrors the docs tree (incl. nested) into the per-package dest", () => {
    write("README.md", "hi");
    write("01-overview.md");
    write("ru/01-обзор.md");

    const r = scaffoldHostDocs({ docsSource: src, destDir: dest });

    expect(r.action).toBe("written");
    expect(fs.readFileSync(path.join(dest, "README.md"), "utf-8")).toBe("hi");
    expect(fs.existsSync(path.join(dest, "ru", "01-обзор.md"))).toBe(true);
  });

  it("excludes internals/, root ТЗ-*.md, and .DS_Store anywhere", () => {
    write("README.md");
    write("internals/mechanics.md");
    write("ТЗ-spec.md");
    write(".DS_Store");
    write("ru/.DS_Store");

    const r = scaffoldHostDocs({ docsSource: src, destDir: dest });

    expect(r.action).toBe("written");
    expect(fs.existsSync(path.join(dest, "internals"))).toBe(false);
    expect(fs.existsSync(path.join(dest, "ТЗ-spec.md"))).toBe(false);
    expect(fs.existsSync(path.join(dest, ".DS_Store"))).toBe(false);
    expect(fs.existsSync(path.join(dest, "ru", ".DS_Store"))).toBe(false);
    expect(fs.existsSync(path.join(dest, "README.md"))).toBe(true);
  });

  it("atomic-replaces — a stale file from a prior version is gone after re-scaffold", () => {
    write("README.md");
    scaffoldHostDocs({ docsSource: src, destDir: dest });
    fs.writeFileSync(path.join(dest, "stale.md"), "old"); // lingering from a past version

    const r = scaffoldHostDocs({ docsSource: src, destDir: dest });

    expect(r.action).toBe("written");
    expect(fs.existsSync(path.join(dest, "stale.md"))).toBe(false);
    expect(fs.existsSync(path.join(dest, "README.md"))).toBe(true);
  });

  it("best-effort: a missing source → skipped, dest untouched (never fails install)", () => {
    const r = scaffoldHostDocs({ docsSource: path.join(root, "absent"), destDir: dest });
    expect(r.action).toBe("skipped");
    expect(fs.existsSync(dest)).toBe(false);
  });
});
