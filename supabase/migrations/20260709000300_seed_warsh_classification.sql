-- One-time data seed, not a schema change: the automated pipeline had no
-- way to know Warsh was classified HAWKISH on the June 22, 2026 FOMC (that
-- context only existed in the user's original master prompt doc, which
-- isn't wired into any automated source). Seeds it into the most recent
-- crash_checks row so the rule engine and write_snapshot carry it forward
-- correctly from here on, instead of defaulting to PENDING.
update crash_checks
set
  warsh_classification = 'HAWKISH',
  warsh_classification_date = '2026-06-22',
  warsh_hard_rules_active = true
where id = (select id from crash_checks order by run_at desc limit 1);
