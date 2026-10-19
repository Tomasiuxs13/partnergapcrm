-- D1-only tables the daily run fills (after the prompt diffs, J3) and the site reads. Never copied to the
-- Google Sheet. Safe to run more than once. Spec 6.2 (P0). On production it runs right after 003, right
-- before the release merge (crm/docs/release.md), after Jonas's OK.
-- The daily run must never drop, recreate or empty these tables (crm/docs/edits-contract.md section 4).

-- Suggestions from the daily run: suggested contacts (Apollo free search, so no email), test emails and
-- ownership asks. The site marks them used (after "Add as contact") or dismissed; no edits row.
CREATE TABLE IF NOT EXISTS suggestions (
  id TEXT PRIMARY KEY,            -- '<run date>:<kind>:<account_id>[:<k>]', set by the daily run
  run_date TEXT NOT NULL,         -- YYYY-MM-DD
  kind TEXT NOT NULL,             -- 'candidate' | 'email' | 'slack_ask'
  account_id TEXT NOT NULL,
  client TEXT,
  name TEXT, title TEXT, linkedin TEXT, source TEXT,   -- candidate (no email: Apollo free search)
  to_email TEXT, subject TEXT, body TEXT,              -- email (test mode; to_email only if already in Contacts)
  note TEXT,                                           -- slack_ask: the message that would go to the owner
  status TEXT NOT NULL DEFAULT 'open',                 -- open | used | dismissed
  reviewed_by TEXT, reviewed_at TEXT
);
CREATE INDEX IF NOT EXISTS suggestions_account ON suggestions (account_id, status);
CREATE INDEX IF NOT EXISTS suggestions_status ON suggestions (status, run_date);

-- One row per scheduled run, written by the run itself.
CREATE TABLE IF NOT EXISTS runs (
  n INTEGER PRIMARY KEY, name TEXT NOT NULL,     -- 'daily' | 'discovery' | 'digest'
  started_at TEXT, finished_at TEXT, status TEXT, -- 'ok' | 'error'
  summary TEXT                                   -- JSON counts
);
