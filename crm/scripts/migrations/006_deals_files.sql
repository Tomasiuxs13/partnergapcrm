-- Several deals per site, one per client, and files (links to contracts, price lists, briefs) on a site
-- or a deal. Tomas asked for both on 2026-10-21. Safe to run more than once. On production it runs after
-- Jonas's OK, together with the daily-run prompt change that copies create_deal, deal_update and
-- create_file edits into the sheet's Deals and Files tabs (crm/docs/daily-run-changes.md).
-- (005 stays reserved for the deferred stage history, crm/docs/edits-contract.md section 4.)

-- One row per deal. id is D-nnnnn, or NEWD-nnnn until the daily run renames it (like NEW- sites).
-- stage uses the site stages a deal can have: Negotiating, Active (signed; Live once live_date or
-- content_url is set) and Lost.
CREATE TABLE IF NOT EXISTS deals (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  client TEXT,
  stage TEXT NOT NULL DEFAULT 'Negotiating',
  owner TEXT,
  deal_model TEXT,
  deal_flat REAL,
  deal_pct REAL,
  deal_value REAL,
  content_url TEXT,
  live_date TEXT,
  tracking_id TEXT,
  next_step TEXT,
  next_due TEXT,
  notes TEXT,
  created TEXT,
  updated_at TEXT,
  updated_by TEXT
);
CREATE INDEX IF NOT EXISTS deals_account ON deals (account_id);

-- Files are links (Google Drive, Dropbox, a signed-contract link). Nothing is uploaded to Cloudflare.
CREATE TABLE IF NOT EXISTS files (
  n INTEGER PRIMARY KEY,
  account_id TEXT NOT NULL,
  deal_id TEXT,
  label TEXT NOT NULL,
  kind TEXT,
  url TEXT NOT NULL,
  added_at TEXT,
  added_by TEXT
);
CREATE INDEX IF NOT EXISTS files_account ON files (account_id);

-- First run only (the table is empty): one deal per site that has deal terms or is at Negotiating or
-- Active, for the site's first client, with the site's own deal fields. Sites at Lost without terms
-- (old imports) get none.
INSERT INTO deals (id, account_id, client, stage, owner, deal_model, deal_flat, deal_pct, deal_value, content_url,
  live_date, tracking_id, next_step, next_due, created, updated_at, updated_by)
SELECT 'D-' || printf('%05d', ROW_NUMBER() OVER (ORDER BY id)), id,
  NULLIF(TRIM(CASE WHEN instr(COALESCE(clients, ''), ',') > 0 THEN substr(clients, 1, instr(clients, ',') - 1) ELSE COALESCE(clients, '') END), ''),
  CASE WHEN stage IN ('Negotiating', 'Active', 'Lost') THEN stage ELSE 'Negotiating' END,
  owner, deal_model, deal_flat, deal_pct, deal_value, content_url, live_date, tracking_id,
  CASE WHEN stage IN ('Negotiating', 'Active') THEN next_step END,
  CASE WHEN stage IN ('Negotiating', 'Active') THEN next_due END,
  COALESCE(last_touch, date('now')), strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), 'Migration 006'
FROM partners
WHERE (stage IN ('Negotiating', 'Active')
    OR COALESCE(deal_model, '') <> '' OR deal_flat IS NOT NULL OR deal_pct IS NOT NULL OR deal_value IS NOT NULL
    OR COALESCE(content_url, '') <> '' OR COALESCE(live_date, '') <> '')
  AND COALESCE(stage, '') <> 'Do not contact'
  AND NOT EXISTS (SELECT 1 FROM deals);
