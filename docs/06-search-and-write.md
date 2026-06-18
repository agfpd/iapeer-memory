# 06 — Search and write

[Русский](ru/06-поиск-и-запись.md) · **English**

An agent works with memory through three MCP tools (read-only) and ordinary file creation (write). The tools are attached automatically once a peer is granted access to memory ([02 — Quick start](02-quickstart.md)).

## Tools

### memory_search — search

The main entry point when you don't know the exact path. Input — a query in any language; output — up to six notes sorted by relevance, with fields: title, path, type, status, a text snippet around the match, and a score.

```text
memory_search("restart MCP after plugin update")
→ [ { title, path, type, status, score, snippet, related[] }, … ]
```

Search is hybrid. The base layer is full-text (BM25); it always works and doesn't depend on the network. On top of it, if configured, vector search (by meaning) and reranking are added; the results of the two layers are combined. Weighting is affected by: the note's status (active above, stale below — [04](04-note-genres.md)), links (a hub note with many references gets a boost), and origin (another agent's operative memory ranks at ×0.7 — visible, but it doesn't outrank shared knowledge). The output score is relative: the most relevant result is around 1.0, the rest proportionally.

Having found a path, the agent reads the note with an ordinary file read — there's no separate read tool in the set.

### memory_related — links around a note

The wikilink graph around a given note, 1–3 hops deep: what's connected to what, and in which direction. Useful for walking from a note to its neighbors. Links from operative memory into canon are shown in the graph; the reverse (from canon into someone's operative memory) is not — the canon graph isn't cluttered with different agents' personal notes.

### memory_map — store topology

A map of canon as a whole: clusters by topic, hub notes (much-referenced), bridges between topics, orphan notes with no links. Operative memory isn't part of the map. The tool is diagnostic — a curator uses it to find isolates and check store health.

## Writing

Writing is always direct — into the right folder for the note's purpose. There's no intermediate draft inbox: the folder declares the genre, the write hook fills the service fields on write.

**Into canon — straight to the genre folder.** Whatever is useful to the team, the agent writes straight into the canon folder by genre: `01_Knowledge/` for a fact, `02_Decisions/` for a choice, and so on. The agent picks the folder (the genre is visible from the folder), while type, author, status, title, and stamps are filled by the write hook at write time — no model. The agent writes self-contained text, sets at least one tag, and adds links (inline `[[...]]` and the `## Links` block). Curation later proofreads the note and completes the graph with links the author missed ([08 — Curation](08-curation.md)).

**Write-time hints.** Right after a canon note is written, the hook checks it against the store by meaning and signals the author at write time, before curation: if it finds a close possible duplicate, it warns (better to extend the existing note than to spawn a parallel one); if it finds a merely related note, it suggests adding a link. So duplicates are caught at the entrance and the graph grows links right away. This works when vector search is configured (comparison by cosine similarity; the duplicate and link thresholds are tunable — [11 — Configuration](11-configuration.md)).

**Into operative memory — directly.** The agent creates a personal note straight in its subfolder `06_Agent_Memory/<own-name>/`. It writes the body and two fields; the system fills the rest (title, type, date, author):

```markdown
---
subtype: pitfall
description: "1-2 sentence summary of the note"
---
The note body.
```

The agent edits its own operative memory freely — text, status, description. Title, type, date, and author the system keeps unchanged. On edit a "who edited" stamp is set — a service marker by which curation tells apart edits by the author, a curator, and the human.

## What an agent sees in its memory

Your own operative memory is visible in search without a penalty; another agent's is at ×0.7 (visible, but lower). This is the default for a session with a known identity; with administrative access and no identity there's no penalty — everything is seen as-is.
