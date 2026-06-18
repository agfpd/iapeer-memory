# 03 — Vault: layout and zones

[Русский](ru/03-vault-и-зоны.md) · **English**

The vault is a directory of markdown files, compatible with Obsidian. Eight top-level folders; the set is fixed, the names are configurable — there's a Russian and an English layout (chosen at install).

## Layout

```text
vault/
├── 01_Knowledge/      facts, patterns, research reports
├── 02_Decisions/      choices between alternatives, with rationale
├── 03_Projects/<name>/ overview, plan, project phases (one folder per project)
├── 04_Ideas/          hypotheses, "might come in handy"
├── 05_Lists/          registries and profiles
├── 06_Agent_Memory/   each agent's personal notes (in name-subfolders)
├── 07_Archive/        notes with a final status (mirrors the canon structure)
└── 99_System/         templates and the tag dictionary
```

The Russian layout is the same folders under the names `01_Знания`, `02_Решения`, `03_Проекты`, `04_Идеи`, `05_Списки`, `06_Оперативка_агентов`, `07_Архив`, `99_Система`.

The folders split by purpose:

- **Canon** (`01_*`–`05_*`) — the team's shared knowledge, laid out by genre ([04 — Note genres](04-note-genres.md)). Both agents and the owner write straight into the right folder: the folder declares the genre, the write hook fills the service fields on write. There's no intermediate draft inbox.
- **Operative memory** (`06_*`) — agents' personal notes, one subfolder per agent ([03 §Operative memory](#operative-memory) below).
- **Archive** (`07_*`) — notes with a final status; the structure inside mirrors canon.
- **System** (`99_*`) — note templates and the tag dictionary (both authors and the curator extend it).

Authorship is stored not by folder but by the `author` field in the note: canon is laid out by genre, not by author. The per-author view is the author's note index, which reaches the agent in the system prompt ([07 — Context delivery](07-context-delivery.md)).

## Edit zones: who can change what

Memory stays in order not by forbidding edits but through clear access zones.

- **Canon (`01_*`–`05_*`) — shared, edited by everyone.** Both agents and the owner edit any canon note: rephrase, replace stale, extend — it's team knowledge, not personal property. When you edit a note you didn't author, the system automatically appends you to `coauthors` — the `author` field is immutable (it records who created the note), only the co-author list grows. This is sanctioned co-authorship.
- **Your own operative memory (`06_*/<you>`) — owner only.** Only the owner of an operative subfolder writes to or edits it.
- **Another's operative memory — read-only.** You can't edit another agent's subfolder — it's their personal zone; the whole team may read it (lower-ranked in search).

What the author edits in the note itself: the body, tags (at least one), and links — inline `[[...]]` and the `## Links` block. The service fields (type, author, status, dates) it doesn't touch — those are filled by the write hook; from frontmatter only `status` is edited. Structure and graph health are kept by the Index curator: it enriches links, repairs broken ones, merges duplicates, and maintains the tag dictionary ([08 — Curation](08-curation.md)).

On every edit the system stamps `last_edited_by` — who last changed the file. Edits by neither the author nor a curator are flagged for review (`needs_review`) — a curator's proofreading queue, not a block. Curator roles (Index, Scriber, DreamWeaver) are exempt from the flag — their edits are sanctioned. Edits made around the system (in Obsidian, by hand) are recognized too — the note gets the editor's authorship and a review flag, and those edits aren't lost.

**Co-authorship.** An agent becomes a co-author of a note three ways: by editing someone else's canon note (the system appends it to `coauthors` automatically); by a merge — when a curator consolidates its note with another during dedup; and by hand — when the project owner adds a co-author to an overview or plan.

## Operative memory

`06_Agent_Memory/<name>/` is each agent's personal zone, a replacement for the runtime's built-in memory. The agent writes here directly, without curation: feedback, working context, the owner's profile, lessons learned. Only the owner of a subfolder may write to it; the whole team may read, but another agent's operative memory ranks lower in search ([06 — Search and write](06-search-and-write.md)).

Operative notes carry a `subtype` field — one of five:

| subtype | What it holds |
|---|---|
| `feedback` | how to work with the person and colleagues, what worked for them |
| `context` | a current working thread, an experiment before it settles into knowledge |
| `reference` | personal coordinates: paths, selectors, steps, procedural tricks |
| `person_profile` | facts about the owner: how to address them, time zone, preferences |
| `pitfall` | a rule after a concrete incident |

Operative memory doesn't go through Scriber proofreading; it's cleaned by DreamWeaver's weekly consolidation ([08 — Curation](08-curation.md)).

## Archiving

When a note reaches a final status (knowledge goes `outdated`, a decision `superseded`, a project `completed`), memoryd moves it to `07_Archive/` into a mirror subfolder on its next pass. This is base infrastructure — a deterministic move with no model: the author just sets the final status, no need to delete notes by hand. The note stays in the store and is still found by search, but ranks lower — it's history, not the current truth. Which statuses are final for each genre — in [04 — Note genres](04-note-genres.md).
