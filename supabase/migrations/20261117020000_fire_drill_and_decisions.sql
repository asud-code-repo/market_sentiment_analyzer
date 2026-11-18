-- Private Full Report additions (2026-11-17). Both tables are already
-- service_role-only (RLS on, no policies, no anon/authenticated grants), so
-- the new columns inherit that; no grant changes.
--
-- full_report_snapshots.fire_drill: computed by write_full_report from the
-- local deployment-instrument registry and policy (mcp_server
-- fireDrillSnapshot.ts). Wave 3 drill for the waves alone and each
-- crash-type layer: percentages, readiness grades, the instrument each line
-- would buy and why. Never dollar amounts. { error } when it couldn't run.
--
-- portfolio_review_snapshots.decisions: the review's "Waiting for your
-- decision" list, [{ title, detail, kind, ticker? }], a fresh list each run.
--
-- The MCP server retries without these columns if they're missing, so the
-- order of applying this vs deploying the server doesn't matter.
alter table full_report_snapshots
  add column if not exists fire_drill jsonb;

alter table portfolio_review_snapshots
  add column if not exists decisions jsonb;
