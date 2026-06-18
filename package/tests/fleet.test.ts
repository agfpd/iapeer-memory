import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readFleetMap, writeFleetMap } from "../src/fleet.js";
import { liveEgress } from "../src/egress.js";

// Refusing handle (preload sandbox env); explicit fake bins spawn for real.
const EG = liveEgress();

let tmp: string;
let mapPath: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "im-fleet-"));
  mapPath = path.join(tmp, "state", "fleet.json");
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function fakeBin(stdout: string, exitCode = 0): string {
  const bin = path.join(tmp, "fake-iapeer");
  fs.writeFileSync(bin, `#!/usr/bin/env bash\nprintf '%s' '${stdout}'\nexit ${exitCode}\n`);
  fs.chmodSync(bin, 0o755);
  return bin;
}

describe("writeFleetMap (personality → cwd joint)", () => {
  it("writes the map from `list --json`; peers without a cwd are dropped (no fragment home)", () => {
    const bin = fakeBin(
      JSON.stringify([
        {
          personality: "boris",
          cwd: "/Users/x/Peers/boris",
          runtimes: [{ runtime: "claude", status: "live" }],
        },
        { personality: "arthur" }, // human, no cwd → dropped
        { personality: "linus", cwd: "  " }, // blank cwd → dropped
        {
          personality: "index",
          cwd: "/Users/x/.iapeer/peers/index",
          runtimes: [
            { runtime: "claude", status: "asleep" },
            { runtime: "codex", status: "asleep" },
            { runtime: "claude" }, // duplicate → deduped
          ],
        },
      ]),
    );
    const r = writeFleetMap(EG, { fleetMapPath: mapPath, iapeerBin: bin, nowIso: "2026-06-10T00:00:00.000Z" });
    expect(r.action).toBe("written");
    expect(r.count).toBe(2);
    const map = JSON.parse(fs.readFileSync(mapPath, "utf-8"));
    expect(map).toEqual({
      updatedAt: "2026-06-10T00:00:00.000Z",
      peers: [
        { personality: "boris", cwd: "/Users/x/Peers/boris", runtimes: ["claude"] },
        { personality: "index", cwd: "/Users/x/.iapeer/peers/index", runtimes: ["claude", "codex"] },
      ],
    });
    expect(fs.existsSync(`${mapPath}.tmp`)).toBe(false); // atomic, no residue
  });

  it("readFleetMap is fail-open and reads pre-v1.2 maps as runtimes: []", () => {
    expect(readFleetMap(mapPath)).toBeNull(); // missing
    fs.mkdirSync(path.dirname(mapPath), { recursive: true });
    fs.writeFileSync(mapPath, "{broken");
    expect(readFleetMap(mapPath)).toBeNull(); // unreadable
    fs.writeFileSync(
      mapPath,
      JSON.stringify({ peers: [{ personality: "old", cwd: "/o" }] }), // pre-v1.2
    );
    expect(readFleetMap(mapPath)).toEqual([{ personality: "old", cwd: "/o", runtimes: [] }]);
  });

  it("readFleetMap REFUSES the prod fleet map under the sandbox (read-as-egress, И4 parity)", () => {
    // The prod map NAMES live cwds — the source of the residual write lane
    // (24/29 fleet cwds outside every anchor). Read-only safe
    // even on regression: the assertion below would then see live peers.
    const prodMap = path.join(os.homedir(), ".iapeer", "state", "iapeer-memory", "fleet.json");
    expect(readFleetMap(prodMap)).toBeNull();
  });

  it("a missing binary / non-zero exit / unparsable output are RESULTS, the old map is not clobbered", () => {
    fs.mkdirSync(path.dirname(mapPath), { recursive: true });
    fs.writeFileSync(mapPath, '{"peers":[{"personality":"keep","cwd":"/k"}]}');

    expect(writeFleetMap(EG, { fleetMapPath: mapPath, iapeerBin: path.join(tmp, "absent") }).action).toBe("failed");
    expect(writeFleetMap(EG, { fleetMapPath: mapPath, iapeerBin: fakeBin("", 1) }).action).toBe("failed");
    expect(writeFleetMap(EG, { fleetMapPath: mapPath, iapeerBin: fakeBin("not json") }).action).toBe("failed");

    // every failure left the existing map intact (memoryd keeps a working fleet)
    expect(JSON.parse(fs.readFileSync(mapPath, "utf-8")).peers[0].personality).toBe("keep");
  });
});
