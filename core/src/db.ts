import fs from "node:fs";
import path from "node:path";
import { Database } from "bun:sqlite";
// sqlite-vec ships its own .d.ts; runtime API is just `load(db)`.
import * as sqliteVec from "sqlite-vec";
import type { CoreConfig } from "./config.js";
import { prepareSqliteRuntime } from "./sqlite-loader.js";
import { fromJson, toJson } from "./utils.js";

export type CoreDb = Database & {
  /**
   * True if `sqlite-vec` virtual-table is available on this connection. When
   * false, `vec_chunks` does not exist and `vectorSearch` must fall back to
   * the brute-force `SELECT embedding FROM chunks` path. Set once at
   * `openDatabase` time based on the process-wide sqlite runtime.
   */
  vecAvailable: boolean;
};

export type IndexedDocumentRow = {
  path: string;
  title: string;
  type: string | null;
  status: string | null;
  tags: string[];
  contentHash: string;
  frontmatter: Record<string, unknown>;
  created: string | null;
  updated: string | null;
  indexedAt: string;
};

export type SearchRow = {
  path: string;
  title: string;
  score: number;
  snippet: string;
};

export type OpenDatabaseOptions = {
  /**
   * Writer-only. When a `vec_chunks` table already exists at a dimension that
   * differs from `config.embedding.dimensions` (the embedder was swapped for
   * one with a different output width — e.g. Qwen3-Embedding-8B@4096 →
   * Qwen3-Embedding-4B@2560), DROP it so the CREATE below rebuilds it at the
   * new dimension. `CREATE VIRTUAL TABLE IF NOT EXISTS` alone keeps the stale
   * dimension forever, and every embedding INSERT then fails with
   * "Dimension mismatch ... Expected N ... received M", crash-looping the
   * writer's vault scan. Embeddings are invalidated on the same swap
   * (`checkEmbeddingModelChanged` nulls `chunks.embedding`), so dropping the
   * vec mirror loses nothing — the re-embed pass repopulates both tables.
   *
   * Defaults to false so read-only MCP frontends (`src/server.ts`) never
   * mutate the table: the single writer daemon owns this migration. A reader
   * that opened during the swap window just sees an empty/stale vec_chunks and
   * degrades to BM25 until the writer finishes re-embedding.
   */
  migrateVecDimension?: boolean;
};

export function openDatabase(config: CoreConfig, options: OpenDatabaseOptions = {}): CoreDb {
  fs.mkdirSync(path.dirname(config.index.dbPath), { recursive: true });

  // Process-wide: swap bun's stripped sqlite for one that supports extension
  // loading (homebrew on macOS, distro libsqlite3 on Linux). Idempotent —
  // safe to call from every openDatabase, the helper caches the decision.
  const runtime = prepareSqliteRuntime();

  // strict: true — bind named params (`@a`, `$a`, `:a`) by key without prefix.
  // Without strict mode bun silently inserts NULL for `VALUES (@a) RUN { a: "x" }`.
  const db = new Database(config.index.dbPath, { create: true, strict: true }) as CoreDb;
  db.vecAvailable = false;
  // The DB stores verbatim chunks of private vault content. On shared systems
  // (multi-user macOS, misconfigured VPS) the default mode (typically 0644)
  // would expose the whole vault to other local users. Lock it down.
  // WAL/SHM siblings get the same treatment as soon as they appear.
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      fs.chmodSync(config.index.dbPath + suffix, 0o600);
    } catch {
      // Best effort — file may not exist yet (sidecars appear on first write)
      // or the filesystem may not support chmod (FAT32, some network mounts).
    }
  }
  db.run("PRAGMA journal_mode = WAL");
  db.run("PRAGMA foreign_keys = ON");

  // Schema migration: prior versions carried `source` / `agent_id` columns
  // for a diary channel that was never wired in the MCP build. The fields
  // were removed in v0.7. Old databases keep working because SQLite ignores
  // extra columns on INSERT only if they're NULLable — but `source` was
  // NOT NULL, so a plain start against the legacy schema fails. Detect the
  // legacy column and drop the four content tables; `fullScanOnStartup`
  // (default true) will rebuild them. `meta` is preserved so embedding /
  // parser fingerprints survive and don't force a needless re-embed sweep
  // on every upgrade — they're invalidated separately by content changes.
  const docCols = db.prepare("PRAGMA table_info(documents)").all() as Array<{ name: string }>;
  const hasLegacyDiary = docCols.some((c) => c.name === "source" || c.name === "agent_id");
  if (hasLegacyDiary) {
    db.exec(`
      DROP TABLE IF EXISTS documents;
      DROP TABLE IF EXISTS chunk_fts;
      DROP TABLE IF EXISTS chunks;
      DROP TABLE IF EXISTS edges;
    `);
    // DROP TABLE chunks resets AUTOINCREMENT — rebuilt chunks reuse ids
    // 1..N, and a legacy vec_chunks would silently attribute OLD vectors to
    // NEW chunks through the rowid join. Deleting the embedding fingerprint
    // makes checkEmbeddingModelChanged treat the next start as a model
    // change and clear the vec mirror + embeddings — the full re-embed is
    // unavoidable on a legacy rebuild anyway.
    try {
      db.prepare("DELETE FROM meta WHERE key = 'embedding_fingerprint'").run();
    } catch {
      // meta may not exist yet on a truly ancient DB — created below
    }
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS documents (
      path TEXT PRIMARY KEY,
      title TEXT,
      type TEXT,
      status TEXT,
      tags TEXT,
      content_hash TEXT,
      frontmatter TEXT,
      created TEXT,
      updated TEXT,
      indexed_at TEXT
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS chunk_fts USING fts5(
      chunk_text,
      doc_path UNINDEXED,
      chunk_index UNINDEXED,
      tokenize='porter unicode61'
    );

    CREATE TABLE IF NOT EXISTS chunks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      doc_path TEXT NOT NULL,
      chunk_index INTEGER NOT NULL,
      chunk_text TEXT NOT NULL,
      embedding BLOB,
      UNIQUE(doc_path, chunk_index)
    );

    CREATE TABLE IF NOT EXISTS edges (
      source_path TEXT NOT NULL,
      target_path TEXT NOT NULL,
      context_snippet TEXT,
      PRIMARY KEY (source_path, target_path)
    );

    -- The composite PK indexes source_path only; every incoming-link query
    -- (backlink boost per search result, runGraph incoming, getBacklinks)
    -- filters on target_path and would full-scan edges without this
    -- (audit cosmetic). IF NOT EXISTS makes it a transparent migration.
    CREATE INDEX IF NOT EXISTS edges_target ON edges(target_path);

    -- Wikilinks that could not be resolved to a real note. Kept first-class
    -- instead of being silently dropped from edges: a missing/ambiguous link
    -- is a vault health signal (surfaced via memory_map orphan_wikilinks +
    -- the Index nightly health-check). reason ∈ 'missing' | 'ambiguous'.
    CREATE TABLE IF NOT EXISTS unresolved_links (
      source_path TEXT NOT NULL,
      raw_target TEXT NOT NULL,
      reason TEXT NOT NULL,
      context_snippet TEXT,
      PRIMARY KEY (source_path, raw_target)
    );

    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT
    );
  `);

  // ---- sqlite-vec: KNN-capable mirror of `chunks.embedding` ----
  //
  // `vec_chunks.rowid` == `chunks.id`, so JOINs are cheap and dedup-by-path
  // still uses the chunks table. We store cosine-distance vectors because
  // the legacy `vectorSearch` used JS-side cosineSimilarity; switching the
  // metric here would change ranking semantics. Dimension comes from the
  // embedding config — must match what TEI returns or the INSERT fails.
  //
  // If the runtime SQLite has no extension support (no homebrew sqlite, or
  // OMIT_LOAD_EXTENSION compiled in), we skip the virtual table entirely
  // and search.ts falls back to the brute-force path. That keeps the system
  // usable on machines that haven't installed a non-stripped libsqlite3.
  if (runtime.available && config.embedding) {
    try {
      sqliteVec.load(db);
      const dim = config.embedding.dimensions;
      // Writer-only: if an existing vec_chunks was created at a different
      // dimension (embedder swapped), DROP it first — IF NOT EXISTS would
      // otherwise keep the old width and every INSERT fails (see
      // OpenDatabaseOptions.migrateVecDimension). Must run with sqlite-vec
      // loaded: DROP TABLE on a vec0 virtual table needs the module resolvable
      // (a plain sqlite3 CLI without the extension errors "no such module:
      // vec0"), which is exactly why this lives in code, not a CLI one-liner.
      if (options.migrateVecDimension && dropVecChunksIfDimensionMismatch(db, dim)) {
        process.stderr.write(
          `[iapeer-memory] vec_chunks dimension changed → float[${dim}]; dropped stale table, ` +
            `re-embed will repopulate it\n`,
        );
      }
      db.exec(
        `CREATE VIRTUAL TABLE IF NOT EXISTS vec_chunks USING vec0(embedding float[${dim}] distance_metric=cosine)`,
      );
      db.vecAvailable = true;
    } catch (err) {
      // Best effort — degraded BM25-only path still works.
      // Logging goes through callers' own loggers (we don't take a logger here
      // to keep openDatabase signature stable for callers/tests).
      process.stderr.write(
        `[iapeer-memory] sqlite-vec load failed: ${String(err)} — vector search falls back to brute-force\n`,
      );
    }
  }

  return db;
}

/**
 * Dimension a `vec_chunks` table was created with, parsed from its stored
 * CREATE statement (`...float[N]...`) in sqlite_master. Returns null if the
 * table doesn't exist or the width can't be parsed. The reflected table
 * definition is the source of truth — the dimension is deliberately NOT tracked
 * in `meta` as well, so it can never drift from the actual column width.
 */
export function vecChunksDimension(db: Database): number | null {
  const row = db
    .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='vec_chunks'")
    .get() as { sql?: string } | null;
  if (!row?.sql) return null;
  const m = row.sql.match(/float\[(\d+)\]/);
  return m ? Number(m[1]) : null;
}

/**
 * DROP `vec_chunks` when its on-disk dimension differs from `dim`. vec0 tables
 * carry shadow tables (`vec_chunks_chunks`, `vec_chunks_rowids`, …); DROP TABLE
 * on the virtual table cascades to them via vec0's xDestroy, so this is a
 * complete reset. Caller MUST have `sqliteVec.load(db)`'d first (DROP needs the
 * vec0 module resolvable). Returns true iff a stale table was dropped; no-op
 * (returns false) when the dimension already matches or the table is absent.
 */
function dropVecChunksIfDimensionMismatch(db: CoreDb, dim: number): boolean {
  const existing = vecChunksDimension(db);
  if (existing !== null && existing !== dim) {
    db.exec("DROP TABLE IF EXISTS vec_chunks");
    return true;
  }
  return false;
}

export function getMeta(db: CoreDb, key: string): string | null {
  const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value?: string } | null;
  return row?.value ?? null;
}

export function setMeta(db: CoreDb, key: string, value: string): void {
  db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
}

/**
 * Check if embedding model changed since last indexation.
 * If changed — clear all embeddings and update stored model info.
 * Returns true if embeddings were invalidated.
 */
export function checkEmbeddingModelChanged(db: CoreDb, config: { model: string; dimensions: number } | null): boolean {
  if (!config) return false;

  // Deferred vec invalidation (audit important): a model swap that happened
  // while sqlite-vec was NOT loadable could not clear vec_chunks (a DELETE
  // on a vec0 table needs the loaded module) — the old model's vectors would
  // sit under LIVE rowids forever, answering new-model queries as permanent
  // semantic noise (the NOT EXISTS backfill never overwrites them, and the
  // fingerprint no longer changes). The durable meta flag survives restarts:
  // the first vec-capable writer start performs the clear. Also sweeps the
  // orphan rows that vec-less reindexes left behind in the same window.
  if (db.vecAvailable && getMeta(db, "vec_chunks_stale") === "1") {
    db.prepare("DELETE FROM vec_chunks").run();
    db.prepare("DELETE FROM meta WHERE key = 'vec_chunks_stale'").run();
  }

  const fingerprint = `${config.model}:${config.dimensions}`;
  const stored = getMeta(db, "embedding_fingerprint");

  if (stored === fingerprint) return false;

  // Model changed (or first run) — every stored vector is now invalid. Clear
  // BOTH the chunks.embedding column AND the vec_chunks mirror. The mirror
  // matters for memoryd's serve-first startup (the MCP port opens before the
  // background re-embed finishes): a SAME-dimension model swap does not trigger
  // migrateVecDimension's table drop, so without this the old model's vectors
  // would linger in vec_chunks and be searched against a new-model query
  // embedding — semantic noise. Clearing them degrades the backfill window
  // cleanly to BM25-only instead. (Dimension CHANGES are already handled by
  // migrateVecDimension dropping the table; on first run vec_chunks is empty,
  // so this is a no-op.)
  db.prepare("UPDATE chunks SET embedding = NULL").run();
  if (db.vecAvailable) {
    db.prepare("DELETE FROM vec_chunks").run();
  } else if (stored !== null) {
    // Can't clear the mirror now — arm the durable flag for the next
    // vec-capable start (first run has no mirror to clear).
    setMeta(db, "vec_chunks_stale", "1");
  }
  setMeta(db, "embedding_fingerprint", fingerprint);

  return stored !== null; // true = invalidated old embeddings, false = first run
}

/**
 * Check if the parser fingerprint changed since last indexation.
 *
 * Bumped manually when the chunking algorithm changes in a way that affects
 * what's stored on disk — e.g. adding a title prefix to chunk[0]. Changing
 * this version forces the next startup to re-parse every note: we set
 * content_hash = NULL on all documents, so indexFile's "skip if hash matches"
 * short-circuit no longer fires and the parser runs on each file.
 *
 * Returns true if invalidation occurred (existing index was dropped).
 */
export function checkParserChanged(db: CoreDb, version: string): boolean {
  const stored = getMeta(db, "parser_fingerprint");
  if (stored === version) return false;

  db.prepare("UPDATE documents SET content_hash = NULL").run();
  setMeta(db, "parser_fingerprint", version);

  return stored !== null;
}

export function getStoredHash(db: CoreDb, docPath: string): string | null {
  const row = db.prepare("SELECT content_hash FROM documents WHERE path = ?").get(docPath) as { content_hash?: string } | null;
  return row?.content_hash ?? null;
}

/**
 * Drop all vec_chunks rows owned by a document. Used when a document is
 * about to be re-chunked (upsert) or deleted entirely. No-op if vec is not
 * loaded on this connection.
 *
 * vec_chunks is rowid-only — it has no doc_path column — so we join through
 * `chunks` to find which rowids to delete. This is the only place that
 * pre-existing chunks.id values are used as a deletion key, so we must
 * resolve them BEFORE the chunks rows themselves are deleted.
 */
function deleteVecChunksByDoc(db: CoreDb, docPath: string): void {
  if (!db.vecAvailable) return;
  const rows = db.prepare("SELECT id FROM chunks WHERE doc_path = ?").all(docPath) as Array<{ id: number }>;
  if (rows.length === 0) return;
  const stmt = db.prepare("DELETE FROM vec_chunks WHERE rowid = ?");
  for (const r of rows) stmt.run(r.id);
}

export function upsertDocument(db: CoreDb, row: IndexedDocumentRow, chunks: { chunkIndex: number; text: string }[], links: { target: string; contextSnippet: string }[]): void {
  const tx = db.transaction(() => {
    // vec_chunks rowids referenced by this doc's old chunks must die BEFORE
    // we delete the chunks rows themselves — once `chunks.id` is gone we
    // can't recover the rowid mapping.
    deleteVecChunksByDoc(db, row.path);
    db.prepare(
      `INSERT INTO documents (
        path, title, type, status, tags, content_hash, frontmatter, created, updated, indexed_at
      ) VALUES (
        @path, @title, @type, @status, @tags, @contentHash, @frontmatter, @created, @updated, @indexedAt
      )
      ON CONFLICT(path) DO UPDATE SET
        title=excluded.title,
        type=excluded.type,
        status=excluded.status,
        tags=excluded.tags,
        content_hash=excluded.content_hash,
        frontmatter=excluded.frontmatter,
        created=excluded.created,
        updated=excluded.updated,
        indexed_at=excluded.indexed_at`
    ).run({
      path: row.path,
      title: row.title,
      type: row.type,
      status: row.status,
      tags: toJson(row.tags),
      contentHash: row.contentHash,
      frontmatter: toJson(row.frontmatter),
      created: row.created,
      updated: row.updated,
      indexedAt: row.indexedAt,
    });

    db.prepare("DELETE FROM chunk_fts WHERE doc_path = ?").run(row.path);
    db.prepare("DELETE FROM chunks WHERE doc_path = ?").run(row.path);
    db.prepare("DELETE FROM edges WHERE source_path = ?").run(row.path);
    db.prepare("DELETE FROM unresolved_links WHERE source_path = ?").run(row.path);

    const insertChunkFts = db.prepare("INSERT INTO chunk_fts (chunk_text, doc_path, chunk_index) VALUES (?, ?, ?)");
    const insertChunk = db.prepare("INSERT INTO chunks (doc_path, chunk_index, chunk_text) VALUES (?, ?, ?)");
    for (const chunk of chunks) {
      insertChunkFts.run(chunk.text, row.path, chunk.chunkIndex);
      insertChunk.run(row.path, chunk.chunkIndex, chunk.text);
    }

    const insertEdge = db.prepare("INSERT OR IGNORE INTO edges (source_path, target_path, context_snippet) VALUES (?, ?, ?)");
    for (const link of links) {
      insertEdge.run(row.path, link.target, link.contextSnippet);
    }
  });

  tx();
}

/** Total indexed documents — the corpus size the mass-delete fuse (indexer)
 *  measures would-be deletions against. */
export function countDocuments(db: CoreDb): number {
  const row = db.prepare("SELECT COUNT(*) AS n FROM documents").get() as { n: number };
  return row.n;
}

/** How many indexed documents are NOT in `existingPaths` — what
 *  deleteMissingDocuments WOULD remove. Split out so the caller can refuse a
 *  mass deletion (iCloud partial-sync fuse, audit critical #2) before any
 *  destructive work. */
export function countMissingDocuments(db: CoreDb, existingPaths: Set<string>): number {
  const rows = db.prepare("SELECT path FROM documents").all() as Array<{ path: string }>;
  return rows.filter((row) => !existingPaths.has(row.path)).length;
}

/** Paths + stored titles of every indexed document — the incremental
 *  indexAll path rebuilds titleToPath from here instead of re-reading the
 *  whole vault (audit important: O(vault) rescans on the hot path). */
export function listDocumentTitles(db: CoreDb): Array<{ path: string; title: string | null }> {
  return db.prepare("SELECT path, title FROM documents").all() as Array<{
    path: string;
    title: string | null;
  }>;
}

/** basename → current path(s), for MOVE detection. Archiving a note is a move
 *  (`07_Архив/<base>`); its incoming edges (the note's backlinks) must follow,
 *  not be dropped — otherwise an archived note loses its backlinks AND the
 *  active→archive link rule never sees the edge until the source is re-parsed
 *  (the archival-moment gap). resolveWikilinks skips already-resolved `.md`
 *  edges, so a dropped incoming edge is NOT self-healed. */
function buildByBase(paths: Iterable<string>): Map<string, string[]> {
  const byBase = new Map<string, string[]>();
  for (const p of paths) {
    const base = path.basename(p);
    const list = byBase.get(base);
    if (list) list.push(p);
    else byBase.set(base, [p]);
  }
  return byBase;
}

export function deleteMissingDocuments(db: CoreDb, existingPaths: Set<string>): number {
  const rows = db.prepare("SELECT path FROM documents").all() as Array<{ path: string }>;
  const stale = rows.map((row) => row.path).filter((docPath) => !existingPaths.has(docPath));
  if (stale.length === 0) return 0;
  removeDocuments(db, stale, buildByBase(existingPaths));
  return stale.length;
}

/**
 * Targeted deletion for the INCREMENTAL index path: remove exactly these
 * docPaths (those that are actually indexed). Move detection runs against the
 * SURVIVING documents — a rename delivers «new path indexed + old path gone»
 * in one changed set, so the new location is already in `documents` by the
 * time the old one is deleted here.
 */
export function deleteDocumentsByPaths(db: CoreDb, docPaths: string[]): number {
  const stale = docPaths.filter((p) => documentExists(db, p));
  if (stale.length === 0) return 0;
  const staleSet = new Set(stale);
  const surviving = (db.prepare("SELECT path FROM documents").all() as Array<{ path: string }>)
    .map((r) => r.path)
    .filter((p) => !staleSet.has(p));
  removeDocuments(db, stale, buildByBase(surviving));
  return stale.length;
}

function removeDocuments(db: CoreDb, stale: string[], byBase: Map<string, string[]>): void {
  const tx = db.transaction(() => {
    const deleteDoc = db.prepare("DELETE FROM documents WHERE path = ?");
    const deleteFts = db.prepare("DELETE FROM chunk_fts WHERE doc_path = ?");
    const deleteOutgoing = db.prepare("DELETE FROM edges WHERE source_path = ?");
    const deleteIncoming = db.prepare("DELETE FROM edges WHERE target_path = ?");
    const repointIncoming = db.prepare(
      "UPDATE OR IGNORE edges SET target_path = ? WHERE target_path = ?",
    );
    // Genuine deletion: the `[[Target]]` text still sits in each SOURCE note,
    // but the source is unchanged → its hash matches → it is never re-parsed
    // → a silently dropped edge would resurface NOWHERE (resolveWikilinks
    // walks only edges + unresolved_links). Park the incoming links in
    // unresolved_links instead (reason 'missing', snippet preserved): the
    // health surface sees the broken link, and the self-heal pass restores
    // the edge if the note ever comes back (audit important — the
    // «unresolvable links are NOT silently dropped» invariant).
    const parkIncoming = db.prepare(
      `INSERT OR IGNORE INTO unresolved_links (source_path, raw_target, reason, context_snippet)
       SELECT source_path, ?, 'missing', context_snippet FROM edges WHERE target_path = ?`,
    );
    const deleteUnresolved = db.prepare("DELETE FROM unresolved_links WHERE source_path = ?");
    const deleteChunks = db.prepare("DELETE FROM chunks WHERE doc_path = ?");
    for (const docPath of stale) {
      // vec_chunks first — drops the rowids before the chunks rows that own them go away.
      deleteVecChunksByDoc(db, docPath);
      deleteDoc.run(docPath);
      deleteFts.run(docPath);
      deleteOutgoing.run(docPath);
      // MOVE-aware incoming edges: a removed path whose basename now lives at
      // exactly ONE new location is a move → re-point its incoming edges there.
      // UPDATE OR IGNORE skips a collision (the source already links the new
      // path); the deleteIncoming below then drops those skipped stale
      // leftovers — they duplicate existing edges, silent deletion is right.
      // No unique new home (genuine deletion / ambiguous basename) → park the
      // incoming links as unresolved before dropping the edges.
      const moved = byBase.get(path.basename(docPath));
      if (moved && moved.length === 1 && moved[0] !== docPath) {
        repointIncoming.run(moved[0], docPath);
      } else {
        parkIncoming.run(path.basename(docPath, ".md"), docPath);
      }
      deleteIncoming.run(docPath);
      deleteUnresolved.run(docPath);
      deleteChunks.run(docPath);
    }
  });

  tx();
}

export function searchDocuments(db: CoreDb, params: { query: string; limit: number }): SearchRow[] {
  const stmt = db.prepare(`
    SELECT
      d.path as path,
      d.title as title,
      rank as score,
      snippet(chunk_fts, 0, '[', ']', ' … ', 18) as snippet
    FROM chunk_fts
    JOIN documents d ON d.path = chunk_fts.doc_path
    WHERE chunk_fts MATCH ?
    ORDER BY rank ASC
    LIMIT ?
  `);

  // FTS5 rank is per-row, not per-document. We deduplicate by path, keeping the best score.
  const rows = stmt.all(params.query, params.limit * 3) as SearchRow[];
  const seen = new Map<string, SearchRow>();
  for (const row of rows) {
    const existing = seen.get(row.path);
    if (!existing || row.score < existing.score) {
      seen.set(row.path, row);
    }
  }
  return [...seen.values()]
    .sort((a, b) => a.score - b.score)
    .slice(0, params.limit);
}

export function getDocumentMeta(db: CoreDb, docPath: string): {
  path: string;
  title: string;
  type: string | null;
  status: string | null;
  tags: string[];
  frontmatter: Record<string, unknown>;
  created: string | null;
  updated: string | null;
} | null {
  const row = db.prepare(`SELECT path, title, type, status, tags, frontmatter, created, updated FROM documents WHERE path = ?`).get(docPath) as Record<string, unknown> | null;
  if (!row) return null;
  return {
    path: String(row.path),
    title: String(row.title ?? ""),
    type: (row.type as string | null) ?? null,
    status: (row.status as string | null) ?? null,
    tags: fromJson<string[]>(typeof row.tags === "string" ? row.tags : null, []),
    frontmatter: fromJson<Record<string, unknown>>(typeof row.frontmatter === "string" ? row.frontmatter : null, {}),
    created: (row.created as string | null) ?? null,
    updated: (row.updated as string | null) ?? null,
  };
}

export function getRelatedPaths(db: CoreDb, docPath: string, limit = 5): string[] {
  const rows = db.prepare(`
    SELECT target_path as path FROM edges WHERE source_path = ?
    UNION
    SELECT source_path as path FROM edges WHERE target_path = ?
    LIMIT ?
  `).all(docPath, docPath, limit) as Array<{ path: string }>;
  return rows.map((row) => row.path);
}

export function getChunkTexts(db: CoreDb, docPath: string): string[] {
  const rows = db.prepare("SELECT chunk_text FROM chunks WHERE doc_path = ? ORDER BY chunk_index").all(docPath) as Array<{ chunk_text: string }>;
  return rows.map((r) => r.chunk_text);
}

export function getChunksWithoutEmbeddings(db: CoreDb, limit: number): Array<{ id: number; docPath: string; chunkText: string }> {
  return db.prepare(
    "SELECT id, doc_path as docPath, chunk_text as chunkText FROM chunks WHERE embedding IS NULL LIMIT ?"
  ).all(limit) as Array<{ id: number; docPath: string; chunkText: string }>;
}

/** How many chunks still lack an embedding — the pending size of a (re-)embed
 *  pass, used by memoryd to log background-backfill progress. */
export function countChunksWithoutEmbeddings(db: CoreDb): number {
  const row = db.prepare("SELECT COUNT(*) AS n FROM chunks WHERE embedding IS NULL").get() as { n: number };
  return row.n;
}

export function storeChunkEmbeddings(db: CoreDb, updates: Array<{ id: number; embedding: Buffer }>): void {
  const stmt = db.prepare("UPDATE chunks SET embedding = ? WHERE id = ?");
  // vec_chunks mirrors the same buffer keyed by rowid == chunks.id.
  // chunks.id is AUTOINCREMENT — an id is NEVER reused, so a zero-change
  // UPDATE means the chunk was deleted by a concurrent reindex (the note was
  // edited while its batch sat in `await embedTexts` — routine during the
  // background backfill window). The stale vector MUST be dropped, not
  // written: vec_chunks rows under dead rowids are invisible to every
  // cleanup path (they all resolve rowids THROUGH chunks) and permanently
  // eat KNN top-k slots. The edited note's new chunks re-embed via the
  // NULL-embedding queue on the next pass.
  const vecStmt = db.vecAvailable
    ? db.prepare("INSERT OR REPLACE INTO vec_chunks(rowid, embedding) VALUES (?, ?)")
    : null;
  const tx = db.transaction(() => {
    for (const u of updates) {
      if (stmt.run(u.embedding, u.id).changes === 0) continue;
      if (vecStmt) vecStmt.run(u.id, u.embedding);
    }
  });
  tx();
}

/**
 * Drop vec_chunks rows whose owning chunks row no longer exists. One-shot GC
 * for orphans accumulated before storeChunkEmbeddings learned to check the
 * UPDATE result (audit 2026-07-02, critical #1) — run once at writer startup;
 * steady-state it's a cheap no-op. Returns the number of rows removed.
 */
export function gcOrphanVecChunks(db: CoreDb): number {
  if (!db.vecAvailable) return 0;
  // Count first: `changes` on a vec0 virtual-table DELETE reports shadow-table
  // row counts, not logical rows (measured: 2 per deleted vector).
  const { n } = db
    .prepare("SELECT COUNT(*) AS n FROM vec_chunks WHERE rowid NOT IN (SELECT id FROM chunks)")
    .get() as { n: number };
  if (n === 0) return 0;
  db.prepare("DELETE FROM vec_chunks WHERE rowid NOT IN (SELECT id FROM chunks)").run();
  return n;
}

/**
 * Backfill `vec_chunks` from `chunks.embedding` BLOBs. Called once at writer
 * startup when vec is available: existing DBs predate vec_chunks and have all
 * their embeddings only in the legacy column. After this pass vec_chunks
 * mirrors chunks and stays in sync via storeChunkEmbeddings / upsertDocument
 * / deleteMissingDocuments.
 *
 * Idempotent: if vec_chunks already covers every chunk, the streaming pass
 * just produces zero work via INSERT OR REPLACE. Streams in batches to keep
 * heap bounded — full vault has ~1500 chunks × 16KB embedding = ~24 MB.
 */
export async function backfillVecChunks(db: CoreDb, batchSize = 200, shouldStop?: () => boolean): Promise<number> {
  if (!db.vecAvailable) return 0;
  // Only chunks NOT already in vec_chunks. NOT EXISTS lets sqlite skip the
  // join when vec_chunks is fully populated.
  const selectMissing = db.prepare(
    `SELECT c.id, c.embedding
     FROM chunks c
     WHERE c.embedding IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM vec_chunks v WHERE v.rowid = c.id)
     LIMIT ?`,
  );
  const insert = db.prepare(
    "INSERT OR REPLACE INTO vec_chunks(rowid, embedding) VALUES (?, ?)",
  );
  let total = 0;
  while (true) {
    if (shouldStop?.()) break;
    const rows = selectMissing.all(batchSize) as Array<{ id: number; embedding: Buffer }>;
    if (rows.length === 0) break;
    const tx = db.transaction(() => {
      for (const r of rows) insert.run(r.id, r.embedding);
    });
    tx();
    total += rows.length;
    if (rows.length < batchSize) break;
    // Yield between batches (audit cosmetic): a fully synchronous loop
    // blocked the event loop — including the just-opened MCP port — for the
    // entire mirroring pass, and shouldStop physically could not fire.
    await new Promise((r) => setTimeout(r, 0));
  }
  return total;
}

export function getBacklinks(db: CoreDb, docPath: string): Array<{ path: string; contextSnippet: string | null }> {
  return db.prepare(`SELECT source_path as path, context_snippet as contextSnippet FROM edges WHERE target_path = ? ORDER BY source_path ASC`).all(docPath) as Array<{ path: string; contextSnippet: string | null }>;
}

export function documentExists(db: CoreDb, docPath: string): boolean {
  return db.prepare("SELECT 1 FROM documents WHERE path = ? LIMIT 1").get(docPath) != null;
}

/**
 * Unresolved wikilinks (missing target / ambiguous basename across folders).
 * First-class health signal — surfaced through memory_map's opt-in
 * `orphan_wikilinks` part and the Index nightly health-check.
 */
export function getUnresolvedLinks(
  db: CoreDb,
): Array<{ source: string; target: string; reason: string }> {
  return db
    .prepare(
      "SELECT source_path as source, raw_target as target, reason FROM unresolved_links ORDER BY source_path ASC, raw_target ASC",
    )
    .all() as Array<{ source: string; target: string; reason: string }>;
}

/**
 * Directional archive-link rule (invariant): a wikilink FROM a
 * LIVE CANON note TO an archived note is FORBIDDEN — a canon note must not pull
 * a reader into dead knowledge; the reverse
 * (archive → active, legitimate historical context) is allowed. This is a
 * derived vault-health signal, recomputed every pass over the CURRENT edge
 * set, so it covers all three cases uniformly: a fresh active→archive link, the
 * archival moment (the source unchanged — its edge was re-pointed by the
 * move-aware deleteMissingDocuments), and the existing backlog. GLOB, not LIKE:
 * the archive folder name carries an underscore, a LIKE wildcard.
 *
 * Scope is LIVE CANON sources only — agent-memory (`06_…`) sources are excluded.
 * Operative notes are personal journals OUTSIDE the canonical graph (memory_map
 * and memory_related already drop them), so an operative→archive link is a
 * legitimate cross-reference to the past (a handoff citing a prior archived
 * handoff), not a canon-graph violation. Counting them would make the health
 * signal permanently non-zero for links nobody should "repair".
 */
export function getActiveToArchiveLinks(
  db: CoreDb,
  archiveFolder: string,
  agentMemoryFolder: string,
): Array<{ source: string; target: string; contextSnippet: string | null }> {
  const archivePattern = `${archiveFolder}/*`;
  const operativePattern = `${agentMemoryFolder}/*`;
  return db
    .prepare(
      `SELECT source_path as source, target_path as target, context_snippet as contextSnippet
       FROM edges
       WHERE target_path GLOB ? AND source_path NOT GLOB ? AND source_path NOT GLOB ?
       ORDER BY source_path ASC, target_path ASC`,
    )
    .all(archivePattern, archivePattern, operativePattern) as Array<{
    source: string;
    target: string;
    contextSnippet: string | null;
  }>;
}
