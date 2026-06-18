/**
 * Terminal styling for CLI status output — a small ANSI helper shared by every
 * command that prints status lines (init / update / verify / status /
 * provision-peer / uninstall). The palette mirrors the iapeer onboard wizard
 * (its src/tui/ansi.ts) so a fresh install reads as ONE consistent surface:
 * the onboard wizard runs `iapeer-memory init` as an inherited-stdio child, so
 * this output lands on the user's real terminal right beside the wizard's.
 *
 * Honest TTY gate (agreed with iapeer): color ONLY when stdout is a real
 * terminal — or FORCE_COLOR is set — and NEVER when NO_COLOR is present (the
 * user's explicit opt-out always wins). Piped/captured output (tests, CI, a
 * file) stays plain, byte-for-byte as before. Level-1 (16-color) SGR only —
 * maximally portable; no truecolor.
 */

const SGR = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  gray: "\x1b[90m",
} as const;

/** Color when a real TTY or FORCE_COLOR; NO_COLOR (any value) always disables. */
export function colorEnabled(stream: { isTTY?: boolean } = process.stdout): boolean {
  if (process.env.NO_COLOR != null) return false;
  const force = process.env.FORCE_COLOR;
  if (force != null && force !== "" && force !== "0" && force !== "false") return true;
  return Boolean(stream.isTTY);
}

function paint(code: string, text: string): string {
  // Re-evaluated per call (cheap) so env/tty changes are honoured live (tests).
  return colorEnabled() ? `${code}${text}${SGR.reset}` : text;
}

/** Color helpers — each a no-op when color is disabled. Composition nests:
 *  the inner reset ends early, so wrap the SMALLER span inside the larger. */
export const ui = {
  bold: (s: string) => paint(SGR.bold, s),
  dim: (s: string) => paint(SGR.dim, s),
  red: (s: string) => paint(SGR.red, s),
  green: (s: string) => paint(SGR.green, s),
  yellow: (s: string) => paint(SGR.yellow, s),
  cyan: (s: string) => paint(SGR.cyan, s),
  gray: (s: string) => paint(SGR.gray, s),
};

/** Semantic line status → shared palette. `skip` is gray (neutral/not-done);
 *  `warn` is yellow (reserved for an actual caution). */
export type LineStatus = "ok" | "fail" | "skip" | "warn";

/** Paint a status TOKEN in place — the layout/text is untouched, only colored. */
export function paintStatus(status: LineStatus, token: string): string {
  switch (status) {
    case "ok":
      return ui.green(token);
    case "fail":
      return ui.red(token);
    case "warn":
      return ui.yellow(token);
    case "skip":
      return ui.gray(token);
  }
}
