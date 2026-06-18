import fs from "node:fs/promises";
import path from "node:path";
import type { CoreConfig } from "./config.js";
import type { CoreDb } from "./db.js";
import { deleteMissingDocuments, getStoredHash, getDocumentMeta, documentExists, upsertDocument, getChunksWithoutEmbeddings, storeChunkEmbeddings } from "./db.js";
import { embedTexts } from "./embedding.js";
import { parseMarkdown, wikilinkBasename } from "./parser.js";
import { hashContent, normalizeRelativePath, nowIso } from "./utils.js";

export async function indexAll(params: {
  db: CoreDb;
  config: CoreConfig;
  logger: { info: (msg: string) => void; warn: (msg: string) => void; error: (msg: string) => void };
}): Promise<Map<string, string[]>> {
  const { db, config, logger } = params;
  const seenPaths = new Set<string>();
  // title/basename → doc paths. A list, not a single path: two notes can share
  // a basename (e.g. `Фаза — MVP` in two projects). The resolver treats >1 as
  // ambiguous instead of silently picking the last writer.
  const titleToPath = new Map<string, string[]>();

  await scanRoot({
    db,
    basePath: config.vaultPath,
    excludeFolders: new Set(config.excludeFolders),
    config,
    seenPaths,
    logger,
    titleToPath,
  });

  const deleted = deleteMissingDocuments(db, seenPaths);
  if (deleted > 0) {
    logger.info(`iapeer-memory: removed ${deleted} stale documents from index`);
  }

  // Resolve wikilinks: map note titles to actual file paths
  resolveWikilinks(db, titleToPath);

  // Embed chunks that don't have embeddings yet
  if (config.embedding) {
    await embedMissingChunks({ db, config, logger });
  }

  return titleToPath;
}

/**
 * Register a title/basename → docPath association. List-valued so collisions
 * (same basename in different folders) are detectable, not last-writer-wins.
 * Exported because the watcher maintains the same map incrementally.
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

async function embedMissingChunks(params: {
  db: CoreDb;
  config: CoreConfig;
  logger: { info: (msg: string) => void; warn: (msg: string) => void; error: (msg: string) => void };
}): Promise<void> {
  const { db, config, logger } = params;
  if (!config.embedding) return;

  const batchSize = config.embedding.batchSize;
  let total = 0;

  while (true) {
    const missing = getChunksWithoutEmbeddings(db, batchSize);
    if (missing.length === 0) break;

    const texts = missing.map((c) => c.chunkText);
    const result = await embedTexts(texts, config.embedding!);

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

async function scanRoot(params: ScanRootParams): Promise<void> {
  const { basePath, logger } = params;
  try {
    const stat = await fs.stat(basePath);
    if (!stat.isDirectory()) {
      logger.warn(`iapeer-memory: skip non-directory path ${basePath}`);
      return;
    }
  } catch {
    logger.warn(`iapeer-memory: path does not exist, skipping ${basePath}`);
    return;
  }

  await walkDirectory(params, basePath);
}

async function walkDirectory(params: ScanRootParams, currentPath: string): Promise<void> {
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

    if (!entry.isFile() || !entry.name.endsWith(".md")) {
      continue;
    }

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
  const { db, basePath, seenPaths, config, logger, titleToPath } = params;
  const content = await fs.readFile(fullPath, "utf8");
  const docPath = normalizeRelativePath(path.relative(basePath, fullPath));
  seenPaths.add(docPath);

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
