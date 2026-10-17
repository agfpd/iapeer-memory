/** Self-contained OpenCode plugin. No package imports at session time: the
 * installed CLI owns stamping, tag teaching and hints for every runtime.
 * Keep this factory closure-free: its JS is embedded in the owned .mjs. */
async function openCodeHooks(
  context: { directory: string },
  options: { binary: string },
) {
  const { spawn } = await import("node:child_process");
  const invoke = (verb: string, event: unknown): Promise<string> => new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    const child = spawn(options.binary, ["hook", verb], {
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 10_000,
    });
    child.stdout.on("data", (chunk) => { stdout = (stdout + chunk).slice(-65_536); });
    child.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-2048); });
    child.on("error", (err) => resolve(`[iapeer-memory] hook unavailable: ${err.message}`));
    child.stdin.on("error", () => {}); // an early exit must not crash OpenCode (EPIPE)
    child.on("close", (code) => {
      if (code !== 0) return resolve(`[iapeer-memory] hook failed (${code}): ${stderr}`);
      if (verb === "session-start") return resolve(stdout.trim());
      try {
        resolve(JSON.parse(stdout).hookSpecificOutput?.additionalContext ?? "");
      } catch {
        resolve(""); // healthy writes deliberately have no output
      }
    });
    child.stdin.end(JSON.stringify(event));
  });
  const health = await invoke("session-start", {});
  return {
    "experimental.chat.system.transform": async (_input: unknown, output: { system: string[] }) => {
      if (health) output.system.push(health);
    },
    "tool.execute.after": async (
      input: { tool: string; args: unknown },
      output: { output: string; metadata?: unknown },
    ) => {
      if (!["write", "edit", "apply_patch", "bash"].includes(input.tool)) return;
      try {
        const hint = await invoke("post-write", {
          tool_name: `opencode:${input.tool}`,
          tool_input: input.args,
          tool_response: output.output,
          cwd: context.directory,
        });
        if (hint) output.output += `\n\n${hint}`;
      } catch (err) {
        // Fail-open, but visible: a successful file write must not be lost,
        // nor a missing attribution mechanism silently called healthy.
        output.output += `\n\n[iapeer-memory] hook failed: ${String(err)}`;
      }
    },
  };
}

export const OPENCODE_PLUGIN_MARKER = "// iapeer-memory owned OpenCode attribution plugin";

export function openCodePluginSource(binary: string): string {
  return `${OPENCODE_PLUGIN_MARKER}\nexport default (context) => (${openCodeHooks.toString()})(context, ${JSON.stringify({ binary })});\n`;
}
