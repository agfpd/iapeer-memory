# 02 — Quick start

[Русский](ru/02-быстрый-старт.md) · **English**

From install to your first note and search. Under each step — what it does.

## Requirements

- **macOS** — as with iapeer.
- **A working [iapeer](https://github.com/agfpd/iapeer) install** — memory is delivered by its system prompt and relies on its messaging. Without iapeer the system doesn't come together.
- **`notifier-runtime`** — events (noticing changes) and schedules (consolidation, timeouts) run through it. Also required.

## Install

```bash
npx @agfpd/iapeer-memory init
```

In an interactive terminal the command asks for: the vault path, the folder layout language (Russian or English), the owner's name, and a vector-search endpoint (which you can skip — search works on BM25). The reranker endpoint is set with `--reranker-endpoint`. For scripts the same values are passed as flags (`--vault`, `--locale`, `--human`, etc.); in non-interactive mode, without a vault path the command refuses to run rather than create a store silently.

What `init` provisions:

- **vault** — the folder structure (in the chosen language) and the system templates;
- **configuration** at `~/.iapeer/plugins/iapeer-memory/config.env` — vault path, language, owner name, MCP port, search endpoints (you edit it later, the package won't overwrite it; all variables are in [11 — Configuration](11-configuration.md));
- **binary** at `~/.local/bin/iapeer-memory`;
- **curators** — creates the role agents (Index for links and health, Scriber for canon proofreading, DreamWeaver for consolidation) with their doctrines; the roles are ephemeral and spin up on a tick;
- **daemon** — registers `memoryd` under `notifier` (the watcher restarts it on a crash) and the weekly consolidation timer;
- **memory slot** — writes `~/.iapeer/memory-provider.json`, claiming the single per-host slot;
- **disables native memory** for Claude and Codex (`iapeer native-memory off --all`) so there's no second store;
- **guide** — places a memory how-to into the shared system-prompt layer.

Install is idempotent — re-running is safe.

## Check

```bash
iapeer-memory status     # a snapshot of the whole chain: vault, daemon, slot, search
iapeer-memory verify     # a quick self-check of the live surfaces
```

`status` shows the state of the store, the daemon's freshness, whether the slot is claimed, and whether search is working; a non-zero exit code means something needs attention. `verify --repair` fixes what's fixable automatically (re-rendering curator doctrines, for example).

## Memory for agents

Memory attaches to a peer not by a separate `iapeer-memory` command but through the iapeer core's slot:

- **A new or onboarding peer.** A peer is brought up with iapeer: `iapeer create <name>` to create a new one, or `iapeer init` in the peer's folder to onboard an existing folder. Either path runs the peer through provisioning: the core sees the claimed memory slot and calls the provider's provision command itself — it places the surfaces into the peer. No separate step for memory. (Not to be confused with `iapeer-memory init` — that installs the memory system, it doesn't create a peer.)
- **A specific existing peer** (created before memory was installed, or with drifted surfaces) — attach it by hand with the same command: `iapeer-memory provision-peer --cwd <peer-folder> --runtime claude|codex --personality <name>`.
- **All peers at once** — `iapeer-memory verify --repair` (or a re-run of the idempotent `iapeer-memory init`) walks every peer and reinstalls the surfaces.

`iapeer-memory init` installs the memory system itself (daemon, search, curators, slot); it doesn't create peers — iapeer does that. What exactly a peer gets in its surfaces, and the claude/codex parity — in [10 — iapeer integration](10-iapeer-integration.md).

Once attached, the agent gets its memory map and the `memory_search` tool in the system prompt on its next start.

## First note and search

**Personal note (operative memory).** The agent writes straight into its operative folder `06_Agent_Memory/<own-name>/` (or `06_Оперативка_агентов/<name>/` in the Russian layout). A body and two fields are enough — the system fills the rest:

```markdown
---
subtype: pitfall
description: "After a plugin update the MCP process must be restarted"
---
A live MCP holds the old code in memory; the on-disk update isn't picked up
until the process restarts.
```

**Canon note.** Whatever is useful to the whole team, the agent writes straight into the right canon folder by genre — `01_Knowledge/` for a fact, `02_Decisions/` for a choice, and so on (or the Russian `01_Знания`, `02_Решения`). The folder declares the genre, and the write hook fills the service fields (type from the folder, author, status, title, stamps) right on write — no model involved. Just write self-contained text; there's no draft to place or stage. Curation later proofreads and enriches links ([08 — Curation](08-curation.md)).

**Search.** From the agent's session — with the `memory_search` tool:

```text
memory_search("restart MCP after plugin update")
→ a list of notes with paths, type, snippet, and a relevance score
```

Search covers the entire team store, not just your own notes. Having found a path, the agent reads the note with an ordinary file read.

## Next

- How the store and its zones are built — [03 — Vault: layout and zones](03-vault-and-zones.md).
- How an agent searches and writes, and what other tools exist — [06 — Search and write](06-search-and-write.md).
- How memory reaches the system prompt — [07 — Context delivery](07-context-delivery.md).
- How to tune the system to your needs (modes, turning curators off, search) — [11 — Configuration](11-configuration.md).
