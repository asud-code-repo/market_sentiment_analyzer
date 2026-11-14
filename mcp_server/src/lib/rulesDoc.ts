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

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const RULES_DOC_PATH = path.resolve(fileURLToPath(import.meta.url), "../../../../reference_docs/rules/crash-check-rules.md");

/**
 * Personal rules (local-only, gitignored): sections whose real text is
 * private, e.g. wave splits or plan-specific restrictions. Same headings as
 * the public doc; see mergePersonalRules. PERSONAL_RULES_PATH if set,
 * otherwise personal-rules.md next to PORTFOLIO_PATH. null = not configured
 * (a fresh checkout reads the public doc alone).
 */
export function personalRulesPath(): string | null {
  if (process.env.PERSONAL_RULES_PATH) return process.env.PERSONAL_RULES_PATH;
  const portfolio = process.env.PORTFOLIO_PATH;
  return portfolio ? path.join(path.dirname(portfolio), "personal-rules.md") : null;
}

export interface RulesDocLoad {
  markdown: string;
  personal: { path: string | null; loaded: boolean; replaced: string[]; appended: string[]; warnings: string[] };
}

/** The public rules doc with the personal sections merged in, when the personal file exists. */
export function loadRulesDoc(): RulesDocLoad {
  const publicMd = readFileSync(RULES_DOC_PATH, "utf8");
  const p = personalRulesPath();
  if (!p || !existsSync(p)) {
    const warnings = p ? [`Personal rules file not found at ${p}: personal sections show their public stubs.`] : [];
    return { markdown: publicMd, personal: { path: p, loaded: false, replaced: [], appended: [], warnings } };
  }
  const merged = mergePersonalRules(publicMd, readFileSync(p, "utf8"));
  return { markdown: merged.markdown, personal: { path: p, loaded: true, replaced: merged.replaced, appended: merged.appended, warnings: merged.warnings } };
}

export function readRulesDoc(): string {
  return loadRulesDoc().markdown;
}

interface HeadingUnit {
  level: 2 | 3;
  title: string;
  start: number; // line index of the heading
  end: number; // exclusive: the next ## or ### heading of ANY level, or end of doc
}

function headingUnits(lines: string[]): { firstHeading: number; units: HeadingUnit[] } {
  const heads: { i: number; level: 2 | 3; title: string }[] = [];
  let inFence = false;
  lines.forEach((l, i) => {
    if (/^\s*```/.test(l)) inFence = !inFence;
    const m = !inFence && /^(#{2,3}) (.+?)\s*$/.exec(l);
    if (m) heads.push({ i, level: m[1].length as 2 | 3, title: m[2] });
  });
  const units = heads.map((h, k) => ({ level: h.level, title: h.title, start: h.i, end: heads[k + 1]?.i ?? lines.length }));
  return { firstHeading: heads[0]?.i ?? lines.length, units };
}

/**
 * Merges personal sections into the public doc. Each ## or ### heading in
 * the personal file is one unit: its heading line and text up to the next
 * heading of any level. A unit replaces the public unit with the same level
 * and title (case/punctuation-insensitive), so a personal ## replaces only
 * that section's own text, not its ### children; a personal ### replaces
 * just that subsection. Units with no public match are appended at the end.
 * Text before the personal file's first heading is a comment and is ignored.
 */
export function mergePersonalRules(
  publicMd: string,
  personalMd: string,
): { markdown: string; replaced: string[]; appended: string[]; warnings: string[] } {
  const pub = publicMd.split(/\r?\n/);
  const per = personalMd.split(/\r?\n/);
  const pu = headingUnits(pub);
  const qu = headingUnits(per).units;
  const replacements = new Map<number, string[]>();
  const appended: string[][] = [];
  const replaced: string[] = [];
  const appendedTitles: string[] = [];
  const warnings: string[] = [];
  for (const u of qu) {
    const body = per.slice(u.start, u.end);
    const matches = pu.units.flatMap((p, i) => (p.level === u.level && norm(p.title) === norm(u.title) ? [i] : []));
    if (matches.length > 1) {
      warnings.push(`"${u.title}" matches ${matches.length} public headings; personal text not used.`);
    } else if (matches.length === 1) {
      if (replacements.has(matches[0])) warnings.push(`"${u.title}" appears twice in the personal file; the later one wins.`);
      replacements.set(matches[0], body);
      replaced.push(u.title);
    } else {
      appended.push(body);
      appendedTitles.push(u.title);
    }
  }
  const out = pub.slice(0, pu.firstHeading);
  pu.units.forEach((p, i) => out.push(...(replacements.get(i) ?? pub.slice(p.start, p.end))));
  for (const body of appended) {
    if (out.length && out[out.length - 1].trim() !== "") out.push("");
    out.push(...body);
  }
  return { markdown: out.join("\n"), replaced, appended: appendedTitles, warnings };
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
