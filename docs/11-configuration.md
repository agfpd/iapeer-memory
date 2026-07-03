# 11 — Configuration

[Русский](ru/11-конфигурация.md) · **English**

Everything configurable in iapeer-memory is set through environment variables prefixed `IAPEER_MEMORY_*`. Their permanent home is the `config.env` file; for a single run any variable can be overridden through the process environment. Out of the box the system runs without a single edit (BM25 search, the default curation mode), so configure only what you need to change.

## Where configuration lives

One file:

```
~/.iapeer/plugins/iapeer-memory/config.env
```

`init` creates it once and never touches it again — the file is yours. The format is line-by-line `KEY=VALUE`:

```bash
# Comments and blank lines are ignored
IAPEER_MEMORY_VAULT_PATH=/Users/you/iapeer-memory-vault
IAPEER_MEMORY_LOCALE=en
IAPEER_MEMORY_MODE=lean
export IAPEER_MEMORY_MCP_PORT=8766   # the export prefix is allowed
```

A value wrapped in quotes (single or double) is unwrapped one level; escaping isn't processed — this is a config file, not a shell.

### Precedence

```
command flags  >  process environment  >  config.env  >  built-in defaults
```

A variable already set in the environment is **not** overwritten by the file — an explicit `IAPEER_MEMORY_*=` in the environment always wins. That's handy for one-off checks: run a command with the variable inline and it overrides the file without changing it.

### When changes take effect

- **Search, paths, port, daemon parameters** — `memoryd` reads them at start. Restart the daemon to apply (`notifier` brings it back up; or run `iapeer-memory update`).
- **Curation mode and roles** — the `notifier` triggers (the watcher and the consolidation timer) are registered for the current mode by `init` / `verify --repair` / `update`. After changing the curation variables, run `iapeer-memory verify --repair` — it re-registers the triggers for the new mode; the daemon picks up the tick emission on its next restart.

## Vault and language

| Variable | Default | Purpose |
|---|---|---|
| `IAPEER_MEMORY_VAULT_PATH` | — (**required**) | Absolute path to the vault. Without it the daemon won't start. Must be an existing directory — on a typo or an unmounted drive the system fails immediately rather than running "empty". |
| `IAPEER_MEMORY_LOCALE` | `en` | Folder-layout and taxonomy language: `en` or `ru`. Chosen at install; not changed on the fly once the vault is populated. |

## Curation mode

This is the answer to "how to turn curators and ticks off". The key principle: **the mode governs only the proactivity of curation, not the existence of anything**. The base — indexing, search, archiving by status, dedup, generating the map into the prompt — always runs, in any mode. The curator roles (Index, Scriber, DreamWeaver) are always created and callable on demand too. The mode decides one thing: whether the system wakes the curators by itself.

### Two modes

| Variable | Default | Purpose |
|---|---|---|
| `IAPEER_MEMORY_MODE` | `curated` if the variable is absent; a new `init` writes `lean` | `lean` — the base runs, the curation tick stays silent (the system doesn't wake curators itself). `curated` — on top of the base, the system proactively spins up curators on the tick. |

A subtlety about the default: in code an absent variable reads as `curated` (for compatibility with older hosts provisioned before modes existed). But `init` on a new host **writes** `IAPEER_MEMORY_MODE=lean` into `config.env` — so a fresh install runs lean. A re-run of `init` preserves the existing mode and never flips it silently.

### Per-role toggles

On top of the mode, each role is turned on and off individually:

| Variable | Default | Purpose |
|---|---|---|
| `IAPEER_MEMORY_PROACTIVE_INDEX` | follows the mode | Index proactivity (link enrichment, health). |
| `IAPEER_MEMORY_PROACTIVE_SCRIBER` | follows the mode | Scriber proactivity (canon proofreading). |
| `IAPEER_MEMORY_PROACTIVE_DREAMWEAVER` | follows the mode | DreamWeaver proactivity (weekly operative-memory consolidation). |

Values: `on` / `1` / `true` / `yes` / `y` to enable; `off` / `0` / `false` / `no` / `n` to disable; empty or unrecognized — follow the mode. In `curated` all three are on by default, in `lean` — off.

The tick logic: the system emits `CURATOR_TICK` only if there's someone to receive it — an active Scriber or Index. If Scriber is active, the batch goes to it (it proofreads and passes to Index); otherwise straight to Index; if both are off, the tick isn't emitted at all. DreamWeaver is separate: its weekly timer is registered only when the role is proactive.

### Recipes

**Turn off DreamWeaver only** (Index and Scriber keep working):

```bash
IAPEER_MEMORY_MODE=curated
IAPEER_MEMORY_PROACTIVE_DREAMWEAVER=off
```

The weekly consolidation timer isn't registered; the `CURATOR_TICK` tick for Index/Scriber works as before.

**Silence curation entirely** (base only — indexing, search, archiving):

```bash
IAPEER_MEMORY_MODE=lean
```

The system doesn't wake curators itself, and the tick isn't emitted. The vault stays fresh: new notes are indexed, stale ones move to the archive by status, dedup hints and the prompt map keep working. Any curator can still be called by hand when needed.

**Enable full curation:**

```bash
IAPEER_MEMORY_MODE=curated
```

After any of these changes, run `iapeer-memory verify --repair` so the `notifier` triggers fall in line with the new mode.

### Who counts as a curator

| Variable | Default | Purpose |
|---|---|---|
| `IAPEER_MEMORY_CURATOR_SET` | `index,scriber,dreamweaver` | A comma-separated list of personalities whose edits the system treats as sanctioned curation and does **not** flag for review (`needs_review`). |

Every non-curator write — including the author editing their own note — sets `needs_review`: the flag IS the curation queue, and it stays until the Index clears it (automatically, when its edit moves the semantic hash) or a human does. Only edits by personalities in this list don't set the flag. If you renamed the roles or added a new curator, update the list — otherwise the new curator's edits set the flag like any author's and the queue grows for nothing.

### Tick period

| Variable | Default | Purpose |
|---|---|---|
| `IAPEER_MEMORY_CURATOR_TICK_SECS` | `21600` (6 hours) | The `CURATOR_TICK` period in seconds. Once per this interval, accumulated canon edits go to curation as a single list — as a batch, not per event. |

## Consolidation schedule (DreamWeaver)

The weekly operative-memory cleanup tick is configured separately. All variables are optional.

| Variable | Default | Purpose |
|---|---|---|
| `IAPEER_MEMORY_DREAM_CRON` | `0 4 * * 1` (Monday, 04:00) | The tick schedule in cron format (5 fields). |
| `IAPEER_MEMORY_DREAM_WINDOW_DAYS` | `7` | The window in days: notes and transcripts within this span enter the pass. |
| `IAPEER_MEMORY_DREAM_DESC_MAXLEN` | `250` | Description length (characters) beyond which a note is a reformulation candidate. |
| `IAPEER_MEMORY_DREAM_BATCH_THRESHOLD` | `20` | How many notes in a folder → its own subagent; fewer are grouped. |
| `IAPEER_MEMORY_DREAM_GROUP_CAP` | `20` | The cap on the combined weight of grouped folders. |
| `IAPEER_MEMORY_DREAM_TRANSCRIPT_CAP` | `20` | The per-folder transcript cap (`0` — no cap). |

## Search

By default search runs on full-text BM25 — a fully valid mode, with no network or external services. Vector search (by meaning) and reranking are optional add-ons: an empty endpoint means the layer is off.

### Vector search (embeddings)

Enabled by setting an endpoint. Any service speaking the OpenAI `/v1/embeddings` or TEI protocol works.

| Variable | Default | Purpose |
|---|---|---|
| `IAPEER_MEMORY_EMBEDDING_ENDPOINT` | empty (off) | The embeddings endpoint. Empty → BM25-only search. |
| `IAPEER_MEMORY_EMBEDDING_PROVIDER` | `openai` | The wire format: `openai` or `tei`. |
| `IAPEER_MEMORY_EMBEDDING_MODEL` | `Qwen/Qwen3-Embedding-8B` | The embedding model name. |
| `IAPEER_MEMORY_EMBEDDING_DIMENSIONS` | `4096` | Vector dimensions (model-dependent). |
| `IAPEER_MEMORY_EMBEDDING_BATCH_SIZE` | `32` | Request batch size to the service. |
| `IAPEER_MEMORY_EMBEDDING_API_KEY` | empty | API key, if the service requires one. |
| `IAPEER_MEMORY_EMBEDDING_TIMEOUT_MS` | `60000` | Per-batch timeout of the INDEXING path (a slow local endpoint chews a full batch in seconds). Interactive queries keep the strict 3s default. |

### Reranking

An extra layer on top of vector search. Also off by default.

| Variable | Default | Purpose |
|---|---|---|
| `IAPEER_MEMORY_RERANKER_ENDPOINT` | empty (off) | The reranking endpoint (TEI `/rerank` protocol and compatible). |
| `IAPEER_MEMORY_RERANKER_PROVIDER` | `tei` | The format: `tei`, `cohere`, `nvidia`, `jina`, or `none` (an explicit off even with an endpoint set). |
| `IAPEER_MEMORY_RERANKER_MODEL` | `BAAI/bge-reranker-v2-m3` | The reranker model name. |
| `IAPEER_MEMORY_RERANKER_TOP_K` | `20` | How many top candidates to send for reranking. |
| `IAPEER_MEMORY_RERANKER_WEIGHT` | `0.7` | The reranker score weight in the blend (0–1; the rest is the full-text score's weight). |
| `IAPEER_MEMORY_RERANKER_API_KEY` | empty | API key, if the service requires one. |

If an endpoint is configured but the service is unavailable, search degrades silently to BM25 — the results stay valid.

### Index and result tuning

You rarely need to change these.

| Variable | Default | Purpose |
|---|---|---|
| `IAPEER_MEMORY_MAX_RESULTS` | `6` | How many notes `memory_search` returns. |
| `IAPEER_MEMORY_CHUNK_SIZE` | `500` | Chunk size for indexing (characters). |
| `IAPEER_MEMORY_CHUNK_OVERLAP` | `80` | Overlap between adjacent chunks (characters). |
| `IAPEER_MEMORY_RRF_K` | `60` | The constant that fuses the two search layers (Reciprocal Rank Fusion). |
| `IAPEER_MEMORY_FULL_SCAN_ON_STARTUP` | `true` | A full re-index of the vault at daemon start (a consistency guarantee). `false` — a faster start, trusting the incremental index. |
| `IAPEER_MEMORY_ALLOW_MASS_DELETE` | unset | Emergency override of the mass-delete fuse. A scan that would drop >10 notes AND >20% of the corpus at once is refused (an iCloud partial sync looks exactly like that); set `1` for one conscious bulk cleanup. |
| `IAPEER_MEMORY_EXCLUDE_FOLDERS` | the `99_System` / `99_Система` folder | Folders (comma-separated) skipped during indexing. |

The status weights in results (active above, stale below), the penalty for another agent's operative memory, and the boost for hub notes are fixed in code and not tunable by variables; they're covered in [06 — Search and write](06-search-and-write.md).

### Write-time hints

When vector search is enabled, after a note is written the system hints at nearby notes — a possible duplicate or a link.

| Variable | Default | Purpose |
|---|---|---|
| `IAPEER_MEMORY_DEDUP_THRESHOLD` | `0.78` | Cosine similarity ≥ this threshold → a "possible duplicate" hint. |
| `IAPEER_MEMORY_LINK_HINT_THRESHOLD` | `0.68` | Similarity in the range `[threshold, dedup)` → a "maybe link these" hint. |

## MCP and the owner

| Variable | Default | Purpose |
|---|---|---|
| `IAPEER_MEMORY_MCP_PORT` | `8766` | The port of `memoryd`'s MCP HTTP endpoint (neighbour of the iapeer foundation on 8765). The same port must be written into the peers' surfaces — change it via `verify --repair`, not by hand. `0` — an ephemeral port (for tests). |
| `IAPEER_MEMORY_HUMAN_NAME` | empty | The human owner's personality. Set → recognition of hand edits is enabled (attribution, protection against false external-editor triggers). Empty → edits are treated as machine-made. |
| `IAPEER_MEMORY_AGENT_NAME` | empty | A fallback caller name for the CLI and programmatic consumers outside sessions (within a session the identity comes from the identity header and takes precedence). |

## Other (advanced)

Fine-grained settings rarely needed.

| Variable | Default | Purpose |
|---|---|---|
| `IAPEER_MEMORY_FRESH_EDIT_WINDOW_S` | `90` | The "fresh edit" window in seconds: how long after a write an edit still counts as the system's own when recognizing hand edits from outside. |
| `IAPEER_MEMORY_INDEX_AGENT` | `index` | The personality treated as the Index role when generating author indexes and fragments. Change it if you renamed the Index role. |
| `IAPEER_MEMORY_PROJECTS_ROOT` | — (none) | A fallback root for resolving a project's working directory in author indexes. |
| `IAPEER_MEMORY_TAGS_BOUNDARY_MAXLEN` | `160` | The tag-boundary length (characters) in the tag-dictionary projection delivered to the prompt; keeps the projection compact. |

## Paths and storage

Each root is overridable individually; by default everything lives under `IAPEER_ROOT` (which itself defaults to `~/.iapeer`).

| Variable | Default | Purpose |
|---|---|---|
| `IAPEER_ROOT` | `~/.iapeer` | The storage root for the whole iapeer ecosystem. |
| `IAPEER_MEMORY_CONFIG_FILE` | `<IAPEER_ROOT>/plugins/iapeer-memory/config.env` | The path to the config file itself. |
| `IAPEER_MEMORY_STATE_DIR` | `<IAPEER_ROOT>/state/iapeer-memory/` | State: author indexes, heartbeat, roles manifest, hashes. |
| `IAPEER_MEMORY_CACHE_DIR` | `<IAPEER_ROOT>/cache/iapeer-memory/` | Cache: the SQLite index, the tag-dictionary mirror. |
| `IAPEER_MEMORY_LOGS_DIR` | `<IAPEER_ROOT>/logs/iapeer-memory/` | Log files. |
| `IAPEER_MEMORY_DB_PATH` | `<CACHE_DIR>/index.db` | The SQLite database file. |
| `IAPEER_MEMORY_BINARY_PATH` | `~/.local/bin/iapeer-memory` | The compiled CLI binary (hooks and the watcher rely on this path). |

## The full list of variables

A roundup of everything above — for quick lookup.

**Required:** `IAPEER_MEMORY_VAULT_PATH`.

**Vault and language:** `IAPEER_MEMORY_LOCALE`.

**Curation:** `IAPEER_MEMORY_MODE`, `IAPEER_MEMORY_PROACTIVE_INDEX`, `IAPEER_MEMORY_PROACTIVE_SCRIBER`, `IAPEER_MEMORY_PROACTIVE_DREAMWEAVER`, `IAPEER_MEMORY_CURATOR_SET`, `IAPEER_MEMORY_CURATOR_TICK_SECS`.

**Consolidation:** `IAPEER_MEMORY_DREAM_CRON`, `IAPEER_MEMORY_DREAM_WINDOW_DAYS`, `IAPEER_MEMORY_DREAM_DESC_MAXLEN`, `IAPEER_MEMORY_DREAM_BATCH_THRESHOLD`, `IAPEER_MEMORY_DREAM_GROUP_CAP`, `IAPEER_MEMORY_DREAM_TRANSCRIPT_CAP`.

**Search:** `IAPEER_MEMORY_EMBEDDING_ENDPOINT`, `IAPEER_MEMORY_EMBEDDING_PROVIDER`, `IAPEER_MEMORY_EMBEDDING_MODEL`, `IAPEER_MEMORY_EMBEDDING_DIMENSIONS`, `IAPEER_MEMORY_EMBEDDING_BATCH_SIZE`, `IAPEER_MEMORY_EMBEDDING_API_KEY`, `IAPEER_MEMORY_EMBEDDING_TIMEOUT_MS`, `IAPEER_MEMORY_RERANKER_ENDPOINT`, `IAPEER_MEMORY_RERANKER_PROVIDER`, `IAPEER_MEMORY_RERANKER_MODEL`, `IAPEER_MEMORY_RERANKER_TOP_K`, `IAPEER_MEMORY_RERANKER_WEIGHT`, `IAPEER_MEMORY_RERANKER_API_KEY`, `IAPEER_MEMORY_MAX_RESULTS`, `IAPEER_MEMORY_CHUNK_SIZE`, `IAPEER_MEMORY_CHUNK_OVERLAP`, `IAPEER_MEMORY_RRF_K`, `IAPEER_MEMORY_FULL_SCAN_ON_STARTUP`, `IAPEER_MEMORY_EXCLUDE_FOLDERS`, `IAPEER_MEMORY_DEDUP_THRESHOLD`, `IAPEER_MEMORY_LINK_HINT_THRESHOLD`.

**MCP and the owner:** `IAPEER_MEMORY_MCP_PORT`, `IAPEER_MEMORY_HUMAN_NAME`, `IAPEER_MEMORY_AGENT_NAME`.

**Other (advanced):** `IAPEER_MEMORY_FRESH_EDIT_WINDOW_S`, `IAPEER_MEMORY_INDEX_AGENT`, `IAPEER_MEMORY_PROJECTS_ROOT`, `IAPEER_MEMORY_TAGS_BOUNDARY_MAXLEN`.

**Paths:** `IAPEER_ROOT`, `IAPEER_MEMORY_CONFIG_FILE`, `IAPEER_MEMORY_STATE_DIR`, `IAPEER_MEMORY_CACHE_DIR`, `IAPEER_MEMORY_LOGS_DIR`, `IAPEER_MEMORY_DB_PATH`, `IAPEER_MEMORY_BINARY_PATH`.

> A few more variables (`IAPEER_MEMORY_DEBUG`, `IAPEER_MEMORY_SQLITE_DYLIB`, `IAPEER_MEMORY_SUPPRESS_IAP_SEND`) serve debugging and tests — they aren't set in normal operation.

## Next

- What the curators do and the `CURATOR_TICK` tick — [08 — Curation](08-curation.md).
- How the daemon and the operator commands work — [09 — memoryd and the CLI](09-memoryd-and-cli.md).
- How search and its weighting work — [06 — Search and write](06-search-and-write.md).
