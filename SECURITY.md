# Security policy

## Reporting a vulnerability

Please **don't open a public issue** for a security problem. Report it
privately through GitHub instead:
[**Report a vulnerability**](../../security/advisories/new) (Security tab →
"Report a vulnerability").

Include what you found, how to reproduce it and what an attacker could do
with it. This is a single-maintainer project, so there's no formal response
time, but security reports are read first.

## What's in scope

The design keeps personal data off public surfaces (see "Security model" in
the [README](README.md#security-model-public-engine-private-policy)). Reports
that break that design are the most valuable:

- Reading a private Supabase table (`full_report_snapshots`,
  `private_data_points`, the watchlist or insider tables) with the public
  anon key, or writing to any table with it.
- Reaching the private Full Report page without passing Cloudflare Access,
  including through preview or deployment URLs.
- Personal policy or dollar figures appearing in a public table, the public
  dashboard or this repository, including its history.
- A secret committed to the repository or its history.
- Injection or cross-site scripting on the public dashboard.

## Not a vulnerability

- **The Supabase anon key in `dashboard_site/`.** It's a publishable key,
  public by design. Row-level security limits it to public market data and
  rule output.
- The public dashboard's market data being readable. That's its purpose.
- Missing rate limiting or security headers without a concrete impact.

## Supported versions

Only the current `main` branch and the live sites are maintained.
