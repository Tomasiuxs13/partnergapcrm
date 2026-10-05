# PartnerGap affiliate CRM

The CRM data lives in the Google Sheet **PartnerGap Affiliate CRM**:
https://docs.google.com/spreadsheets/d/1llDAVFowJ1tHVXCTRc2Upos1FXndl2Iit3mfAOhp05I/edit

This folder holds the plan, the sheet layout and the scripts used to fill it. Contact data (emails, names) is not stored in git.

- `docs/workflow.md`: workflow, connectors and the automation plan
- `docs/sheet-schema.md`: tabs, columns, dropdown lists and ID ranges
- `docs/automation.md`: what runs on its own and what waits for approval
- `scripts/build_gmail_index.py`: builds an index of sent, replied and bounced addresses from Gmail thread exports
- `scripts/gmail_to_crm.py`: turns that index into new Accounts and Contacts rows
- `dashboard/index.html`: pipeline dashboard page (static snapshot, ready for Cloudflare Pages)
