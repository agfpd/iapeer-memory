/**
 * On-host per-package docs (ecosystem convention FU6, sanctioned by the owner;
 * foundation reference: scaffoldHostDocs in iapeer src/install/index.ts).
 *
 * Every package copies its PUBLIC docs into `<IAPEER_ROOT|~/.iapeer>/docs/<pkg>/`
 * on each install AND update — one readable folder per package, version-matched
 * to the installed artifact. The copy is necessary because no other location
 * survives: the compiled binary carries no docs, the npm tarball's `docs/` is
 * discarded after install, the bunx cache is transient. The on-host copy in
 * `~/.iapeer` persists across GC/clean and always matches the installed version.
 *
 * Ownership is isolation: each package writes ONLY its own `/<pkg>/` subtree.
 * The write is atomic (temp-sibling → rename, so a reader never sees a
 * half-copy) and best-effort (a missing source or fs error must never fail the
 * install/update). Exclusions are exactly the tarball's (pruneLocalDocs:
 * internals/, root ТЗ-*.md, .DS_Store).
 */

import fs from "node:fs";
import path from "node:path";
import { guardedRmSync, guardedRenameSync } from "@agfpd/iapeer-memory-core";
import { countDocsFiles, pruneLocalDocs } from "./sync-docs.js";

/** This package's SHIPPED `docs/` — a sibling of `src/` in the published
 *  tarball (materialised at prepack, see sync-docs.ts). Resolved relative to
 *  THIS module so it works wherever the package is unpacked (npx/bunx cache).
 *  Absent when running from the compiled binary (docs aren't bundled) → the
 *  caller degrades best-effort. */
export function packageDocsDir(): string {
  return path.join(
    path.dirname(path.dirname(new URL(import.meta.url).pathname)),
    "docs",
  );
}

export type HostDocsResult = { action: "written" | "skipped"; detail: string };

/**
 * Mirror `docsSource` into the on-host per-package docs dir `destDir`
 * atomically. Returns `skipped` when the source is absent (best-effort — the
 * caller must not fail install on it). Throws only on a genuine fs/guard error
 * (the caller wraps it to stay best-effort). The sandbox write-guard fires via
 * the first `guardedRmSync` (the temp sibling shares destDir's anchor), so a
 * prod-anchored dest under a test sandbox is refused before any copy.
 */
export function scaffoldHostDocs(opts: {
  docsSource: string;
  destDir: string;
}): HostDocsResult {
  const { docsSource, destDir } = opts;
  if (!fs.existsSync(docsSource)) {
    return { action: "skipped", detail: `no docs source (${docsSource})` };
  }
  const tmp = `${destDir}.tmp`;
  guardedRmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(destDir), { recursive: true });
  fs.cpSync(docsSource, tmp, { recursive: true });
  pruneLocalDocs(tmp);
  // Atomic swap: replace the live tree with a single rename.
  guardedRmSync(destDir, { recursive: true, force: true });
  guardedRenameSync(tmp, destDir);
  return { action: "written", detail: `${countDocsFiles(destDir)} files → ${destDir}` };
}
