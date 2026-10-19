# The frozen `edits` contract and the daily-run facts

The website never writes to the Google Sheet. Every change made on the site lands in the D1 table `edits`, and the scheduled "CRM daily run" (`trig_01W5Wr581htK5Xzf1BDrufxq`, weekdays 08:47 Vilnius) copies the waiting rows into the sheet. This page is the contract between the two. It is **frozen**: the redesign adds endpoints, but every endpoint writes exactly the rows below (spec 1.3, 6.4).

**The executable definition is `tests/e2e/golden/`.** Those files hold the rows the live code (`d5e91d9`) wrote for every write path on the synthetic fixture. `tests/e2e/90-api-contract.test.mjs` (T22) and `tests/e2e/91-migrations.test.mjs` replay them against the new code. Never re-capture them from new code. A change to them needs a matching change to the daily-run prompt in the same release (`crm/docs/daily-run-changes.md`).

## 1. Kinds and columns

`edits` columns: `n` (INTEGER PK, the order), `at` (ISO UTC to the second, `2026-10-22T09:15:02Z`), `by_whom` (self-declared name, max 40 characters, default `Someone`), `kind`, `account_id`, `contact_id`, `field`, `old`, `new`, `applied` (0 = waiting, 1 = copied; only the daily run sets 1).

| kind | Written by | account_id | contact_id | field | old | new |
|---|---|---|---|---|---|---|
| `update` | PATCH `/api/partner/:id`, POST `/api/partner/:id/outcome`, POST `/api/bulk` (ids and rows modes) | partner id (`PG-` or `NEW-`) | NULL | the column name, one of the 13 EDITABLE fields | previous value as text, or NULL | new value as text, or NULL |
| `create_account` | POST `/api/partners` (Add site) | the new `NEW-nnnn` id | NULL | NULL | NULL | JSON, keys in this order: `domain, name, stage, owner, clients, type, next_step, next_due, notes, added` |
| `create_contact` | POST `/api/partner/:id/contacts` (Add contact, also "Add as contact" from a suggestion) | partner id | the new `NEWC-nnnn` id | NULL | NULL | JSON: `first_name, last_name, title, email, linkedin, client` |
| `activity` | POST `/api/partner/:id/activity`, POST `/api/partner/:id/outcome` | partner id | the contact id or NULL | **the new `activity.n`, as text** | NULL | JSON: `date, type, summary, client` |
| `client_program` | PUT `/api/clients/:k` | NULL | NULL | **the stored client key** (`soro`, `botanical synthesis`) | NULL | JSON: `network, commission, payout_terms, signup_url, brief, cookie_days` |

Details that are part of the contract (the golden files compare them as strings):

- EDITABLE = `stage, owner, clients, type, next_step, next_due, deal_model, deal_flat, deal_pct, deal_value, content_url, live_date, tracking_id` (`lib/crm.js`). Nothing else can be changed on the site, and nothing can be deleted.
- Numbers in `update` rows are text: `"1200"`, `"12.5"`, `"2500.55"` (cleaned of `$ , %` and spaces, rounded to cents).
- A cleared value is NULL in `new`, never `""`.
- JSON in `new` keeps its key order, and its mix of `""` and `null`. For example Add contact writes `"last_name":""` but `"title":null`, and an activity without a client writes `"client":null`.
- `activity.date` and `create_account.added` are the server's UTC date.
- Stage values are the stored ones: `New, Researching, Contacted, Replied, Negotiating, Active, Lost`. `Do not contact` is accepted only while the Settings switch "Allow 'Do not contact'" is on (kv_meta `allow_dnc` = `"1"`, spec D3), which waits for diff (a) of the daily-run prompt.
- `owner` is free text (max 40), so "Someone else" names and Settings team changes need no change here.

## 2. Rules

- **One `update` row per changed field.** Unchanged fields write nothing, and a request that changes nothing writes no row. The rows follow the order of the keys in the request's `fields`; the page sends them in EDITABLE order.
- **`applied = 0` waits.** The daily run applies rows in `n` order and then sets `applied = 1` directly in D1. Edit history shows three states: Waiting (`applied = 0`), Copied (`applied = 1`), and "Not copied – a sheet edit won; check the sheet" (`applied = 0` with `n` below the highest applied `n`, rule R5).
- **`NEW-` / `NEWC-` ids** are temporary: `NEW-` + (highest NEW number + 1) padded to 4 digits, the same for `NEWC-`. The daily run gives them the next free `PG-` / `C-` id (R2). `update`, `activity` and `create_contact` rows may point at a `NEW-` id created earlier the same day.
  - A number is never handed out twice. After the run renames `NEW-0012`, the highest `NEW-` number left in `partners` drops, so "highest + 1" alone would give the next new site `NEW-0012` again, and an old link to it would open that other site. `kv_meta` therefore keeps the highest number handed out (`new_site_n`, `new_contact_n`), written in the same batch as the insert, and the next id is 1 + the larger of that and the highest number in the table (`lib/crm.js#nextTempId`). Before migration 003 (no `kv_meta`) it is the table's highest + 1, as on `d5e91d9`. The `edits` rows are unchanged; only which number a new site gets after a rename differs. The 4-digit padding grows to 5 digits after `NEW-9999`.
- **Full imports only when nothing is waiting** (`crm/scripts/build_d1_import.py`): a full import replaces partners and drops and recreates contacts and activity, so waiting rows would point at the wrong activity `n`. After a full import, re-run migration 003 (it recreates the indexes on `activity`).
- **Atomic writes.** Every request validates everything first and writes nothing on error (400 with a sentence for the user, or 404 `{"error":"Not found"}`). Each request's writes run in one `db.batch`, so a failure leaves no half-written change.

## 3. Which endpoint writes what

| Endpoint | Rows, in order |
|---|---|
| PATCH `/api/partner/:id` | `update` × changed fields |
| POST `/api/partner/:id/outcome` | `update` × changed fields, **then** one `activity` row (when the request has an activity). These equal `golden/patch-partner.json` followed by `golden/activity-log.json`: for Interested, `patch-partner#interested` then `activity-log#interested` |
| POST `/api/partner/:id/activity` | one `activity` row |
| POST `/api/bulk` (ids mode and rows mode) | `update` × changed fields per site (ids mode writes per field, so compare bulk rows sorted by `account_id`, then `field`) |
| POST `/api/partners` (Add site) | one `create_account` |
| POST `/api/partner/:id/contacts` (Add contact, Add as contact) | one `create_contact` |
| PUT `/api/clients/:k` | one `client_program` |
| PUT `/api/settings`, POST `/api/suggestions/:id`, the freshness check of GET `/api/meta` | **nothing** (D1-only tables) |

How one outcome is written (spec 6.3.3), in one batch, in the old page's order (drawer Save, then Log):

1. `UPDATE partners` of the changed columns plus `updated_at`, `updated_by`, and one `update` row per changed field (`lib/crm.js#updateStatements`, shared with PATCH).
2. `INSERT INTO activity (date, account_id, contact_id, type, by_whom, summary, client)`.
3. `INSERT INTO edits (..., field, ...) VALUES (..., CAST(last_insert_rowid() AS TEXT), ...)`, directly after statement 2, so `edits.field` = the new `activity.n` (checked on wrangler 4.40 local D1; there is no MAX+1 fallback).
4. For Email, Call and Meeting: `UPDATE partners SET last_touch = <today>, updated_at, updated_by`. This has no `edits` row (R3).

POST `/api/partner/:id/activity` runs statements 2–4 in one batch with the same request and response as before.

## 4. D1-only tables the daily run must never drop, recreate or empty

| Table | Migration | What it holds |
|---|---|---|
| `kv_meta` | 003 | Settings overrides (`team`, `clients`, `allow_dnc`, `settings_log`), the freshness signature (`sheet_sig`, `last_sheet_change`), `site_meta_since`, the highest temporary ids handed out (`new_site_n`, `new_contact_n`) |
| `suggestions` | 004 | Suggested contacts, test emails and ownership asks from the daily run; the site marks them used or dismissed |
| `runs` | 004 | One row per scheduled run (`daily`, `discovery`, `digest`) |
| `partner_snap`, `stage_log` | 005 (deferred, Appendix D) | Stage history, when it ships |

None of them is ever copied to the sheet. Migration 003 also adds indexes on `edits` (`edits_account`, `edits_at`, `edits_kind_field`) and `activity` (`activity_account_date`). All migrations are idempotent: `tests/e2e/91-migrations.test.mjs` applies each twice and compares schemas and row counts.

## 5. Daily-run facts

From the stored prompt of `trig_01W5Wr581htK5Xzf1BDrufxq` (these replace the earlier open questions):

- **R1.** Step 0 reads `SELECT * FROM edits WHERE applied=0 ORDER BY n` and maps `update` rows by field to Accounts columns: stage **M**, owner **J**, clients **U**, type **D**, next_step **R**, next_due **S**, deal_model **W**, deal_flat **X**, deal_pct **Y**, deal_value **Z**, content_url **AA**, live_date **AB**, tracking_id **AC**. All 13 EDITABLE fields are covered.
- **R2.** `create_account` appends an Accounts row with the next free PG id, then renames `NEW-` in D1 `partners`, `contacts.account_id`, `activity.account_id` and `edits.account_id` **only**. `create_contact` does the same with C- ids. (Diff (b) adds the D1-only tables to the rename.)
- **R3.** `activity` rows are appended as they are to "Activity log". **The sheet's Last touch (Q) is not updated** by site-logged Email, Call or Meeting. Diff (c) fixes this, so the run's own follow-up list stops naming sites already followed up on the site.
- **R4.** `client_program` is only noted in the run file (no sheet tab yet).
- **R5.** Conflict rule: if a person changed the sheet cell after the edit time and it differs, the sheet value wins and the edit stays `applied=0`. Step 6 then copies the sheet value into D1. The site shows this as **"Not copied – a sheet edit won; check the sheet"**.
- **R6.** Step 6 copies the run's Accounts changes (and rows people edited in the sheet, detected by Last touch) into D1 with `UPDATE` by id, plus new Activity rows. **Contacts are not mirrored**, so `last_email`, `replied` and `outreach_status` can be stale in D1. Diff (f) fixes this.
- **R7.** Step 3 keeps Apollo candidates out of Contacts by design, and step 4 writes test emails to `/mnt/project-files/crm/outreach/<date>-test-run.md`. The site can show them only through `suggestions`, which needs diffs (d) and (e).
- **R8.** "Do not contact" is not mentioned in the prompt. Diff (a) states it is valid. Until then the `allow_dnc` setting stays off.
- **R9.** The run's follow-up rule (no touch 7 days after Contacted) differs from the site's "No reply in 14+ days". This is accepted: the site's list is the work queue, and the run's list is a report.
- **R10.** Edits made directly in the sheet reach D1 only through step 6, the next weekday. Help and Edit history say so.

The exact prompt diffs (a)–(f) and the memory notes are in `crm/docs/daily-run-changes.md` (spec 6.5). They are applied only after Jonas's OK (J3).

## 6. How the site sees the sheet's side (freshness, `lib/freshness.js`)

GET `/api/meta` returns `freshness` from cheap indexed reads: the waiting count and the oldest waiting `at` (waiting = `applied = 0` and `n` above the highest applied `n`; a "Not copied" conflict stays `applied = 0` for good, so it is never counted as waiting), and `stale_pending`, the waiting edits older than `stale_before` (the last expected weekday 08:47 run), which is the N of the "didn't pick up N changes" banner; the highest applied `n`; the newest `activity` row that has no `activity` edit (so it came from the sheet); the newest `PG-` id. The last three form `sheet_sig`. When it changes, the site stores `sheet_sig` and `last_sheet_change = now` in `kv_meta`. That is the only write on a GET, it happens only on change, and never on a read-only host. Once the daily run writes `runs` rows (diff in 6.5), the latest `daily` row is returned too. Before migration 003 exists, `freshness` is `null`.
