/** Real installer/signature gate. --source may name a clean unpacked facade.
 * Existing host identity only: this probe never creates a signing identity.
 * No install/update/verify of live memory surfaces or service restarts.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { pathToFileURL } from "node:url";

const arg = (key: string) => { const i = process.argv.indexOf(key); return i < 0 ? undefined : process.argv[i + 1]; };
const source = path.resolve(arg("--source") ?? "package");
const artifacts = path.resolve(arg("--artifacts") ?? "dist/proofs/signing");
if (fs.existsSync(artifacts)) throw new Error(`use a new artifacts directory: ${artifacts}`);
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "im-signature-")));
const out = path.join(root, "bin/memory");
const prod = path.join(os.homedir(), ".local/bin/iapeer-memory");
const sha = (p: string) => crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
const baseline = sha(prod);
const results: any[] = [], calls: any[] = [];
const env = {
  // Keep the operator's HOME for access to the EXISTING login keychain.
  // Only install-binary runs here; all product writes target this tmp root.
  PATH: process.env.PATH!, HOME: os.homedir(),
  IAPEER_ROOT: path.join(root, "iapeer"), IAPEER_MEMORY_BINARY_PATH: out,
  IAPEER_MEMORY_CONFIG_FILE: path.join(root, "config.env"), IAPEER_MEMORY_STATE_DIR: path.join(root, "state"),
  IAPEER_MEMORY_CACHE_DIR: path.join(root, "cache"), IAPEER_MEMORY_LOGS_DIR: path.join(root, "logs"),
};
function run(argv: string[]) {
  const p = Bun.spawnSync(argv, { env, cwd: root, timeout: 120_000 });
  const r = { argv, code: p.exitCode, stdout: p.stdout.toString(), stderr: p.stderr.toString() };
  calls.push(r);
  return r;
}
function check(name: string, ok: boolean, detail?: unknown) {
  results.push({ name, ok, detail }); console.log(`${ok ? "PASS" : "FAIL"} ${name}`);
  if (!ok) throw new Error(`${name}: ${JSON.stringify(detail)}`);
}
let success = false;
try {
  fs.mkdirSync(env.HOME, { recursive: true });
  const identities = run(["/usr/bin/security", "find-identity", "-p", "codesigning"]).stdout;
  const leaf = identities.match(/([A-F0-9]{40}) "iapeer Local Codesign"/)?.[1]?.toLowerCase();
  check("existing stable identity (no creation)", !!leaf);
  const install = () => run([process.execPath, path.join(source, "src/cli.ts"), "install-binary", "--out", out]);
  check("normal artifact installer succeeds", install().code === 0, calls.at(-1));
  check("strict signature without manual re-sign", run(["/usr/bin/codesign", "--verify", "--strict", out]).code === 0, calls.at(-1));
  const requirement = run(["/usr/bin/codesign", "-d", "-r-", out]).stdout;
  check("stable product designated requirement", requirement.includes('identifier "com.agfpd.iapeer-memory"') && requirement.includes(`certificate leaf = H"${leaf}"`), requirement);
  const version = JSON.parse(fs.readFileSync(path.join(source, "package.json"), "utf8")).version;
  check("installed candidate executes expected version", run([out, "version"]).stdout.trim() === version);
  check("normal repeated install succeeds", install().code === 0, calls.at(-1));
  check("reinstall preserves designated requirement", run(["/usr/bin/codesign", "-d", "-r-", out]).stdout === requirement);
  const good = sha(out), mode = fs.statSync(out).mode;
  // Fault only the actual compiler OUTPUT. codesign and the rest of the
  // installer remain real: a truncated Mach-O must never replace good bytes.
  const driver = path.join(root, "reject.ts");
  fs.writeFileSync(driver, `
import fs from "node:fs";
const { installBinary } = await import(${JSON.stringify(pathToFileURL(path.join(source, "src/binary.ts")).href)});
const { liveEgress } = await import(${JSON.stringify(pathToFileURL(path.join(source, "src/egress.ts")).href)});
const real = liveEgress();
const eg = { ...real, spawnSync(argv, opts) {
  const result = real.spawnSync(argv, opts);
  if (argv[1] === "build" && result.exitCode === 0) fs.truncateSync(argv.at(-1), 64);
  return result;
} };
const result = installBinary(eg, { outPath: ${JSON.stringify(out)} });
console.log(JSON.stringify(result));
process.exit(result.action === "failed" && result.detail.includes("codesign failed") ? 0 : 1);
`);
  check("real codesign rejects truncated compiler output", run([process.execPath, driver]).code === 0, calls.at(-1));
  check("rejected candidate preserves previous bytes and mode", sha(out) === good && fs.statSync(out).mode === mode);
  check("candidate temporaries cleaned", fs.readdirSync(path.dirname(out)).join() === "memory");
  check("previous binary still strictly valid and executable", run(["/usr/bin/codesign", "--verify", "--strict", out]).code === 0 && run([out, "version"]).stdout.trim() === version);
  success = true;
} catch (error) {
  results.push({ name: "harness", ok: false, detail: String(error) }); console.error(error);
} finally {
  const unchanged = sha(prod) === baseline;
  results.push({ name: "live memory binary unchanged", ok: unchanged });
  console.log(`${unchanged ? "PASS" : "FAIL"} live memory binary unchanged`);
  if (!unchanged) success = false;
  fs.mkdirSync(artifacts, { recursive: true });
  fs.writeFileSync(path.join(artifacts, "result.json"), JSON.stringify({ success, source, sourceVersion: JSON.parse(fs.readFileSync(path.join(source, "package.json"), "utf8")).version, baseline, results, calls }, null, 2));
  fs.rmSync(root, { recursive: true, force: true });
}
process.exit(success ? 0 : 1);
