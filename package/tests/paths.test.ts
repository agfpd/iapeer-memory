import { describe, it, expect } from "bun:test";
import path from "node:path";
import { authorIndexPath, memoryPaths } from "../src/paths.js";

describe("memoryPaths", () => {
  it("defaults to the ~/.iapeer/{state,cache,logs,plugins}/iapeer-memory namespace", () => {
    const p = memoryPaths({ HOME: "/home/u" });
    expect(p.stateDir).toBe("/home/u/.iapeer/state/iapeer-memory");
    expect(p.cacheDir).toBe("/home/u/.iapeer/cache/iapeer-memory");
    expect(p.logsDir).toBe("/home/u/.iapeer/logs/iapeer-memory");
    expect(p.configFile).toBe("/home/u/.iapeer/plugins/iapeer-memory/config.env");
    expect(p.dbPath).toBe("/home/u/.iapeer/cache/iapeer-memory/index.db");
  });

  it("derived files hang off the roots — one source of truth for memoryd AND verify", () => {
    const p = memoryPaths({ HOME: "/home/u" });
    expect(p.heartbeatPath).toBe(path.join(p.stateDir, "memoryd.heartbeat"));
    expect(p.hashStatePath).toBe(path.join(p.stateDir, "memoryd.hashes.json"));
    expect(p.rolesManifestPath).toBe(path.join(p.stateDir, "roles.json"));
    expect(p.tagsMirrorPath).toBe(path.join(p.cacheDir, "tags-dictionary.md"));
    expect(p.indexesDir).toBe(path.join(p.stateDir, "indexes"));
  });

  it("every root is individually overridable via env", () => {
    const p = memoryPaths({
      HOME: "/home/u",
      IAPEER_MEMORY_STATE_DIR: "/tmp/s",
      IAPEER_MEMORY_CACHE_DIR: "/tmp/c",
      IAPEER_MEMORY_LOGS_DIR: "/tmp/l",
      IAPEER_MEMORY_CONFIG_FILE: "/tmp/cfg.env",
      IAPEER_MEMORY_DB_PATH: "/tmp/db.sqlite",
    });
    expect(p.stateDir).toBe("/tmp/s");
    expect(p.cacheDir).toBe("/tmp/c");
    expect(p.logsDir).toBe("/tmp/l");
    expect(p.configFile).toBe("/tmp/cfg.env");
    expect(p.dbPath).toBe("/tmp/db.sqlite");
    expect(p.heartbeatPath).toBe("/tmp/s/memoryd.heartbeat");
    expect(p.tagsMirrorPath).toBe("/tmp/c/tags-dictionary.md");
  });

  it("authorIndexPath keeps the reference-visible basename form <agent>-vault-index.md", () => {
    const p = memoryPaths({ HOME: "/home/u" });
    expect(authorIndexPath(p, "boris")).toBe(
      path.join(p.indexesDir, "boris-vault-index.md"),
    );
  });

  it("slot lives in the storage root; binary in ~/.local/bin", () => {
    const p = memoryPaths({ HOME: "/home/u" });
    expect(p.slotPath).toBe("/home/u/.iapeer/memory-provider.json");
    expect(p.binaryPath).toBe("/home/u/.local/bin/iapeer-memory");
  });

  it("IAPEER_ROOT (the ecosystem storage-root override) relocates the .iapeer namespace", () => {
    const p = memoryPaths({ HOME: "/home/u", IAPEER_ROOT: "/sandbox/iapeer" });
    expect(p.slotPath).toBe("/sandbox/iapeer/memory-provider.json");
    expect(p.stateDir).toBe("/sandbox/iapeer/state/iapeer-memory");
    expect(p.configFile).toBe("/sandbox/iapeer/plugins/iapeer-memory/config.env");
    // binary is NOT under .iapeer — own override
    expect(
      memoryPaths({ HOME: "/h", IAPEER_MEMORY_BINARY_PATH: "/tmp/bin/im" }).binaryPath,
    ).toBe("/tmp/bin/im");
  });
});
