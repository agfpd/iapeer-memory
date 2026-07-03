/**
 * `iapeer-memory archive-stale [--commit]` — the DELIBERATE backlog archiver
 * (lean §2.2a).
 *
 * memoryd archives notes incrementally as they BECOME stale (an edit fires the
 * change pass). Pre-existing stale notes are NOT swept on startup (that would
 * be a mass move as a side-effect of a daemon boot — banned by §1: bulk
 * actions are deliberate and verifiable). This verb is that deliberate path:
 *
 *   archive-stale            DRY-RUN — list what would move + a count
 *   archive-stale --commit   actually move them
 *
 * Scope = ALL content folders, INCLUDING `03_Projects` (unified rule:
 * a completed phase/project is stale like any note and archives
 * too — `isArchivableZone`). memoryd reindexes the moves on its next pass (or
 * on restart); the verb itself only moves files.
 */

import fs from "node:fs";
import path from "node:path";
import {
  configFromEnv,
  snapshotVault,
  shouldArchive,
  archiveTargetRel,
  guardedRenameSync,
} from "@agfpd/iapeer-memory-core";

export function cmdArchiveStale(argv: string[]): number {
  const commit = argv.includes("--commit");
  const config = configFromEnv();
  const vault = config.vaultPath;
  const taxonomy = config.taxonomy;

  // Candidates: notes in the monitored content folders carrying a final
  // status — ALL content folders incl. 03_Projects (shouldArchive → isArchivableZone).
  const snap = snapshotVault(vault, taxonomy);
  const reserved = new Set<string>(); // archive targets claimed within this run
  const moves: Array<{ from: string; to: string }> = [];
  for (const rel of snap.keys()) {
    let content: string;
    try {
      content = fs.readFileSync(path.join(vault, rel), "utf-8");
    } catch {
      continue;
    }
    if (!shouldArchive(rel, content, taxonomy)) continue;
    const to = archiveTargetRel(
      path.basename(rel),
      taxonomy,
      (r) => reserved.has(r) || fs.existsSync(path.join(vault, r)),
    );
    reserved.add(to);
    moves.push({ from: rel, to });
  }

  if (moves.length === 0) {
    console.log("archive-stale: no stale notes outside the archive — nothing to do.");
    return 0;
  }

  if (!commit) {
    console.log(
      `archive-stale (DRY-RUN): ${moves.length} stale note(s) WOULD move to ${taxonomy.folders.archive}/:`,
    );
    for (const m of moves) console.log(`  ${m.from}  →  ${m.to}`);
    console.log(
      `\nPass --commit to move them. (All content folders incl. 03_Projects — a completed phase/project archives like any stale note; memoryd archives ongoing staleness on its own.)`,
    );
    return 0;
  }

  let moved = 0;
  for (const m of moves) {
    const toAbs = path.join(vault, m.to);
    try {
      fs.mkdirSync(path.dirname(toAbs), { recursive: true });
      guardedRenameSync(path.join(vault, m.from), toAbs);
      moved += 1;
      console.log(`  moved: ${m.from}  →  ${m.to}`);
    } catch (err) {
      console.error(`  FAILED: ${m.from} (${String(err)})`);
    }
  }
  console.log(
    `archive-stale: moved ${moved}/${moves.length}. memoryd reindexes on its next pass (or restart).`,
  );
  return 0;
}
