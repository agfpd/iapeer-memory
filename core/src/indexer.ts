import fs from "node:fs/promises";
import path from "node:path";
import type { CoreConfig } from "./config.js";
import type { CoreDb } from "./db.js";
import { deleteMissingDocuments, countMissingDocuments, countDocuments, getStoredHash, getDocumentMeta, documentExists, upsertDocument, getChunksWithoutEmbeddings, storeChunkEmbeddings } from "./db.js";
import { embedTexts, DEFAULT_INDEX_TIMEOUT_MS } from "./embedding.js";
import { parseMarkdown, wikilinkBasename } from "./parser.js";
import { hashContent, normalizeRelativePath, nowIso } from "./utils.js";

/** Mass-delete fuse thresholds (audit critical #2): a legitimate cleanup
 *  rarely removes >20% of the vault in one pass; an iCloud partial sync
 *  routinely "removes" much more. Both must trip for the fuse to blow. */
const MASS_DELETE_MAX_FRACTION = 0.2;
const MASS_DELETE_MIN_COUNT = 10;

/** Legacy iCloud placeholder (macOS <12.3): an evicted `Note.md` leaves
 *  `.Note.md.icloud` on disk. Modern macOS evicts in place (UF_DATALESS —
 *  the file keeps its name and readdir sees it), but old placeholders must
 *  still count as "the note exists": eviction is not deletion. */
const ICLOUD_PLACEHOLDER_RE = /^\.(.+\.md)\.icloud$/;

export async function indexAll(params: {
  db: CoreDb;
  config: CoreConfig;
  logger: { info: (msg: string) => void; warn: (msg: string) => void; error: (msg: string) => void };
  /**
   * Run the embedding pass inline (default `true`). The structural work
   * (parse / chunk / upsert / wikilink-resolve) — everything BM25/FTS5 serving
   * needs — always runs synchronously; only the network-bound embed pass is
   * gated. memoryd passes `false` at startup so the MCP port + heartbeat come
   * up at once and the (potentially whole-vault) re-embed runs in the
   * background. Incremental callers and the CLI keep the default so a changed
   * note's vector is ready promptly.
   */
  embed?: boolean;
}): Promise<Map<string, string[]>> {
  const { db, config, logger } = params;
  const seenPaths = new Set<string>();
  // title/basename → doc paths. A list, not a single path: two notes can share
  // a basename (e.g. `Фаза — MVP` in two projects). The resolver treats >1 as
  // ambiguous instead of silently picking the last writer.
  const titleToPath = new Map<string, string[]>();

  const scanOk = await scanRoot({
    db,
    basePath: config.vaultPath,
    excludeFolders: new Set(config.excludeFolders),
    config,
    seenPaths,
    logger,
    titleToPath,
  });

  // «Not seen by the scan» is NOT «deleted» when the scan itself is suspect.
  // The vault lives in iCloud Drive: partial materialisation, a re-sync
  // window, or the root vanishing mid-pass (TOCTOU) can legally produce a
  // near-empty seenPaths while every note is alive and well — deleting on
  // that evidence silently wipes the team's index, embeddings included
  // (audit critical #2). Three belts, outermost first:
  //  1. aborted scan (root missing/not a dir) → no deletion at all;
  //  2. EMPTY scan over a non-empty corpus → no deletion (any corpus size);
  //  3. mass-delete fuse — more than MASS_DELETE_MIN_COUNT files AND more
  //     than MASS_DELETE_MAX_FRACTION of the corpus gone at once → refuse,
  //     log loudly, require the explicit operator override
  //     IAPEER_MEMORY_ALLOW_MASS_DELETE=1 (a conscious bulk cleanup is rare
  //     and can afford one env var; a silent wipe cannot be undone cheaply).
  if (!scanOk) {
    logger.warn("iapeer-memory: scan aborted — skipping stale-document deletion");
  } else {
    const corpus = countDocuments(db);
    const staleCount = countMissingDocuments(db, seenPaths);
    const override = process.env.IAPEER_MEMORY_ALLOW_MASS_DELETE === "1";
    if (staleCount > 0 && seenPaths.size === 0 && corpus > 0 && !override) {
      logger.error(
        `iapeer-memory: scan saw ZERO notes while the index holds ${corpus} — ` +
          "refusing to delete (iCloud partial sync?). Set IAPEER_MEMORY_ALLOW_MASS_DELETE=1 to force.",
      );
    } else if (
      staleCount > MASS_DELETE_MIN_COUNT &&
      staleCount > corpus * MASS_DELETE_MAX_FRACTION &&
      !override
    ) {
      logger.error(
        `iapeer-memory: ${staleCount}/${corpus} indexed notes vanished from the scan — ` +
          "refusing the mass deletion (iCloud partial sync?). " +
          "Set IAPEER_MEMORY_ALLOW_MASS_DELETE=1 to force a conscious bulk cleanup.",
      );
    } else {
      const deleted = deleteMissingDocuments(db, seenPaths);
      if (deleted > 0) {
        logger.info(`iapeer-memory: removed ${deleted} stale documents from index`);
      }
    }
  }

  // Resolve wikilinks: map note titles to actual file paths
  resolveWikilinks(db, titleToPath);

  // Embed chunks that don't have embeddings yet (unless deferred to a
  // background pass — see the `embed` option above).
  if (config.embedding && params.embed !== false) {
    await embedMissingChunks({ db, config, logger });
  }

  return titleToPath;
}

/**
 * Register a title/basename → docPath association. List-valued so collisions
 * (same basename in different folders) are detectable, not last-writer-wins.
 * An internal helper of indexFile (its only caller); titleToPath is rebuilt
 * from scratch on each full scan — there is no incremental title-map consumer.
 */
export function addTitlePath(
  map: Map<string, string[]>,
  key: string,
  docPath: string,
): void {
  const arr = map.get(key);
  if (!arr) {
    map.set(key, [docPath]);
  } else if (!arr.includes(docPath)) {
    arr.push(docPath);
  }
}

/**
 * Resolve wikilink targets against the title→paths map.
 *
 * Path-aware (Audit #3): an author-written path is honoured exactly first; a
 * bare basename resolves only when exactly one note has it — never the last
 * indexed one. Unresolvable links are NOT silently dropped (Audit #5): they
 * move to `unresolved_links` with a reason (`missing` | `ambiguous`) so the
 * memory_map / nightly health-check can see vault rot. The map carries ALL
 * indexed files including unchanged ones (Audit #1), so a link to a note that
 * simply wasn't re-parsed this run still resolves instead of being dropped.
 *
 * Also self-heals: a previously-unresolved link whose target later appears is
 * promoted back into `edges` on the next pass.
 */
export function resolveWikilinks(
  db: CoreDb,
  titleToPath: Map<string, string[]>,
): void {
  type Res = { path: string } | { reason: "missing" | "ambiguous" };

  const tryResolve = (raw: string): Res => {
    const nfc = raw.normalize("NFC");
    if (nfc.includes("/")) {
      // Author wrote an explicit path — match it exactly. docPaths are stored
      // NFD (normalizeRelativePath); links from content are usually NFC.
      const withMd = /\.md$/i.test(nfc) ? nfc : `${nfc}.md`;
      const cand = withMd.normalize("NFD");
      if (documentExists(db, cand)) return { path: cand };
      // Explicit path didn't hit — fall through to a strict basename try.
    }
    const base = wikilinkBasename(nfc).normalize("NFC");
    const paths = titleToPath.get(base);
    if (!paths || paths.length === 0) return { reason: "missing" };
    if (paths.length > 1) return { reason: "ambiguous" };
    return { path: paths[0] };
  };

  const edges = db
    .prepare(
      "SELECT rowid, source_path, target_path, context_snippet FROM edges",
    )
    .all() as Array<{
      rowid: number;
      source_path: string;
      target_path: string;
      context_snippet: string | null;
    }>;
  // OR IGNORE: two different links in one note can resolve to the same note
  // ([[Foo]] and [[01_Знания/Foo]]); the second update would hit the
  // (source,target) PK. On ignore (changes===0) it's a duplicate — drop it.
  const updateEdge = db.prepare(
    "UPDATE OR IGNORE edges SET target_path = ? WHERE rowid = ?",
  );
  const removeEdge = db.prepare("DELETE FROM edges WHERE rowid = ?");
  const insertEdge = db.prepare(
    "INSERT OR IGNORE INTO edges (source_path, target_path, context_snippet) VALUES (?, ?, ?)",
  );
  const upsertUnresolved = db.prepare(
    "INSERT INTO unresolved_links (source_path, raw_target, reason, context_snippet) VALUES (?, ?, ?, ?) ON CONFLICT(source_path, raw_target) DO UPDATE SET reason = excluded.reason, context_snippet = excluded.context_snippet",
  );
  const updateUnresolvedReason = db.prepare(
    "UPDATE unresolved_links SET reason = ? WHERE rowid = ?",
  );
  const removeUnresolved = db.prepare(
    "DELETE FROM unresolved_links WHERE rowid = ?",
  );

  const tx = db.transaction(() => {
    for (const edge of edges) {
      if (edge.target_path.endsWith(".md")) continue; // already resolved
      const r = tryResolve(edge.target_path);
      if ("path" in r) {
        const res = updateEdge.run(r.path, edge.rowid);
        if (res.changes === 0) removeEdge.run(edge.rowid); // dup of existing edge
      } else {
        removeEdge.run(edge.rowid);
        upsertUnresolved.run(
          edge.source_path,
          edge.target_path,
          r.reason,
          edge.context_snippet,
        );
      }
    }

    // Self-heal: retry every unresolved link — its target may exist now.
    const unresolved = db
      .prepare(
        "SELECT rowid, source_path, raw_target, context_snippet, reason FROM unresolved_links",
      )
      .all() as Array<{
        rowid: number;
        source_path: string;
        raw_target: string;
        context_snippet: string | null;
        reason: string;
      }>;
    for (const u of unresolved) {
      const r = tryResolve(u.raw_target);
      if ("path" in r) {
        insertEdge.run(u.source_path, r.path, u.context_snippet);
        removeUnresolved.run(u.rowid);
      } else if (r.reason !== u.reason) {
        updateUnresolvedReason.run(r.reason, u.rowid);
      }
    }
  });
  tx();
}

/**
 * Embed every chunk whose `embedding` column is still NULL, batch by batch.
 *
 * Restart-safe and re-entrant by construction: each loop re-queries
 * `getChunksWithoutEmbeddings`, so an interrupted pass (crash, shutdown) simply
 * resumes from the remaining NULL-embedding chunks on the next call — already
 * embedded chunks are never re-embedded. Returns the count embedded this call.
 *
 * `shouldStop` is a cooperative cancellation hook checked before each batch, so
 * memoryd's background backfill can bail promptly on shutdown without leaving a
 * half-written batch (each batch's store is atomic).
 */
export async function embedMissingChunks(params: {
  db: CoreDb;
  config: CoreConfig;
  logger: { info: (msg: string) => void; warn: (msg: string) => void; error: (msg: string) => void };
  shouldStop?: () => boolean;
}): Promise<number> {
  const { db, config, logger, shouldStop } = params;
  if (!config.embedding) return 0;

  const batchSize = config.embedding.batchSize;
  let total = 0;

  while (true) {
    if (shouldStop?.()) break;
    const missing = getChunksWithoutEmbeddings(db, batchSize);
    if (missing.length === 0) break;

    const texts = missing.map((c) => c.chunkText);
    // Indexing timeout, NOT the 3s query default: a full batch on a busy
    // local endpoint takes seconds — at 3s per batch the vault would never
    // finish embedding, silently (audit critical #3).
    const result = await embedTexts(
      texts,
      config.embedding!,
      undefined,
      config.embedding!.indexTimeoutMs ?? DEFAULT_INDEX_TIMEOUT_MS,
    );

    if (!result.vectors) {
      logger.warn(
        `iapeer-memory: embedding endpoint unavailable (${result.status}), skipping embedding`,
      );
      break;
    }

    const updates = missing.map((chunk, i) => ({
      id: chunk.id,
      embedding: Buffer.from(result.vectors![i].buffer),
    }));

    storeChunkEmbeddings(db, updates);
    total += updates.length;
  }

  if (total > 0) {
    logger.info(`iapeer-memory: embedded ${total} chunks`);
  }
  return total;
}

type ScanRootParams = {
  db: CoreDb;
  basePath: string;
  excludeFolders: Set<string>;
  config: CoreConfig;
  seenPaths: Set<string>;
  logger: { info: (msg: string) => void; warn: (msg: string) => void; error: (msg: string) => void };
  titleToPath: Map<string, string[]>;
};

/** Returns `false` when the scan could not run at all (root missing / not a
 *  directory) — the caller must then treat seenPaths as NO EVIDENCE and skip
 *  stale-document deletion entirely. */
async function scanRoot(params: ScanRootParams): Promise<boolean> {
  const { basePath, logger } = params;
  try {
    const stat = await fs.stat(basePath);
    if (!stat.isDirectory()) {
      logger.warn(`iapeer-memory: skip non-directory path ${basePath}`);
      return false;
    }
  } catch {
    logger.warn(`iapeer-memory: path does not exist, skipping ${basePath}`);
    return false;
  }

  await walkDirectory(params, basePath);
  return true;
}

async function walkDirectory(params: ScanRootParams, currentPath: string): Promise<void> {
  const { basePath, seenPaths } = params;
  const entries = await fs.readdir(currentPath, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(currentPath, entry.name);
    if (entry.isDirectory()) {
      if (params.excludeFolders.has(entry.name)) {
        continue;
      }
      await walkDirectory(params, fullPath);
      continue;
    }

    if (!entry.isFile()) continue;

    // Legacy iCloud placeholder = the note EXISTS, its content is just not
    // local right now. Count it as seen (eviction ≠ deletion — the index
    // keeps serving the last-parsed content); never try to read it.
    const placeholder = ICLOUD_PLACEHOLDER_RE.exec(entry.name);
    if (placeholder) {
      seenPaths.add(
        normalizeRelativePath(path.relative(basePath, path.join(currentPath, placeholder[1]))),
      );
      continue;
    }

    if (!entry.name.endsWith(".md")) {
      continue;
    }

    // The readdir entry itself is the existence evidence — register it BEFORE
    // any read/parse. A read failure (iCloud dataless file while offline,
    // permissions, a transient FS error) must degrade to «skip this pass,
    // keep the indexed copy», NOT to «file deleted»: seenPaths feeds
    // deleteMissingDocuments (audit critical #2, the read-failure window).
    seenPaths.add(normalizeRelativePath(path.relative(basePath, fullPath)));

    // One malformed frontmatter shouldn't kill the whole scan. Pre-split,
    // server.ts caught at the top of indexAll and the writer continued
    // with an empty titleToPath (degraded). Now that the writer is its own
    // daemon, a single bad note crashing the scan would force a launchd
    // restart loop — the bad note is still bad, so the daemon never
    // stabilises. Log, skip, move on.
    try {
      await indexFile(params, fullPath);
    } catch (err) {
      params.logger.warn(
        `iapeer-memory: skip ${fullPath} — ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

async function indexFile(params: ScanRootParams, fullPath: string): Promise<void> {
  const { db, basePath, config, logger, titleToPath } = params;
  const content = await fs.readFile(fullPath, "utf8");
  const docPath = normalizeRelativePath(path.relative(basePath, fullPath));

  const contentHash = hashContent(content);
  // NFC-normalize keys: paths from iCloud are NFD, wikilinks in content are NFC
  const titleKey = path.basename(docPath, ".md").normalize("NFC");

  if (getStoredHash(db, docPath) === contentHash) {
    // Unchanged this run — but its title MUST still be registered. Otherwise a
    // changed file linking [[ThisNote]] won't resolve and resolveWikilinks()
    // silently deletes the edge: graph rot on every clean restart. The title
    // comes from the stored row (no re-parse needed for an unchanged file).
    addTitlePath(titleToPath, titleKey, docPath);
    const storedTitle = getDocumentMeta(db, docPath)?.title?.normalize("NFC");
    if (storedTitle && storedTitle !== titleKey) {
      addTitlePath(titleToPath, storedTitle, docPath);
    }
    return;
  }

  const parsed = parseMarkdown(content, docPath, config.search.chunkSize, config.search.chunkOverlap, config.taxonomy);
  upsertDocument(
    db,
    {
      path: docPath,
      title: parsed.title,
      type: parsed.type,
      status: parsed.status,
      tags: parsed.tags,
      contentHash,
      frontmatter: parsed.frontmatter,
      created: parsed.created,
      updated: parsed.updated,
      indexedAt: nowIso(),
    },
    parsed.chunks,
    parsed.wikilinks,
  );

  // Register title → path mapping for wikilink resolution
  addTitlePath(titleToPath, titleKey, docPath);
  const titleNfc = parsed.title?.normalize("NFC");
  if (titleNfc && titleNfc !== titleKey) {
    addTitlePath(titleToPath, titleNfc, docPath);
  }

  logger.info(`iapeer-memory: indexed ${docPath}`);
}
