/**
 * fm-update — YAML-aware structural frontmatter edits for batch paths.
 *
 * TS port of the reference `scripts/mergemind-fm-update.py` (behavioural
 * parity against `tests/python/test_fm_update.py`, 38 fixtures).
 *
 * Structural tool for safe frontmatter changes: `set` scalar, `unset` key,
 * `list-add` / `list-remove` item. The round-trip parser preserves key
 * order and value form (scalar vs block-list). By construction an orphan
 * list item is impossible: unsetting a key removes the key AND its items
 * atomically; scalar→list promotion normalises the value.
 *
 * Why: batch edits of multi-line YAML with sed/regex broke structure — sed
 * edited one line without knowing `  - item` lines hang under it. A
 * `sed` write once destroyed frontmatter on ~180 notes. `sed` over
 * frontmatter is BANNED; every bash-path edit goes through this module.
 *
 * After structural changes the same `frontmatter-fill` logic the post-write
 * hook uses stamps attribution (`last_edited_by` / `updated` /
 * `needs_review` via curator-set, ADR-006) — the bash path stamps
 * equivalently to the harness edit path BY CONSTRUCTION.
 *
 * CLI contract (the package facade binary wires argv to `fmUpdate`):
 *
 *     iapeer-memory fm-update [--agent NAME] [--vault PATH] [--no-stamp]
 *       [--set KEY VALUE | --unset KEY | --list-add KEY VALUE
 *        | --list-remove KEY VALUE]...
 *       FILE [FILE ...]
 *
 * - `--agent` defaults to `resolveAgentName()` (PEER_PERSONALITY first,
 *   never cwd guessing — нюанс 10);
 * - with no operations it is a pure attribution stamp (the reference
 *   `stamp.sh` equivalent);
 * - operations apply to every file, in category order set → unset →
 *   list-add → list-remove (predictable regardless of flag order);
 * - non-.md / missing files are skipped silently.
 */

import fs from "node:fs";
import type { TaxonomyPreset } from "./taxonomy.js";
import {
  assemble,
  atomicWrite,
  moveServiceFieldsToEnd,
  processFile,
  splitFrontmatter,
  stripBrokenDelims,
  yamlDoubleQuote,
  yamlNeedsQuoting,
  BLOCK_LIST_ITEM_RE,
  BLOCK_LIST_ITEM_CAPTURE_RE,
} from "./frontmatter-fill.js";

const KEY_RE = /^([A-Za-z_][\w-]*)\s*:\s*(.*?)\s*$/;

export class Scalar {
  constructor(public value: string) {}
}

export class FmList {
  constructor(public items: string[] = []) {}
}

/**
 * An opaque run of source lines the round-trip model does NOT understand —
 * block scalars (`key: |` + indented body), nested maps (`key:` + indented
 * `sub: v`), non-ASCII-keyed lines. Preserved VERBATIM in place (audit
 * important: the old parser dropped these as «orphans», silently destroying
 * valid YAML — a `--set status` pass erased a note's whole block-scalar
 * description). An explicit op addressing a raw entry's real key replaces
 * the construct — the operator wins; untouched raw entries round-trip
 * byte-identically.
 */
export class RawBlock {
  constructor(public lines: string[]) {}
}

export type Entry = Scalar | FmList | RawBlock;

function stripPairedQuotes(v: string): string {
  if (
    v.length >= 2 &&
    (v.startsWith('"') || v.startsWith("'")) &&
    v.endsWith(v[0])
  ) {
    return v.slice(1, -1);
  }
  return v;
}

/**
 * Serialise a scalar as valid YAML through the SHARED normaliser from
 * frontmatter-fill (one source of quoting rules). The round-trip parser
 * strips quotes/delimiters on read; here they come back VALIDLY: a value
 * with `: ` / an indicator / a dangling quote / guillemets-with-colon →
 * double-quoted, a safe plain scalar → raw.
 */
export function yamlSafeScalar(value: string): string {
  if (yamlNeedsQuoting(value)) {
    return yamlDoubleQuote(stripBrokenDelims(value));
  }
  return value;
}

/**
 * Round-trip AST for the frontmatter YAML subset: top-level scalars,
 * block-style lists (`key:` + `- item`, ANY indent including zero), inline
 * lists (`key: [a, b]`), inline null (`key: null` / `key: ~`). Constructs
 * OUTSIDE the model — block scalars, nested maps, non-ASCII keys — are kept
 * as opaque RawBlock entries and serialised verbatim in place (audit
 * important: they used to be dropped as «orphans», destroying valid YAML on
 * every structural pass). The ONLY thing still dropped is a true orphan: a
 * lone `- value` with no open list key above (the sed-artifact class this
 * sanitisation was built for) — never re-attached.
 *
 * Invariant: list items live INSIDE FmList — an orphan is impossible.
 * Empty scalars and empty lists are dropped after parsing.
 */
export class Frontmatter {
  private entries = new Map<string, Entry>();
  private order: string[] = [];

  static fromText(text: string): Frontmatter {
    const fm = new Frontmatter();
    const lines = text.split("\n").map((l) => l.replace(/\r$/, ""));
    let rawSeq = 0;
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      if (!line.trim()) {
        i += 1;
        continue;
      }

      const mKey = KEY_RE.exec(line);
      if (mKey) {
        const key = mKey[1];
        let value = mKey[2].trim();

        // Block scalar (`key: |` / `key: >`, chomping/indent modifiers) —
        // the body is YAML we do not model: keep the whole construct raw.
        if (/^[|>][0-9+-]*$/.test(value)) {
          const block = [line];
          let j = i + 1;
          while (j < lines.length && (lines[j].trim() === "" || /^\s/.test(lines[j]))) {
            block.push(lines[j]);
            j += 1;
          }
          while (block.length > 1 && block[block.length - 1].trim() === "") block.pop();
          fm.setEntry(key, new RawBlock(block));
          i = j;
          continue;
        }

        if (value.startsWith("[") && value.endsWith("]")) {
          const inner = value.slice(1, -1).trim();
          const items = inner
            ? inner.split(",").map((s) => s.trim()).filter(Boolean)
            : [];
          fm.setEntry(key, new FmList(items));
          i += 1;
          continue;
        }

        if (value === "" || value === "null" || value === "~") {
          if (value === "") {
            // Lookahead decides the construct: indented NON-item content is
            // a nested map (raw, verbatim); `- item` lines (any indent, zero
            // included) are a block list; nothing → empty scalar.
            let k = i + 1;
            while (k < lines.length && lines[k].trim() === "") k += 1;
            if (
              k < lines.length &&
              /^\s+\S/.test(lines[k]) &&
              !BLOCK_LIST_ITEM_RE.test(lines[k])
            ) {
              const block = [line];
              let j = i + 1;
              while (j < lines.length && (lines[j].trim() === "" || /^\s/.test(lines[j]))) {
                block.push(lines[j]);
                j += 1;
              }
              while (block.length > 1 && block[block.length - 1].trim() === "") block.pop();
              fm.setEntry(key, new RawBlock(block));
              i = j;
              continue;
            }
            const items: string[] = [];
            let j = i + 1;
            while (j < lines.length && lines[j].trim() !== "") {
              const it = BLOCK_LIST_ITEM_CAPTURE_RE.exec(lines[j]);
              if (!it) break;
              const v = stripPairedQuotes(it[1].trim());
              if (v) items.push(v);
              j += 1;
            }
            if (items.length > 0) {
              fm.setEntry(key, new FmList(items));
              i = j;
              continue;
            }
          }
          fm.setEntry(key, new Scalar(""));
          i += 1;
          continue;
        }

        value = stripPairedQuotes(value);
        fm.setEntry(key, new Scalar(value));
        i += 1;
        continue;
      }

      // Non-ASCII-keyed mapping line (`Ключ: значение` — Obsidian user
      // fields): outside the ops model, but VALID YAML — preserve verbatim
      // (with its indented continuation) under a synthetic, unaddressable key.
      if (!/^\s/.test(line) && /^[^\s#-][^:]*:/.test(line)) {
        const block = [line];
        let j = i + 1;
        while (j < lines.length && (lines[j].trim() === "" || /^\s/.test(lines[j]))) {
          block.push(lines[j]);
          j += 1;
        }
        while (block.length > 1 && block[block.length - 1].trim() === "") block.pop();
        fm.setEntry(`\u0000raw${rawSeq++}`, new RawBlock(block));
        i = j;
        continue;
      }

      // True orphan (a lone `- value` with no open list key — the sed-artifact
      // class) — drop: the load-bearing structural sanitisation.
      i += 1;
    }
    fm.dropEmpties();
    return fm;
  }

  private dropEmpties(): void {
    for (const key of [...this.order]) {
      const entry = this.entries.get(key)!;
      if (entry instanceof Scalar && entry.value === "") this.remove(key);
      else if (entry instanceof FmList && entry.items.length === 0) this.remove(key);
    }
  }

  private setEntry(key: string, entry: Entry): void {
    if (!this.entries.has(key)) this.order.push(key);
    this.entries.set(key, entry);
  }

  has(key: string): boolean {
    return this.entries.has(key);
  }

  get(key: string): Entry | undefined {
    return this.entries.get(key);
  }

  setScalar(key: string, value: string): void {
    this.setEntry(key, new Scalar(value));
  }

  remove(key: string): boolean {
    if (!this.entries.has(key)) return false;
    this.entries.delete(key);
    this.order.splice(this.order.indexOf(key), 1);
    return true;
  }

  listAppend(key: string, value: string): void {
    const existing = this.entries.get(key);
    if (existing === undefined) {
      this.setEntry(key, new FmList([value]));
      return;
    }
    if (existing instanceof Scalar) {
      const promoted = new FmList(existing.value ? [existing.value] : []);
      if (!promoted.items.includes(value)) promoted.items.push(value);
      this.entries.set(key, promoted);
      return;
    }
    if (existing instanceof RawBlock) {
      // The operator explicitly targets this key — the op wins over the
      // opaque construct (same contract as `set` replacing it).
      this.entries.set(key, new FmList([value]));
      return;
    }
    if (!existing.items.includes(value)) existing.items.push(value);
  }

  listRemove(key: string, value: string): void {
    const existing = this.entries.get(key);
    if (existing === undefined) return;
    if (existing instanceof Scalar) {
      if (existing.value === value) this.remove(key);
      return;
    }
    if (existing instanceof RawBlock) return; // opaque — nothing to match
    const i = existing.items.indexOf(value);
    if (i !== -1) existing.items.splice(i, 1);
    if (existing.items.length === 0) this.remove(key);
  }

  toText(): string {
    const out: string[] = [];
    for (const key of this.order) {
      const entry = this.entries.get(key)!;
      if (entry instanceof Scalar) {
        if (entry.value === "") continue;
        out.push(`${key}: ${yamlSafeScalar(entry.value)}\n`);
      } else if (entry instanceof RawBlock) {
        for (const l of entry.lines) out.push(`${l}\n`); // verbatim, in place
      } else {
        if (!entry.items.length) continue;
        out.push(`${key}:\n`);
        for (const item of entry.items) out.push(`  - ${item}\n`);
      }
    }
    return out.join("");
  }
}

export type OpKind = "set" | "unset" | "list-add" | "list-remove";

export type Op = {
  kind: OpKind;
  key: string;
  value?: string;
};

export function applyOps(fm: Frontmatter, ops: Op[]): void {
  for (const op of ops) {
    switch (op.kind) {
      case "set":
        fm.setScalar(op.key, op.value!);
        break;
      case "unset":
        fm.remove(op.key);
        break;
      case "list-add":
        fm.listAppend(op.key, op.value!);
        break;
      case "list-remove":
        fm.listRemove(op.key, op.value!);
        break;
      default:
        throw new Error(`Unknown operation: ${String(op.kind)}`);
    }
  }
}

/**
 * Apply structural operations to a file's frontmatter. Returns true when
 * the file changed. Creates the frontmatter block when absent AND an
 * operation produced content; unset-only on a missing block is a no-op.
 */
export function updateFile(filePath: string, ops: Op[]): boolean {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return false;
  }
  if (!stat.isFile()) return false;
  const content = fs.readFileSync(filePath, "utf-8");
  const [fmBlock, rest] = splitFrontmatter(content);
  const hadFrontmatter = Boolean(fmBlock);
  const fm = Frontmatter.fromText(fmBlock);
  applyOps(fm, ops);
  // Service trio to the end (canonical convention) — structural-only, never
  // touches values, so a --no-stamp backfill keeps `updated` exact.
  const newFm = moveServiceFieldsToEnd(fm.toText());
  if (!hadFrontmatter && !newFm) return false;
  const newContent = assemble(newFm, rest);
  if (newContent === content) return false;
  atomicWrite(filePath, newContent);
  return true;
}

/**
 * Collect operations in category order: set → unset → list-add →
 * list-remove (inside each category — argument order). The categorical
 * order keeps behaviour predictable regardless of flag order.
 */
export function collectOps(opts: {
  set?: Array<[string, string]>;
  unset?: string[];
  listAdd?: Array<[string, string]>;
  listRemove?: Array<[string, string]>;
}): Op[] {
  const ops: Op[] = [];
  for (const [key, value] of opts.set ?? []) ops.push({ kind: "set", key, value });
  for (const key of opts.unset ?? []) ops.push({ kind: "unset", key });
  for (const [key, value] of opts.listAdd ?? []) ops.push({ kind: "list-add", key, value });
  for (const [key, value] of opts.listRemove ?? []) ops.push({ kind: "list-remove", key, value });
  return ops;
}

export type FmUpdateOptions = {
  files: string[];
  ops?: Op[];
  /** Writer identity; resolve via resolveAgentName at the CLI level. */
  agent?: string | null;
  vault?: string;
  taxonomy: TaxonomyPreset;
  curatorSet?: readonly string[];
  /** false = structural ops only, no attribution stamp. */
  stamp?: boolean;
  /** Injectable for tests. */
  now?: Date;
};

/**
 * The fm-update entry: structural ops + attribution stamp through the SAME
 * fill logic the post-write hook uses (zone resolved from the path; outside
 * the whitelist the stamp is a no-op). With no ops — pure stamp.
 */
export function fmUpdate(opts: FmUpdateOptions): void {
  const ops = opts.ops ?? [];
  const agent = (opts.agent ?? "").trim();
  const vault = (opts.vault ?? "").trim();
  const stamp = opts.stamp ?? true;

  for (const filePath of opts.files) {
    if (!filePath.endsWith(".md")) continue;
    let isFile = false;
    try {
      isFile = fs.statSync(filePath).isFile();
    } catch {
      isFile = false;
    }
    if (!isFile) continue;

    if (ops.length) updateFile(filePath, ops);
    if (!stamp) continue;
    if (!agent) continue;
    processFile(filePath, {
      zone: "auto",
      agent,
      vault,
      taxonomy: opts.taxonomy,
      curatorSet: opts.curatorSet,
      now: opts.now,
    });
  }
}
