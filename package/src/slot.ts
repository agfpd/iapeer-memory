/**
 * Memory-provider slot declaration — the iapeer memory-slot contract (FINAL
 * base, iapeer docs fc68c54/e2195a7/c968219; v1.2 revision).
 * The slot file tells the core that the three public surfaces (layer-5
 * fragments / MCP tools / daemon under a notifier watcher) are occupied:
 *
 * - the PROVIDER writes and removes the file (our init/uninstall), atomic
 *   temp+rename; the core only reads it (absent/unreadable = empty slot);
 * - a slot held by a FOREIGN provider is never touched — explicit refusal
 *   (mirror of the core's own init-step refusal);
 * - `version` = the package version (the same single source as the doctrine
 *   marker, ADR-010); our `update` re-writes it (P4 obligation);
 * - `heartbeat` (optional) = the absolute path whose mtime memoryd touches —
 *   the core may show staleness in `iapeer status`, never acts on it;
 * - `provision`/`unprovision` (v1.2, ADR-009 v1.2 — the birth-joint
 *   inversion, schema fixed with the core): the PROVIDER's OWN command
 *   the core shells into at peer birth / verb sweeps / peer removal. The
 *   core never learns the surface forms; placeholders {cwd} {runtime}
 *   {personality} {occasion} substitute PER-ARGUMENT (argv spawn, no shell,
 *   120s timeout, best-effort + loud warn; no runtime fallback).
 *
 * The v1.1 marketplace-plugin channel is fully gone (ADR-017): the foundation
 * no longer reads or writes a `plugin` slot block (its v1.1 parser is a
 * tombstone), and this package no longer carries the field. Migrating a
 * pre-v1.2 host is a documented manual step (uninstall + re-init) — see
 * docs/10-iapeer-integration.md.
 */

import fs from "node:fs";
import path from "node:path";
import {
  guardedWriteFileSync,
  guardedUnlinkSync,
  sandboxBlocksProdRead,
} from "@agfpd/iapeer-memory-core";

export const SLOT_PROVIDER = "iapeer-memory";
export const SLOT_PACKAGE = "@agfpd/iapeer-memory";

/** v1.2 provision command block — argv form (§7 req 1: per-argument
 *  placeholder substitution, spawn without a shell). */
export type MemoryProviderCommand = {
  /** Absolute path (§7 req 2: birth-hooks live in a minimal launchd PATH). */
  command: string;
  args: string[];
};

/** The provision/unprovision blocks of OUR slot — built around the stable
 *  installed binary (the same path the hooks/watcher rely on). */
export function slotProvisionBlocks(binaryPath: string): {
  provision: MemoryProviderCommand;
  unprovision: MemoryProviderCommand;
} {
  return {
    provision: {
      command: binaryPath,
      args: [
        "provision-peer",
        "--cwd", "{cwd}",
        "--runtime", "{runtime}",
        "--personality", "{personality}",
        "--occasion", "{occasion}",
      ],
    },
    unprovision: {
      command: binaryPath,
      args: [
        "unprovision-peer",
        "--cwd", "{cwd}",
        "--runtime", "{runtime}",
        "--occasion", "{occasion}",
      ],
    },
  };
}

export type MemoryProviderSlot = {
  provider: string;
  package: string;
  version: string;
  registeredAt: string;
  heartbeat?: string;
  /** v1.2 (ADR-009 v1.2). */
  provision?: MemoryProviderCommand;
  unprovision?: MemoryProviderCommand;
};

/** Never throws: missing / unreadable / malformed → null (empty slot). */
export function readSlot(slotPath: string): MemoryProviderSlot | null {
  // Read-as-egress (И4 parity): the PROD slot gates fleet-wide sweeps
  // («slot is ours» is TRUE on the live host) — a sandboxed process must
  // read it as absent and refuse/skip honestly.
  if (sandboxBlocksProdRead(slotPath)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(slotPath, "utf-8")) as MemoryProviderSlot;
    if (!parsed || typeof parsed.provider !== "string") return null;
    return parsed;
  } catch {
    return null;
  }
}

export type SlotWriteResult = {
  action: "written" | "identical" | "refused-foreign";
  existing: MemoryProviderSlot | null;
};

export function writeSlot(opts: {
  slotPath: string;
  version: string;
  /** Absolute path of the installed binary — the provision command carrier. */
  binaryPath: string;
  heartbeat?: string;
  /** Injectable for tests. */
  nowIso?: string;
}): SlotWriteResult {
  const existing = readSlot(opts.slotPath);
  if (existing && existing.provider !== SLOT_PROVIDER) {
    return { action: "refused-foreign", existing };
  }
  const blocks = slotProvisionBlocks(opts.binaryPath);
  if (
    existing &&
    existing.version === opts.version &&
    existing.heartbeat === opts.heartbeat &&
    existing.package === SLOT_PACKAGE &&
    JSON.stringify(existing.provision) === JSON.stringify(blocks.provision) &&
    JSON.stringify(existing.unprovision) === JSON.stringify(blocks.unprovision)
  ) {
    return { action: "identical", existing }; // idempotent re-init: no churn
  }
  const slot: MemoryProviderSlot = {
    provider: SLOT_PROVIDER,
    package: SLOT_PACKAGE,
    version: opts.version,
    registeredAt: opts.nowIso ?? new Date().toISOString(),
    ...(opts.heartbeat ? { heartbeat: opts.heartbeat } : {}),
    ...blocks,
  };
  fs.mkdirSync(path.dirname(opts.slotPath), { recursive: true });
  const tmp = `${opts.slotPath}.tmp`;
  guardedWriteFileSync(tmp, JSON.stringify(slot, null, 2) + "\n", "utf-8");
  fs.renameSync(tmp, opts.slotPath);
  return { action: "written", existing };
}

export type SlotRemoveResult = "removed" | "absent" | "refused-foreign";

/** Uninstall removes ONLY our own declaration; a foreign slot is left intact. */
export function removeSlot(slotPath: string): SlotRemoveResult {
  const existing = readSlot(slotPath);
  if (!existing) return "absent";
  if (existing.provider !== SLOT_PROVIDER) return "refused-foreign";
  guardedUnlinkSync(slotPath);
  return "removed";
}
