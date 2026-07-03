/**
 * Grep invariants of the deny-by-default contract (П6, boris-extended):
 * the egress hub and the FS belt are TOPOLOGY — a new outbound channel must
 * not appear outside them. The test fails on the exact file:line, so the
 * violation teaches: route the call through the hub / the guard, or extend
 * the contract consciously (review!), never silently.
 *
 * Scanned: BOTH src trees (package + core). Comments are stripped first —
 * the hub/guard headers NAME the banned calls.
 */

import { describe, it, expect } from "bun:test";
import fs from "node:fs";
import path from "node:path";

const PKG_SRC = new URL("../src", import.meta.url).pathname;
const CORE_SRC = new URL("../../core/src", import.meta.url).pathname;

function tsFiles(root: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const p = path.join(root, entry.name);
    if (entry.isDirectory()) out.push(...tsFiles(p));
    else if (entry.name.endsWith(".ts")) out.push(p);
  }
  return out;
}

function stripComments(code: string): string {
  return code
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/([^:"'])\/\/[^\n"']*$/gm, "$1");
}

type Rule = {
  name: string;
  /** Matches a BANNED call (global-call forms only, not method accesses). */
  pattern: RegExp;
  /** Basenames where the call is the hub/guard itself. */
  allowedFiles: string[];
};

const RULES: Rule[] = [
  {
    name: "spawn/kill go through the egress hub",
    pattern: /\bBun\.spawnSync\(|\bBun\.spawn\(|\bprocess\.kill\(/,
    allowedFiles: ["egress.ts"],
  },
  {
    name: "global fetch goes through the egress hub (or the provider http-client)",
    pattern: /(?<![.\w$])fetch\s*\(/,
    allowedFiles: ["egress.ts", "http-client.ts"],
  },
  {
    name: "raw writes/removals/renames go through the fs-guard wrappers",
    pattern: /\bfs\.writeFileSync\(|\bBun\.write\(|\bfs\.rmSync\(|\bfs\.unlinkSync\(|\bfs\.renameSync\(/,
    allowedFiles: ["fs-guard.ts"],
  },
];

describe("deny-by-default topology invariants (П6)", () => {
  const files = [...tsFiles(PKG_SRC), ...tsFiles(CORE_SRC)];

  it("scans both src trees (sanity: the trees are where we think)", () => {
    expect(files.some((f) => f.endsWith("egress.ts"))).toBe(true);
    expect(files.some((f) => f.endsWith("fs-guard.ts"))).toBe(true);
    expect(files.length).toBeGreaterThan(40);
  });

  for (const rule of RULES) {
    it(rule.name, () => {
      const violations: string[] = [];
      for (const file of files) {
        if (rule.allowedFiles.includes(path.basename(file))) continue;
        const lines = stripComments(fs.readFileSync(file, "utf-8")).split("\n");
        lines.forEach((line, i) => {
          if (rule.pattern.test(line)) violations.push(`${file}:${i + 1}  ${line.trim()}`);
        });
      }
      expect(violations).toEqual([]);
    });
  }

  // Read-as-egress parity (И4): every reader of prod state that NAMES live
  // peer cwds (or gates a fleet-wide sweep) carries the sandbox read-gate.
  // memoryd's readFleetMap is an inner closure — this pin is its only test.
  it("prod-state readers (fleet map, slot, config.env) gate with sandboxBlocksProdRead", () => {
    const mustGate = [
      path.join(CORE_SRC, "memoryd.ts"),
      path.join(PKG_SRC, "fleet.ts"),
      path.join(PKG_SRC, "slot.ts"),
      path.join(PKG_SRC, "cli.ts"),
    ];
    for (const file of mustGate) {
      const code = stripComments(fs.readFileSync(file, "utf-8"));
      expect(code).toContain("sandboxBlocksProdRead(");
    }
  });
});
