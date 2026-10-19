# Golden `edits` rows (the frozen sheet contract)

These files are the executable definition of the `edits` contract (spec 1.3, 6.4). They hold what the live code wrote for every write path, so the redesign can prove it writes exactly the same rows.

## How they were captured

- **Code:** commit `d5e91d9` ("Add a monthly report to each client page"), the live site's code, checked out clean at `/home/claude/wt/golden-src`. Each file records `captured_commit`.
- **Data:** the synthetic fixture `tests/fixtures/make-seed.mjs` v1 (only `*.example.test`; no partner data) on a local D1 built from `crm/scripts/migrations/001_base.sql`. 003/004 were not applied, as in production at `d5e91d9`.
- **Server:** this repo's harness (`tests/e2e/lib.mjs` `startServer`): a free port, its own inspector port, a fresh `mktemp -d` persist dir, `wrangler pages dev` 4.40 with `DASHBOARD_PASSWORD=testpass`. Local D1 only.
- **Command:**

  ```
  node tests/e2e/golden/capture.mjs --root /home/claude/wt/golden-src
  ```

  The script refuses a checkout with local changes. It signs in, then for each case it puts the target rows into a fixed state, notes `MAX(edits.n)`, sends the request, and reads the new `edits` rows. It drops `n` and `at` and replaces run-dependent values with tokens.
- **Check:** every case was then replayed with `replayCase()` on a fresh server running `d5e91d9`. All six files passed.

## Files (one per write path)

| File | Write path | `kind` | Cases |
|---|---|---|---|
| `patch-partner.json` | `PATCH /api/partner/:id` | `update` | interested, deal-terms, lost-clears-next, assign-owner-clients-type, waiting-on-client, clear-owner-and-type, no-change, ignores-non-editable, 3 errors |
| `activity-log.json` | `POST /api/partner/:id/activity` | `activity` | interested, note-with-contact, deal-update-no-client, content-live, call-sets-last-touch, 3 errors |
| `bulk-update.json` | `POST /api/bulk` | `update` | owner-and-stage, add-client, next-due, nothing-changes, 3 errors |
| `add-site.json` | `POST /api/partners` | `create_account` | full, name-only, duplicate (409), duplicate-forced, 2 errors |
| `add-contact.json` | `POST /api/partner/:id/contacts` | `create_contact` | full, name-only, duplicate (409), duplicate-forced, 4 errors |
| `client-program.json` | `PUT /api/clients/:k` | `client_program` | soro-full, partial, key-with-space-d5e91d9-bug, 3 errors |

Each case has these fields:

- `name` and `about`.
- `before`: the 13 EDITABLE columns plus `last_touch` of every partners row the request touches, as they were just before it.
- `request`: `{method, url, body}`.
- `status`.
- `response`: the body.
- `edits`: the new rows in `n` order, keeping `by_whom, kind, account_id, contact_id, field, old, new, applied`.

`by` is always `"Kamile"`.

## Tokens

Values that depend on the run are replaced by tokens. One token name has one value across a whole case, so the activity row's `field` must equal the response's `activity.n`.

| Token | Matches | Where |
|---|---|---|
| `{{today}}` | the server's UTC date `YYYY-MM-DD` | `"date"` in activity JSON, `"added"` in create_account JSON, `last_touch` and `activity.date` in responses |
| `{{activity_n}}` | the new `activity.n` | `edits.field` of the activity row, `response.activity.n` |
| `{{new_account_id}}` | `NEW-nnnn` | `account_id` of create_account, `response.row[0]` |
| `{{new_contact_id}}` | `NEWC-nnnn` | `contact_id` of create_contact, `response.contact.id` |
| `{{at}}` | `YYYY-MM-DDTHH:MM:SSZ` | `updated_at` in responses only (edits rows drop `at`) |

Everything else is literal. **JSON in `edits.new` is compared as a string**, so its key order is part of the contract:

- create_account: `domain, name, stage, owner, clients, type, next_step, next_due, notes, added`
- create_contact: `first_name, last_name, title, email, linkedin, client`
- activity: `date, type, summary, client`
- client_program: `network, commission, payout_terms, signup_url, brief, cookie_days`

Mixed `""` and `null` values in these JSON strings are also part of the contract. For example, Add contact writes `"last_name":""` but `"title":null`. Numbers in `update` rows are text: `"1200"`, `"12.5"`, `"2500.55"`.

## Row order

- `update` rows follow the order of the keys in the request's `fields`. Every golden request lists fields in EDITABLE order (`stage, owner, clients, type, next_step, next_due, deal_model, deal_flat, deal_pct, deal_value, content_url, live_date, tracking_id`). An implementation that walks EDITABLE therefore writes the same order.
- `bulk-update.json` has `row_order: "any"`. `d5e91d9` writes per site, but the new ids mode (6.3.4) writes per field. Compare bulk rows after `sortEdits()` (by `account_id`, then `field`).
- **Outcome (6.3.3)** = the PATCH rows, then the activity row. For **Interested**, the expected rows are `patch-partner.json#interested` `edits` followed by `activity-log.json#interested` `edits`, on the same site (`PG-00577`). Use `before` from `patch-partner#interested`. The request is `{by, fields: <patch body.fields>, activity: {type, summary, client} of activity-log#interested}`.

## Known differences that are not in these files (by design)

- **Bulk add-client on a slash value.** `d5e91d9` rewrites `MailerLite/MailerSend` to `MailerLite, MailerSend, Soro`. The redesign keeps stored tokens (`MailerLite/MailerSend, Soro`, T12, spec 6.3.4). `add-client` therefore uses values with no slash, where both behaviours agree.
- **Bulk `next_step`/`type` and `only_if_empty`.** These are new in the ids mode and do not exist on `d5e91d9`.
- **Contact duplicate check.** `d5e91d9` uses a substring `LIKE`, so `ann@x…` matches `joann@x…`. The redesign uses an exact match (6.3.10). The written row is the same either way. Only the 409 case with an exact duplicate is captured.
- **Client keys with a space** (`key-with-space-d5e91d9-bug`). `d5e91d9` answers `PUT /api/clients/botanical%20synthesis` with 400 "Unknown client.": the route gets the raw `%20` in `params.k` (seen on wrangler 4.40 local), and the old page sends `encodeURIComponent(k)`. So no program with a space in its key can be saved today. T23 expects the redesign to decode the key. The row it must then write is `client-program.json#partial` with `field` = `"botanical synthesis"`.

## Using them in a test

```js
import { loadGolden, replayCase, goldenCase, assertGolden, applyBefore, editsAfter, maxEditN, stripEdit } from "./lib.mjs";

// Replay every case of a file on the run's server (B1, T22):
const g = loadGolden("patch-partner");
for (const c of g.cases) {
  const r = await replayCase(c, { order: g.row_order });
  assert.ok(r.ok, c.name + "\n" + r.errors.join("\n"));
}

// Compare rows a UI action wrote (T3: Interested on PG-00577):
const patch = goldenCase("patch-partner", "interested"), act = goldenCase("activity-log", "interested");
await applyBefore(patch.before);                       // PG-00577: Replied, "Answer their reply", no date
const n0 = await maxEditN();
// ... with the page clock fixed to Fri 2026-10-30, click Interested and type the note "Wants the media kit." ...
const rows = (await editsAfter(n0)).map(stripEdit);
assertGolden([...patch.edits, ...act.edits], rows);   // 3 update rows, then the activity row
```

The Interested case was chosen to line up with Appendix A: stage Negotiating, next step "Agree terms", +3 working days (2026-11-04 when today is Fri 2026-10-30), and the activity Email "Interested. {note}" with the site's first client (Soro).

These rows are a contract with the daily run (spec 6.4). Do not re-capture them from new code. A change to them needs a matching change to the daily-run prompt in the same release.
