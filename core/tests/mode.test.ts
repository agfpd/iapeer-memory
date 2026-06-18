import { describe, it, expect } from "bun:test";
import { resolveMode, curationPlan } from "../src/mode.js";

describe("resolveMode (lean §7) — default + presets + overrides", () => {
  it("ABSENT mode → curated (legacy preservation, never silently flip)", () => {
    const { mode, roles } = resolveMode({});
    expect(mode).toBe("curated");
    expect(roles).toEqual({ index: true, scriber: true, dreamweaver: true });
  });

  it("lean → all roles off", () => {
    const { mode, roles } = resolveMode({ IAPEER_MEMORY_MODE: "lean" });
    expect(mode).toBe("lean");
    expect(roles).toEqual({ index: false, scriber: false, dreamweaver: false });
  });

  it("curated → all roles on", () => {
    expect(resolveMode({ IAPEER_MEMORY_MODE: "curated" }).roles).toEqual({
      index: true,
      scriber: true,
      dreamweaver: true,
    });
  });

  it("unrecognised mode value → curated (safe legacy default)", () => {
    expect(resolveMode({ IAPEER_MEMORY_MODE: "weird" }).mode).toBe("curated");
  });

  it("per-role override flips a single role over the preset", () => {
    // curated preset, index turned OFF
    expect(
      resolveMode({ IAPEER_MEMORY_MODE: "curated", IAPEER_MEMORY_PROACTIVE_INDEX: "off" }).roles,
    ).toEqual({ index: false, scriber: true, dreamweaver: true });
    // lean preset, scriber turned ON
    expect(
      resolveMode({ IAPEER_MEMORY_MODE: "lean", IAPEER_MEMORY_PROACTIVE_SCRIBER: "on" }).roles,
    ).toEqual({ index: false, scriber: true, dreamweaver: false });
  });

  it("toggle accepts 1/0/yes/no/true/false; unrecognised → preset", () => {
    const r = (v: string) =>
      resolveMode({ IAPEER_MEMORY_MODE: "lean", IAPEER_MEMORY_PROACTIVE_DREAMWEAVER: v }).roles
        .dreamweaver;
    expect(r("1")).toBe(true);
    expect(r("yes")).toBe(true);
    expect(r("0")).toBe(false);
    expect(r("no")).toBe(false);
    expect(r("garbage")).toBe(false); // → preset (lean = false)
  });
});

describe("curationPlan (lean §7.1 matrix)", () => {
  const plan = (roles: { index: boolean; scriber: boolean; dreamweaver: boolean }) =>
    curationPlan(roles);

  it("full lean (none) → no emit, no target, no dream", () => {
    expect(plan({ index: false, scriber: false, dreamweaver: false })).toEqual({
      emit: false,
      eventTarget: null,
      dream: false,
    });
  });

  it("full curated → emit, target=scriber, dream", () => {
    expect(plan({ index: true, scriber: true, dreamweaver: true })).toEqual({
      emit: true,
      eventTarget: "scriber",
      dream: true,
    });
  });

  it("Index only → emit, target=index, no dream", () => {
    expect(plan({ index: true, scriber: false, dreamweaver: false })).toEqual({
      emit: true,
      eventTarget: "index",
      dream: false,
    });
  });

  it("Index+Scriber → target=scriber (scriber wins), no dream", () => {
    expect(plan({ index: true, scriber: true, dreamweaver: false })).toEqual({
      emit: true,
      eventTarget: "scriber",
      dream: false,
    });
  });

  it("Scriber only → emit, target=scriber, no dream", () => {
    expect(plan({ index: false, scriber: true, dreamweaver: false })).toEqual({
      emit: true,
      eventTarget: "scriber",
      dream: false,
    });
  });

  it("DreamWeaver only → NO emit (no scriber/index), no target, dream on (decoupled)", () => {
    expect(plan({ index: false, scriber: false, dreamweaver: true })).toEqual({
      emit: false,
      eventTarget: null,
      dream: true,
    });
  });
});
