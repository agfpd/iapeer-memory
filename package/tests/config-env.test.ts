import { describe, it, expect } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfigFile, parseEnvFile } from "../src/config-env.js";

describe("parseEnvFile", () => {
  it("parses KEY=VALUE lines", () => {
    expect(parseEnvFile("A=1\nB=two\n")).toEqual({ A: "1", B: "two" });
  });

  it("skips blanks, comments and non-assignment lines", () => {
    const text = "\n# comment\nnot a pair\nA=1\n  # indented comment\n";
    expect(parseEnvFile(text)).toEqual({ A: "1" });
  });

  it("accepts the export prefix", () => {
    expect(parseEnvFile("export A=1\n")).toEqual({ A: "1" });
  });

  it("unwraps one level of matching quotes", () => {
    expect(parseEnvFile(`A="with spaces"\nB='single'\nC="unbalanced\n`)).toEqual({
      A: "with spaces",
      B: "single",
      C: '"unbalanced',
    });
  });

  it("keeps = inside values", () => {
    expect(parseEnvFile("A=x=y\n")).toEqual({ A: "x=y" });
  });

  it("rejects invalid key names", () => {
    expect(parseEnvFile("1BAD=x\nGOOD=1\n")).toEqual({ GOOD: "1" });
  });
});

describe("loadConfigFile", () => {
  it("missing file is a valid state, not an error", () => {
    const env: Record<string, string | undefined> = {};
    const res = loadConfigFile("/nonexistent/config.env", env);
    expect(res.missing).toBe(true);
    expect(env).toEqual({});
  });

  it("applies file values into the env", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "im-cfg-"));
    const file = path.join(dir, "config.env");
    fs.writeFileSync(file, "IAPEER_MEMORY_LOCALE=ru\n");
    const env: Record<string, string | undefined> = {};
    const res = loadConfigFile(file, env);
    expect(res.missing).toBe(false);
    expect(res.applied).toEqual(["IAPEER_MEMORY_LOCALE"]);
    expect(env.IAPEER_MEMORY_LOCALE).toBe("ru");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("an explicit process env wins over the file (deliberate divergence from the MergeMind source-order)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "im-cfg-"));
    const file = path.join(dir, "config.env");
    fs.writeFileSync(file, "IAPEER_MEMORY_LOCALE=ru\nIAPEER_MEMORY_MCP_PORT=9000\n");
    const env: Record<string, string | undefined> = { IAPEER_MEMORY_LOCALE: "en" };
    const res = loadConfigFile(file, env);
    expect(env.IAPEER_MEMORY_LOCALE).toBe("en"); // env wins
    expect(env.IAPEER_MEMORY_MCP_PORT).toBe("9000"); // file fills the gap
    expect(res.shadowed).toEqual(["IAPEER_MEMORY_LOCALE"]);
    expect(res.applied).toEqual(["IAPEER_MEMORY_MCP_PORT"]);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("an EMPTY env value does not shadow the file (harness ${VAR} expansion renders missing vars as '')", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "im-cfg-"));
    const file = path.join(dir, "config.env");
    fs.writeFileSync(file, "IAPEER_MEMORY_LOCALE=ru\n");
    const env: Record<string, string | undefined> = { IAPEER_MEMORY_LOCALE: "" };
    loadConfigFile(file, env);
    expect(env.IAPEER_MEMORY_LOCALE).toBe("ru");
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("parseEnvFile — inline comments (audit cosmetic promoted after a live bite)", () => {
  it("strips the ` #…` tail from an UNQUOTED value", () => {
    // A comment after the value became part of it, skewed the embedding
    // fingerprint and triggered a needless full vault re-embed (2026-07-03).
    const out = parseEnvFile("MODEL=Qwen/Qwen3-Embedding-4B  # actual served model\n");
    expect(out.MODEL).toBe("Qwen/Qwen3-Embedding-4B");
  });

  it("keeps `#` inside a QUOTED value verbatim (quoting is the escape hatch)", () => {
    const out = parseEnvFile('TOKEN="abc #not-a-comment"\n');
    expect(out.TOKEN).toBe("abc #not-a-comment");
  });

  it("a bare `#` glued to the value is NOT a comment (needs the space)", () => {
    const out = parseEnvFile("COLOR=#ff0000\n");
    expect(out.COLOR).toBe("#ff0000");
  });
});
