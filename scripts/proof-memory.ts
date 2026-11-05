/** Installed OC09 acceptance on synthetic data; no cloud credentials.
 * bun scripts/proof-memory.ts --artifacts <dir> [--memory-bin <absolute CLI>]
 * Native tools are driven by a deterministic loopback provider, not an LLM.
 * Both product CLIs/daemon and native runtimes are real installed executables.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

const arg = (k: string) => { const i = process.argv.indexOf(k); return i < 0 ? undefined : process.argv[i + 1]; };
const hostHome = os.homedir();
const memory = path.resolve(arg("--memory-bin") ?? path.join(hostHome, ".local/bin/iapeer-memory"));
const core = path.resolve(arg("--core-bin") ?? path.join(hostHome, ".local/bin/iapeer"));
const native = path.resolve(arg("--opencode-bin") ?? path.join(hostHome, ".opencode/bin/opencode"));
const claude = fs.realpathSync(path.resolve(arg("--claude-bin") ?? path.join(hostHome, ".local/bin/claude")));
const seed = path.resolve(arg("--seed-config") ?? path.join(hostHome, ".config/opencode"));
const artifacts = path.resolve(arg("--artifacts") ?? "dist/proofs/memory");
if (fs.existsSync(artifacts)) throw new Error(`use a new artifacts directory: ${artifacts}`);
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "im-native-")));
const home = path.join(root, "home"), iap = path.join(root, "iapeer"), vault = path.join(root, "vault");
const cwd = path.join(root, "ocmem"), state = path.join(root, "state");
for (const dir of [home, iap, vault, cwd, state]) fs.mkdirSync(dir, { recursive: true });
const results: Array<{ name: string; ok: boolean; detail?: unknown }> = [];
const wire: any[] = [];
const read = (p: string) => { try { return fs.readFileSync(p, "utf8"); } catch { return ""; } };
function hasCaller(value: any): boolean {
  if (typeof value === "string") { try { return hasCaller(JSON.parse(value.split("\n\n<system-reminder>")[0]!)); } catch { return false; } }
  if (!value || typeof value !== "object") return false;
  return value.caller_agent === "ocmem" || Object.values(value).some(hasCaller);
}
function check(name: string, ok: boolean, detail?: unknown) {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` ${JSON.stringify(detail).slice(0, 400)}` : ""}`);
  if (!ok) throw new Error(name);
}
async function until(name: string, f: () => unknown | Promise<unknown>, ms = 60_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await f()) return; await Bun.sleep(100); }
  throw new Error(`timeout: ${name}`);
}
function reservePort() { const s = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") }); const p = s.port!; s.stop(true); return p; }
const port = reservePort(), memPort = reservePort();
const env: Record<string, string> = {
  PATH: `${path.join(root, "bin")}:${path.dirname(core)}:${path.dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`,
  HOME: home, TERM: "xterm-256color", IAPEER_ROOT: iap,
  IAPEER_PORT: String(port), IAPEER_DAEMON_SOCKET: path.join(root, "router.sock"),
  IAPEER_SOCK_DIR: path.join(root, "s"), IAPEER_LAUNCHAGENTS_DIR: path.join(root, "LaunchAgents"),
  IAPEER_MEMORY_CONFIG_FILE: path.join(root, "config.env"), IAPEER_MEMORY_STATE_DIR: state,
  IAPEER_MEMORY_CACHE_DIR: path.join(root, "cache"), IAPEER_MEMORY_LOGS_DIR: path.join(root, "logs"),
  IAPEER_MEMORY_BINARY_PATH: memory, IAPEER_MEMORY_VAULT_PATH: vault,
  IAPEER_MEMORY_LOCALE: "en", IAPEER_MEMORY_MODE: "lean", IAPEER_MEMORY_MCP_PORT: String(memPort),
  IAPEER_MEMORY_SUPPRESS_IAP_SEND: "1", IAPEER_TEST_SANDBOX: "1",
  XDG_CONFIG_HOME: path.join(home, "config"), XDG_DATA_HOME: path.join(home, "data"),
  XDG_CACHE_HOME: path.join(home, "cache"), XDG_STATE_HOME: path.join(home, "state"),
  OPENCODE_DISABLE_DEFAULT_PLUGINS: "true", OPENCODE_DISABLE_MODELS_FETCH: "true", HOMEBREW_NO_AUTO_UPDATE: "1",
};
const cliLog: any[] = [];
async function run(bin: string, ...args: string[]) {
  const p = Bun.spawn([bin, ...args], { env, cwd, stdout: "pipe", stderr: "pipe", timeout: 180_000 });
  const [code, stdout, stderr] = await Promise.all([p.exited, new Response(p.stdout).text(), new Response(p.stderr).text()]);
  cliLog.push({ bin, args, code, stdout, stderr });
  if (code !== 0) throw new Error(`${path.basename(bin)} ${args.join(" ")}: ${code} ${stderr} ${stdout}`);
  return stdout.trim();
}
const secret = `SECRET_${crypto.randomBytes(8).toString("hex").toUpperCase()}`;
const note = path.join(vault, "01_Knowledge", "Native follow-up.md");
const provider = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
  const body = await req.json().catch(() => ({})) as any;
  wire.push(body);
  if (new URL(req.url).pathname.includes("count_tokens")) return Response.json({ input_tokens: 100 });
  if (!body.messages) return Response.json({});
  if (new URL(req.url).pathname.endsWith("/messages")) {
    const tools = body.tools?.map((t: any) => t.name) ?? [];
    const history = (body.messages ?? []).flatMap((m: any) => Array.isArray(m.content) ? m.content : []);
    const calls = history.filter((b: any) => b.type === "tool_use").map((b: any) => b.name);
    const search = tools.find((t: string) => /memory.*search/.test(t));
    let call: { name: string; input: unknown } | undefined;
    if (JSON.stringify(body.messages).includes("CROSS_RUNTIME_PROOF")) {
      if (!search && tools.includes("ToolSearch") && !calls.includes("ToolSearch")) call = { name: "ToolSearch", input: { query: "select:mcp__iapeer-memory__memory_search" } };
      else if (search && !calls.includes(search)) call = { name: search, input: { query: "Native follow-up" } };
      else if (!calls.includes("Read")) call = { name: "Read", input: { file_path: note } };
      else if (!calls.includes("Edit")) call = { name: "Edit", input: { file_path: note, old_string: "verified: yes", new_string: "verified: yes\ncross-runtime: yes" } };
    }
    const content = call ? [{ type: "tool_use", id: `toolu_${wire.length}`, ...call }] : [{ type: "text", text: "CROSS_DONE" }];
    const message = { id: `msg_${wire.length}`, type: "message", role: "assistant", model: body.model, content, stop_reason: call ? "tool_use" : "end_turn", stop_sequence: null, usage: { input_tokens: 100, output_tokens: 10 } };
    if (!body.stream) return Response.json(message);
    const event = (type: string, data: unknown) => `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
    let stream = event("message_start", { type: "message_start", message: { ...message, content: [], stop_reason: null } });
    for (const [index, block] of content.entries()) {
      stream += event("content_block_start", { type: "content_block_start", index, content_block: call ? { ...block, input: {} } : { type: "text", text: "" } });
      stream += event("content_block_delta", { type: "content_block_delta", index, delta: call ? { type: "input_json_delta", partial_json: JSON.stringify(call.input) } : { type: "text_delta", text: "CROSS_DONE" } });
      stream += event("content_block_stop", { type: "content_block_stop", index });
    }
    stream += event("message_delta", { type: "message_delta", delta: { stop_reason: message.stop_reason, stop_sequence: null }, usage: { output_tokens: 10 } });
    stream += event("message_stop", { type: "message_stop" });
    return new Response(stream, { headers: { "Content-Type": "text/event-stream" } });
  }
  const tools = body.tools?.map((t: any) => t.function?.name) ?? [];
  const isMain = JSON.stringify(body.messages).includes("NATIVE_MEMORY_PROOF") && tools.length > 0;
  const outputs = (body.messages ?? []).filter((m: any) => m.role === "tool");
  let call: { name: string; args: unknown } | undefined;
  if (isMain) {
    const calls = (body.messages ?? []).flatMap((m: any) => m.tool_calls ?? []).map((t: any) => t.function?.name);
    const search = tools.find((t: string) => /memory.*search/.test(t));
    const found = JSON.stringify(outputs).match(/SECRET_[A-F0-9]+/)?.[0];
    if (!calls.some((t: string) => /memory.*search/.test(t)) && search) call = { name: search, args: { query: "Hidden calibration" } };
    else if (found && !calls.includes("write")) call = { name: "write", args: { filePath: note, content: `---\ntags: [Testing]\n---\n\n# Native follow-up\n\ncode: ${found}\n` } };
    else if (found && !calls.includes("edit")) call = { name: "edit", args: { filePath: note, oldString: `code: ${found}`, newString: `code: ${found}\nverified: yes` } };
  }
  const id = `proof-${wire.length}`;
  const chunk = (delta: unknown, finish: string | null) => `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created: 1, model: "synthetic", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
  const delta = call ? { role: "assistant", tool_calls: [{ index: 0, id: `call_${wire.length}`, type: "function", function: { name: call.name, arguments: JSON.stringify(call.args) } }] } : { role: "assistant", content: "NATIVE_DONE" };
  return new Response(chunk(delta, null) + chunk({}, call ? "tool_calls" : "stop") + "data: [DONE]\n\n", { headers: { "Content-Type": "text/event-stream" } });
} });
Object.assign(env, {
  ANTHROPIC_BASE_URL: provider.url.origin, ANTHROPIC_AUTH_TOKEN: "synthetic-local-only", ANTHROPIC_MODEL: "claude-sonnet-4-5",
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", DISABLE_AUTOUPDATER: "1",
});
let memd: ReturnType<typeof Bun.spawn> | undefined, daemon: ReturnType<typeof Bun.spawn> | undefined;
let success = false;
try {
  check("installed memory signature", Bun.spawnSync(["/usr/bin/codesign", "--verify", "--strict", memory]).exitCode === 0);
  const version = await run(memory, "version");
  fs.mkdirSync(path.join(home, "config/opencode"), { recursive: true });
  for (const entry of ["node_modules", "package.json", "package-lock.json"]) {
    fs.cpSync(path.join(seed, entry), path.join(home, "config/opencode", entry), { recursive: true });
  }
  // The native runtime (including all hook subprocesses) cannot read host
  // credentials/vault or send to a cloud endpoint, even if config drifts.
  const profile = path.join(root, "native.sb");
  fs.writeFileSync(profile, `(version 1)\n(allow default)\n(deny network-outbound)\n(allow network-outbound (remote ip "localhost:*"))\n(deny file-read* file-write* (subpath ${JSON.stringify(hostHome)}))\n(allow file-read* (literal ${JSON.stringify(native)}) (literal ${JSON.stringify(claude)}) (literal ${JSON.stringify(memory)}) (literal ${JSON.stringify(core)}) (subpath ${JSON.stringify(path.dirname(process.execPath))}))\n(allow file-read* file-write* (subpath ${JSON.stringify(root)}))\n`);
  fs.mkdirSync(path.join(root, "bin"));
  const wrapper = path.join(root, "bin/opencode");
  fs.writeFileSync(wrapper, `#!/bin/sh\nexec /usr/bin/sandbox-exec -f '${profile}' '${native}' "$@"\n`, { mode: 0o755 });
  env.IAPEER_OPENCODE_BIN = wrapper;
  const claudeWrapper = path.join(root, "bin/claude");
  fs.writeFileSync(claudeWrapper, `#!/bin/sh\nexec /usr/bin/sandbox-exec -f '${profile}' '${claude}' "$@"\n`, { mode: 0o755 });
  env.IAPEER_CLAUDE_BIN = claudeWrapper;
  fs.writeFileSync(path.join(home, ".claude.json"), JSON.stringify({ hasCompletedOnboarding: true, theme: "dark", bypassPermissionsModeAccepted: true }));
  // Negative controls establish the boundary, not just a clean HOME.
  const allowed = Bun.spawnSync(["/usr/bin/sandbox-exec", "-f", profile, "/usr/bin/true"], { env });
  check("OS boundary profile compiles and allows execution", allowed.exitCode === 0, allowed.stderr.toString());
  const denied = Bun.spawnSync(["/usr/bin/sandbox-exec", "-f", profile, "/bin/cat", path.join(hostHome, ".iapeer/peers-profiles.json")], { env });
  check("OS boundary denies host registry read", denied.exitCode !== 0);
  // -v exposes the kernel's EPERM (quiet curl and Bun's net API report only
  // a generic connection failure). The denied connect sends no API request.
  const outbound = Bun.spawnSync(["/usr/bin/sandbox-exec", "-f", profile, "/usr/bin/curl", "-sv", "--noproxy", "*", "--connect-timeout", "2", "https://1.1.1.1"], { env, cwd: root, timeout: 5000 });
  check("OS boundary denies external connect with EPERM", outbound.exitCode === 7 && /Operation not permitted/.test(outbound.stderr.toString()), outbound.stderr.toString());
  await run(memory, "init", "--vault", vault, "--locale", "en", "--skip-deps", "--skip-ecosystem", "--skip-binary");
  fs.appendFileSync(path.join(vault, "99_System/Tags.md"), "\n| Testing | synthetic acceptance |\n");
  fs.writeFileSync(path.join(vault, "01_Knowledge/Hidden calibration.md"), `---\ntags: [Testing]\n---\n\n# Hidden calibration\n\nThe calibration code is ${secret}.\n`);
  memd = Bun.spawn([memory, "memoryd"], { env, cwd, stdout: Bun.file(path.join(root, "memoryd.out")), stderr: Bun.file(path.join(root, "memoryd.err")) });
  await until("memoryd ready before peer birth", () => fs.existsSync(path.join(state, "memoryd.heartbeat")));
  await run(core, "create", "ocmem", "--runtime", "opencode", "--path", cwd, "--bin", wrapper);
  await run(core, "create", "proof", "--runtime", "opencode", "--path", path.join(root, "proof"), "--bin", wrapper);
  const privateDir = await run(core, "private-dir", "ocmem", "--runtime", "opencode");
  check("birth provision uses core private directory", fs.existsSync(path.join(privateDir, "iapeer-memory.json")));
  const fragment = path.join(cwd, ".iapeer/fragments/iapeer-memory.md");
  await until("birth fragment without vault edit or verify", () => read(fragment).includes(vault), 35_000);
  check("newborn receives paths and author index", read(fragment).includes("ocmem"), read(fragment).slice(0, 200));
  fs.writeFileSync(path.join(privateDir, "opencode.json"), JSON.stringify({ model: "synthetic/synthetic", small_model: "synthetic/synthetic", enabled_providers: ["synthetic"], provider: { synthetic: { npm: "@ai-sdk/openai-compatible", name: "Synthetic", options: { baseURL: provider.url.origin + "/v1", apiKey: "synthetic-only" }, models: { synthetic: { name: "Synthetic", limit: { context: 100000, output: 3000 } } } } } }));
  daemon = Bun.spawn([core, "daemon"], { env, cwd, stdout: Bun.file(path.join(root, "daemon.out")), stderr: Bun.file(path.join(root, "daemon.err")) });
  await until("installed core daemon", () => read(path.join(root, "daemon.err")).includes("daemon READY"));
  await run(core, "send", "ocmem", "--runtime", "opencode", "--from", "opencode-proof", "--message", "NATIVE_MEMORY_PROOF: find Hidden calibration in team memory and record it using native write/edit.");
  await until("native write and edit with hook stamping", () => read(note).includes("verified: yes") && /last_edited_by:\s*ocmem/.test(read(note)), 120_000);
  check("unknown code travels through real MCP search into native writes", read(note).includes(secret));
  check("native hook attributes author and editor to personality", /author:\s*ocmem/.test(read(note)) && /last_edited_by:\s*ocmem/.test(read(note)), read(note));
  check("guide and newborn index reach native provider", wire.some((b) => { const sys = JSON.stringify(b.messages?.filter((m: any) => m.role === "system")); return sys.includes(vault) && sys.includes("ocmem") && sys.includes("shared memory"); }));
  const events = read(path.join(privateDir, "events.jsonl"));
  check("native journal records memory_search, write and edit", ["memory_search", '"tool":"write"', '"tool":"edit"'].every((s) => events.includes(s)));
  await until("author index includes new note before second-runtime launch", () => read(fragment).includes("[[Native follow-up]]"));
  await run(core, "stop", "ocmem", "opencode", "--force");
  await run(core, "add-runtime", "claude", "--peer", "ocmem");
  await run(core, "send", "ocmem", "--runtime", "claude", "--from", "opencode-proof", "--message", "CROSS_RUNTIME_PROOF: search Native follow-up, read it and mark cross-runtime: yes using native Edit.");
  await until("same personality edits via native Claude and finishes stamping", () => read(note).includes("cross-runtime: yes") && /last_edited_by:\s*ocmem/.test(read(note)), 120_000);
  check("cross-runtime author stays personality, not runtime", /author:\s*ocmem/.test(read(note)) && /last_edited_by:\s*ocmem/.test(read(note)), read(note));
  check("second runtime discovers memory MCP and receives refreshed author index", wire.some((b) => b.system && JSON.stringify(b.system).includes("[[Native follow-up]]") && JSON.stringify(b.tools).includes("memory_search")));
  check("second runtime search resolves the same caller personality", wire.some((b) => b.system && hasCaller(b.messages)));
  await run(core, "stop", "ocmem", "claude", "--force");
  env.IAPEER_PRIVATE_DIR = privateDir;
  await run(memory, "unprovision-peer", "--cwd", cwd, "--runtime", "opencode", "--personality", "ocmem");
  check("off removes only memory private surfaces", !fs.existsSync(path.join(privateDir, "iapeer-memory.json")) && !fs.existsSync(path.join(privateDir, "iapeer-memory-plugin.mjs")) && fs.existsSync(path.join(privateDir, "opencode.json")));
  await run(memory, "unprovision-peer", "--cwd", cwd, "--runtime", "opencode", "--personality", "ocmem");
  success = true;
  check("installed version recorded", true, version);
} catch (error) {
  results.push({ name: "harness", ok: false, detail: String(error) });
  console.error(error);
} finally {
  // Never discover/kill a fleet: the only supervisor named here is our own.
  try { await run(core, "supervisor", "kill", "opencode-ocmem", "--run-dir", path.join(iap, "state/supervisor")); } catch {}
  try { await run(core, "supervisor", "kill", "claude-ocmem", "--run-dir", path.join(iap, "state/supervisor")); } catch {}
  for (const p of [daemon, memd]) if (p) { p.kill("SIGTERM"); const timer = setTimeout(() => p.kill("SIGKILL"), 5000); await p.exited; clearTimeout(timer); }
  provider.stop(true);
  fs.mkdirSync(artifacts, { recursive: true });
  fs.cpSync(root, path.join(artifacts, "raw"), { recursive: true, filter: (p) => !p.split(path.sep).includes("node_modules") && !fs.lstatSync(p).isSocket() });
  fs.writeFileSync(path.join(artifacts, "wire.json"), JSON.stringify(wire, null, 2));
  fs.writeFileSync(path.join(artifacts, "cli.json"), JSON.stringify(cliLog, null, 2));
  const hash = (p: string) => crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
  fs.writeFileSync(path.join(artifacts, "result.json"), JSON.stringify({ success, memory, core, native, claude, memorySHA256: hash(memory), coreSHA256: hash(core), opencodeSHA256: hash(native), claudeSHA256: hash(claude), results }, null, 2));
  fs.rmSync(root, { recursive: true, force: true });
  console.log(`artifacts: ${artifacts}`);
}
process.exit(success ? 0 : 1);
