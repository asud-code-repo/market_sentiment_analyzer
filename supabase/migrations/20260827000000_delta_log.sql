-- Structured delta log: the colored +/- bulleted list of factors already
-- rendered live in the chat HTML artifact (reference_docs/rules/
-- dashboard-template.html's cc-delta-log), never previously persisted --
-- only unstructured prose in `notes` survived to the database, which
-- dashboard_site could not reconstruct into the same colored list (its own
-- .delta-log CSS has sat unused since it was added). Nullable, no default:
-- optional because the very first report ever (or any run with no prior
-- full report to diff against, per project-instructions.md step 8) has
-- nothing to build a delta log from.
alter table crash_checks add column delta_log jsonb;
