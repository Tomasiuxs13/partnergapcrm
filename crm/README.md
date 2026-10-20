# PartnerGap affiliate CRM

The CRM data lives in the Google Sheet **PartnerGap Affiliate CRM**:
https://docs.google.com/spreadsheets/d/1llDAVFowJ1tHVXCTRc2Upos1FXndl2Iit3mfAOhp05I/edit

This folder holds the plan, the sheet layout, the website and the scripts used to fill it. Contact data (emails, names) is not stored in git.

## The website (https://partnergap-crm.pages.dev)

- `docs/site-guide.md`: how to use the site, for the team (one page)
- `docs/team-announcement.md`: the text Jonas posts when the new site goes live
- `docs/release.md`: preflight, release steps and rollback
- `docs/daily-run-changes.md`: the changes to the daily run and the Friday digest prompts, applied after Jonas's OK
- `docs/edits-contract.md`: how site changes reach the sheet (the frozen `edits` table rules)
- `docs/snapshot.md`: the read-only one-file copy of the site (`scripts/build_snapshot.mjs`)
- `dashboard/`: the site itself (static files, no build step); `dashboard/legacy.html` is the old page
- `scripts/migrations/`: database changes (`003_site_meta.sql` and `004_suggestions_runs.sql` run at release)

## The sheet and the scripts

- `docs/workflow.md`: workflow, connectors and the automation plan
- `docs/sheet-schema.md`: tabs, columns, dropdown lists and ID ranges
- `docs/automation.md`: what runs on its own and what waits for approval
- `scripts/build_gmail_index.py`: builds an index of sent, replied and bounced addresses from Gmail thread exports
- `scripts/gmail_to_crm.py`: turns that index into new Accounts and Contacts rows
- `scripts/build_d1_import.py`: turns sheet dumps into a full import for the site's database
