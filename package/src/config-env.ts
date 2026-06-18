/**
 * Package config loader — env-format file (`KEY=VALUE`), applied into
 * `process.env` with CONVENTIONAL precedence:
 *
 *     CLI flags  >  process env  >  config file  >  built-in defaults
 *
 * i.e. a key already present (non-empty) in the process env is NOT
 * overwritten by the file. NB: this deliberately diverges from the
 * reference-implementation bootstrap, whose `set -a; source config.env` ran AFTER the
 * parent env and silently overrode it (documented as a legacy pitfall);
 * here an operator's explicit `IAPEER_MEMORY_*=` always wins.
 *
 * Accepted lines: blank, `# comment`, `KEY=VALUE`, `export KEY=VALUE`.
 * A VALUE wrapped in matching single or double quotes is unwrapped (one
 * level, no escape processing — this is a config file, not a shell).
 */

import fs from "node:fs";

const LINE_RE = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/;

export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const m = LINE_RE.exec(line);
    if (!m) continue; // not KEY=VALUE — ignored, never a parse failure
    let value = m[2].trim();
    if (
      value.length >= 2 &&
      (value[0] === '"' || value[0] === "'") &&
      value.endsWith(value[0])
    ) {
      value = value.slice(1, -1);
    }
    out[m[1]] = value;
  }
  return out;
}

export type LoadResult = {
  /** File absent — a valid state (defaults apply), never an error. */
  missing: boolean;
  /** Keys applied into the env. */
  applied: string[];
  /** Keys present in the file but already set in the env (env wins). */
  shadowed: string[];
};

export function loadConfigFile(
  filePath: string,
  env: Record<string, string | undefined> = process.env,
): LoadResult {
  let text: string;
  try {
    text = fs.readFileSync(filePath, "utf-8");
  } catch {
    return { missing: true, applied: [], shadowed: [] };
  }
  const parsed = parseEnvFile(text);
  const applied: string[] = [];
  const shadowed: string[] = [];
  for (const [key, value] of Object.entries(parsed)) {
    const existing = env[key];
    if (typeof existing === "string" && existing.length > 0) {
      shadowed.push(key);
      continue;
    }
    env[key] = value;
    applied.push(key);
  }
  return { missing: false, applied, shadowed };
}
