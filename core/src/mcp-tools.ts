/**
 * MCP tool handlers — pure functions called from server.ts after Zod
 * validation. Each returns the JSON payload that the server wraps into
 * `content` + `structuredContent`.
 */

import fs from "node:fs/promises";
import path from "node:path";
import type { CoreConfig } from "./config.js";
import type { CoreDb } from "./db.js";
import { getBacklinks, getDocumentMeta } from "./db.js";
import { parseMarkdown } from "./parser.js";
import { runVaultSearch } from "./search.js";
import { buildVaultMap } from "./graph.js";
import { normalizePath } from "./utils.js";
import { agentMemoryFolderMarker } from "./taxonomy.js";

// Защита от UF_DATALESS iCloud-файлов: чтение такого файла триггерит
// синхронный fetch с iCloud, без таймаута Node event loop замораживается
// на минуты. 30 секунд — большой запас, на нормальной сети iCloud
// укладывается за 5-15 секунд. При срабатывании пишем warn в stderr и
// возвращаем not-found, чтобы caller мог упасть на memory_search fallback.
const READ_TIMEOUT_MS = 30000;

function isAbortError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { name?: string; code?: string };
  return e.name === "AbortError" || e.code === "ABORT_ERR";
}

// ---- memory_search ----

export async function runSearch(
  db: CoreDb,
  config: CoreConfig,
  args: { query: string; forCuration?: boolean },
): Promise<unknown> {
  const out = await runVaultSearch({
    db,
    config,
    query: args.query,
    forCuration: args.forCuration ?? false,
  });
  return { query: args.query, results: out.results, pipeline: out.pipeline };
}

/**
 * Public MCP tool surface (ADR-008): exactly three read-only tools.
 * `vault_read` is deliberately NOT part of the surface — in-session reading
 * is the harness's native Read (after memory_search the path is known), and
 * backlinks are covered by memory_related(depth=1, incoming). `runRead` below
 * is retained as a hardened LIBRARY function (path-traversal / null-byte /
 * exclude-folder tests) with no in-repo consumer today — a deliberate seam for
 * programmatic readers outside harness sessions.
 */
export const MCP_TOOL_SURFACE = ["memory_search", "memory_related", "memory_map"] as const;

// ---- vault_read — library read function (NOT on the MCP surface, ADR-008) ----

/**
 * Validate and resolve a user-supplied vault path before any disk access.
 *
 * vault_read is reachable from any agent wired to the memory MCP surface,
 * including ones whose context can be poisoned by untrusted note content (prompt
 * injection). Without containment, an attacker-controlled `path` like
 * `../../.ssh/id_rsa`, `../../.mergemind/env`, or `/etc/passwd` would
 * exfiltrate arbitrary files the MCP process can read.
 *
 * Defence-in-depth here: enforce relative-only + .md suffix + no traversal
 * segments, refuse paths inside `excludeFolders` (drafts/system), and finally
 * resolve to an absolute path and assert it stays under the canonical vault
 * root. Both sides are NFD-normalised because macOS stores filenames in NFD
 * while user input is usually NFC, and a byte-wise startsWith would otherwise
 * either fail-open (accept paths that look outside but aren't) or fail-closed
 * (reject legitimate Cyrillic paths).
 */
/**
 * Validation outcome:
 *   - `{docPath, fullPath}` — path is well-formed and inside vault root.
 *   - `{notFound: true, reason}` — path is well-formed but lives in an
 *     excludeFolders area (drafts/system). The caller surfaces this as a
 *     payload-level not-found so excluded folders can't be probed for
 *     existence — same wording as the actual not-in-index case.
 *   - **throws** on malformed input (null byte, non-.md, absolute path,
 *     empty/./.. segments, vault-root escape). These are programmer/caller
 *     errors, not lookup misses, so they bubble up as MCP tool errors
 *     (`isError: true`) instead of leaking validation strings into the
 *     payload of an otherwise successful-looking response.
 */
type ValidatedPath =
  | { docPath: string; fullPath: string }
  | { notFound: true; reason: string };

function validateVaultPath(
  rawPath: string,
  config: CoreConfig,
): ValidatedPath {
  if (!rawPath || rawPath.includes("\0")) {
    throw new Error("Path is required");
  }
  const docPath = normalizePath(rawPath);

  if (!docPath.toLowerCase().endsWith(".md")) {
    throw new Error("Only .md files can be read via vault_read");
  }
  if (path.isAbsolute(docPath)) {
    throw new Error("Path must be relative to the vault root");
  }
  const segments = docPath.split("/");
  if (segments.some((s) => s === "" || s === "." || s === "..")) {
    throw new Error("Path must not contain empty, '.' or '..' segments");
  }

  // Respect excludeFolders even for direct disk reads. The system folder is
  // intentionally hidden from search — leaking it
  // through vault_read would defeat the privacy contract excludeFolders
  // is supposed to provide. Same "Document not found" wording as the
  // not-in-index branch so we don't reveal whether the path exists.
  // CASE-INSENSITIVE segment match (audit important): APFS/iCloud — the
  // product's target platform — is case-insensitive, so «99_система/…»
  // passed the exact-string guard, missed the index (system folders are
  // never indexed) and fell into the direct-disk fallback, which happily
  // read the real file. toLowerCase AFTER NFD on both sides.
  const firstSegment = (segments[0] ?? "").toLowerCase();
  const excluded = config.excludeFolders.map((f) => f.normalize("NFD").toLowerCase());
  if (excluded.includes(firstSegment)) {
    return { notFound: true, reason: `Document not found: ${docPath}` };
  }

  const vaultRoot = path.resolve(config.vaultPath).normalize("NFD");
  const fullPath = path.resolve(vaultRoot, docPath).normalize("NFD");
  if (fullPath !== vaultRoot && !fullPath.startsWith(vaultRoot + path.sep)) {
    throw new Error("Path escapes vault root");
  }

  return { docPath, fullPath };
}

export async function runRead(
  db: CoreDb,
  config: CoreConfig,
  args: { path: string },
): Promise<unknown> {
  const guard = validateVaultPath(args.path, config);
  // excludeFolders branch — surface as payload-level not-found, not isError.
  // Agents legitimately probe paths; isError would imply caller error.
  if ("notFound" in guard) {
    return { found: false, error: guard.reason };
  }
  const { docPath, fullPath } = guard;
  const meta = getDocumentMeta(db, docPath);

  // Fallback path: the requested document is not in the index (typically
  // because it lives in an excluded folder like `99_System/`, or the watcher
  // hasn't picked it up yet). Read it directly from disk and
  // parse it on the fly — without backlinks, since those depend on the index.
  if (!meta) {
    let text: string;
    try {
      text = await fs.readFile(fullPath, {
        encoding: "utf8",
        signal: AbortSignal.timeout(READ_TIMEOUT_MS),
      });
    } catch (err) {
      if (isAbortError(err)) {
        console.warn(`[mcp] vault_read timeout (${READ_TIMEOUT_MS}ms) on ${docPath} — likely iCloud UF_DATALESS`);
        return { found: false, error: `Document read timeout (${READ_TIMEOUT_MS}ms): ${docPath}` };
      }
      return { found: false, error: `Document not found: ${docPath}` };
    }
    const parsed = parseMarkdown(
      text,
      docPath,
      config.search.chunkSize,
      config.search.chunkOverlap,
      config.taxonomy,
    );
    return {
      path: docPath,
      text,
      meta: {
        title:
          typeof parsed.frontmatter.title === "string"
            ? parsed.frontmatter.title
            : docPath,
        type: parsed.type,
        status: parsed.status,
        tags: parsed.tags,
        created: parsed.created,
        updated: parsed.updated,
        notIndexed: true,
      },
      wikilinks: parsed.wikilinks,
      backlinks: [],
    };
  }

  let text: string;
  try {
    text = await fs.readFile(fullPath, {
      encoding: "utf8",
      signal: AbortSignal.timeout(READ_TIMEOUT_MS),
    });
  } catch (err) {
    if (isAbortError(err)) {
      console.warn(`[mcp] vault_read timeout (${READ_TIMEOUT_MS}ms) on ${docPath} — likely iCloud UF_DATALESS`);
      return { found: false, error: `Document read timeout (${READ_TIMEOUT_MS}ms): ${docPath}` };
    }
    // Race with deletion — file was indexed but is now gone. Surface as
    // not-found rather than tool error so the caller can fall back to search.
    return { found: false, error: `Document not found: ${docPath} (${String(err)})` };
  }

  const parsed = parseMarkdown(
    text,
    docPath,
    config.search.chunkSize,
    config.search.chunkOverlap,
    config.taxonomy,
  );

  // We deliberately don't echo `parsed.frontmatter` here — `text` already
  // contains the YAML frontmatter verbatim, so an agent that needs custom
  // fields (e.g. заменено_на) can read them from `text` without us paying for
  // a duplicated structured copy in every response. Standard fields stay in
  // `meta` for ergonomic access.
  return {
    path: docPath,
    text,
    meta: {
      title: meta.title,
      type: meta.type,
      status: meta.status,
      tags: meta.tags,
      created: meta.created,
      updated: meta.updated,
    },
    wikilinks: parsed.wikilinks,
    backlinks: getBacklinks(db, docPath),
  };
}

// ---- memory_related ----

// Oneway-фильтр графа: backlinks из `06_Оперативка_агентов/` **не**
// показываются при запросе графа канонической заметки — граф референса не
// должен засоряться упоминаниями оперативки разных агентов. От оперативной
// заметки исходящие связи (на каноники) показываются как есть — автор
// должен видеть на что ссылается его оперативка. Парсер сохраняет все
// wikilinks в `edges` (для целостности графа), фильтрация только здесь.
// Подробности — раздел «Oneway-фильтр в графе».
function isAgentMemory(path: string, config: CoreConfig): boolean {
  return path.includes(agentMemoryFolderMarker(config.taxonomy));
}

export function runGraph(
  db: CoreDb,
  config: CoreConfig,
  args: { path: string; depth?: number },
): unknown {
  const depth = Math.min(Math.max(args.depth ?? 1, 1), 3);
  const docPath = normalizePath(args.path);
  const centerMeta = getDocumentMeta(db, docPath);

  if (!centerMeta) {
    return {
      found: false,
      error: `Document not found: ${docPath}`,
      hint: "If you don't have the exact path, find the note first with memory_search, then pass its `path` here.",
    };
  }

  type Node = {
    path: string;
    title: string;
    type: string | null;
    status: string | null;
    depth: number;
    direction: string;
  };

  const nodes: Node[] = [];
  const edges: Array<{ from: string; to: string }> = [];
  const visited = new Set<string>([docPath]);
  let frontier: string[] = [docPath];

  const outgoingStmt = db.prepare(
    "SELECT target_path as path FROM edges WHERE source_path = ?",
  );
  const incomingStmt = db.prepare(
    "SELECT source_path as path FROM edges WHERE target_path = ?",
  );

  for (let d = 1; d <= depth; d++) {
    const nextFrontier: string[] = [];

    for (const current of frontier) {
      const outgoing = outgoingStmt.all(current) as Array<{ path: string }>;
      for (const row of outgoing) {
        edges.push({ from: current, to: row.path });
        if (!visited.has(row.path)) {
          visited.add(row.path);
          nextFrontier.push(row.path);
          const meta = getDocumentMeta(db, row.path);
          nodes.push({
            path: row.path,
            title: meta?.title ?? row.path,
            type: meta?.type ?? null,
            status: meta?.status ?? null,
            depth: d,
            direction: "outgoing",
          });
        }
      }

      // Backlinks из оперативки не показываются для vault-заметок — граф
      // vault'а не засоряется упоминаниями памяти разных агентов. Для самой
      // оперативной заметки фильтр не применяется (там backlinks обычно от
      // Индекса или того же автора — релевантны).
      const currentIsAgentMemory = isAgentMemory(current, config);
      const incoming = incomingStmt.all(current) as Array<{ path: string }>;
      for (const row of incoming) {
        if (!currentIsAgentMemory && isAgentMemory(row.path, config)) {
          continue;
        }
        edges.push({ from: row.path, to: current });
        if (!visited.has(row.path)) {
          visited.add(row.path);
          nextFrontier.push(row.path);
          const meta = getDocumentMeta(db, row.path);
          nodes.push({
            path: row.path,
            title: meta?.title ?? row.path,
            type: meta?.type ?? null,
            status: meta?.status ?? null,
            depth: d,
            direction: "incoming",
          });
        }
      }
    }

    frontier = nextFrontier;
    if (frontier.length === 0) break;
  }

  const uniqueEdges = [
    ...new Map(edges.map((e) => [`${e.from}→${e.to}`, e])).values(),
  ];

  return {
    center: {
      path: docPath,
      title: centerMeta.title,
      type: centerMeta.type,
    },
    nodes,
    edges: uniqueEdges,
    stats: {
      totalNodes: nodes.length,
      totalEdges: uniqueEdges.length,
      depth,
    },
  };
}

// ---- memory_map ----

// Summary-mode caps. Full topology of a 300+ note vault crosses 25KB JSON
// before it reaches the agent — most of that is per-cluster node lists and
// the hubs tail. Summary mode keeps the shape but returns only the parts an
// agent uses to *navigate* the vault: cluster name+size+hub, top hubs, full
// bridges/orphans (already small).
const SUMMARY_TOP_NODES_PER_CLUSTER = 5;
const SUMMARY_TOP_HUBS = 20;

export type VaultMapPart =
  | "clusters"
  | "hubs"
  | "bridges"
  | "orphans"
  | "orphan_wikilinks"
  | "active_to_archive_links";
// orphan_wikilinks and active_to_archive_links are opt-in — NOT in the default
// set. Their counts always ride in stats (data.stats.*) so a default call still
// signals "broken links / forbidden archive-links exist, ask for the part".
const ALL_PARTS: VaultMapPart[] = ["clusters", "hubs", "bridges", "orphans"];

export function runMap(
  db: CoreDb,
  config: CoreConfig,
  args: { detail?: "summary" | "full"; parts?: VaultMapPart[] } = {},
): unknown {
  const detail = args.detail === "full" ? "full" : "summary";
  const requested = new Set<VaultMapPart>(
    args.parts && args.parts.length > 0 ? args.parts : ALL_PARTS,
  );

  const data = buildVaultMap(db, config);

  // Pre-compute degree map once so we can rank nodes inside each cluster
  // without an N×getDocumentMeta sweep.
  const degreeByPath = new Map<string, number>();
  if (detail === "summary" && requested.has("clusters")) {
    for (const h of data.hubs) {
      degreeByPath.set(h.path, h.total);
    }
  }

  // stats are always cheap and orient the agent — kept regardless of `parts`.
  const out: Record<string, unknown> = {
    generated: data.generated,
    stats: data.stats,
    detail,
    parts: [...requested].sort(),
  };

  if (requested.has("clusters")) {
    out.clusters = data.clusters.map((c) => {
      const base = {
        name: c.name,
        size: c.nodes.length,
        hub: c.hub ? { title: c.hub.title, degree: c.hub.degree } : null,
      };

      if (detail === "full") {
        return {
          ...base,
          nodes: c.nodes.map(
            (n) => n.split("/").pop()?.replace(/\.md$/, "") ?? n,
          ),
        };
      }

      // Summary: only the top N nodes by degree (hubs of this cluster). The
      // hub itself is already in `base.hub` — drop duplicates.
      const ranked = [...c.nodes]
        .sort((a, b) => (degreeByPath.get(b) ?? 0) - (degreeByPath.get(a) ?? 0))
        .filter((p) => p !== c.hub?.path)
        .slice(0, SUMMARY_TOP_NODES_PER_CLUSTER)
        .map((n) => n.split("/").pop()?.replace(/\.md$/, "") ?? n);

      return { ...base, top_nodes: ranked };
    });
  }

  if (requested.has("hubs")) {
    const hubs =
      detail === "full" ? data.hubs : data.hubs.slice(0, SUMMARY_TOP_HUBS);
    out.hubs = hubs.map((h) => ({
      title: h.title,
      in: h.inDegree,
      out: h.outDegree,
      total: h.total,
    }));
    if (detail === "summary" && data.hubs.length > SUMMARY_TOP_HUBS) {
      out.hubs_truncated = data.hubs.length - SUMMARY_TOP_HUBS;
    }
  }

  if (requested.has("bridges")) {
    out.bridges = data.bridges.map((b) => ({
      title: b.title,
      connects: b.connects,
    }));
  }

  if (requested.has("orphans")) {
    out.orphans = data.orphans.map(
      (o) => o.split("/").pop()?.replace(/\.md$/, "") ?? o,
    );
  }

  if (requested.has("orphan_wikilinks")) {
    out.orphan_wikilinks = data.orphanWikilinks;
  }

  if (requested.has("active_to_archive_links")) {
    out.active_to_archive_links = data.activeToArchiveLinks;
  }

  return out;
}
