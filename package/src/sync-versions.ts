/**
 * Manifest version sync (docs/10 §Версионная синхронизация): propagate the
 * facade `package/package.json` version into every other manifest of the
 * monorepo — `core/package.json` (the adapter plugin manifests left with
 * the plugin channel, ADR-017). Wired into the npm `version` lifecycle,
 * runnable standalone:
 *
 *     bun src/sync-versions.ts
 *
 * Missing manifests are reported and skipped. The reference
 * sync-plugin-version pattern, generalised to N manifests.
 */

import fs from "node:fs";
import path from "node:path";
import { guardedWriteFileSync } from "@agfpd/iapeer-memory-core";

export type SyncOutcome = { file: string; action: "updated" | "identical" | "missing" };

/** Relative (to the monorepo root) manifests that must carry one version. */
export const SYNC_TARGETS = ["core/package.json"] as const;

export function syncVersions(opts: {
  rootDir: string;
  version: string;
  targets?: readonly string[];
}): SyncOutcome[] {
  const targets = opts.targets ?? SYNC_TARGETS;
  const outcomes: SyncOutcome[] = [];
  for (const rel of targets) {
    const file = path.join(opts.rootDir, rel);
    let raw: string;
    try {
      raw = fs.readFileSync(file, "utf-8");
    } catch {
      outcomes.push({ file: rel, action: "missing" });
      continue;
    }
    const manifest = JSON.parse(raw) as Record<string, unknown>;
    if (manifest.version === opts.version) {
      outcomes.push({ file: rel, action: "identical" });
      continue;
    }
    manifest.version = opts.version;
    // 2-space indent + trailing newline — the repo's manifest style.
    guardedWriteFileSync(file, JSON.stringify(manifest, null, 2) + "\n", "utf-8");
    outcomes.push({ file: rel, action: "updated" });
  }
  return outcomes;
}

/**
 * The facade's dependency on the core is an EXACT version pin kept in
 * lockstep by this script (release decision: two npm packages, one shared
 * version). `npm publish` ships the manifest verbatim — it does NOT
 * rewrite the `workspace:*` protocol (only bun/pnpm publish do), so the
 * pin on disk is the published truth. Locally the exact pin still resolves
 * to the workspace copy: bun matches workspace packages against semver
 * ranges, and syncVersions keeps core/package.json at the same version.
 */
export function syncCoreDependencyPin(opts: {
  packageManifestPath: string;
  version: string;
}): SyncOutcome {
  const rel = path.basename(opts.packageManifestPath);
  let raw: string;
  try {
    raw = fs.readFileSync(opts.packageManifestPath, "utf-8");
  } catch {
    return { file: rel, action: "missing" };
  }
  const manifest = JSON.parse(raw) as {
    dependencies?: Record<string, string>;
  };
  const deps = manifest.dependencies ?? {};
  if (deps["@agfpd/iapeer-memory-core"] === opts.version) {
    return { file: rel, action: "identical" };
  }
  deps["@agfpd/iapeer-memory-core"] = opts.version;
  manifest.dependencies = deps;
  guardedWriteFileSync(
    opts.packageManifestPath,
    JSON.stringify(manifest, null, 2) + "\n",
    "utf-8",
  );
  return { file: rel, action: "updated" };
}

if (import.meta.main) {
  const pkgDir = path.dirname(path.dirname(new URL(import.meta.url).pathname));
  const pkg = JSON.parse(
    fs.readFileSync(path.join(pkgDir, "package.json"), "utf-8"),
  ) as { version: string };
  const outcomes = syncVersions({
    rootDir: path.dirname(pkgDir),
    version: pkg.version,
  });
  outcomes.push(
    syncCoreDependencyPin({
      packageManifestPath: path.join(pkgDir, "package.json"),
      version: pkg.version,
    }),
  );
  for (const o of outcomes) {
    console.log(`sync-versions: ${o.action.padEnd(9)} ${o.file}`);
  }
}
