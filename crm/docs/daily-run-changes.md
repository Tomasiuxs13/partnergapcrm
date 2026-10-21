# Prompt changes for the daily run and the Friday digest

The new site needs a few more lines in two scheduled routines:
- **CRM daily run** (`trig_01W5Wr581htK5Xzf1BDrufxq`, weekdays 08:47 Vilnius): the morning copy to the Google Sheet.
- **CRM Friday digest** (`trig_01BTBs3esEf39BXnJVtwoe9c`, Fridays 15:51 Vilnius).

Nothing here is applied before Jonas says OK (J3). The agent applies it in release step 6 (`crm/docs/release.md`).
The source is spec 6.5. Every line was checked against the code on `crm-easy-site`. Where the code needed a different word, the change is listed under "Differences from spec 6.5" at the end.

## How to apply

1. Read both routines with `get_trigger`. Save each prompt as it is now in the run file or the thread, so it can be put back.
2. Check that every place named below is in the prompt word for word. If one is missing, stop and ask Jonas.
3. Fill in the two values in braces:
   - `{RELEASE_DATE}`: the day of the merge, as YYYY-MM-DD.
   - `{ARTIFACT_URL}`: the dashboard artifact link that is in the digest prompt now. It doesn't change.

   Everything in `<angle brackets>` stays as it is. The routines fill those in themselves on each run.
4. Insert or replace the text below. Keep every other word of the prompt, the schedule and the connectors as they are.
5. Save with `update_trigger`. Read the routine again with `get_trigger` and compare.
6. Update the two memory notes (below).
7. Then Jonas turns on "Allow 'Do not contact'" in Help › Settings (J7).

**To undo**: `update_trigger` with the saved prompt. The database tables stay; they are harmless.

## Daily run (`trig_01W5Wr581htK5Xzf1BDrufxq`)

Six insertions. The rest of the prompt stays word for word.

**1. At the end of step 0** (after its last sentence, right before "1. Reply and bounce sync"), add:

> Rules for the new site ({RELEASE_DATE}): (a) Stage "Do not contact" is valid; write it to M as-is. (b) When you rename a NEW-/NEWC- id, also rename it in these D1-only tables when they exist: UPDATE suggestions SET account_id=? WHERE account_id=?; UPDATE partner_snap SET id=? WHERE id=?; UPDATE stage_log SET account_id=? WHERE account_id=?. (c) For an activity edit of type Email, Call or Meeting, also set Accounts!Q (Last touch) to the activity date when it is later than the cell. (d) A site whose domain ends in ".invalid" is a smoke test: mark its edits applied=1 without touching the sheet, then delete its D1 rows (partners, contacts, activity with that account_id). (e) Never drop, recreate or empty the D1-only tables kv_meta, suggestions, runs, partner_snap, stage_log. Leave an edit at applied=0 only when it is a conflict. If an edit can't be applied for any other reason, stop applying edits there and say so in the review, so that edit and every later one stay waiting: the site shows an unapplied edit that is older than an applied one as "Not copied – a sheet edit won".

**2. At the end of step 2** (right before "3. Enrichment"), add:

> Also INSERT OR IGNORE one D1 suggestions row per ask: id '<date>:slack_ask:<account_id>', run_date, kind 'slack_ask', account_id, client, note = the message. Skip an account that already has an open slack_ask row.

**3. At the end of step 3** (right before "4. Outreach prep"), add:

> Also INSERT OR IGNORE one D1 suggestions row per candidate: id '<date>:candidate:<account_id>:<k>', run_date, kind 'candidate', account_id, client, name, title, linkedin, source 'Apollo'. Never an email. Skip an account that already has an open candidate row.

**4. At the end of step 4** (right before "5. Follow-ups"), add:

> Also INSERT OR IGNORE one D1 suggestions row per test email: id '<date>:email:<account_id>:<k>', run_date, kind 'email', account_id, client, name, subject, body; set to_email only if the address is already in Contacts. Skip an account that already has an open email row.

**5. At the end of step 6** (after its last sentence), add:

> (f) Also copy the Contacts changes this run made (Outreach status, Replied, Email status, Last email date) into D1 contacts with UPDATE by id, and new Contacts rows with INSERT OR IGNORE. Emails are allowed in D1 contacts, never in partners or activity.

**6. Right before "Then post ONE short review"**, add:

> Finally INSERT INTO runs (name, started_at, finished_at, status, summary) VALUES ('daily', <start ISO>, <end ISO>, 'ok' or 'error', <JSON counts: edits_applied, conflicts, replies, bounces, candidates, emails, slack_asks>). When the status is 'error', also put "error": "<one short sentence on what went wrong>" in that JSON.

**7. Deals and files** (only together with migration 006, after Jonas's OK; `{DEALS_DATE}` = the day 006 runs). Right after insertion 1, add:

> Deals and files ({DEALS_DATE}): the sheet has a Deals tab (A Deal ID, B Account ID, C Client, D Stage, E Owner, F Deal model, G Flat fee, H Commission %, I Deal value, J Content URL, K Live date, L Tracking ID, M Next step, N Next due, O Notes, P Created) and a Files tab (A File n, B Account ID, C Deal ID, D Name, E Type, F Link, G Added, H Added by). Copy these edits in n order with the same conflict rule: create_deal appends a Deals row from the JSON in new with the next free D- id (D-nnnnn), then renames the NEWD- id in D1 deals.id, files.deal_id, edits.field of create_deal rows and the "NEWD-n." prefix of deal_update fields; deal_update (field "<deal id>.<column>") sets that deal's cell (client C, stage D, owner E, deal_model F, deal_flat G, deal_pct H, deal_value I, content_url J, live_date K, tracking_id L, next_step M, next_due N, notes O); create_file appends a Files row with A = field. When you rename a NEW- site id, also rename it in deals.account_id and files.account_id. Never drop, recreate or empty the D1 tables deals and files.

## Friday digest (`trig_01BTBs3esEf39BXnJVtwoe9c`)

Replace the sentence that starts "Then refresh the CRM dashboard artifact" (it ends "and republish it to the same URL.") with:

> Then refresh the CRM dashboard artifact ({ARTIFACT_URL}) from the website code on main: dump Accounts!A1:AC, Contacts!A1:Q and 'Activity log'!A1:H with the Sheets connector, by rows and saved as the connector returns them ({range, values}), to <scratchpad>/accounts.json, <scratchpad>/contacts.json and <scratchpad>/activity-log.json. In the repo on main (if the checkout is on another branch: git fetch origin main, then git worktree add <scratchpad>/crm-main origin/main and work there), run `node crm/scripts/build_snapshot.mjs --rows <scratchpad>/accounts.json --contacts-sheet <scratchpad>/contacts.json --activity-sheet <scratchpad>/activity-log.json --out <scratchpad>/crm-snapshot.html`, read its one-line summary once, and republish the file to the same URL. The builder refuses any page that contains an email address; never work around that (no --redact-emails): if it refuses, keep the old artifact and say why in the reply. If the D1 table runs exists, add the week's daily runs (count, errors) to the digest.

The two sentences after it stay: "Contact emails never go on the dashboard. Read only apart from the reply and the dashboard."

## Memory notes (updated in the same step)

**`crm-routines`**: replace the line that starts "Friday refresh: rebuild with scratchpad hub_art.py pattern" with:

> Friday refresh: dump Accounts!A1:AC, Contacts!A1:Q and 'Activity log'!A1:H with the Sheets connector, run `node crm/scripts/build_snapshot.mjs --rows <accounts dump> --contacts-sheet <contacts dump> --activity-sheet <activity log dump> --out <file>` from the code on main, then republish to the same artifact URL (since {RELEASE_DATE}). Docs: crm/docs/snapshot.md.

**`crm-site-editing`**: add this paragraph:

> New site (since {RELEASE_DATE}): Today, Sites, Deals, Clients, Team overview and Help; Edit history opens from the footer. Every change still goes through the D1 table edits with the same kinds and columns (crm/docs/edits-contract.md). D1-only tables, never copied to the sheet and never dropped, recreated or emptied: kv_meta (Settings for team, clients and allow_dnc; the freshness check; the highest NEW-/NEWC- numbers handed out, so a number is never used twice), suggestions (the daily run writes them; the site marks them used or dismissed) and runs (one row per daily run). "Waiting on client" is the next_step prefix "Waiting on client: ". "Do not contact" is a valid stage once Jonas turns on the Settings switch (J7). Sites on ".invalid" domains are smoke tests; the daily run discards them. Branch previews (*.partnergap-crm.pages.dev) are read-only. /legacy.html (the old page) stays until the Friday digest has used the new builder twice.

## What the site does with these rows (checked against the code)

| Topic | What the code does | What the prompt text needs |
|---|---|---|
| Sheet state in Edit history (`functions/api/edits.js`, `lib/freshness.js`) | **Copied** = `applied = 1`. **Waiting** = `applied = 0` and newer than the newest applied edit. **Not copied – a sheet edit won** = `applied = 0` and older than an applied edit. The footer's waiting count and the amber banner count only Waiting. | Only a conflict may stay unapplied behind an applied edit. Hence the last sentence of insertion 1. |
| Morning copy banner and footer (`crm/dashboard/js/shell/shell.js`) | The newest `runs` row named `daily`: status `error` shows "This morning's copy to the Google Sheet stopped with an error". Its `finished_at` is the footer's "Sheet data from …". Without `runs` rows, the footer uses the time the site first saw the sheet change. | Insertion 6, with `status` 'ok' or 'error'. |
| Team overview's morning run card (`crm/dashboard/js/pages/team.js`) | Reads `summary.edits_applied`, `replies`, `candidates`, and `error` when the run failed. Email addresses in `summary` are hidden. | Insertion 6 names these keys; the `error` key is added. |
| Temporary ids (`lib/crm.js#nextTempId`) | A new site gets `NEW-` + 1 more than the highest number ever handed out (kv_meta `new_site_n`, or the table if that is higher); the same for contacts with `NEWC-` and `new_contact_n`. Numbers keep growing after the morning copy renames a site: after `NEW-0012` is renamed, the next one is `NEW-0013`. Four digits, then five after `NEW-9999`. | Rename as now, plus `suggestions` (rule (b)). Never reset kv_meta (rule (e)). Don't expect numbers to restart at `NEW-0001`. |
| Suggestions (`functions/api/suggestions.js`, `crm/dashboard/js/features/record/suggestions.js`, `crm/dashboard/js/pages/today.js`, `crm/dashboard/js/rules/team.js`) | Kinds `candidate`, `email`, `slack_ask`; status `open`, `used`, `dismissed`. The site shows **every open row**: two open candidate rows for one site show twice in its panel and count twice on Team overview. `to_email` shows only in the site's panel, never in lists. | Insertions 2–4, each with "Skip an account that already has an open … row". |
| Waiting on client (spec D2) | A tick writes the `next_step` prefix "Waiting on client: " as an ordinary `update` row. | Nothing new: R copies it as text. |
| "Do not contact" (`lib/meta.js` `DNC_STAGE`) | Accepted only while kv_meta `allow_dnc` is "1" (the Settings switch). | Rule (a) first, then J7. |
| Last touch | The site sets D1 `last_touch` to today for Email, Call and Meeting. | Rule (c) copies it to Accounts!Q. |
| Smoke test | Add site accepts `smoke-test.invalid` (checked on a local test server). | Rule (d). |
| Snapshot from the sheet (`crm/scripts/build_snapshot.mjs`, `crm/scripts/snapshot/sheet.mjs`) | With all three dumps, the rows equal what the site serves after an import of the same sheet. With Accounts only, every site has 0 contacts and no reply date from email, so most replies drop out of Do now. It reads `{range, values}` by rows and refuses a dump by columns. | The digest text names all three dumps. |

## Differences from spec 6.5

Each one goes to Jonas with J3.
1. **Insertion 1** adds one rule after (e): only a conflict may stay unapplied. Without it, an edit that failed for another reason would show as "Not copied – a sheet edit won".
2. **Insertions 2–4** add "Skip an account that already has an open … row". The run picks the same sites each day (the highest-DR New sites with no contact), and each day's ids are new, so without this the same suggestion would show again every day.
3. **Insertion 6** adds the `error` key, which the morning run card shows.
4. **Friday digest**: three dumps instead of Accounts only (G3-6b), dumped by rows; how to run from `main` when the checkout is on another branch; no `--redact-emails` (the builder now has that flag); keep the old artifact when the builder refuses.
5. **`crm-routines`** uses the three-dump command.
6. The date and the artifact link are fill-ins (`{RELEASE_DATE}`, `{ARTIFACT_URL}`), because the release day may move, and the link stays out of this public repo.
7. Spec 6.4 R7 calls the step 3 and step 4 additions "diffs (d) and (e)". Here they are insertions 3 and 4. The letters (a)–(f) are only the ones inside the quoted text.
