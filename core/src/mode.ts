/**
 * Lean §7/§7.1 — mode + per-role proactivity resolution.
 *
 * The toggle gates the curation OVERLAY's PROACTIVITY (notifier triggers /
 * memoryd curation emits), NOT the existence of anything: the role peers
 * (Index/Scriber/DreamWeaver) are ALWAYS provisioned and callable on-demand in
 * either mode, and memoryd (detector + archive + projection render +
 * /dedup) ALWAYS runs (its watcher trigger launches it — base infra, never
 * gated). What the mode gates is whether the curation pipeline FIRES by itself.
 *
 * Default resolution: `IAPEER_MEMORY_MODE` ABSENT → `curated` — a host
 * provisioned before this feature ran curated, and must never be silently
 * flipped to lean (§10.3). A NEW install's `init` WRITES the key (default
 * `lean`), so new hosts read lean. Per-role env overrides the preset:
 * `IAPEER_MEMORY_PROACTIVE_{INDEX,SCRIBER,DREAMWEAVER}` = on|off (independent
 * toggles over the preset, §7).
 */

export type MemoryMode = "lean" | "curated";
export type RoleSet = { index: boolean; scriber: boolean; dreamweaver: boolean };

const TRUE_TOKENS = new Set(["1", "on", "true", "yes", "y"]);
const FALSE_TOKENS = new Set(["0", "off", "false", "no", "n"]);

function toggle(raw: string | undefined, preset: boolean): boolean {
  const v = (raw ?? "").trim().toLowerCase();
  if (TRUE_TOKENS.has(v)) return true;
  if (FALSE_TOKENS.has(v)) return false;
  return preset; // unset / unrecognised → follow the mode preset
}

export function resolveMode(env: Record<string, string | undefined> = process.env): {
  mode: MemoryMode;
  roles: RoleSet;
} {
  const raw = (env.IAPEER_MEMORY_MODE ?? "").trim().toLowerCase();
  // absent / "curated" / anything-not-"lean" → curated (legacy preservation).
  const mode: MemoryMode = raw === "lean" ? "lean" : "curated";
  const preset = mode === "curated";
  return {
    mode,
    roles: {
      index: toggle(env.IAPEER_MEMORY_PROACTIVE_INDEX, preset),
      scriber: toggle(env.IAPEER_MEMORY_PROACTIVE_SCRIBER, preset),
      dreamweaver: toggle(env.IAPEER_MEMORY_PROACTIVE_DREAMWEAVER, preset),
    },
  };
}

/**
 * Curation proactivity derived from the role set (§7.1 matrix). The memoryd
 * WATCHER trigger is deliberately NOT here — it ALWAYS registers (it launches
 * memoryd; the base needs memoryd in both modes). This is exactly what the
 * toggle gates ON TOP of the always-on watcher.
 */
export type CurationPlan = {
  /** memoryd emits the curation event (CURATOR_TICK) — ONLY when a proactive
   *  receiver exists (scriber ∥ index). Full-lean → suppressed (the watcher
   *  then forwards nothing). */
  emit: boolean;
  /** The watcher's forward target, §7.1 conditional: scriber → else index →
   *  else null (no proactive receiver; placeholder, nothing is emitted). */
  eventTarget: string | null;
  /** Register the weekly dream-tick timer (→ dreamweaver) — decoupled from
   *  the Index (§7.1 key #2); only if dreamweaver is proactive. */
  dream: boolean;
};

export function curationPlan(roles: RoleSet): CurationPlan {
  const eventTarget = roles.scriber ? "scriber" : roles.index ? "index" : null;
  return {
    emit: eventTarget !== null,
    eventTarget,
    dream: roles.dreamweaver,
  };
}
