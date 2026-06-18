/**
 * Public surface of `@agfpd/iapeer-memory-core` — the modules the package
 * facade (CLI) consumes. Deliberately EXPLICIT, not
 * `export *`: the barrel is the contract boundary between core and the
 * distribution layer; deep imports stay possible
 * inside the workspace but everything the facade needs must be listed here
 * (also avoids real symbol collisions, e.g. the two internal `atomicWrite`s).
 */

// config
export {
  configFromEnv,
  ensureEndpointNotProxied,
  ensureLoopbackNotProxied,
  type CoreConfig,
} from "./config.js";

// taxonomy (ADR-002/011)
export {
  getTaxonomy,
  isLocaleId,
  defaultExcludeFolders,
  genreForFolder,
  isStale,
  statusGroup,
  DEFAULT_CURATOR_SET,
  DEFAULT_RANKING,
  type LocaleId,
  type RankingConfig,
  type TaxonomyPreset,
  type TaxonomyInitialStatus,
} from "./taxonomy.js";

// frontmatter: post-write fill + structural fm-update (CLI contract in module header)
export {
  processFile,
  resolveAgentName,
  splitFrontmatter,
  resolveZone,
  type ProcessOptions,
  type Zone,
} from "./frontmatter-fill.js";
export { fmUpdate, collectOps, yamlSafeScalar, type FmUpdateOptions, type Op } from "./fm-update.js";

// mode + per-role proactivity (lean §7/§7.1)
export {
  resolveMode,
  curationPlan,
  type MemoryMode,
  type RoleSet,
  type CurationPlan,
} from "./mode.js";

// dedup + link-hint bands (lean §3a/§3b)
export {
  runDedup,
  DEFAULT_DEDUP_THRESHOLD,
  DEFAULT_LINK_HINT_THRESHOLD,
  type DedupMatch,
} from "./search.js";

// deterministic archiving (lean §2.2a)
export {
  isArchivableZone,
  statusOf,
  shouldArchive,
  archiveTargetRel,
} from "./archive.js";
export { snapshotVault } from "./permanent-detect.js";

// tag gate + injected dictionary projection (lean §3)
export { tagsDictionarySourceRel } from "./tags-mirror.js";
export {
  parseDictionaryEntries,
  parseDictionaryTags,
  isTagAllowed,
  parseNoteTags,
  tagGateProblems,
  renderTagsProjection,
  DEFAULT_TAGS_BOUNDARY_MAXLEN,
  type DictionaryEntry,
  type TagGateOptions,
  type ProjectionOptions,
} from "./tags-gate.js";

// author index rendering
export { regenerateVaultIndex, fullIndexPathFor, type RenderContext } from "./index-render.js";

// layer-5 fragments (ADR-001)
export {
  FRAGMENT_STEM,
  peerFragmentsDir,
  renderPeerFragment,
  writeHostWideGuideFragment,
  type FragmentEnv,
} from "./context-render.js";

// role doctrines + version marker (ADR-009/010)
export {
  renderDoctrine,
  renderRoleDoctrines,
  renderedVersion,
  versionMarker,
  type RenderOutcome,
} from "./render-doctrine.js";

// memoryd (ADR-004/012)
export {
  startMemoryd,
  MEMORYD_SERVER_NAME,
  type MemorydHandle,
  type MemorydOptions,
  type MemorydFragmentsWiring,
  type FleetPeer,
} from "./memoryd.js";

// auto-memory migration (engine; sources are adapter-scoped)
export { planMigration, applyMigration, type MigrationPlan, type MigrationResult } from "./migrate-auto-memory.js";

// sqlite runtime probe (vec availability — visible degradation, never silent)
export { prepareSqliteRuntime, type SqliteRuntime } from "./sqlite-loader.js";

// logging
export { makeLogger, type Logger } from "./log.js";

export {
  sandboxEnvArmed,
  isUnderProdAnchor,
  isHarnessTreeOutsideSandbox,
  sandboxBlocksProdRead,
  assertSandboxWritablePath,
  guardedWriteFileSync,
  guardedUnlinkSync,
  guardedRmSync,
} from "./fs-guard.js";
