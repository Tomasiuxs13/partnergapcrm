# Release runbook: preflight, release and rollback

This is how the new site goes live. Each step says who does it.
"The agent" is the CRM session in the project thread. The source is spec 7.5; this page follows the code as it is now.

Three things need Jonas's own words in the thread before they happen:
- **J3**: "OK" to the prompt changes in `crm/docs/daily-run-changes.md`.
- **J4**: who runs the two database changes, and "OK run migrations".
- **J5**: the word **"merge"**.

Nobody pushes a branch, runs `--remote` or changes Cloudflare before the step that says so.

## Before the preflight: the release candidate

1. **The branch is ready** (agent). `crm-easy-site` has every Group 3 merge.
   - `window.BUILD` in `crm/dashboard/index.html` and `BUILD` in `lib/meta.js` hold the same release name (`easy-rc1` for the first release candidate). If they differ, every page shows "A new version is ready".
   - On that commit, these pass on a local test server (synthetic data, local database only):
     - `node --test tests/unit/`
     - `bash tests/e2e/run.sh` (every e2e file, about 22 minutes)
2. **The preview for Jonas** (whoever may publish to the dashboard artifact). Build the read-only snapshot with `node crm/scripts/build_snapshot.mjs` (see `crm/docs/snapshot.md`). Republish it to the dashboard artifact, so Jonas can click through the new site.
3. **The message to Jonas** (agent). It asks J3, J4, J5, J7, J8 and J9 in at most 15 short lines. It points to `crm/docs/daily-run-changes.md` and `crm/docs/team-announcement.md`.

## Preflight (the afternoon before the release)

**P1. Sign-in works on production** (agent, read-only).
- Run:
  ```
  curl -s -o /dev/null -w "%{http_code}" https://partnergap-crm.pages.dev/login
  ```
  On Windows PowerShell:
  ```
  curl.exe -s -o NUL -w "%{http_code}" https://partnergap-crm.pages.dev/login
  ```
- It must print **200**.
- **503** means the password secret is missing. Then Tomas (or Jonas) opens Tomas's Cloudflare account → Workers & Pages → **partnergap-crm** (the Pages project, not the Worker with the same name) → Settings → Variables and secrets → `DASHBOARD_PASSWORD`. Set it for **Production** and for **Preview**, then redeploy. The preview needs it too, or the release branch's preview shows the 503 page.

**P2. Nothing old is stuck** (agent, read-only).
- The old site's Change log shows no edit waiting for more than 1 day.
- Or ask the database (read-only):
  ```sql
  SELECT COUNT(*) AS waiting, MIN(at) AS oldest
  FROM edits
  WHERE applied = 0 AND n > (SELECT COALESCE(MAX(n), 0) FROM edits WHERE applied = 1);
  ```
  This counts the edits that wait for the morning copy. It leaves out old conflicts (a sheet edit won), which stay unapplied for good.
- If `oldest` is more than 1 day old, tell Jonas before you go on.

**P3. Approvals** in the thread:
- J3: the prompt changes. This may come later; the release goes ahead without it.
- J4: who runs the migrations, and "OK run migrations".
- J5: "merge".

## Release (the evening of the release day)

**1. Migrations, right before the merge** (the person J4 names).
Run `crm/scripts/migrations/003_site_meta.sql`, then `crm/scripts/migrations/004_suggestions_runs.sql`, on the production database `partnergap-crm-partners` (id `ccc497cd-fbac-40c5-b28f-374d2cdecf2f`, in Tomas's Cloudflare account, the one the daily run uses).
- Both files are safe to run more than once. They only add tables and indexes. The old site ignores them.
- Never run `001_base.sql` (test databases only) or `002_site_editing.sql` (already on production; it fails a second time).
- Who runs them, by J4:
  - **(a) Default: the agent**, with the Cloudflare D1 query tool the daily run already uses, after Jonas writes "OK run migrations". Send each file's statements in order, one call per statement if the tool takes one at a time.
  - **(b) Jonas on Windows**, from the repo folder:
    ```
    npx.cmd wrangler d1 execute partnergap-crm-partners --remote --file crm/scripts/migrations/003_site_meta.sql
    npx.cmd wrangler d1 execute partnergap-crm-partners --remote --file crm/scripts/migrations/004_suggestions_runs.sql
    ```
    On a Mac or Linux, use `npx` instead of `npx.cmd`.
  - **(c) Tomas**, with the same commands.
- Then check. This must return 3 rows:
  ```sql
  SELECT name FROM sqlite_master WHERE name IN ('kv_meta','suggestions','runs');
  ```
  And this must return 6 rows:
  ```sql
  SELECT name FROM sqlite_master WHERE type = 'index' AND name IN
    ('edits_account','edits_at','edits_kind_field','activity_account_date','suggestions_account','suggestions_status');
  ```

**2. Push and open the pull request** (agent).
- Push `crm-easy-site` and open the pull request into `main`. Use the prepared description (Before, After, How, tests, migrations, rollback).
- The repo is public. The branch holds no partner data: fixtures are synthetic (`*.example.test`), and `.gitignore` keeps `*.json` out except under `tests/`.
- Cloudflare builds a preview of the branch. The preview is read-only by its address (`functions/_middleware.js`): every change there gets "This copy is read-only.", so clicking it can't change production data.
- If the live code `d5e91d9` (the Monthly report change) is not on `main` yet, this pull request carries it too.

**3. Merge** (agent, only after Jonas writes "merge"). Cloudflare Pages deploys `main` in about 2 minutes.

**4. Checks after the deploy** (agent).
- The `curl` from P1 prints 200 again.
- Signed in, open https://partnergap-crm.pages.dev/api/meta. It shows:
  - `build` = the release name in `crm/dashboard/index.html` (`window.BUILD`);
  - `read_only: false`;
  - `features.settings: true`, `features.suggestions: true` and `features.runs: true` (the migrations are there).
- Signed in, https://partnergap-crm.pages.dev/legacy.html opens the old page.

**5. Smoke test** (agent or Jonas, 5 minutes). Sign in as Jonas or Vik (only they see Settings).
- Sign in and pick your name. Today opens (Vik lands on Team overview).
- Open a site.
- Search (Ctrl K): paste a site's address. The site and its owner show in the first row.
- Help › Settings: change your own "Lands on" to Team overview, then back to Today. Each change says "Saved." These go to the site's own settings only; nothing goes to the sheet.
- **If J3 is applied** (the prompt changes are live): Add site with the address `smoke-test.invalid` and the name "TEST – delete". Open it, then Log what happened › Note. Edit history shows both changes as **Waiting**. The next morning copy discards the site and shows its changes as **Copied** (change (d) in `crm/docs/daily-run-changes.md`).
- **Without J3**: make no change that goes to the sheet. The first real edit of the day is the copy check in step 9.

**6. Apply the prompt changes** (agent, after J3).
- Use `update_trigger` on both routines with the text in `crm/docs/daily-run-changes.md`, and update the two memory notes there.
- Then Jonas turns on "Allow 'Do not contact'" in Help › Settings (J7).

**7. Team announcement** (Jonas posts it himself). The text is in `crm/docs/team-announcement.md`.

**8. Jonas's 5-minute pass** (J8). Team overview › Needs a decision: tick "Waiting on client" where the site suggests it.

**9. The first weekday morning after the release, at 10:00** (agent, read-only).
- Edit history (filter Sheet: Copied) shows the site's edits from the release day as **Copied**.
- The Google Sheet has them.
- The footer says "Sheet data from <today> 08:5x". Without J3 the time is when someone first opened the site after the copy, so a later time is fine. An amber "No sheet update seen yet today" after 10:00 means the copy hasn't run or hasn't reached the site.
- If anything says "Not copied – a sheet edit won", list those changes for Jonas.

**10. Rollback** (agent, after Jonas's OK). See below.

**11. One week later (planned Fri 30 Oct)**, after the Friday digest has used the new builder twice: delete `crm/dashboard/legacy.html` and the old list format of `GET /api/partners` (the call without `?v=2`, in `functions/api/partners.js`), with the tests that pin them (T24 and the old list checks in `tests/e2e/90-api-contract.test.mjs` and `tests/e2e/91-migrations.test.mjs`). That is a separate pull request, with Jonas's OK.

## Second update: deals per client and file links (migration 006)

Tomas's changes of 2026-10-21, released after the steps above, in their own pull request.
1. **Jonas's OK** for migration 006 and prompt insertion 7 (`crm/docs/daily-run-changes.md`).
2. **Migration**: run `crm/scripts/migrations/006_deals_files.sql` on `partnergap-crm-partners` the same way as step 1 (the agent with the D1 query tool, or `npx.cmd wrangler d1 execute partnergap-crm-partners --remote --file crm/scripts/migrations/006_deals_files.sql`). It is safe to run again, and it seeds one deal per site at Negotiating or Active or with deal terms only while `deals` is empty. Check: `SELECT name FROM sqlite_master WHERE name IN ('deals','files')` returns 2 rows, and `SELECT COUNT(*) FROM deals` is above 0.
3. **Sheet**: add the Deals and Files tabs with the headers in `crm/docs/sheet-schema.md`, and copy every seeded deal (`SELECT * FROM deals ORDER BY id`) into Deals.
4. **Prompt**: add insertion 7 to the daily run with `update_trigger`, then read it back.
5. **Merge** after Jonas writes "merge", then open a site with a deal: the record shows Deals and Files, the Deals page shows one row per deal, and `GET /api/deals` answers a list.

To undo: revert the pull request and take insertion 7 out of the prompt. The two tables can stay; the old code ignores them.

## Rollback

Do this only after Jonas says so in the thread.
- **Fastest** (Tomas or Jonas): in Tomas's Cloudflare account → Workers & Pages → partnergap-crm → Deployments, roll back to the production deployment from before the merge. It takes effect at once. Then also revert in git (next point) before anything else is merged, or the next deploy brings the new site back.
- **In git** (agent): revert the merge commit on `main` (`git revert -m 1 <merge commit>`), push it on a branch and open a pull request "Revert the new site". Merge it after Jonas's OK. Pages deploys it in about 2 minutes.
- Nothing else needs undoing:
  - The API stays backward compatible, and `edits` rows are written the same way.
  - The new tables (`kv_meta`, `suggestions`, `runs`) and indexes are harmless to the old site. Leave them.
  - `/legacy.html` keeps working the whole time.
  - The prompt changes work with the old site too.
- One difference after a rollback: the old code numbers a new site as the highest `NEW-` number + 1 again. After the morning copy renames a site, its old `NEW-` number can come back.

## Ops task (only after an explicit OK on J2 (b) or (c))

The agent moves the chosen Replied rows in one pass:
- In the sheet: one batched update of column M (Stage).
- In the database: `UPDATE partners SET stage = ? WHERE id IN (...)`, in chunks of 90 ids.
- No `edits` rows, so the morning copy doesn't apply them again.
- Post the counts before and after in the thread.
