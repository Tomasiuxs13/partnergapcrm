# Sheet schema

All tabs have a frozen header row (dark blue fill, white bold text).

## Clients
A Client, B Website, C Vertical, D Target country, E Time zone, F Everflow offer ID, G Seed keywords, H Competitor domains, I Account manager, J Active (checkbox), K Notes

## Accounts (one row per affiliate domain)
A Account ID (PG-00001…), B Domain (dedupe key, duplicates highlighted red), C Brand / site name, D Affiliate type, E Vertical, F Source, G Seed keyword, H Domain rating, I Organic traffic, J Owner, K Claimed by, L Claimed date, M Stage, N Everflow partner ID, O Apollo account ID, P Brands promoted, Q Last touch, R Next step, S Next step due, T Notes, U Clients pitched, V Top traffic country

## Contacts (many per account)
A Contact ID (C-00001…), B Account ID (dropdown), C Domain (formula, do not overwrite), D First name, E Last name, F Title, G Email (duplicates highlighted red), H Email status, I LinkedIn URL, J Source, K Apollo contact ID, L Primary contact, M Outreach status, N Smartlead campaign, O Last email date, P Replied, Q Client

C2 formula:
```
=ARRAYFORMULA(IF(LEN(B2:B), IFERROR(VLOOKUP(B2:B, Accounts!A:B, 2, FALSE), "Account not found"), ))
```

## Activity log
Date, Account ID, Contact ID, Type, By, Summary, Link, Client

## Keyword runs
Date, Seed keyword, Tool, Domains found, New domains, Already in CRM, Run by, Client

## Lists (dropdown sources)
- Stage: New, Researching, Contacted, Replied, Negotiating, Active, Lost, Do not contact
- Affiliate type: Media / Publisher, Coupon / Deals, Review, Influencer / Social, Affiliate Network, Loyalty / Rewards, Marketplace Partner, Web Hosting, Email Marketing, WP / Web Platform, Tech / SaaS, Agency, Other, Uncategorized
- Source: Ahrefs, affiliatefinder.ai, Apollo, Manual, Referral, Past work (import), Gmail outreach
- Owner: Jonas, Jay, Tomas, Gaby, Eivyda, Vik, Sandra
- Outreach status: Not started, Queued, In sequence, Replied, Bounced, Unsubscribed, Sent
- Email status: Verified, Guessed, Unknown, Delivered, Bounced
- Activity type: Slack ask, Claim email, Outreach email, Reply, Call, Note
- Discovery tool: Ahrefs, affiliatefinder.ai

## Data loaded (2026-09-29)
- PG-00001 to PG-04358 and C-00001 to C-02719: past partners from "PartnerGap - Master Partner List (Compiled)". DR, traffic and top country from Ahrefs for 2,578 domains.
- PG-04359 to PG-07277 and C-02720 to C-06014: addresses from Jonas's Gmail outreach (Source "Gmail outreach").
- Next free IDs: PG-07278 and C-06015.
