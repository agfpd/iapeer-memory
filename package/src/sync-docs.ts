/**
 * Pack-time docs sync: copy the monorepo-root `docs/` tree into the facade
 * package (`package/docs/`) so the published npm tarball carries the docs that
 * an installed peer reads locally (the agent looks for docs inside the
 * installed package; `package.json` description points at `docs/README.md`).
 *
 * The single source of truth stays at the repo root — `package/docs/` is a
 * build artifact, gitignored and regenerated on every `prepack`. This exists
 * because the publishable package is a workspace SUBDIR while `docs/` lives at
 * the repo ROOT: npm's `files` allowlist is rooted at the package directory and
 * cannot reach `../docs`, so the tree must be materialised inside the package.
 *
 *     bun src/sync-docs.ts
 *
 * Local-only material is pruned to mirror `.gitignore` — it must never reach
 * the public tarball: `internals/` (internal mechanics) and root `ТЗ-*.md`
 * (specs).
 */

import fs from "node:fs";
import path from "node:path";
import { guardedRmSync } from "@agfpd/iapeer-memory-core";

/** Doc subtrees kept local for development — pruned from the public package. */
export const DOCS_EXCLUDE_DIRS = ["internals"] as const;
/** Root-level doc files (specs) kept local for development — pruned from the public package. */
export const DOCS_EXCLUDE_ROOT = /^ТЗ-.*\.md$/;

export function syncDocs(opts: { rootDir: string; pkgDir: string }): {
  destDir: string;
  files: number;
} {
  const srcDir = path.join(opts.rootDir, "docs");
  const destDir = path.join(opts.pkgDir, "docs");
  // Rebuild from scratch so source deletions don't linger in the artifact.
  guardedRmSync(destDir, { recursive: true, force: true });
  fs.cpSync(srcDir, destDir, { recursive: true });
  // Prune local-only material (mirrors .gitignore) after the copy — explicit
  // deletion is unambiguous regardless of cpSync filter directory semantics.
  for (const dir of DOCS_EXCLUDE_DIRS) {
    guardedRmSync(path.join(destDir, dir), { recursive: true, force: true });
  }
  for (const entry of fs.readdirSync(destDir)) {
    if (DOCS_EXCLUDE_ROOT.test(entry)) {
      guardedRmSync(path.join(destDir, entry), { recursive: true, force: true });
    }
  }
  return { destDir, files: countFiles(destDir) };
}

function countFiles(dir: string): number {
  let n = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    n += entry.isDirectory() ? countFiles(path.join(dir, entry.name)) : 1;
  }
  return n;
}

if (import.meta.main) {
  const pkgDir = path.dirname(path.dirname(new URL(import.meta.url).pathname));
  const rootDir = path.dirname(pkgDir);
  const { destDir, files } = syncDocs({ rootDir, pkgDir });
  console.log(`sync-docs: ${files} files → ${path.relative(rootDir, destDir)}`);
}
