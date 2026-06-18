/**
 * context-render — doctrine-fragment assembly for iapeer layer 5 (ADR-001).
 *
 * Carries over the LAYER ASSEMBLY from the reference
 * `mergemind-build-context-shards.py::build_layers` (order of layers, the
 * Index branch) and DROPS the entire shard mechanics (est_tokens /
 * pack_shards / write_shards / k-N markers / MAX_SHARDS padding) — per-hook
 * limits do not exist on the system-prompt path; the fragment is delivered
 * whole by the iapeer merge.
 *
 * Changes against the reference assembly, all sanctioned:
 * - the writer guide is NOT a per-peer layer anymore — it is the HOST-WIDE
 *   fragment (`~/.iapeer/fragments/iapeer-memory.md`), written by the
 *   package at install/update, one copy for the whole fleet;
 * - the L2/L3 user-override layers are dropped (нюанс 1): user additions
 *   ride iapeer's own layer 4 (any *.md in the `.iapeer/` roots);
 * - `capText` is kept as a parity utility (it capped L2/L3 in the
 *   reference) but the current assembly has nothing left to cap.
 *
 * Layer-5 writer contract (iapeer 0.2.8):
 * fragment files live in `<root>/.iapeer/fragments/<stem>.md`, the stem is
 * `iapeer-memory.md`, and writes MUST be atomic (temp + rename in the same
 * directory) — the fragment is re-read on every cold-wake and may race a
 * peer waking up.
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { guardedWriteFileSync, guardedUnlinkSync } from "./fs-guard.js";

export const FRAGMENT_STEM = "iapeer-memory.md";

export type ContextLayer = [title: string, body: string];

function readFileOrEmpty(filePath: string): string {
  try {
    return fs.readFileSync(filePath, "utf-8");
  } catch {
    return "";
  }
}

/**
 * Trim text to maxChars at a line boundary, appending a marker when cut.
 * Parity utility (capped the user-override layers in the reference);
 * the marker template takes `{label}` and `{max}` placeholders.
 */
export function capText(
  text: string,
  maxChars: number,
  label: string,
  template = "\n\n_[{label} truncated: over the {max} character limit. Shorten the document.]_",
): string {
  if (text.length <= maxChars) return text;
  let cut = text.lastIndexOf("\n", maxChars);
  if (cut < Math.floor(maxChars / 2)) cut = maxChars;
  const trimmed = text.slice(0, cut).replace(/\s+$/, "");
  return trimmed + template.replace("{label}", label).replace("{max}", String(maxChars));
}

export type FragmentEnv = {
  /** Peer personality (resolved by the caller — нюанс 10). */
  agent: string;
  /** Personality of the Index curator (its branch has a different layout). */
  indexAgent?: string;
  paths: {
    vault: string;
    db?: string;
    config?: string;
    state: string;
    cache: string;
    logs?: string;
  };
  /** Rendered author index file (capped variant), absolute path. */
  authorIndexPath: string;
  /** Compact tags-dictionary projection, absolute path — injected to EVERY
   *  author in lean (§3), not just the Index. */
  tagsProjectionPath?: string;
  /** Layer title for the projection (the dictionary file name, e.g. `Теги.md`);
   *  defaults to the projection file basename. */
  tagsTitle?: string;
};

/**
 * Assemble the per-peer fragment layers in the reference build_layers
 * order: paths → tags-dictionary projection (lean §3: ALL authors now, not
 * only the Index) → author index. The curator gets no writer guide — its
 * contract is the role doctrine; the guide arrives host-wide by layer
 * mechanics. Missing/empty sources are skipped gracefully.
 */
export function buildLayers(env: FragmentEnv): ContextLayer[] {
  const layers: ContextLayer[] = [];

  const p = env.paths;
  const pathsBlock = [
    "<iapeer-memory-paths>",
    `vault: ${p.vault ?? ""}`,
    `db: ${p.db ?? ""}`,
    `config: ${p.config ?? ""}`,
    `state: ${p.state ?? ""}`,
    `cache: ${p.cache ?? ""}`,
    `logs: ${p.logs ?? ""}`,
    "</iapeer-memory-paths>",
  ].join("\n");
  layers.push(["iapeer-memory paths", pathsBlock]);

  if (env.tagsProjectionPath) {
    const tags = readFileOrEmpty(env.tagsProjectionPath);
    if (tags.trim()) {
      layers.push([env.tagsTitle || path.basename(env.tagsProjectionPath), tags]);
    }
  }

  const idx = readFileOrEmpty(env.authorIndexPath);
  if (idx.trim()) layers.push([path.basename(env.authorIndexPath), idx]);

  return layers;
}

/** Render layers into the fragment text: `## title` + body per layer. */
export function renderFragmentText(layers: ContextLayer[]): string {
  const parts: string[] = [];
  for (const [title, body] of layers) {
    parts.push(`## ${title}\n${body.replace(/\s+$/, "")}`);
  }
  return parts.join("\n\n") + (parts.length ? "\n" : "");
}

/**
 * Atomic fragment write — temp + rename IN THE SAME DIRECTORY (layer-5
 * writer contract). Creates the fragments directory when missing.
 */
export function writeFragmentAtomic(
  fragmentsDir: string,
  text: string,
  stem: string = FRAGMENT_STEM,
): string {
  // 0700 — aligned with the iapeer scaffold's fragments/ mode (author's
  // review note, stage 7): peer doctrine material is owner-only.
  fs.mkdirSync(fragmentsDir, { recursive: true, mode: 0o700 });
  const target = path.join(fragmentsDir, stem);
  const tmp = path.join(
    fragmentsDir,
    `.${stem}.${crypto.randomBytes(6).toString("hex")}.tmp`,
  );
  try {
    guardedWriteFileSync(tmp, text, "utf-8");
    fs.renameSync(tmp, target);
  } catch (err) {
    try {
      if (fs.existsSync(tmp)) guardedUnlinkSync(tmp);
    } catch {
      // best effort
    }
    throw err;
  }
  return target;
}

/** `<peerCwd>/.iapeer/fragments/` — the per-peer fragment directory. */
export function peerFragmentsDir(peerCwd: string): string {
  return path.join(peerCwd, ".iapeer", "fragments");
}

/**
 * Render and atomically write the per-peer fragment for one peer.
 * Returns the written path.
 */
export function renderPeerFragment(opts: {
  peerCwd: string;
  env: FragmentEnv;
}): string {
  const text = renderFragmentText(buildLayers(opts.env));
  return writeFragmentAtomic(peerFragmentsDir(opts.peerCwd), text);
}

/**
 * Write the HOST-WIDE guide fragment (`<homeIapeerDir>/fragments/`).
 * The guide content is a package runtime artifact; this function writes
 * whatever it is given. CAUTION: pointing homeIapeerDir at the production
 * `~/.iapeer` reaches EVERY peer of the fleet on their next wakes — the
 * fleet rollout of the guide is a separately sanctioned release step.
 */
export function writeHostWideGuideFragment(
  homeIapeerDir: string,
  guideText: string,
): string {
  return writeFragmentAtomic(path.join(homeIapeerDir, "fragments"), guideText);
}
