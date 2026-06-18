/**
 * Tests for src/context-render.ts. Of the reference's 10 fixtures only
 * capText (2) is transferable — the other 8 test the DROPPED shard
 * mechanics (est_tokens / pack_shards / write_shards, ADR-001).
 * `build_layers` had NO direct unit fixtures in the reference (integration
 * only) — the layer tests here are new, written against the documented
 * contract (docs/05-delivery-and-context.md).
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  capText,
  buildLayers,
  renderFragmentText,
  writeFragmentAtomic,
  peerFragmentsDir,
  renderPeerFragment,
  writeHostWideGuideFragment,
  FRAGMENT_STEM,
  type FragmentEnv,
} from "../src/context-render.js";

const RU_CAP_TEMPLATE =
  "\n\n_[{label} обрезан: превышен лимит {max} символов (= размер гайда). Сократи документ.]_";

describe("capText (parity with the reference)", () => {
  it("under cap untouched", () => {
    const t = "line1\nline2\n";
    expect(capText(t, 1000, "X", RU_CAP_TEMPLATE)).toBe(t);
  });

  it("over cap trims at a line boundary with a marker", () => {
    const t = "строка\n".repeat(100);
    const out = capText(t, 50, "MERGEMIND.md глобальный", RU_CAP_TEMPLATE);
    expect(out.split("_[")[0]!.length).toBeLessThanOrEqual(60);
    expect(out).toContain("обрезан");
    expect(out).toContain("50 символов");
  });
});

describe("buildLayers — assembly order from the reference, shards dropped", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "iapeer-memory-ctx-"));
  });

  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  function env(over: Partial<FragmentEnv> = {}): FragmentEnv {
    return {
      agent: "boris",
      paths: {
        vault: "/v",
        db: "/c/index.db",
        config: "/p/config.env",
        state: "/s",
        cache: "/c",
        logs: "/l",
      },
      authorIndexPath: path.join(tmp, "boris-vault-index.md"),
      ...over,
    };
  }

  it("author branch: paths block first, then the author index", () => {
    fs.writeFileSync(path.join(tmp, "boris-vault-index.md"), "## Знания\n- [[X]]\n");
    const layers = buildLayers(env());
    expect(layers).toHaveLength(2);
    expect(layers[0]![0]).toBe("iapeer-memory paths");
    expect(layers[0]![1]).toContain("<iapeer-memory-paths>");
    expect(layers[0]![1]).toContain("vault: /v");
    expect(layers[1]![0]).toBe("boris-vault-index.md");
    expect(layers[1]![1]).toContain("[[X]]");
  });

  it("missing/empty index file is skipped gracefully", () => {
    const layers = buildLayers(env());
    expect(layers).toHaveLength(1);
    expect(layers[0]![0]).toBe("iapeer-memory paths");
  });

  it("tags projection → ALL authors (lean §3): paths → projection → own index", () => {
    fs.writeFileSync(path.join(tmp, "tags-projection.md"), "Память — память как предмет\nФинансы");
    fs.writeFileSync(path.join(tmp, "boris-vault-index.md"), "## Знания\n");
    const layers = buildLayers(
      env({
        agent: "boris", // ordinary author, NOT the index — still gets the projection
        authorIndexPath: path.join(tmp, "boris-vault-index.md"),
        tagsProjectionPath: path.join(tmp, "tags-projection.md"),
        tagsTitle: "Теги.md",
      }),
    );
    expect(layers.map((l) => l[0])).toEqual([
      "iapeer-memory paths",
      "Теги.md",
      "boris-vault-index.md",
    ]);
  });

  it("projection title falls back to the file basename when tagsTitle is absent", () => {
    fs.writeFileSync(path.join(tmp, "tags-projection.md"), "Память");
    const layers = buildLayers(env({ tagsProjectionPath: path.join(tmp, "tags-projection.md") }));
    expect(layers.map((l) => l[0])).toContain("tags-projection.md");
  });

  it("a missing/empty projection file is skipped gracefully", () => {
    const layers = buildLayers(env({ tagsProjectionPath: path.join(tmp, "nonexistent.md") }));
    expect(layers.map((l) => l[0])).not.toContain("nonexistent.md");
  });
});

describe("renderFragmentText / writeFragmentAtomic", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "iapeer-memory-frag-"));
  });

  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it("renders layers as ## sections, whole — no shards, no k/N markers", () => {
    const text = renderFragmentText([
      ["A", "body-a"],
      ["B", "body-b\n"],
    ]);
    expect(text).toBe("## A\nbody-a\n\n## B\nbody-b\n");
    expect(text).not.toContain("shard");
  });

  it("writes atomically into the fragments dir with the canonical stem", () => {
    const dir = path.join(tmp, "fragments");
    const target = writeFragmentAtomic(dir, "контент\n");
    expect(target).toBe(path.join(dir, FRAGMENT_STEM));
    expect(fs.readFileSync(target, "utf-8")).toBe("контент\n");
    // no temp leftovers
    expect(fs.readdirSync(dir)).toEqual([FRAGMENT_STEM]);
  });

  it("renderPeerFragment writes <peerCwd>/.iapeer/fragments/iapeer-memory.md", () => {
    const peerCwd = path.join(tmp, "peer");
    const idx = path.join(tmp, "boris-vault-index.md");
    fs.writeFileSync(idx, "## Знания\n- [[Токен]]\n");
    const written = renderPeerFragment({
      peerCwd,
      env: {
        agent: "boris",
        paths: { vault: "/v", state: "/s", cache: "/c" },
        authorIndexPath: idx,
      },
    });
    expect(written).toBe(path.join(peerFragmentsDir(peerCwd), FRAGMENT_STEM));
    const text = fs.readFileSync(written, "utf-8");
    expect(text).toContain("<iapeer-memory-paths>");
    expect(text).toContain("[[Токен]]");
  });

  it("rewrite replaces the fragment whole (old content gone)", () => {
    const dir = path.join(tmp, "fragments");
    writeFragmentAtomic(dir, "OLD\n");
    writeFragmentAtomic(dir, "NEW\n");
    expect(fs.readFileSync(path.join(dir, FRAGMENT_STEM), "utf-8")).toBe("NEW\n");
  });

  it("writeHostWideGuideFragment targets <home>/fragments/ (kept OFF prod in tests)", () => {
    const fakeHomeIapeer = path.join(tmp, "home-iapeer");
    const written = writeHostWideGuideFragment(fakeHomeIapeer, "guide text\n");
    expect(written).toBe(path.join(fakeHomeIapeer, "fragments", FRAGMENT_STEM));
    expect(fs.readFileSync(written, "utf-8")).toBe("guide text\n");
  });
});
