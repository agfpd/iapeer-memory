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
const seed = path.resolve(arg("--seed-config") ?? path.join(hostHome, ".config/opencode"));
const artifacts = path.resolve(arg("--artifacts") ?? "dist/proofs/memory");
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "im-native-")));
const home = path.join(root, "home"), iap = path.join(root, "iapeer"), vault = path.join(root, "vault");
const cwd = path.join(root, "ocmem"), state = path.join(root, "state");
for (const dir of [home, iap, vault, cwd, state]) fs.mkdirSync(dir, { recursive: true });
const results: Array<{ name: string; ok: boolean; detail?: unknown }> = [];
const wire: any[] = [];
const read = (p: string) => { try { return fs.readFileSync(p, "utf8"); } catch { return ""; } };
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
  const p = Bun.spawn([bin, ...args], { env, cwd, stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([p.exited, new Response(p.stdout).text(), new Response(p.stderr).text()]);
  cliLog.push({ bin, args, code, stdout, stderr });
  if (code !== 0) throw new Error(`${path.basename(bin)} ${args.join(" ")}: ${code} ${stderr} ${stdout}`);
  return stdout.trim();
}
const secret = `SECRET_${crypto.randomBytes(8).toString("hex").toUpperCase()}`;
const note = path.join(vault, "01_Knowledge", "Native follow-up.md");
const provider = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
  const body = await req.json() as any;
  wire.push(body);
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
let memd: ReturnType<typeof Bun.spawn> | undefined, daemon: ReturnType<typeof Bun.spawn> | undefined;
let success = false;
try {
  check("installed memory signature", Bun.spawnSync(["/usr/bin/codesign", "--verify", "--strict", memory]).exitCode === 0);
  const version = await run(memory, "version");
  fs.cpSync(seed, path.join(home, "config/opencode"), { recursive: true });
  // The native runtime (including all hook subprocesses) cannot read host
  // credentials/vault or send to a cloud endpoint, even if config drifts.
  const profile = path.join(root, "native.sb");
  fs.writeFileSync(profile, `(version 1)\n(allow default)\n(deny network-outbound)\n(allow network-outbound (remote ip "127.0.0.1:*"))\n(deny file-read* file-write* (subpath ${JSON.stringify(hostHome)}))\n(allow file-read* (literal ${JSON.stringify(native)}) (literal ${JSON.stringify(memory)}) (literal ${JSON.stringify(core)}) (subpath ${JSON.stringify(path.dirname(process.execPath))}))\n(allow file-read* file-write* (subpath ${JSON.stringify(root)}))\n`);
  fs.mkdirSync(path.join(root, "bin"));
  const wrapper = path.join(root, "bin/opencode");
  fs.writeFileSync(wrapper, `#!/bin/sh\nexec /usr/bin/sandbox-exec -f '${profile}' '${native}' "$@"\n`, { mode: 0o755 });
  env.IAPEER_OPENCODE_BIN = wrapper;
  // Negative controls establish the boundary, not just a clean HOME.
  const denied = Bun.spawnSync(["/usr/bin/sandbox-exec", "-f", profile, "/bin/cat", path.join(hostHome, ".iapeer/peers-profiles.json")], { env });
  check("OS boundary denies host registry read", denied.exitCode !== 0);
  await run(memory, "init", "--vault", vault, "--locale", "en", "--skip-deps", "--skip-ecosystem", "--skip-binary");
  fs.appendFileSync(path.join(vault, "99_System/Tags.md"), "\nTesting — synthetic acceptance\n");
  fs.writeFileSync(path.join(vault, "01_Knowledge/Hidden calibration.md"), `---\ntags: [Testing]\n---\n\n# Hidden calibration\n\nThe calibration code is ${secret}.\n`);
  memd = Bun.spawn([memory, "memoryd"], { env, cwd, stdout: Bun.file(path.join(root, "memoryd.out")), stderr: Bun.file(path.join(root, "memoryd.err")) });
  await until("memoryd ready before peer birth", () => fs.existsSync(path.join(state, "memoryd.heartbeat")));
  await run(core, "create", "ocmem", "--runtime", "opencode", "--path", cwd, "--bin", wrapper);
  const privateDir = await run(core, "private-dir", "ocmem", "--runtime", "opencode");
  check("birth provision uses core private directory", fs.existsSync(path.join(privateDir, "iapeer-memory.json")));
  const fragment = path.join(cwd, ".iapeer/fragments/iapeer-memory.md");
  await until("birth fragment without vault edit or verify", () => read(fragment).includes(vault), 35_000);
  check("newborn receives paths and author index", read(fragment).includes("ocmem"), read(fragment).slice(0, 200));
  fs.writeFileSync(path.join(privateDir, "opencode.json"), JSON.stringify({ model: "synthetic/synthetic", small_model: "synthetic/synthetic", enabled_providers: ["synthetic"], provider: { synthetic: { npm: "@ai-sdk/openai-compatible", name: "Synthetic", options: { baseURL: provider.url.origin + "/v1", apiKey: "synthetic-only" }, models: { synthetic: { name: "Synthetic", limit: { context: 100000, output: 3000 } } } } } }));
  daemon = Bun.spawn([core, "daemon"], { env, cwd, stdout: Bun.file(path.join(root, "daemon.out")), stderr: Bun.file(path.join(root, "daemon.err")) });
  await until("installed core daemon", () => read(path.join(root, "daemon.err")).includes("daemon READY"));
  await run(core, "send", "ocmem", "--runtime", "opencode", "--from", "opencode-ocmem", "--message", "NATIVE_MEMORY_PROOF: find Hidden calibration in team memory and record it using native write/edit.");
  await until("native write and edit with hook stamping", () => read(note).includes("verified: yes") && /last_edited_by:\s*ocmem/.test(read(note)), 120_000);
  check("unknown code travels through real MCP search into native writes", read(note).includes(secret));
  check("native hook attributes author and editor to personality", /author:\s*ocmem/.test(read(note)) && /last_edited_by:\s*ocmem/.test(read(note)), read(note));
  check("guide and newborn index reach native provider", wire.some((b) => { const sys = JSON.stringify(b.messages?.filter((m: any) => m.role === "system")); return sys.includes(vault) && sys.includes("ocmem") && sys.includes("shared memory"); }));
  const events = read(path.join(privateDir, "events.jsonl"));
  check("native journal records memory_search, write and edit", ["memory_search", '"tool":"write"', '"tool":"edit"'].every((s) => events.includes(s)));
  await run(core, "stop", "ocmem", "opencode", "--force");
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
  for (const p of [daemon, memd]) if (p) { p.kill("SIGTERM"); const timer = setTimeout(() => p.kill("SIGKILL"), 5000); await p.exited; clearTimeout(timer); }
  provider.stop(true);
  fs.mkdirSync(artifacts, { recursive: true });
  fs.cpSync(root, path.join(artifacts, "raw"), { recursive: true });
  fs.writeFileSync(path.join(artifacts, "wire.json"), JSON.stringify(wire, null, 2));
  fs.writeFileSync(path.join(artifacts, "cli.json"), JSON.stringify(cliLog, null, 2));
  fs.writeFileSync(path.join(artifacts, "result.json"), JSON.stringify({ success, memory, core, native, memorySHA256: crypto.createHash("sha256").update(fs.readFileSync(memory)).digest("hex"), results }, null, 2));
  fs.rmSync(root, { recursive: true, force: true });
  console.log(`artifacts: ${artifacts}`);
}
process.exit(success ? 0 : 1);
