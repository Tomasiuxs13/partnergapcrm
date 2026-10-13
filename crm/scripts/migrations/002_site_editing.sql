-- Lets the team edit the CRM on the website. Additive only: run once with
--   npx wrangler d1 execute partnergap-crm-partners --remote --file crm/scripts/migrations/002_site_editing.sql
-- Affiliate deal terms on each partner.
ALTER TABLE partners ADD COLUMN deal_model TEXT;
ALTER TABLE partners ADD COLUMN deal_flat REAL;
ALTER TABLE partners ADD COLUMN deal_pct REAL;
ALTER TABLE partners ADD COLUMN deal_value REAL;
ALTER TABLE partners ADD COLUMN content_url TEXT;
ALTER TABLE partners ADD COLUMN live_date TEXT;
ALTER TABLE partners ADD COLUMN tracking_id TEXT;
ALTER TABLE partners ADD COLUMN updated_at TEXT;
ALTER TABLE partners ADD COLUMN updated_by TEXT;
-- Every change made on the site, so the daily run can copy it into the Google Sheet.
CREATE TABLE IF NOT EXISTS edits (
  n INTEGER PRIMARY KEY,
  at TEXT NOT NULL,
  by_whom TEXT,
  kind TEXT NOT NULL,      -- update | create_account | create_contact | activity | client_program
  account_id TEXT,
  contact_id TEXT,
  field TEXT,
  old TEXT,
  new TEXT,
  applied INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS edits_pending ON edits (applied, n);
-- Each client's affiliate program: network, commission, cookie, payout and brief.
CREATE TABLE IF NOT EXISTS client_programs (
  k TEXT PRIMARY KEY,
  network TEXT,
  commission TEXT,
  cookie_days INTEGER,
  payout_terms TEXT,
  signup_url TEXT,
  brief TEXT,
  updated_at TEXT,
  updated_by TEXT
);
INSERT OR IGNORE INTO client_programs (k, commission, updated_at, updated_by)
  VALUES ('soro', '30% recurring for 12 months', '2026-10-13', 'Claude');
