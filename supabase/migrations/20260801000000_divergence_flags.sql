-- Divergence detection (IG-vs-HY, initial-vs-continuing claims, VIX-vs-HY)
-- moves from an MCP-server-only, chat-triggered computation into the daily
-- deterministic rule engine (classify.ts), so it has a single persisted
-- source of truth both the chat tools and dashboard_site can read from,
-- instead of two independent computations that could drift apart. Matches
-- the existing Rule Engine Output Contract — see crash-check-rules.md.
--
-- Shape: [{ pair, diverging, detail, series_a: {label, value, unit,
--   delta_7d}, series_b: {label, value, unit, delta_7d} }, ...]
alter table crash_checks add column divergence_flags jsonb;
