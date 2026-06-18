/**
 * Roles manifest — the init→verify bridge (`<state>/roles.json`):
 * which role peers exist, where their cwd is, which template renders their
 * doctrine. init writes it after `iapeer create`; verify reads it to
 * compare rendered doctrine versions against the package (ADR-010) and
 * `--repair` re-renders from the referenced templates.
 *
 * Role peer location: the CORE'S DEFAULT (`iapeer create` without
 * `--path` → its documented default peers folder). Host-specific layouts
 * must never leak into the product (by requirement).
 */

import fs from "node:fs";
import path from "node:path";
import { guardedWriteFileSync } from "@agfpd/iapeer-memory-core";

export type RoleEntry = { role: string; peerCwd: string; template: string };

export type RolesManifest = { roles: RoleEntry[] };

export function writeRolesManifest(opts: {
  rolesManifestPath: string;
  roles: RoleEntry[];
}): void {
  fs.mkdirSync(path.dirname(opts.rolesManifestPath), { recursive: true });
  const tmp = `${opts.rolesManifestPath}.tmp`;
  guardedWriteFileSync(
    tmp,
    JSON.stringify({ roles: opts.roles } satisfies RolesManifest, null, 2) + "\n",
    "utf-8",
  );
  fs.renameSync(tmp, opts.rolesManifestPath);
}

/** Never throws: absent/malformed → null (verify treats it as "init has not run"). */
export function readRolesManifest(rolesManifestPath: string): RolesManifest | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(rolesManifestPath, "utf-8")) as RolesManifest;
    if (!Array.isArray(parsed.roles)) return null;
    return parsed;
  } catch {
    return null;
  }
}
