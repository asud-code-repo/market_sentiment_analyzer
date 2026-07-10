-- Fixes "permission denied for table" for the anon role, same root cause
-- as the earlier service_role fix (20260709000100): an RLS policy governs
-- which rows are visible, but Postgres still requires the base GRANT
-- before RLS policies are even evaluated. The SELECT-only policy from
-- 20260709000400 was correct but incomplete without this.
grant usage on schema public to anon;
grant select on crash_checks to anon;
grant select on data_points to anon;
