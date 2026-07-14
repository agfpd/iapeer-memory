/**
 * Archive grace window (инцидент boris 15.07: «финальный статус → мгновенный
 * архив» ронял дописку итогов по старому пути с «File does not exist»).
 *
 * Contract under test:
 *  1. A note that just received a final status STAYS at its path for the
 *     grace window — an append at the OLD path lands, restarts the window,
 *     and the note is archived LATER with the append preserved (the
 *     per-path grace timer re-feeds it without any external pass).
 *  2. The FULL pass (belt / startup sweep / runDetectPass) sweeps the whole
 *     monitored zone: a stale note that never produced an fs event for this
 *     process (status flipped while memoryd was down; grace timer lost to a
 *     restart) is archived once it is older than the grace window.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { startMemoryd, type MemorydHandle } from "../src/memoryd.js";
import { formatStamp } from "../src/human-edit-detect.js";
import type { CoreConfig } from "../src/config.js";
import { getTaxonomy, defaultExcludeFolders, DEFAULT_RANKING } from "../src/taxonomy.js";

const T = getTaxonomy("ru");
const STALE = T.statuses.stale[0]!; // устарело

let tmpdir: string;
let vault: string;
let handle: MemorydHandle | null = null;

function makeConfig(): CoreConfig {
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
    batch: { curatorMs: 6 * 3600_000 },
    mcp: { port: 0 },
    embedding: null,
    reranker: null,
  };
}

function note(status: string, body: string): string {
  return `---\ntitle: Закрываемая нить\nauthor: boris\nlast_edited_by: boris\nupdated: ${formatStamp(
    new Date(),
  )}\ntype: ${T.types.knowledge}\nstatus: ${status}\n---\n\n${body}\n`;
}

async function waitFor(cond: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return cond();
}

beforeEach(() => {
  tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), "iapeer-memory-grace-"));
  vault = path.join(tmpdir, "vault");
  fs.mkdirSync(path.join(vault, T.folders.knowledge), { recursive: true });
});

afterEach(async () => {
  await handle?.close();
  handle = null;
  fs.rmSync(tmpdir, { recursive: true, force: true });
});

describe("archive grace window", () => {
  it("ИНЦИДЕНТ 15.07: финальный статус → дописка по СТАРОМУ пути живёт, архив приходит позже и С допиской", async () => {
    handle = await startMemoryd({
      config: makeConfig(),
      emit: () => {},
      debounceMs: 80,
      archiveGraceMs: 500,
      mcpPort: null,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    });
    const p = path.join(vault, T.folders.knowledge, "Закрываемая нить.md");
    fs.writeFileSync(p, note(T.statusTokens.current, "Тело нити."), "utf-8");
    await new Promise((r) => setTimeout(r, 200));
    await handle.runDetectPass(); // baseline: active → stays

    // Шаг 1 инцидента: финальный статус.
    fs.writeFileSync(p, note(STALE, "Тело нити."), "utf-8");
    await new Promise((r) => setTimeout(r, 200));
    await handle.runDetectPass();

    // Grace держит заметку на месте — старый путь ЖИВ.
    expect(fs.existsSync(p)).toBe(true);

    // Шаг 2 инцидента: немедленная дописка итогов по старому пути.
    // До фикса здесь был ENOENT — файл уже уехал в 07_Архив.
    fs.appendFileSync(p, "\nДописка итогов приёмки.\n", "utf-8");

    // Никаких внешних пассов: собственный таймер grace должен сам довести
    // заметку до архива после тишины.
    const archived = path.join(vault, T.folders.archive, "Закрываемая нить.md");
    expect(await waitFor(() => fs.existsSync(archived) && !fs.existsSync(p), 8000)).toBe(true);
    expect(fs.readFileSync(archived, "utf-8")).toContain("Дописка итогов приёмки.");
    expect(fs.readFileSync(archived, "utf-8")).toContain(`status: ${STALE}`);
  });

  it("FULL-SWEEP: stale-заметка без fs-события этого процесса (класс «демон был мёртв») архивируется полным проходом", async () => {
    // Заметка становится stale ДО старта демона; mtime старше grace-окна.
    const p = path.join(vault, T.folders.knowledge, "Закрываемая нить.md");
    fs.writeFileSync(p, note(STALE, "Закрыта при выключенном демоне."), "utf-8");
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(p, old, old);

    handle = await startMemoryd({
      config: makeConfig(),
      emit: () => {},
      debounceMs: 80,
      archiveGraceMs: 500,
      mcpPort: null,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    });

    // runDetectPass = flush(full) — тот же конвейер, что belt и startup sweep.
    await handle.runDetectPass();
    const archived = path.join(vault, T.folders.archive, "Закрываемая нить.md");
    expect(fs.existsSync(archived)).toBe(true);
    expect(fs.existsSync(p)).toBe(false);
  });

  it("grace НЕ архивирует заметку, вернувшуюся в активный статус внутри окна", async () => {
    handle = await startMemoryd({
      config: makeConfig(),
      emit: () => {},
      debounceMs: 80,
      archiveGraceMs: 400,
      mcpPort: null,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    });
    const p = path.join(vault, T.folders.knowledge, "Закрываемая нить.md");
    fs.writeFileSync(p, note(STALE, "Ошибочно закрыта."), "utf-8");
    await new Promise((r) => setTimeout(r, 200));
    await handle.runDetectPass();
    expect(fs.existsSync(p)).toBe(true); // grace держит

    // Автор передумал — вернул активный статус внутри окна.
    fs.writeFileSync(p, note(T.statusTokens.current, "Снова живая."), "utf-8");

    // Даём таймеру grace отработать вхолостую и полному проходу пройти.
    await new Promise((r) => setTimeout(r, 900));
    await handle.runDetectPass();
    expect(fs.existsSync(p)).toBe(true); // осталась в каноне
    expect(fs.existsSync(path.join(vault, T.folders.archive, "Закрываемая нить.md"))).toBe(false);
  });
});
