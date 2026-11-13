// Section-level access to reference_docs/rules/crash-check-rules.md.
//
// Why (2026-11-13): Claude Desktop project knowledge stopped loading in
// full once the synced docs passed ~200 KB, and started returning search
// fragments instead (the daily run "couldn't get the full dashboard
// template"). The rules doc is ~60% of that and grows with most features,
// so it's served from disk by the get_rules tool instead: always complete,
// always the committed version, and only the section a run actually needs.
//
// Parsing is pure (unit-tested in rulesDoc.test.ts); readRulesDoc() is the
// only part that touches the filesystem.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const RULES_DOC_PATH = path.resolve(fileURLToPath(import.meta.url), "../../../../reference_docs/rules/crash-check-rules.md");

export function readRulesDoc(): string {
  return readFileSync(RULES_DOC_PATH, "utf8");
}

export interface RulesSection {
  title: string; // heading text without the leading #'s
  level: 2 | 3; // ## or ###; the text before the first ## is "Introduction" (level 2)
  parent: string | null; // the enclosing ## title for a ### section
  content: string; // the heading line plus everything up to the next heading of the same or higher level
}

/** Splits the doc into ## sections (each including its ### children) and ### sections. */
export function parseSections(markdown: string): RulesSection[] {
  const lines = markdown.split(/\r?\n/);
  const heads: { i: number; level: 2 | 3; title: string }[] = [];
  let inFence = false;
  lines.forEach((l, i) => {
    if (/^\s*```/.test(l)) inFence = !inFence;
    const m = !inFence && /^(#{2,3}) (.+?)\s*$/.exec(l);
    if (m) heads.push({ i, level: m[1].length as 2 | 3, title: m[2] });
  });
  const out: RulesSection[] = [];
  const firstH2 = heads.find((h) => h.level === 2)?.i ?? lines.length;
  const intro = lines.slice(0, firstH2).join("\n").trim();
  if (intro) out.push({ title: "Introduction", level: 2, parent: null, content: intro });
  let parent: string | null = null;
  heads.forEach((h, k) => {
    if (h.level === 2) parent = h.title;
    const end = heads.slice(k + 1).find((n) => n.level <= h.level)?.i ?? lines.length;
    out.push({ title: h.title, level: h.level, parent: h.level === 3 ? parent : null, content: lines.slice(h.i, end).join("\n").trim() });
  });
  return out;
}

const norm = (s: string) => s.toLowerCase().replace(/&amp;/g, "&").replace(/[^a-z0-9&]+/g, " ").trim();

export type SectionLookup =
  | { found: RulesSection }
  | { ambiguous: RulesSection[] }
  | { missing: true };

/**
 * Finds a section by name: an exact (case/punctuation-insensitive) title
 * match wins, then a title that starts with the query, then one that
 * contains it. When several sections tie at the best tier, a single ##
 * section among them wins (its ### children are inside it anyway);
 * otherwise the caller gets the candidates.
 */
export function findSection(sections: RulesSection[], query: string): SectionLookup {
  const q = norm(query);
  if (!q) return { missing: true };
  for (const test of [(t: string) => t === q, (t: string) => t.startsWith(q), (t: string) => t.includes(q)]) {
    const hits = sections.filter((s) => test(norm(s.title)));
    if (hits.length === 1) return { found: hits[0] };
    if (hits.length > 1) {
      const top = hits.filter((s) => s.level === 2);
      return top.length === 1 ? { found: top[0] } : { ambiguous: hits };
    }
  }
  return { missing: true };
}

/** Table of contents: every ## section with its ### children and an approximate token size. */
export function tableOfContents(sections: RulesSection[]): { title: string; approx_tokens: number; subsections: string[] }[] {
  return sections
    .filter((s) => s.level === 2)
    .map((s) => ({
      title: s.title,
      approx_tokens: Math.round(s.content.length / 4),
      subsections: sections.filter((c) => c.level === 3 && c.parent === s.title).map((c) => c.title),
    }));
}
