import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  syncCoreDependencyPin,
  syncVersions,
  SYNC_TARGETS,
} from "../src/sync-versions.js";

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "im-sync-"));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function writeManifest(rel: string, manifest: Record<string, unknown>): string {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(manifest, null, 2) + "\n");
  return file;
}

describe("syncVersions", () => {
  it("propagates the facade version into every present manifest", () => {
    writeManifest("core/package.json", { name: "core", version: "0.0.1" });
    const outcomes = syncVersions({ rootDir: root, version: "1.2.3" });
    expect(outcomes).toEqual([{ file: "core/package.json", action: "updated" }]);
    const core = JSON.parse(fs.readFileSync(path.join(root, "core/package.json"), "utf-8"));
    expect(core.version).toBe("1.2.3");
    expect(core.name).toBe("core"); // other fields untouched
  });

  it("missing manifests are reported, never thrown", () => {
    const outcomes = syncVersions({ rootDir: root, version: "1.0.0" });
    expect(outcomes.every((o) => o.action === "missing")).toBe(true);
    expect(outcomes.length).toBe(SYNC_TARGETS.length);
  });

  it("an already-synced manifest is identical (idempotent, no mtime churn)", () => {
    const file = writeManifest("core/package.json", { version: "2.0.0" });
    const before = fs.statSync(file).mtimeMs;
    const outcomes = syncVersions({
      rootDir: root,
      version: "2.0.0",
      targets: ["core/package.json"],
    });
    expect(outcomes).toEqual([{ file: "core/package.json", action: "identical" }]);
    expect(fs.statSync(file).mtimeMs).toBe(before);
  });

  it("the real monorepo target list covers the core manifest (adapters left with the plugin channel, ADR-017)", () => {
    expect(SYNC_TARGETS).toContain("core/package.json");
    expect(SYNC_TARGETS.some((t) => t.includes("adapters/"))).toBe(false);
  });
});

describe("syncCoreDependencyPin", () => {
  it("pins the core dependency to the facade version (npm publish ships the manifest verbatim)", () => {
    const file = writeManifest("package/package.json", {
      name: "@agfpd/iapeer-memory",
      version: "1.2.3",
      dependencies: { "@agfpd/iapeer-memory-core": "workspace:*", zod: "^4.0.0" },
    });
    const outcome = syncCoreDependencyPin({ packageManifestPath: file, version: "1.2.3" });
    expect(outcome.action).toBe("updated");
    const manifest = JSON.parse(fs.readFileSync(file, "utf-8"));
    expect(manifest.dependencies["@agfpd/iapeer-memory-core"]).toBe("1.2.3");
    expect(manifest.dependencies.zod).toBe("^4.0.0"); // other deps untouched
  });

  it("an already-pinned manifest is identical (idempotent)", () => {
    const file = writeManifest("package/package.json", {
      dependencies: { "@agfpd/iapeer-memory-core": "2.0.0" },
    });
    const before = fs.statSync(file).mtimeMs;
    expect(
      syncCoreDependencyPin({ packageManifestPath: file, version: "2.0.0" }).action,
    ).toBe("identical");
    expect(fs.statSync(file).mtimeMs).toBe(before);
  });

  it("the REAL facade manifest carries an exact pin, never the workspace protocol", () => {
    const real = JSON.parse(
      fs.readFileSync(path.join(import.meta.dir, "..", "package.json"), "utf-8"),
    ) as { version: string; dependencies: Record<string, string> };
    const pin = real.dependencies["@agfpd/iapeer-memory-core"];
    expect(pin).toBe(real.version); // lockstep: facade version == core pin
    expect(pin.includes("workspace")).toBe(false);
  });
});
