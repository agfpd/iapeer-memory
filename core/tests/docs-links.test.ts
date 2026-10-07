import { describe, expect, it } from "bun:test";
import fs from "node:fs";
import { extractWikilinks, stripLinksSection } from "../src/parser.js";
import { TAXONOMY_EN, TAXONOMY_RU } from "../src/taxonomy.js";

describe("public links documentation", () => {
  for (const { file, taxonomy } of [
    { file: "05-links-and-tags.md", taxonomy: TAXONOMY_EN },
    { file: "ru/05-связи-и-теги.md", taxonomy: TAXONOMY_RU },
  ]) {
    it(`${taxonomy.locale}: the note example puts graph metadata after the body`, () => {
      const doc = fs.readFileSync(new URL(`../../docs/${file}`, import.meta.url), "utf-8");
      const example = doc.match(/```markdown\n([\s\S]*?)\n```/)?.[1];
      expect(example).toBeDefined();
      const body = example!.replace(/^---\n[\s\S]*?\n---\n+/, "").trim();
      const heading = body.indexOf(taxonomy.linksSection);
      // Leading blocks remain supported for old notes, but public examples
      // must teach the canonical trailing layout, not legacy compatibility.
      expect(heading).toBeGreaterThan(0);
      const content = body.slice(0, heading).trim();
      expect(stripLinksSection(body, taxonomy)).toBe(content);
      const links = extractWikilinks(body.slice(heading));
      expect(links.length).toBeGreaterThan(0);
    });
  }
});
