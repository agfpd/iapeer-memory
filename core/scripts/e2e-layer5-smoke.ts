/**
 * Manual e2e smoke for layer-5 delivery (stage 7 acceptance).
 *
 * Renders a REAL author index from a throwaway vault containing a note with
 * an unguessable token, assembles the per-peer doctrine fragment with
 * context-render and writes it into a TEST peer's cwd. The live check is
 * then driven from outside:
 *
 *   1. bun core/scripts/e2e-layer5-smoke.ts render <peer-cwd> <token-title>
 *   2. iapeer send <peer> --message "процитируй строки с [[ ]] из секции
 *      vault-индекса твоего системного промпта" --from <you>
 *      → reply must contain the token title.
 *   3. bun core/scripts/e2e-layer5-smoke.ts clean <peer-cwd>
 *   4. iapeer stop <peer> && iapeer send … again (cold-wake rebuilds the
 *      prompt) → reply must NOT contain the token.
 *
 * SAFETY: writes ONLY into the given peer cwd and the iapeer-memory state
 * namespace. It never touches the production host-wide ~/.iapeer/fragments/
 * — the fleet guide rollout is a separately sanctioned release step.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { regenerateVaultIndex } from "../src/index-render.js";
import { renderPeerFragment, peerFragmentsDir, FRAGMENT_STEM } from "../src/context-render.js";
import { getTaxonomy, DEFAULT_RANKING } from "../src/taxonomy.js";

const STATE = path.join(os.homedir(), ".iapeer", "state", "iapeer-memory", "e2e-smoke");

function usage(): never {
  console.error("usage: e2e-layer5-smoke.ts render <peer-cwd> <token-title> | clean <peer-cwd>");
  process.exit(2);
}

const [mode, peerCwd, tokenTitle] = process.argv.slice(2);
if (!mode || !peerCwd) usage();

if (mode === "clean") {
  const frag = path.join(peerFragmentsDir(peerCwd), FRAGMENT_STEM);
  if (fs.existsSync(frag)) fs.unlinkSync(frag);
  fs.rmSync(STATE, { recursive: true, force: true });
  console.log(`cleaned: ${frag} + ${STATE}`);
  process.exit(0);
}

if (mode !== "render" || !tokenTitle) usage();

const taxonomy = getTaxonomy("ru");
const ctx = { taxonomy, ranking: { ...DEFAULT_RANKING } };
const vault = path.join(STATE, "vault");
const agent = "memfragtest";

// Throwaway vault: one knowledge note titled with the unguessable token.
const noteDir = path.join(vault, taxonomy.folders.knowledge);
fs.mkdirSync(noteDir, { recursive: true });
fs.writeFileSync(
  path.join(noteDir, `${tokenTitle}.md`),
  `---\ntitle: ${tokenTitle}\nauthor: ${agent}\ntype: ${taxonomy.types.knowledge}\nstatus: ${taxonomy.statusTokens.current}\n---\n\nЗаметка-зонд e2e-смоука слоя 5.\n`,
  "utf-8",
);

// Real renderer → real per-peer fragment.
const outFile = path.join(STATE, `${agent}-vault-index.md`);
regenerateVaultIndex({ vault, agent, outFile, ctx, projectsRoot: STATE });
const written = renderPeerFragment({
  peerCwd,
  env: {
    agent,
    paths: { vault, state: STATE, cache: STATE },
    authorIndexPath: outFile,
  },
});
console.log(`fragment written: ${written}`);
console.log(fs.readFileSync(written, "utf-8"));
