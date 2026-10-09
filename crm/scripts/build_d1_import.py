#!/usr/bin/env python3
"""Build the SQL import file for the website's partner list (Cloudflare D1).

Inputs are the JSON dumps the Google Sheets connector saves for large reads:
  accounts: Accounts!A1:V<last row>   contacts: Contacts!B1:B<last row>
Output: SQL that Tomas loads once with
  npx wrangler d1 execute partnergap-crm-partners --remote --file <out.sql>

No contact details go in: emails are never read from Contacts, any
Domain or Brand value containing "@" is blanked, and any address inside a
Next step is replaced. Notes (column T) are skipped.

Usage: python3 crm/scripts/build_d1_import.py <accounts.json> <contacts.json> <out.sql>
"""
import collections
import json
import re
import sqlite3
import sys

COLS = "id,domain,name,type,dr,traffic,owner,stage,last_touch,clients,country,contacts,next_step,next_due"
SCHEMA = ("CREATE TABLE IF NOT EXISTS partners (id TEXT PRIMARY KEY, domain TEXT, name TEXT, type TEXT, "
          "dr INTEGER, traffic INTEGER, owner TEXT, stage TEXT, last_touch TEXT, clients TEXT, "
          "country TEXT, contacts INTEGER, next_step TEXT, next_due TEXT);")
# Tables created before next steps were added get the two columns here; D1 reports
# "duplicate column" if they already exist, so run these two lines once, by hand.
MIGRATE = ("ALTER TABLE partners ADD COLUMN next_step TEXT;", "ALTER TABLE partners ADD COLUMN next_due TEXT;")
EMAIL = re.compile(r"[\w.+-]+@[\w-]+\.[\w.-]+")


def no_email(s):
    """Next steps are free text and sometimes name an address; the site never shows one."""
    return EMAIL.sub("[email in sheet]", s)


def cell(row, i):
    return row[i].strip() if i < len(row) and row[i] is not None else ""


def num(s):
    try:
        return int(float(s.replace(",", "")))
    except ValueError:
        return None


def sql(v):
    if v is None:
        return "NULL"
    if isinstance(v, int):
        return str(v)
    return "'" + v.replace("'", "''") + "'"


def main(accounts_path, contacts_path, out_path):
    accounts = json.load(open(accounts_path))["values"]
    contacts = json.load(open(contacts_path))["values"]
    assert accounts[0][0] == "Account ID" and accounts[0][1] == "Domain", "accounts dump must start at Accounts!A1"
    per_account = collections.Counter(cell(r, 0) for r in contacts[1:])

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
            cell(r, 16),           # Q Last touch
            cell(r, 20),           # U Clients pitched
            cell(r, 21),           # V Top traffic country
            per_account.get(pid, 0),
            no_email(cell(r, 17)), # R Next step
            cell(r, 18),           # S Next step due
        ))

    parts = [SCHEMA]
    for i in range(0, len(rows), 200):
        values = ",\n".join("(" + ",".join(sql(v) for v in row) + ")" for row in rows[i:i + 200])
        parts.append(f"INSERT OR REPLACE INTO partners ({COLS}) VALUES\n{values};")
    text = "\n".join(parts) + "\n"

    # Check the file runs cleanly before anyone loads it.
    db = sqlite3.connect(":memory:")
    db.executescript(text)
    count = db.execute("SELECT COUNT(*) FROM partners").fetchone()[0]
    leaked = db.execute("SELECT COUNT(*) FROM partners WHERE domain LIKE '%@%' OR name LIKE '%@%' OR next_step LIKE '%@%'").fetchone()[0]
    assert count == len(rows) and leaked == 0

    with open(out_path, "w") as f:
        f.write(text)
    print(f"wrote {out_path}: {count} partner sites")


if __name__ == "__main__":
    if len(sys.argv) != 4:
        sys.exit(__doc__)
    main(*sys.argv[1:])
