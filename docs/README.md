# iapeer-memory

[Русский](ru/README.md) · **English**

iapeer-memory is the agent team's shared long-term memory. It's the store where the team keeps what it knows and where it goes to recall it: one agent writes down a decision or a finding, another retrieves it by search. Memory survives session restarts and context compaction, so the team never loses what it has accumulated between conversations.

Memory has two parts:

- **Canon** — the team's shared knowledge: knowledge, decisions, ideas, projects, lists. Whatever is useful to everyone and built to last.
- **Operative memory** — each agent's personal notes: feedback, working context, the owner's profile, lessons learned. Private to each agent, readable by the whole team.

The vault is plain markdown files, compatible with Obsidian. Search, indexing, and context delivery run on top of them through the `memoryd` daemon.

```text
   an agent writes                            an agent searches
   a note into the vault                      memory_search("…")
        │                                          │
        ▼                                          ▼
   ┌──────────────────────────────────────────────────────┐
   │  memoryd — indexing · search · context delivery        │
   │  one daemon, owner of the index and search            │
   └──────────────────────────────────────────────────────┘
        │                                          │
        ▼                                          ▼
   curators (on a tick)                       prompt layer 5:
   links · health · consolidation             the agent's note map
```

iapeer-memory is the reference provider of the [iapeer](https://github.com/agfpd/iapeer) memory slot: it occupies the single per-host memory slot and connects to the agent team through iapeer's own mechanisms (system prompt, messaging, schedules).

## What it gives you

- **The team remembers.** A finding made by one agent is available to the rest — no retelling, no copying between sessions.
- **Knowledge isn't lost.** A note survives restarts and context compaction; an agent in a fresh session gets a map of its memory right in the system prompt.
- **Search, not a dump.** `memory_search` finds by meaning and content; curation keeps the store in order — enriches links, repairs structure, merges duplicates. Stale notes move to the archive on their own, by status.
- **Memory under watch.** Curators (Index, Scriber, DreamWeaver) spin up on a tick to enrich links, proofread canon, and consolidate personal notes; between ticks they don't exist — only the daemon is persistent.

## Quick start

You need a working [iapeer](https://github.com/agfpd/iapeer) and `notifier-runtime` already installed.

```bash
# Install and provision: vault, daemon, curators, memory slot
npx @agfpd/iapeer-memory init
```

The command asks for the vault path, the language (Russian or English folder layout), and a few more details, then creates everything it needs. Full walkthrough — [02 — Quick start](02-quickstart.md).

## Documentation

**Introduction**
- [01 — Overview](01-overview.md) — what the team's shared memory is and how it's built
- [02 — Quick start](02-quickstart.md) — install, the slot, your first note and search

**The vault**
- [03 — Vault: layout and zones](03-vault-and-zones.md)
- [04 — Note genres](04-note-genres.md)
- [05 — Links and tags](05-links-and-tags.md)

**Working with memory**
- [06 — Search and write](06-search-and-write.md) — the agent's MCP tools
- [07 — Context delivery](07-context-delivery.md) — memory in the system prompt
- [08 — Curation](08-curation.md) — events, curators, consolidation

**Infrastructure**
- [09 — memoryd and the CLI](09-memoryd-and-cli.md)
- [10 — iapeer integration](10-iapeer-integration.md) — the memory slot, install, distribution
- [11 — Configuration](11-configuration.md) — config.env, variables, lean/curated modes, how to turn curators and ticks off

## Status

Shipped as a single npm package, `@agfpd/iapeer-memory` — the package IS the system (daemon, search, curators); an agent session connects to memory through direct per-peer surfaces. Search works on BM25 out of the box; vector search and reranking are optional add-ons. The platform is macOS, as with iapeer.
