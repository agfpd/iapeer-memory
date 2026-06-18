/**
 * Host provisioning primitives of init (P3a slice): the vault skeleton and
 * the package config. Both IDEMPOTENT and USER-RESPECTING: existing files
 * are never overwritten (the config and the 99_System seeds become
 * operator-owned the moment they exist — docs/10 «пользователь правит,
 * пакет не перезаписывает»).
 *
 * The 99_System seeds are generated from the taxonomy preset in code (one
 * source of truth with the folder/status tokens) — they are SEEDS, not
 * templates of ours to maintain: the human/Index grow them afterwards.
 */

import fs from "node:fs";
import path from "node:path";
import type { LocaleId, MemoryMode, TaxonomyPreset } from "@agfpd/iapeer-memory-core";
import { guardedWriteFileSync } from "@agfpd/iapeer-memory-core";

export type ProvisionResult = {
  createdDirs: string[];
  createdFiles: string[];
  kept: string[];
};

/** 4-field minimal frontmatter — the human's editor template (docs/01). */
export function draftTemplateContent(taxonomy: TaxonomyPreset): string {
  return [
    "---",
    "title: {{title}}",
    `status: ${taxonomy.statusTokens.draft}`,
    "created: {{date}}",
    "author: {{author}}",
    "---",
    "",
    "",
  ].join("\n");
}

/**
 * Project Overview template seed (ADR-014): the editor template for the
 * human/Index when starting a project group. Carries the `dir:` field —
 * the source of truth for the project's working directory.
 */
export function overviewTemplateContent(taxonomy: TaxonomyPreset): string {
  const ru = taxonomy.locale === "ru";
  const name = ru ? "{{имя}}" : "{{name}}";
  return [
    "---",
    `title: ${taxonomy.projectFiles.overviewPrefix}${name}`,
    "type: " + (ru ? "проект" : "project"),
    "tags:",
    ru ? "  - {{Доменный_Тег}}" : "  - {{Domain_Tag}}",
    "status: " + (ru ? "активный" : "active"),
    "created: {{date}}",
    ru ? "author: {{maintainer латиницей}}" : "author: {{maintainer}}",
    ru
      ? "dir: {{абсолютный или ~-относительный путь рабочей папки проекта — источник правды}}"
      : "dir: {{absolute or ~-relative path to the project's working directory — the source of truth}}",
    "---",
    "",
    `# ${taxonomy.projectFiles.overviewPrefix}${name}`,
    "",
    ru
      ? "Что за проект, цель, текущее состояние верхнего уровня."
      : "What the project is, its goal, the current top-level state.",
    "",
  ].join("\n");
}

/** Empty tags dictionary seed — the Index grows it (docs/07). */
export function tagsDictionaryContent(taxonomy: TaxonomyPreset): string {
  const ru = taxonomy.locale === "ru";
  return [
    ru ? "## Доменные теги" : "## Domain tags",
    "",
    ru
      ? "<!-- Канонический список top-level доменных тегов. Ведёт Index; новый домен — строка в таблице. Граница обязательна для пересекающихся доменов. -->"
      : "<!-- The canonical list of top-level domain tags. Curated by the Index; a new domain = a new table row. The boundary phrase is mandatory for overlapping domains. -->",
    "",
    ru ? "| Тег | Граница — про что (опционально) |" : "| Tag | Boundary — what it covers (optional) |",
    "|---|---|",
    "",
  ].join("\n");
}

/**
 * Create the vault folder skeleton + 99_System seeds. Returns what was
 * created vs kept; never deletes or overwrites anything.
 */
export function provisionVault(opts: {
  vaultPath: string;
  taxonomy: TaxonomyPreset;
}): ProvisionResult {
  const { vaultPath, taxonomy } = opts;
  const createdDirs: string[] = [];
  const createdFiles: string[] = [];
  const kept: string[] = [];

  for (const folder of Object.values(taxonomy.folders)) {
    const dir = path.join(vaultPath, folder);
    if (fs.existsSync(dir)) {
      kept.push(folder);
    } else {
      fs.mkdirSync(dir, { recursive: true });
      createdDirs.push(folder);
    }
  }

  // The Overview template lives next to the draft template (same Templates/
  // subfolder, provision-level name — not a taxonomy token: only the seeds
  // know it, nothing parses it back).
  const overviewSeedRel = path.join(
    path.dirname(taxonomy.systemFiles.draftTemplate),
    `${taxonomy.projectFiles.overviewPrefix.trim()}.md`,
  );
  const seeds: Array<[rel: string, content: string]> = [
    [
      path.join(taxonomy.folders.system, taxonomy.systemFiles.draftTemplate),
      draftTemplateContent(taxonomy),
    ],
    [
      path.join(taxonomy.folders.system, taxonomy.systemFiles.tagsDictionary),
      tagsDictionaryContent(taxonomy),
    ],
    [path.join(taxonomy.folders.system, overviewSeedRel), overviewTemplateContent(taxonomy)],
  ];
  for (const [rel, content] of seeds) {
    const file = path.join(vaultPath, rel);
    if (fs.existsSync(file)) {
      kept.push(rel);
      continue;
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    guardedWriteFileSync(file, content, "utf-8");
    createdFiles.push(rel);
  }

  return { createdDirs, createdFiles, kept };
}

export type ConfigContentOptions = {
  vaultPath: string;
  locale: LocaleId;
  /** Curation mode written at init (lean §7). Default lean for new installs. */
  mode: MemoryMode;
  human?: string | null;
  embeddingEndpoint?: string | null;
  rerankerEndpoint?: string | null;
};

/** The default package config — operator-owned once written. */
export function defaultConfigContent(opts: ConfigContentOptions): string {
  return [
    "# iapeer-memory package config (env format).",
    "# Precedence: CLI flags > process env > this file > built-in defaults.",
    "# This file is operator-owned: the package writes it ONCE at init and",
    "# never overwrites it (verify/update leave it alone).",
    "",
    `IAPEER_MEMORY_VAULT_PATH=${opts.vaultPath}`,
    `IAPEER_MEMORY_LOCALE=${opts.locale}`,
    opts.human
      ? `IAPEER_MEMORY_HUMAN_NAME=${opts.human}`
      : "# IAPEER_MEMORY_HUMAN_NAME=",
    "",
    "# Curation mode (lean §7): lean = NO proactive curation triggers — the base",
    "# (write-hook fill + tag-gate + archive + dedup + projection) ALWAYS runs and the",
    "# role peers are always provisioned (callable on-demand); curated = the",
    "# Index/Scriber/DreamWeaver pipeline fires by itself. Independent per-role",
    "# overrides: IAPEER_MEMORY_PROACTIVE_{INDEX,SCRIBER,DREAMWEAVER}=on|off.",
    `IAPEER_MEMORY_MODE=${opts.mode}`,
    "",
    "# MCP endpoint of memoryd (ADR-012). 8766 = iapeer-MCP neighbour.",
    "# IAPEER_MEMORY_MCP_PORT=8766",
    "",
    "# Search providers (ADR-013). Empty endpoints = BM25-only, a valid state.",
    opts.embeddingEndpoint
      ? `IAPEER_MEMORY_EMBEDDING_ENDPOINT=${opts.embeddingEndpoint}`
      : "# IAPEER_MEMORY_EMBEDDING_ENDPOINT=",
    "# IAPEER_MEMORY_EMBEDDING_PROVIDER=openai",
    "# IAPEER_MEMORY_EMBEDDING_MODEL=Qwen/Qwen3-Embedding-8B",
    opts.rerankerEndpoint
      ? `IAPEER_MEMORY_RERANKER_ENDPOINT=${opts.rerankerEndpoint}`
      : "# IAPEER_MEMORY_RERANKER_ENDPOINT=",
    "# IAPEER_MEMORY_RERANKER_PROVIDER=tei",
    "",
    "# Curator personalities exempt from needs_review stamping (ADR-006).",
    "# IAPEER_MEMORY_CURATOR_SET=index,scriber,dreamweaver",
    "",
    "# Lean §3: per-tag boundary budget in the injected dictionary projection",
    "# (×whole fleet — keep tight). Boundary text over this many chars is clipped.",
    "# IAPEER_MEMORY_TAGS_BOUNDARY_MAXLEN=160",
    "",
    "# Lean §3a: dedup hint on canon writes — raw cosine similarity threshold",
    "# above which an existing canon note is surfaced as a possible duplicate.",
    "# Needs embeddings (semantic); with embeddings off the hint is silent.",
    "# IAPEER_MEMORY_DEDUP_THRESHOLD=0.78",
    "# Lean §3b: link-hint band lower bound — cosine in [this, DEDUP_THRESHOLD)",
    "# surfaces «semantically close, maybe link [[…]]» (additive to the Index).",
    "# IAPEER_MEMORY_LINK_HINT_THRESHOLD=0.68",
    "",
    "# Weekly dream-tick (deterministic pre-filter → DreamWeaver). Schedule is",
    "# 5-field cron; the window is days BY TIME (not since-last-tick).",
    "# IAPEER_MEMORY_DREAM_CRON=0 4 * * 1",
    "# IAPEER_MEMORY_DREAM_WINDOW_DAYS=7",
    "# description longer than this many chars → a reformulation candidate.",
    "# IAPEER_MEMORY_DREAM_DESC_MAXLEN=250",
    "# >threshold new notes in a folder → its own subagent; smaller folders are",
    "# grouped up to the cap (sum of per-folder weights).",
    "# IAPEER_MEMORY_DREAM_BATCH_THRESHOLD=20",
    "# IAPEER_MEMORY_DREAM_GROUP_CAP=20",
    "# Per-folder cap on transcripts handed to phase D (most recent N by mtime;",
    "# bounds an ephemeral worker's hundreds of sessions). 0 = uncapped.",
    "# IAPEER_MEMORY_DREAM_TRANSCRIPT_CAP=20",
    "",
  ].join("\n");
}

export function writeDefaultConfig(
  opts: ConfigContentOptions & { configFile: string },
): "written" | "exists" {
  if (fs.existsSync(opts.configFile)) return "exists";
  fs.mkdirSync(path.dirname(opts.configFile), { recursive: true });
  guardedWriteFileSync(opts.configFile, defaultConfigContent(opts), "utf-8");
  return "written";
}
