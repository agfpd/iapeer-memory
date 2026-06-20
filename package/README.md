# @agfpd/iapeer-memory

Peer memory for the [iapeer](https://www.npmjs.com/package/@agfpd/iapeer)
multi-agent ecosystem: a shared Obsidian-compatible vault (team canon +
per-agent memory), a single indexing/search daemon (`memoryd`, BM25 +
optional embeddings/reranker, MCP-over-HTTP), layer-5 context fragments
injected into every peer's system prompt, and three curator role peers
(index / scriber / dreamweaver) running an inverted vetting pipeline.

The package IS the system: everything live enters through this CLI. The
claude/codex session surfaces are thin per-peer sockets that call back into it.

## Install

```bash
npx -y @agfpd/iapeer-memory init   # interactive on a tty; flags for scripts:
#   --vault PATH --locale en|ru [--human NAME]
#   [--embedding-endpoint URL] [--reranker-endpoint URL] [--skip-guide]
```

`init` is idempotent — re-running it is the official repair path, together
with `iapeer-memory verify --repair`.

## Commands

| Command | What it does |
| --- | --- |
| `init` | provision the host: vault skeleton, config, stable signed binary, role peers + doctrines, notifier wiring (event trigger + sweep/dream timers), memory-provider slot |
| `status` | read-only diagnostics: verify checks, slot, MCP probe, live search pipeline, inbox load |
| `verify [--repair]` | check (and heal) the live surfaces |
| `update` | every surface in one command: binary recompile + re-sign, templates, doctrines, slot, triggers, managed `memoryd` restart |
| `uninstall` | remove the slot declaration + binary (vault and config are kept — user data) |
| `migrate --source DIR` | move a harness's built-in auto-memory into the vault (dry-run by default) |
| `memoryd` | run the daemon in the foreground (supervised by a notifier watcher in production) |

Requires [bun](https://bun.sh) on PATH and the iapeer foundation
(`npx -y @agfpd/iapeer install`). Full architecture docs and ADRs live in
the [repository](https://github.com/agfpd/iapeer-memory).
