/**
 * `npm run release:pack` (after `npm version`) — cut a CI-publishable
 * release CANDIDATE without publishing anything:
 *
 *   1. lockstep check: facade version == core version == exact core pin;
 *   2. commit `<V>` + annotated tag `v<V>` (npm version skips git in a
 *      workspace subdir — CLAUDE.md §Релиз);
 *   3. `npm pack` both packages into `dist/release/<V>/` and verify each
 *      archive's name / version / repository.url;
 *   4. sha256 of both archives → `SHA256SUMS`;
 *   5. push commit + tag, create the GitHub Release `v<V>` with both
 *      archives as assets.
 *
 * Publishing is the PM's act: `.github/workflows/publish.yml` is dispatched
 * with the tag and the two ACCEPTED hashes and publishes exactly these
 * bytes. Nothing here talks to the npm registry.
 */

import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { guardedRmSync, guardedWriteFileSync } from "@agfpd/iapeer-memory-core";

const PKG_DIR = path.dirname(import.meta.dir); // package/
const ROOT = path.dirname(PKG_DIR);
const REPO_URL = "git+https://github.com/agfpd/iapeer-memory.git";
const CORE = "@agfpd/iapeer-memory-core";
const FACADE = "@agfpd/iapeer-memory";

function run(cmd: string, args: string[], cwd = ROOT): string {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf-8" });
  if (r.status !== 0) {
    throw new Error(`${cmd} ${args.join(" ")} failed (${r.status}): ${(r.stderr || r.stdout || "").trim()}`);
  }
  return r.stdout.trim();
}

function manifest(rel: string): Record<string, any> {
  return JSON.parse(fs.readFileSync(path.join(ROOT, rel), "utf-8"));
}

export function archiveName(pkg: string, version: string): string {
  return `${pkg.replace(/^@/, "").replace("/", "-")}-${version}.tgz`;
}

function checkArchive(tgz: string, name: string, version: string): void {
  const meta = JSON.parse(run("tar", ["-xzOf", tgz, "package/package.json"]));
  const repo = typeof meta.repository === "string" ? meta.repository : meta.repository?.url;
  if (meta.name !== name) throw new Error(`${tgz}: name ${meta.name} != ${name}`);
  if (meta.version !== version) throw new Error(`${tgz}: version ${meta.version} != ${version}`);
  if (repo !== REPO_URL) throw new Error(`${tgz}: repository.url ${repo} != ${REPO_URL} (provenance would be off)`);
}

function sha256(file: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

export function main(): void {
  const facade = manifest("package/package.json");
  const core = manifest("core/package.json");
  const v: string = facade.version;
  if (core.version !== v) throw new Error(`core ${core.version} != facade ${v}`);
  if (facade.dependencies?.[CORE] !== v) throw new Error(`facade pins core ${facade.dependencies?.[CORE]}, expected exact ${v}`);
  const tag = `v${v}`;

  run("git", ["commit", "-m", v]);
  run("git", ["tag", "-a", tag, "-m", v]);

  const out = path.join(ROOT, "dist", "release", v);
  guardedRmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });
  run("npm", ["pack", "--pack-destination", out], path.join(ROOT, "core"));
  run("npm", ["pack", "--pack-destination", out], PKG_DIR);
  const coreTgz = path.join(out, archiveName(CORE, v));
  const facadeTgz = path.join(out, archiveName(FACADE, v));
  checkArchive(coreTgz, CORE, v);
  checkArchive(facadeTgz, FACADE, v);
  // prepack materialises LICENSE copies (gitignored) — the tree must stay clean.
  const dirty = run("git", ["status", "--porcelain"]);
  if (dirty) throw new Error(`pack dirtied the tree:\n${dirty}`);

  const coreSha = sha256(coreTgz);
  const facadeSha = sha256(facadeTgz);
  guardedWriteFileSync(
    path.join(out, "SHA256SUMS"),
    `${coreSha}  ${path.basename(coreTgz)}\n${facadeSha}  ${path.basename(facadeTgz)}\n`,
  );

  run("git", ["push", "origin", "HEAD", "--follow-tags"]);
  run("gh", [
    "release", "create", tag, coreTgz, facadeTgz, path.join(out, "SHA256SUMS"),
    "--title", tag,
    "--notes", `Release candidate ${v}. Publish only via publish.yml dispatch with the PM-accepted hashes.`,
  ]);

  console.log(`release candidate ${tag} — NOT published`);
  console.log(`  ${path.basename(coreTgz)}  sha256 ${coreSha}`);
  console.log(`  ${path.basename(facadeTgz)}  sha256 ${facadeSha}`);
  console.log(`  local: ${out}`);
  console.log(`publish (PM, after acceptance):`);
  console.log(`  gh workflow run publish.yml --ref main -f tag=${tag} -f core_sha256=${coreSha} -f facade_sha256=${facadeSha}`);
}

if (import.meta.main) main();
