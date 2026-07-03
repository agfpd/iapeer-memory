/**
 * `iapeer-memory render` — explicit one-shot rendering of the package's
 * artifacts. memoryd renders these continuously at runtime; `render` is the
 * manual/scripted path (init, repair, debugging, tests).
 *
 *   render index    --agent NAME [--out FILE] [--projects-root DIR]
 *   render fragment --agent NAME --peer-cwd DIR [--index FILE]
 *   render doctrine --role NAME --peer-cwd DIR --template FILE
 *   render guide    --source FILE --target IAPEER_DIR
 *
 * `guide` writes the HOST-WIDE fragment — it reaches EVERY peer of the
 * fleet on their next wakes, so the target directory is always EXPLICIT
 * (no default to the production ~/.iapeer; the fleet rollout is a
 * separately sanctioned release step).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  configFromEnv,
  regenerateVaultIndex,
  renderDoctrine,
  renderPeerFragment,
  resolveAgentName,
  writeHostWideGuideFragment,
  type FragmentEnv,
} from "@agfpd/iapeer-memory-core";
import { authorIndexPath, memoryPaths } from "../paths.js";
import { packageVersion } from "../version.js";

class UsageError extends Error {}

function parseFlags(argv: string[], spec: Record<string, "value" | "bool">): {
  flags: Record<string, string | boolean>;
  rest: string[];
} {
  const flags: Record<string, string | boolean> = {};
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) {
      rest.push(a);
      continue;
    }
    const kind = spec[a];
    if (!kind) throw new UsageError(`unknown flag: ${a}`);
    if (kind === "bool") {
      flags[a] = true;
    } else {
      const v = argv[++i];
      if (v === undefined) throw new UsageError(`${a} requires a value`);
      flags[a] = v;
    }
  }
  return { flags, rest };
}

function renderIndex(argv: string[]): number {
  const { flags } = parseFlags(argv, {
    "--agent": "value",
    "--out": "value",
    "--projects-root": "value",
  });
  const agent = resolveAgentName((flags["--agent"] as string) ?? null);
  if (!agent) throw new UsageError("no agent (pass --agent or set PEER_PERSONALITY)");

  const config = configFromEnv();
  const paths = memoryPaths();
  const outFile = (flags["--out"] as string) || authorIndexPath(paths, agent);
  const projectsRoot =
    (flags["--projects-root"] as string) ||
    process.env.IAPEER_MEMORY_PROJECTS_ROOT ||
    path.join(process.env.HOME || os.homedir(), "Projects");

  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  const result = regenerateVaultIndex({
    vault: config.vaultPath,
    agent,
    outFile,
    ctx: { taxonomy: config.taxonomy, ranking: config.ranking },
    projectsRoot,
  });
  console.log(
    `render index: ${outFile} (${result.total} notes` +
      `${result.truncated ? ", truncated" : ""}` +
      `${result.skipped.length ? `, ${result.skipped.length} skipped` : ""})`,
  );
  return 0;
}

function renderFragment(argv: string[]): number {
  const { flags } = parseFlags(argv, {
    "--agent": "value",
    "--peer-cwd": "value",
    "--index": "value",
  });
  const agent = resolveAgentName((flags["--agent"] as string) ?? null);
  if (!agent) throw new UsageError("no agent (pass --agent or set PEER_PERSONALITY)");
  const peerCwd = flags["--peer-cwd"] as string | undefined;
  if (!peerCwd) throw new UsageError("--peer-cwd is required");

  const config = configFromEnv();
  const paths = memoryPaths();
  const indexAgent = process.env.IAPEER_MEMORY_INDEX_AGENT || "index";
  const indexFile = (flags["--index"] as string) || authorIndexPath(paths, agent);
  if (!fs.existsSync(indexFile)) {
    console.error(
      `render fragment: author index not found at ${indexFile} — ` +
        `run \`iapeer-memory render index --agent ${agent}\` first ` +
        `(the fragment would silently miss its index layer)`,
    );
    return 1;
  }

  const env: FragmentEnv = {
    agent,
    indexAgent,
    paths: {
      vault: config.vaultPath,
      db: config.index.dbPath,
      config: paths.configFile,
      state: paths.stateDir,
      cache: paths.cacheDir,
      logs: paths.logsDir,
    },
    authorIndexPath: indexFile,
    // lean §3: the compact projection goes to EVERY peer (memoryd renders the
    // projection file; a missing file is skipped gracefully by buildLayers).
    tagsProjectionPath: paths.tagsProjectionPath,
    tagsTitle: config.taxonomy.systemFiles.tagsDictionary,
  };
  const written = renderPeerFragment({ peerCwd, env });
  console.log(`render fragment: ${written}`);
  return 0;
}

function renderDoctrineCmd(argv: string[]): number {
  const { flags } = parseFlags(argv, {
    "--role": "value",
    "--peer-cwd": "value",
    "--template": "value",
  });
  const role = flags["--role"] as string | undefined;
  const peerCwd = flags["--peer-cwd"] as string | undefined;
  const template = flags["--template"] as string | undefined;
  if (!role || !peerCwd || !template) {
    throw new UsageError("--role, --peer-cwd and --template are all required");
  }
  // vaultPath — the same host-fact resolution update/init/verify use (audit
  // important): without it the {{VAULT_PATH}} marker rendered as a
  // placeholder, the role peer lost the vault root fact, and verify (marker
  // version only) read the crippled doctrine as «ok» forever.
  let vaultPath: string | undefined;
  try {
    vaultPath = configFromEnv().vaultPath;
  } catch {
    // unprovisioned env — the template keeps its marker, never a guess
  }
  const outcome = renderDoctrine({
    templatePath: template,
    peerCwd,
    version: packageVersion(),
    vaultPath,
  });
  console.log(`render doctrine [${role}]: ${outcome.action} ${outcome.target}`);
  return outcome.action === "missing-template" ? 1 : 0;
}

function renderGuide(argv: string[]): number {
  const { flags } = parseFlags(argv, {
    "--source": "value",
    "--target": "value",
  });
  const source = flags["--source"] as string | undefined;
  const target = flags["--target"] as string | undefined;
  if (!source || !target) {
    throw new UsageError(
      "--source and --target are both required (the host-wide guide reaches " +
        "the whole fleet — the target is never implicit)",
    );
  }
  let text = fs.readFileSync(source, "utf-8");
  // {{VAULT_PATH}} marker → host fact; unprovisioned env
  // keeps the marker — an honest template passthrough, never a guess.
  try {
    text = text.replaceAll("{{VAULT_PATH}}", configFromEnv().vaultPath);
  } catch {
    // no config — leave the marker as is
  }
  const written = writeHostWideGuideFragment(target, text);
  console.log(`render guide: ${written}`);
  return 0;
}

export function cmdRender(argv: string[]): number {
  const [sub, ...rest] = argv;
  try {
    switch (sub) {
      case "index":
        return renderIndex(rest);
      case "fragment":
        return renderFragment(rest);
      case "doctrine":
        return renderDoctrineCmd(rest);
      case "guide":
        return renderGuide(rest);
      default:
        throw new UsageError(
          `unknown render target: ${sub ?? "(none)"} (expected index | fragment | doctrine | guide)`,
        );
    }
  } catch (err) {
    if (err instanceof UsageError) {
      console.error(`iapeer-memory render: ${err.message}`);
      return 2;
    }
    throw err;
  }
}
