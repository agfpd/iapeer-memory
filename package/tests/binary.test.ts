import { describe, it, expect } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { installBinary } from "../src/binary.js";
import { packageVersion } from "../src/version.js";
import type { Egress } from "../src/egress.js";

describe("candidate validation before binary activation", () => {
  for (const failure of ["verify", "probe", "stable-sign"] as const) {
    it(`${failure} failure preserves the previous working installation`, () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "im-candidate-"));
      const outPath = path.join(root, "memory");
      fs.writeFileSync(outPath, "previous-working-bytes");
      const calls: string[][] = [];
      const eg: Egress = {
        refused: failure !== "stable-sign",
        spawnSync(argv) {
          calls.push(argv);
          const ok = { exitCode: 0, stdout: "", stderr: "" };
          if (argv[1] === "build") fs.writeFileSync(argv.at(-1)!, "candidate");
          if (argv[0] === "security") return { ...ok, stdout: '"iapeer Local Codesign"' };
          if ((failure === "verify" && argv.includes("--verify")) ||
              (failure === "probe" && argv[1] === "version") ||
              (failure === "stable-sign" && argv[0] === "codesign")) return { ...ok, exitCode: 1, stderr: "forced failure" };
          if (argv[1] === "version") return { ...ok, stdout: packageVersion() };
          return ok;
        },
        spawnDetached: () => ({ started: false, detail: "not expected" }),
        kill: () => ({ delivered: false }),
        fetch: () => Promise.reject(new Error("not expected")),
      };
      try {
        const outcome = installBinary(eg, { outPath });
        // On non-Darwin there is no signature verifier; the probe case is
        // still portable. This product currently targets Darwin.
        if (process.platform === "darwin" || failure !== "verify") {
          expect(outcome.action).toBe("failed");
          expect(fs.readFileSync(outPath, "utf-8")).toBe("previous-working-bytes");
        }
        expect(calls.every((argv) => argv.at(-1) !== outPath)).toBe(true);
        expect(fs.readdirSync(root)).toEqual(["memory"]);
      } finally { fs.rmSync(root, { recursive: true, force: true }); }
    });
  }
});

describe("sandboxed install-binary never targets the live binary", () => {
  it("default out path under ~/.local/bin is refused before any compile (incident 17.10)", () => {
    const prev = process.env.IAPEER_TEST_SANDBOX;
    process.env.IAPEER_TEST_SANDBOX = "1";
    const calls: string[][] = [];
    const eg = {
      refused: true,
      spawnSync(argv: string[]) { calls.push(argv); return { exitCode: 0, stdout: "", stderr: "" }; },
      spawnDetached: () => ({ started: false, detail: "" }),
      kill: () => ({ delivered: false }),
      fetch: () => Promise.reject(new Error("no")),
    } as unknown as Egress;
    try {
      const outcome = installBinary(eg, { outPath: path.join(os.homedir(), ".local", "bin", "iapeer-memory") });
      expect(outcome.action).toBe("failed");
      expect((outcome as { detail?: string }).detail).toMatch(/fs-guard/);
      expect(calls).toEqual([]);
    } finally {
      if (prev === undefined) delete process.env.IAPEER_TEST_SANDBOX; else process.env.IAPEER_TEST_SANDBOX = prev;
    }
  });
});
