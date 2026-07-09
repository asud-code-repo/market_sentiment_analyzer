-- Fixes "permission denied for table" errors from the ingestion Action.
--
-- "Automatically expose new tables" was intentionally left unchecked at
-- project creation (to keep anon/authenticated locked out by default), but
-- that setting also withholds the standard GRANTs new tables normally get —
-- including for service_role. RLS bypass and table-level privileges are
-- separate mechanisms: service_role bypasses RLS policies, but still needs
-- an explicit GRANT to touch the table at all. anon/authenticated
-- deliberately get nothing here — deny-all for them remains intended.
grant usage on schema public to service_role;

grant select, insert, update, delete on crash_checks to service_role;
grant select, insert, update, delete on data_points to service_role;
grant select on latest_snapshot to service_role;
