# 08 — Curation

[Русский](ru/08-курирование.md) · **English**

Canon is filled directly: authors write straight into the right genre folder, and the write hook fills the service fields on write. Curation sits not at the entrance but on top of already-placed canon: it proofreads notes, enriches links, repairs structure, and clears out the stale — so the store stays a store, not a dump.

## Roles

**Index — curator of links and health.** One per store, but not a standing process: it spins up on the `CURATOR_TICK` tick or on demand, works a batch, and winds down. It enriches already-placed notes with links (finding by search what the author missed), maintains the tag dictionary, ties notes to project phases, and checks store health: it looks for orphans and broken links and fixes them, finds and merges duplicates of existing notes, and reports a summary to the owner. It doesn't place notes into folders (authors do that by writing directly) and doesn't archive by hand (archiving is the deterministic base). Index directs the other roles but doesn't write note content — that's the authors' zone.

**Scriber — proofreading.** Spins up for the task, checks a note already placed in canon: formatting, style, coherence, factual accuracy (up to fact-checking on the web). It fixes the small stuff itself and returns the questionable with a verdict. It works on the `CURATOR_TICK` tick or on demand; it doesn't place notes and doesn't deal with drafts. Once done, it winds down — it's an ephemeral iapeer worker: a fresh session per task, with no accumulated context.

**DreamWeaver — consolidation.** Cleans agents' personal operative memory: removes duplicates, compresses descriptions, reconciles links, extracts rules from transcripts. Runs weekly on a timer. First a deterministic collector script (no model) finds the folders that saw work over the week and assembles ready tasks with candidates; then DreamWeaver fans out one subagent per task — each only judges what it's handed, touching only the notes in the weekly window. Folders with no activity don't wake the model (the schedule is configured by the `IAPEER_MEMORY_DREAM_*` variables).

Each role's proactivity is configurable: by the `IAPEER_MEMORY_MODE` mode (`lean` / `curated`) and by per-role toggles. You can turn any curator off individually or silence the tick entirely — the system keeps indexing, searching, and archiving. How exactly — in [11 — Configuration](11-configuration.md).

## What happens when an agent writes a note

On write, the write hook (deterministic fill logic, no model) sets the service fields: type from the folder, author, status, title, stamps. The note is already in the right canon folder. For an agent this is done by the `PostToolUse` hook; for a human, by the `humanEditPass` (memoryd completes a bare-body note via `fs.watch`). `memoryd` notices the change and accumulates it toward the `CURATOR_TICK` tick, which once per cadence (6 hours by default) goes to curation as a single list of paths. From there the path depends on what changed.

**A canon note**: on the `CURATOR_TICK` tick, Scriber proofreads it (formatting, style, facts) and renders a verdict; Index enriches it with links, checks for duplicates of existing notes (by search) and merges on a match. A summary goes to the owner; if there's nothing to handle — silence.

**An edit in canon**: it's checked against the template and the zones. Any non-curator edit — the author's own included — flags the note for review; the flag is the curation queue itself, and Index clears it once the note is actually curated.

**An operative note**: curated more lightly — without Scriber proofreading. Index may set its links; DreamWeaver cleans it.

## Protection against self-looping and outside edits

Curation edits notes itself (sets links, markers) — and must not react to its own edits as a new event, or it would loop forever. Three mechanisms guard against that:

- changes are detected by content, not file time, and service fields are excluded — so an edit of only the service fields raises no event (this also damps false triggers from cloud sync, which touches file time);
- by the "who edited" stamp, curation recognizes its own edits and skips them;
- edits made around the system (in Obsidian, by hand) are, conversely, recognized — the note gets the editor's authorship and a review flag.

That last point matters: the owner or an agent may edit files directly in an external editor, and those edits aren't lost — curation notices and accounts for them.

Who counts as curation is a configurable list of personalities, by default `index`, `scriber`, `dreamweaver` (the `IAPEER_MEMORY_CURATOR_SET` variable). The system uses it to tell its roles' edits from outside ones. If the roles were renamed or a new curator was added, the list must be updated — otherwise the new curator's edits are taken for hand edits from outside and notes are flagged for review for nothing.

## Consolidation (distill)

Operative memory lives fast and accumulates duplicates and noise. Consolidation puts it in order: it walks an agent's subfolder, merges similar notes, compresses descriptions, reconciles links, and when needed pulls fresh facts from session transcripts. It works in two modes — weekly on a schedule (automatically, including for agents that are offline at the time) and on the agent's own request, when the owner asks it ("tidy up your memory"). That keeps personal notes useful without manual cleanup.
