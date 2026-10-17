/** OpenCode surfaces are PRIVATE to personality/runtime, not project cwd.
 * The iapeer adapter merges this JSON into OPENCODE_CONFIG_CONTENT on each
 * launch. It must fail loudly on an invalid present fragment. The core
 * owns prompt composition; this product owns MCP and the write plugin.
 * Never write project/global OpenCode configs: peers can share a cwd. */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { guardedUnlinkSync } from "@agfpd/iapeer-memory-core";
import { memoryPaths } from "../paths.js";
import { readJsonObject, sameJson, writeFileAtomic, type SurfaceOutcome } from "./claude.js";
import { openCodePluginSource, OPENCODE_PLUGIN_MARKER } from "./opencode-plugin.js";

/** `privateDir`: the core-supplied runtime-private directory (slot env
 *  `IAPEER_PRIVATE_DIR` / `{privateDir}`) — authoritative when given. Paths
 *  without the core (sweep/verify) fall back to the documented layout
 *  `<root>/state/opencode/<p>/` (iapeer docs/20, ABI as of core 7e41813). */
type Options = { personality: string; root?: string; privateDir?: string };
type ProvisionOptions = Options & { port: number; binary?: string };

export function openCodePaths(opts: Options): { config: string; plugin: string } {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(opts.personality)) {
    throw new Error("OpenCode surfaces require a valid --personality (no path segments)");
  }
  const dir = opts.privateDir ?? openCodePrivateDir(opts.root ?? path.dirname(memoryPaths().slotPath), opts.personality);
  return { config: path.join(dir, "iapeer-memory.json"), plugin: path.join(dir, "iapeer-memory-plugin.mjs") };
}

export function openCodePrivateDir(iapeerRoot: string, personality: string): string {
  return path.join(iapeerRoot, "state", "opencode", personality);
}

export function expectedOpenCodeMcp(port: number): Record<string, unknown> {
  return {
    type: "remote", url: `http://127.0.0.1:${port}/mcp`, enabled: true, oauth: false,
    headers: { "X-IAPeer-Identity": "{env:PEER_IDENTITY}" },
  };
}

function editConfig(opts: Options & { port?: number }, remove: boolean): SurfaceOutcome {
  const paths = openCodePaths(opts);
  const result = (action: SurfaceOutcome["action"], detail?: string): SurfaceOutcome =>
    ({ surface: "mcp", action, path: paths.config, detail });
  const current = readJsonObject(paths.config);
  if (current === null) return result("failed", "not a JSON object — refusing to clobber");
  if (current === "absent" && remove) return result("absent");
  const obj = current === "absent" ? {} : current;
  const before = JSON.stringify(obj);
  if ((obj.mcp !== undefined && (!obj.mcp || typeof obj.mcp !== "object" || Array.isArray(obj.mcp))) ||
      (obj.plugin !== undefined && !Array.isArray(obj.plugin))) {
    return result("failed", "mcp/plugin has invalid shape — refusing to clobber");
  }
  const mcp = (obj.mcp ?? {}) as Record<string, unknown>;
  const plugin = (obj.plugin ?? []) as unknown[];
  const url = pathToFileURL(paths.plugin).href;
  if (remove) {
    delete mcp["iapeer-memory"];
    const kept = plugin.filter((p) => p !== url);
    if (Object.keys(mcp).length) obj.mcp = mcp; else delete obj.mcp;
    if (kept.length) obj.plugin = kept; else delete obj.plugin;
  } else {
    mcp["iapeer-memory"] = expectedOpenCodeMcp(opts.port!);
    obj.mcp = mcp;
    obj.plugin = [...plugin.filter((p) => p !== url), url];
  }
  if (before === JSON.stringify(obj)) return result(remove ? "absent" : "already");
  if (remove && !Object.keys(obj).length) guardedUnlinkSync(paths.config);
  else writeFileAtomic(paths.config, JSON.stringify(obj, null, 2) + "\n");
  return result(remove ? "removed" : "written");
}

export function provisionOpenCodePeer(opts: ProvisionOptions): SurfaceOutcome[] {
  const paths = openCodePaths(opts);
  const source = openCodePluginSource(opts.binary ?? memoryPaths().binaryPath);
  let current: string | null = null;
  try { current = fs.readFileSync(paths.plugin, "utf-8"); } catch { /* absent */ }
  if (current !== null && !current.startsWith(OPENCODE_PLUGIN_MARKER + "\n")) {
    return [{ surface: "hooks", action: "failed", path: paths.plugin, detail: "foreign file at plugin path — refusing to clobber" }];
  }
  // Plugin first, so config never points into a void.
  if (current !== source) writeFileAtomic(paths.plugin, source);
  return [
    { surface: "hooks", action: current === source ? "already" : "written", path: paths.plugin },
    editConfig(opts, false),
  ];
}

export function unprovisionOpenCodePeer(opts: Options): SurfaceOutcome[] {
  const paths = openCodePaths(opts);
  const mcp = editConfig(opts, true);
  // A failed config removal keeps the referenced plugin intact.
  if (mcp.action === "failed") return [mcp];
  let current: string;
  try { current = fs.readFileSync(paths.plugin, "utf-8"); } catch {
    return [mcp, { surface: "hooks", action: "absent", path: paths.plugin }];
  }
  if (!current.startsWith(OPENCODE_PLUGIN_MARKER + "\n")) {
    return [mcp, { surface: "hooks", action: "failed", path: paths.plugin, detail: "foreign file — left intact" }];
  }
  guardedUnlinkSync(paths.plugin);
  return [mcp, { surface: "hooks", action: "removed", path: paths.plugin }];
}

export function checkOpenCodePeer(opts: ProvisionOptions): Array<{ surface: SurfaceOutcome["surface"]; ok: boolean; detail: string }> {
  const paths = openCodePaths(opts);
  const obj = readJsonObject(paths.config);
  const valid = obj !== null && obj !== "absent";
  const mcp = valid ? (obj.mcp as Record<string, unknown> | undefined)?.["iapeer-memory"] : undefined;
  const plugins = valid && Array.isArray(obj.plugin) ? obj.plugin : [];
  let text = "";
  try { text = fs.readFileSync(paths.plugin, "utf-8"); } catch { /* absent */ }
  return [
    { surface: "mcp", ok: sameJson(mcp, expectedOpenCodeMcp(opts.port)), detail: paths.config },
    { surface: "hooks", ok: plugins.filter((p) => p === pathToFileURL(paths.plugin).href).length === 1 &&
      text === openCodePluginSource(opts.binary ?? memoryPaths().binaryPath), detail: paths.plugin },
  ];
}
