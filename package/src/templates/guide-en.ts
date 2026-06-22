/**
 * Writer's guide — EN base. The HOST-WIDE layer-5 fragment: every peer of
 * the fleet reads this on every cold wake (ADR-001). Token-frugal by
 * design — bloat here costs the whole team on every session. Source of
 * truth: docs/01–05; the style base is the proven reference guide.
 */

export const GUIDE_EN = `# iapeer-memory — the team's shared memory

iapeer-memory is the team's shared memory (agents + human): the canon plus
each agent's personal memory. You read it and you write it.

**Start a substantial task by searching iapeer-memory first.** Research, a
decision, a recurring problem, or work that continues someone else's — the
team may have already solved it.

**Verify before acting.** A note is a snapshot at write time.

**On a conflict between memory and observation — trust the observation.**
Update or deprecate the stale note. This is living memory.

## Write proactively — you don't exist between sessions

A session is ephemeral: when it ends, the context is gone. The vault is the
only thing that survives — what isn't written is lost. You record it
immediately, yourself, into the canon or your memory. What and where — you
decide, not the human. Asking the human "should I write this down?" is an
anti-pattern.

- **Session handoff / continuation snapshot** → at logical milestones:
  finished a meaningful chunk of work, before a risky operation, when the
  session is clearly wrapping up. NOT every step (burns tokens).
- **A handoff is a rolling snapshot, not a log.** Keep ONE handoff per active
  work thread (stable, dateless title — put the date in the body) and rewrite
  its body in place; the new snapshot supersedes the old. Thread finished or
  split — flip the old one to \`outdated\` (it's auto-archived) and start a new
  one. Don't accumulate old handoffs — they're noise in the whole team's context.
- **Something evolving** → consolidate at milestones, don't rewrite it by
  micro-steps.

**Write concisely.** Notes are injected into readers' contexts — bloat
costs tokens for the whole team.

**Sweep as you write.** Added or updated a note → check whether an older
note on the same topic became stale: flip its \`status\` to the final token.

## Storage layout

| Folder | What it holds | \`type\` | \`status\` |
|---|---|---|---|
| \`01_Knowledge/\` | Facts, conceptual descriptions, nuances of external systems, reference tables, recurring patterns, incidents generalized to a pattern | \`knowledge\` | \`current\` → \`outdated\` |
| \`02_Decisions/\` | Choices among alternatives, with rationale. **Immutable** once decided | \`decision\` | \`accepted\` → \`superseded\` |
| \`03_Projects/<name>/\` | One subfolder per project: \`Overview <name>.md\`, \`Plan <name>.md\`, \`Phase — <title>.md\` | \`project\` | Overview/Plan: \`active\` / \`paused\` / \`completed\`. Phase (exception): \`planned\` / \`active\` / \`completed\` / \`paused\` / \`cancelled\` |
| \`04_Ideas/\` | Hypotheses, "might be useful later" thoughts | \`idea\` | \`new\` → \`in_progress\` → \`dropped\` |
| \`05_Lists/\` | Registries, dictionaries, trackers (append-only); profiles of durable external entities | \`list\` | \`current\` → \`outdated\` |
| \`06_Agent_Memory/<name>/\` | Each agent's personal memory — feedback, working context, personal references, person profile, pitfalls | \`agent_memory\` | \`current\` → \`outdated\` |

## How and where to write

**Write and edit notes with your runtime's file tool, not bash.** claude — \`Write\`/\`Edit\`, codex — \`apply_patch\`. A bash write (\`cat\`/\`>\`/\`sed\`) is invisible to the post-write hook: memoryd mis-attributes the edit to the human and leaves a new note with no author.

### Canon notes

**The canon** (knowledge / decisions / ideas / projects / lists) — information useful to the human and the agents, **stable material not tied to a single task**: conceptual descriptions of systems, nuances of external systems, decisions with alternatives and rationale, ideas and hypotheses, project overviews / plans / phases / lists / registries, profiles of durable external entities, stable patterns and incidents generalized to a pattern, infrastructure facts, and so on.

**Canon writing style** — idiomatic English, academic tone, self-contained text (no references to the conversation's context, expand abbreviations on first use), no emoji. Mark hypotheses as hypotheses ("Looks like X" / "Assumption: X").
**The canon's viewpoint is knowledge about a system.** A canon note describes the system objectively: what exists, how it works, what follows. A consequence is stated as a fact, in impersonal third person, as a property of the system. The subjective, procedural "how I act" lives in your memory (\`reference\` / \`pitfall\`). Material that is "objective knowledge + a personal technique" is split by the "Material both for the team and for you" rule below.

**Filename = the note's clear title.** Three months on, any reader sees only the title in the index — it must convey what the note is about without opening the file.

From you: BODY + ≥1 tag from the dictionary + organic inline \`[[...]]\` links + a self-describing TITLE (= the filename). Path: \`{{VAULT_PATH}}/01_Knowledge/<Clear title>.md\`; frontmatter between \`---\` fences with \`tags: [Tag1, Tag2]\`, then the body.

Tags come from the dictionary \`99_System/Tags.md\`, ≥1 per canon note. No fitting tag? Add a new one to the dictionary (explicitly, not on the fly) and use it right away — ANY author may add one when needed, no waiting. The Index CURATES the dictionary (dedup of near-duplicates, boundary coherence), so add deliberately rather than duplicating; the roles are complementary (you add, the Index keeps it coherent).

**Links: inline and the \`## Links\` block.** A \`[[Note]]\` reference comes in two forms — both go into the graph equally:
- **inline** — right in the text, when the note IS part of what you're saying ("as in [[X]]").
- **the \`## Links\` block** — a separate link to a related note that isn't in the text but is conceptually nearby. **Place it at the END of the note, after the body.** Each line: \`- [[X]] — how it relates\` (related / extends / contradicts / applies). The explanation is mandatory — name the gist of the link in one phrase; it also keeps you from linking blind. Tags go in the frontmatter, not in this block.

### Your memory → your own folder

**Memory** (\`06_Agent_Memory/<name>/\`) — what's personally useful to you, by the 5 subtypes below.

**5 \`subtype\` values:**

- \`feedback\` — from colleagues (human or agent).
- \`context\` — personal context of a project, topic, or task (a handoff).
- \`reference\` — personal navigation marks, your procedural technique ("X first, then Y"), and the like.
- \`person_profile\` — facts, goals, preferences about a person.
- \`pitfall\` — a rule born from one incident (stepped on it once — wrote it down so it won't repeat).

Path: \`{{VAULT_PATH}}/06_Agent_Memory/<your name>/<Title>.md\`; frontmatter: \`subtype: <one of 5>\` + \`description: '1-2 sentence summary'\`, then the body.

### Material both for the team and for you

Part of it is shared team knowledge, part is your memory → do **both**: into the canon (for the team) + a memory note mentioning it inline as \`[[The clear title]]\`.

## Editing rules

**The canon is team knowledge, edit it freely** (your own and others'): reword, replace stale text in place, no "## Update YYYY-MM-DD" journals. **Memory is edited only by its author** (a personal zone).

From the frontmatter you change ONLY \`status\` (by the type's scale, from the "Storage layout" table above). You don't touch \`type\`, the tag structure, or another agent's memory. **\`needs_review\` is a MECHANIC's flag, not yours:** the mechanics set it, the Index or the human clears it — NOT you. If it appears after your edit, do NOT clear it and do NOT write to / notify the Index about it: the Index sweeps flagged notes on its own in the background, on the curation cadence (≈6 hours). Just carry on — there is nothing to do or report.

Don't delete notes by hand. Set the final \`status\` — it's archived automatically (moved to \`07_Archive\`, links intact, the note stays in search with the stale de-boost). The final status IS the deletion: knowledge/list/memory → \`outdated\`, decision → \`superseded\`, idea → \`dropped\`, project/phase → \`completed\`/\`cancelled\`.

## Projects

\`Plan <name>.md\` = the high-level phase list; \`Phase — <title>.md\` = that phase's task checklist. Both are append-only — add, don't rewrite history.
`;
