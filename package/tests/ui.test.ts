import { describe, it, expect, afterEach } from "bun:test";
import { colorEnabled, ui, paintStatus } from "../src/ui.js";

const saved = { NO_COLOR: process.env.NO_COLOR, FORCE_COLOR: process.env.FORCE_COLOR };
afterEach(() => {
  for (const k of ["NO_COLOR", "FORCE_COLOR"] as const) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("colorEnabled — honest TTY gate", () => {
  it("NO_COLOR disables even with FORCE_COLOR and a TTY (user opt-out wins)", () => {
    process.env.FORCE_COLOR = "1";
    process.env.NO_COLOR = "1";
    expect(colorEnabled({ isTTY: true })).toBe(false);
  });

  it("FORCE_COLOR forces color even when not a TTY", () => {
    delete process.env.NO_COLOR;
    process.env.FORCE_COLOR = "1";
    expect(colorEnabled({ isTTY: false })).toBe(true);
  });

  it("FORCE_COLOR=0 does not force", () => {
    delete process.env.NO_COLOR;
    process.env.FORCE_COLOR = "0";
    expect(colorEnabled({ isTTY: false })).toBe(false);
  });

  it("falls back to the real TTY when neither env is set", () => {
    delete process.env.NO_COLOR;
    delete process.env.FORCE_COLOR;
    expect(colorEnabled({ isTTY: true })).toBe(true);
    expect(colorEnabled({ isTTY: false })).toBe(false);
  });
});

describe("painters — ANSI when enabled, byte-identical plain when disabled", () => {
  it("emit SGR when color is on (FORCE_COLOR)", () => {
    delete process.env.NO_COLOR;
    process.env.FORCE_COLOR = "1";
    expect(ui.green("x")).toBe("\x1b[32mx\x1b[0m");
    expect(ui.dim("p")).toBe("\x1b[2mp\x1b[0m");
    expect(paintStatus("ok", "ok  ")).toBe("\x1b[32mok  \x1b[0m");
    expect(paintStatus("fail", "FAIL")).toBe("\x1b[31mFAIL\x1b[0m");
    expect(paintStatus("skip", "skip")).toBe("\x1b[90mskip\x1b[0m");
    expect(paintStatus("warn", "!")).toBe("\x1b[33m!\x1b[0m");
  });

  it("return the input untouched when color is off (NO_COLOR) — pipes/tests stay plain", () => {
    process.env.NO_COLOR = "1";
    expect(ui.green("x")).toBe("x");
    expect(ui.dim("p")).toBe("p");
    expect(paintStatus("fail", "FAIL")).toBe("FAIL");
  });
});
