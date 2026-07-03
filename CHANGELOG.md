# Changelog

All notable changes to **iapeer-memory** are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html)
(pre-1.0: a minor bump carries features, a patch carries fixes and refinements).

> Versions before 0.3.13 predate this repository's recorded git history and are
> not itemised here; the changelog begins at the first tagged public release.

## [Unreleased]

### Changed

- Repository documentation actualised to the v1.2-only model: the package
  README no longer calls the per-peer session surfaces "plugins", and the
  Russian integration doc gained parity for the pre-v1.2 manual-migration note.

## [0.4.9] - 2026-07-03

Remediation phase 2 (audit 2026-07-02): the six important findings in the
daemon's event loop and lifecycle.

### Fixed

- **Lost flush passes**: a vault-unavailable window or a pass error no longer
  eats the changed set — the paths are re-queued and replayed on a
  bounded-backoff retry timer.
- **Shutdown flush**: `close()` now runs the documented final pass over a
  non-empty pending set (structural-only; embeddings resume next start via
  the restart-safe backfill) — a SIGTERM inside the debounce window no longer
  drops just-made edits from the detect belts.
- **Debounce max-wait cap** (default 10 × debounce): an event storm with
  sub-debounce gaps (iCloud sync, bulk migration) can no longer defer
  indexing for the whole storm.
- **Single-writer lock**: a second memoryd on the same vault/DB now refuses
  at startup (O_EXCL lock + owner liveness via the egress `ps` probe, or
  lock-mtime staleness for bare-core callers) instead of racing the first
  writer's tmp files and SQLite; the pid file is written only after a
  successful start, so a refused second instance no longer clobbers the live
  instance's stop handle.
- **Backfill dedup**: while the background embed backfill drains the global
  queue, a flush indexes structurally only — no inline drain of the whole
  backlog on a single edit, no double-embedding.
- **Stamp persistence cadence**: silent-edit baselines persist on the same
  60 s change-gated cadence as the hash state (was: curator tick / graceful
  close only), so a non-graceful death loses seconds, not hours, of stamps.

## [0.4.8] - 2026-07-03

Remediation phase 1 of the 2026-07-02 full-codebase audit: all seven
confirmed-critical findings fixed at the root layer, each with regression
tests. Ships together with the serve-first memoryd startup (`c07d152`).

### Fixed

- **Eviction ≠ deletion** (audit #2): the indexer registers a note as existing
  from its readdir entry (a read failure no longer counts as "deleted"),
  legacy `.icloud` placeholders count as existing, an aborted or empty scan
  never reaches stale-document deletion, and a mass-delete fuse (>10 files AND
  >20% of the corpus at once) refuses an iCloud-partial-sync wipe unless
  `IAPEER_MEMORY_ALLOW_MASS_DELETE=1`.
- **Watch-loss degradation** (audit #6): a dead `fs.watch` (start-time or a
  runtime `'error'` — previously an uncaught crash) degrades to a polling
  pass (5 min) instead of freezing the index and renders forever; a slow belt
  pass (60 min) insures against silently dead FSEvents; the heartbeat file
  carries `watch=on|off` and `verify` FAILS a fresh-but-degraded daemon.
- **Indexing embed timeout** (audit #3): batch embedding runs on its own
  per-batch timeout (`IAPEER_MEMORY_EMBEDDING_TIMEOUT_MS`, default 60 s)
  instead of the 3 s query default that aborted every batch on a slow local
  endpoint; interactive queries keep the strict 3 s.
- **vec_chunks orphan race** (audit #1): an embed batch returning after its
  note was re-indexed no longer writes a vector under a dead rowid; a one-shot
  GC at writer startup sweeps orphans accumulated pre-fix.
- **Separator-only query tokens** (audit #4): a standalone «—»/«→»/emoji token
  no longer reaches FTS5 as a zero-term phrase (build-dependent zeroing
  semantics); snippet highlighting stays consistent with the FTS terms.
- **Zero-indent YAML lists** (audit #5): `stripEmptyArrays` no longer deletes
  a `tags:` key above zero-indent items (orphaned items = broken frontmatter =
  the note silently out of the index); one shared item recogniser across
  `parseListField` / `removeListField` / the tags gate.
- **Sandbox egress hole in `uninstall`** (audit #7): the `iapeerBin` default
  is gone — a defined value is an explicit-binary egress authorization, so the
  old `"iapeer"` fallback let sandboxed tests send LIVE trigger unregisters to
  the production notifier.

### Added

- Serve-first memoryd startup: the structural index, MCP port and heartbeat
  come up immediately; the (potentially whole-vault) embedding pass runs as a
  restart-safe background backfill.

## [0.4.4] - 2026-06-20

### Removed

- The v1.1 plugin slot-mirror — the `MemoryProviderPlugin` type, the slot's
  `plugin` field, and the `writeSlot` v1.1-detection guard. The iapeer
  foundation no longer reads or writes a `plugin` slot block (its v1.1 parser is
  a tombstone), so the memory-provider slot is now v1.2-only
  (`provision` / `unprovision`).

## [0.4.3] - 2026-06-20

### Removed

- The v1.1→v1.2 migration apparatus in `init` / `update` / `verify` /
  `uninstall` (plugin-slot detection, the postpone-on-failure path, the
  manual-recipe step) and the legacy inbox-sweep trigger cleanup. The
  marketplace-plugin session channel (ADR-017) is gone; the `init`/`update`
  slot write is now an unconditional v1.2 declaration.

### Changed

- Migrating a pre-v1.2 host is now a documented manual step (`uninstall` +
  `init`) — see `docs/10-iapeer-integration.md`.

## [0.4.2] - 2026-06-20

### Removed

- Dead code: unused detector input fields (`DecideUpdateInput.{zone,basename}`,
  `DecideSilentInput.zone`), a duplicate `setIfMissing`, an unreachable
  embedding pipeline state, and unused imports.

### Changed

- De-duplicated surface helpers (shared `writeFileAtomic` and
  `isOurHookCommand`) and replaced hardcoded literals with single-source
  constants (`DEFAULT_REGISTRANT`, `FRAGMENT_STEM`, `mcpPort()`).
- tmux→pty wording in the test-suppression fuse and log-prefix comments
  (mechanisms unchanged).

### Fixed

- Stale doc-comments that described contracts the code no longer implements
  (the `dream-collect` output shape, and the `runRead` / `addTitlePath`
  rationale).

## [0.4.1] - 2026-06-18

### Added

- On-host documentation: the published docs are mirrored to
  `~/.iapeer/docs/iapeer-memory`.
- Minimal GitHub Actions CI (macOS + bun) and a status-badge row.

### Changed

- Consistent colored CLI output across commands via a shared `ui.ts` palette,
  including the `uninstall` report.
- Memory guide: search by the character of the task rather than "before every
  response"; tag-dictionary role wording (the author adds, the Index curates).

## [0.4.0] - 2026-06-18

### Added

- init runtime contract: the role-peer runtime is resolved from the iapeer
  registry instead of a hardcoded `claude`, a `--runtime` flag is threaded
  through, and a host with no runtime degrades gracefully (base + BM25,
  exit 0).
- Interactive embedding and reranker endpoint prompts in `init`.

## [0.3.13] - 2026-06-18

### Added

- Initial public release in this repository — the `@agfpd/iapeer-memory` and
  `@agfpd/iapeer-memory-core` packages: the `memoryd` indexing/search daemon
  (BM25 with optional embeddings and reranker, MCP-over-HTTP), layer-5 context
  fragments injected into peer system prompts, the curator role peers
  (index / scriber / dreamweaver), and the v1.2 memory-provider slot.
- Documentation and LICENSE shipped inside the published npm packages.

[Unreleased]: https://github.com/agfpd/iapeer-memory/compare/v0.4.4...HEAD
[0.4.4]: https://github.com/agfpd/iapeer-memory/compare/v0.4.3...v0.4.4
[0.4.3]: https://github.com/agfpd/iapeer-memory/compare/v0.4.2...v0.4.3
[0.4.2]: https://github.com/agfpd/iapeer-memory/compare/v0.4.1...v0.4.2
[0.4.1]: https://github.com/agfpd/iapeer-memory/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/agfpd/iapeer-memory/compare/v0.3.13...v0.4.0
[0.3.13]: https://github.com/agfpd/iapeer-memory/releases/tag/v0.3.13
