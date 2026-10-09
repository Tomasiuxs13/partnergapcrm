#!/usr/bin/env python3
"""Build the SQL import file for the website's partner data (Cloudflare D1).

Inputs are the JSON dumps the Google Sheets connector saves for large reads:
  accounts: Accounts!A1:V   contacts: Contacts!A1:Q   activity: 'Activity log'!A1:H
Output: SQL that is loaded with
  npx wrangler d1 execute partnergap-crm-partners --remote --file <out.sql>

Contact emails go only into contacts.email, which the site shows to signed-in
users (functions/_middleware.js keeps the whole site behind the login). Any
Domain or Brand value containing "@" is blanked, and any address inside a
Next step, Notes or Activity summary is replaced, so the partner list itself
carries none.

Usage: python3 crm/scripts/build_d1_import.py <accounts.json> <contacts.json> <activity.json> <out.sql>
"""
import collections
import datetime
import json
import re
import sqlite3
import sys

COLS = ("id,domain,name,type,dr,traffic,owner,stage,last_touch,clients,country,contacts,"
        "next_step,next_due,source,seed_keyword,notes")
SCHEMA = """CREATE TABLE IF NOT EXISTS partners (id TEXT PRIMARY KEY, domain TEXT, name TEXT, type TEXT,
  dr INTEGER, traffic INTEGER, owner TEXT, stage TEXT, last_touch TEXT, clients TEXT,
  country TEXT, contacts INTEGER, next_step TEXT, next_due TEXT, source TEXT, seed_keyword TEXT, notes TEXT);
DROP TABLE IF EXISTS contacts;
CREATE TABLE contacts (id TEXT PRIMARY KEY, account_id TEXT, first_name TEXT, last_name TEXT, title TEXT,
  email TEXT, linkedin TEXT, email_status TEXT, source TEXT, primary_contact INTEGER, outreach_status TEXT,
  last_email TEXT, replied INTEGER, client TEXT);
CREATE INDEX contacts_account ON contacts (account_id);
DROP TABLE IF EXISTS activity;
CREATE TABLE activity (n INTEGER PRIMARY KEY, date TEXT, account_id TEXT, contact_id TEXT, type TEXT,
  by_whom TEXT, summary TEXT, client TEXT);
CREATE INDEX activity_account ON activity (account_id);"""
# Tables created before these columns existed get them here; D1 reports
# "duplicate column" if they already exist, so run these lines once, by hand.
MIGRATE = (
    "ALTER TABLE partners ADD COLUMN next_step TEXT;", "ALTER TABLE partners ADD COLUMN next_due TEXT;",
    "ALTER TABLE partners ADD COLUMN source TEXT;", "ALTER TABLE partners ADD COLUMN seed_keyword TEXT;",
    "ALTER TABLE partners ADD COLUMN notes TEXT;",
)
EMAIL = re.compile(r"[\w.+-]+@[\w-]+\.[\w.-]+")
CONTACT_COLS = ("id,account_id,first_name,last_name,title,email,linkedin,email_status,source,primary_contact,"
                "outreach_status,last_email,replied,client")
ACTIVITY_COLS = "n,date,account_id,contact_id,type,by_whom,summary,client"


def no_email(s):
    """Free text sometimes names an address; the site never shows one."""
    return EMAIL.sub("[email in sheet]", s)


def cell(row, i):
    return row[i].strip() if i < len(row) and row[i] is not None else ""


def num(s):
    try:
        return int(float(s.replace(",", "")))
    except ValueError:
        return None


def day(s):
    """Sheets returns some dates as serial numbers (days since 1899-12-30)."""
    if re.fullmatch(r"\d{5}(\.\d+)?", s):
        return (datetime.date(1899, 12, 30) + datetime.timedelta(days=int(float(s)))).isoformat()
    return s


def flag(s):
    return 1 if s.upper() == "TRUE" else 0


def sql(v):
    if v is None:
        return "NULL"
    if isinstance(v, int):
        return str(v)
    return "'" + v.replace("'", "''") + "'"


def inserts(table, cols, rows, verb="INSERT"):
    out = []
    for i in range(0, len(rows), 200):
        values = ",\n".join("(" + ",".join(sql(v) for v in row) + ")" for row in rows[i:i + 200])
        out.append(f"{verb} INTO {table} ({cols}) VALUES\n{values};")
    return out


def main(accounts_path, contacts_path, activity_path, out_path):
    accounts = json.load(open(accounts_path))["values"]
    contacts = json.load(open(contacts_path))["values"]
    activity = json.load(open(activity_path))["values"]
    assert accounts[0][0] == "Account ID" and accounts[0][1] == "Domain", "accounts dump must start at Accounts!A1"
    assert contacts[0][:2] == ["Contact ID", "Account ID"] and contacts[0][6] == "Email", "contacts dump must be Contacts!A1:Q"
    assert activity[0][:2] == ["Date", "Account ID"], "activity dump must start at 'Activity log'!A1"
    contacts = [r for r in contacts[1:] if cell(r, 0)]
    per_account = collections.Counter(cell(r, 1) for r in contacts)

    rows = []
    for r in accounts[1:]:
        pid = cell(r, 0)
        if not pid:
            continue
        domain, name = cell(r, 1), cell(r, 2)
        rows.append((
            pid,
            "" if "@" in domain else domain,
            "" if "@" in name else name,
            cell(r, 3),            # D Affiliate type
            num(cell(r, 7)),       # H Domain rating
            num(cell(r, 8)),       # I Organic traffic
            cell(r, 9),            # J Owner
            cell(r, 12),           # M Stage
            day(cell(r, 16)),      # Q Last touch
            cell(r, 20),           # U Clients pitched
            cell(r, 21),           # V Top traffic country
            per_account.get(pid, 0),
            no_email(cell(r, 17)), # R Next step
            day(cell(r, 18)),      # S Next step due
            cell(r, 5),            # F Source
            cell(r, 6),            # G Seed keyword
            no_email(cell(r, 19)), # T Notes
        ))

    people = [(
        cell(r, 0), cell(r, 1), cell(r, 3), cell(r, 4), cell(r, 5),
        cell(r, 6),                # G Email
        cell(r, 8),                # I LinkedIn URL
        cell(r, 7), cell(r, 9), flag(cell(r, 11)), cell(r, 12),
        day(cell(r, 14)), flag(cell(r, 15)), cell(r, 16),
    ) for r in contacts]

    log = [(
        n, day(cell(r, 0)), cell(r, 1), cell(r, 2), cell(r, 3), cell(r, 4), no_email(cell(r, 5)), cell(r, 7),
    ) for n, r in enumerate(activity[1:], 1) if cell(r, 0)]

    parts = [SCHEMA]
    parts += inserts("partners", COLS, rows, "INSERT OR REPLACE")
    parts += inserts("contacts", CONTACT_COLS, people)
    parts += inserts("activity", ACTIVITY_COLS, log)
    text = "\n".join(parts) + "\n"

    # Check the file runs cleanly and only contacts.email carries addresses.
    db = sqlite3.connect(":memory:")
    db.executescript(text)
    count = db.execute("SELECT COUNT(*) FROM partners").fetchone()[0]
    assert count == len(rows) and not any(
        EMAIL.search(str(v)) for q in ("SELECT * FROM partners", "SELECT * FROM activity",
                                       "SELECT id, account_id, first_name, last_name, title, linkedin FROM contacts")
        for row in db.execute(q) for v in row if v is not None
    ), "an email address got outside contacts.email"

    with open(out_path, "w") as f:
        f.write(text)
    print(f"wrote {out_path}: {count} partner sites, {len(people)} contacts, {len(log)} activity entries")


if __name__ == "__main__":
    if len(sys.argv) != 5:
        sys.exit(__doc__)
    main(*sys.argv[1:])
