# PartnerGap affiliate CRM: workflow and master sheet proposal

Based on Jonas's sketch (2026-09-29).

## Connector status

| Tool | Role in the flow | Status in this project |
|---|---|---|
| Ahrefs | Keyword competitors → affiliate domains | Connected |
| Apollo | Find contacts, create accounts/contacts | Connected |
| Slack | Ask the owner of an existing contact | Connected |
| Gmail (PG Gmail) | Claim-contact emails, 1:1 follow-ups | Connected |
| Google Drive | Create the master sheet file | Connected |
| Google Sheets | Read/write rows in the master sheet | Not connected (card posted in thread) |
| Affiliate Finder (AF) | Keyword competitors, affiliate contacts | No connector in the directory |
| Everflow | Partner/affiliate records, managers | No directory connector; add as custom connector with its MCP URL |
| Smartlead | Email outreach campaigns | No directory connector; needs a custom connector or API key |

Until Smartlead is connected, outreach can run as Gmail drafts or Apollo sequences.
Until AF is connected, AF exports (CSV) can be dropped into the project and imported.

## Workflow

1. **Discover.** Enter a seed keyword or brand. Ahrefs pulls organic competitors and pages ranking for it; AF export (or connector later) adds affiliate sites. Output: candidate domains, de-duplicated by root domain.
2. **Check the CRM.** For each domain, look it up in the master sheet (and Everflow once connected).
   - **Exists with an owner:** draft a Slack DM to the owner asking for status/intel. Sent only after Jonas approves.
   - **Exists, no owner:** mark `Claimed by` = requester, draft a claim email (Gmail) for approval.
   - **New:** go to step 3.
3. **Enrich.** Apollo people search on the domain (titles: affiliate/partnerships/founder/editor), fall back to AF. Store best contact + email confidence.
4. **Create account.** After approval: create the account (Apollo, and Everflow partner when connected), set the manager/owner, write IDs back to the sheet.
5. **Outreach.** Push approved contacts into a Smartlead campaign (or Apollo sequence / Gmail drafts until then). Status syncs back to the sheet.

Every step that sends a message or writes to Apollo/Everflow/Slack waits for a human OK.

## Master sheet structure

**Tab 1: Accounts** (one row per affiliate domain)

| Column | Notes |
|---|---|
| Account ID | PG-0001 |
| Domain | root domain, the dedupe key |
| Brand / site name | |
| Affiliate type | content, coupon, review, influencer, network, loyalty |
| Vertical / niche | |
| Source | Ahrefs, AF, manual, referral |
| Seed keyword | keyword that surfaced it |
| DR / organic traffic | from Ahrefs |
| Owner (PG manager) | blank = unowned |
| Claimed by / date | |
| Stage | New, Researching, Contacted, Replied, Negotiating, Active, Lost, Do not contact |
| Everflow partner ID | |
| Apollo account ID | |
| Brands promoted / competitors they work with | |
| Last touch date | |
| Next step / due | |
| Notes | |

**Tab 2: Contacts** (many per account)

Contact ID, Account ID, Domain, First name, Last name, Title, Email, Email status (verified/guessed), LinkedIn, Source (Apollo/AF), Apollo contact ID, Primary (Y/N), Outreach status, Smartlead campaign, Last email date, Replied (Y/N).

**Tab 3: Activity log**

Date, Account ID, Contact ID, Type (Slack ask, claim email, outreach, reply, call, note), By, Summary, Link.

**Tab 4: Keyword runs**

Date, Seed keyword, Tool, Domains found, New, Already in CRM, Run by.

**Tab 5: Lists** (dropdown values): Stages, Affiliate types, Owners, Sources.

## Agency setup (added 2026-09-29)

PartnerGap is an affiliate marketing agency, so the sheet now has a **Clients** tab (client, website, vertical, Everflow offer ID, seed keywords, competitor domains, account manager, active) and a Client column on Contacts, Activity log and Keyword runs, plus "Clients pitched" on Accounts. One affiliate domain stays one Account row even when it is pitched for several clients.

## Automation plan

Scheduled routines run on their own and write only to the master sheet. Anything that leaves PartnerGap (emails, Slack messages to colleagues, Apollo credit spend, Everflow writes) waits in a review queue unless Jonas turns that gate off.

| Routine | When | What it does automatically | Gate |
|---|---|---|---|
| Discovery run | Weekly, Monday morning | For every active client: Ahrefs organic competitors and pages ranking for the seed keywords and competitor domains. New root domains go into Accounts (Stage New, Source Ahrefs, Clients pitched). Run logged in Keyword runs. affiliatefinder.ai added once connected. | None (sheet only) |
| Dedupe and ownership check | Daily | Flags domains already in the sheet (and Everflow once connected). Owned: drafts a Slack DM to the owner. Unowned: proposes a claim. | Slack DM to a colleague needs approval |
| Contact enrichment | Daily | Apollo people search on new domains (partnerships, affiliate, founder, editor titles) into Contacts. | Email reveals spend Apollo credits: daily cap, approval above it |
| Outreach prep | Daily | Personalised first email per new contact, per client, staged as Gmail drafts or an Apollo sequence (Smartlead once connected). | Sending needs approval (one batch click) |
| Reply and bounce sync | Daily | Reads replies/bounces from Gmail (and Smartlead later), updates Outreach status, Replied, Stage, Last touch, Activity log. | None (sheet only) |
| Follow-up nudges | Daily | Accounts with Next step due today or no touch in 7 days get listed for the owner. | Slack reminder needs approval |
| Pipeline digest | Weekly, Friday | Summary per client: new affiliates, contacted, replies, active partners. Posted in this project. | None |

Once Everflow is connected: when a partner reaches Active, create the partner and assign the manager in Everflow (approval), and pull partner performance into the digest.
