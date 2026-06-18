/**
 * `iapeer-memory uninstall [--keep-binary]` — remove the system from the
 * host. SYMMETRY OBLIGATION of the memory-slot contract: the provider that
 * writes the slot declaration removes it.
 *
 * What it removes: direct session surfaces across the fleet (ADR-009 v1.2 —
 * own entries/keys/dirs only, swept BEFORE the declaration falls), the slot
 * declaration (own only — a foreign slot is refused), notifier triggers,
 * memoryd (verified-pid stop), the compiled binary. What it deliberately
 * KEEPS: the vault (user data), the package config (operator-owned),
 * state/cache (cheap to rebuild, may hold migrate backups!).
 *
 * Native auto-memory of the fleet is NOT restored (contract decision,
 * c968219): silent re-enabling would quietly resurrect split memory across
 * the fleet — worse than an honest visible degradation. The restore lever
 * is the core's: `iapeer native-memory on --all` (manual decision).
 */

import fs from "node:fs";
import type { Egress } from "../egress.js";
import { memoryPaths } from "../paths.js";
import { ui } from "../ui.js";
import { removeBinary } from "../binary.js";
import { readFleetMap } from "../fleet.js";
import { readSlot, removeSlot, SLOT_PROVIDER } from "../slot.js";
import { withProvisionLock } from "../surfaces/lock.js";
import { sweepUnprovision } from "../surfaces/sweep.js";
import { guardedUnlinkSync } from "@agfpd/iapeer-memory-core";
import {
  DREAM_TRIGGER_ID,
  LEGACY_SWEEP_TRIGGER_ID,
  resolveRegistrantRuntime,
  unregisterTimer,
  unregisterWatcher,
  WATCHER_TRIGGER_ID,
} from "../watcher.js";

/**
 * Owner verification before signalling: the process command line must look
 * like OUR daemon (`… memoryd`, launched via the CLI/launcher). A pid can
 * be recycled by the OS between memoryd's crash and uninstall — verifying
 * the command closes the "signal a stranger" class. Probe failure → false
 * (never signal on uncertainty).
 */
export function pidLooksLikeOurs(egress: Egress, pid: number): boolean {
  // `ps` probe — egress allowance 3 (read-only lookup FEEDING the verified
  // kill; refusing it would break the guard itself). Never throws.
  const proc = egress.spawnSync(["ps", "-o", "command=", "-p", String(pid)]);
  if (proc.spawnError || proc.exitCode !== 0) return false;
  return proc.stdout.trim().includes("memoryd");
}

/**
 * Stop memoryd by its pid file. DEFENSIVE KILL CONTRACT: a signal is sent
 * ONLY to a positive, live pid whose command line
 * is VERIFIED to be ours — a recycled/foreign pid in a stale file must
 * never be signalled; never a group/negative pid by construction. Shared
 * by uninstall (stop) and update (managed restart: SIGTERM → the notifier
 * watcher relaunches via the launcher with the fresh binary, ADR-010).
 */
export function stopMemorydByPidFile(egress: Egress, pidPath: string): string {
  let line = "not running (no pid file)";
  try {
    const pid = Number(fs.readFileSync(pidPath, "utf-8").trim());
    if (Number.isInteger(pid) && pid > 1) {
      if (!pidLooksLikeOurs(egress, pid)) {
        line = `pid file points at a non-memoryd process (${pid}) — NOT signalling; stale file removed`;
      } else {
        line = egress.kill(pid, "SIGTERM").delivered
          ? `SIGTERM sent to pid ${pid} (command verified)`
          : `stale pid file (process ${pid} gone) — removed`;
      }
    }
    guardedUnlinkSync(pidPath);
  } catch {
    // no pid file — nothing to stop
  }
  return line;
}

export function cmdUninstall(argv: string[], egress: Egress): number {
  let keepBinary = false;
  let iapeerBin = "iapeer";
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--keep-binary") keepBinary = true;
    else if (a === "--iapeer-bin") iapeerBin = argv[++i] ?? "iapeer";
    else {
      console.error(`iapeer-memory uninstall: unknown flag: ${a}`);
      return 2;
    }
  }

  const paths = memoryPaths();
  let failed = false;
  // Consistent CLI look (onboard's uninstall-verb surfaces this): the "label :"
  // key is dim, the outcome word is colored by its sentiment, bare paths dim.
  const row = (label: string, detail: string): void =>
    console.log(`${ui.dim(`${label.padEnd(10)}:`)} ${detail}`);

  // Direct session surfaces OFF across the fleet BEFORE removing the
  // declaration (ADR-009 v1.2 mirror symmetry: a dead provider's surfaces
  // must not keep pointing at a void). Guard: only when the slot is OURS.
  const declared = readSlot(paths.slotPath);
  if (declared && declared.provider === SLOT_PROVIDER) {
    const fleet = readFleetMap(paths.fleetMapPath);
    if (!fleet) {
      row(
        "surfaces",
        ui.gray("fleet map missing/unreadable (") +
          ui.dim(paths.fleetMapPath) +
          ui.gray(") — nothing swept; manual per peer: iapeer-memory unprovision-peer --cwd <cwd> --runtime <r>"),
      );
    } else {
      const locked = withProvisionLock({
        stateDir: paths.stateDir,
        fn: () => sweepUnprovision({ fleet }),
      });
      if (!locked.acquired) {
        row("surfaces", ui.red(locked.detail));
        failed = true;
      } else {
        const { results, skipped } = locked.result;
        const bad = results.filter((r) => !r.ok);
        row(
          "surfaces",
          ui.green(`stripped from ${results.length - bad.length}/${results.length} peer-runtime(s)`) +
            (skipped.length ? ui.gray(` (${skipped.length} skipped)`) : ""),
        );
        for (const b of bad) {
          failed = true;
          row(
            "surfaces",
            ui.red(
              `FAIL ${b.personality}:${b.runtime} — ${b.outcomes
                .filter((o) => o.action === "failed")
                .map((o) => `${o.surface}: ${o.detail ?? "failed"}`)
                .join("; ")}`,
            ),
          );
        }
      }
    }

    // Legacy v1.1 path: the slot still carries a plugin block. The plugin
    // channel is REMOVED (ADR-017) — no core verb is shelled; the manual
    // recipe works without the slot.
    if (declared.plugin) {
      row(
        "plugin",
        ui.gray(
          "legacy v1.1 session plugin is NOT auto-removed (channel removed, ADR-017) — manual: " +
            "per claude peer `claude plugin uninstall iapeer-memory@agfpd --scope project` from its cwd; " +
            "codex (host-global): `codex plugin remove iapeer-memory@agfpd`",
        ),
      );
    }
  }

  const slot = removeSlot(paths.slotPath);
  if (slot === "refused-foreign") {
    row("slot", ui.red("held by a FOREIGN provider — left intact"));
    failed = true;
  } else {
    row("slot", slot === "removed" ? ui.green("declaration removed") : ui.gray("already absent"));
  }

  // notifier wiring: best-effort unregister of all three triggers (not-found
  // is soft on the notifier side; teaching replies go to the index session).
  // The `--from` identity must carry the index peer's DECLARED runtime (the
  // notifier refuses a wrong runtime) — read it from the registry. If it can't
  // be resolved (peer already gone / core unreachable), try each agentic runtime
  // so a trigger is never orphaned by a single wrong guess (no hardcode claude).
  const declaredRuntime = resolveRegistrantRuntime(egress, { iapeerBin });
  const tryRuntimes = declaredRuntime ? [declaredRuntime] : ["claude", "codex"];
  const unregAcross = (
    send: (runtime: string) => { ok: boolean; detail: string },
  ): { ok: boolean; detail: string } => {
    let last = { ok: false, detail: "no runtime attempted" };
    for (const rt of tryRuntimes) {
      last = send(rt);
      if (last.ok) break;
    }
    return last;
  };
  const unreg = unregAcross((runtime) => unregisterWatcher(egress, { runtime, iapeerBin }));
  row(
    "watcher",
    unreg.ok
      ? ui.green(`unregister sent for ${WATCHER_TRIGGER_ID}`)
      : ui.gray(`unregister not sent (${unreg.detail}) — remove the trigger manually via the watcher peer`),
  );
  for (const id of [LEGACY_SWEEP_TRIGGER_ID, DREAM_TRIGGER_ID]) {
    const t = unregAcross((runtime) => unregisterTimer(egress, { id, runtime, iapeerBin }));
    row(
      "timer",
      t.ok
        ? ui.green(`unregister sent for ${id}`)
        : ui.gray(`unregister not sent for ${id} (${t.detail}) — remove manually via the timer peer`),
    );
  }

  const memoryd = stopMemorydByPidFile(egress, paths.pidPath);
  row("memoryd", /sent|removed/.test(memoryd) ? ui.green(memoryd) : ui.gray(memoryd));

  if (keepBinary) {
    row("binary", ui.gray("kept (") + ui.dim(paths.binaryPath) + ui.gray(")"));
  } else {
    row(
      "binary",
      removeBinary(paths.binaryPath) === "removed"
        ? ui.green("removed ") + ui.dim(paths.binaryPath)
        : ui.gray("already absent"),
    );
  }

  row("vault", ui.gray("NOT touched (user data)"));
  row("config", ui.gray("NOT touched (") + ui.dim(paths.configFile) + ui.gray(" — operator-owned)"));
  row(
    "native",
    ui.gray("fleet auto-memory stays OFF — restoring it is a manual decision; core lever: iapeer native-memory on --all"),
  );

  return failed ? 1 : 0;
}
