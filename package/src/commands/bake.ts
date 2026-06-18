/**
 * `iapeer-memory bake <files>` — re-stamp `last_edited_by = <agent>` (+ `updated`)
 * on the given notes. THE PROBLEM: a shell/bash write to the vault (`echo >`,
 * `sed -i`, `tee`, `cp`/`mv` …) bypasses the PostToolUse hook, so memoryd sees
 * only the fs-change with no identity and humanEditPass mis-attributes it to the
 * human. `bake` fixes the attribution: it makes the note a settled AGENT edit
 * (humanEditPass then echo-agent-skips it; it also OVERWRITES a stamp memoryd may
 * have raced in). It is `fm-update` with NO field ops — a pure attribution stamp.
 * The just-in-time post-Bash hook reminds the agent to run it (no standing rule:
 * the reminder fires only on a detected bash-vault-write).
 *
 * SCOPE — `last_edited_by`, not `author`. `bake` stamps the EDITOR. On a bash
 * EDIT of an existing note that is exactly right. On a bash CREATION of a brand
 * new note, memoryd mis-attributes BOTH `author` and `last_edited_by` to the
 * human; `bake` corrects `last_edited_by` but `author` stays the human — a stamp
 * can't reconstruct authorship the write hook never witnessed. So for a NEW note,
 * create it via Write (the write hook sets `author` from your identity); reach for
 * `bake` to repair the editor stamp on shell-written edits.
 *
 *     iapeer-memory bake [--agent NAME] [--vault PATH] FILE [FILE ...]
 *
 * identity: `--agent` → PEER_PERSONALITY → IAPEER_MEMORY_AGENT_NAME
 * (resolveAgentName, нюанс 10 — never guessed from cwd). No identity → error
 * (a stamp with no author would be meaningless).
 */

import {
  collectOps,
  DEFAULT_CURATOR_SET,
  fmUpdate,
  getTaxonomy,
  isLocaleId,
  resolveAgentName,
} from "@agfpd/iapeer-memory-core";

export function cmdBake(argv: string[]): number {
  let agent: string | null = null;
  let vault = "";
  const files: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--agent") {
      agent = argv[++i] ?? null;
    } else if (a === "--vault") {
      vault = argv[++i] ?? "";
    } else if (a.startsWith("--")) {
      console.error(`iapeer-memory bake: unknown flag: ${a}`);
      return 2;
    } else {
      files.push(a);
    }
  }
  if (!files.length) {
    console.error("iapeer-memory bake: no files given");
    return 2;
  }

  const localeRaw = process.env.IAPEER_MEMORY_LOCALE || "en";
  if (!isLocaleId(localeRaw)) {
    console.error(`iapeer-memory bake: unknown locale "${localeRaw}"`);
    return 2;
  }
  const resolved = resolveAgentName(agent);
  if (!resolved) {
    console.error(
      "iapeer-memory bake: no agent identity (set PEER_PERSONALITY or pass --agent NAME)",
    );
    return 2;
  }
  const curatorSet = (process.env.IAPEER_MEMORY_CURATOR_SET || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  fmUpdate({
    files,
    ops: collectOps({ set: [], unset: [], listAdd: [], listRemove: [] }),
    agent: resolved,
    vault: vault || process.env.IAPEER_MEMORY_VAULT_PATH || "",
    taxonomy: getTaxonomy(localeRaw),
    curatorSet: curatorSet.length ? curatorSet : DEFAULT_CURATOR_SET,
    stamp: true,
  });
  return 0;
}
