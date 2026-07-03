/**
 * Stage-9 e2e: memoryd over a throwaway vault.
 *
 * Ports the reference `server.e2e.test.ts` contract under the MCP-HTTP
 * transport (ADR-012): of the 13 reference cases the 3 vault_read ones do
 * NOT return (vault_read is off the surface, ADR-008) — replaced by the
 * surface assert and identity-header cases. Plus the stage smoke: a file
 * edit produces a coalesced curator-tick line over the changed canon.
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Database } from "bun:sqlite";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { startMemoryd, acquireMemorydLock, parsePersonalityFromIdentity, MEMORYD_SERVER_NAME, type MemorydHandle } from "../src/memoryd.js";
import { formatStamp } from "../src/human-edit-detect.js";
import type { CoreConfig } from "../src/config.js";
import {
  getTaxonomy,
  defaultExcludeFolders,
  DEFAULT_RANKING,
} from "../src/taxonomy.js";

const T = getTaxonomy("ru");

let tmpdir: string;
let vault: string;
let handle: MemorydHandle;
let events: string[] = [];

function writeNote(rel: string, content: string): string {
  const full = path.join(vault, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, "utf-8");
  return full;
}

function makeConfig(): CoreConfig {
  return {
    vaultPath: vault,
    locale: "ru",
    taxonomy: T,
    ranking: { ...DEFAULT_RANKING },
    curatorSet: ["index", "scriber", "dreamweaver"], // = DEFAULT_CURATOR_SET (бренд-тройка)
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

async function mcpClient(identity?: string): Promise<Client> {
  const client = new Client({ name: "e2e-test", version: "0.0.1" });
  const transport = new StreamableHTTPClientTransport(
    new URL(`http://127.0.0.1:${handle.mcpPort}/mcp`),
    identity
      ? { requestInit: { headers: { "X-IAPeer-Identity": identity } } }
      : undefined,
  );
  await client.connect(transport);
  return client;
}

beforeAll(async () => {
  tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), "iapeer-memory-memoryd-"));
  vault = path.join(tmpdir, "vault");
  fs.mkdirSync(path.join(vault, T.folders.knowledge), { recursive: true });

  writeNote(
    `${T.folders.knowledge}/Гибридный поиск.md`,
    `---\ntitle: Гибридный поиск\nauthor: boris\ntype: ${T.types.knowledge}\nstatus: ${T.statusTokens.current}\n---\n\nГибридный поиск сочетает BM25 и векторное сходство. Ссылка на [[Соседняя заметка]].\n`,
  );
  writeNote(
    `${T.folders.knowledge}/Соседняя заметка.md`,
    `---\ntitle: Соседняя заметка\nauthor: boris\ntype: ${T.types.knowledge}\nstatus: ${T.statusTokens.current}\n---\n\nСосед по графу.\n`,
  );
  writeNote(
    `${T.folders.agentMemory}/linus/Чужая память.md`,
    `---\ntitle: Чужая память\nauthor: linus\ntype: ${T.types.agentMemory}\nsubtype: ${T.subtypes.reference}\nstatus: ${T.statusTokens.current}\n---\n\nГибридный поиск — личная справка linus.\n`,
  );

  events = [];
  handle = await startMemoryd({
    config: makeConfig(),
    emit: (line) => events.push(line),
    debounceMs: 120,
    humanName: "artur",
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  });
});

afterAll(async () => {
  await handle.close();
  fs.rmSync(tmpdir, { recursive: true, force: true });
});

// ── handshake & contract (reference block 1) ────────────────────────────────

describe("memoryd.e2e — handshake & contract", () => {
  it("initialize returns expected serverInfo + instructions", async () => {
    const client = await mcpClient();
    const sv = client.getServerVersion();
    expect(sv?.name).toBe(MEMORYD_SERVER_NAME);
    // Server instructions carry the shared, once-injected contract (snapshot +
    // open-with-native-Read), NOT a per-tool roster — that lives in each tool's
    // own description (atomicity: each fact in one place).
    expect(client.getInstructions()).toContain("native Read");
    await client.close();
  });

  it("tools/list returns EXACTLY the three tools — vault_read absent (ADR-008)", async () => {
    const client = await mcpClient();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "memory_map",
      "memory_related",
      "memory_search",
    ]);
    expect(tools.map((t) => t.name)).not.toContain("vault_read");
    await client.close();
  });

  it("each tool declares an inputSchema and outputSchema", async () => {
    const client = await mcpClient();
    const { tools } = await client.listTools();
    for (const tool of tools) {
      expect(tool.inputSchema).toBeDefined();
      expect(tool.outputSchema).toBeDefined();
    }
    await client.close();
  });

  it("§6.1 Directory HARD criteria: title + readOnlyHint + destructiveHint on every tool", async () => {
    // These are pass/fail Anthropic Directory annotations — a regression that
    // dropped them would otherwise pass CI silently (all three tools read-only).
    const client = await mcpClient();
    const { tools } = await client.listTools();
    expect(tools).toHaveLength(3);
    for (const tool of tools) {
      const a = (tool as { annotations?: Record<string, unknown> }).annotations ?? {};
      const title = (tool as { title?: string }).title;
      expect(typeof title).toBe("string");
      expect((title as string).length).toBeGreaterThan(0);
      expect(a.readOnlyHint).toBe(true);
      expect(a.destructiveHint).toBe(false);
      expect(tool.name.length).toBeLessThanOrEqual(64);
      // §6.1 HARD: tool descriptions must NOT instruct behaviour (the
      // "open with native Read" usage hint lives in server-instructions only).
      expect(tool.description ?? "").not.toContain("native Read");
    }
    await client.close();
  });
});

// ── memory_search (reference block 2) ────────────────────────────────────────

describe("memoryd.e2e — memory_search over http", () => {
  it("returns structuredContent matching the output shape; BM25-only pipeline ok", async () => {
    const client = await mcpClient("claude-boris");
    const res = (await client.callTool({
      name: "memory_search",
      arguments: { query: "гибридный поиск" },
    })) as { structuredContent?: { query: string; results: Array<{ path: string; score: number }>; pipeline: { bm25: string; caller_agent: string | null } } };
    const sc = res.structuredContent!;
    expect(sc.query).toBe("гибридный поиск");
    expect(sc.results.length).toBeGreaterThanOrEqual(1);
    expect(sc.results[0]!.score).toBe(1); // display normalisation
    expect(sc.pipeline.bm25).toBe("ok");
    await client.close();
  });

  it("rejects an empty query at the schema layer", async () => {
    const client = await mcpClient();
    const res = (await client.callTool({
      name: "memory_search",
      arguments: { query: "" },
    })) as { isError?: boolean };
    expect(res.isError).toBe(true);
    await client.close();
  });
});

// ── identity header (ADR-012, replaces the dropped vault_read block) ────────

describe("memoryd.e2e — identity header", () => {
  it("X-IAPeer-Identity reaches pipeline.caller_agent (runtime prefix stripped)", async () => {
    const client = await mcpClient("claude-boris");
    const res = (await client.callTool({
      name: "memory_search",
      arguments: { query: "гибридный поиск" },
    })) as { structuredContent?: { pipeline: { caller_agent: string | null } } };
    expect(res.structuredContent!.pipeline.caller_agent).toBe("boris");
    await client.close();
  });

  it("no header → caller_agent null (identity-dependent mechanics off)", async () => {
    const client = await mcpClient();
    const res = (await client.callTool({
      name: "memory_search",
      arguments: { query: "гибридный поиск" },
    })) as { structuredContent?: { pipeline: { caller_agent: string | null } } };
    expect(res.structuredContent!.pipeline.caller_agent).toBeNull();
    await client.close();
  });

  it("parsePersonalityFromIdentity strips only known runtime prefixes", () => {
    expect(parsePersonalityFromIdentity("claude-iapeer-memory")).toBe("iapeer-memory");
    expect(parsePersonalityFromIdentity("codex-linus")).toBe("linus");
    expect(parsePersonalityFromIdentity("boris")).toBe("boris");
    expect(parsePersonalityFromIdentity("")).toBeNull();
    expect(parsePersonalityFromIdentity(null)).toBeNull();
  });
});

// ── memory_related (reference block 4) ─────────────────────────────────────────

describe("memoryd.e2e — memory_related over http", () => {
  it("returns center + nodes for an indexed note", async () => {
    const client = await mcpClient();
    const res = (await client.callTool({
      name: "memory_related",
      arguments: { path: `${T.folders.knowledge}/Гибридный поиск.md`.normalize("NFD"), depth: 1 },
    })) as { structuredContent?: { center?: { title: string }; nodes?: Array<{ path: string }> } };
    const sc = res.structuredContent!;
    expect(sc.center).toBeDefined();
    expect((sc.nodes ?? []).length).toBeGreaterThanOrEqual(1);
    await client.close();
  });

  it("returns the not-found payload for an unknown path (no isError)", async () => {
    const client = await mcpClient();
    const res = (await client.callTool({
      name: "memory_related",
      arguments: { path: `${T.folders.knowledge}/Нет такой.md` },
    })) as { isError?: boolean; structuredContent?: { found?: boolean } };
    expect(res.isError ?? false).toBe(false);
    expect(res.structuredContent!.found).toBe(false);
    await client.close();
  });
});

// ── memory_map (reference block 5) ───────────────────────────────────────────

describe("memoryd.e2e — memory_map over http", () => {
  it("returns stats + default parts on no args; agent memory excluded", async () => {
    const client = await mcpClient();
    const res = (await client.callTool({
      name: "memory_map",
      arguments: {},
    })) as { structuredContent?: { stats: { documents: number }; parts: string[] } };
    const sc = res.structuredContent!;
    expect(sc.stats.documents).toBe(2); // только канон, оперативка исключена
    expect([...sc.parts].sort()).toEqual(["bridges", "clusters", "hubs", "orphans"]);
    await client.close();
  });

  it("respects a parts subset", async () => {
    const client = await mcpClient();
    const res = (await client.callTool({
      name: "memory_map",
      arguments: { parts: ["orphans"] },
    })) as { structuredContent?: { parts: string[]; clusters?: unknown } };
    const sc = res.structuredContent!;
    expect(sc.parts).toEqual(["orphans"]);
    expect(sc.clusters).toBeUndefined();
    await client.close();
  });
});

// ── dedup RPC (lean §3a, memoryd-internal, NOT an MCP tool) ─────────────────

describe("memoryd.e2e — /dedup hint endpoint", () => {
  it("POST /dedup returns enabled:false with embeddings disabled (silent dedup)", async () => {
    const res = await fetch(`http://127.0.0.1:${handle.mcpPort}/dedup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "гибридный поиск сочетает BM25 и вектор" }),
    });
    expect(res.ok).toBe(true);
    const json = (await res.json()) as { enabled: boolean; matches: unknown[] };
    expect(json.enabled).toBe(false); // e2e config has no embedding provider
    expect(json.matches).toEqual([]);
  });

  it("GET /dedup (or any non-POST) falls through to 404 — it is POST-only", async () => {
    const res = await fetch(`http://127.0.0.1:${handle.mcpPort}/dedup`, { method: "GET" });
    expect(res.status).toBe(404);
  });

  it("empty content → enabled flag without a search", async () => {
    const res = await fetch(`http://127.0.0.1:${handle.mcpPort}/dedup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "   " }),
    });
    const json = (await res.json()) as { matches: unknown[] };
    expect(json.matches).toEqual([]);
  });
});

// ── unknown tool (reference block 6) ────────────────────────────────────────

describe("memoryd.e2e — unknown tool", () => {
  it("returns an error for a non-registered tool name (vault_read included)", async () => {
    const client = await mcpClient();
    const res = (await client.callTool({
      name: "vault_read",
      arguments: { path: "x.md" },
    })) as { isError?: boolean; content?: Array<{ text?: string }> };
    expect(res.isError).toBe(true);
    expect(res.content?.[0]?.text ?? "").toContain("vault_read");
    await client.close();
  });
});

// ── stage smoke: live events ────────────────────────────────────────────────

describe("memoryd.e2e — event stream smoke", () => {
  it("каденция + очередь: needs_review:true нота в наборе тика (НЕ мгновенно, только на curator-tick); самовозврат до снятия", async () => {
    events.length = 0;
    writeNote(
      `${T.folders.knowledge}/В очереди.md`,
      `---\ntitle: В очереди\nauthor: boris\ntype: ${T.types.knowledge}\nstatus: ${T.statusTokens.current}\nlast_edited_by: boris\nupdated: ${formatStamp(new Date())}\nneeds_review: true\n---\n\nТело в очереди курации.\n`,
    );
    await new Promise((r) => setTimeout(r, 200));
    await handle.runDetectPass();
    expect(events.filter((l) => l.startsWith("CURATOR_TICK"))).toHaveLength(0); // не мгновенно (каденция)

    handle.runCuratorTick();
    const batch = events.filter((l) => l.startsWith("CURATOR_TICK: "));
    expect(batch).toHaveLength(1);
    const paths = JSON.parse(batch[0]!.slice("CURATOR_TICK: ".length)) as string[];
    expect(paths.some((x) => x.normalize("NFD").includes("В очереди.md".normalize("NFD")))).toBe(true);
    expect(paths.every((x) => x.startsWith(vault))).toBe(true); // абсолютные

    // self-returning queue (Release 3): the flag is NOT cleared, so a repeat
    // tick STILL emits the note — the curator's work-set is the needs_review
    // queue and persists until the flag clears (closure), unlike the old
    // one-shot smart-hash diff that went silent once the baseline absorbed it.
    events.length = 0;
    handle.runCuratorTick();
    const repeat = events.filter((l) => l.startsWith("CURATOR_TICK: "));
    expect(repeat).toHaveLength(1);
    const repeatPaths = JSON.parse(repeat[0]!.slice("CURATOR_TICK: ".length)) as string[];
    expect(
      repeatPaths.some((x) => x.normalize("NFD").includes("В очереди.md".normalize("NFD"))),
    ).toBe(true);
  });

  it("needs_review closure: Index curation (leb=index + hash moved) auto-clears the flag", async () => {
    const stamp = () => formatStamp(new Date());
    const p = writeNote(
      `${T.folders.knowledge}/Закрытие очереди.md`,
      `---\ntitle: Закрытие очереди\nauthor: boris\ntype: ${T.types.knowledge}\nstatus: ${T.statusTokens.current}\nlast_edited_by: boris\nupdated: ${stamp()}\nneeds_review: true\n---\n\nИсходное тело.\n`,
    );
    await new Promise((r) => setTimeout(r, 200));
    await handle.runDetectPass(); // first-sight → silentStamps baseline
    // it is in the queue while flagged
    events.length = 0;
    handle.runCuratorTick();
    const q = JSON.parse(
      events.filter((l) => l.startsWith("CURATOR_TICK: "))[0]!.slice("CURATOR_TICK: ".length),
    ) as string[];
    expect(q.some((x) => x.normalize("NFD").includes("Закрытие очереди.md".normalize("NFD")))).toBe(true);
    // Index curates: leb=index + FRESH updated + BODY changed (semantic hash moves)
    fs.writeFileSync(
      p,
      `---\ntitle: Закрытие очереди\nauthor: boris\ntype: ${T.types.knowledge}\nstatus: ${T.statusTokens.current}\nlast_edited_by: index\nupdated: ${stamp()}\nneeds_review: true\n---\n\nКурированное тело со связью [[Гибридный поиск]].\n`,
      "utf-8",
    );
    await new Promise((r) => setTimeout(r, 200));
    await handle.runDetectPass();
    expect(fs.readFileSync(p, "utf-8")).toContain("needs_review: false"); // auto-cleared
  });

  it("needs_review closure: service-only Index touch (hash NOT moved) does NOT clear (inv 5)", async () => {
    const stamp = () => formatStamp(new Date());
    const body = "\n\nТело которое НЕ меняется.\n";
    const p = writeNote(
      `${T.folders.knowledge}/Служебный тач.md`,
      `---\ntitle: Служебный тач\nauthor: boris\ntype: ${T.types.knowledge}\nstatus: ${T.statusTokens.current}\nlast_edited_by: boris\nupdated: ${stamp()}\nneeds_review: true\n---${body}`,
    );
    await new Promise((r) => setTimeout(r, 200));
    await handle.runDetectPass(); // baseline
    // service-only: leb=index + fresh updated, body + non-service fm UNCHANGED
    fs.writeFileSync(
      p,
      `---\ntitle: Служебный тач\nauthor: boris\ntype: ${T.types.knowledge}\nstatus: ${T.statusTokens.current}\nlast_edited_by: index\nupdated: ${stamp()}\nneeds_review: true\n---${body}`,
      "utf-8",
    );
    await new Promise((r) => setTimeout(r, 200));
    await handle.runDetectPass();
    expect(fs.readFileSync(p, "utf-8")).toContain("needs_review: true"); // NOT cleared
  });

  it("ПРЕЦЕДЕНТ (permanent): немая правка тела в свежем окне перештамповывается unstamped, а не глотается echo-окном", async () => {
    // body-правка через 52с после штампа куратора падала в
    // Case 2 echo-agent и съедалась recordHash'ем НАВСЕГДА.
    const fm = (body: string) =>
      `---\ntitle: Немая канон-заметка\nauthor: boris\nlast_edited_by: index\nupdated: ${formatStamp(new Date())}\n---\n\n${body}\n`;
    const head = fm("Тело до немой правки.");
    const p = writeNote(`${T.folders.knowledge}/Немая канон-заметка.md`, head);
    await new Promise((r) => setTimeout(r, 300)); // fs.watch → pending
    await handle.runDetectPass(); // first-sight
    // немая правка: ТОЛЬКО тело, штамп стоит (срез head до body-строки)
    fs.writeFileSync(p, head.replace("Тело до немой правки.", "Тело ПОСЛЕ немой правки."), "utf-8");
    await new Promise((r) => setTimeout(r, 300));
    await handle.runDetectPass();
    const text = fs.readFileSync(p, "utf-8");
    expect(text).toContain("last_edited_by: unstamped");
    expect(text).toContain("needs_review: true");
    expect(text).not.toContain("last_edited_by: artur"); // не свалено на human
  });

  it("FIRST-SIGHT: появление файла в каноне (mv размещения) НЕ стампится human-edit'ом (churn-фикс)", async () => {
    // mv Индекса = новый путь в hash-базе; старый updated (>90с) выглядел
    // как нестампленная человеческая правка → фантомный last_edited_by.
    const p = writeNote(
      `${T.folders.knowledge}/Размещённая заметка.md`,
      "---\ntitle: Размещённая заметка\nauthor: linus\nlast_edited_by: index\nupdated: 2026-06-09 10:00:00\n---\n\nРазмещённый канон.\n",
    );
    await new Promise((r) => setTimeout(r, 300)); // fs.watch → pending
    await handle.runDetectPass();
    const text = fs.readFileSync(p, "utf-8");
    expect(text).not.toContain("last_edited_by: artur"); // фантома нет
    expect(text).toContain("last_edited_by: index"); // атрибуция цела
    // LOAD-BEARING INVARIANT (boris flag-1 критерий #2): a SETTLED note (has
    // author) seen first time at startup is NEVER re-stamped — only baselined.
    expect(text).toContain("author: linus");
  });

  it("§9-fix (flag-1 крит.#1): a human's BARE-BODY canon note (no author) is FILLED on the FIRST fs event", async () => {
    // The first-sight guard discriminates by `author`: authorless = genuinely
    // new (a human's fresh bare note) → fill it now, don't defer to a 2nd event.
    const p = writeNote(`${T.folders.knowledge}/Голая мысль человека.md`, "Сырое тело без шапки.\n");
    await new Promise((r) => setTimeout(r, 300)); // fs.watch → pending
    await handle.runDetectPass();
    const text = fs.readFileSync(p, "utf-8");
    expect(text).toContain("author: artur"); // attributed to the human owner
    expect(text).toContain(`type: ${T.types.knowledge}`); // type from the folder
    expect(text).toContain(`status: ${T.initialStatus.knowledge}`);
    expect(text).toContain("needs_review: true"); // flagged for curation
    expect(text).toContain("Сырое тело без шапки."); // body preserved
  });

  it("lean §2.2a: a canon note marked stale is MOVED to the archive on the next pass, staying searchable", async () => {
    const rel = `${T.folders.knowledge}/Устаревающая заметка.md`;
    const head = (status: string) =>
      `---\ntitle: Устаревающая заметка\nauthor: boris\nlast_edited_by: boris\nupdated: ${formatStamp(new Date())}\ntype: ${T.types.knowledge}\nstatus: ${status}\n---\n\nТело со ссылкой [[Соседняя заметка]].\n`;
    const p = writeNote(rel, head(T.statusTokens.current));
    await new Promise((r) => setTimeout(r, 250)); // fs.watch → pending
    await handle.runDetectPass();
    expect(fs.existsSync(p)).toBe(true); // active → stays in canon

    // the author marks it stale (final token)
    fs.writeFileSync(p, head(T.statuses.stale[0]!), "utf-8"); // устарело
    await new Promise((r) => setTimeout(r, 250));
    await handle.runDetectPass();

    // moved: source gone, archive copy present (flat)
    expect(fs.existsSync(p)).toBe(false);
    const archived = path.join(vault, T.folders.archive, "Устаревающая заметка.md");
    expect(fs.existsSync(archived)).toBe(true);
    expect(fs.readFileSync(archived, "utf-8")).toContain(`status: ${T.statuses.stale[0]}`);

    // still searchable from the archive (archive is not excluded; stale boost)
    const client = await mcpClient("claude-boris");
    const res = (await client.callTool({
      name: "memory_search",
      arguments: { query: "устаревающая заметка" },
    })) as { structuredContent?: { results: Array<{ path: string }> } };
    const hit = res.structuredContent!.results.some((r) =>
      r.path.normalize("NFD").includes("Устаревающая заметка".normalize("NFD")),
    );
    expect(hit).toBe(true);
    await client.close();
  });

  it("a service-field-only edit raises no needs_review → not in the curator queue", async () => {
    events.length = 0;
    const p = path.join(vault, T.folders.knowledge, "Соседняя заметка.md");
    const content = fs.readFileSync(p, "utf-8");
    fs.writeFileSync(
      p,
      content.replace(
        "---\n\nСосед",
        "updated: 2026-06-09 12:00:00\n---\n\nСосед",
      ),
      "utf-8",
    );
    await handle.runDetectPass();
    handle.runCuratorTick();
    // Under queue-semantics the tick emits whenever ANY note is flagged; the
    // property is that THIS service-only-edited note (no needs_review) is NOT in
    // the queue — a service edit does not enrol a note into curation.
    const batch = events.filter((l) => l.startsWith("CURATOR_TICK: "));
    if (batch.length) {
      const paths = JSON.parse(batch[0]!.slice("CURATOR_TICK: ".length)) as string[];
      expect(
        paths.some((x) => x.normalize("NFD").includes("Соседняя заметка.md".normalize("NFD"))),
      ).toBe(false);
    }
  });
});

// ── fleet fragment rendering (docs/05: контракт «memoryd
// рендерит непрерывно» был обещан и не подключён — пиры после рестарта не
// знали пути записи vault) ──────────────────────────────────────────────────

describe("memoryd.e2e — fleet fragment rendering", () => {
  let ftmp: string;
  let fvault: string;
  let linusCwd: string;
  let fhandle: MemorydHandle;
  const fragmentOf = (cwd: string) =>
    path.join(cwd, ".iapeer", "fragments", "iapeer-memory.md");

  function fconfig(): CoreConfig {
    return {
      ...makeConfig(),
      vaultPath: fvault,
      index: { dbPath: path.join(ftmp, "index.db"), fullScanOnStartup: true },
    };
  }

  beforeAll(async () => {
    ftmp = fs.mkdtempSync(path.join(os.tmpdir(), "iapeer-memory-frag-"));
    fvault = path.join(ftmp, "vault");
    fs.mkdirSync(path.join(fvault, T.folders.knowledge), { recursive: true });
    fs.mkdirSync(path.join(fvault, T.folders.knowledge), { recursive: true });
    fs.writeFileSync(
      path.join(fvault, T.folders.knowledge, "Заметка линуса.md"),
      `---\ntitle: Заметка линуса\nauthor: linus\ntype: ${T.types.knowledge}\nstatus: ${T.statusTokens.current}\n---\n\nТело.\n`,
      "utf-8",
    );
    linusCwd = path.join(ftmp, "peers", "linus");
    fs.mkdirSync(linusCwd, { recursive: true });
    fs.writeFileSync(
      path.join(ftmp, "fleet.json"),
      JSON.stringify({
        updatedAt: "2026-06-10T00:00:00.000Z",
        peers: [
          { personality: "linus", cwd: linusCwd },
          // cwd не существует — пир удалён: рендер обязан ПРОПУСТИТЬ, не скаффолдить
          { personality: "ghost", cwd: path.join(ftmp, "peers", "ghost") },
        ],
      }),
      "utf-8",
    );
    fhandle = await startMemoryd({
      config: fconfig(),
      emit: () => {},
      debounceMs: 60,
      mcpPort: null,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      fragments: {
        fleetMapPath: path.join(ftmp, "fleet.json"),
        paths: {
          vault: fvault,
          db: path.join(ftmp, "index.db"),
          state: path.join(ftmp, "state"),
          cache: path.join(ftmp, "cache"),
        },
        authorIndexPathFor: (agent) => path.join(ftmp, "indexes", `${agent}-vault-index.md`),
      },
    });
  });

  afterAll(async () => {
    await fhandle.close();
    fs.rmSync(ftmp, { recursive: true, force: true });
  });

  it("startup renders the whole fleet: paths-блок + индекс автора; пир без cwd пропущен", () => {
    const frag = fs.readFileSync(fragmentOf(linusCwd), "utf-8");
    expect(frag).toContain("<iapeer-memory-paths>");
    expect(frag).toContain(`vault: ${fvault}`); // источник пути записи
    expect(frag.normalize("NFD")).toContain("Заметка линуса".normalize("NFD"));
    // -full вариант индекса тоже на месте
    expect(fs.existsSync(path.join(ftmp, "indexes", "linus-vault-index-full.md"))).toBe(true);
    // удалённый пир НЕ скаффолдится
    expect(fs.existsSync(path.join(ftmp, "peers", "ghost"))).toBe(false);
  });

  it("a vault change re-renders the author's fragment (свежесть за секунды)", async () => {
    fs.writeFileSync(
      path.join(fvault, T.folders.knowledge, "Вторая заметка линуса.md"),
      `---\ntitle: Вторая заметка линуса\nauthor: linus\ntype: ${T.types.knowledge}\nstatus: ${T.statusTokens.current}\n---\n\nТело два.\n`,
      "utf-8",
    );
    await new Promise((r) => setTimeout(r, 200)); // fs.watch → pending
    await fhandle.runDetectPass();
    const frag = fs.readFileSync(fragmentOf(linusCwd), "utf-8");
    expect(frag.normalize("NFD")).toContain("Вторая заметка линуса".normalize("NFD"));
  });

  it("missing fleet map → rendering quietly off (fail-open, no scaffold)", async () => {
    const qtmp = fs.mkdtempSync(path.join(os.tmpdir(), "iapeer-memory-frag-q-"));
    const qvault = path.join(qtmp, "vault");
    fs.mkdirSync(path.join(qvault, T.folders.knowledge), { recursive: true });
    const qhandle = await startMemoryd({
      config: { ...makeConfig(), vaultPath: qvault, index: { dbPath: path.join(qtmp, "index.db"), fullScanOnStartup: true } },
      emit: () => {},
      debounceMs: 60,
      mcpPort: null,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      fragments: {
        fleetMapPath: path.join(qtmp, "no-such-fleet.json"),
        paths: { vault: qvault, state: path.join(qtmp, "state"), cache: path.join(qtmp, "cache") },
        authorIndexPathFor: (agent) => path.join(qtmp, "indexes", `${agent}-vault-index.md`),
      },
    });
    try {
      await qhandle.runDetectPass(); // не падает
      expect(fs.existsSync(path.join(qtmp, "indexes"))).toBe(false); // ничего не рендерилось
    } finally {
      await qhandle.close();
      fs.rmSync(qtmp, { recursive: true, force: true });
    }
  });
});

// ── watch-loss degradation contour (audit critical #6) ──────────────────────
// Pre-fix: a dead fs.watch froze the index and all renders FOREVER while the
// heartbeat kept ticking green. The contour: polling drives the same pipeline
// at reduced latency, and the heartbeat file carries `watch=on|off` so
// verify/status can see the degradation.

describe("memoryd.e2e — watch-loss degradation (audit critical #6)", () => {
  let wtmp: string;
  let wvault: string;

  beforeAll(() => {
    wtmp = fs.mkdtempSync(path.join(os.tmpdir(), "iapeer-memory-watchloss-"));
    wvault = path.join(wtmp, "vault");
    fs.mkdirSync(path.join(wvault, T.folders.knowledge), { recursive: true });
  });

  afterAll(() => {
    fs.rmSync(wtmp, { recursive: true, force: true });
  });

  function wconfig(sub: string): CoreConfig {
    return {
      ...makeConfig(),
      vaultPath: wvault,
      index: { dbPath: path.join(wtmp, `${sub}.db`), fullScanOnStartup: true },
    };
  }

  it("a healthy daemon advertises watch=on in the heartbeat", async () => {
    const hb = path.join(wtmp, "hb-on");
    const h = await startMemoryd({
      config: wconfig("on"),
      emit: () => {},
      mcpPort: null,
      heartbeatPath: hb,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    });
    try {
      expect(fs.readFileSync(hb, "utf-8")).toContain("watch=on");
    } finally {
      await h.close();
    }
  });

  it("without fs.watch the polling contour still picks up a new note; heartbeat says watch=off", async () => {
    const hb = path.join(wtmp, "hb-off");
    const db = path.join(wtmp, "off.db");
    const h = await startMemoryd({
      config: wconfig("off"),
      emit: () => {},
      mcpPort: null,
      heartbeatPath: hb,
      disableWatch: true, // the watch-loss path, from tick one
      watchFallbackMs: 150,
      debounceMs: 40,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    });
    try {
      expect(fs.readFileSync(hb, "utf-8")).toContain("watch=off");

      // A note lands AFTER startup — no fs.watch to see it.
      fs.writeFileSync(
        path.join(wvault, T.folders.knowledge, "Слепая заметка.md"),
        `---\ntitle: Слепая заметка\nauthor: boris\ntype: ${T.types.knowledge}\nstatus: ${T.statusTokens.current}\n---\n\nТело, которое обязан увидеть polling.\n`,
        "utf-8",
      );

      // Poll (150ms) + debounce (40ms) + flush — a couple of seconds is ample.
      const sqlite = new Database(db, { readonly: true });
      let found = false;
      for (let i = 0; i < 40 && !found; i++) {
        await new Promise((r) => setTimeout(r, 100));
        const row = sqlite
          .prepare("SELECT COUNT(*) AS n FROM documents WHERE title = ?")
          .get("Слепая заметка") as { n: number };
        found = row.n === 1;
      }
      sqlite.close();
      expect(found).toBe(true); // index stayed LIVE without fs.watch
    } finally {
      await h.close();
    }
  });
});

// ── memoryd batch (audit important): flush loss / shutdown flush / debounce
// max-wait / single-writer lock / backfill dedup ─────────────────────────────

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("memoryd.e2e — flush-loss / shutdown / storm / lock (audit important batch)", () => {
  let btmp: string;
  let bvault: string;

  beforeAll(() => {
    btmp = fs.mkdtempSync(path.join(os.tmpdir(), "iapeer-memory-batch-"));
    bvault = path.join(btmp, "vault");
    fs.mkdirSync(path.join(bvault, T.folders.knowledge), { recursive: true });
  });

  afterAll(() => {
    fs.rmSync(btmp, { recursive: true, force: true });
  });

  function bconfig(sub: string, vaultPath = bvault): CoreConfig {
    return {
      ...makeConfig(),
      vaultPath,
      index: { dbPath: path.join(btmp, `${sub}.db`), fullScanOnStartup: true },
    };
  }

  function bnote(vaultPath: string, title: string): void {
    fs.writeFileSync(
      path.join(vaultPath, T.folders.knowledge, `${title}.md`),
      `---\ntitle: ${title}\nauthor: boris\ntype: ${T.types.knowledge}\nstatus: ${T.statusTokens.current}\n---\n\nТело: ${title}.\n`,
      "utf-8",
    );
  }

  function hasDoc(dbPath: string, title: string): boolean {
    const sq = new Database(dbPath, { readonly: true });
    try {
      const row = sq
        .prepare("SELECT COUNT(*) AS n FROM documents WHERE title = ?")
        .get(title) as { n: number };
      return row.n === 1;
    } finally {
      sq.close();
    }
  }

  it("shutdown flush: close() inside the debounce window does not drop pending", async () => {
    const dbPath = path.join(btmp, "shutdown.db");
    const h = await startMemoryd({
      config: bconfig("shutdown"),
      emit: () => {},
      mcpPort: null,
      debounceMs: 60_000, // the debounce alone would NEVER fire in this test
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    });
    try {
      bnote(bvault, "Предсмертная заметка");
      await sleep(400); // fs.watch delivery → pending
    } finally {
      await h.close(); // pre-fix: pending silently dropped here
    }
    expect(hasDoc(dbPath, "Предсмертная заметка")).toBe(true);
  });

  it("debounce max-wait cap: a continuous event storm cannot defer flush forever", async () => {
    const dbPath = path.join(btmp, "storm.db");
    const h = await startMemoryd({
      config: bconfig("storm"),
      emit: () => {},
      mcpPort: null,
      debounceMs: 120,
      debounceMaxWaitMs: 400,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    });
    try {
      // Events every 70ms (< debounceMs) for ~1.1s — pre-fix the timer reset
      // on every event and flush never ran during the storm.
      for (let i = 0; i < 16; i++) {
        bnote(bvault, `Шторм ${i}`);
        await sleep(70);
      }
      // Immediately after the last event: the 120ms debounce has NOT fired
      // yet — only the cap can have flushed by now.
      expect(hasDoc(dbPath, "Шторм 0")).toBe(true);
    } finally {
      await h.close();
    }
  });

  it("vault unavailable at flush time: the changed set is re-queued and retried", async () => {
    const rvault = path.join(btmp, "rvault");
    fs.mkdirSync(path.join(rvault, T.folders.knowledge), { recursive: true });
    const dbPath = path.join(btmp, "requeue.db");
    const h = await startMemoryd({
      config: bconfig("requeue", rvault),
      emit: () => {},
      mcpPort: null,
      debounceMs: 250, // retry backoff base = 4× = 1s
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    });
    try {
      bnote(rvault, "Ретрай заметка");
      await sleep(150); // watch delivered, debounce still pending
      fs.renameSync(rvault, `${rvault}-away`); // unmount window
      await sleep(400); // debounce fired → flush → vault unavailable → re-queue
      expect(hasDoc(dbPath, "Ретрай заметка")).toBe(false); // and NOT lost silently…
      fs.renameSync(`${rvault}-away`, rvault); // vault back
      // …the bounded-backoff retry replays the pass without any new fs event.
      let found = false;
      for (let i = 0; i < 40 && !found; i++) {
        await sleep(100);
        found = hasDoc(dbPath, "Ретрай заметка");
      }
      expect(found).toBe(true);
    } finally {
      await h.close();
    }
  });

  it("single-writer lock: a second memoryd on the same DB dir refuses while the first lives", async () => {
    const h1 = await startMemoryd({
      config: bconfig("lock1"),
      emit: () => {},
      mcpPort: null,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    });
    try {
      // Same dbDir (btmp) → same lock. The lock is FRESH (heartbeat touch).
      await expect(
        startMemoryd({
          config: bconfig("lock2"),
          emit: () => {},
          mcpPort: null,
          logger: { info: () => {}, warn: () => {}, error: () => {} },
        }),
      ).rejects.toThrow(/another memoryd/);
    } finally {
      await h1.close();
    }
    // Graceful close released the lock — the next writer starts freely.
    const h2 = await startMemoryd({
      config: bconfig("lock3"),
      emit: () => {},
      mcpPort: null,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    });
    await h2.close();
  });

  it("acquireMemorydLock: pidAlive probe decides — live owner refuses, dead owner is taken over", () => {
    const lp = path.join(btmp, "probe.lock");
    fs.writeFileSync(lp, "424242\n");
    expect(() => acquireMemorydLock(lp, { pidAlive: () => true })).toThrow(/another memoryd/);
    const release = acquireMemorydLock(lp, { pidAlive: () => false }); // crashed owner
    expect(fs.readFileSync(lp, "utf-8").trim()).toBe(String(process.pid));
    release();
    expect(fs.existsSync(lp)).toBe(false);
  });

  it("acquireMemorydLock: mtime fallback — a fresh lock refuses, a stale one is swept", () => {
    const lp = path.join(btmp, "mtime.lock");
    fs.writeFileSync(lp, "999999\n"); // fresh mtime = owner presumed alive
    expect(() => acquireMemorydLock(lp)).toThrow(/another memoryd/);
    const old = new Date(Date.now() - 10 * 60_000);
    fs.utimesSync(lp, old, old); // a crashed owner stops touching the lock
    const release = acquireMemorydLock(lp);
    release();
  });
});

describe("memoryd.e2e — flush does not drain the embed queue during backfill (audit important)", () => {
  it("runDetectPass during a blocked backfill returns without embedding; the backfill drains everything after", async () => {
    const etmp = fs.mkdtempSync(path.join(os.tmpdir(), "iapeer-memory-embedgate-"));
    const evault = path.join(etmp, "vault");
    fs.mkdirSync(path.join(evault, T.folders.knowledge), { recursive: true });
    const dbPath = path.join(etmp, "embed.db");
    for (let i = 0; i < 3; i++) {
      fs.writeFileSync(
        path.join(evault, T.folders.knowledge, `Нота ${i}.md`),
        `---\ntitle: Нота ${i}\nauthor: boris\ntype: ${T.types.knowledge}\nstatus: ${T.statusTokens.current}\n---\n\nТело ${i}.\n`,
        "utf-8",
      );
    }

    let releaseGate!: () => void;
    const gate = new Promise<void>((r) => (releaseGate = r));
    let fetchCalls = 0;
    const realFetch = globalThis.fetch;
    // A fetch stub that BLOCKS the first (and every) embed batch on the gate —
    // freezing the backfill mid-flight so the test can flush "during" it.
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      fetchCalls++;
      await gate;
      const batch = (JSON.parse(String(init?.body)) as { input: string[] }).input;
      return new Response(
        JSON.stringify({ data: batch.map(() => ({ embedding: [0.1, 0.2, 0.3] })) }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;

    let h: MemorydHandle | null = null;
    try {
      h = await startMemoryd({
        config: {
          ...makeConfig(),
          vaultPath: evault,
          index: { dbPath, fullScanOnStartup: true },
          embedding: {
            endpoint: "http://127.0.0.1:1/v1/embeddings",
            model: "test-embedder",
            dimensions: 3,
            batchSize: 2,
            apiKey: null,
          },
        },
        emit: () => {},
        mcpPort: null,
        debounceMs: 40,
        logger: { info: () => {}, warn: () => {}, error: () => {} },
      });
      // Serve-first: the port is conceptually up, the backfill has issued its
      // first batch and hangs on the gate.
      await sleep(200);
      expect(fetchCalls).toBe(1);

      // A flush mid-backfill: pre-fix it drained the WHOLE global queue
      // inline (second fetch + the flush chain blocked on the gate forever).
      fs.writeFileSync(
        path.join(evault, T.folders.knowledge, "Во время бэкфилла.md"),
        `---\ntitle: Во время бэкфилла\nauthor: boris\ntype: ${T.types.knowledge}\nstatus: ${T.statusTokens.current}\n---\n\nНовое тело.\n`,
        "utf-8",
      );
      await sleep(150); // fs.watch delivery
      await h.runDetectPass(); // must resolve with the gate still CLOSED
      expect(fetchCalls).toBe(1); // no inline drain — one owner of the queue

      releaseGate();
      // The backfill loop re-queries until empty — including the new note's
      // chunks that the structural flush upserted with NULL embeddings.
      let missing = -1;
      for (let i = 0; i < 50 && missing !== 0; i++) {
        await sleep(100);
        const sq = new Database(dbPath, { readonly: true });
        try {
          missing = (
            sq.prepare("SELECT COUNT(*) AS n FROM chunks WHERE embedding IS NULL").get() as {
              n: number;
            }
          ).n;
        } finally {
          sq.close();
        }
      }
      expect(missing).toBe(0);
    } finally {
      globalThis.fetch = realFetch;
      if (h) await h.close();
      fs.rmSync(etmp, { recursive: true, force: true });
    }
  });
});
