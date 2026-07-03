# 01 — Overview

[Русский](ru/01-обзор.md) · **English**

iapeer-memory gives an agent team shared, long-term memory. One agent records a piece of knowledge — the whole team finds it by search; the record survives session restarts and context compaction. It's the reference provider of the [iapeer](https://github.com/agfpd/iapeer) memory slot.

## Two parts of memory

**Canon** — the team's shared knowledge, valuable to everyone and built to last. It splits into five genres: knowledge, decisions, ideas, projects, lists ([04 — Note genres](04-note-genres.md)). Material lands in canon directly: the author (agent or human) writes straight into the right typed folder — the folder declares the genre, the write hook fills the service fields on write. Curation comes afterward — proofreading and link enrichment of a note that's already in place.

**Operative memory** — an agent's personal notes: the owner's feedback, working context, a person's profile, a lesson after an incident. Each agent has its own zone, only it may write there; the whole team may read (another agent's operative memory ranks lower in search). Operative memory replaces the runtime's built-in memory — it's turned off for Claude and Codex so there's no second, unmanaged store.

## Concepts

**Vault** — the store: a directory of markdown files, compatible with Obsidian. Eight top-level folders, a fixed set, configurable names (there's a Russian and an English layout). The layout is covered in [03 — Vault: layout and zones](03-vault-and-zones.md).

**Note** — a single markdown file with frontmatter (service fields: type, status, author, date) and a body. A note's type is set by its folder; the service fields are filled by the system, not the agent.

**Links** — notes reference one another with wikilinks `[[Name]]`, forming a graph. Memory is navigated along the graph; curation enriches the links of notes already in place. See [05 — Links and tags](05-links-and-tags.md).

## Components

```text
┌─────────────────────────────────────────────────────────────┐
│  Agent: writes notes · searches through MCP tools            │
└───────────────┬─────────────────────────────────────────────┘
                │
┌───────────────▼─────────────────────────────────────────────┐
│  memoryd — one daemon                                        │
│  • indexes the vault into SQLite                             │
│  • answers memory_search / memory_related / memory_map (MCP) │
│  • notices file changes and emits events                    │
│  • generates the agent's memory map into the system prompt   │
└───────────────┬─────────────────────────────────────────────┘
                │ change events
┌───────────────▼─────────────────────────────────────────────┐
│  Curators (ephemeral, on a tick): Index · Scriber · DreamWeaver │
│  link enrichment, proofreading, store health, consolidation │
└──────────────────────────────────────────────────────────────┘
```

**memoryd** — the only persistent process and the sole owner of the index. It indexes the vault, answers search over MCP, notices file changes, generates the memory map for the system prompt, and keeps a heartbeat for health checks. See [09 — memoryd and the CLI](09-memoryd-and-cli.md).

**MCP tools** — how an agent works with memory: `memory_search` (search by meaning and content), `memory_related` (the link graph around a note), `memory_map` (store topology). All read-only; writing is an ordinary file create. See [06 — Search and write](06-search-and-write.md).

**Curators** — the role agents that keep order: Index, Scriber, DreamWeaver. All ephemeral: they spin up on the `CURATOR_TICK` tick or on demand, do their pass, and wind down — there is no standing curator, only `memoryd` is persistent. Index enriches links and repairs store health (broken links, duplicates). Scriber proofreads canon notes (style, fact-checking). DreamWeaver consolidates operative memory (weekly, on a timer). The ticks and the timer fire in the `curated` mode; the default `lean` mode runs no curation ticks — the author curates as they write. Placing notes is not the curators' job: the author writes straight into a typed folder. See [08 — Curation](08-curation.md).

## How memory reaches an agent

Two paths, and they complement each other:

1. **A map in the system prompt.** At session start the agent gets two things as a system-prompt layer (iapeer's layer 5): the memory guide and an index of its own notes — what it has, on which topics. The map is rebuilt on every start, so it's always fresh. See [07 — Context delivery](07-context-delivery.md).
2. **Search while working.** The map is a "what do I have" signpost; for the actual content the agent goes to `memory_search`, which searches the entire team store, not just its own notes.

## Relationship to iapeer

iapeer-memory is not a standalone system — it's a primitive on top of [iapeer](https://github.com/agfpd/iapeer). It occupies the core's memory slot and relies on its mechanisms: the system prompt (map delivery), messaging (curators talk to authors), schedules (weekly consolidation). That's why iapeer and `notifier-runtime` are required dependencies. The integration points are covered in [10 — iapeer integration](10-iapeer-integration.md).

## Next

- Install and try it — [02 — Quick start](02-quickstart.md).
- Understand how the store is built — [03 — Vault: layout and zones](03-vault-and-zones.md).
- Learn how an agent searches and writes — [06 — Search and write](06-search-and-write.md).
