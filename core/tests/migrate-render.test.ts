/**
 * Stage-10 tests:
 * - migrate-auto-memory — translation of the reference
 *   `tests/python/test_migrate_auto_memory.py` (16 fixtures, taxonomy
 *   tokens via the RU preset = reference literals) + the dry-run smoke;
 * - render-doctrine — translation of `test_render_agent_files.py`
 *   (7 fixtures) adapted to the surviving peerDoctrine-only target
 *   (ADR-009/010) + the version-marker smoke;
 * - memoryd detect-hash persistence (stage-9 review note 5).
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  parseFlatFrontmatter,
  mapTypeToSubtype,
  buildNewFrontmatter,
  planMigration,
  applyMigration,
} from "../src/migrate-auto-memory.js";
import {
  renderDoctrine,
  renderRoleDoctrines,
  stripTemplateFrontmatter,
  versionMarker,
  renderedVersion,
} from "../src/render-doctrine.js";
import { loadHashState, persistHashState } from "../src/memoryd.js";
import { TAXONOMY_RU } from "../src/taxonomy.js";

const T = TAXONOMY_RU;

// ── parseFlatFrontmatter (reference block 1) ────────────────────────────────

describe("migrate: parseFlatFrontmatter", () => {
  it("empty text", () => {
    expect(parseFlatFrontmatter("")).toEqual([{}, ""]);
  });

  it("no frontmatter", () => {
    expect(parseFlatFrontmatter("Just body\n")).toEqual([{}, "Just body\n"]);
  });

  it("basic frontmatter", () => {
    const [fm, body] = parseFlatFrontmatter("---\ntype: user\ndescription: О владельце\n---\n\nBody\n");
    expect(fm.type).toBe("user");
    expect(fm.description).toBe("О владельце");
    expect(body).toContain("Body");
  });

  it("values kept as-is, including quotes", () => {
    const [fm] = parseFlatFrontmatter('---\ndescription: "в кавычках: да"\n---\nx');
    expect(fm.description).toBe('"в кавычках: да"');
  });
});

// ── type → subtype mapping (reference block 2) ──────────────────────────────

describe("migrate: mapTypeToSubtype (taxonomy tokens)", () => {
  it("user → профиль_человека", () => expect(mapTypeToSubtype("user", T)).toBe("профиль_человека"));
  it("feedback → обратная_связь", () => expect(mapTypeToSubtype("feedback", T)).toBe("обратная_связь"));
  it("project → контекст", () => expect(mapTypeToSubtype("project", T)).toBe("контекст"));
  it("reference → справка", () => expect(mapTypeToSubtype("reference", T)).toBe("справка"));
  it("unknown/empty → контекст (default)", () => {
    expect(mapTypeToSubtype("weird", T)).toBe("контекст");
    expect(mapTypeToSubtype("", T)).toBe("контекст");
  });
});

// ── buildNewFrontmatter (reference block 3) ─────────────────────────────────

describe("migrate: buildNewFrontmatter", () => {
  it("includes the required agent-memory fields (tokens from taxonomy)", () => {
    const fm = buildNewFrontmatter({
      title: "Заметка",
      subtype: "справка",
      description: "коротко",
      created: "2026-05-01",
      author: "boris",
      taxonomy: T,
    });
    expect(fm).toContain("title: Заметка");
    expect(fm).toContain(`type: ${T.types.agentMemory}`);
    expect(fm).toContain("subtype: справка");
    expect(fm).toContain(`status: ${T.statusTokens.current}`);
    expect(fm).toContain("description: коротко");
    expect(fm).toContain("created: 2026-05-01");
    expect(fm).toContain("author: boris");
  });

  it("description with a colon goes through the SHARED yaml-safe serialiser", () => {
    const fm = buildNewFrontmatter({
      title: "X", subtype: "контекст", description: "Handoff: статус",
      created: "2026-05-01", author: "b", taxonomy: T,
    });
    // Deviation from the reference (single-quote escaping): one source of
    // quoting rules — double-quoted via yamlSafeScalar.
    expect(fm).toContain('description: "Handoff: статус"');
  });
});

// ── integration: plan + apply (reference block 4) ───────────────────────────

describe("migrate: plan + apply on a tmp source", () => {
  let tmp: string;
  let source: string;
  let vault: string;
  let backupRoot: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "iapeer-memory-mig-"));
    source = path.join(tmp, "agent-memory", "boris");
    vault = path.join(tmp, "vault");
    backupRoot = path.join(tmp, "backup");
    fs.mkdirSync(source, { recursive: true });
    fs.mkdirSync(vault, { recursive: true });
  });

  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  function writeSrc(name: string, content: string): void {
    fs.writeFileSync(path.join(source, name), content, "utf-8");
  }

  function migrate() {
    return applyMigration({ sourceDir: source, agent: "boris", vault, backupRoot, taxonomy: T });
  }

  it("dry-run (plan) maps correctly and writes NOTHING (stage smoke)", () => {
    writeSrc("Профиль.md", "---\ntype: user\ndescription: о владельце\n---\n\nТело\n");
    writeSrc("Грабли инструмента.md", "---\ntype: feedback\n---\nfb\n");
    writeSrc("MEMORY.md", "system index\n");
    const plan = planMigration({ sourceDir: source, agent: "boris", vault, taxonomy: T });
    expect(plan.totalToMigrate).toBe(2);
    expect(plan.subtypeCounts["профиль_человека"]).toBe(1);
    expect(plan.subtypeCounts["обратная_связь"]).toBe(1);
    expect(plan.skippedSystem).toEqual(["MEMORY.md"]);
    // ничего не записано и не удалено
    expect(fs.existsSync(path.join(vault, T.folders.agentMemory))).toBe(false);
    expect(fs.readdirSync(source).sort()).toEqual(
      ["MEMORY.md", "Грабли инструмента.md", "Профиль.md"].sort(),
    );
  });

  it("basic migration of a user-type note", () => {
    writeSrc("Профиль.md", "---\ntype: user\ndescription: о владельце\n---\n\nТело заметки\n");
    const res = migrate();
    expect(res.migrated).toEqual(["Профиль.md"]);
    const out = fs.readFileSync(
      path.join(vault, T.folders.agentMemory, "boris", "Профиль.md"),
      "utf-8",
    );
    expect(out).toContain("subtype: профиль_человека");
    expect(out).toContain(`type: ${T.types.agentMemory}`);
    expect(out).toContain("author: boris");
    expect(out).toContain("Тело заметки");
  });

  it("source file removed after success", () => {
    writeSrc("N.md", "---\ntype: reference\n---\nx\n");
    migrate();
    expect(fs.existsSync(path.join(source, "N.md"))).toBe(false);
  });

  it("idempotent repeat skips an existing target", () => {
    writeSrc("N.md", "---\ntype: reference\n---\nверсия 1\n");
    migrate();
    const target = path.join(vault, T.folders.agentMemory, "boris", "N.md");
    const first = fs.readFileSync(target, "utf-8");
    fs.mkdirSync(source, { recursive: true });
    writeSrc("N.md", "---\ntype: reference\n---\nверсия 2 НЕ должна затереть\n");
    const res2 = migrate();
    expect(res2.skipped).toEqual(["N.md"]);
    expect(fs.readFileSync(target, "utf-8")).toBe(first);
  });

  it("backup dir contains the originals (including MEMORY.md)", () => {
    writeSrc("N.md", "---\ntype: project\n---\nоригинал\n");
    writeSrc("MEMORY.md", "индекс памяти\n");
    const res = migrate();
    const backed = fs.readdirSync(res.backupDir).sort();
    expect(backed).toEqual(["MEMORY.md", "N.md"]);
    expect(fs.readFileSync(path.join(res.backupDir, "N.md"), "utf-8")).toContain("оригинал");
  });

  it("MEMORY.md backed up and removed, never copied to the vault", () => {
    writeSrc("MEMORY.md", "индекс\n");
    const res = migrate();
    expect(fs.existsSync(path.join(source, "MEMORY.md"))).toBe(false);
    expect(
      fs.existsSync(path.join(vault, T.folders.agentMemory, "boris", "MEMORY.md")),
    ).toBe(false);
    expect(fs.existsSync(path.join(res.backupDir, "MEMORY.md"))).toBe(true);
    expect(res.sourceRemoved).toBe(true);
  });

  it("unknown type falls back to the default subtype", () => {
    writeSrc("X.md", "---\ntype: bizarre\n---\nx\n");
    migrate();
    const out = fs.readFileSync(
      path.join(vault, T.folders.agentMemory, "boris", "X.md"),
      "utf-8",
    );
    expect(out).toContain("subtype: контекст");
  });
});

// ── render-doctrine (reference render-agent-files, surviving core) ──────────

describe("render-doctrine: templates → peerDoctrine with a version marker", () => {
  let tmp: string;
  let peerCwd: string;
  let tpl: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "iapeer-memory-rd-"));
    peerCwd = path.join(tmp, "peer");
    fs.mkdirSync(peerCwd, { recursive: true });
    tpl = path.join(tmp, "index.md.tmpl");
    fs.writeFileSync(tpl, "---\nname: index\nmodel: whatever\n---\n\n# Доктрина Индекса\n\nИнструкции.\n", "utf-8");
  });

  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it("writes the doctrine when absent: frontmatter stripped, marker prepended (stage smoke)", () => {
    const res = renderDoctrine({ templatePath: tpl, peerCwd, version: "1.2.3" });
    expect(res.action).toBe("written");
    const out = fs.readFileSync(res.target, "utf-8");
    expect(out.startsWith(versionMarker("1.2.3"))).toBe(true);
    expect(out).toContain("# Доктрина Индекса");
    expect(out).not.toContain("model: whatever"); // template frontmatter stripped
    expect(renderedVersion(out)).toBe("1.2.3"); // verify-сторона читает маркер
  });

  it("idempotent: identical template+version → no rewrite", () => {
    renderDoctrine({ templatePath: tpl, peerCwd, version: "1.2.3" });
    const res2 = renderDoctrine({ templatePath: tpl, peerCwd, version: "1.2.3" });
    expect(res2.action).toBe("identical");
  });

  it("rewrites when the template changed", () => {
    renderDoctrine({ templatePath: tpl, peerCwd, version: "1.2.3" });
    fs.writeFileSync(tpl, "---\nname: index\n---\n\n# Новая доктрина\n", "utf-8");
    const res = renderDoctrine({ templatePath: tpl, peerCwd, version: "1.2.3" });
    expect(res.action).toBe("written");
    expect(fs.readFileSync(res.target, "utf-8")).toContain("# Новая доктрина");
  });

  it("rewrites when only the version bumped (verify-driven re-render)", () => {
    renderDoctrine({ templatePath: tpl, peerCwd, version: "1.2.3" });
    const res = renderDoctrine({ templatePath: tpl, peerCwd, version: "1.3.0" });
    expect(res.action).toBe("written");
    expect(renderedVersion(fs.readFileSync(res.target, "utf-8"))).toBe("1.3.0");
  });

  it("missing template reported; other roles still render", () => {
    const out = renderRoleDoctrines({
      version: "1.0.0",
      roles: [
        { role: "index", templatePath: path.join(tmp, "nope.tmpl"), peerCwd },
        { role: "scriber", templatePath: tpl, peerCwd: path.join(tmp, "peer2") },
      ],
    });
    expect(out[0]!.action).toBe("missing-template");
    expect(out[1]!.action).toBe("written");
    expect(fs.existsSync(path.join(tmp, "peer2", ".iapeer", "IAPEER.md"))).toBe(true);
  });

  it("atomic: no tmp leftovers next to the doctrine", () => {
    renderDoctrine({ templatePath: tpl, peerCwd, version: "1.2.3" });
    const files = fs.readdirSync(path.join(peerCwd, ".iapeer"));
    expect(files).toEqual(["IAPEER.md"]);
  });

  it("template without frontmatter renders verbatim under the marker", () => {
    fs.writeFileSync(tpl, "# Голый шаблон\n", "utf-8");
    const res = renderDoctrine({ templatePath: tpl, peerCwd, version: "2.0.0" });
    const out = fs.readFileSync(res.target, "utf-8");
    expect(out).toBe(`${versionMarker("2.0.0")}\n# Голый шаблон\n`);
  });
});

// ── memoryd hash persistence (stage-9 note 5) ───────────────────────────────

describe("memoryd hash-state persistence", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "iapeer-memory-hs-"));
  });

  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it("round-trip: persist → load preserves valid entries", () => {
    const file = path.join(tmp, "memoryd.hashes.json");
    const map = new Map([["/v/a.md", "a".repeat(64)], ["/v/b.md", "b".repeat(64)]]);
    persistHashState(file, map);
    const loaded = loadHashState(file);
    expect(loaded.size).toBe(2);
    expect(loaded.get("/v/a.md")).toBe("a".repeat(64));
    // atomic: no tmp leftovers
    expect(fs.readdirSync(tmp)).toEqual(["memoryd.hashes.json"]);
  });

  it("load rejects malformed values and survives a corrupt file", () => {
    const file = path.join(tmp, "memoryd.hashes.json");
    fs.writeFileSync(file, JSON.stringify({ "/v/a.md": "not-a-hash", "/v/b.md": "c".repeat(64) }));
    const loaded = loadHashState(file);
    expect(loaded.size).toBe(1);
    fs.writeFileSync(file, "{broken json");
    expect(loadHashState(file).size).toBe(0); // first-run semantics, no throw
  });
});
