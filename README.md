# iapeer-memory

**Shared memory for a team of AI agents — the memory component of [iapeer](https://github.com/agfpd/iapeer).**

[![CI](https://github.com/agfpd/iapeer-memory/actions/workflows/ci.yml/badge.svg)](https://github.com/agfpd/iapeer-memory/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@agfpd/iapeer-memory)](https://www.npmjs.com/package/@agfpd/iapeer-memory)
[![license](https://img.shields.io/npm/l/@agfpd/iapeer-memory)](./LICENSE)
[![platform](https://img.shields.io/badge/platform-macOS-lightgrey)](#quick-start)

iapeer-memory gives a team of [iapeer](https://github.com/agfpd/iapeer) agents one shared, long-term memory. One agent writes down a finding — the whole team retrieves it by search, across session restarts and context compaction. The package IS the system: a daemon, search, and curators over plain markdown files.

> **Built for iapeer.** It isn't a standalone product — it runs only inside [iapeer](https://github.com/agfpd/iapeer), alongside `notifier-runtime`. It occupies iapeer's single memory slot and reaches agents through iapeer's own mechanisms: the system prompt, messaging, and schedules. Here it's simply the memory part of iapeer.

## How it works

```text
   an agent writes                   an agent searches
   a note into the vault             memory_search("…")
        │                                 │
        ▼                                 ▼
   ┌───────────────────────────────────────────┐
   │  memoryd — index · search · delivery        │
   │  one daemon over a plain-markdown vault     │
   └───────────────────────────────────────────┘
        │                                 │
        ▼                                 ▼
   curators (on a tick)              system prompt:
   links · health · consolidation    the agent's note map
```

## Quick start

Requirements: **macOS**, plus a working [iapeer](https://github.com/agfpd/iapeer) and `notifier-runtime` — memory is delivered by iapeer's system prompt and driven by notifier's events and schedules.

```sh
# install and provision: vault, daemon, curators, the memory slot
npx @agfpd/iapeer-memory init
```

`init` asks for the vault path and the folder-layout language (English or Russian), then sets everything up. Once the slot is claimed, every peer gets memory automatically when it's created or onboarded in iapeer (`iapeer create` / `iapeer init`) — no separate step. (Running `iapeer onboard` to set up the host installs memory for you.)

Check the chain:

```sh
iapeer-memory status     # vault, daemon, slot, search
```

## What makes it different

- **Shared team memory.** One agent's finding is available to all — not per-agent silos. Notes survive session restarts and context compaction.
- **One personality, one memory, across runtimes.** The same peer on Claude and on Codex works with one memory — `memoryd` keys it to the personality, not the runtime.
- **Memory in the system prompt, not SessionStart shards.** The guide and the agent's note map ride iapeer's system-prompt layer, so they survive compaction without re-injected duplicates.
- **A plain-markdown vault, Obsidian-compatible.** Your data is yours: open it, edit it by hand, put it in git, read it with your eyes — no proprietary store.
- **Frictionless capture, straight to canon.** Write into a typed folder; the write hook fills the metadata (no model) and, at write time, flags a possible duplicate and suggests links — so knowledge doesn't fragment.
- **Self-curating, cheap and configurable.** Ephemeral curators run on a tick (lean by default): link enrichment, proofreading, weekly consolidation, archive-by-status. Only the daemon is persistent; any curator — or the tick itself — can be turned off.
- **Search out of the box.** Full-text BM25 with zero external services; optional pluggable vector search and reranking, with a graceful fallback to BM25.

## Documentation

[`docs/`](docs/README.md) — what it is and how to use it (English; Russian in [`docs/ru/`](docs/ru/README.md)). This repository is the implementation.

## License

Apache-2.0. Platform: macOS. iapeer-memory is the reference memory provider for the [iapeer](https://github.com/agfpd/iapeer) ecosystem — a component of iapeer, not a standalone system.
