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
  type LocaleId,
} from "@agfpd/iapeer-memory-core";
import { IAPEER_BIN, type Egress } from "../egress.js";
import { readFleetMap, writeFleetMap, queryRegistry } from "../fleet.js";
import {
  roleDescription,
  rolePersonality,
  ROLE_NAMES,
  type RoleName,
} from "../templates/index.js";
import { memoryPaths, type MemoryPaths } from "../paths.js";
import { readRolesManifest } from "../roles.js";
import { readSlot, slotProvisionBlocks, writeSlot, SLOT_PROVIDER } from "../slot.js";
import { withProvisionLock, pidAliveProbe } from "../surfaces/lock.js";
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
  unregisterTimer,
  writeDreamGateScript,
  writeLauncherScript,
  WATCHER_TRIGGER_ID,
} from "../watcher.js";
import { paintStatus, ui } from "../ui.js";
import { pidLooksLikeOurs } from "./uninstall.js";
import { guardedUnlinkSync } from "@agfpd/iapeer-memory-core";

/** Heartbeat default is 30s (core memoryd) — 4 missed beats = stale. */
export const DEFAULT_HEARTBEAT_STALE_MS = 120_000;

/**
 * Terminate a HUNG memoryd so the notifier's exit-detection can relaunch it
 * (audit important: the watcher.ts contract «hung silently is covered by our
 * file heartbeat + verify — no gap» was documented but never implemented —
 * repair only PRINTED the stale warning).
 *
 * Escalation is mandatory, not optional: a stale heartbeat under a LIVE
 * process almost certainly means a blocked event loop, and memoryd installs
 * its own SIGTERM handler — a handler that will never run replaced the
 * default disposition, so SIGTERM alone cannot kill the hung daemon.
 * SIGTERM → grace → SIGKILL. The pid file is removed only after CONFIRMED
 * death — losing it while the deadlocked process lives would strand the next
 * repair without a handle. Verified-kill contract holds: the pid's command
 * line is checked (ps) before any signal.
 */
function terminateHungMemoryd(
  egress: Egress,
  pidPath: string,
): { done: boolean; detail: string } {
  let pid = NaN;
  try {
    pid = Number(fs.readFileSync(pidPath, "utf-8").trim());
  } catch {
    return { done: false, detail: "no pid file — cannot signal; manual: iapeer-memory memoryd" };
  }
  if (!Number.isInteger(pid) || pid <= 1 || !pidLooksLikeOurs(egress, pid)) {
    return {
      done: false,
      detail: `pid file does not point at a live memoryd (${pid}) — nothing to terminate; manual: iapeer-memory memoryd`,
    };
  }
  const waitDead = (graceMs: number): boolean => {
    const until = Date.now() + graceMs;
    while (Date.now() < until) {
      if (!pidLooksLikeOurs(egress, pid)) return true;
      Bun.sleepSync(250);
    }
    return !pidLooksLikeOurs(egress, pid);
  };
  egress.kill(pid, "SIGTERM");
  let how = "SIGTERM";
  if (!waitDead(5_000)) {
    egress.kill(pid, "SIGKILL");
    how = "SIGKILL after a 5s SIGTERM grace";
    if (!waitDead(2_000)) {
      return {
        done: false,
        detail: `memoryd (pid ${pid}) survived SIGKILL — pid file kept; inspect manually`,
      };
    }
  }
  try {
    guardedUnlinkSync(pidPath); // only after confirmed death
  } catch {
    // best effort — a stale pid file is harmless (readers check liveness)
  }
  return {
    done: true,
    detail: `hung memoryd (pid ${pid}) terminated via ${how} — the notifier watcher relaunches it`,
  };
}

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
  let localeForRoles: LocaleId | undefined;
  try {
    const config = configFromEnv();
    configOk = true;
    vaultPathForDoctrines = config.vaultPath;
    localeForRoles = config.locale;
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
        pidAlive: pidAliveProbe(egress),
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

  // 2. memoryd heartbeat. Freshness alone is NOT health: the heartbeat keeps
  // ticking while fs.watch is dead (audit critical #6) — memoryd now writes
  // its watch state into the file (`watch=on|off`), and a fresh-but-degraded
  // daemon must FAIL the check, not hide behind a green mtime. A heartbeat
  // without the marker (older daemon during a rolling update) counts as ok.
  try {
    const stat = fs.statSync(paths.heartbeatPath);
    const ageMs = nowMs - stat.mtimeMs;
    if (ageMs > staleMs) {
      if (repair) {
        // The notifier restarts memoryd only on process EXIT (its watchdog is
        // deliberately unarmed) — a hung-but-alive daemon is OUR loop to
        // close: terminate it so exit-detection relaunches with a clean slate.
        const t = terminateHungMemoryd(egress, paths.pidPath);
        results.push({
          name: "memoryd-heartbeat",
          status: t.done ? "repaired" : "fail",
          detail: `stale (${Math.round(ageMs / 1000)}s old) — ${t.detail}`,
        });
      } else {
        results.push({
          name: "memoryd-heartbeat",
          status: "fail",
          detail: `stale (${Math.round(ageMs / 1000)}s old, threshold ${Math.round(staleMs / 1000)}s) — repair terminates the hung daemon: iapeer-memory verify --repair`,
        });
      }
    } else if (fs.readFileSync(paths.heartbeatPath, "utf-8").includes("watch=off")) {
      results.push({
        name: "memoryd-heartbeat",
        status: "fail",
        detail:
          `fresh (${Math.round(ageMs / 1000)}s old) but fs.watch is DOWN — ` +
          "running degraded on polling; restart memoryd to re-arm watch: iapeer-memory memoryd",
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
        // Role OFF: a LEFTOVER timer is a problem, not a skip (audit
        // important, docs-contract): docs/11 promises «verify --repair
        // re-registers the triggers for the new mode», and the dream gate
        // checks only note mtimes — a stale timer would keep waking
        // DreamWeaver against the operator's config. Mirror of update's
        // reconcile branch.
        const stale = readWatcherTrigger({ registrantCwd, id: DREAM_TRIGGER_ID, role: "time" });
        if (!stale) {
          results.push({
            name: "dream-timer",
            status: "skip",
            detail: "not expected (mode: dreamweaver not proactive)",
          });
        } else if (!repair) {
          results.push({
            name: "dream-timer",
            status: "fail",
            detail:
              "role is OFF but the weekly timer is still registered — DreamWeaver would keep waking; repair unregisters it",
          });
        } else if (!registrationRuntime) {
          results.push({
            name: "dream-timer",
            status: "fail",
            detail: "stale timer found, but the index peer runtime is unresolved in the registry — cannot unregister",
          });
        } else {
          const un = unregisterTimer(egress, {
            id: DREAM_TRIGGER_ID,
            runtime: registrationRuntime,
            iapeerBin: opts.iapeerBin,
          });
          results.push({
            name: "dream-timer",
            status: un.ok ? "repaired" : "fail",
            detail: un.ok
              ? "stale weekly timer unregistered (role is OFF)"
              : `stale timer unregister not sent (${un.detail})`,
          });
        }
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
  let manifest: RolesManifest | null = null;
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
      // A crippled doctrine can carry the CURRENT version marker: `render
      // doctrine` used to render {{VAULT_PATH}} as a placeholder while
      // stamping the package version — the marker-only check read it as
      // «ok» forever (audit important). The placeholder text is the tell.
      const hasPlaceholder =
        current !== null && current.includes("<unknown — see IAPEER_MEMORY_VAULT_PATH");
      if (current !== null && rendered === version && !hasPlaceholder) {
        results.push({ name, status: "ok", detail: `v${rendered}` });
        continue;
      }
      const problem =
        current === null
          ? `doctrine missing at ${target}`
          : hasPlaceholder
            ? "doctrine carries the VAULT_PATH placeholder — rendered without a host vault fact"
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

  // 5. role-peer registry descriptions (В36): an EMPTY registry description
  // leaves a role peer nameless in `iapeer list` and every fleet index — a
  // provisioning defect (pre-0.4.17 init created role peers without a
  // description; regen preserved the emptiness). Repair re-asserts the
  // canonical role description via the core's sanctioned re-provision verb
  // (`iapeer create --path <cwd> --description <d>` — В36: updates the local
  // profile AND the registry row; the doctrine is no-clobber). ONLY an empty
  // description is repaired — an operator-tuned one is never overwritten.
  if (manifest === null) {
    results.push({
      name: "role-descriptions",
      status: "skip",
      detail: "roles manifest absent/unreadable — init has not run (see role-doctrines)",
    });
  } else if (localeForRoles === undefined) {
    results.push({
      name: "role-descriptions",
      status: "skip",
      detail: "locale unknown (config check failed) — cannot pick the description locale",
    });
  } else {
    const locale = localeForRoles;
    const roleSet = manifest.roles
      .map((r) => r.role)
      .filter((r): r is RoleName => (ROLE_NAMES as readonly string[]).includes(r));
    const q = queryRegistry(egress, { iapeerBin: opts.iapeerBin });
    if ("error" in q) {
      results.push({
        name: "role-descriptions",
        status: "skip",
        detail: `registry unavailable — ${q.error}`,
      });
    } else {
      const missing: string[] = [];
      const empty: Array<{ role: RoleName; personality: string; cwd: string }> = [];
      for (const role of roleSet) {
        const personality = rolePersonality(role);
        const rec = q.peers.find((p) => p.personality === personality);
        if (!rec) missing.push(personality);
        else if (!rec.description.trim()) empty.push({ role, personality, cwd: rec.cwd });
      }
      if (missing.length > 0) {
        // Creating peers is init's job (runtime detection, degrade, collision
        // guard live there) — verify reports with the recipe, never half-inits.
        results.push({
          name: "role-descriptions",
          status: "fail",
          detail: `role peer(s) absent from the iapeer registry: ${missing.join(", ")} — re-run iapeer-memory init`,
        });
      } else if (empty.length === 0) {
        results.push({
          name: "role-descriptions",
          status: "ok",
          detail: `${roleSet.map((r) => rolePersonality(r)).join(", ")} described`,
        });
      } else if (!repair) {
        results.push({
          name: "role-descriptions",
          status: "fail",
          detail: `empty registry description: ${empty.map((e) => e.personality).join(", ")} — repair re-asserts the role descriptions`,
        });
      } else {
        const failed: string[] = [];
        for (const e of empty) {
          const proc = egress.spawnSync(
            [
              opts.iapeerBin ?? IAPEER_BIN,
              "create",
              e.personality,
              "--path",
              e.cwd,
              "--description",
              roleDescription(locale, e.role),
            ],
            { explicitBin: opts.iapeerBin !== undefined },
          );
          if (proc.refused) failed.push(`${e.personality} (spawn refused — test sandbox)`);
          else if (proc.spawnError) failed.push(`${e.personality} (${proc.spawnError})`);
          else if (proc.exitCode !== 0) {
            failed.push(`${e.personality} (${proc.stderr.trim() || `exit ${proc.exitCode}`})`);
          }
        }
        results.push(
          failed.length > 0
            ? {
                name: "role-descriptions",
                status: "fail",
                detail: `description re-assert failed: ${failed.join("; ")}`,
              }
            : {
                name: "role-descriptions",
                status: "repaired",
                detail: `description re-asserted: ${empty.map((e) => e.personality).join(", ")}`,
              },
        );
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
