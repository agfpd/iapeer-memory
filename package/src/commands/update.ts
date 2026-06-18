/**
 * `iapeer-memory update` — one command, every surface, deterministic
 * (ADR-010; closes the «daemon running a deleted snapshot» defect class).
 *
 * Run from SOURCE (`npx @agfpd/iapeer-memory@latest update`): the fresh
 * npx snapshot recompiles the stable binary; everything downstream follows
 * the new code. Surfaces, in order:
 *
 *   1. binary     — recompile `~/.local/bin/iapeer-memory` (from the
 *                   installed binary itself: honest skip + npx hint);
 *   2. templates  — re-materialise (package-owned, bytes-compare);
 *   3. doctrines  — re-render every role from the roles manifest with the
 *                   fresh version marker; roles pick it up on their next
 *                   cold wake (ADR-007), no restarts;
 *   4. fleet      — re-write the fleet map from `iapeer list --json`;
 *   5. surfaces   — direct per-peer session surfaces sweep over the map
 *                   (ADR-009 v1.2: the «всё на местах у подключённых пиров»
 *                   duty — both runtimes, idempotent, repairs drift);
 *   6. plugin-off — v1.1→v1.2 migration: a slot still carrying a plugin
 *                   block gets the MANUAL removal recipe (the plugin
 *                   channel is removed, ADR-017) — the slot migrates only
 *                   after surfaces landed cleanly;
 *   7. slot       — re-declare in the v1.2 form (provision command blocks,
 *                   new version — contract obligation);
 *   8. launcher + triggers + guide — regenerate;
 *   9. memoryd    — MANAGED restart: verified SIGTERM via the pid file →
 *                   the notifier watcher relaunches through the launcher
 *                   with the NEW binary. Not running → nothing to do.
 *
 * Idempotent: same version re-run → identical/no-op on every surface.
 */

import fs from "node:fs";
import path from "node:path";
import {
  configFromEnv,
  isLocaleId,
  renderDoctrine,
  resolveMode,
  curationPlan,
  writeHostWideGuideFragment,
  type LocaleId,
} from "@agfpd/iapeer-memory-core";
import { installBinary } from "../binary.js";
import type { Egress } from "../egress.js";
import { readFleetMap, writeFleetMap } from "../fleet.js";
import { memoryPaths } from "../paths.js";
import { readRolesManifest } from "../roles.js";
import { readSlot, writeSlot, SLOT_PROVIDER } from "../slot.js";
import { withProvisionLock } from "../surfaces/lock.js";
import { sweepProvision } from "../surfaces/sweep.js";
import { mcpPort } from "./provision-peer.js";
import { guideText, guideTemplatePath, materialiseTemplates } from "../templates/index.js";
import { packageDocsDir, scaffoldHostDocs } from "../host-docs.js";
import { packageVersion } from "../version.js";
import {
  DREAM_TARGET,
  DREAM_TRIGGER_ID,
  LEGACY_SWEEP_TRIGGER_ID,
  dreamTimerMessage,
  patchWakePolicyEphemeral,
  registerTimer,
  registerWatcher,
  resolveRegistrantRuntime,
  unregisterTimer,
  writeDreamGateScript,
  writeLauncherScript,
} from "../watcher.js";
import { paintStatus, ui } from "../ui.js";
import { stopMemorydByPidFile } from "./uninstall.js";

/** A non-forcing operator hint, emitted when this update rewrote the host-wide
 *  guide. Ephemeral peers (memory curators) pick the new doctrine up on their
 *  next wake automatically; live telegram-fronted peers RESUME the OLD system
 *  prompt until their session turns over (iapeer resolveWakeMode: human-
 *  conversational resume-on-park). `iapeer refresh --all` arms a lazy fresh-on-
 *  next-wake for the fleet. Auto-refresh is DELIBERATELY not wired:
 *  refresh is a conscious operator step — update runs on every self-
 *  update, not every one changes doctrine. Returns null when the guide was
 *  unchanged (roles-only changes touch only the self-refreshing curators). */
export function fleetRefreshHint(writtenTemplatePaths: string[], guidePath: string): string | null {
  if (!writtenTemplatePaths.includes(guidePath)) return null;
  return (
    "[hint] the host-wide guide changed this update. Ephemeral peers (memory curators) pick it up " +
    "automatically; live telegram-fronted peers keep the OLD doctrine until their session turns over. " +
    "Land it fleet-wide on the next natural wake (lazy — no kill, no burst): iapeer refresh --all"
  );
}

export function cmdUpdate(argv: string[], egress: Egress): number {
  let skipBinary = false;
  let iapeerBin: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--skip-binary") skipBinary = true;
    else if (a === "--iapeer-bin") iapeerBin = argv[++i];
    else {
      console.error(`iapeer-memory update: unknown flag: ${a}`);
      return 2;
    }
  }

  const paths = memoryPaths();
  const version = packageVersion();
  const localeRaw = process.env.IAPEER_MEMORY_LOCALE || "en";
  if (!isLocaleId(localeRaw)) {
    console.error(`iapeer-memory update: unknown locale "${localeRaw}"`);
    return 2;
  }
  const locale: LocaleId = localeRaw;
  let failures = 0;
  const step = (name: string, detail: string, ok = true): void => {
    if (!ok) failures++;
    const token = paintStatus(ok ? "ok" : "fail", ok ? "ok  " : "FAIL");
    console.log(`${token}  ${name.padEnd(10)}  ${ok ? ui.dim(detail) : detail}`);
  };

  console.log(`iapeer-memory update → v${version}`);

  // 1. binary
  if (skipBinary) {
    step("binary", "skipped (--skip-binary)");
  } else {
    const bin = installBinary(egress, { outPath: paths.binaryPath });
    step(
      "binary",
      bin.action === "compiled"
        ? `recompiled ${bin.outPath} (${Math.round(bin.bytes / 1024 / 1024)}MB; signing: ${bin.signing.state}` +
          `${bin.signing.state === "failed-soft" ? ` — ${bin.signing.detail}` : ""})`
        : bin.action === "skipped-compiled"
          ? "running FROM the installed binary — recompile via: npx @agfpd/iapeer-memory@latest update"
          : `compile failed — ${bin.detail}`,
      bin.action !== "failed",
    );
  }

  // 2. templates (package-owned)
  const tmpl = materialiseTemplates({ templatesDir: paths.templatesDir, locale });
  step("templates", `${tmpl.written.length} written, ${tmpl.identical.length} identical`);
  // Non-forcing fleet-refresh nudge: did the host-wide GUIDE change this run?
  const refreshHint = fleetRefreshHint(tmpl.written, guideTemplatePath(paths.templatesDir, locale));

  // 3. role doctrines (version marker follows the package — ADR-010).
  // vaultPath feeds the {{VAULT_PATH}} doctrine substitution (host fact).
  let vaultPathForDoctrines: string | undefined;
  try {
    vaultPathForDoctrines = configFromEnv().vaultPath;
  } catch {
    vaultPathForDoctrines = undefined; // unprovisioned env — placeholder fallback
  }
  const manifest = readRolesManifest(paths.rolesManifestPath);
  if (!manifest || manifest.roles.length === 0) {
    step("doctrines", "no roles manifest — init has not run (nothing to re-render)");
  } else {
    const outcomes = manifest.roles.map((r) => ({
      role: r.role,
      ...renderDoctrine({ templatePath: r.template, peerCwd: r.peerCwd, version, vaultPath: vaultPathForDoctrines }),
    }));
    const missing = outcomes.filter((o) => o.action === "missing-template");
    step(
      "doctrines",
      outcomes
        .map((o) => `${o.role}: ${o.action}`)
        .join(", ") + ` (v${version}; roles pick it up on next cold wake)`,
      missing.length === 0,
    );
    // wake_policy: all curators are tick-stateless ephemeral workers — a
    // PERSISTENT session accumulates a stale model after a deploy (the migration
    // class an ephemeral flip kills). Re-assert ephemeral on every update
    // (no-clobber, idempotent — "identical" when already set).
    const wp = manifest.roles.map((r) => `${r.role}:${patchWakePolicyEphemeral(r.peerCwd)}`);
    const wpMissing = wp.filter((w) => w.endsWith("missing-profile")).length;
    step(
      "wake_policy",
      `${wp.join(" ")} (ephemeral — fresh session per wake)` +
        (wpMissing ? ` — ${wpMissing} profile(s) not yet born (peer birth creates them)` : ""),
      true, // best-effort reconciliation; a missing peer profile is a birth concern, never an update failure
    );
  }

  // 4. fleet map — personality → cwd × runtimes (the joint of the surfaces
  // sweep below AND memoryd's fragment renderer, docs/05). BEFORE surfaces
  // and BEFORE the memoryd restart: both consume the fresh map.
  {
    const fleet = writeFleetMap(egress, { fleetMapPath: paths.fleetMapPath, iapeerBin });
    step(
      "fleet",
      fleet.action === "written"
        ? fleet.detail
        : `fleet map not written (${fleet.detail}) — surfaces sweep runs on the LAST map; fragments stay stale until verify --repair`,
      fleet.action === "written",
    );
  }

  // 5. direct session surfaces sweep (ADR-009 v1.2) — the update duty:
  // «всё на местах у подключённых пиров, что codex, что claude».
  const existingSlot = readSlot(paths.slotPath);
  const slotForeign = existingSlot !== null && existingSlot.provider !== SLOT_PROVIDER;
  let surfacesOk = false;
  if (slotForeign) {
    step("surfaces", "skipped (foreign slot — not our host)");
  } else {
    const fleet = readFleetMap(paths.fleetMapPath) ?? [];
    const locked = withProvisionLock({
      stateDir: paths.stateDir,
      fn: () => sweepProvision(egress, { fleet, hooksDir: paths.hooksDir, port: mcpPort(), iapeerBin }),
    });
    if (!locked.acquired) {
      step("surfaces", locked.detail, false);
    } else {
      const { results, skipped } = locked.result;
      const failed = results.filter((r) => !r.ok);
      surfacesOk = failed.length === 0;
      step(
        "surfaces",
        `${results.length - failed.length}/${results.length} peer-runtime(s) in place` +
          (skipped.length ? `, ${skipped.length} skipped` : "") +
          " — live sessions pick changes up on next restart",
        surfacesOk,
      );
      for (const f of failed) {
        console.log(
          `      surfaces    FAIL ${f.personality}:${f.runtime} — ${f.outcomes
            .filter((o) => o.action === "failed")
            .map((o) => `${o.surface}: ${o.detail ?? "failed"}`)
            .join("; ")}`,
        );
      }
    }
  }

  // 6. v1.1 → v1.2 migration (one-shot per host): the plugin channel is
  // REMOVED (ADR-017) — no core verb is shelled; a v1.1 host gets the
  // manual recipe and the slot migrates ONLY after the direct surfaces
  // landed cleanly (never strand a host with neither channel).
  let migrationBlocked = false;
  if (!slotForeign && existingSlot?.plugin) {
    if (!surfacesOk) {
      migrationBlocked = true;
      step(
        "plugin-off",
        "POSTPONED: direct surfaces did not land cleanly — v1.1 slot kept (fix and re-run update)",
        false,
      );
    } else {
      step(
        "plugin-off",
        "legacy v1.1 session plugin is NOT auto-removed (channel removed, ADR-017) — manual, per claude peer: " +
          "`claude plugin uninstall iapeer-memory@agfpd --scope project` from its cwd; codex (host-global): " +
          "`codex plugin remove iapeer-memory@agfpd`. Until then it stamps in parallel (idempotent).",
      );
    }
  }

  // 7. slot version + v1.2 form (contract obligation). Kept v1.1 while the
  // migration is blocked — the legacy channel stays derivable.
  if (slotForeign) {
    step("slot", `slot held by foreign provider "${existingSlot?.provider}" — not ours to update`, false);
  } else if (migrationBlocked) {
    step("slot", "kept v1.1 declaration (migration postponed — see plugin-off)", false);
  } else {
    const slot = writeSlot({
      slotPath: paths.slotPath,
      version,
      binaryPath: paths.binaryPath,
      heartbeat: paths.heartbeatPath,
    });
    step("slot", `${slot.action} (v${version}, provision-command declared)`, slot.action !== "refused-foreign");
  }

  // 8. launcher
  step("launcher", writeLauncherScript({ launcherPath: paths.launcherPath, binaryPath: paths.binaryPath }));

  // 8b. notifier wiring — RECONCILE to the curation plan (lean §7). The
  // WATCHER always re-registers (it launches memoryd; same-id = replace, and
  // it re-targets old hosts). The legacy inbox-SWEEP timer is unconditionally
  // UNREGISTERED — the inbox pipeline is gone, so a host provisioned before
  // the direct-to-canon migration gets its stale sweep trigger cleaned out
  // (idempotent: not-found is a soft no-op). The DREAM timer is registered
  // when its role is proactive, UNREGISTERED otherwise.
  {
    const plan = curationPlan(resolveMode(process.env).roles);
    // The trigger owner identity's runtime is the index peer's DECLARED runtime
    // (registry `default_runtime`), never a hardcoded "claude". Null → no index
    // peer on this host (BM25-only / degraded install) → nothing to reconcile
    // (non-fatal: triggers land once role peers exist, via verify --repair).
    const runtime = resolveRegistrantRuntime(egress, { iapeerBin });
    if (!runtime) {
      step(
        "triggers",
        "skipped — no index peer runtime in the registry (BM25-only / degraded install); " +
          "triggers reconcile once role peers exist",
      );
    } else {
      const w = registerWatcher(egress, {
        launcherPath: paths.launcherPath,
        target: plan.eventTarget ?? undefined,
        runtime,
        iapeerBin,
      });

      // Migration cleanup: drop any stale inbox-sweep timer.
      const s = unregisterTimer(egress, { id: LEGACY_SWEEP_TRIGGER_ID, runtime, iapeerBin });

      let d: { ok: boolean; suppressed?: boolean; detail: string };
      if (plan.dream) {
        writeDreamGateScript({
          dreamGateScriptPath: paths.dreamGateScriptPath,
          binaryPath: paths.binaryPath,
        });
        d = registerTimer(egress, {
          message: dreamTimerMessage({
            cron: process.env.IAPEER_MEMORY_DREAM_CRON,
            dreamGateScriptPath: paths.dreamGateScriptPath,
          }),
          runtime,
          iapeerBin,
        });
      } else {
        d = unregisterTimer(egress, { id: DREAM_TRIGGER_ID, runtime, iapeerBin });
      }

      const sandboxed = w.suppressed && s.suppressed && d.suppressed;
      step(
        "triggers",
        sandboxed
          ? "skipped (test sandbox — sends suppressed)"
          : w.ok && s.ok && d.ok
            ? `reconciled: watcher→${plan.eventTarget ?? "memoryd-only (lean)"}, ` +
              `legacy sweep cleared, ` +
              `dream ${plan.dream ? `→${DREAM_TARGET}` : "unregistered"}; confirm: verify`
            : `watcher: ${w.ok ? "ok" : w.detail}; sweep-cleanup: ${s.ok ? "ok" : s.detail}; dream: ${d.ok ? "ok" : d.detail}`,
        Boolean(sandboxed) || (w.ok && s.ok && d.ok),
      );
    }
  }

  // 8c. host-wide guide — update an ALREADY-ROLLED-OUT guide only
  // (presence = the rollout sanction; init --skip-guide hosts stay
  // untouched). Vault substituted into {{VAULT_PATH}} (the literal
  // placeholder left peers without the write path).
  {
    const iapeerDir = path.dirname(paths.slotPath);
    const guidePath = path.join(iapeerDir, "fragments", "iapeer-memory.md");
    if (!fs.existsSync(guidePath)) {
      step("guide", "not rolled out on this host — left untouched (roll out via init)");
    } else if (!vaultPathForDoctrines) {
      step("guide", "unprovisioned env — vault unknown, guide left as is", false);
    } else {
      writeHostWideGuideFragment(iapeerDir, guideText(locale, vaultPathForDoctrines));
      step("guide", `${guidePath} re-written (v${version}, vault path substituted)`);
    }
  }

  // 8d. on-host docs (ecosystem convention FU6): refresh the version-matched
  // docs copy under <IAPEER_ROOT|~/.iapeer>/docs/iapeer-memory/. Best-effort —
  // a missing source / fs error never fails update.
  try {
    const d = scaffoldHostDocs({ docsSource: packageDocsDir(), destDir: paths.hostDocsDir });
    step("docs", d.action === "written" ? d.detail : `skipped — ${d.detail}`);
  } catch (e) {
    step("docs", `skipped — ${(e as Error).message}`);
  }

  // 9. memoryd managed restart (the watcher relaunches with the new binary)
  step("memoryd", `${stopMemorydByPidFile(egress, paths.pidPath)} — the notifier watcher relaunches it with the new binary`);

  console.log(
    failures
      ? `\nupdate finished with ${failures} problem(s) — iapeer-memory verify --repair`
      : "\nupdate complete — confirm: iapeer-memory verify",
  );
  if (refreshHint) console.log(`\n${refreshHint}`);
  return failures ? 1 : 0;
}
