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

The numbers are never written down twice: tests get them from `make-seed.mjs`, which builds the same rows it seeds.

```js
import { buildFixture, fixtureMeta } from "../fixtures/make-seed.mjs";   // or fixture() from tests/e2e/lib.mjs
const fx = buildFixture({ today: process.env.FIXTURE_TODAY });           // the run's day (run.sh exports it)
fx.counts.by_stage.Replied;            // counts: partners, by_stage, by_owner, owner_stage, by_clients, nameless,
                                       //   contacts, activity, edits, edits_pending, edits_conflicts, suggestions...
fx.groups["kamile-contacted-20d"];     // ids per group (tags below), in seed order
fx.intended.Kamile.doNow.reply;        // the Do now lists B.1 should produce, per reason, in display order
fx.partners, fx.contacts, ...          // every row
const meta = fixtureMeta();            // the /api/meta body (6.3.1) the numbers assume, for pure unit tests
```

`node tests/fixtures/make-seed.mjs --counts [--today YYYY-MM-DD]` prints `counts`, `intended` and `groups` as JSON. The counts and the ids in each group are the same on every day; only the dates move. `tests/unit/schema.test.mjs` loads the seed into 001 in memory and checks the counts.

## Ids

- Sites `PG-00001`..`PG-00596` and `NEW-0001`..`NEW-0004` (so Add site creates `NEW-0005` next).
- Contacts `C-00001`..`C-01998` and `NEWC-0001` (on `NEW-0003`), `NEWC-0002` (no email). Add contact creates `NEWC-0003` next.
- `activity.n` 1..33. `edits.n` 1..30: 1–18 applied except n 7, the conflict row (`applied=0`, below the highest applied n). 19–30 are pending.
- `suggestions.id` = `<run date>:<kind>:<account_id>[:<k>]`: 14 rows (7 candidate, 4 email, 3 slack_ask), 11 open, 2 dismissed, 1 used.
- `runs.n` 1..3 (a discovery run, a failed daily run, an ok daily run).

## Groups (`fx.groups`)

Each site carries one or more tags; `fx.groups[tag]` lists its ids. Dates are relative to `today` (d-20 = 20 days before).

| Tags | What they are for |
|---|---|
| `kamile-new` (30), `kamile-new-sugg` (5), `kamile-new-dismissed` (1) | Kamile's New prospects: 28 PG rows plus `NEW-0001`/`NEW-0002`, no contacts; 5 with open suggestions, 1 with only a dismissed one |
| `kamile-contacted-nodate` (150), `kamile-contacted-20d` (30) | Kamile's Contacted rows with no date and with `last_touch` d-20 (the "No reply" candidates) |
| `K-od1`..`K-od3`, `K-due1`, `K-due2`, `K-rep-a`, `K-rep-b`, `K-rep-handled`, `K-rep-handled2`, `K-rep-stale`, `K-neg-decision`, `K-neg-waiting`, `K-neg-snoozed`, `K-fut1`, `K-fut2`, `K-act-quiet`, `K-act-live` | One designed row each for every Do now reason, the rows that must stay out (handled, stale, snoozed, live) and Coming up. All are also in `kamile-today` |
| `replied-nodate` (120; `kamile-replied-nodate` 90 of them) | Replied with no date at all |
| `jonas-replied-old` (40), `jonas-replied-email` (6) | Replied, `last_touch` d-8..d-30 (outside the 7-day window), and Replied with a contact `last_email` d-10 and `replied=1` (inside the 30-day window) |
| `jonas-neg`, `jonas-decision`, `J-neg-1`..`J-neg-3`, `J-neg-marker` (`internal-marker`), `J-neg-wait-1`, `J-neg-wait-2` | Jonas's Negotiating rows; `J-neg-marker`'s next step contains `INTERNAL-MARKER-7` |
| `waiting-on-client` (4) | The 4 Negotiating rows whose `next_step` starts with `Waiting on client: ` |
| `soro-live-last-month` (2), `active-future-live` (1), `J-act-signed`, `lost-with-terms` (1) | Report rows: Soro placements live last month, an Active row with a future `live_date`, a signed row not live yet, a Lost row with deal terms and a `content_url` |
| `jonas-contacted` (10), `jonas-noreply` (5), `J-od`, `jonas-new` (7, 2 of them platform rows, plus `NEW-0004`) | Jonas's other Today rows |
| `platform` (10) | Stage New, DR 90–97 on `*.example.test` (2 owned by Jonas, 8 unowned): hidden from prospect lists |
| `channel` (1) | `youtube.com/@pgfixture-channel`, DR 99: the only domain outside `example.test`. A channel path is never a platform (D7) |
| `nameless` (20) | No name and no domain; each has a contact, so the v2 `label` is the contact's name or email |
| `dupe-site`, `mr-money`, `site-x`, `site-y`, `site-w`, `site-ann`, `contact-name-site`, `new-3` | Search and duplicate rows: `dupe.example.test` (T7), "Mr. Money Matters", `rob@x`/`joann@x`/`ann@x.example.test` (T9, T10), `a@y.example.test; b@y.example.test`, `joxann@w.example.test`, the contact "Ottilie Vance", `NEW-0003` |
| `researching` (3), `do-not-contact` (1), `past-owner` (3, owner "Jay"), `unowned-*` | The other stages and owners. The Do not contact row is stored even though `allow_dnc` is off: the sheet can hold the value |
| `gaby-conflict` (1) | The site of the conflict `edits` row (n 7) |
| `<owner>-new`, `<owner>-contacted`, `<owner>-replied`, `<owner>-active`, `<owner>-lost` | Small groups so every team member owns something (Denisse and Egle 2 New each) |
| `contract` (20): `c-interested`, `c-deal`, `c-lost`, `c-assign`, `c-nochange`, `c-waiting`, `c-note`, `c-live`, `c-bulk-a`..`c-bulk-f`, `c-contact`, `c-contact-2`, `c-spare-1`..`c-spare-4` | `PG-00577`..`PG-00596`, the rows the golden `edits` files (`tests/e2e/golden/`) write to. Owner Tomas, except `c-bulk-a` (Mantvydas), `c-bulk-c` (Gaby) and the unowned `c-assign` and `c-bulk-b`, so they never show on Kamile's or Jonas's Today. Tests may change them; set them with `applyBefore(case.before)` first |

## Optional tables (003/004)

`seedSql(fx, {tables})` writes `kv_meta`, `suggestions` and `runs` rows only for the tables listed, so the same seed works on the T29 server without 003/004. `startServer()` lists the tables that exist and passes them. After a late 003/004, `server.seedOptional()` adds those rows.

`kv_meta` holds one key, `team`: a JSON array of the full team, `[{"name":"Jonas","active":true},{"name":"Vik","home":"team","active":true},…,{"name":"Denisse","active":true},{"name":"Egle","active":true}]` (11 names). It is the whole list, not a diff; Denisse is in it (T20).
