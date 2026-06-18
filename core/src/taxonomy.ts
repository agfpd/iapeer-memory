/**
 * Vault taxonomy as configuration — ADR-002 (taxonomy is config, not code
 * constants) and ADR-011 (EN base nomenclature, RU as the first locale
 * preset).
 *
 * Every folder name, enum value (type / status / subtype), the links-section
 * heading, project file-name prefixes and system file names live here.
 * i18n = presets of this same configuration: the EN base plus the RU preset
 * (the live reference vault, used for migration parity).
 *
 * The canonical RU↔EN mapping is the «Таксономия» table — this module
 * encodes that table; tests guard shape parity between presets.
 *
 * Ranking coefficients are locale-independent and live in DEFAULT_RANKING —
 * same ADR-002 rule (config, not constants), different axis (tuning, not
 * language).
 */

export type LocaleId = "en" | "ru";

export type StatusGroup = "active" | "pending" | "stale";

export type TaxonomyFolders = {
  knowledge: string;
  decisions: string;
  projects: string;
  ideas: string;
  lists: string;
  agentMemory: string;
  archive: string;
  system: string;
};

export type TaxonomyTypes = {
  knowledge: string;
  decision: string;
  idea: string;
  project: string;
  list: string;
  agentMemory: string;
};

export type TaxonomySubtypes = {
  feedback: string;
  context: string;
  reference: string;
  personProfile: string;
  pitfall: string;
};

/** Individual status tokens the WRITER side must emit (hook fills). */
export type TaxonomyStatusTokens = {
  /** The draft status token (pending group) — author-settable WIP marker. */
  draft: string;
  /** Initial status of a new agent-memory note. */
  current: string;
};

/**
 * Initial `status` token a new note of each canonical type carries — the
 * guard fills `status` on the permanent branch from the FOLDER's type (lean
 * mode §2.1, «начальный токен типа»). Verified against the live RU vault:
 * knowledge→актуально, decision→принято, idea→новая, list→актуально,
 * project→активный, agent_memory→актуально. Every token is a member of
 * `statuses.active` (parity-tested).
 */
export type TaxonomyInitialStatus = Record<keyof TaxonomyTypes, string>;

export type TaxonomyStatuses = {
  /** Current/live lifecycle states — search boost ×activeBoost. */
  active: string[];
  /** Draft/deferred states — search boost ×pendingPenalty. */
  pending: string[];
  /** Final/closed states — search boost ×stalePenalty; trigger archiving
   *  and are filtered out of author indexes. */
  stale: string[];
};

export type TaxonomyProjectFiles = {
  /** `Overview <name>.md` / `Описание <имя>.md` */
  overviewPrefix: string;
  /** `Plan <name>.md` / `План <имя>.md` */
  planPrefix: string;
  /** `Phase — <title>.md` / `Фаза — <название>.md` */
  phasePrefix: string;
};

export type TaxonomySystemFiles = {
  draftTemplate: string;
  tagsDictionary: string;
};

/** Locale strings for the author-index renderer (display, not schema). */
export type TaxonomyIndexStrings = {
  /** `# {header} \`agent\`` */
  header: string;
  generatedComment: string;
  sections: {
    agentMemory: string;
    knowledge: string;
    decisions: string;
    projects: string;
    ideas: string;
    lists: string;
  };
  emptySection: string;
  /** Suffix after the link count: `3 св.` / `3 links`. */
  linksSuffix: string;
  /** Placeholder in the projects folder display: `<имя>` / `<name>`. */
  namePlaceholder: string;
  /** `{bits}` and `{path}` placeholders. */
  truncatedMarker: string;
  memoryLabel: string;
  canonLabel: string;
  /** `{parts}` placeholder. */
  projectsTrimmed: string;
  /** `{n}` and `{cap}` placeholders. */
  pendingPhases: string;
  /** `{n}` and `{cap}` placeholders. */
  overHardCap: string;
};

export type TaxonomyPreset = {
  locale: LocaleId;
  folders: TaxonomyFolders;
  types: TaxonomyTypes;
  subtypes: TaxonomySubtypes;
  /** Subtype render order in author indexes (visual grouping). */
  subtypeOrder: string[];
  statuses: TaxonomyStatuses;
  statusTokens: TaxonomyStatusTokens;
  /** Per-type initial `status` token — the guard fills the permanent branch
   *  from the folder's type (lean §2.1). */
  initialStatus: TaxonomyInitialStatus;
  /** Phase status tokens in their project-group render order:
   *  planned → active → paused → completed → cancelled. */
  phaseStatusOrder: string[];
  indexStrings: TaxonomyIndexStrings;
  /** Links-section heading, e.g. `## Links` / `## Связи`. */
  linksSection: string;
  projectFiles: TaxonomyProjectFiles;
  systemFiles: TaxonomySystemFiles;
};

/** EN base — public nomenclature accepted by ADR-011. */
export const TAXONOMY_EN: TaxonomyPreset = {
  locale: "en",
  folders: {
    knowledge: "01_Knowledge",
    decisions: "02_Decisions",
    projects: "03_Projects",
    ideas: "04_Ideas",
    lists: "05_Lists",
    agentMemory: "06_Agent_Memory",
    archive: "07_Archive",
    system: "99_System",
  },
  types: {
    knowledge: "knowledge",
    decision: "decision",
    idea: "idea",
    project: "project",
    list: "list",
    agentMemory: "agent_memory",
  },
  subtypes: {
    feedback: "feedback",
    context: "context",
    reference: "reference",
    personProfile: "person_profile",
    pitfall: "pitfall",
  },
  subtypeOrder: ["feedback", "context", "reference", "person_profile", "pitfall"],
  statuses: {
    active: ["current", "active", "accepted", "new", "in_progress"],
    pending: ["draft", "planned", "paused"],
    stale: ["outdated", "superseded", "dropped", "completed", "cancelled"],
  },
  statusTokens: { draft: "draft", current: "current" },
  initialStatus: {
    knowledge: "current",
    decision: "accepted",
    idea: "new",
    project: "active",
    list: "current",
    agentMemory: "current",
  },
  phaseStatusOrder: ["planned", "active", "paused", "completed", "cancelled"],
  indexStrings: {
    header: "Vault index of notes by",
    generatedComment: "<!-- Generated by iapeer-memory index-render. Do not edit manually. -->",
    sections: {
      agentMemory: "Agent memory",
      knowledge: "Knowledge",
      decisions: "Decisions",
      projects: "Projects",
      ideas: "Ideas",
      lists: "Lists",
    },
    emptySection: "_(no notes of this type yet)_",
    linksSuffix: "links",
    namePlaceholder: "<name>",
    truncatedMarker: "_Index truncated: {bits}. Full uncapped list — `Read {path}`._",
    memoryLabel: "memory",
    canonLabel: "canon",
    projectsTrimmed: "projects: trimmed {parts}",
    pendingPhases: "{n} PENDING phases (section > {cap})",
    overHardCap: "{n} over the {cap} limit",
  },
  linksSection: "## Links",
  projectFiles: {
    overviewPrefix: "Overview ",
    planPrefix: "Plan ",
    phasePrefix: "Phase — ",
  },
  systemFiles: {
    draftTemplate: "Templates/Draft.md",
    tagsDictionary: "Tags.md",
  },
};

/**
 * RU preset — the live reference-vault taxonomy (frozen, ADR-002).
 * Values are verbatim from the reference `src/` constants;
 * migration parity runs against this preset.
 */
export const TAXONOMY_RU: TaxonomyPreset = {
  locale: "ru",
  folders: {
    knowledge: "01_Знания",
    decisions: "02_Решения",
    projects: "03_Проекты",
    ideas: "04_Идеи",
    lists: "05_Списки",
    agentMemory: "06_Оперативка_агентов",
    archive: "07_Архив",
    system: "99_Система",
  },
  types: {
    knowledge: "знание",
    decision: "решение",
    idea: "идея",
    project: "проект",
    list: "список",
    agentMemory: "оперативка агентов",
  },
  subtypes: {
    feedback: "обратная_связь",
    context: "контекст",
    reference: "справка",
    personProfile: "профиль_человека",
    pitfall: "грабли",
  },
  subtypeOrder: ["обратная_связь", "контекст", "справка", "профиль_человека", "грабли"],
  statuses: {
    // RU carries gendered/inflected duplicates the EN base collapses
    // (активный/активная → active; завершён/завершена → completed).
    active: ["актуально", "активный", "активная", "принято", "новая", "реализуется"],
    pending: ["черновик", "запланирована", "на паузе"],
    stale: ["устарело", "заменено", "отброшена", "завершён", "завершена", "отменена"],
  },
  statusTokens: { draft: "черновик", current: "актуально" },
  initialStatus: {
    knowledge: "актуально",
    decision: "принято",
    idea: "новая",
    project: "активный",
    list: "актуально",
    agentMemory: "актуально",
  },
  phaseStatusOrder: ["запланирована", "активная", "на паузе", "завершена", "отменена"],
  indexStrings: {
    header: "Vault-индекс заметок автора",
    generatedComment: "<!-- Сгенерировано iapeer-memory index-render. Не править вручную. -->",
    sections: {
      agentMemory: "Оперативка агентов",
      knowledge: "Знания",
      decisions: "Решения",
      projects: "Проекты",
      ideas: "Идеи",
      lists: "Списки",
    },
    emptySection: "_(пока нет твоих заметок этого типа)_",
    linksSuffix: "св.",
    namePlaceholder: "<имя>",
    truncatedMarker: "_Индекс обрезан: {bits}. Полный список заметок (без cap'а) — `Read {path}`._",
    memoryLabel: "оперативка",
    canonLabel: "канон",
    projectsTrimmed: "проекты: отрезано {parts}",
    pendingPhases: "{n} PENDING-фаз (секция > {cap})",
    overHardCap: "{n} сверх лимита {cap}",
  },
  linksSection: "## Связи",
  projectFiles: {
    overviewPrefix: "Описание ",
    planPrefix: "План ",
    phasePrefix: "Фаза — ",
  },
  systemFiles: {
    draftTemplate: "Шаблоны/Черновик.md",
    tagsDictionary: "Теги.md",
  },
};

const PRESETS: Record<LocaleId, TaxonomyPreset> = {
  en: TAXONOMY_EN,
  ru: TAXONOMY_RU,
};

export function getTaxonomy(locale: LocaleId): TaxonomyPreset {
  return PRESETS[locale];
}

export function isLocaleId(value: string): value is LocaleId {
  return value === "en" || value === "ru";
}

/**
 * Path prefix for the agent-memory zone (`06_Agent_Memory/<name>/...`).
 * Used by both the foreign-memory score penalty (search) and the one-way
 * graph filter (mcp-tools). One derived value for both call sites.
 *
 * DB paths are stored without a leading slash, so the marker has none.
 * The trailing slash is load-bearing: a note named
 * `06_Agent_Memory_README.md` must NOT be classified as agent memory.
 */
export function agentMemoryFolderMarker(taxonomy: TaxonomyPreset): string {
  return `${taxonomy.folders.agentMemory}/`;
}

/**
 * Status → lifecycle group lookup. Returns null for unknown statuses
 * (no boost / no penalty — neutral, mirrors the reference behaviour where
 * an unknown status falls through all three Set checks).
 */
export function statusGroup(
  taxonomy: TaxonomyPreset,
  status: string,
): StatusGroup | null {
  if (taxonomy.statuses.active.includes(status)) return "active";
  if (taxonomy.statuses.pending.includes(status)) return "pending";
  if (taxonomy.statuses.stale.includes(status)) return "stale";
  return null;
}

/** True when `status` is a final/closed token — the archiving predicate
 *  (lean §2.2a: `isStale → move to archive`). Mirrors the search/index
 *  semantics (`statusGroup === "stale"`); a single source for the memoryd
 *  archiver and the index renderer. `на паузе`/`paused` are PENDING, not
 *  stale — a resumable note is never archived. */
export function isStale(taxonomy: TaxonomyPreset, status: string | null | undefined): boolean {
  if (!status) return false;
  return statusGroup(taxonomy, status.trim()) === "stale";
}

/**
 * Folder-key → type-key pairing (lean §2.1 «helper выравнивания ключей»):
 * the two maps are parallel-keyed but differ by plurality
 * (`decisions`↔`decision`, `ideas`↔`idea`, `lists`↔`list`,
 * `projects`↔`project`). `agentMemory` is paired too — the memory zone reuses
 * the same alignment. Inbox/archive/system have no canonical type.
 */
const FOLDER_TYPE_PAIRS: ReadonlyArray<[keyof TaxonomyFolders, keyof TaxonomyTypes]> = [
  ["knowledge", "knowledge"],
  ["decisions", "decision"],
  ["projects", "project"],
  ["ideas", "idea"],
  ["lists", "list"],
  ["agentMemory", "agentMemory"],
];

/**
 * Genre (type + initial status) declared by a vault FOLDER name — the guard
 * derives `type` and the starting `status` from the note's position (lean
 * §2.1: «Папка = объявление жанра»). `folderName` is the first path segment
 * relative to the vault. Returns null for folders without a canonical type
 * (both inboxes, archive, system) — the caller fills no type/status there.
 */
export function genreForFolder(
  taxonomy: TaxonomyPreset,
  folderName: string,
): { type: string; initialStatus: string } | null {
  for (const [fKey, tKey] of FOLDER_TYPE_PAIRS) {
    if (taxonomy.folders[fKey] === folderName) {
      return { type: taxonomy.types[tKey], initialStatus: taxonomy.initialStatus[tKey] };
    }
  }
  return null;
}

/**
 * Default search-index exclusions: the system folder (templates/dictionary,
 * not content). The archive is NOT excluded — it stays searchable with the
 * stale boost. (Inbox folders are gone — authors write straight into canon.)
 */
export function defaultExcludeFolders(taxonomy: TaxonomyPreset): string[] {
  return [taxonomy.folders.system];
}

/**
 * Regex matching a body that STARTS with the links section, mirroring the
 * reference parser semantics: `\b` is ASCII-only in JS, useless after a
 * cyrillic heading, so the pattern uses `(?:\s|$)` explicitly.
 */
export function linksSectionPattern(taxonomy: TaxonomyPreset): RegExp {
  const escaped = taxonomy.linksSection.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${escaped}(?:\\s|$)`);
}

/**
 * Ranking coefficients — locale-independent tuning config (ADR-002).
 * Defaults are verbatim from the reference `search.ts`.
 */
export type RankingConfig = {
  activeBoost: number;
  pendingPenalty: number;
  stalePenalty: number;
  /** Foreign agent-memory penalty (×0.7). */
  foreignAgentMemoryPenalty: number;
  /** 1-hop graph-expand neighbour penalty. */
  graphExpandPenalty: number;
  /** Incoming-wikilink count from which a note counts as a hub. */
  backlinkHubThreshold: number;
  backlinkHubBoost: number;
};

export const DEFAULT_RANKING: RankingConfig = {
  activeBoost: 1.2,
  pendingPenalty: 0.8,
  stalePenalty: 0.5,
  foreignAgentMemoryPenalty: 0.7,
  graphExpandPenalty: 0.4,
  backlinkHubThreshold: 5,
  backlinkHubBoost: 1.15,
};

/**
 * Curator set (ADR-006): personalities whose edits are sanctioned curation —
 * the post-write hook does NOT stamp `needs_review` for them, and zone
 * validation accepts their edits on foreign notes within a task. Replaces the
 * reference hard-coded `agent != "index"` rule. Config, not a constant: the
 * set is extendable per deployment.
 */
export const DEFAULT_CURATOR_SET: readonly string[] = [
  "index",
  "scriber",
  "dreamweaver",
];
