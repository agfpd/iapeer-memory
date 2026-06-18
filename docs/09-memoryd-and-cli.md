# 09 — memoryd and the CLI

[Русский](ru/09-memoryd-и-cli.md) · **English**

## memoryd

`memoryd` is iapeer-memory's only persistent process and the sole owner of the index. Everything that needs the index or search goes through it. It:

- **indexes the vault** — a full pass at start, then incrementally on file changes (with protection against needless rebuilds: only what actually changed by content is re-indexed);
- **answers search** — serves an MCP endpoint over HTTP on a local port (8766 by default) with the `memory_search` / `memory_related` / `memory_map` tools;
- **notices changes** and signals them to curation;
- **generates the memory map** for an agent and the shared guide into the system-prompt layer;
- **keeps a heartbeat** — a file whose freshness tells whether the daemon is alive.

The index is SQLite at `~/.iapeer/cache/iapeer-memory/index.db` (full-text index plus the link graph; with vector search configured, also embeddings). Configuration is a single file at `~/.iapeer/plugins/iapeer-memory/config.env` (vault path, language, owner name, port, search endpoints); the owner edits it, the package doesn't overwrite it. The full list of variables — in [11 — Configuration](11-configuration.md).

The daemon runs under `notifier`, which restarts it on a crash and notices a hang by the heartbeat. `memoryd` itself doesn't route messages or wake agents — iapeer does that; memoryd only indexes, searches, and signals changes.

## The iapeer-memory CLI

Commands for the operator:

| Command | What it does |
|---|---|
| `init` | Provision the system: vault, config, binary, curators, daemon, memory slot. Idempotent. |
| `status` | A snapshot of the whole chain: config, daemon, slot, search. A non-zero exit code means something needs attention. |
| `verify [--repair]` | A quick self-check of the live surfaces (vault, heartbeat, daemon registration, curator doctrines). `--repair` fixes what's auto-fixable. |
| `update [--skip-binary]` | Update everything in one command: binary, templates, doctrines, slot, triggers, daemon restart. Idempotent. |
| `migrate --source <dir> --agent <name> [--apply]` | Migrate the named agent's runtime built-in memory into its operative memory in the vault. Dry-run by default; `--apply` performs the real move. The agent name is required (the `--agent` flag or the `PEER_PERSONALITY` variable). |
| `uninstall [--keep-binary]` | Remove the system: slot, binary, triggers, registration. The vault and config stay. |
| `archive-stale [--commit]` | Move accumulated notes with a final status into the archive (memoryd archives new ones as they go; this command clears the old backlog). Dry-run by default; `--commit` performs the real move. |
| `version` · `help` | Package version · help. |

The command `provision-peer --cwd <folder> --runtime claude|codex --personality <name>` is normally invoked by the iapeer core at peer birth, but it's also run by hand to attach memory to a specific existing peer (see [02 — Quick start](02-quickstart.md)). Two more commands repair note attribution and are occasionally run by an author by hand: `bake` resets the "who edited" stamp on notes written around the hook (via bash), and `fm-update` edits service fields surgically. The rest (`unprovision-peer`, `memoryd`, `hook`, `render`, `dream-collect`, `install-binary`) are invoked not by the operator but by the system and the iapeer core — at peer birth and removal, daemon launch under `notifier`, filesystem events, and consolidation ticks.
