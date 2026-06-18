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
 * Local-only / OS-cruft material is pruned (see `pruneLocalDocs`): `internals/`
 * (internal mechanics) and root `ТЗ-*.md` (specs) mirror `.gitignore`;
 * `.DS_Store` (macOS) must reach neither the tarball nor the on-host docs copy.
 * The same pruner is reused by the on-host docs scaffold (host-docs.ts).
 */

import fs from "node:fs";
import path from "node:path";
import { guardedRmSync } from "@agfpd/iapeer-memory-core";

/** Doc subtrees kept local for development — pruned from any public copy. */
export const DOCS_EXCLUDE_DIRS = ["internals"] as const;
/** Root-level doc files (specs) kept local for development — pruned. */
export const DOCS_EXCLUDE_ROOT = /^ТЗ-.*\.md$/;

/** Strip local-only and OS-cruft material from a COPIED docs tree, in place:
 *  `internals/` + root `ТЗ-*.md` (mirror `.gitignore`) and `.DS_Store` anywhere.
 *  Shared by the prepack tarball sync and the on-host docs scaffold so both
 *  exclude exactly the same set. */
export function pruneLocalDocs(destDir: string): void {
  for (const dir of DOCS_EXCLUDE_DIRS) {
    guardedRmSync(path.join(destDir, dir), { recursive: true, force: true });
  }
  for (const entry of fs.readdirSync(destDir)) {
    if (DOCS_EXCLUDE_ROOT.test(entry)) {
      guardedRmSync(path.join(destDir, entry), { recursive: true, force: true });
    }
  }
  removeDsStore(destDir);
}

/** `.DS_Store` can sit in any subdirectory of a macOS-touched tree. */
function removeDsStore(dir: string): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) removeDsStore(p);
    else if (entry.name === ".DS_Store") guardedRmSync(p, { force: true });
  }
}

export function countDocsFiles(dir: string): number {
  let n = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    n += entry.isDirectory() ? countDocsFiles(path.join(dir, entry.name)) : 1;
  }
  return n;
}

export function syncDocs(opts: { rootDir: string; pkgDir: string }): {
  destDir: string;
  files: number;
} {
  const srcDir = path.join(opts.rootDir, "docs");
  const destDir = path.join(opts.pkgDir, "docs");
  // Rebuild from scratch so source deletions don't linger in the artifact.
  guardedRmSync(destDir, { recursive: true, force: true });
  fs.cpSync(srcDir, destDir, { recursive: true });
  pruneLocalDocs(destDir);
  return { destDir, files: countDocsFiles(destDir) };
}

if (import.meta.main) {
  const pkgDir = path.dirname(path.dirname(new URL(import.meta.url).pathname));
  const rootDir = path.dirname(pkgDir);
  const { destDir, files } = syncDocs({ rootDir, pkgDir });
  console.log(`sync-docs: ${files} files → ${path.relative(rootDir, destDir)}`);
}
