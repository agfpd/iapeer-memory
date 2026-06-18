/**
 * Stage-4 acceptance smoke: the three-tool MCP surface (ADR-008) answers on
 * a small on-disk vault in BOTH locales; vault_read is NOT on the surface;
 * BM25-only display scores are non-zero with the ordering unchanged.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { openDatabase, type CoreDb } from "../src/db.js";
import type { CoreConfig } from "../src/config.js";
import { indexAll } from "../src/indexer.js";
import { MCP_TOOL_SURFACE, runSearch, runGraph, runMap, runRead } from "../src/mcp-tools.js";
import {
  getTaxonomy,
  defaultExcludeFolders,
  DEFAULT_RANKING,
  type LocaleId,
} from "../src/taxonomy.js";

const noopLogger = { info: () => {}, warn: () => {}, error: () => {} };

describe("MCP tool surface (ADR-008)", () => {
  it("is exactly the three read-only tools — no vault_read", () => {
    expect([...MCP_TOOL_SURFACE]).toEqual(["memory_search", "memory_related", "memory_map"]);
    expect([...MCP_TOOL_SURFACE]).not.toContain("vault_read");
  });

  it("runRead remains available as a LIBRARY function (memoryd/CLI), outside the surface", () => {
    expect(typeof runRead).toBe("function");
  });
});

for (const locale of ["ru", "en"] as LocaleId[]) {
  const T = getTaxonomy(locale);

  describe(`three tools answer on a test vault [${locale}]`, () => {
    let tmpDir: string;
    let vault: string;
    let db: CoreDb;
    let config: CoreConfig;

    beforeEach(async () => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `iapeer-memory-surface-${locale}-`));
      vault = path.join(tmpDir, "vault");
      fs.mkdirSync(vault);
      config = {
        vaultPath: vault,
        locale,
        taxonomy: T,
        ranking: { ...DEFAULT_RANKING },
        curatorSet: ["index", "scriber", "dreamweaver"],
        callerAgent: "boris",
        excludeFolders: defaultExcludeFolders(T),
        search: { chunkSize: 500, chunkOverlap: 80, maxResults: 6, rrfK: 60 },
        index: { dbPath: path.join(tmpDir, "index.db"), fullScanOnStartup: true },
    batch: { curatorMs: 6 * 3600_000 },
    mcp: { port: 0 },
        embedding: null,
        reranker: null,
      };
      db = openDatabase(config);

      const K = T.folders.knowledge;
      const M = T.folders.agentMemory;
      const w = (rel: string, c: string) => {
        const full = path.join(vault, rel);
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, c, "utf-8");
      };
      w(
        `${K}/Альфа.md`,
        `---\ntitle: Альфа\ntype: ${T.types.knowledge}\nstatus: ${T.statusTokens.current}\n---\n\nАльфа описывает поиск. Ссылка на [[Бета]].\n`,
      );
      w(
        `${K}/Бета.md`,
        `---\ntitle: Бета\ntype: ${T.types.knowledge}\nstatus: ${T.statusTokens.current}\n---\n\nБета тоже про поиск.\n`,
      );
      // Agent memory backlink to a canon note — must NOT show in the canon map
      // and must NOT appear as an incoming edge of Альфа (one-way filter).
      w(
        `${M}/boris/Личное про Альфу.md`,
        `---\ntitle: Личное про Альфу\ntype: ${T.types.agentMemory}\nstatus: ${T.statusTokens.current}\nauthor: boris\n---\n\nЗаметка ссылается на [[Альфа]].\n`,
      );
      await indexAll({ db, config, logger: noopLogger });
    });

    afterEach(() => {
      db.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it("memory_search answers; BM25-only scores visible, order intact", async () => {
      const out = (await runSearch(db, config, { query: "поиск" })) as {
        results: Array<{ path: string; score: number }>;
      };
      expect(out.results.length).toBeGreaterThanOrEqual(2);
      expect(out.results[0]!.score).toBe(1);
      for (const r of out.results) expect(r.score).toBeGreaterThan(0);
      // ordering: non-increasing scores
      for (let i = 1; i < out.results.length; i++) {
        expect(out.results[i]!.score).toBeLessThanOrEqual(out.results[i - 1]!.score);
      }
    });

    it("memory_related answers; one-way filter hides agent-memory backlinks of canon", () => {
      const nfd = (x: string) => x.normalize("NFD");
      const out = runGraph(db, config, {
        path: `${T.folders.knowledge}/Альфа.md`.normalize("NFD"),
        depth: 1,
      }) as { found?: boolean; nodes: Array<{ path: string }> };
      expect(out.found ?? true).not.toBe(false);
      const paths = out.nodes.map((n) => nfd(n.path));
      // outgoing canon neighbour visible
      expect(paths.some((p) => p.endsWith(nfd("Бета.md")))).toBe(true);
      // agent-memory backlink filtered (one-way)
      expect(paths.some((p) => p.includes(nfd(`${T.folders.agentMemory}/`)))).toBe(false);
    });

    it("memory_map answers; agent memory excluded from canon topology", () => {
      const out = runMap(db, config) as {
        stats: { documents?: number; nodes?: number };
        clusters: Array<{ size: number }>;
      };
      expect(out.clusters.length).toBeGreaterThanOrEqual(1);
      const totalNodes = out.clusters.reduce((acc, c) => acc + c.size, 0);
      // только 2 канонические заметки; оперативка исключена целиком
      expect(totalNodes).toBe(2);
    });
  });
}
