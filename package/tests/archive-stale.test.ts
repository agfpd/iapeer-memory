import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { cmdArchiveStale } from "../src/commands/archive-stale.js";

let tmp: string;
let vault: string;
const saved: Record<string, string | undefined> = {};

function setEnv(k: string, v: string | undefined): void {
  if (!(k in saved)) saved[k] = process.env[k];
  if (v === undefined) delete process.env[k];
  else process.env[k] = v;
}

function capture(fn: () => number): { code: number; out: string } {
  const lines: string[] = [];
  const origLog = console.log;
  const origErr = console.error;
  console.log = (...a: unknown[]) => lines.push(a.join(" "));
  console.error = (...a: unknown[]) => lines.push(a.join(" "));
  try {
    return { code: fn(), out: lines.join("\n") };
  } finally {
    console.log = origLog;
    console.error = origErr;
  }
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "im-archstale-"));
  vault = path.join(tmp, "vault");
  for (const d of ["01_Знания", "03_Проекты/proj", "07_Архив"]) {
    fs.mkdirSync(path.join(vault, d), { recursive: true });
  }
  setEnv("IAPEER_MEMORY_VAULT_PATH", vault);
  setEnv("IAPEER_MEMORY_LOCALE", "ru");
});

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  for (const k of Object.keys(saved)) delete saved[k];
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("archive-stale verb (lean §2.2a, deliberate backlog)", () => {
  it("dry-run lists stale notes (incl. completed projects), skips active, moves nothing", () => {
    fs.writeFileSync(path.join(vault, "01_Знания", "Старое.md"), "---\nstatus: устарело\n---\nтело");
    fs.writeFileSync(path.join(vault, "01_Знания", "Живое.md"), "---\nstatus: актуально\n---\nтело");
    // completed phase in a project — UNIFIED rule: archives too
    fs.writeFileSync(path.join(vault, "03_Проекты/proj", "Фаза.md"), "---\nstatus: завершена\n---\nтело");

    const { code, out } = capture(() => cmdArchiveStale([]));
    expect(code).toBe(0);
    expect(out).toContain("DRY-RUN");
    expect(out).toContain("01_Знания/Старое.md");
    expect(out).toContain("Фаза.md"); // completed project phase archives too
    expect(out).not.toContain("Живое.md"); // active
    // nothing moved (dry-run)
    expect(fs.existsSync(path.join(vault, "01_Знания", "Старое.md"))).toBe(true);
    expect(fs.existsSync(path.join(vault, "07_Архив", "Старое.md"))).toBe(false);
  });

  it("--commit moves stale notes into the archive", () => {
    fs.writeFileSync(path.join(vault, "01_Знания", "Старое.md"), "---\nstatus: устарело\n---\nтело");
    const { code } = capture(() => cmdArchiveStale(["--commit"]));
    expect(code).toBe(0);
    expect(fs.existsSync(path.join(vault, "01_Знания", "Старое.md"))).toBe(false);
    expect(fs.existsSync(path.join(vault, "07_Архив", "Старое.md"))).toBe(true);
  });

  it("collision gets a numeric suffix", () => {
    fs.writeFileSync(path.join(vault, "07_Архив", "Старое.md"), "preexisting");
    fs.writeFileSync(path.join(vault, "01_Знания", "Старое.md"), "---\nstatus: устарело\n---\nтело");
    capture(() => cmdArchiveStale(["--commit"]));
    expect(fs.existsSync(path.join(vault, "07_Архив", "Старое-2.md"))).toBe(true);
  });

  it("nothing to do when no stale notes outside the archive", () => {
    fs.writeFileSync(path.join(vault, "01_Знания", "Живое.md"), "---\nstatus: актуально\n---\nтело");
    const { out } = capture(() => cmdArchiveStale([]));
    expect(out).toContain("nothing to do");
  });
});
