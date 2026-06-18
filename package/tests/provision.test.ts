import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getTaxonomy } from "@agfpd/iapeer-memory-core";
import {
  defaultConfigContent,
  provisionVault,
  writeDefaultConfig,
} from "../src/provision.js";

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "im-prov-"));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("provisionVault", () => {
  it("creates the full EN folder skeleton + 99_System seeds", () => {
    const vault = path.join(tmp, "vault");
    const taxonomy = getTaxonomy("en");
    const r = provisionVault({ vaultPath: vault, taxonomy });
    for (const folder of Object.values(taxonomy.folders)) {
      expect(fs.statSync(path.join(vault, folder)).isDirectory()).toBe(true);
    }
    expect(r.createdDirs.length).toBe(Object.values(taxonomy.folders).length);
    const draft = fs.readFileSync(
      path.join(vault, "99_System", "Templates", "Draft.md"),
      "utf-8",
    );
    expect(draft).toContain("status: draft");
    const tags = fs.readFileSync(path.join(vault, "99_System", "Tags.md"), "utf-8");
    expect(tags).toContain("## Domain tags");
    expect(tags).toContain("|---|---|");
    // ADR-014: the Overview template seed carries the dir: field
    const overview = fs.readFileSync(
      path.join(vault, "99_System", "Templates", "Overview.md"),
      "utf-8",
    );
    expect(overview).toContain("dir: {{");
    expect(overview).toContain("type: project");
  });

  it("RU preset gets RU folders, tokens and seed filenames", () => {
    const vault = path.join(tmp, "vault");
    const taxonomy = getTaxonomy("ru");
    provisionVault({ vaultPath: vault, taxonomy });
    expect(fs.existsSync(path.join(vault, "01_Знания"))).toBe(true);
    expect(fs.existsSync(path.join(vault, "06_Оперативка_агентов"))).toBe(true);
    expect(fs.existsSync(path.join(vault, "00_Входящие"))).toBe(false); // inbox gone
    const draft = fs.readFileSync(
      path.join(vault, "99_Система", "Шаблоны", "Черновик.md"),
      "utf-8",
    );
    expect(draft).toContain("status: черновик");
    expect(
      fs.readFileSync(path.join(vault, "99_Система", "Теги.md"), "utf-8"),
    ).toContain("## Доменные теги");
    expect(
      fs.readFileSync(path.join(vault, "99_Система", "Шаблоны", "Описание.md"), "utf-8"),
    ).toContain("dir: {{");
  });

  it("idempotent and user-respecting: existing files are never overwritten", () => {
    const vault = path.join(tmp, "vault");
    const taxonomy = getTaxonomy("en");
    provisionVault({ vaultPath: vault, taxonomy });
    const tagsFile = path.join(vault, "99_System", "Tags.md");
    fs.writeFileSync(tagsFile, "| Custom | grown by the Index |\n");
    const r2 = provisionVault({ vaultPath: vault, taxonomy });
    expect(r2.createdDirs).toEqual([]);
    expect(r2.createdFiles).toEqual([]);
    expect(fs.readFileSync(tagsFile, "utf-8")).toContain("Custom");
  });
});

describe("writeDefaultConfig", () => {
  it("writes the operator-owned config once; existing config is sacred", () => {
    const configFile = path.join(tmp, "plugins", "iapeer-memory", "config.env");
    expect(
      writeDefaultConfig({ configFile, vaultPath: "/v", locale: "ru", mode: "lean", human: "arthur" }),
    ).toBe("written");
    const text = fs.readFileSync(configFile, "utf-8");
    expect(text).toContain("IAPEER_MEMORY_VAULT_PATH=/v");
    expect(text).toContain("IAPEER_MEMORY_LOCALE=ru");
    expect(text).toContain("IAPEER_MEMORY_HUMAN_NAME=arthur");
    expect(text).toContain("IAPEER_MEMORY_MODE=lean"); // lean §7: default for new installs

    fs.writeFileSync(configFile, "IAPEER_MEMORY_VAULT_PATH=/operator-moved\n");
    expect(
      writeDefaultConfig({ configFile, vaultPath: "/v", locale: "en", mode: "lean" }),
    ).toBe("exists");
    expect(fs.readFileSync(configFile, "utf-8")).toContain("/operator-moved");
  });

  it("human absent → commented placeholder line", () => {
    const text = defaultConfigContent({ vaultPath: "/v", locale: "en", mode: "curated" });
    expect(text).toContain("# IAPEER_MEMORY_HUMAN_NAME=");
    expect(text).toContain("IAPEER_MEMORY_MODE=curated");
  });
});
