-- Signal Tiering & Confirmation Windows (crash-check-rules.md v5): a Tier-1
-- indicator's RED reading must hold across 2+ distinct ingestion dates
-- before it can authorize a wave, not just be true on whatever row the
-- dashboard happens to render. confirmation_state tracks, per indicator,
-- its current color, the observation_date that color was computed from,
-- how many distinct dates it's held, and when the current streak began.
-- confirmed_red_count is the subset of red_count that has actually cleared
-- confirmation — wave_authorized now gates on this, not raw red_count.
alter table crash_checks add column confirmation_state jsonb;
alter table crash_checks add column confirmed_red_count integer;
