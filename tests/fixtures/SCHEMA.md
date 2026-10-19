# Test fixture shape

This is the synthetic data that `tests/fixtures/make-seed.mjs` (owner G1-D) writes into each e2e server's local D1. The source is spec section 8. G0 wrote this file; G1-D keeps it in step with the seed.

## Rules

- **Synthetic only.** No partner data, no real names from the sheet, no real email addresses. Every domain and address ends in `.example.test`.
- **Deterministic.** The same run day always gives the same rows. Dates are relative to the run day (`today`), so rules that use "N days ago" behave the same every day.
- **Schema.** Tables come from `crm/scripts/migrations/001_base.sql`, then `003_site_meta.sql`, then `004_suggestions_runs.sql`. The seed only inserts rows and never creates tables. T29 runs a second server without 003/004.
- **Ids.** Sheet rows use `PG-nnnnn` (sites) and `C-nnnnn` (contacts). Site-created rows use `NEW-nnnn` / `NEWC-nnnn`. Use the same formats as production.
- **Committed JSON.** Synthetic JSON may be committed only under `tests/` (see `.gitignore`). Golden files live in `tests/e2e/golden/`.

## Tables and columns

| Table | Columns the seed fills |
|---|---|
| `partners` | id, domain, name, type, dr, traffic, owner, stage, last_touch, clients, country, contacts, next_step, next_due, source, seed_keyword, notes, deal_model, deal_flat, deal_pct, deal_value, content_url, live_date, tracking_id, updated_at, updated_by |
| `contacts` | id, account_id, first_name, last_name, title, email, linkedin, email_status, source, primary_contact, outreach_status, last_email, replied, client |
| `activity` | n, date, account_id, contact_id, type, by_whom, summary, client |
| `edits` | n, at, by_whom, kind, account_id, contact_id, field, old, new, applied |
| `client_programs` | k, network, commission, cookie_days, payout_terms, signup_url, brief, updated_at, updated_by |
| `kv_meta` (003) | k, v, at, by_whom |
| `suggestions` (004) | id, run_date, kind, account_id, client, name, title, linkedin, source, to_email, subject, body, note, status, reviewed_by, reviewed_at |
| `runs` (004) | n, name, started_at, finished_at, status, summary |

Stages are the stored values: New, Researching, Contacted, Replied, Negotiating, Active, Lost (and Do not contact only when a test turns on `allow_dnc`). Dates are `YYYY-MM-DD`. Timestamps are ISO UTC with a `Z`.

## Required rows

**Sites: 600 on `*.example.test`**
- Every stage.
- Every team owner, plus no owner, plus "Jay" (a past owner).
- Client variants: `Ultahost`, `UltaHost`, `MailerLite/MailerSend`, `Weglot, Ultahost`, `Melograno - Trafft`, `Termly`.
- 20 nameless creators (no name, no domain) that have contacts.
- 10 platform rows (root host in `platform_domains`, or DR >= 90 and not a channel path).
- 120 Replied with no date.
- 40 Replied with `last_touch` 8 to 30 days ago, owner Jonas.
- 6 Replied with a contact whose `last_email` is 10 days ago and `replied=1`.
- 150 Contacted for Kamile with no date, and 30 with `last_touch` 20 days ago.
- 12 Negotiating, 4 of them with the `Waiting on client: ` prefix in `next_step`.
- 1 Active with a future `live_date`.
- 1 Lost with deal terms and a `content_url`.
- 1 Negotiating whose `next_step` contains `INTERNAL-MARKER-7`. The report test checks that this marker never appears in a report.
- Kamile rows with an overdue, a today and a future `next_due`.
- 30 Kamile New rows: none have contacts, 5 have suggestions.
- A site on `dupe.example.test`, so that Add site with `https://www.dupe.example.test/a/b?x=1` finds a duplicate (T7).

**Contacts: 2,000**
- Must include `ann@x.example.test` and `joann@x.example.test`. The test checks that one does not match the other.
- Must include a multi-address row `a@y.example.test; b@y.example.test`.

**Other tables**
- `activity`: rows across stages and owners.
- `edits`: a mix of `applied` values, plus one conflict row (`applied=0` with `n` below the highest applied `n`).
- `suggestions`: all 3 kinds (`candidate`, `email`, `slack_ask`), mostly `open`.
- `kv_meta`: a team override that adds "Denisse".
- `client_programs`: the `soro` seed row.

## Counts the tests assert

Tests such as T2 and T20 compare page numbers with "the fixture". G1-D decides how the expected counts are published (for example, exported from `make-seed.mjs`), so the numbers are not written down twice.
