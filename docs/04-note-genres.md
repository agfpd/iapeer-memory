# 04 — Note genres

[Русский](ru/04-жанры-заметок.md) · **English**

A note's type is set by the canon folder the author writes into — there's no separate field to choose. Five genres, each with its own shape and its own status scale.

## Knowledge (`01_Knowledge`)

Verifiable facts about how a system or a subject area works. The viewpoint is objective — a description, not an instruction to an agent. Four kinds live in one folder:

- **plain knowledge** — a factual statement;
- **research report** — the shape "Question → Answer → Details → Sources";
- **stable pattern** — a solution that has recurred several times, in the form "when you see X, do Y";
- **incident pattern** — a lesson from an incident: not a chronicle of the event but the extracted rule.

Statuses: `draft` → `current` → `outdated` (to the archive).

## Decision (`02_Decisions`)

A choice between alternatives, with rationale. A simple test: were there alternatives — it's a decision; were there none — it's knowledge. Recommended shape: "Context → Decision and rationale → Alternatives".

A decision is immutable as a fact: choosing X from {X, Y, Z} is something that happened, and it isn't rewritten. When a decision is revisited, the old one is marked `superseded` and the new one is filed as a separate note with mutual links — the history of the choice is preserved.

Statuses: `accepted` → `superseded` (to the archive).

## Project (`03_Projects/<name>`)

One folder per project, three kinds of file:

- **Overview** — what the project is, its goal, the maintainer;
- **Plan** — a list of phases, appended as they appear (append-only);
- **Phase** — tasks as a checklist plus working notes, also append-only.

Append-only means: you add to the plan and the phases, you don't rewrite history. Phases aren't numbered or ordered — they can run in parallel.

Overview and plan statuses: `active` → `paused` → `completed`. A phase has its own, wider scale: `planned` / `active` / `completed` / `paused` / `cancelled` (the `completed` vs `cancelled` distinction matters for history — goal reached, or abandoned).

## Idea (`04_Ideas`)

Hypotheses and thoughts without verification — "might come in handy". An idea can grow into a project or, once confirmed, into knowledge (filed separately), or be dropped.

Statuses: `new` → `in_progress` → `dropped` (to the archive).

## List (`05_Lists`)

Registries of same-kind entities (suppliers, channels, dictionaries) and profile dossiers of a single durable entity (a route, a marketplace, a partner). Lists are kept append-only: the author adds without rewriting.

Statuses: `current` → `outdated` (to the archive).

## Statuses and search

A note's status affects its weight in search. Roughly three groups:

- **active** (`current`, `active`, `accepted`, `new`, `in_progress`) — boosted in results;
- **in progress** (`draft`, `planned`, `paused`) — neutral weight;
- **final** (`outdated`, `superseded`, `dropped`, `completed`, `cancelled`) — lowered weight, moved to the archive.

So a stale note doesn't vanish — it's still found by search as history, but it doesn't outrank the current. The weighting mechanism is covered in [06 — Search and write](06-search-and-write.md).
