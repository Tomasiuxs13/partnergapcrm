-- D1-only site settings and indexes. Never copied to the Google Sheet. Safe to run more than once.
-- Spec 6.2 (P0). On production it runs right before the release merge (crm/docs/release.md), after Jonas's OK.
-- kv_meta holds the Settings overrides (team, clients, allow_dnc), the freshness signature (sheet_sig,
-- last_sheet_change) and site_meta_since. The daily run must never drop, recreate or empty it.
CREATE TABLE IF NOT EXISTS kv_meta (k TEXT PRIMARY KEY, v TEXT, at TEXT, by_whom TEXT);
-- Edit history per site, by time, and the freshness lookup of site-written activity rows.
CREATE INDEX IF NOT EXISTS edits_account ON edits (account_id, n);
CREATE INDEX IF NOT EXISTS edits_at ON edits (at);
CREATE INDEX IF NOT EXISTS edits_kind_field ON edits (kind, field);
-- Last activity date per site (the v2 list). The base index activity_account (account_id) keeps its name,
-- so this one has its own. A full import drops the activity table with its indexes; re-run 003 after one.
CREATE INDEX IF NOT EXISTS activity_account_date ON activity (account_id, date);
INSERT OR IGNORE INTO kv_meta (k, v, at) VALUES ('site_meta_since', strftime('%Y-%m-%dT%H:%M:%SZ','now'), strftime('%Y-%m-%dT%H:%M:%SZ','now'));
