// Run: npm test (node's built-in test runner via tsx -- no test framework dependency).
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSections, findSection, tableOfContents, readRulesDoc, mergePersonalRules } from "./rulesDoc.js";

// The "real rules doc" test below must exercise the public doc alone.
delete process.env.PERSONAL_RULES_PATH;
delete process.env.PORTFOLIO_PATH;

const DOC = `# Title

Intro line.

## Alpha Rules (read first)

alpha body

### Alpha detail

detail body

\`\`\`
## not a heading (inside a code fence)
\`\`\`

## Beta & Gamma

beta body

### Alpha detail extra

nested under beta
`;

test("parses the intro, ## sections with their ### children, and ignores fenced headings", () => {
  const s = parseSections(DOC);
  assert.deepEqual(s.map((x) => [x.title, x.level, x.parent]), [
    ["Introduction", 2, null],
    ["Alpha Rules (read first)", 2, null],
    ["Alpha detail", 3, "Alpha Rules (read first)"],
    ["Beta & Gamma", 2, null],
    ["Alpha detail extra", 3, "Beta & Gamma"],
  ]);
  const alpha = s[1].content;
  assert.match(alpha, /alpha body/);
  assert.match(alpha, /detail body/); // ### child included in its ## section
  assert.match(alpha, /not a heading/); // the fenced line stays inside, not a split point
  assert.doesNotMatch(alpha, /beta body/);
});

test("lookup: exact beats prefix beats substring, case and punctuation ignored", () => {
  const s = parseSections(DOC);
  const title = (r: ReturnType<typeof findSection>) => ("found" in r ? r.found.title : null);
  assert.equal(title(findSection(s, "alpha detail")), "Alpha detail"); // exact, not the longer "extra"
  assert.equal(title(findSection(s, "ALPHA RULES")), "Alpha Rules (read first)"); // prefix
  assert.equal(title(findSection(s, "beta and gamma")), null); // "and" isn't "&"
  assert.equal(title(findSection(s, "beta & gamma")), "Beta & Gamma");
  assert.equal(title(findSection(s, "gamma")), "Beta & Gamma"); // substring
  assert.ok("missing" in findSection(s, "delta"));
  assert.ok("missing" in findSection(s, "  "));
});

test("ambiguous matches return candidates unless one is a ## section", () => {
  const s = parseSections(DOC);
  const r = findSection(s, "detail");
  assert.ok("ambiguous" in r);
  assert.deepEqual(r.ambiguous.map((x) => x.title), ["Alpha detail", "Alpha detail extra"]);
  // "alpha" prefixes both "Alpha Rules (read first)" (##) and "Alpha detail" (###): the ## section wins.
  const alpha = findSection(s, "alpha");
  assert.ok("found" in alpha && alpha.found.title === "Alpha Rules (read first)");
});

test("the real rules doc: sections the workflows name are all reachable", () => {
  const s = parseSections(readRulesDoc());
  for (const name of ["Formatting Requirements", "Deployment Instrument Selection", "Signal Tiering", "6-Indicator Panel", "Wave Deployment Thresholds", "Post-Crash Allocation Protocol", "Stage 1", "Contextual Indicators", "Statistical Hazard Model", "AI single-name credit stress", "Fiscal-event trigger", "Treasury auction quality", "Repo-stress spread", "Bond volatility", "Event-conditional scenarios"]) {
    assert.ok("found" in findSection(s, name), name);
  }
  const toc = tableOfContents(s);
  assert.ok(toc.length >= 15);
  assert.ok(toc.every((t) => t.approx_tokens > 0));
});

const PUBLIC = [
  "# Rules",
  "",
  "## Waves",
  "",
  "Public stub: values are private.",
  "",
  "### Slow path",
  "",
  "Public slow stub.",
  "",
  "## Panel",
  "",
  "Panel text.",
  "",
  "```",
  "## Waves",
  "```",
].join("\n");

test("mergePersonalRules: a personal ## replaces only its own text, a ### only its subsection", () => {
  const personal = ["Comment before the first heading is ignored.", "", "## Waves", "", "Real wave splits.", ""].join("\n");
  const m = mergePersonalRules(PUBLIC, personal);
  assert.deepEqual(m.replaced, ["Waves"]);
  assert.ok(m.markdown.includes("Real wave splits."));
  assert.ok(!m.markdown.includes("Public stub"));
  assert.ok(m.markdown.includes("Public slow stub."), "the ### child is untouched");
  assert.ok(!m.markdown.includes("Comment before"));
  assert.ok(m.markdown.includes("```\n## Waves\n```"), "fenced headings are not sections");

  const sub = mergePersonalRules(PUBLIC, ["### Slow path", "", "Real slow-bear numbers."].join("\n"));
  const s = parseSections(sub.markdown);
  const waves = findSection(s, "Waves");
  assert.ok("found" in waves && waves.found.content.includes("Public stub") && waves.found.content.includes("Real slow-bear numbers."));
});

test("mergePersonalRules: unmatched sections are appended, case and punctuation are ignored", () => {
  const m = mergePersonalRules(PUBLIC, ["## PANEL", "", "Private panel note.", "", "## Account glossary", "", "Tactical = the plan account."].join("\n"));
  assert.deepEqual(m.replaced, ["PANEL"]);
  assert.deepEqual(m.appended, ["Account glossary"]);
  const s = parseSections(m.markdown);
  const g = findSection(s, "Account glossary");
  assert.ok("found" in g && g.found.content.includes("Tactical = the plan account."));
  assert.equal(m.warnings.length, 0);
});
