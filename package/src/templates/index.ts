/**
 * Template registry + materialisation. Content is EMBEDDED in the package
 * (TS constants → bundled into the compiled binary; no fs lookup into an
 * evictable npx cache). init/update MATERIALISE the templates to
 * `<plugins>/iapeer-memory/templates/<locale>/…` — the stable on-disk form
 * the roles manifest points at and `verify --repair` re-renders from.
 *
 * Ownership: unlike the vault 99_System seeds (operator-owned, written
 * once), the materialised templates are PACKAGE-owned runtime artifacts —
 * they follow the package version and are overwritten on change
 * (bytes-compare, no mtime churn).
 */

import fs from "node:fs";
import path from "node:path";
import type { LocaleId } from "@agfpd/iapeer-memory-core";
import { GUIDE_EN } from "./guide-en.js";
import { GUIDE_RU } from "./guide-ru.js";
import { guardedWriteFileSync } from "@agfpd/iapeer-memory-core";
import {
  SCRIBER_DOCTRINE_EN,
  DREAMWEAVER_DOCTRINE_EN,
  INDEX_DOCTRINE_EN,
} from "./roles-en.js";
import {
  SCRIBER_DOCTRINE_RU,
  DREAMWEAVER_DOCTRINE_RU,
  INDEX_DOCTRINE_RU,
} from "./roles-ru.js";

export const ROLE_NAMES = ["index", "scriber", "dreamweaver"] as const;
export type RoleName = (typeof ROLE_NAMES)[number];

/**
 * Peer PERSONALITY of a role — the BRAND names, identical to the conceptual
 * role names (by decision: «index должен остаться с таким же
 * именем — это бренд, не memory-index»; the `memory-*` namespace variant
 * was built and rolled back the same day). Collision safety therefore rests
 * ENTIRELY on the init roles-step GUARD: a pre-existing peer with a foreign
 * doctrine fails loud with a recipe, never gets rendered over (прецедент:
 * «index» был занят живым Индексом предшественника до cutover'а). The single
 * mapping point is kept so a future namespace decision is one line.
 */
export function rolePersonality(role: RoleName): string {
  return role;
}

/** The distinctive phrase of the CORE's create-scaffold placeholder (fact:
 *  iapeer src/init/index.ts — `iapeer create` writes a 6-line IAPEER.md
 *  that literally says to replace it). Live-caught once:
 *  the guard's first form read the scaffold as «foreign» and false-failed
 *  on freshly created role peers. */
const CORE_SCAFFOLD_PHRASE = "An empty doctrine launches a bare peer";

/**
 * Who owns a peer's rendered doctrine — the init COLLISION GUARD's eye.
 * "ours" = carries the ADR-010 marker (re-init/update path);
 * "scaffold" = the core's create-placeholder or an empty file — REPLACEABLE
 * by design (the scaffold itself says «Replace this»);
 * "foreign" = somebody else's LIVE doctrine (rendering over it would hijack
 * the peer — FAIL loud; the predecessor-Index precedent is sacred);
 * "none" = no doctrine file, ours to render.
 */
export function doctrineOwnership(
  peerCwd: string,
): "ours" | "foreign" | "scaffold" | "none" {
  let current: string;
  try {
    current = fs.readFileSync(path.join(peerCwd, ".iapeer", "IAPEER.md"), "utf-8");
  } catch {
    return "none";
  }
  if (current.includes("<!-- iapeer-memory doctrine")) return "ours";
  if (current.includes(CORE_SCAFFOLD_PHRASE) || current.trim() === "") {
    return "scaffold";
  }
  return "foreign";
}

const ROLES: Record<LocaleId, Record<RoleName, string>> = {
  en: {
    index: INDEX_DOCTRINE_EN,
    scriber: SCRIBER_DOCTRINE_EN,
    dreamweaver: DREAMWEAVER_DOCTRINE_EN,
  },
  ru: {
    index: INDEX_DOCTRINE_RU,
    scriber: SCRIBER_DOCTRINE_RU,
    dreamweaver: DREAMWEAVER_DOCTRINE_RU,
  },
};

const GUIDES: Record<LocaleId, string> = { en: GUIDE_EN, ru: GUIDE_RU };

export function roleDoctrineTemplate(locale: LocaleId, role: RoleName): string {
  return ROLES[locale][role];
}

/**
 * Writer-guide text. With `vaultPath` the `{{VAULT_PATH}}` marker is
 * substituted (host fact — the host-wide guide once shipped the
 * write-path as a literal placeholder, peers could not know where to
 * write); without it the marker is preserved — that is the TEMPLATE form
 * (materialiseTemplates keeps templates host-neutral).
 */
export function guideText(locale: LocaleId, vaultPath?: string): string {
  const text = GUIDES[locale];
  if (!vaultPath) return text;
  return text.replaceAll("{{VAULT_PATH}}", vaultPath);
}

/** Stable on-disk path of a materialised role template. */
export function roleTemplatePath(
  templatesDir: string,
  locale: LocaleId,
  role: RoleName,
): string {
  return path.join(templatesDir, locale, `${role}.md`);
}

export function guideTemplatePath(templatesDir: string, locale: LocaleId): string {
  return path.join(templatesDir, locale, "guide.md");
}

export type MaterialiseResult = { written: string[]; identical: string[] };

/** Write the locale's templates to disk (package-owned: overwrite on change). */
export function materialiseTemplates(opts: {
  templatesDir: string;
  locale: LocaleId;
}): MaterialiseResult {
  const written: string[] = [];
  const identical: string[] = [];
  const entries: Array<[string, string]> = [
    ...ROLE_NAMES.map(
      (role): [string, string] => [
        roleTemplatePath(opts.templatesDir, opts.locale, role),
        roleDoctrineTemplate(opts.locale, role),
      ],
    ),
    [guideTemplatePath(opts.templatesDir, opts.locale), guideText(opts.locale)],
  ];
  for (const [file, content] of entries) {
    let existing: string | null = null;
    try {
      existing = fs.readFileSync(file, "utf-8");
    } catch {
      existing = null;
    }
    if (existing === content) {
      identical.push(file);
      continue;
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    guardedWriteFileSync(tmp, content, "utf-8");
    fs.renameSync(tmp, file);
    written.push(file);
  }
  return { written, identical };
}
