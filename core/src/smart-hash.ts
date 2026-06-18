/**
 * sha256 of the SEMANTIC content of a vault .md file.
 *
 * TS port of the reference `scripts/mergemind-frontmatter-hash.py`
 * (behavioural parity against `tests/python/test_frontmatter_hash.py`).
 *
 * The "semantic" part is the frontmatter without service fields plus the
 * body. Service fields (`last_edited_by`, `updated`, `needs_review`) are
 * rewritten by hooks after every edit and carry no meaning for the Index —
 * noisy edits of those fields produce the SAME hash, the change detector
 * emits no event, and the echo-loop is impossible below the instruction
 * level (ADR-004/005: smart-hash is the idempotency primitive of the
 * pipeline).
 */

import fs from "node:fs";
import crypto from "node:crypto";

/**
 * Frontmatter fields ignored when hashing. Field NAMES are locale-independent
 * (EN in both presets); the set is exported for detector configuration.
 */
export const SERVICE_FIELDS: ReadonlySet<string> = new Set([
  "last_edited_by",
  "updated",
  "needs_review",
]);

const FRONTMATTER_RE = /^---[^\S\n]*\n([\s\S]*?\n)---[^\S\n]*(?:\n|$)/;
const KEY_RE = /^([a-zA-Z_][\w-]*)\s*:/;

function sha256Hex(data: Uint8Array | string): string {
  return crypto.createHash("sha256").update(data).digest("hex");
}

/**
 * Smart hash of raw file bytes. Invalid UTF-8 → raw-bytes hash (binary
 * fallback). No frontmatter block → hash of the content as-is.
 */
export function smartHash(content: Uint8Array): string {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(content);
  } catch {
    // Binary / non-utf-8: hash as-is, no cleanup.
    return sha256Hex(content);
  }

  const m = FRONTMATTER_RE.exec(text);
  if (!m) {
    // No frontmatter block — hash the body as-is.
    return sha256Hex(content);
  }

  const fmBlock = m[1];
  const body = text.slice(m[0].length);

  // Drop service-field lines. The parser is simple — multi-line YAML values
  // are not supported (our service fields are always single-line).
  const cleanedLines: string[] = [];
  for (const line of fmBlock.split("\n")) {
    const keyMatch = KEY_RE.exec(line);
    if (keyMatch && SERVICE_FIELDS.has(keyMatch[1])) continue;
    cleanedLines.push(line);
  }
  const cleanedFm = cleanedLines.join("\n");

  // Hash cleaned frontmatter + body. The `---` separator keeps frontmatter
  // and body from merging (theoretical collision guard).
  return sha256Hex(`${cleanedFm}\n---\n${body}`);
}

/**
 * Smart hash of a file. Returns "" when the file is unreadable
 * (silent skip — mirrors the reference CLI contract).
 */
export function hashFile(filePath: string): string {
  let content: Buffer;
  try {
    content = fs.readFileSync(filePath);
  } catch {
    return "";
  }
  return smartHash(content);
}
