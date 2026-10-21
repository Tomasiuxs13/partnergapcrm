-- Generated from the production-shaped scratch copy. Do not run on production.
-- Base schema for test and new databases only (spec 6.2). Written by crm/scripts/dump_schema.py,
-- which reads the scratch D1 schema read-only (sqlite mode=ro) and copies no rows.
-- Apply order on a test database: 001_base.sql, then 003_site_meta.sql, then 004_suggestions_runs.sql.
-- Safe to run more than once.

CREATE TABLE IF NOT EXISTS partners (id TEXT PRIMARY KEY, domain TEXT, name TEXT, type TEXT, dr INTEGER, traffic INTEGER, owner TEXT, stage TEXT, last_touch TEXT, clients TEXT, country TEXT, contacts INTEGER, next_step TEXT, next_due TEXT, source TEXT, seed_keyword TEXT, notes TEXT, deal_model TEXT, deal_flat REAL, deal_pct REAL, deal_value REAL, content_url TEXT, live_date TEXT, tracking_id TEXT, updated_at TEXT, updated_by TEXT);

CREATE TABLE IF NOT EXISTS contacts (id TEXT PRIMARY KEY, account_id TEXT, first_name TEXT, last_name TEXT, title TEXT, linkedin TEXT, email_status TEXT, source TEXT, primary_contact INTEGER, outreach_status TEXT, last_email TEXT, replied INTEGER, client TEXT, email TEXT);

CREATE INDEX IF NOT EXISTS contacts_account ON contacts (account_id);

CREATE TABLE IF NOT EXISTS activity (n INTEGER PRIMARY KEY, date TEXT, account_id TEXT, contact_id TEXT, type TEXT, by_whom TEXT, summary TEXT, client TEXT);

CREATE INDEX IF NOT EXISTS activity_account ON activity (account_id);

CREATE TABLE IF NOT EXISTS edits (
  n INTEGER PRIMARY KEY,
  at TEXT NOT NULL,
  by_whom TEXT,
  kind TEXT NOT NULL,
  account_id TEXT,
  contact_id TEXT,
  field TEXT,
  old TEXT,
  new TEXT,
  applied INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS edits_pending ON edits (applied, n);

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

-- Seed row of 002_site_editing.sql.
INSERT OR IGNORE INTO client_programs (k, commission, updated_at, updated_by)
  VALUES ('soro', '30% recurring for 12 months', '2026-10-13', 'Claude');
