/**
 * The package version — the SINGLE source for the doctrine version marker
 * (ADR-010) and for the manifest sync (docs/10 §Версионная синхронизация).
 *
 * STATIC json import, not a runtime fs read: the CLI also ships as a
 * `bun build --compile` binary (P3), where `import.meta.url` resolves into
 * the bundled `/$bunfs/` filesystem and `../package.json` does not exist —
 * proven by the P3a compile fact-check. A static import is embedded by the
 * bundler and works identically in source-run and compiled modes.
 */

import pkg from "../package.json";

export function packageVersion(): string {
  if (!pkg.version) throw new Error("package.json has no version field");
  return pkg.version;
}
