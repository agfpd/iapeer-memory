/**
 * `iapeer-memory init` — provision the system on this host (docs/10
 * §Install-flow). IDEMPOTENT: every step is safe to re-run; re-running
 * init is the official repair path for a half-provisioned host.
 *
 * Interactivity contract (fixed with the iapeer core, memory-slot doc):
 * the PROVIDER owns the install questions. tty + missing answers →
 * interactive prompts (storage path, locale, optional search endpoint,
 * human name); all answers via flags → fully silent; NON-tty (or
 * --non-interactive) without an explicit --vault → refusal (silent
 * provisioning of a default storage path is forbidden). `iapeer onboard`
 * runs this init with inherited stdio and may pass `--human <personality>`
 * (sent only when exactly one natural peer exists in the registry).
 *
 * Step order: deps → vault → config → binary → templates → role peers +
 * doctrines + roles manifest → fleet map → watcher registration → direct
 * session surfaces sweep (ADR-009 v1.2) → legacy v1.1 manual hint (the
 * plugin channel is removed, ADR-017) → slot declaration (v1.2 provision
 * command) → native-memory sweep (core verb, soft-skip on old cores) →
 * host-wide guide fragment. Ecosystem steps are skippable (--skip-ecosystem)
 * for sandboxed runs; the binary compile is skippable (--skip-binary) for
 * fast tests.
 */

import fs from "node:fs";
import path from "node:path";
import {
  getTaxonomy,
  isLocaleId,
  renderDoctrine,
  resolveMode,
  curationPlan,
  writeHostWideGuideFragment,
  type LocaleId,
  type MemoryMode,
} from "@agfpd/iapeer-memory-core";
import { installBinary } from "../binary.js";
import { IAPEER_BIN, type Egress } from "../egress.js";
import { memoryPaths } from "../paths.js";
import { provisionVault, writeDefaultConfig } from "../provision.js";
import { writeRolesManifest, type RoleEntry } from "../roles.js";
import { readSlot, writeSlot, SLOT_PROVIDER } from "../slot.js";
import { readFleetMap, writeFleetMap } from "../fleet.js";
import { withProvisionLock } from "../surfaces/lock.js";
import { sweepProvision } from "../surfaces/sweep.js";
import { mcpPort } from "./provision-peer.js";
import {
  doctrineOwnership,
  guideText,
  materialiseTemplates,
  rolePersonality,
  roleTemplatePath,
  ROLE_NAMES,
} from "../templates/index.js";
import { packageVersion } from "../version.js";
import { paintStatus, ui } from "../ui.js";
import {
  DREAM_TARGET,
  dreamTimerMessage,
  patchWakePolicyEphemeral,
  registerTimer,
  registerWatcher,
  resolveRegistrantRuntime,
  writeDreamGateScript,
  writeLauncherScript,
} from "../watcher.js";

type InitFlags = {
  vault?: string;
  locale?: string;
  human?: string;
  embeddingEndpoint?: string;
  rerankerEndpoint?: string;
  /** Host agentic runtime, passed by onboard (which detects it): role peers are
   *  created with it AND watcher/timer register from it — ONE runtime end-to-end
   *  (contract with iapeer/onboard). Omitted on a no-runtime host → degrade. */
  runtime?: string;
  /** Curation mode (lean §7); default lean for new installs. */
  mode?: string;
  nonInteractive: boolean;
  skipDeps: boolean;
  skipEcosystem: boolean;
  skipBinary: boolean;
  /** Skip the host-wide guide fragment (staged fleet rollout: the fleet may
   *  still carry the predecessor's guide; ours lands by a separate
   *  decision after the plugin swap). */
  skipGuide: boolean;
  /** Explicitly named core binary (--iapeer-bin) — undefined means the PATH
   *  default; the distinction feeds the egress explicit-bin allowance. */
  iapeerBin?: string;
};

function parseFlags(argv: string[]): InitFlags | null {
  const f: InitFlags = {
    nonInteractive: false,
    skipDeps: false,
    skipEcosystem: false,
    skipBinary: false,
    skipGuide: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const take = (): string | undefined => argv[++i];
    switch (a) {
      case "--vault": f.vault = take(); break;
      case "--locale": f.locale = take(); break;
      case "--human": f.human = take(); break;
      case "--embedding-endpoint": f.embeddingEndpoint = take(); break;
      case "--reranker-endpoint": f.rerankerEndpoint = take(); break;
      case "--runtime": f.runtime = take(); break;
      case "--mode": f.mode = take(); break;
      case "--non-interactive": f.nonInteractive = true; break;
      case "--skip-deps": f.skipDeps = true; break;
      case "--skip-ecosystem": f.skipEcosystem = true; break;
      case "--skip-binary": f.skipBinary = true; break;
      case "--skip-guide": f.skipGuide = true; break;
      case "--iapeer-bin": f.iapeerBin = take(); break;
      default:
        console.error(`iapeer-memory init: unknown flag: ${a}`);
        return null;
    }
  }
  return f;
}

// ── iapeer registry helpers ──────────────────────────────────────────────────

type PeerInfo = { personality: string; intelligence?: string; cwd?: string };

type RunResult = { exitCode: number; stdout: string; stderr: string };

/** Egress spawn that never throws — a missing binary (and a refusing test
 *  egress) is a result, not a crash: the ecosystem half degrades to the
 *  same skip path as «iapeer not on this host». */
function run(
  egress: Egress,
  cmd: string[],
  opts?: { explicitBin?: boolean },
): RunResult {
  const proc = egress.spawnSync(cmd, { explicitBin: opts?.explicitBin });
  if (proc.spawnError) return { exitCode: 127, stdout: "", stderr: proc.spawnError };
  return { exitCode: proc.exitCode, stdout: proc.stdout, stderr: proc.stderr };
}

function listPeers(egress: Egress, iapeerBin?: string): PeerInfo[] | null {
  const proc = run(egress, [iapeerBin ?? IAPEER_BIN, "list", "--json"], {
    explicitBin: iapeerBin !== undefined,
  });
  if (proc.exitCode !== 0) return null;
  try {
    return JSON.parse(proc.stdout) as PeerInfo[];
  } catch {
    return null;
  }
}

/** «Don't ask what the stack already knows»: exactly one natural peer → its name. */
function naturalPeerDefault(peers: PeerInfo[] | null): string | null {
  const naturals = (peers ?? []).filter((p) => p.intelligence === "natural");
  return naturals.length === 1 ? naturals[0].personality : null;
}

// ── interactive prompts (tty only) ───────────────────────────────────────────

function ask(question: string, fallback: string): string {
  // Bun's global prompt(); returns null on EOF.
  const answer = prompt(`${question}${fallback ? ` [${fallback}]` : ""}:`);
  const trimmed = (answer ?? "").trim();
  return trimmed || fallback;
}

// ── the command ──────────────────────────────────────────────────────────────

export async function cmdInit(argv: string[], egress: Egress): Promise<number> {
  const flags = parseFlags(argv);
  if (!flags) return 2;

  const interactive =
    !flags.nonInteractive && Boolean(process.stdin.isTTY && process.stdout.isTTY);

  // ── resolve answers (provider owns the questions) ──
  let vault = flags.vault ?? "";
  let localeRaw = flags.locale ?? "";
  let human = flags.human ?? "";
  let embeddingEndpoint = flags.embeddingEndpoint ?? "";
  let rerankerEndpoint = flags.rerankerEndpoint ?? "";
  // Host runtime from onboard (it detects the host's agentic runtime). Threaded
  // into `iapeer create --runtime` AND watcher/timer registration — one runtime
  // end-to-end. Absent (onboard omits it on a no-runtime host) → create fails
  // and init degrades to the BM25 base (see step 6/7).
  const flagRuntime = (flags.runtime ?? "").trim();

  const peers = flags.skipEcosystem ? null : listPeers(egress, flags.iapeerBin);
  const humanDefault = flags.human ?? naturalPeerDefault(peers) ?? "";

  if (!vault) {
    if (!interactive) {
      console.error(
        "iapeer-memory init: no tty and no --vault — refusing to silently " +
          "provision a default storage path. Pass --vault PATH (and --locale).",
      );
      return 2;
    }
    vault = ask("Vault (storage) path", path.join(process.env.HOME ?? "~", "iapeer-memory-vault"));
  }
  if (!localeRaw) {
    localeRaw = interactive ? ask("Vault locale (en|ru)", "en") : "en";
  }
  if (!isLocaleId(localeRaw)) {
    console.error(`iapeer-memory init: unknown locale "${localeRaw}" (expected en|ru)`);
    return 2;
  }
  const locale: LocaleId = localeRaw;

  // Curation mode (lean §7). Resolution: an explicit --mode wins; else PRESERVE
  // the host's existing mode (cli.ts loads config.env into process.env before
  // dispatch — a re-init of a curated host must NOT silently flip to lean and
  // mis-wire its triggers, §10.3 / mode.ts); else default lean for a truly NEW
  // install (cheap by default — the curation overlay is a deliberate opt-in).
  const envMode = (process.env.IAPEER_MEMORY_MODE ?? "").trim().toLowerCase();
  const preserved = envMode === "lean" || envMode === "curated" ? envMode : "lean";
  const modeRaw = (flags.mode ?? preserved).trim().toLowerCase();
  if (modeRaw !== "lean" && modeRaw !== "curated") {
    console.error(`iapeer-memory init: --mode must be "lean" or "curated" (got "${flags.mode}")`);
    return 2;
  }
  const mode: MemoryMode = modeRaw;
  const plan = curationPlan(resolveMode({ ...process.env, IAPEER_MEMORY_MODE: mode }).roles);
  if (!human) {
    human = interactive
      ? ask("Human owner personality (empty = no human role)", humanDefault)
      : humanDefault; // the stack knew it — use it, don't ask
  }
  if (!embeddingEndpoint && interactive) {
    embeddingEndpoint = ask(
      "Embedding endpoint (OpenAI-compatible URL; Enter = пропустить → BM25-only, включишь позже в config.env)",
      "",
    );
  }
  // Reranker layers on top of the hybrid fusion — only meaningful WITH
  // embeddings. Ask for it only when an embedding endpoint was given; otherwise
  // a one-line pointer (it stays configurable in config.env either way).
  if (!rerankerEndpoint && interactive) {
    if (embeddingEndpoint) {
      rerankerEndpoint = ask(
        "Reranker endpoint (TEI /rerank URL; Enter = пропустить, добавишь позже в config.env)",
        "",
      );
    } else {
      console.log("      Reranker: пропущен (нужны эмбеддинги) — добавишь в config.env позже");
    }
  }

  const paths = memoryPaths();
  const iapeerDir = path.dirname(paths.slotPath);
  const version = packageVersion();
  let failures = 0;
  const step = (name: string, detail: string, ok = true): void => {
    if (!ok) failures++;
    const token = paintStatus(ok ? "ok" : "fail", ok ? "ok  " : "FAIL");
    // ok detail is confirmatory → dim; fail detail is the reason → keep readable.
    console.log(`${token}  ${name.padEnd(10)}  ${ok ? ui.dim(detail) : detail}`);
  };

  // 1. dependencies
  if (flags.skipDeps) {
    step("deps", "skipped (--skip-deps)");
  } else {
    const ver = run(egress, [flags.iapeerBin ?? IAPEER_BIN, "version"], { explicitBin: flags.iapeerBin !== undefined });
    if (ver.exitCode !== 0) {
      step("deps", "iapeer foundation not found on PATH — install it first (npx @agfpd/iapeer)", false);
    } else {
      const coreVersion = ver.stdout.trim();
      const hasNotifier = (peers ?? []).some((p) => p.personality === "watcher");
      step(
        "deps",
        `iapeer ${coreVersion}` +
          (hasNotifier ? ", notifier watcher peer present" : ""),
        hasNotifier,
      );
      if (!hasNotifier) {
        console.log(
          "      deps        notifier-runtime watcher peer missing — install the notifier " +
            "runtime (iapeer install-runtime notifier), then re-run init",
        );
      }
    }
  }

  // 2. vault
  fs.mkdirSync(vault, { recursive: true });
  const prov = provisionVault({ vaultPath: vault, taxonomy: getTaxonomy(locale) });
  step(
    "vault",
    `${vault} (${prov.createdDirs.length} dirs + ${prov.createdFiles.length} seeds created, ${prov.kept.length} kept)`,
  );

  // 3. config (operator-owned; written once)
  const cfg = writeDefaultConfig({
    configFile: paths.configFile,
    vaultPath: vault,
    locale,
    mode,
    human: human || null,
    embeddingEndpoint: embeddingEndpoint || null,
    rerankerEndpoint: rerankerEndpoint || null,
  });
  step("config", `${paths.configFile} (${cfg}) mode=${mode}`);

  // 4. stable binary
  if (flags.skipBinary) {
    step("binary", "skipped (--skip-binary)");
  } else {
    const bin = installBinary(egress, { outPath: paths.binaryPath });
    step(
      "binary",
      bin.action === "compiled"
        ? `${bin.outPath} (${Math.round(bin.bytes / 1024 / 1024)}MB; signing: ${bin.signing.state}` +
          `${bin.signing.state === "signed-new-identity" ? " — the one install-time keychain event" : ""}` +
          `${bin.signing.state === "failed-soft" ? ` — ${bin.signing.detail}` : ""})`
        : bin.action === "skipped-compiled"
          ? `kept existing ${bin.outPath} (running from the installed binary)`
          : `compile failed — ${bin.detail}`,
      bin.action !== "failed",
    );
  }

  // 5. templates (package-owned)
  const tmpl = materialiseTemplates({ templatesDir: paths.templatesDir, locale });
  step("templates", `${paths.templatesDir} (${tmpl.written.length} written, ${tmpl.identical.length} identical)`);

  // 6. role peers + doctrines + manifest. Personalities are namespaced
  // memory-<role> (collision-proof by design); the manifest keeps the
  // CONCEPTUAL role keys.
  // No-runtime degrade: a host with no agentic runtime can't run role peers —
  // `iapeer create` fails, init provisions the BM25 base and skips role peers +
  // notifier wiring (contract: onboard omits --runtime on such a host).
  let noRuntimeDegrade = false;
  let noRuntimeDetail = "";
  if (flags.skipEcosystem) {
    step("roles", "skipped (--skip-ecosystem)");
  } else {
    const roleEntries: RoleEntry[] = [];
    let rolesOk = true;
    let createdAny = false;
    for (const role of ROLE_NAMES) {
      const personality = rolePersonality(role);
      const exists = (peers ?? []).some((p) => p.personality === personality);
      if (!exists) {
        // Thread the host runtime through create (onboard's detected runtime) —
        // the peer is DECLARED with it, and watcher/timer later register from the
        // same declaration (step 7). Absent → core resolves its own default.
        const createArgs = [flags.iapeerBin ?? IAPEER_BIN, "create", personality];
        if (flagRuntime) createArgs.push("--runtime", flagRuntime);
        const created = run(egress, createArgs, { explicitBin: flags.iapeerBin !== undefined });
        if (created.exitCode !== 0) {
          rolesOk = false;
          // No --runtime passed AND create failed → no agentic runtime on the
          // host: degrade (don't half-provision the rest of the role peers).
          if (!flagRuntime) {
            noRuntimeDegrade = true;
            noRuntimeDetail = created.stderr.trim();
            break;
          }
          console.log(`      roles       create ${personality} failed: ${created.stderr.trim()}`);
          continue;
        }
        createdAny = true;
      }
    }
    if (noRuntimeDegrade) {
      // Graceful degrade — the BM25 base IS provisioned (success), only the
      // role peers wait on a runtime. Non-fatal (init exits 0): onboard proceeds
      // and surfaces the advisory; `verify --repair` wires the rest once a
      // runtime is installed.
      step(
        "roles",
        "skipped — no agentic runtime installed (Claude Code / Codex). Base provisioned; " +
          "install a runtime, then `iapeer-memory verify --repair` to wire role peers + triggers" +
          (noRuntimeDetail ? ` (iapeer: ${noRuntimeDetail})` : ""),
      );
    } else {
      // peerCwd: the registry FACT when the core exposes it (`cwd` in
      // `iapeer list --json` — iapeer 0.2.14), otherwise the core's
      // DOCUMENTED create default (no --path — by requirement;
      // IAPEER_ROOT-aware).
      const freshPeers = createdAny ? listPeers(egress, flags.iapeerBin) : peers;
      for (const role of ROLE_NAMES) {
        const personality = rolePersonality(role);
        const registryCwd = (freshPeers ?? []).find((p) => p.personality === personality)?.cwd;
        const peerCwd = registryCwd || path.join(iapeerDir, "peers", personality);
        // COLLISION GUARD («index» уже бывал занят живым Индексом
        // предшественника; бренд-имена ролей — by decision, защита
        // целиком здесь): a pre-existing peer whose doctrine is NOT ours is
        // somebody else's — rendering over it would hijack a live peer.
        // FAIL loud with a recipe, never render.
        if (doctrineOwnership(peerCwd) === "foreign") {
          rolesOk = false;
          console.log(
            `      roles       COLLISION: peer "${personality}" exists with a foreign doctrine ` +
              `(${path.join(peerCwd, ".iapeer", "IAPEER.md")}) — not touching it. Recipe: ` +
              `rename/remove that peer (iapeer stop ${personality} && iapeer remove ${personality}) ` +
              `or move its cwd, then re-run init`,
          );
          continue;
        }
        const template = roleTemplatePath(paths.templatesDir, locale, role);
        const rendered = renderDoctrine({ templatePath: template, peerCwd, version, vaultPath: vault });
        if (rendered.action === "missing-template") {
          rolesOk = false;
          console.log(`      roles       ${role}: template missing at ${template}`);
          continue;
        }
        roleEntries.push({ role, peerCwd, template });
      }
      writeRolesManifest({ rolesManifestPath: paths.rolesManifestPath, roles: roleEntries });
      // ALL curators (Index/Scriber/DreamWeaver) are TICK-STATELESS — each wakes
      // for a discrete pass (CURATOR_TICK / dream-tick / on-demand) and carries
      // no state between wakes. They run EPHEMERAL (a clean session per wake): a
      // PERSISTENT session would accumulate a STALE model after a deploy — exactly
      // the migration class an ephemeral flip structurally kills. Patch the one
      // key into each core-owned profile, no-clobber.
      const wakePolicies = roleEntries.map((r) => `${r.role}:${patchWakePolicyEphemeral(r.peerCwd)}`);
      const wakeOk = wakePolicies.every((w) => !w.endsWith("missing-profile"));
      step(
        "roles",
        `${roleEntries.map((r) => rolePersonality(r.role as (typeof ROLE_NAMES)[number])).join(", ")} ` +
          `(doctrines v${version}, wake_policy ${wakePolicies.join(" ")}, manifest ${paths.rolesManifestPath})`,
        rolesOk && roleEntries.length === ROLE_NAMES.length && wakeOk,
      );
    }
  }

  // 6b. fleet map — personality → cwd for memoryd's fragment renderer
  // (docs/05: без карты пиры не получали paths-блок и индекс).
  // ПЕРЕД watcher-регистрацией: memoryd, поднятый notifier'ом, рендерит
  // весь флот уже на старте. Roles-степ выше уже создал ролевых пиров —
  // карта включает их.
  if (flags.skipEcosystem) {
    step("fleet", "skipped (--skip-ecosystem)");
  } else {
    const fleet = writeFleetMap(egress, {
      fleetMapPath: paths.fleetMapPath,
      iapeerBin: flags.iapeerBin,
    });
    step(
      "fleet",
      fleet.action === "written"
        ? fleet.detail
        : `fleet map not written (${fleet.detail}) — fragments stay off until verify --repair`,
      fleet.action === "written",
    );
  }

  // 7. notifier wiring — GATED by the curation plan (lean §7). The WATCHER
  // ALWAYS registers: its script LAUNCHES memoryd (the base — детектор/архив/
  // проекция/dedup — runs in BOTH modes; never gated). Its forward target is
  // the §7.1 conditional (scriber→index→placeholder), and memoryd SUPPRESSES
  // curation emits in full-lean so the forward is empty. The SWEEP (→index)
  // and DREAM (→dreamweaver) timers register ONLY when their role is proactive.
  if (flags.skipEcosystem) {
    step("watcher", "skipped (--skip-ecosystem)");
    step("timers", "skipped (--skip-ecosystem)");
  } else if (noRuntimeDegrade) {
    // Graceful (see roles step) — non-fatal: nothing to register without role peers.
    step("watcher", "skipped — no agentic runtime (role peers not provisioned; see roles)");
    step("dream", "skipped — no agentic runtime");
  } else {
    // The registrant identity's runtime is the index role peer's DECLARED
    // runtime: the host runtime onboard passed (--runtime), else read back from
    // the registry (`default_runtime`). NEVER a hardcoded "claude" — a codex role
    // peer must register as `codex-index` or the notifier refuses the trigger.
    const registrationRuntime =
      flagRuntime || resolveRegistrantRuntime(egress, { iapeerBin: flags.iapeerBin }) || "";
    if (!registrationRuntime) {
      step(
        "watcher",
        "skipped — could not resolve the index peer's runtime from the registry; " +
          "run `iapeer-memory verify --repair` once the runtime is set",
        false,
      );
      step("dream", "skipped (index runtime unresolved)");
    } else {
      writeLauncherScript({ launcherPath: paths.launcherPath, binaryPath: paths.binaryPath });
      const sent = registerWatcher(egress, {
        launcherPath: paths.launcherPath,
        target: plan.eventTarget ?? undefined, // null (full-lean) → default placeholder; memoryd emits nothing
        runtime: registrationRuntime,
        iapeerBin: flags.iapeerBin,
      });
      step(
        "watcher",
        sent.suppressed
          ? "skipped (test sandbox — sends suppressed)"
          : sent.ok
            ? `registered (launches memoryd; curation target: ${plan.eventTarget ?? "none — lean: base runs, curation silent"}); confirm: iapeer-memory verify`
            : `registration failed — ${sent.detail}`,
        sent.ok || Boolean(sent.suppressed),
      );

      if (plan.dream) {
        writeDreamGateScript({
          dreamGateScriptPath: paths.dreamGateScriptPath,
          binaryPath: paths.binaryPath,
        });
        const dream = registerTimer(egress, {
          message: dreamTimerMessage({
            cron: process.env.IAPEER_MEMORY_DREAM_CRON,
            dreamGateScriptPath: paths.dreamGateScriptPath,
          }),
          runtime: registrationRuntime,
          iapeerBin: flags.iapeerBin,
        });
        step(
          "dream",
          dream.suppressed
            ? "skipped (test sandbox)"
            : dream.ok
              ? `dream-tick (weekly, gated → ${DREAM_TARGET})`
              : `dream: ${dream.detail}`,
          dream.ok || Boolean(dream.suppressed),
        );
      } else {
        step("dream", `not registered (mode ${mode}: dreamweaver not proactive)`);
      }
    }
  }

  // 8. slot + surfaces + v1.1 migration — ORDER MATTERS (ADR-009 v1.2):
  //   8a. a FOREIGN slot refuses the whole block (never lay surfaces over
  //       another provider's host);
  //   8b. direct surfaces sweep across the existing fleet (the new channel
  //       must be in place BEFORE the old one is stripped);
  //   8c. legacy plugin off — while the v1.1 slot is STILL on disk (the
  //       core verb derives the plugin identity from the live declaration;
  //       overwriting first would leave it nothing to derive from);
  //   8d. slot declaration re-written in the v1.2 form (provision command,
  //       no plugin block). Newborns are then the core birth-hook's duty.
  const existingSlot = readSlot(paths.slotPath);
  const slotForeign = existingSlot !== null && existingSlot.provider !== SLOT_PROVIDER;
  if (slotForeign) {
    step("slot", `slot held by foreign provider "${existingSlot?.provider}" — uninstall it first`, false);
    step("surfaces", "skipped (foreign slot — not our host)");
  } else {
    // 8b. direct session surfaces across the EXISTING fleet — the package's
    // own rail over the fleet map written in 6b.
    let surfacesOk = false;
    if (flags.skipEcosystem) {
      step("surfaces", "skipped (--skip-ecosystem)");
      surfacesOk = true; // sandboxed run — don't block the slot/migration steps
    } else {
      const fleet = readFleetMap(paths.fleetMapPath) ?? [];
      const locked = withProvisionLock({
        stateDir: paths.stateDir,
        fn: () => sweepProvision(egress, { fleet, hooksDir: paths.hooksDir, port: mcpPort(), iapeerBin: flags.iapeerBin }),
      });
      if (!locked.acquired) {
        step("surfaces", locked.detail, false);
      } else {
        const { results, skipped } = locked.result;
        const failed = results.filter((r) => !r.ok);
        surfacesOk = failed.length === 0;
        step(
          "surfaces",
          `${results.length - failed.length}/${results.length} peer-runtime(s) provisioned` +
            (skipped.length ? `, ${skipped.length} skipped (no session runtime / missing cwd)` : "") +
            " — live sessions pick them up on next restart",
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

    // 8c. v1.1 → v1.2 migration: the plugin channel is REMOVED (ADR-017) —
    // the package no longer shells the core verb; a v1.1 host gets the
    // manual recipe and the slot migrates ONLY after the direct surfaces
    // landed cleanly (never strand a host with neither channel).
    let migrationBlocked = false;
    if (!flags.skipEcosystem && existingSlot?.plugin) {
      if (!surfacesOk) {
        migrationBlocked = true;
        step(
          "plugin-off",
          "POSTPONED: direct surfaces did not land cleanly — v1.1 slot kept (re-run init after fixing)",
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

    // 8d. slot declaration (atomic; provider-owned). Kept in the v1.1 form
    // while the migration is blocked — the legacy plugin channel stays
    // derivable until the new channel lands.
    if (migrationBlocked) {
      step("slot", "kept v1.1 declaration (migration postponed — see plugin-off)", false);
    } else {
      const slot = writeSlot({
        slotPath: paths.slotPath,
        version,
        binaryPath: paths.binaryPath,
        heartbeat: paths.heartbeatPath,
      });
      step(
        "slot",
        `${paths.slotPath} (${slot.action}, v${version}, provision-command declared)`,
        slot.action !== "refused-foreign",
      );
    }
  }

  // 9. native-memory sweep — the core's lever (one home of runtime forms);
  // soft-skip when the verb is unavailable (older core), verify re-runs later.
  if (flags.skipEcosystem) {
    step("sweep", "skipped (--skip-ecosystem)");
  } else {
    const sweep = run(egress, [flags.iapeerBin ?? IAPEER_BIN, "native-memory", "off", "--all"], { explicitBin: flags.iapeerBin !== undefined });
    // One line per peer-runtime — summarise ALL peers, not the last line
    // (e2e §A finding: ".pop()" named one peer while three were swept).
    const sweepLines = sweep.stdout.trim().split("\n").filter(Boolean);
    const sweptPeers = [
      ...new Set(sweepLines.map((l) => l.split(" ")[0].replace(/:$/, "")).filter(Boolean)),
    ];
    step(
      "sweep",
      sweep.exitCode === 0
        ? `native auto-memory off across the fleet (${sweptPeers.length} peer(s): ` +
          `${sweptPeers.slice(0, 8).join(", ")}${sweptPeers.length > 8 ? ", …" : ""})`
        : `soft-skip: core verb unavailable (${sweep.stderr.trim().slice(0, 120) || `exit ${sweep.exitCode}`}) — upgrade the iapeer core and re-run`,
    );
  }

  // 10. host-wide guide fragment (layer 5 — reaches every peer on next wakes)
  if (flags.skipGuide) {
    step("guide", "skipped (--skip-guide) — roll out by a separate decision after the fleet plugin swap");
  } else {
    // vault substituted into the {{VAULT_PATH}} marker (the literal
    // placeholder left peers without the write path).
    const guidePath = writeHostWideGuideFragment(iapeerDir, guideText(locale, vault));
    step("guide", guidePath);
  }

  console.log(
    failures
      ? `\n${ui.bold(ui.yellow(`init finished with ${failures} problem(s)`))} — re-run init (idempotent) or iapeer-memory verify --repair`
      : `\n${ui.bold(ui.green("init complete"))} — check the chain: iapeer-memory status`,
  );
  return failures ? 1 : 0;
}
