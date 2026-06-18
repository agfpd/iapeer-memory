/**
 * Embedded skill files — the DIRECT-surface form of the four session skills
 * (ADR-009 v1.2: direct per-peer surfaces instead of the plugin socket).
 * Bodies are the plugin-era skills (historical provenance:
 * adapters/claude/skills, removed with the plugin channel — ADR-017; spot-
 * checked against the live CLI) with exactly two deltas:
 *
 *   1. names are namespaced `iapeer-memory-*` (direct
 *      skills lose the plugin namespace `/iapeer-memory:name` — the prefix
 *      replaces it; the `copywriter` collision class);
 *   2. "plugin" wording → "session surfaces" where it described the socket
 *      form (the socket is now files merged into the peer's cwd).
 *
 * provision-peer materialises them to `<cwd>/.claude/skills/<name>/SKILL.md`
 * (bytes-compare, package-owned — overwritten on version change; the
 * `iapeer-memory-` directory prefix is OUR namespace, unprovision removes
 * every directory matching it).
 */

export type SkillName =
  | "iapeer-memory-init"
  | "iapeer-memory-status"
  | "iapeer-memory-migrate"
  | "iapeer-memory-distill";

export const SKILL_NAMES: readonly SkillName[] = [
  "iapeer-memory-init",
  "iapeer-memory-status",
  "iapeer-memory-migrate",
  "iapeer-memory-distill",
] as const;

/** Directory-name prefix that marks a skill directory as OURS (the removal
 *  glob of unprovision — the namespace promise of the `iapeer-memory-*`
 *  naming). */
export const SKILL_DIR_PREFIX = "iapeer-memory-";

const SKILL_INIT = `---
name: iapeer-memory-init
description: "Use when the user asks to install, provision or initialize iapeer-memory on this host (\\"set up iapeer-memory\\", \\"init memory\\", \\"provision the vault\\"). Thin facade over \`iapeer-memory init\`: the procedure lives in the package CLI, not here."
allowed-tools: ["Bash", "AskUserQuestion"]
---

# Provision iapeer-memory on this host

The session surfaces are only a socket (ADR-009) — provisioning is owned by
the package CLI. Do not improvise installation steps around it.

1. Locate the CLI: \`command -v iapeer-memory || ls ~/.local/bin/iapeer-memory\`.
   Missing → run via \`npx @agfpd/iapeer-memory\` instead.
2. Init is two-mode. On a tty it prompts; your Bash calls have NO tty, so
   without \`--vault\` init refuses (silently provisioning a default storage
   path is forbidden). Collect the answers from the user first
   (AskUserQuestion), then run:
   \`iapeer-memory init --vault PATH --locale en|ru
   [--embedding-endpoint URL] [--reranker-endpoint URL]\`.
   Do NOT ask for the human owner: init reads the iapeer registry and uses
   the single natural peer by itself (don't ask what the stack already
   knows). Pass \`--human NAME\` only when the registry can't answer (zero or
   several natural peers) and the user wants a human role.
3. Init prints a step table (deps → vault → config → binary → templates →
   roles → fleet → watcher → surfaces → slot → sweep → guide) and is
   idempotent: on exit 1 re-running init is the official repair path,
   together with \`iapeer-memory verify --repair\`.
4. A host that is already provisioned and only version-stale wants the
   update story, not init: \`npx @agfpd/iapeer-memory@latest update\`.

After success, check the chain with the \`iapeer-memory-status\` skill.
(\`iapeer onboard\` runs this same init from the core's host phase —
full-stack onboarding already covers memory.)
`;

const SKILL_STATUS = `---
name: iapeer-memory-status
description: "Use when the user asks for the iapeer-memory status (\\"memory status\\", \\"is the vault index alive\\", \\"check iapeer-memory\\", \\"is memoryd running\\"). Read-only facade over \`iapeer-memory status\`: package ↔ surfaces link first, then the CLI's own diagnostics. Never repairs anything."
allowed-tools: ["Bash"]
---

# iapeer-memory status — read-only diagnostics

The session surfaces are the socket, the package is the system (ADR-009).
This skill's first duty is to DIAGNOSE A BROKEN LINK between them — a
session whose surfaces are wired but whose system is missing must say so
explicitly.

1. **Socket → system link**: \`command -v iapeer-memory || ls ~/.local/bin/iapeer-memory\`.
   Missing → report: "session surfaces present, package missing — the socket
   has no system behind it; run: npx @agfpd/iapeer-memory init". Stop here.
2. **Everything else**: run \`iapeer-memory status\` and relay its table —
   verify checks (config, memory-slot, memoryd heartbeat, notifier watcher,
   role doctrine versions, per-peer surfaces), slot-file, mcp-endpoint
   probe, search pipeline. Exit 1 = something needs attention.

Reading the table: \`search\` shows the LIVE per-component pipeline from the
running memoryd (bm25/embedding/reranker/graph) and falls back to the
static config view when memoryd is down.
`;

const SKILL_MIGRATE = `---
name: iapeer-memory-migrate
description: "Use when the user asks to migrate harness auto-memory into iapeer-memory (\\"migrate memory\\", \\"move auto-memory to the vault\\", \\"перенеси auto-memory\\"), or when connecting a peer that has accumulated Claude auto-memory. Facade over \`iapeer-memory migrate\`: the skill resolves the claude-specific SOURCE directory, the deterministic engine does the rest (dry-run → confirm → apply, with backups)."
argument-hint: "<agent> [<project-dir>]"
allowed-tools: ["Bash", "AskUserQuestion"]
---

# Migrate Claude auto-memory into the vault

The engine (\`iapeer-memory migrate\`) is source-agnostic — THIS skill owns the
claude-specific knowledge of where auto-memory lives. (The codex source is
NOT wired yet: its live format is unverified — never guess it.)

## Resolve the source directory

- **Launchd/persistent peer** (no \`<project-dir>\` argument):
  \`SOURCE=~/.claude/agent-memory/<agent>/\`
- **Project session** (\`<project-dir>\` given): the slug is the absolute
  path with every non-alphanumeric character replaced by \`-\` — dots too:
  \`/a/b.c\` → \`-a-b-c\` (so \`~/.iapeer/...\` yields a double dash). When in
  doubt, \`ls ~/.claude/projects/\` and match.
  \`SOURCE=~/.claude/projects/<slug>/memory/\`

No directory or no \`.md\` files inside → nothing to migrate; say so and stop.

## Run

1. Dry-run first: \`iapeer-memory migrate --source "$SOURCE" --agent <agent>\`
   — show the user the plan verbatim (per-file type → subtype mapping,
   skip lists, totals).
2. Ask for confirmation (AskUserQuestion).
3. Apply: same command + \`--apply\`. Per-file backups land under
   \`~/.iapeer/state/iapeer-memory/migrate-backups/\` before conversion; an
   existing target note is never overwritten.
4. Report: migrated/skipped/errors + backup path.

## After migration

A \`feedback\` note that is semantically a pitfall cannot be told apart
deterministically — re-filing such notes to \`pitfall\` is the agent's manual
step afterwards (the iapeer-memory-distill skill covers it).
`;

const SKILL_DISTILL = `---
name: iapeer-memory-distill
description: "Use when the user asks the agent to clean up its own memory (\\"distill your memory\\", \\"прибери свою память\\", \\"clean up your operative notes\\"). Deep MANUAL distillation of the agent's own agent-memory folder, in-session, user in the loop — deeper than the DreamWeaver weekly tick: fact-checks, re-filing, promoting team knowledge to canon."
allowed-tools: ["Read", "Edit", "Write", "Bash", "Glob", "Grep"]
---

# Distill your own agent memory

You are cleaning YOUR OWN folder: \`<vault>/06_Agent_Memory/<your personality>/\`
(RU locale: \`06_Оперативка_агентов/<…>/\`). Identity comes from
\`PEER_PERSONALITY\` — if it is empty, refuse: you cannot know whose memory
you are touching. An absent/empty folder = nothing to distill; say so and stop.

## Superseding a note — set a final status, never delete

Don't \`rm\` or rename a placed note by hand. Set its \`status\` to the final
token for its type (outdated / superseded / dropped / completed) and, if it
is being replaced, write the replacement and cross-link the two. memoryd
moves a final-status note to \`07_Archive\` on the next pass — links survive
(edges re-index) and it stays searchable with the stale de-boost. Final
status IS the deletion; the move is automatic, no curator needed.

Body edits that keep identity (rewording, updating description, switching
subtype) change nothing structural — just edit in place.

## Passes

1. **Inventory**: list every note; for each — subtype, status, age, one-line
   gist.
2. **Dedup**: near-duplicate notes about one topic → merge into the
   strongest one, deprecate the rest (watershed rule).
3. **Compress**: bloated notes → tighten to the essentials; notes are
   injected into readers' contexts, bloat costs the whole team tokens.
4. **Verify**: notes asserting local facts (paths, flags, versions) —
   re-check the fact cheaply where possible; stale → fix or deprecate.
5. **Re-file**: \`feedback\` notes that are semantically pitfalls (a rule
   born from one incident) → subtype \`pitfall\`; other mis-filed subtypes
   likewise.
6. **Promote**: material useful to the whole team → write it straight into
   the right typed canon folder (canon style: self-contained, objective),
   keep the personal angle in your memory note with an inline \`[[title]]\` link.
7. **Report**: summary to the user — counts per pass, anything that needs
   their decision.

Confirm with the user between passes 6 and 7 when the promote list is
non-empty — moving knowledge to canon is visible to the whole team.
`;

export const SKILL_BODIES: Record<SkillName, string> = {
  "iapeer-memory-init": SKILL_INIT,
  "iapeer-memory-status": SKILL_STATUS,
  "iapeer-memory-migrate": SKILL_MIGRATE,
  "iapeer-memory-distill": SKILL_DISTILL,
};
