import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  readSlot,
  removeSlot,
  slotProvisionBlocks,
  writeSlot,
  SLOT_PACKAGE,
  SLOT_PROVIDER,
} from "../src/slot.js";

let tmp: string;
let slotPath: string;
const BIN = "/Users/x/.local/bin/iapeer-memory";

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "im-slot-"));
  slotPath = path.join(tmp, ".iapeer", "memory-provider.json");
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("memory-provider slot (v1.2)", () => {
  it("readSlot never throws: missing and malformed → null (empty slot, contract fail-open)", () => {
    expect(readSlot(slotPath)).toBeNull();
    fs.mkdirSync(path.dirname(slotPath), { recursive: true });
    fs.writeFileSync(slotPath, "{broken");
    expect(readSlot(slotPath)).toBeNull();
  });

  it("readSlot REFUSES the prod slot under the sandbox (read-as-egress, И4 parity)", () => {
    // «Slot is ours» is TRUE on the live host — it gates fleet-wide sweeps
    // (uninstall). A sandboxed process must see the prod slot as absent.
    const prodSlot = path.join(os.homedir(), ".iapeer", "memory-provider.json");
    expect(readSlot(prodSlot)).toBeNull();
  });

  it("writeSlot declares the v1.2 contract schema atomically — provision blocks, NO plugin block", () => {
    const r = writeSlot({
      slotPath,
      version: "1.2.3",
      binaryPath: BIN,
      heartbeat: "/state/memoryd.heartbeat",
      nowIso: "2026-06-11T00:00:00.000Z",
    });
    expect(r.action).toBe("written");
    const slot = readSlot(slotPath)!;
    expect(slot).toEqual({
      provider: SLOT_PROVIDER,
      package: SLOT_PACKAGE,
      version: "1.2.3",
      registeredAt: "2026-06-11T00:00:00.000Z",
      heartbeat: "/state/memoryd.heartbeat",
      ...slotProvisionBlocks(BIN),
    });
    expect(fs.existsSync(`${slotPath}.tmp`)).toBe(false); // no temp residue
  });

  it("the provision blocks match the schema fixed with the core (argv form, absolute command, per-argument placeholders)", () => {
    const blocks = slotProvisionBlocks(BIN);
    expect(blocks.provision).toEqual({
      command: BIN,
      args: [
        "provision-peer",
        "--cwd", "{cwd}",
        "--runtime", "{runtime}",
        "--personality", "{personality}",
        "--occasion", "{occasion}",
      ],
    });
    expect(blocks.unprovision).toEqual({
      command: BIN,
      args: [
        "unprovision-peer",
        "--cwd", "{cwd}",
        "--runtime", "{runtime}",
        "--occasion", "{occasion}",
      ],
    });
    // a relative command would read as an invalid block at the core (fail-open)
    expect(path.isAbsolute(blocks.provision.command)).toBe(true);
  });

  it("re-init with the same version+binary is idempotent (no churn, registeredAt kept)", () => {
    writeSlot({ slotPath, version: "1.2.3", binaryPath: BIN, heartbeat: "/h", nowIso: "2026-06-10T00:00:00.000Z" });
    const r = writeSlot({ slotPath, version: "1.2.3", binaryPath: BIN, heartbeat: "/h", nowIso: "2026-06-11T00:00:00.000Z" });
    expect(r.action).toBe("identical");
    expect(readSlot(slotPath)!.registeredAt).toBe("2026-06-10T00:00:00.000Z");
  });

  it("update re-declares a new version; a moved binary re-declares too (provision command follows)", () => {
    writeSlot({ slotPath, version: "1.0.0", binaryPath: BIN, nowIso: "2026-06-10T00:00:00.000Z" });
    const v = writeSlot({ slotPath, version: "1.1.0", binaryPath: BIN, nowIso: "2026-06-11T00:00:00.000Z" });
    expect(v.action).toBe("written");
    expect(readSlot(slotPath)!.version).toBe("1.1.0");

    const moved = writeSlot({ slotPath, version: "1.1.0", binaryPath: "/new/bin/iapeer-memory" });
    expect(moved.action).toBe("written");
    expect(readSlot(slotPath)!.provision?.command).toBe("/new/bin/iapeer-memory");
  });

  it("a FOREIGN slot is refused on write AND on remove (never touched)", () => {
    fs.mkdirSync(path.dirname(slotPath), { recursive: true });
    const foreign = {
      provider: "other-memory",
      package: "@x/other",
      version: "9.0.0",
      registeredAt: "2026-01-01T00:00:00.000Z",
    };
    fs.writeFileSync(slotPath, JSON.stringify(foreign));

    const w = writeSlot({ slotPath, version: "1.0.0", binaryPath: BIN });
    expect(w.action).toBe("refused-foreign");
    expect(readSlot(slotPath)!.provider).toBe("other-memory");

    expect(removeSlot(slotPath)).toBe("refused-foreign");
    expect(fs.existsSync(slotPath)).toBe(true);
  });

  it("removeSlot removes own declaration; absent is reported, not an error", () => {
    expect(removeSlot(slotPath)).toBe("absent");
    writeSlot({ slotPath, version: "1.0.0", binaryPath: BIN });
    expect(removeSlot(slotPath)).toBe("removed");
    expect(fs.existsSync(slotPath)).toBe(false);
  });
});
