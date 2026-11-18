-- Macro & Fiscal tab narrative (2026-11-18). A short AI-written paragraph
-- (3-5 sentences) that explains what the fiscal checklist, yield curve and
-- contextual indicators add up to, shown at the top of that tab's rail with
-- the AI mark. Written by write_snapshot only on runs where a Macro-tab
-- reading changed; other rows leave it null and the dashboard shows the most
-- recent non-null one with its date.
--
-- Public, like notes: write_snapshot runs the same dollar-figure and
-- private-term guards over it before insert. Macro/market narrative only.
--
-- Safe to deploy the code before or after this: the dashboard and
-- /latest.md read it in their own query and skip it if the column is
-- missing, and write_snapshot retries without it (returning a warning).

alter table crash_checks add column if not exists macro_narrative text;
