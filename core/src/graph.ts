import type { CoreDb } from "./db.js";
import { getUnresolvedLinks, getActiveToArchiveLinks } from "./db.js";
import type { CoreConfig } from "./config.js";
import { agentMemoryFolderMarker } from "./taxonomy.js";

export type Cluster = {
  name: string;
  nodes: string[];
  hub: { path: string; title: string; degree: number } | null;
};

export type Hub = {
  path: string;
  title: string;
  inDegree: number;
  outDegree: number;
  total: number;
};

export type Bridge = {
  path: string;
  title: string;
  connects: [string, string]; // cluster names
};

export type VaultMapData = {
  generated: string;
  stats: {
    documents: number;
    edges: number;
    clusters: number;
    hubs: number;
    bridges: number;
    orphans: number;
    orphan_wikilinks: number;
    active_to_archive_links: number;
  };
  clusters: Cluster[];
  hubs: Hub[];
  bridges: Bridge[];
  orphans: string[];
  orphanWikilinks: Array<{ source: string; target: string; reason: string }>;
  activeToArchiveLinks: Array<{
    source: string;
    target: string;
    contextSnippet: string | null;
  }>;
};

// ── Graph loading ──

type AdjMap = Map<string, Set<string>>;

function loadGraph(db: CoreDb, agentMemoryMarker: string, archiveFolder: string): { adj: AdjMap; directed: Map<string, Set<string>>; allPaths: Set<string> } {
  const adj: AdjMap = new Map();
  const directed = new Map<string, Set<string>>();

  const edges = db.prepare("SELECT source_path, target_path FROM edges").all() as Array<{
    source_path: string;
    target_path: string;
  }>;

  // memory_map is the CANONICAL / shared topology — used by the Index nightly
  // health-check (orphans, hubs, bridges). Agent operative notes are personal
  // memory: excluding them here keeps that health picture honest (a
  // canonically-isolated note must read as orphan even if some agent journaled
  // about it). This is the uniform graph-layer half of the Audit #6 split —
  // dropping operative notes from allPaths transitively drops every edge with
  // an operative endpoint via the existing both-ends guard below.
  //
  // Archive is excluded for the SAME reason: the map is a LIVE-canon navigation
  // surface (themes, gaps, structure). An archived note is dead — it would
  // inflate orphan counts (its incoming active→archive edges were repointed on
  // archival, so it reads as a dead orphan) and pad clusters/hubs with stale
  // content. The forbidden-link health signal is NOT lost: getActiveToArchiveLinks
  // and getUnresolvedLinks query `edges`/`documents` directly, independent of
  // this graph, so they still see the archive.
  //
  // Deliberately NOT mirrored in search.ts (backlink-boost / graph-expand):
  // there, "many agents reference this" is a legitimate cross-agent importance
  // signal and operative→canon edges stay counted. Do not "unify" the two.
  const allPaths = new Set<string>();
  const docs = db.prepare("SELECT path FROM documents").all() as Array<{ path: string }>;
  for (const d of docs) {
    if (d.path.includes(agentMemoryMarker)) continue;
    if (d.path.split("/")[0] === archiveFolder) continue;
    allPaths.add(d.path);
  }

  for (const e of edges) {
    // Only include edges where both ends are indexed, non-operative documents
    if (!allPaths.has(e.source_path) || !allPaths.has(e.target_path)) continue;

    // Undirected for connected components
    if (!adj.has(e.source_path)) adj.set(e.source_path, new Set());
    if (!adj.has(e.target_path)) adj.set(e.target_path, new Set());
    adj.get(e.source_path)!.add(e.target_path);
    adj.get(e.target_path)!.add(e.source_path);

    // Directed for degree counting
    if (!directed.has(e.source_path)) directed.set(e.source_path, new Set());
    directed.get(e.source_path)!.add(e.target_path);
  }

  return { adj, directed, allPaths };
}

// ── Connected components (BFS) ──

function findConnectedComponents(adj: AdjMap, allPaths: Set<string>): string[][] {
  const visited = new Set<string>();
  const components: string[][] = [];

  for (const node of allPaths) {
    if (visited.has(node)) continue;

    const component: string[] = [];
    const queue = [node];
    visited.add(node);

    while (queue.length > 0) {
      const current = queue.shift()!;
      component.push(current);

      const neighbors = adj.get(current);
      if (neighbors) {
        for (const neighbor of neighbors) {
          if (!visited.has(neighbor)) {
            visited.add(neighbor);
            queue.push(neighbor);
          }
        }
      }
    }

    components.push(component);
  }

  // Sort by size descending
  components.sort((a, b) => b.length - a.length);
  return components;
}

// ── Degree calculation ──

function calcDegrees(directed: Map<string, Set<string>>, allPaths: Set<string>): Map<string, { in: number; out: number }> {
  const degrees = new Map<string, { in: number; out: number }>();

  for (const p of allPaths) {
    degrees.set(p, { in: 0, out: 0 });
  }

  for (const [src, targets] of directed) {
    const d = degrees.get(src);
    if (d) d.out = targets.size;
    for (const tgt of targets) {
      const td = degrees.get(tgt);
      if (td) td.in++;
    }
  }

  return degrees;
}

// ── Articulation points (Tarjan) ──

function findArticulationPoints(adj: AdjMap, allPaths: Set<string>): Set<string> {
  const disc = new Map<string, number>();
  const low = new Map<string, number>();
  const parent = new Map<string, string | null>();
  const ap = new Set<string>();
  let timer = 0;

  function dfs(u: string): void {
    let children = 0;
    disc.set(u, timer);
    low.set(u, timer);
    timer++;

    const neighbors = adj.get(u);
    if (!neighbors) return;

    for (const v of neighbors) {
      if (!disc.has(v)) {
        children++;
        parent.set(v, u);
        dfs(v);

        const lowU = low.get(u)!;
        const lowV = low.get(v)!;
        low.set(u, Math.min(lowU, lowV));

        // Root with 2+ children
        if (parent.get(u) === null && children > 1) {
          ap.add(u);
        }

        // Non-root where low[v] >= disc[u]
        if (parent.get(u) !== null && lowV >= disc.get(u)!) {
          ap.add(u);
        }
      } else if (v !== parent.get(u)) {
        const lowU = low.get(u)!;
        const discV = disc.get(v)!;
        low.set(u, Math.min(lowU, discV));
      }
    }
  }

  for (const node of allPaths) {
    if (!disc.has(node)) {
      parent.set(node, null);
      dfs(node);
    }
  }

  return ap;
}

// ── Cluster naming ──

function getDocMeta(db: CoreDb, path: string): { title: string; tags: string[] } {
  const row = db.prepare("SELECT title, tags FROM documents WHERE path = ?").get(path) as
    | { title: string; tags: string | null }
    | null;
  if (!row) return { title: path.split("/").pop()?.replace(/\.md$/, "") ?? path, tags: [] };

  let tags: string[] = [];
  try {
    tags = row.tags ? JSON.parse(row.tags) : [];
  } catch {
    tags = [];
  }

  return { title: row.title || path, tags };
}

function nameCluster(
  db: CoreDb,
  nodes: string[],
  degrees: Map<string, { in: number; out: number }>,
): { name: string; hub: { path: string; title: string; degree: number } | null } {
  // Find hub: node with max total degree in this cluster
  let hubPath: string | null = null;
  let maxDeg = 0;

  for (const n of nodes) {
    const d = degrees.get(n);
    const total = d ? d.in + d.out : 0;
    if (total > maxDeg) {
      maxDeg = total;
      hubPath = n;
    }
  }

  if (!hubPath || maxDeg === 0) {
    // No connections — name by first node alphabetically
    const sorted = [...nodes].sort();
    const meta = getDocMeta(db, sorted[0]);
    return { name: meta.title, hub: null };
  }

  const hubMeta = getDocMeta(db, hubPath);
  const hub = { path: hubPath, title: hubMeta.title, degree: maxDeg };

  // Cluster name = most frequent top-level domain tag across ALL nodes.
  // Was `hubMeta.tags[0].split("/")[0]` — depended on the hub's YAML tag
  // order, so reordering tags silently renamed the cluster (Audit #8).
  // Counting top-level tags over the whole cluster is order-independent;
  // ties break alphabetically for determinism.
  const freq = new Map<string, number>();
  for (const n of nodes) {
    for (const t of getDocMeta(db, n).tags) {
      const top = t.split("/")[0];
      if (top) freq.set(top, (freq.get(top) ?? 0) + 1);
    }
  }
  if (freq.size > 0) {
    const best = [...freq.entries()].sort(
      (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
    )[0][0];
    return { name: best, hub };
  }

  // No tags anywhere in the cluster — fall back to the hub title.
  return { name: hubMeta.title, hub };
}

// ── Which clusters does a bridge connect? ──

function bridgeConnects(
  db: CoreDb,
  bridgePath: string,
  adj: AdjMap,
  degrees: Map<string, { in: number; out: number }>,
): [string, string] | null {
  const neighbors = adj.get(bridgePath);
  if (!neighbors || neighbors.size < 2) return null;

  // Components the graph splits into once the articulation point is removed.
  const visited = new Set<string>([bridgePath]);
  const groups: Set<string>[] = [];

  for (const start of neighbors) {
    if (visited.has(start)) continue;
    const group = new Set<string>();
    const queue = [start];
    visited.add(start);
    while (queue.length > 0) {
      const cur = queue.shift()!;
      group.add(cur);
      const curNeighbors = adj.get(cur);
      if (curNeighbors) {
        for (const n of curNeighbors) {
          if (n === bridgePath) continue;
          if (!visited.has(n)) {
            visited.add(n);
            queue.push(n);
          }
        }
      }
    }
    groups.push(group);
    if (groups.length >= 2) break;
  }

  if (groups.length < 2) return null;

  // Name each side by its OWN most-connected node + size. The old code named
  // both sides by the original cluster (one name per connected component) —
  // but an articulation point is by definition inside one component, so
  // conn[0] === conn[1] always held and buildVaultMap dropped every bridge.
  // The real signal is "what falls off if this node is removed".
  const labelOf = (group: Set<string>): string => {
    let repPath = "";
    let repDeg = -1;
    for (const p of group) {
      const d = degrees.get(p);
      const total = d ? d.in + d.out : 0;
      if (total > repDeg) {
        repDeg = total;
        repPath = p;
      }
    }
    if (!repPath) repPath = [...group].sort()[0] ?? "";
    const title = repPath ? getDocMeta(db, repPath).title : "?";
    return `${title} (n=${group.size})`;
  };

  return [labelOf(groups[0]), labelOf(groups[1])];
}

// ── Main entry point ──

export function buildVaultMap(db: CoreDb, config: CoreConfig): VaultMapData {
  const agentMemoryMarker = agentMemoryFolderMarker(config.taxonomy);
  const { adj, directed, allPaths } = loadGraph(db, agentMemoryMarker, config.taxonomy.folders.archive);
  const degrees = calcDegrees(directed, allPaths);

  // Connected components
  const rawComponents = findConnectedComponents(adj, allPaths);

  // Orphans: single-node components with 0 edges
  const orphans: string[] = [];
  const clusterComponents: string[][] = [];

  for (const comp of rawComponents) {
    if (comp.length === 1) {
      const d = degrees.get(comp[0]);
      if (!d || (d.in + d.out === 0)) {
        orphans.push(comp[0]);
        continue;
      }
    }
    clusterComponents.push(comp);
  }

  // Build clusters
  const clusters: Cluster[] = [];

  for (const comp of clusterComponents) {
    const { name, hub } = nameCluster(db, comp, degrees);
    clusters.push({ name, nodes: comp.sort(), hub });
  }

  // Hubs: degree >= 5
  const hubs: Hub[] = [];
  for (const [path, d] of degrees) {
    const total = d.in + d.out;
    if (total >= 5) {
      const meta = getDocMeta(db, path);
      hubs.push({
        path,
        title: meta.title,
        inDegree: d.in,
        outDegree: d.out,
        total,
      });
    }
  }
  hubs.sort((a, b) => b.total - a.total);

  // Bridges (articulation points)
  const apSet = findArticulationPoints(adj, allPaths);
  const bridges: Bridge[] = [];
  for (const bp of apSet) {
    const meta = getDocMeta(db, bp);
    const conn = bridgeConnects(db, bp, adj, degrees);
    if (conn) {
      bridges.push({ path: bp, title: meta.title, connects: conn });
    }
  }

  // Edge count (unique directed edges)
  let edgeCount = 0;
  for (const targets of directed.values()) {
    edgeCount += targets.size;
  }

  // Unresolved wikilinks — broken (missing) or ambiguous (same basename in
  // 2+ folders) links the resolver kept instead of silently dropping.
  const orphanWikilinks = getUnresolvedLinks(db);

  // Directional archive-link rule: links FROM active notes TO the
  // archive — forbidden, surfaced as a health signal (archive → active is fine).
  const activeToArchiveLinks = getActiveToArchiveLinks(
    db,
    config.taxonomy.folders.archive,
    config.taxonomy.folders.agentMemory,
  );

  return {
    generated: new Date().toISOString(),
    stats: {
      documents: allPaths.size,
      edges: edgeCount,
      clusters: clusters.length,
      hubs: hubs.length,
      bridges: bridges.length,
      orphans: orphans.length,
      orphan_wikilinks: orphanWikilinks.length,
      active_to_archive_links: activeToArchiveLinks.length,
    },
    clusters,
    hubs,
    bridges,
    orphans: orphans.sort(),
    orphanWikilinks,
    activeToArchiveLinks,
  };
}

