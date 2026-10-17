# 12 — OpenCode: provider/runtime contract

## Ownership and lifecycle

The memory slot invokes `provision-peer` / `unprovision-peer` with `--cwd`,
`--runtime opencode`, `--personality`, and `--occasion`. Personality is required
for **both** verbs: cwd is not an identity and may be shared by several peers.
The slot's unprovision argv includes `{personality}` as of this contract.

The provider owns these two files, under `${IAPEER_ROOT:-~/.iapeer}`:

```
peers/<personality>/opencode/iapeer-memory.json
peers/<personality>/opencode/iapeer-memory-plugin.mjs
```

The JSON contains `mcp.iapeer-memory` (remote HTTP, literal host port,
`oauth: false`, `X-IAPeer-Identity: {env:PEER_IDENTITY}`) and one file-URL
plugin entry. The iapeer adapter merges the fragment into its generated
`OPENCODE_CONFIG_CONTENT` on **every launch**. An absent fragment means no
memory surfaces; a malformed present fragment is a launch error, not a silent
fallback. The runtime process exports canonical `PEER_IDENTITY=opencode-<p>`
and `PEER_PERSONALITY=<p>`. `IAPEER_IDENTITY` is the core's alias, not a second
source for this provider. `memoryd` resolves all three runtime prefixes to the
same personality (including personalities containing hyphens).

Guide, paths, tags and author index remain ordinary memory fragments. The
core delivers them through its shared `composeSystemPrompt` rail; the memory
plugin does not duplicate this content or own the agent doctrine.

Provision is atomic per file, serialized by the existing provider lock,
idempotent and repairable. It never writes `cwd/opencode.json`, `.opencode/`,
global OpenCode config, Claude/Codex surfaces, or another personality's files.
Removal strips our MCP key and plugin URL, preserves foreign JSON data and
refuses to delete a plugin lacking our ownership marker. Pickup is at the
next process launch; removing files does not unload a running plugin.

## Attribution

OpenCode's native `tool.execute.after` forwards `write`, `edit`, and
`apply_patch` results to the **installed absolute CLI** (`hook post-write`).
The adapter namespaces these event names as `opencode:<tool>`, forwards
`args`, tool output and actual directory. `filePath` is resolved against that
directory; `patchText` supports multi-file add/update/move destinations.
The existing shared `fmUpdate` supplies service fields and attribution, tag
teaching and dedup/link hints. Hints are appended to the native tool result.
No generic watcher/file.edited event is used as an author signal: it cannot
distinguish a human edit from a tool write. Failed native tools do not reach
the success after-hook. Bash is not an allowed note-writing path; its hook
only emits the existing best-effort bake reminder, never claims authorship.

The generated plugin is a self-contained session carrier, not a second
implementation of stamping. Its sole subprocess boundary is a bounded call
to the absolute provisioned CLI with fixed `hook` verbs. It needs no npm
dependencies. Startup invokes `hook session-start` once per plugin instance;
degraded warnings join system context, healthy starts are silent. Write-hook
failures remain fail-open and visible in the tool result.

## Evidence matrix

| Surface / trigger | Product mechanism | Evidence / outstanding acceptance |
|---|---|---|
| Provision, repair, off, repeated off | scoped JSON/plugin + provider lock | unit tests: idempotence, drift, foreign data, shared cwd, traversal |
| MCP request identity | env header; memoryd prefix parser | real HTTP MCP test for Claude/Codex/OpenCode, same personality |
| File writes | native after-hook → installed CLI | adapter unit tests + shared stamping tests; native runtime proof pending |
| Multi-file patch and move | patch envelope + result paths | unit tests; native runtime proof pending |
| Tags and dedup/link teaching | shared CLI → native tool output | shared hook tests; native runtime proof pending |
| Session health | plugin initialization → shared health hook | adapter loading tested; native startup proof pending |
| Guide/index delivery, refresh/resume | core prompt composition | depends on core adapter; lifecycle proof pending |
| Cross-runtime same personality | shared vault/daemon/fragments | HTTP identity test; actual second-runtime lifecycle proof pending |
| Weekly transcript source | core journal + `fromTimeMs` | unit tests; live journal from the core producer pending |
| Installed release and PM 3/3 cycles | normal core/provider lifecycle | pending; source tests do not replace installed acceptance |

External OpenCode configuration is **merged**, not replaced, by inline
configuration; managed settings can override it. Synthetic/cloud trials need
an OS-enforced synthetic-only file/network boundary plus an effective-config
check. Fresh HOME and inline config alone are not an isolation proof.
Weekly transcript collection (`dream-collect`) reads the core's
per-personality journal `<IAPEER_ROOT>/peers/<p>/opencode/events.jsonl`
(iapeer `docs/20-opencode.md`: the core is its single producer; the native
OpenCode SQLite is never read). The journal is never rotated, so the task
carries `fromTimeMs` (window start) and the DreamWeaver judge reads only
lines with `time ≥ fromTimeMs`, of main sessions only (the `session.id` of
`runtime.ready` events; child/subagent sessions share the journal but their
user turns are agent-written), upserting streamed parts by `part.id`. Scoping is by personality, so a shared cwd
does not leak another peer's sessions. Until the core's journal producer
ships, an OpenCode-only peer simply contributes no transcripts — the runtime
is still listed in the task, so the gap is visible, not silent.

## Build/delivery gate

Compilation targets a unique candidate in the destination directory.
Stable TCC-identity signing, strict signature verification and execution of
`version` (matching the package version, bounded timeout) precede the atomic
replacement. Failure preserves the previous installed binary. A failed
stable-identity signer is not evidence that a linker-signed candidate works.
On macOS sandbox tests ad-hoc sign **only the guarded temporary candidate**;
the keychain and production binaries are never touched. This tests actual
executability rather than skipping a broken compiled regression.

## Primary sources (checked 2026-10-17)

- [OpenCode plugins](https://opencode.ai/docs/plugins/) — local module hooks.
- [Remote MCP](https://opencode.ai/docs/mcp-servers/) — headers and OAuth.
- [Agents](https://opencode.ai/docs/agents/) — file tools and edit permissions.
- [Config precedence](https://opencode.ai/docs/config/#precedence-order).
- `@opencode-ai/plugin@1.19.3` published TypeScript declarations — after-hook
  `input.args` and mutable `output.output`; selected binary must still be
  checked live (a declaration or current development branch is not proof).
