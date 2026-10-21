# How to use the CRM site

https://partnergap-crm.pages.dev · Sign in with the team password and pick your name. Your changes are signed with that name. To change it, click "change" next to your name at the bottom of the sidebar.

## The pages

- **Today**: what needs you now. It shows only your sites.
  - **Do now**: replies to answer, follow-ups that are due, deals that need your decision. A chip on each row says why ("Replied 2d ago", "Overdue 3d").
  - **New prospects: find a contact**: your new sites. Add a contact right in the row.
  - **Coming up**: your follow-ups for later days.
  - **Start** opens the first site. After each one, the next one opens.
- **Sites**: every site. Tabs: Mine to contact, Unowned, Waiting for reply (with "No reply in 14+ days") and All. Filter, sort, Export CSV, or tick rows to change many at once (with Undo).
- **Deals**: Negotiating, Signed (not live), Live, and Lost in the last 30 days, with the terms and the total value.
- **Clients**: one row per client. A client page has its numbers, deals, live placements, the affiliate program and a monthly **Report** (Copy as email, Print).
- **Team overview**: deals that need a decision, what is stuck, a table per person, the morning run, data clean-up and charts.
- **Help**: how the CRM works, the stages, the shortcuts, who manages which client and "Report a problem". Jonas and Vik also see **Settings** (team, clients).
- **Edit history**: every change made on the site and whether it reached the Google Sheet. Open it from the sync line at the bottom of the sidebar.

On top of every page:
- **Search** finds a site from a pasted link, an email, a contact name or an ID, and shows who owns it.
- **+ Add site** checks for a duplicate first and shows its owner.

Click a site to open its panel. There you can:
- **Log what happened**: one click saves an outcome, such as "They replied" or "Interested", and proposes the next follow-up.
- **Follow up**: pick a date.
- See and add contacts, the timeline and the deal terms.

On a phone, the tabs are at the bottom: Today, Sites, Deals, Search and More. More holds the other pages and Sign out.

## The five keyboard keys

| Key | What it does |
|---|---|
| Ctrl K (Cmd K on a Mac) or `/` | Search |
| `n` | Add site |
| Enter | Open the site in the row you are on |
| Esc | Close the menu, search, window or site panel |
| J / K | Next or previous site, after Start |

They don't work while you type in a field, except Esc and Ctrl K.

## How your changes reach the Google Sheet

- Every change saves on the site at once.
- Each weekday morning at 08:47 (Vilnius time), the morning copy puts the site's changes into the Google Sheet.
- The sidebar shows how many are waiting, for example "All saved · 3 changes copy to the Google Sheet tomorrow at 08:47".
- Edit history shows each change as:
  - **Waiting**: it goes to the sheet on the next weekday morning.
  - **Copied**: it is in the sheet.
  - **Not copied – a sheet edit won; check the sheet**: someone changed the same cell in the sheet later, and the sheet's value stays.
- Changes made directly in the Google Sheet show on the site the next weekday morning.
- A site you add gets a temporary `NEW-` number. The morning copy gives it its `PG-` number.
- If the morning copy missed some changes, an amber line at the top says so. Your changes are still saved. If it is still there the next day, tell Jonas.

## Test mode

Outreach is in test mode. The "● Test mode" badge at the top is always on.
- Nothing is sent from the site: no email, no Slack message.
- "Ask <owner> (copy message)" copies a message for you to send yourself.
- Suggested emails from the morning run are drafts to copy.

Preview links and the dashboard snapshot are read-only copies. They say so at the top, and nothing can be changed there.
