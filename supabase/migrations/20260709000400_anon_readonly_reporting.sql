-- Stage 5 (reporting website): grants SELECT-only access to the anon role
-- on crash_checks and data_points, so a public static site can query
-- Supabase directly with the publishable/anon key — safe specifically
-- because RLS enforces "read-only, these two tables only" at the database
-- level, regardless of what's visible in the page's client-side JS.
--
-- Never extend this pattern to any table that could hold personal data —
-- these two tables are safe by design (see reference_docs/rules/
-- crash-check-rules.md's split-storage architecture note). No INSERT/
-- UPDATE/DELETE policy is added for anon; service_role remains the only
-- role that can write, via RLS bypass as already established.

create policy "anon read-only crash_checks"
  on crash_checks for select
  to anon
  using (true);

create policy "anon read-only data_points"
  on data_points for select
  to anon
  using (true);
