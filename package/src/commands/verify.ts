/**
 * `iapeer-memory verify [--repair]` — idempotent self-check of the live
 * surfaces (ADR-010). Cheap by design: any peer's SessionStart health-check
 * may kick it; the system is repaired by whichever peer is alive, never by
 * the Index or the human.
 *
 * Checks (P1 scope — each lights up as its stage lands):
 *   1. config            — the package env context resolves (vault exists);
 *   2. memoryd heartbeat — fresh within the staleness threshold;
 *   3. notifier watcher  — registration alive          [skip until P3 init];
 *   4. role doctrines    — rendered version == package version (ADR-010
 *      marker); `--repair` re-renders from the package templates.
 *
 * The roles manifest (`<state>/roles.json`, written by init) names the
 * roles: `{ "roles": [{ "role", "peerCwd", "template" }] }`. Absent
 * manifest = init has not run — the doctrine check is skipped, not failed.
 *
 * Exit code: 0 — no failures; 1 — at least one check failed (after repair).
 */

import fs from "node:fs";
import path from "node:path";
import {
  configFromEnv,
  renderDoctrine,
  renderedVersion,
  resolveMode,
  curationPlan,
} from "@agfpd/iapeer-memory-core";
import type { Egress } from "../egress.js";
import { readFleetMap, writeFleetMap } from "../fleet.js";
import { memoryPaths, type MemoryPaths } from "../paths.js";
import { readRolesManifest } from "../roles.js";
import { readSlot, slotProvisionBlocks, writeSlot, SLOT_PROVIDER } from "../slot.js";
import { withProvisionLock } from "../surfaces/lock.js";
import { checkFleetSurfaces, sweepProvision } from "../surfaces/sweep.js";
import { mcpPort } from "./provision-peer.js";
import { packageVersion } from "../version.js";
import {
  DREAM_TARGET,
  dreamTimerMessage,
  DEFAULT_EVENT_TARGET,
  DREAM_TRIGGER_ID,
  readWatcherTrigger,
  registerTimer,
  registerWatcher,
  resolveRegistrantRuntime,
  writeDreamGateScript,
  writeLauncherScript,
  WATCHER_TRIGGER_ID,
} from "../watcher.js";
import { paintStatus, ui } from "../ui.js";

/** Heartbeat default is 30s (core memoryd) — 4 missed beats = stale. */
export const DEFAULT_HEARTBEAT_STALE_MS = 120_000;

export type CheckStatus = "ok" | "fail" | "skip" | "repaired";
export type CheckResult = { name: string; status: CheckStatus; detail: string };

export type VerifyOptions = {
  repair?: boolean;
  paths?: MemoryPaths;
  version?: string;
  staleMs?: number;
  /** Injectable for tests. */
  nowMs?: number;
  /** Injectable for tests — repair MUST NOT reach the live notifier. */
  iapeerBin?: string;
};

type RolesManifest = {
  roles: Array<{ role: string; peerCwd: string; template: string }>;
};

export function runVerify(egress: Egress, opts: VerifyOptions = {}): CheckResult[] {
  const repair = opts.repair ?? false;
  const paths = opts.paths ?? memoryPaths();
  const version = opts.version ?? packageVersion();
  const staleMs = opts.staleMs ?? DEFAULT_HEARTBEAT_STALE_MS;
  const nowMs = opts.nowMs ?? Date.now();
  const results: CheckResult[] = [];

  // 1. config / env context
  let configOk = false;
  let vaultPathForDoctrines: string | undefined;
  try {
    const config = configFromEnv();
    configOk = true;
    vaultPathForDoctrines = config.vaultPath;
    results.push({
      name: "config",
      status: "ok",
      detail: `vault ${config.vaultPath} (locale ${config.locale})`,
    });
  } catch (err) {
    results.push({
      name: "config",
      status: "fail",
      detail: `${(err as Error).message} — provision via init (P3) or fill ${paths.configFile}`,
    });
  }

  // 1b. memory-provider slot (iapeer memory-slot contract): a provisioned
  // host must declare the slot; a FOREIGN slot is never repaired over.
  if (!configOk) {
    results.push({
      name: "memory-slot",
      status: "skip",
      detail: "not provisioned (config check failed)",
    });
  } else {
    const slot = readSlot(paths.slotPath);
    const expectedBlocks = slotProvisionBlocks(paths.binaryPath);
    const formOk =
      slot !== null &&
      JSON.stringify(slot.provision) === JSON.stringify(expectedBlocks.provision) &&
      JSON.stringify(slot.unprovision) === JSON.stringify(expectedBlocks.unprovision);
    if (slot && slot.provider !== SLOT_PROVIDER) {
      results.push({
        name: "memory-slot",
        status: "fail",
        detail: `slot held by foreign provider "${slot.provider}" — refusing to touch (uninstall it first)`,
      });
    } else if (slot && slot.version === version && formOk) {
      results.push({
        name: "memory-slot",
        status: "ok",
        detail: `declared v${slot.version}, provision-command in place`,
      });
    } else {
      const problem = slot
        ? slot.version !== version
          ? `slot declares v${slot.version}, package is v${version}`
          : "provision-command block missing/drifted"
        : `slot declaration missing at ${paths.slotPath}`;
      if (!repair) {
        results.push({ name: "memory-slot", status: "fail", detail: problem });
      } else {
        const w = writeSlot({
          slotPath: paths.slotPath,
          version,
          binaryPath: paths.binaryPath,
          heartbeat: paths.heartbeatPath,
        });
        results.push(
          w.action === "refused-foreign"
            ? { name: "memory-slot", status: "fail", detail: `${problem}; repair refused — foreign slot` }
            : { name: "memory-slot", status: "repaired", detail: `${problem} — re-declared v${version}` },
        );
      }
    }
  }

  // 1c. fleet map — memoryd's fragment renderer reads it (docs/05: без
  // карты пиры не получали paths-блок и индекс автора). Repair
  // re-writes from `iapeer list --json` — the self-healing loop for new
  // peers (SessionStart kick → repair → map fresh → memoryd renders the
  // newcomer on the next heartbeat tick).
  if (!configOk) {
    results.push({ name: "fleet-map", status: "skip", detail: "not provisioned (config check failed)" });
  } else {
    let mapPeers = -1; // -1 = unreadable/missing
    try {
      const raw = JSON.parse(fs.readFileSync(paths.fleetMapPath, "utf-8")) as {
        peers?: unknown[];
      };
      mapPeers = Array.isArray(raw?.peers) ? raw.peers.length : -1;
    } catch {
      mapPeers = -1;
    }
    if (mapPeers > 0) {
      results.push({ name: "fleet-map", status: "ok", detail: `${mapPeers} peer(s) in ${paths.fleetMapPath}` });
    } else {
      const problem =
        mapPeers === 0
          ? `fleet map is empty at ${paths.fleetMapPath}`
          : `fleet map missing/unreadable at ${paths.fleetMapPath}`;
      if (!repair) {
        results.push({ name: "fleet-map", status: "fail", detail: problem });
      } else {
        const w = writeFleetMap(egress, { fleetMapPath: paths.fleetMapPath, iapeerBin: opts.iapeerBin });
        results.push(
          w.action === "written"
            ? { name: "fleet-map", status: "repaired", detail: `${problem} — ${w.detail}` }
            : { name: "fleet-map", status: "fail", detail: `${problem}; repair failed — ${w.detail}` },
        );
      }
    }
  }

  // 1d. direct per-peer session surfaces (ADR-009 v1.2) across the fleet
  // map — the self-healing loop for newborns on hosts where the core's
  // birth-hook lagged AND the drift-repair duty (требование №2).
  if (!configOk) {
    results.push({ name: "peer-surfaces", status: "skip", detail: "not provisioned (config check failed)" });
  } else {
    const fleet = readFleetMap(paths.fleetMapPath);
    if (!fleet) {
      results.push({
        name: "peer-surfaces",
        status: "skip",
        detail: "fleet map unreadable — see fleet-map check",
      });
    } else {
      const { checks, skipped } = checkFleetSurfaces(egress, {
        fleet,
        hooksDir: paths.hooksDir,
        port: mcpPort(),
      });
      const bad = checks.filter((c) => !c.ok);
      if (bad.length === 0) {
        results.push({
          name: "peer-surfaces",
          status: "ok",
          detail:
            `${checks.length} peer-runtime(s) in place` +
            (skipped.length ? ` (${skipped.length} skipped: no session runtime / missing cwd)` : ""),
        });
      } else if (!repair) {
        for (const b of bad) {
          results.push({
            name: `peer-surfaces[${b.personality}:${b.runtime}]`,
            status: "fail",
            detail: b.problems.join("; "),
          });
        }
      } else {
        const badPeers = fleet.filter((p) => bad.some((b) => b.cwd === p.cwd));
        const locked = withProvisionLock({
          stateDir: paths.stateDir,
          fn: () => sweepProvision(egress, { fleet: badPeers, hooksDir: paths.hooksDir, port: mcpPort(), iapeerBin: opts.iapeerBin }),
        });
        if (!locked.acquired) {
          results.push({ name: "peer-surfaces", status: "fail", detail: locked.detail });
        } else {
          const stillBad = locked.result.results.filter((r) => !r.ok);
          results.push(
            stillBad.length === 0
              ? {
                  name: "peer-surfaces",
                  status: "repaired",
                  detail: `${bad.length} drifted peer-runtime(s) re-provisioned (${bad
                    .map((b) => `${b.personality}:${b.runtime}`)
                    .join(", ")})`,
                }
              : {
                  name: "peer-surfaces",
                  status: "fail",
                  detail: `repair failed for ${stillBad
                    .map((r) => `${r.personality}:${r.runtime}`)
                    .join(", ")}`,
                },
          );
        }
      }
    }
  }

  // 2. memoryd heartbeat
  try {
    const stat = fs.statSync(paths.heartbeatPath);
    const ageMs = nowMs - stat.mtimeMs;
    if (ageMs > staleMs) {
      results.push({
        name: "memoryd-heartbeat",
        status: "fail",
        detail:
          `stale (${Math.round(ageMs / 1000)}s old, threshold ${Math.round(staleMs / 1000)}s)` +
          (repair
            ? " — restart is the notifier watcher's job (registration lands in P3); manual: iapeer-memory memoryd"
            : ""),
      });
    } else {
      results.push({
        name: "memoryd-heartbeat",
        status: "ok",
        detail: `fresh (${Math.round(ageMs / 1000)}s old)`,
      });
    }
  } catch {
    results.push({
      name: "memoryd-heartbeat",
      status: "fail",
      detail: `no heartbeat at ${paths.heartbeatPath} — memoryd not running?`,
    });
  }

  // 3. notifier wiring (ADR-015). Durable triggers live in the REGISTRANT's
  // peer profile (canonical storage contract): registrant = index — the
  // EVENT trigger (target=scriber, the curation pipeline) and the weekly
  // dream timer (target=dreamweaver). Re-registration is ASYNC (same id =
  // replace) — repair reports "sent", a re-run confirms.
  {
    const manifest = readRolesManifest(paths.rolesManifestPath);
    const indexEntry = manifest?.roles.find((r) => r.role === "index") ?? null;
    if (!indexEntry) {
      for (const name of ["notifier-watcher", "dream-timer"]) {
        results.push({
          name,
          status: "skip",
          detail: "roles manifest has no index peer — init has not run",
        });
      }
    } else {
      const registrantCwd = indexEntry.peerCwd;
      // The trigger owner identity's runtime is the index peer's DECLARED runtime
      // (registry `default_runtime`), never a hardcoded "claude" — a codex role
      // peer registers as codex-index. Null → repair cannot register (reported).
      const registrationRuntime = resolveRegistrantRuntime(egress, { iapeerBin: opts.iapeerBin });
      // Mode-aware expectation (lean §7): the WATCHER always exists (it launches
      // memoryd) — its target is the §7.1 conditional. The DREAM timer is
      // checked ONLY when its role is proactive; otherwise verify reports a
      // SKIP (it should not exist — update reconciles any stale one).
      const plan = curationPlan(resolveMode(process.env).roles);
      const expectedEventTarget = plan.eventTarget ?? DEFAULT_EVENT_TARGET;
      const checks: Array<{
        name: string;
        id: string;
        role: "event" | "time";
        expect: (t: NonNullable<ReturnType<typeof readWatcherTrigger>>) => string | null;
        repairSend: () => { ok: boolean; detail: string };
      }> = [
        {
          name: "notifier-watcher",
          id: WATCHER_TRIGGER_ID,
          role: "event",
          expect: (t) =>
            t.script !== paths.launcherPath
              ? `script is ${t.script}, expected ${paths.launcherPath}`
              : t.target !== expectedEventTarget
                ? `target is ${t.target ?? "?"}, expected ${expectedEventTarget}`
                : null,
          repairSend: () => {
            if (!registrationRuntime) {
              return { ok: false, detail: "index peer runtime unresolved in the registry — cannot register the trigger" };
            }
            writeLauncherScript({
              launcherPath: paths.launcherPath,
              binaryPath: paths.binaryPath,
            });
            return registerWatcher(egress, {
              launcherPath: paths.launcherPath,
              target: plan.eventTarget ?? undefined,
              runtime: registrationRuntime,
              iapeerBin: opts.iapeerBin,
            });
          },
        },
      ];
      if (plan.dream) {
        checks.push({
          name: "dream-timer",
          id: DREAM_TRIGGER_ID,
          role: "time",
          expect: (t) =>
            t.target !== DREAM_TARGET
              ? `target is ${t.target ?? "?"}, expected ${DREAM_TARGET}`
              : (t as { check?: string }).check !== paths.dreamGateScriptPath
                ? `check is ${(t as { check?: string }).check ?? "?"}, expected ${paths.dreamGateScriptPath}`
                : null,
          repairSend: () => {
            if (!registrationRuntime) {
              return { ok: false, detail: "index peer runtime unresolved in the registry — cannot register the trigger" };
            }
            writeDreamGateScript({
              dreamGateScriptPath: paths.dreamGateScriptPath,
              binaryPath: paths.binaryPath,
            });
            return registerTimer(egress, {
              message: dreamTimerMessage({
                cron: process.env.IAPEER_MEMORY_DREAM_CRON,
                dreamGateScriptPath: paths.dreamGateScriptPath,
              }),
              runtime: registrationRuntime,
              iapeerBin: opts.iapeerBin,
            });
          },
        });
      } else {
        results.push({
          name: "dream-timer",
          status: "skip",
          detail: "not expected (mode: dreamweaver not proactive)",
        });
      }
      for (const c of checks) {
        const trigger = readWatcherTrigger({ registrantCwd, id: c.id, role: c.role });
        const problem = trigger
          ? c.expect(trigger)
          : `no ${c.id} trigger in ${registrantCwd}/.iapeer/peer-profile.json`;
        if (problem === null) {
          results.push({
            name: c.name,
            status: "ok",
            detail: `trigger ${c.id} in index profile → target ${trigger!.target ?? "?"}`,
          });
          continue;
        }
        if (!repair) {
          results.push({ name: c.name, status: "fail", detail: problem });
          continue;
        }
        const sent = c.repairSend();
        results.push(
          sent.ok
            ? {
                name: c.name,
                status: "repaired",
                detail: `${problem} — re-registration sent (async; re-run verify to confirm)`,
              }
            : {
                name: c.name,
                status: "fail",
                detail: `${problem}; re-registration failed — ${sent.detail}`,
              },
        );
      }
    }
  }

  // 4. role doctrine versions (ADR-010 marker)
  let manifestRaw: string | null = null;
  try {
    manifestRaw = fs.readFileSync(paths.rolesManifestPath, "utf-8");
  } catch {
    manifestRaw = null;
  }
  if (manifestRaw === null) {
    results.push({
      name: "role-doctrines",
      status: "skip",
      detail: `roles manifest absent (${paths.rolesManifestPath}) — init has not run`,
    });
  } else {
    let manifest: RolesManifest | null = null;
    try {
      const parsed = JSON.parse(manifestRaw) as RolesManifest;
      if (!Array.isArray(parsed.roles)) throw new Error("no roles array");
      manifest = parsed;
    } catch (err) {
      results.push({
        name: "role-doctrines",
        status: "fail",
        detail: `roles manifest unreadable: ${(err as Error).message}`,
      });
    }
    for (const entry of manifest?.roles ?? []) {
      const name = `doctrine[${entry.role}]`;
      const target = path.join(entry.peerCwd, ".iapeer", "IAPEER.md");
      let current: string | null = null;
      try {
        current = fs.readFileSync(target, "utf-8");
      } catch {
        current = null;
      }
      const rendered = current === null ? null : renderedVersion(current);
      if (current !== null && rendered === version) {
        results.push({ name, status: "ok", detail: `v${rendered}` });
        continue;
      }
      const problem =
        current === null
          ? `doctrine missing at ${target}`
          : rendered === null
            ? "no version marker in rendered doctrine"
            : `v${rendered} != package v${version}`;
      if (!repair) {
        results.push({ name, status: "fail", detail: problem });
        continue;
      }
      const outcome = renderDoctrine({
        templatePath: entry.template,
        peerCwd: entry.peerCwd,
        version,
        vaultPath: vaultPathForDoctrines,
      });
      if (outcome.action === "missing-template") {
        results.push({
          name,
          status: "fail",
          detail: `${problem}; repair failed — template missing at ${entry.template}`,
        });
      } else {
        results.push({
          name,
          status: "repaired",
          detail: `${problem} — re-rendered to v${version}`,
        });
      }
    }
  }

  return results;
}

export function cmdVerify(argv: string[], egress: Egress): number {
  let repair = false;
  let iapeerBin: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--repair") repair = true;
    // Mirror of `update --iapeer-bin` (fb662ed): the hermetic CLI test class
    // needs an explicitly named core binary — the egress explicit-bin
    // allowance keys on it.
    else if (a === "--iapeer-bin") iapeerBin = argv[++i];
    else {
      console.error(`iapeer-memory verify: unknown flag: ${a}`);
      return 2;
    }
  }

  const results = runVerify(egress, { repair, iapeerBin });
  const width = Math.max(...results.map((r) => r.name.length));
  for (const r of results) {
    const mark =
      r.status === "ok" ? paintStatus("ok", "ok      ") :
      r.status === "repaired" ? paintStatus("ok", "repaired") :
      r.status === "skip" ? paintStatus("skip", "skip    ") : paintStatus("fail", "FAIL    ");
    const detail = r.status === "fail" ? r.detail : ui.dim(r.detail);
    console.log(`${mark} ${r.name.padEnd(width)}  ${detail}`);
  }
  return results.some((r) => r.status === "fail") ? 1 : 0;
}
