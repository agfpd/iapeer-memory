# Changelog

All notable changes to iapeer-memory are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html)
(pre-1.0: a minor bump carries features, a patch carries fixes and refinements).

> Versions before 0.3.13 predate this repository's recorded git history and are
> not itemised here; the changelog begins at the first tagged public release.

## [Unreleased]

### Changed

- Repository documentation actualised to the v1.2-only model: the package
  README no longer calls the per-peer session surfaces "plugins", and the
  Russian integration doc gained parity for the pre-v1.2 manual-migration note.

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
