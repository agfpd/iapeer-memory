/**
 * Curator-tick wall-clock anchor (restart-starvation fix). The old
 * setInterval counted a FULL period from PROCESS START, in memory only —
 * every memoryd recycle (the notifier watcher relaunches the daemon on
 * each foundation deploy) reset the 6h countdown, and a deploy-dense day
 * starved curation entirely (live incident 02–03.07.2026: ≈40h without a
 * single CURATOR_TICK while the heartbeat stayed green).
 *
 * Contract under test:
 *   1. the anchor rides the batch state file (roundtrip + legacy migration);
 *   2. a restart MID-period sleeps only the REMAINDER, not a fresh period;
 *   3. an OVERDUE anchor (restart churn ate the whole period) fires a
 *      catch-up tick after the retry floor, not another full period.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  startMemoryd,
  loadBatchState,
  persistBatchState,
  type MemorydHandle,
} from "../src/memoryd.js";
import type { CoreConfig } from "../src/config.js";
import { getTaxonomy, defaultExcludeFolders, DEFAULT_RANKING } from "../src/taxonomy.js";
import { formatStamp } from "../src/human-edit-detect.js";

const T = getTaxonomy("ru");
const SILENT = { info: () => {}, warn: () => {}, error: () => {} };

let tmpdir: string;
let vault: string;

beforeEach(() => {
  tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), "iapeer-memory-anchor-"));
  vault = path.join(tmpdir, "vault");
  fs.mkdirSync(path.join(vault, T.folders.knowledge), { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpdir, { recursive: true, force: true });
});

function makeConfig(curatorMs: number): CoreConfig {
  return {
    vaultPath: vault,
    locale: "ru",
    taxonomy: T,
    ranking: { ...DEFAULT_RANKING },
    curatorSet: ["index", "scriber", "dreamweaver"],
    callerAgent: null,
    excludeFolders: defaultExcludeFolders(T),
    search: { chunkSize: 500, chunkOverlap: 80, maxResults: 6, rrfK: 60 },
    index: { dbPath: path.join(tmpdir, "index.db"), fullScanOnStartup: true },
    batch: { curatorMs },
    mcp: { port: 0 },
    embedding: null,
    reranker: null,
  };
}

function writeQueuedNote(): void {
  fs.writeFileSync(
    path.join(vault, T.folders.knowledge, "В очереди.md"),
    `---\ntitle: В очереди\nauthor: boris\ntype: ${T.types.knowledge}\nstatus: ${T.statusTokens.current}\nlast_edited_by: boris\nupdated: ${formatStamp(new Date())}\nneeds_review: true\n---\n\nТело в очереди курации.\n`,
    "utf-8",
  );
}

const batchPath = () => path.join(tmpdir, "memoryd.batches.json");

async function start(
  curatorMs: number,
  events: string[],
): Promise<MemorydHandle> {
  return startMemoryd({
    config: makeConfig(curatorMs),
    emit: (line) => events.push(line),
    mcpPort: null,
    batchStatePath: batchPath(),
    logger: SILENT,
  });
}

async function waitForTick(events: string[], deadlineMs: number): Promise<number> {
  const t0 = Date.now();
  while (Date.now() - t0 < deadlineMs) {
    if (events.some((l) => l.startsWith("CURATOR_TICK: "))) return Date.now() - t0;
    await Bun.sleep(50);
  }
  return -1;
}

describe("batch-state anchor persistence", () => {
  it("roundtrips lastCuratorTickAt; legacy/garbage state reads as null", () => {
    const file = path.join(tmpdir, "batches.json");
    persistBatchState(file, {
      permanent: new Map([["a.md", "h1"]]),
      silentStamps: new Map(),
      lastCuratorTickAt: 12345,
    });
    expect(loadBatchState(file).lastCuratorTickAt).toBe(12345);

    // legacy pre-anchor file → null (first-sight migration, no crash)
    fs.writeFileSync(file, JSON.stringify({ permanent: { "a.md": "h1" } }), "utf-8");
    expect(loadBatchState(file).lastCuratorTickAt).toBeNull();

    // schema drift → null
    fs.writeFileSync(file, JSON.stringify({ lastCuratorTickAt: "yesterday" }), "utf-8");
    expect(loadBatchState(file).lastCuratorTickAt).toBeNull();
  });

  it("startup persists a freshly-minted anchor (survives an immediate recycle)", async () => {
    const events: string[] = [];
    const before = Date.now();
    const handle = await start(6 * 3600_000, events);
    await handle.close();
    const anchor = loadBatchState(batchPath()).lastCuratorTickAt;
    expect(anchor).not.toBeNull();
    expect(anchor!).toBeGreaterThanOrEqual(before);
    expect(anchor!).toBeLessThanOrEqual(Date.now());
  });
});

describe("restart resilience (the starvation incident class)", () => {
  it("restart MID-period sleeps only the remainder — the countdown is NOT reset", async () => {
    const PERIOD = 6000;
    writeQueuedNote();

    // Instance A anchors the period at its start, then dies 3s in (a deploy).
    const eventsA: string[] = [];
    const a = await start(PERIOD, eventsA);
    await Bun.sleep(3000);
    await a.close();
    expect(eventsA.some((l) => l.startsWith("CURATOR_TICK: "))).toBe(false); // period not over

    // Instance B must tick after ≈ the REMAINDER (~3s), not a fresh 6s.
    const eventsB: string[] = [];
    const b = await start(PERIOD, eventsB);
    const arrived = await waitForTick(eventsB, 5000);
    await b.close();
    expect(arrived).not.toBe(-1); // old behavior: first tick ≥ 6s from B's start
    expect(arrived).toBeGreaterThanOrEqual(1500); // and not an instant catch-up
  }, 15_000);

  it("OVERDUE anchor (restart churn ate the period) → catch-up after the floor, not a full period", async () => {
    const PERIOD = 6000;
    writeQueuedNote();
    // A long-dead anchor, as left behind by a day of deploy churn.
    persistBatchState(batchPath(), {
      permanent: new Map(),
      silentStamps: new Map(),
      lastCuratorTickAt: Date.now() - 100_000,
    });

    const events: string[] = [];
    const handle = await start(PERIOD, events);
    const arrived = await waitForTick(events, 4000);
    await handle.close();
    expect(arrived).not.toBe(-1); // old behavior: 6s+; catch-up = floor (300ms) + startup
    expect(arrived).toBeLessThan(3000);
  }, 10_000);
});
