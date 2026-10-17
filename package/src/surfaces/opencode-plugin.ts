/** Self-contained OpenCode plugin. No package imports at session time: the
 * installed CLI owns stamping, tag teaching and hints for every runtime.
 *
 * The body is a STATIC JS literal, not `Function.toString()`: the source
 * form (bun transpiling TS, e.g. an `npm exec` update) and the compiled
 * binary (bundler renames like `options` → `options2`) stringify the same
 * function differently, so provision by one and the bytes-compare check by
 * the other flapped as permanent drift (0.4.24 live deploy, 18.10.2026).
 * A literal is identical in every runtime by construction. */

export const OPENCODE_PLUGIN_MARKER = "// iapeer-memory owned OpenCode attribution plugin";

const PLUGIN_BODY = `async function openCodeHooks(context, options) {
  const { spawn } = await import("node:child_process");
  const invoke = (verb, event) => new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    const child = spawn(options.binary, ["hook", verb], {
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 10000,
    });
    child.stdout.on("data", (chunk) => { stdout = (stdout + chunk).slice(-65536); });
    child.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-2048); });
    child.on("error", (err) => resolve("[iapeer-memory] hook unavailable: " + err.message));
    child.stdin.on("error", () => {}); // an early exit must not crash OpenCode (EPIPE)
    child.on("close", (code) => {
      if (code !== 0) return resolve("[iapeer-memory] hook failed (" + code + "): " + stderr);
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
    "experimental.chat.system.transform": async (_input, output) => {
      if (health) output.system.push(health);
    },
    "tool.execute.after": async (input, output) => {
      if (!["write", "edit", "apply_patch", "bash"].includes(input.tool)) return;
      try {
        const hint = await invoke("post-write", {
          tool_name: "opencode:" + input.tool,
          tool_input: input.args,
          tool_response: output.output,
          cwd: context.directory,
        });
        if (hint) output.output += "\\n\\n" + hint;
      } catch (err) {
        // Fail-open, but visible: a successful file write must not be lost,
        // nor a missing attribution mechanism silently called healthy.
        output.output += "\\n\\n[iapeer-memory] hook failed: " + String(err);
      }
    },
  };
}`;

export function openCodePluginSource(binary: string): string {
  return `${OPENCODE_PLUGIN_MARKER}\nexport default (context) => (${PLUGIN_BODY})(context, ${JSON.stringify({ binary })});\n`;
}
