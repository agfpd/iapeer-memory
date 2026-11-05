/** Reproducible, dependency-free foundation leaf for runtime profile writes. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { guardedWriteFileSync, guardedRmSync } from "@agfpd/iapeer-memory-core";

const root = fileURLToPath(new URL("../", import.meta.url));
const upstreamSha = "829c2e736a318d343bd7b6b45c0e073026b9e62a";
const manifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const dependency = manifest.devDependencies["@agfpd/iapeer"];
if (dependency !== `github:agfpd/iapeer#${upstreamSha}` && dependency !== "0.4.165") {
  throw new Error("Update vendor provenance when changing the foundation source pin");
}
const check = process.argv.includes("--check");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "memory-profile-vendor-"));
try {
  const output = path.join(tmp, "peer-profile.js");
  const build = Bun.spawnSync([
    process.execPath, "build",
    "node_modules/@agfpd/iapeer/src/identity/patchPeerProfile.ts",
    "--target", "bun", "--outfile", output,
  ], { cwd: root, stdout: "pipe", stderr: "pipe" });
  if (build.exitCode !== 0) throw new Error(build.stderr.toString());
  const bundle = fs.readFileSync(output, "utf8");
  const provenance = JSON.stringify({
    upstream: "https://github.com/agfpd/iapeer",
    commit: upstreamSha,
    source: "src/identity/patchPeerProfile.ts",
    protocol: 1,
    bun: Bun.version,
    sha256: createHash("sha256").update(bundle).digest("hex"),
  }, null, 2) + "\n";
  const vendor = path.join(root, "vendor");
  if (!check) fs.mkdirSync(vendor, { recursive: true });
  for (const [name, bytes] of [["peer-profile.js", bundle], ["peer-profile.provenance.json", provenance]]) {
    const dest = path.join(vendor, name!);
    if (check) {
      if (fs.readFileSync(dest, "utf8") !== bytes) throw new Error(`vendor drift: ${name}; regenerate with pinned Bun`);
    } else {
      guardedWriteFileSync(dest, bytes!, "utf8");
    }
  }
  console.log(`peer-profile vendor ${check ? "verified" : "generated"}`);
} finally {
  guardedRmSync(tmp, { recursive: true, force: true });
}
