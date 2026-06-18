# 10 — iapeer integration

[Русский](ru/10-интеграция.md) · **English**

iapeer-memory is not a standalone system but a primitive on top of [iapeer](https://github.com/agfpd/iapeer): it occupies the core's memory slot and relies on its mechanisms instead of growing its own.

## The memory slot

Memory in iapeer is a provider slot: a single per-host role that one package claims. iapeer-memory claims it by writing `~/.iapeer/memory-provider.json` — a manifest with the name, version, heartbeat path, and `provision` / `unprovision` commands. The core only reads the file.

Through those commands the core calls the provider at a peer's life events: at peer birth (`birth`) — to attach the memory surfaces, at removal (`remove`) — to strip them. That's how a new agent gets access to memory automatically, with no separate setup. At the same time, attaching memory turns off the runtime's native memory (`iapeer native-memory off`) so there's no second, unmanaged store; it isn't turned back on by itself when the provider is removed — that's done by hand.

## Integration points

iapeer-memory uses the core's ready-made mechanisms wherever they exist:

| iapeer mechanism | What iapeer-memory does with it |
|---|---|
| System prompt (layer 5) | places the guide and the agent's memory map ([07](07-context-delivery.md)) |
| Role doctrines | gives the curators their character: Index (links and health), Scriber (proofreading), DreamWeaver (consolidation) |
| `notifier` (watcher) | keeps `memoryd` under supervision, catches file changes |
| `notifier` (timer) | the weekly consolidation tick (dream-tick) |
| Messaging (IAP) | curators talk to authors, assign tasks to workers |
| Human peer (Telegram, say) | curation reports and requests to the owner — optional |
| Peer creation | curators are created as ordinary team peers |
| MCP over HTTP + identity | `memoryd` serves the search tools; by identity it tells its own operative memory from another's |

## Distribution and session surfaces

The system is distributed as a single npm package, `@agfpd/iapeer-memory` — and that IS the system: daemon, search, curators, vault, install, and update.

Connecting an agent session to memory is not a separate distribution form but **direct per-peer surfaces**: the provider places them as files straight into the peer's working directory. They carry no content — the guide and the memory map arrive as a system-prompt layer, not as a surface. How a peer gets them (automatically at birth through the slot; by hand for a specific peer with `provision-peer`; all at once with `verify --repair`) — in [02 — Quick start](02-quickstart.md).

### What a peer gets

The surface set depends on the runtime:

| Surface | What it is | claude | codex |
|---|---|---|---|
| **MCP** | registration of the search tools (`memory_*`) against the `memoryd` endpoint | `<cwd>/.mcp.json` | `<cwd>/.codex/config.toml` |
| **Write hooks** | stamping the service fields on note write + a health check at session start | `<cwd>/.claude/settings.json` | `<cwd>/.codex/hooks.json` |
| **Skills** | four skills that are facades over operator commands: `init`, `status`, `migrate`, `distill` | `<cwd>/.claude/skills/…` | — (codex gets no skills) |

Memory access — MCP search, write hooks, map delivery into the prompt — is identical on both runtimes. The one difference: skills (convenience wrappers over operator commands) are installed for claude only; that doesn't affect the memory itself.

### claude/codex parity: one personality, one memory

The core idea: the same peer, brought up on claude and on codex, works with ONE memory. Both runtimes hit the same `memoryd` endpoint (`http://127.0.0.1:<port>/mcp`, 8766 by default) and carry an identity header `X-IAPeer-Identity: <runtime>-<personality>`. `memoryd` strips the runtime prefix (`claude-`, `codex-`) and resolves both sessions to the same personality — so a peer's claude and codex see the same operative memory and the same canon. One identity, two runtimes, one memory. A codex session started outside an iapeer launch carries no identity — the same unattributed fallback as a claude session without the env.

## Why iapeer-memory is not a runtime package

Infrastructure runtimes (Telegram, `notifier`) register via a `runtime.json` manifest and stand up service peers. iapeer-memory deliberately doesn't: it has no service router peers — its roles (Index and the curators) are ordinary team agents, its function (search) is the daemon's MCP endpoint, and events and schedules are delegated to `notifier`. Registering a runtime with an empty peer list would be form without content. So iapeer-memory is a memory-slot provider and a set of surfaces, not a runtime.

## Dependencies

| Dependency | Required? | Without it |
|---|---|---|
| iapeer | required | no guide or map delivery, no messaging, no curators — the system doesn't come together |
| `notifier-runtime` | required | nothing to supervise the daemon or run schedules — no events, no timeouts |
| human peer (Telegram, etc.) | optional | no channel to the owner: reports and requests are off |
| vector search / reranking | optional | search runs on full-text BM25 — a fully valid mode |
