# Team announcement

Jonas posts this himself, after the smoke test (release step 7 in `crm/docs/release.md`).
Copy the text between the lines. In Slack, bold is one star on each side (`*Today*`).

---

The CRM has a new, simpler layout: https://partnergap-crm.pages.dev
• Sign in with the usual password (ask me if you don't have it) and pick your name.
• **Today** shows what needs you: replies, follow-ups and new prospects. One click logs what happened.
• **Search** (Ctrl K) finds any site from a pasted link, email or name, and shows who owns it.
• **Sites, Deals and Clients** replace Prospecting, Partners, Tasks and Campaigns. "See what moved" on Today explains the rest.
Old bookmarks still work. Your changes copy to the Google Sheet each weekday morning, and nothing is emailed from the CRM (test mode).

---

Every line matches the site as built:
- The sign-in page asks for the password and "Your name" (or "Someone else"), and says "Don't know the password? Ask Jonas."
- Today's one-time banner says "The CRM has a new layout. See what moved". It opens the What's new list of where each old page went.
- Old links such as `#prospecting`, `#partners`, `#tasks` and `#campaigns` open the matching new page.
- The "● Test mode" badge sits in the top bar. Nothing is sent from the site.
- A short guide for the team is in `crm/docs/site-guide.md`.
