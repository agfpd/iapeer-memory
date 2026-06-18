/**
 * `iapeer-memory fm-update` — argv glue for the core `fmUpdate` engine.
 * The contract is fixed in the core module header (core/src/fm-update.ts):
 *
 *     iapeer-memory fm-update [--agent NAME] [--vault PATH] [--no-stamp]
 *       [--set KEY VALUE | --unset KEY | --list-add KEY VALUE
 *        | --list-remove KEY VALUE]...
 *       FILE [FILE ...]
 *
 * - identity: `--agent` → PEER_PERSONALITY → IAPEER_MEMORY_AGENT_NAME
 *   (resolveAgentName, нюанс 10 — never guessed from cwd);
 * - with no operations it is a pure attribution stamp;
 * - taxonomy/curator-set come from the env context (config file already
 *   loaded by the CLI boot), NOT from configFromEnv — fm-update must work
 *   on explicit paths without a provisioned vault env.
 */

import {
  collectOps,
  DEFAULT_CURATOR_SET,
  fmUpdate,
  getTaxonomy,
  isLocaleId,
  resolveAgentName,
} from "@agfpd/iapeer-memory-core";

export function cmdFmUpdate(argv: string[]): number {
  let agent: string | null = null;
  let vault = "";
  let stamp = true;
  const set: Array<[string, string]> = [];
  const unset: string[] = [];
  const listAdd: Array<[string, string]> = [];
  const listRemove: Array<[string, string]> = [];
  const files: string[] = [];

  const take = (flag: string, i: number): string => {
    const v = argv[i];
    if (v === undefined) throw new UsageError(`${flag} requires a value`);
    return v;
  };

  try {
    for (let i = 0; i < argv.length; i++) {
      const a = argv[i];
      switch (a) {
        case "--agent":
          agent = take(a, ++i);
          break;
        case "--vault":
          vault = take(a, ++i);
          break;
        case "--no-stamp":
          stamp = false;
          break;
        case "--set":
          set.push([take(a, ++i), take(a, ++i)]);
          break;
        case "--unset":
          unset.push(take(a, ++i));
          break;
        case "--list-add":
          listAdd.push([take(a, ++i), take(a, ++i)]);
          break;
        case "--list-remove":
          listRemove.push([take(a, ++i), take(a, ++i)]);
          break;
        default:
          if (a.startsWith("--")) throw new UsageError(`unknown flag: ${a}`);
          files.push(a);
      }
    }
    if (!files.length) throw new UsageError("no files given");
  } catch (err) {
    if (err instanceof UsageError) {
      console.error(`iapeer-memory fm-update: ${err.message}`);
      return 2;
    }
    throw err;
  }

  const localeRaw = process.env.IAPEER_MEMORY_LOCALE || "en";
  if (!isLocaleId(localeRaw)) {
    console.error(`iapeer-memory fm-update: unknown locale "${localeRaw}"`);
    return 2;
  }
  const curatorSet = (process.env.IAPEER_MEMORY_CURATOR_SET || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  fmUpdate({
    files,
    ops: collectOps({ set, unset, listAdd, listRemove }),
    agent: resolveAgentName(agent),
    vault: vault || process.env.IAPEER_MEMORY_VAULT_PATH || "",
    taxonomy: getTaxonomy(localeRaw),
    curatorSet: curatorSet.length ? curatorSet : DEFAULT_CURATOR_SET,
    stamp,
  });
  return 0;
}

class UsageError extends Error {}
