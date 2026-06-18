# 05 — Links and tags

[Русский](ru/05-связи-и-теги.md) · **English**

Notes are connected two ways: by links to one another (the graph) and by tags (subject classification). The author sets both — links and tags are part of writing a note; the curator later enriches the graph with what the author missed and maintains the tag dictionary.

## Links

Notes reference one another with wikilinks `[[Note name]]`. Those links form a graph that memory is navigated along ([06 — Search and write](06-search-and-write.md): `memory_related`, `memory_map`).

A canon note has a service links block — a `## Links` section right after the frontmatter, before the body:

```markdown
---
(frontmatter)
---

## Links

- [[Related note]] — how it's related
- [[Another note]] — a different reason

---

The note body…
```

Each line is `- [[Name]] — reason` (the reason is short, no trailing period); after the list a horizontal rule `---` separates the service block from the body. Links come in two kinds, and both go into the graph equally: **inline** — right in the body, when the note is part of what you're saying ("as in `[[X]]`"); and the **`## Links` block** — a separate link to an adjacent note that isn't in the text but is close in meaning. The author sets both while writing. The curator then enriches the section with links the author missed — finding them by searching the store.

When a decision is superseded by another, mutual links are set: on the old one — "superseded by this", on the new one — "supersedes this". Both links go into the graph, and the history of the choice is navigable both ways.

## Tags

One axis — subject: a tag answers "what is this note essentially about". A technical topic, a work area, or a domain. Every canon note carries at least one tag; operative memory carries no tags.

**A subtag** `domain/subaspect` — a refinement within one domain, when the subaspect makes no sense on its own. `MergeMind/architecture` is a subtag (architecture means nothing without the MergeMind context). But `Security` and `LLM` are two independent tags, not `Security/LLM`: each is meaningful on its own.

**Project membership is not a tag.** It's expressed differently: a note inside `03_Projects/<name>/` belongs to the project by virtue of the folder; a note outside the project folder is linked to it by a link to its overview. This keeps tags about "what", not "where it belongs".

**A domain or meta-project** is a top-level tag, not a folder. Optionally a domain hub note is created: one note with that tag, whose links section lists the member projects. Project membership in the domain is then expressed through the hub's links, not a tag stamp on every note.

The tag dictionary lives in `99_System/Tags.md` — a table "tag → boundary (what it's about and what it's NOT)". The boundary is required for overlapping domains (a platform versus a subject area, say) so the tag choice is unambiguous. If no tag fits, the author adds a new one straight into the dictionary (explicitly, not on the fly) and applies it; the curator looks after the dictionary as a whole, cleaning up overlaps and duplicates.

## Tags in search

A tag is a navigation marker, not a search filter: `memory_search` doesn't filter by tags (the full-text index doesn't account for them). Where tags work:

- in the author's note index (the system prompt) — a quick "what are my notes about" before the first search;
- in the graph and the map (`memory_related`, `memory_map`) — clusters by dominant tag, the domain hub;
- in an external editor (Obsidian) — the tag pane, filters, sorting.
