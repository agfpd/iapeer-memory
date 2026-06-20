/**
 * Shared stderr logger.
 *
 * stdout is reserved for MCP JSON-RPC (server.ts only writes JSON frames
 * there); everything diagnostic — both the MCP frontend and the writer
 * daemon — funnels through here so a single grep on stderr captures the
 * full picture. The `[iapeer-memory <kind>]` prefix lets log aggregators
 * distinguish reader and writer processes when their stderr is interleaved in
 * a shared pane.
 */

export type Logger = {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
};

export function makeLogger(kind: "mcp" | "memoryd"): Logger {
  // `mcp` keeps a stable `[iapeer-memory]` prefix that downstream tooling
  // (status skill, monitor scripts) greps for. New processes
  // get an explicit kind so logs can be filtered.
  const tag = kind === "mcp" ? "iapeer-memory" : `iapeer-memory ${kind}`;
  return {
    info: (msg) => process.stderr.write(`[${tag}] ${msg}\n`),
    warn: (msg) => process.stderr.write(`[${tag} WARN] ${msg}\n`),
    error: (msg) => process.stderr.write(`[${tag} ERROR] ${msg}\n`),
  };
}
