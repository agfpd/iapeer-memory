/**
 * Stage-3 acceptance smoke: BM25 search end-to-end on a small on-disk vault
 * in BOTH locales — indexing (indexAll over real files) → memory_search
 * equivalent (runVaultSearch) → results with the status boost applied.
 * No embedding/reranker endpoints: graceful BM25-only, as in the reference.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { openDatabase, type CoreDb } from "../src/db.js";
import type { CoreConfig } from "../src/config.js";
import { indexAll } from "../src/indexer.js";
import { runVaultSearch } from "../src/search.js";
import {
  getTaxonomy,
  defaultExcludeFolders,
  DEFAULT_RANKING,
  type LocaleId,
  type TaxonomyPreset,
} from "../src/taxonomy.js";

const noopLogger = { info: () => {}, warn: () => {}, error: () => {} };

function makeConfig(locale: LocaleId, vaultPath: string, dbPath: string): CoreConfig {
  const taxonomy = getTaxonomy(locale);
  return {
    vaultPath,
    locale,
    taxonomy,
    ranking: { ...DEFAULT_RANKING },
    curatorSet: ["index", "scriber", "dreamweaver"],
    callerAgent: "boris",
    excludeFolders: defaultExcludeFolders(taxonomy),
    search: { chunkSize: 500, chunkOverlap: 80, maxResults: 6, rrfK: 60 },
    index: { dbPath, fullScanOnStartup: true },
    batch: { curatorMs: 6 * 3600_000 },
    mcp: { port: 0 },
    embedding: null, // no endpoint — BM25-only is the valid working state
    reranker: null,
  };
}

for (const locale of ["ru", "en"] as LocaleId[]) {
  const T: TaxonomyPreset = getTaxonomy(locale);
  const ACTIVE = T.statusTokens.current; // актуально / current
  const STALE = T.statuses.stale[0]; // устарело / outdated

  describe(`e2e BM25 smoke [${locale}]: index → search → status boost`, () => {
    let tmpDir: string;
    let vault: string;
    let db: CoreDb;
    let config: CoreConfig;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `iapeer-memory-e2e-${locale}-`));
      vault = path.join(tmpDir, "vault");
      fs.mkdirSync(vault);
      config = makeConfig(locale, vault, path.join(tmpDir, "index.db"));
      db = openDatabase(config);
    });

    afterEach(() => {
      db.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    function writeNote(rel: string, content: string): void {
      const full = path.join(vault, rel);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, content, "utf-8");
    }

    it("ranks the active note above the stale twin; inbox/system are not indexed", async () => {
      const K = T.folders.knowledge;
      // Identical bodies → identical BM25 relevance; only the status boost
      // (×1.2 active vs ×0.5 stale) can separate them.
      writeNote(
        `${K}/Гибридный поиск — актуально.md`,
        `---\ntitle: Гибридный поиск — актуально\ntype: ${T.types.knowledge}\nstatus: ${ACTIVE}\n---\n\nГибридный поиск сочетает BM25 и векторное сходство.\n`,
      );
      writeNote(
        `${K}/Гибридный поиск — старое.md`,
        `---\ntitle: Гибридный поиск — старое\ntype: ${T.types.knowledge}\nstatus: ${STALE}\n---\n\nГибридный поиск сочетает BM25 и векторное сходство.\n`,
      );
      // The system folder must NOT surface in search.
      writeNote(
        `${T.folders.system}/${T.systemFiles.tagsDictionary}`,
        "Гибридный поиск в словаре тегов.\n",
      );

      await indexAll({ db, config, logger: noopLogger });

      const { results, pipeline } = await runVaultSearch({ db, config, query: "гибридный поиск BM25" });

      // BM25-only graceful state: search worked without any endpoints.
      expect(pipeline.bm25).toBe("ok");
      expect(results.length).toBeGreaterThanOrEqual(2);

      const paths = results.map((r) => r.path);
      expect(paths.some((p) => p.includes(T.folders.system))).toBe(false);

      // Status boost decides the ORDER between the identical twins. The
      // displayed score is rounded to 3 decimals AFTER sorting — at BM25-only
      // FTS5 magnitudes both display as 0 (verified identical in the frozen
      // reference), so position is the contract, not the rounded score.
      // Paths are stored NFD-normalised (iCloud/macOS) — compare normalised.
      const nfd = (x: string) => x.normalize("NFD");
      const activeIdx = paths.findIndex((p) => nfd(p).endsWith(nfd("Гибридный поиск — актуально.md")));
      const staleIdx = paths.findIndex((p) => nfd(p).endsWith(nfd("Гибридный поиск — старое.md")));
      expect(activeIdx).toBeGreaterThanOrEqual(0);
      expect(staleIdx).toBeGreaterThanOrEqual(0);
      expect(activeIdx).toBeLessThan(staleIdx);

      // Display normalisation (sanctioned deviation): BM25-only scores are
      // VISIBLE — top result is 1.0, every result > 0, and the boost ratio
      // shows up in the displayed values (order unchanged by construction).
      expect(results[0]!.score).toBe(1);
      for (const r of results) expect(r.score).toBeGreaterThan(0);
      expect(results[activeIdx]!.score).toBeGreaterThan(results[staleIdx]!.score);
    });

    it("foreign agent-memory ranks below own at equal semantics (penalty from config)", async () => {
      const M = T.folders.agentMemory;
      const body = "Личная справка про гибридный поиск и его настройку.";
      writeNote(
        `${M}/boris/Справка про поиск.md`,
        `---\ntitle: Справка про поиск\ntype: ${T.types.agentMemory}\nstatus: ${ACTIVE}\nauthor: boris\n---\n\n${body}\n`,
      );
      writeNote(
        `${M}/linus/Справка про поиск (linus).md`,
        `---\ntitle: Справка про поиск (linus)\ntype: ${T.types.agentMemory}\nstatus: ${ACTIVE}\nauthor: linus\n---\n\n${body}\n`,
      );

      await indexAll({ db, config, logger: noopLogger });

      // The penalty applies BEFORE the final sort; at BM25-only magnitudes
      // the rounded display score ties at 0 (parity with the frozen
      // reference) — order is the contract. To prove the penalty (and not an
      // accidental tie-break) drives the order, run the SAME query under two
      // different caller identities and assert the order FLIPS.
      const order = async (caller: string) => {
        const { results } = await runVaultSearch({
          db,
          config: { ...config, callerAgent: caller },
          query: "справка гибридный поиск",
        });
        const paths = results.map((r) => r.path.normalize("NFD"));
        return {
          boris: paths.findIndex((p) => p.includes(`${M}/boris/`.normalize("NFD"))),
          linus: paths.findIndex((p) => p.includes(`${M}/linus/`.normalize("NFD"))),
        };
      };

      const asBoris = await order("boris");
      expect(asBoris.boris).toBeGreaterThanOrEqual(0);
      expect(asBoris.linus).toBeGreaterThanOrEqual(0);
      expect(asBoris.boris).toBeLessThan(asBoris.linus);

      const asLinus = await order("linus");
      expect(asLinus.linus).toBeLessThan(asLinus.boris);

      // Normalised display: both visible, foreign strictly below own.
      const { results } = await runVaultSearch({ db, config, query: "справка гибридный поиск" });
      expect(results[0]!.score).toBe(1);
      for (const r of results) expect(r.score).toBeGreaterThan(0);
    });
  });
}
