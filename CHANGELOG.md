# Changelog

All notable changes to **iapeer-memory** are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html)
(pre-1.0: a minor bump carries features, a patch carries fixes and refinements).

> Versions before 0.3.13 predate this repository's recorded git history and are
> not itemised here; the changelog begins at the first tagged public release.

## [Unreleased]

## [0.4.16] - 2026-07-03

Remediation phase 9 (audit 2026-07-02): the cosmetic batch — the final
remainder of the audit. 16 findings fixed (4 of the 23 cosmetics had
already been closed in passing by 0.4.11–0.4.13).

### Fixed

- **memoryd/core**: `runDetectPass` serialized through the flushing chain
  (no interleaved double flush); heartbeat written via tmp+rename (a reader
  between truncate and write no longer sees an empty file); the
  `needs_review` auto-clear pass honors the configured `indexAgent` instead
  of the literal `"index"`; `decideUpdate` assembles files via the shared
  `assemble()` — byte parity with the hook path, ending the smart-hash
  flip-flop on the post-fence blank line; `vault_read` not-found responses
  no longer leak the absolute vault path (raw error goes to stderr);
  `memory_map` ranks cluster `top_nodes` on the full degree map
  (`degreeTotals` in `VaultMapData`) instead of the hubs-only rebuild that
  degraded to alphabetical order; a per-search meta cache plus a new
  `edges(target_path)` index kill repeated meta parses and full edge scans
  on the search hot path (transparent `IF NOT EXISTS` migration); graph.ts
  switched to an iterative Tarjan with an explicit stack and index-pointer
  BFS — no stack overflow / O(n²) queues on large vaults.
- **package**: the tag gate reads the tags-dictionary from the local mirror
  first (vault source as fallback) — an evicted iCloud placeholder no
  longer silently disarms the gate; `sameJson` is a structural, key-order-
  insensitive deep-equal — no more perpetual repair churn against foreign
  JSON normalisers; codex TOML surgery recognises the quoted header form
  (`[mcp_servers."iapeer-memory"]`) as ours, preventing duplicate-table
  corruption of a peer's config; `writeExecutable` repairs a lost exec bit
  instead of reporting «identical»; `renderRoleDoctrines` requires
  `vaultPath` so the batch API can't render placeholder doctrines; the CLI
  help and render.ts header now state which artifacts memoryd actually
  renders continuously (index/fragment) versus init/update/verify's duty
  (doctrine/guide).

### Changed

- Docs (EN+RU) aligned with the code: the archive is flat (no genre
  subfolders, numeric suffixes on collisions); memoryd does not render the
  shared guide (init/update do); `status` shows no «inbox»; the weekly
  dream timer is registered in `curated` mode only — the default `lean`
  runs no curation ticks.
- Hook tag-gate tests are hermetic: pinned to a sandbox
  `IAPEER_MEMORY_CACHE_DIR` (the mirror-first read otherwise reached the
  host's live mirror), plus a mirror-first gate test.
- Repository documentation actualised to the v1.2-only model: the package
  README no longer calls the per-peer session surfaces "plugins", and the
  Russian integration doc gained parity for the pre-v1.2 manual-migration note.

## [0.4.15] - 2026-07-03

Remediation phase 8 (audit 2026-07-02): the render/surface layer — the LAST
of the 43 important findings. With this release every critical and
important finding of the audit is fixed.

### Fixed

- **Doctrines always carry the host fact**: the manual `render doctrine`
  path rendered `{{VAULT_PATH}}` as a placeholder while stamping the
  current version, and verify's marker-only check read the crippled
  doctrine as «ok» forever. `render doctrine` resolves the vault the same
  way update/init/verify do, and verify now detects the placeholder text.
- **The provision lock is OWNED**: an owner token (pid + nonce) inside the
  lock dir; stale-breaking requires a confirmed-dead owner (ps probe) —
  an age-only break used to tear the lock from a live holder mid-sweep
  (racing read-merge-writes of the same settings.json); release only
  removes the holder's own lock (the third-writer cascade is closed);
  trust-hooks spawns under the lock are bounded (30 s).
- **Unique tmp names** for fleet.json and surface writes: concurrent
  verify --repair runs shared one `.tmp` — a torn fleet map (fragment
  rendering silently off) or an ENOENT crash of the losing writer.
- **Path-ladder symmetry**: tagsProjectionPath is passed into startMemoryd —
  under an `IAPEER_MEMORY_DB_PATH` override the repair-path
  `render fragment` silently rendered fragments without the tags
  dictionary.
- **bytes-compared renders**: atomicWrite/writeFragmentAtomic skip
  identical content — every debounced flush used to rewrite 3×N fleet
  files with unchanged bytes (mtime churn across every peer's surfaces).

## [0.4.14] - 2026-07-03

Remediation phase 7 (audit 2026-07-02): the curation belts and the sandbox
belt — the silent-metadata-corruption class.

### Fixed

- **A human's needs_review clear persists**: the service-only guard used to
  compare against the 6h-frozen curator-tick baseline — clearing the flag
  after an agent's recent content edit was judged a content change, the
  flag was forced back and the human landed in coauthors of a note they
  never touched. The guard now receives the per-pass semantic baseline.
- **Freshness is measured against the WRITE, not the observation**: a
  hook-stamped edit seen late (sync-storm straggler, first event after
  daemon downtime) was re-attributed to the human; |mtime − updated| within
  the window now recognises «the stamp came with the content», however late
  the daemon looks.
- **fm-update round-trips conservatively**: constructs outside its model —
  block scalars, nested maps, non-ASCII keys, zero-indent lists — are kept
  as opaque raw entries serialised verbatim in place. A `--set status` pass
  used to erase a note's whole block-scalar description. Only the true
  orphan (`- value` with no open key — the sed-artifact class) is still
  dropped.
- **Balanced flow collections are not quoted into strings**: Obsidian
  `aliases: [A, B]` survived as an array; a dangling `[` is still quoted.
- **rename joined the sandbox belt**: guardedRenameSync asserts BOTH ends,
  every renameSync call site converted, `fs.renameSync` added to the grep
  invariant — a sandboxed daemon could physically MOVE live team notes into
  the prod archive with the belt silent. memoryd also refuses to START
  under the test sandbox over a production vault path.

## [0.4.13] - 2026-07-03

Remediation phase 6 (audit 2026-07-02): the search/MCP layer — ranking
coherence and resilience.

### Fixed

- **Reranker tail on the same scale**: candidates outside topK kept their
  raw pipeline score × 0.3 (raw FTS5 magnitudes run 1.5–15) against
  normalized (≤ 1.0) reranked scores — in BM25-only mode (the routine
  serve-first degradation window) the WORST candidates topped the final
  list. The tail now normalizes by the same maxScore; the candidate window
  is also re-sorted after the status boost.
- **Body evidence for the reranker**: vector-found candidates carried an
  empty pipeline snippet, so the cross-encoder compared the query against a
  bare title and systematically sank pure-semantic hits; rerank texts now
  build from the note's chunks (the same evidence the final snippet uses).
- **The archive ranks as the archive**: a note moved into the archive by
  hand keeps its active status and used to get the ×1.2 boost — the folder
  now floors the multiplier at the stale penalty regardless of status.
- **Dedup input capped** to 2 × chunkSize: whole-body embeds of long notes
  overflowed local embedders and two failures opened the breaker shared
  with memory_search — 60 s of silent BM25-only for the whole team.
- **Case-insensitive exclude guard**: on case-insensitive APFS a
  lowercase-spelled system folder bypassed the privacy filter and the
  direct-disk fallback read the hidden file (latent — runRead is off the
  MCP surface).
- **config.env inline comments**: an unquoted value ends at ` #` (dotenv
  convention) — a trailing comment no longer becomes part of the value;
  quote the value to keep a literal `#`.

## [0.4.12] - 2026-07-03

Remediation phase 5 (audit 2026-07-02): the embedding layer. (The fourth
important finding of this section — backfill/flush double-embedding — was
already fixed in 0.4.9.)

### Fixed

- **Retrying embed backfill**: memoryd racing the embedding endpoint up
  after a reboot used to die on the first refused batch and leave the vault
  BM25-only until the next edit, logging «backfill complete» over a 0-of-N
  failure. The backfill is a retry loop now (backoff 60 s ×5 → 15 min cap,
  cancellable on shutdown); «complete» is logged only when the queue is
  actually empty, a stall reports the pending count honestly.
- **Validated embedder responses**: row count must match the batch, vector
  dimensions must match the config, OpenAI rows are re-bound by their
  `index` field, TEI gets the same checks. Short/misshapen/other-dimension
  responses take the graceful error path instead of a TypeError, a stored
  0-length vector (NaN in cosine), or an eternally crashing vec insert.
- **Durable vec invalidation**: a model swap while sqlite-vec is not
  loadable arms a persistent flag; the first vec-capable start clears the
  stale mirror (old-model vectors under live rowids that the backfill would
  never overwrite).
- `backfillVecChunks` yields between batches — the synchronous loop blocked
  the event loop (and the MCP port) for the whole mirroring pass.

## [0.4.11] - 2026-07-03

Remediation phase 4 (audit 2026-07-02): five important + two cosmetic
findings in the indexing backbone. PARSER_VERSION 2→3: the first start
re-parses the vault and the background backfill re-embeds it; serve-first
keeps BM25/MCP live throughout.

### Fixed

- **O(changed) hot path**: a file change now indexes THAT file — the flush
  used to read and sha256 the entire vault (plus provoke iCloud
  re-downloads) on every debounce window. Deletions of changed paths are
  targeted and move-aware; full-walk reconciliation stays on startup and
  the poll/belt passes.
- **Visible broken links**: a genuinely deleted note's incoming wikilinks
  park in `unresolved_links` (snippet preserved) instead of silently
  vanishing from the graph — the health surface sees them and the self-heal
  pass restores the edge if the note returns.
- **stripLinksSection (leading form)** validates the block structure line
  by line: real content between the links block and a later `---` (or a
  setext underline) no longer drops out of the index.
- **Config-aware chunking fingerprint**: changing
  `IAPEER_MEMORY_CHUNK_SIZE`/`_OVERLAP` (or the locale) re-chunks the vault
  instead of leaving a permanent mix of slicings.
- **gray-matter cache off**: the optionless call cached every parsed note
  text forever in the long-lived daemon — a pure, hitless leak.
- **Whitespace-aware chunk splitting**: `findSplitIndex` always returned
  `chunkSize` (dead logic) — every boundary tore words and surrogate pairs;
  overlap tails now align to token boundaries too.
- CRLF notes: the trailing links-block divider is recognised with `\r`.
- Legacy diary migration clears the embedding fingerprint so rebuilt chunk
  ids are never attributed old vectors.

## [0.4.10] - 2026-07-03

Remediation phase 3 (audit 2026-07-02): eight important findings across the
CLI facade and the docs contract. This release closes the self-repair loop
end to end — the class behind the 12h overnight memoryd hang.

### Fixed

- **Self-repair kick in the compiled binary**: the session-start hook
  spawned `<binary> /$bunfs/…/cli.ts verify --repair` → «unknown command» —
  the ADR-010 self-repair NEVER ran in production while the hook reported
  «Kicked … in the background». The kick now branches on the compiled
  runtime.
- **`verify --repair` terminates a hung memoryd**: a stale heartbeat under
  `--repair` now SIGTERMs the command-line-verified daemon, escalates to
  SIGKILL after a 5 s grace (a deadlocked event loop never runs its SIGTERM
  handler), removes the pid file only after confirmed death, and lets the
  notifier's exit-detection relaunch — the watcher.ts «no gap» contract was
  documented but unimplemented.
- **Stale dream timer with the role OFF** is now a FAIL (was: a masking
  skip), and `--repair` unregisters it, as docs/11 always promised.
- **Re-init split-brain guard**: `init --vault` pointing away from the vault
  the host runs with refuses loudly (doctrines/guide would re-point while
  config.env/memoryd stayed — peers would write into a vault nobody
  indexes); the interactive prompt now defaults to the current vault.
- **`IAPEER_MEMORY_DREAM_TRANSCRIPT_CAP=0`** now means «no cap» as
  documented.
- **Release pipeline**: the working-tree cleanliness gate moved to
  `preversion` — `git add -A` can no longer launder uncommitted changes into
  the release commit and the npm tarballs.
- **`migrate` dry-run** now lists non-md files that `--apply` removes from
  the source (backup-only) — the confirmed plan equals the applied mutation.
- **Docs (EN+RU 03/08/11)**: `needs_review` prose now matches the code —
  every non-curator write sets the flag; the flag is the curation queue.

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
