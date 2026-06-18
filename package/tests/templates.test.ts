import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { renderDoctrine, renderedVersion } from "@agfpd/iapeer-memory-core";
import {
  doctrineOwnership,
  guideTemplatePath,
  guideText,
  materialiseTemplates,
  roleDoctrineTemplate,
  roleTemplatePath,
  ROLE_NAMES,
} from "../src/templates/index.js";
import { readRolesManifest, writeRolesManifest } from "../src/roles.js";
import { runVerify } from "../src/commands/verify.js";
import { fleetRefreshHint } from "../src/commands/update.js";
import { memoryPaths } from "../src/paths.js";
import { liveEgress } from "../src/egress.js";

// Refusing handle under the preload sandbox env; explicit fake bins punch
// through legally (egress allowance 1) — the old env-juggling is gone.
const EG = liveEgress();

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "im-tmpl-"));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("embedded templates", () => {
  it("every role exists in both locales, starts with template frontmatter, and differs", () => {
    const seen = new Set<string>();
    for (const locale of ["en", "ru"] as const) {
      for (const role of ROLE_NAMES) {
        const text = roleDoctrineTemplate(locale, role);
        expect(text.startsWith("---\n")).toBe(true);
        expect(text).toContain(`role: ${role}`);
        expect(seen.has(text)).toBe(false);
        seen.add(text);
      }
    }
    expect(seen.size).toBe(6);
  });

  it("doctrines carry the load-bearing invariants (direct-to-canon model)", () => {
    for (const locale of ["en", "ru"] as const) {
      const index = roleDoctrineTemplate(locale, "index");
      const scriber = roleDoctrineTemplate(locale, "scriber");
      const dw = roleDoctrineTemplate(locale, "dreamweaver");
      // Index: события не детектит сам и НЕ размещает (авторы пишут прямо в канон)
      expect(/never poll|не поллишь/i.test(index)).toBe(true);
      expect(/never place|не размещаешь/i.test(index)).toBe(true);
      // Index владеет полем dir: проектного Описания (ADR-014)
      expect(index).toContain("dir:");
      // needs_review: снимает только Индекс/человек; условия схлопываются по
      // контуру (Index+Scriber = ТРИ, Index-only = ДВА)
      expect(/THREE|ТРИ/.test(index)).toBe(true);
      // unstamped-токен детектора немых записей: Индекс знает маршрут
      // (запись мимо хука → писатель неизвестен → разбор по контексту)
      expect(index).toContain("unstamped");
      // Dream-tick: DreamWeaver ОРКЕСТРИРУЕТ (шеллит
      // детерминированный предфильтр dream-collect, фан-аутит субагентов);
      // Индекс СО ВХОДА УБРАН, только финализирует по отчёту консолидации.
      // Механизм субагентов НЕЙТРАЛЕН (без хардкода тула, не Workflow) ради
      // кроссрантайма (Q1).
      expect(index).not.toContain("dream-paths");
      expect(/consolidation|консолидац/i.test(index)).toBe(true);
      expect(/never orchestrate the dream|не оркестрируешь dream/i.test(index)).toBe(true);
      expect(dw).toContain("dream-collect");
      expect(dw).not.toContain("dream-paths");
      expect(dw).not.toContain("Workflow");
      expect(/runtime's\s+own\s+subagent|субагентов\s+твоего\s+рантайма/i.test(dw)).toBe(true);
      expect(/in-window|заметки в окне/i.test(dw)).toBe(true);
      // Scriber: один отчёт на событие + эхо-брейкер all-zones +
      // прямой пинг rejected-авторам + frozen title в permanent
      expect(/ONE report|ОДИН отчёт/.test(scriber)).toBe(true);
      // финиш безусловно виден механике («тихий финиш»
      // scriber'а не взвёл арм реапа → FIFO стоял; молчание запрещено):
      // субстанция → ровно один send; пусто → self-done (M2b, iapeer 0.2.26 —
      // не-будящий арм, Индекс спит; инвариант «отфильтровано = тишина»)
      expect(/UNCONDITIONALLY|БЕЗУСЛОВНО/.test(scriber)).toBe(true);
      expect(scriber).toContain("self-done");
      expect(/silent\s+finish|молчаливый\s+финиш/.test(scriber)).toBe(true);
      expect(/end the session silently|тихо заверши/.test(scriber)).toBe(false);
      // Индексу пустая форма больше НЕ приходит (self-done вместо send'а)
      expect(/no substance|субстанции нет/.test(index)).toBe(false);
      expect(index).not.toContain("self-done");
      // каденция курации: пачка одной доставкой (CURATOR_TICK) + source-фильтр
      expect(scriber).toContain("CURATOR_TICK");
      expect(/filtered\s+at the source|отфильтрованы источником/.test(scriber)).toBe(true);
      // проблемы автору — прямым пингом по IAP
      expect(/to authors|авторам/i.test(scriber)).toBe(true);
      expect(/FROZEN|ЗАМОРОЖЕН/.test(scriber)).toBe(true);
      // Scriber: про needs_review ни слова (поле не его — директива)
      expect(scriber).not.toContain("needs_review");
      // DreamWeaver: один outbound, без hard-delete
      expect(/ONE outbound|ОДНО исходящее/.test(dw)).toBe(true);
      expect(/hard.delete/i.test(dw)).toBe(true);
      // Каждая роль знает корень vault (scriber угадал
      // find'ом протухшую копию vault — чужой мир сломал эхо-брейкер)
      for (const d of [index, scriber, dw]) expect(d).toContain("{{VAULT_PATH}}");
    }
  });

  it("guides use the locale's folder names (direct-to-canon, no inbox)", () => {
    expect(guideText("en")).toContain("01_Knowledge/");
    expect(guideText("en")).toContain("06_Agent_Memory/");
    expect(guideText("en")).not.toContain("00_Inbox");
    expect(guideText("ru")).toContain("01_Знания/");
    expect(guideText("ru")).toContain("06_Оперативка_агентов/");
    expect(guideText("ru")).not.toContain("00_Входящие");
    // 5 operative subtypes named per locale
    expect(guideText("en")).toContain("pitfall");
    expect(guideText("ru")).toContain("грабли");
  });

  it("guide write-path: {{VAULT_PATH}} substituted with the host fact (literal placeholder)", () => {
    for (const locale of ["en", "ru"] as const) {
      // template form (no vault): the marker is PRESERVED, never guessed
      expect(guideText(locale)).toContain("{{VAULT_PATH}}/");
      expect(guideText(locale)).not.toContain("<vault>"); // старый плейсхолдер истреблён
      // host form: the real path lands inside the write-path instruction
      const sub = guideText(locale, "/Users/x/Vault");
      expect(sub).toContain("/Users/x/Vault/");
      expect(sub).not.toContain("{{VAULT_PATH}}");
    }
  });
});

describe("doctrineOwnership — the init collision guard", () => {
  it("foreign doctrine → 'foreign' (live peer is never rendered over); marker → 'ours'; bare → 'none'", () => {
    const peerCwd = path.join(tmp, "index");
    expect(doctrineOwnership(peerCwd)).toBe("none"); // bare peer
    fs.mkdirSync(path.join(peerCwd, ".iapeer"), { recursive: true });
    fs.writeFileSync(
      path.join(peerCwd, ".iapeer", "IAPEER.md"),
      "# Индекс — куратор vault MergeMind\nЖивая чужая доктрина.\n",
    );
    expect(doctrineOwnership(peerCwd)).toBe("foreign"); // foreign cwd
    fs.writeFileSync(
      path.join(peerCwd, ".iapeer", "IAPEER.md"),
      "<!-- iapeer-memory doctrine v9.9.9 -->\n# Index — vault curator\n",
    );
    expect(doctrineOwnership(peerCwd)).toBe("ours"); // re-init/update path
  });

  it("the CORE's create-scaffold → 'scaffold' (replaceable)", () => {
    // VERBATIM the placeholder `iapeer create` writes (fact: core
    // src/init/index.ts) — the file itself says to replace it.
    const peerCwd = path.join(tmp, "scriber");
    fs.mkdirSync(path.join(peerCwd, ".iapeer"), { recursive: true });
    fs.writeFileSync(
      path.join(peerCwd, ".iapeer", "IAPEER.md"),
      [
        "# Peer doctrine",
        "",
        "<!-- This is the local doctrine for this peer — its role, personality, and mandate.",
        "     It is merged into the system prompt at launch (Канал A). Replace this with",
        "     who this peer is and what it does. An empty doctrine launches a bare peer. -->",
        "",
      ].join("\n"),
    );
    expect(doctrineOwnership(peerCwd)).toBe("scaffold");

    // The re-run recovery path boris runs on the live host: scaffold →
    // our render replaces it → ownership flips to "ours".
    const outcome = renderDoctrine({
      templatePath: (() => {
        const t = path.join(tmp, "t.md");
        fs.writeFileSync(t, "---\nrole: scriber\n---\n# Scriber\nBody.\n");
        return t;
      })(),
      peerCwd,
      version: "0.1.5",
    });
    expect(outcome.action).toBe("written");
    expect(doctrineOwnership(peerCwd)).toBe("ours");
  });

  it("empty/whitespace doctrine file → 'scaffold' (replaceable)", () => {
    const peerCwd = path.join(tmp, "dreamweaver");
    fs.mkdirSync(path.join(peerCwd, ".iapeer"), { recursive: true });
    fs.writeFileSync(path.join(peerCwd, ".iapeer", "IAPEER.md"), "\n\n  \n");
    expect(doctrineOwnership(peerCwd)).toBe("scaffold");
  });
});

describe("materialiseTemplates", () => {
  it("writes 3 roles + guide per locale; idempotent; package-owned overwrite on drift", () => {
    const templatesDir = path.join(tmp, "templates");
    const first = materialiseTemplates({ templatesDir, locale: "ru" });
    expect(first.written.length).toBe(4);

    const again = materialiseTemplates({ templatesDir, locale: "ru" });
    expect(again.written).toEqual([]);
    expect(again.identical.length).toBe(4);

    // drift (e.g. an old package version's content) → overwritten, NOT kept:
    // templates are package-owned runtime artifacts, unlike the vault seeds.
    const indexPath = roleTemplatePath(templatesDir, "ru", "index");
    fs.writeFileSync(indexPath, "stale content from v0.0.1\n");
    const healed = materialiseTemplates({ templatesDir, locale: "ru" });
    expect(healed.written).toEqual([indexPath]);
    expect(fs.readFileSync(indexPath, "utf-8")).toContain("Индекс — куратор vault");

    expect(fs.existsSync(guideTemplatePath(templatesDir, "ru"))).toBe(true);
  });
});

describe("render integration (template → doctrine → verify)", () => {
  it("a materialised template renders into a version-marked doctrine and verify accepts it", () => {
    const templatesDir = path.join(tmp, "templates");
    materialiseTemplates({ templatesDir, locale: "en" });

    const peerCwd = path.join(tmp, "peers", "index");
    fs.mkdirSync(peerCwd, { recursive: true });
    const template = roleTemplatePath(templatesDir, "en", "index");
    const outcome = renderDoctrine({ templatePath: template, peerCwd, version: "3.0.0", vaultPath: "/srv/test-vault" });
    expect(outcome.action).toBe("written");

    const rendered = fs.readFileSync(path.join(peerCwd, ".iapeer", "IAPEER.md"), "utf-8");
    expect(renderedVersion(rendered)).toBe("3.0.0");
    expect(rendered).not.toContain("role: index"); // template frontmatter stripped
    expect(rendered).toContain("Index — vault curator");
    // {{VAULT_PATH}} substitution: host fact lands in the doctrine; the
    // placeholder itself never survives the render
    expect(rendered).toContain("/srv/test-vault");
    expect(rendered).not.toContain("{{VAULT_PATH}}");

    // verify reads the manifest written by our writer and reports ok
    const vault = path.join(tmp, "vault");
    fs.mkdirSync(vault, { recursive: true });
    process.env.IAPEER_MEMORY_VAULT_PATH = vault;
    try {
      const paths = memoryPaths({ HOME: tmp, IAPEER_MEMORY_STATE_DIR: path.join(tmp, "state") });
      writeRolesManifest({
        rolesManifestPath: paths.rolesManifestPath,
        roles: [{ role: "index", peerCwd, template }],
      });
      expect(readRolesManifest(paths.rolesManifestPath)!.roles.length).toBe(1);
      const results = runVerify(EG, { paths, version: "3.0.0" });
      const doctrine = results.find((r) => r.name === "doctrine[index]")!;
      expect(doctrine.status).toBe("ok");
    } finally {
      delete process.env.IAPEER_MEMORY_VAULT_PATH;
    }
  });
});

describe("fleetRefreshHint — operator nudge only when the guide actually changed", () => {
  const guide = guideTemplatePath("/t", "ru");

  it("guide template among written → hint suggesting `iapeer refresh --all`", () => {
    const h = fleetRefreshHint([roleTemplatePath("/t", "ru", "index"), guide], guide);
    expect(h).not.toBeNull();
    expect(h).toContain("iapeer refresh --all");
    expect(h).toContain("guide");
  });

  it("roles-only change (guide identical) → null (curators self-refresh, no nudge)", () => {
    expect(fleetRefreshHint([roleTemplatePath("/t", "ru", "scriber")], guide)).toBeNull();
  });

  it("nothing written → null", () => {
    expect(fleetRefreshHint([], guide)).toBeNull();
  });
});
