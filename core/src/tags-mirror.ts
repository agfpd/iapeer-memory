/**
 * Tags-dictionary mirror decision core — a memoryd subsystem (ADR-004,
 * нюанс 2: the standalone tags-mirror daemon of the reference merges into
 * memoryd; the mirror feeds the Index's per-peer fragment).
 *
 * TS port of the pure core of `scripts/mergemind-tags-mirror.cjs`
 * (behavioural parity against `tests/tags-mirror.test.ts`, 6 fixtures).
 *
 * Why a mirror at all: the dictionary lives in the vault (possibly on
 * iCloud) — reading it directly at prompt-assembly time risks a dataless
 * source → an EMPTY dictionary for the critical curator. The mirror in the
 * local cache namespace is always materialised; the fragment assembly
 * reads the mirror, never the iCloud source.
 */

import type { TaxonomyPreset } from "./taxonomy.js";

export type MirrorDecision = { action: "write" | "skip"; reason: string };

/**
 * Decide whether to overwrite the mirror. No I/O.
 *
 * LOAD-BEARING invariant: NEVER clobber a populated mirror with an empty
 * source — a dataless/broken read must not zero out the working dictionary.
 * Degraded (stale slice) beats empty.
 */
export function decideMirror(args: {
  srcContent: string | null;
  mirrorContent: string | null;
}): MirrorDecision {
  const { srcContent, mirrorContent } = args;
  if (srcContent === null) {
    return { action: "skip", reason: "source-unreadable" };
  }
  if (srcContent.trim() === "") {
    return { action: "skip", reason: "source-empty-keep-mirror" };
  }
  if (mirrorContent !== null && srcContent === mirrorContent) {
    return { action: "skip", reason: "identical" };
  }
  return { action: "write", reason: mirrorContent === null ? "mirror-absent" : "changed" };
}

/** Vault-relative path of the dictionary source for a locale preset. */
export function tagsDictionarySourceRel(taxonomy: TaxonomyPreset): string {
  return `${taxonomy.folders.system}/${taxonomy.systemFiles.tagsDictionary}`;
}
