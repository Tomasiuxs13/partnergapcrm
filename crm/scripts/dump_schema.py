#!/usr/bin/env python3
"""Read-only dump of the scratch D1 schema into migrations/001_base.sql (spec 6.2).

Opens the local scratch D1 sqlite (the production-shaped copy under /tmp/wtest/state/v3/d1/)
read-only through a sqlite URI with mode=ro, and writes:
  - every CREATE TABLE and CREATE INDEX from sqlite_master, in creation order, made idempotent
    (IF NOT EXISTS); internal tables (_cf_*, sqlite_*) and automatic indexes are left out;
  - the seed client_programs row of 002_site_editing.sql (a fixed literal, never read from the copy).
It copies the SCHEMA ONLY: no row of the scratch copy is read or written.

001 is for test and new databases only. Never run it on production.

Usage:
  python3 crm/scripts/dump_schema.py                 # writes crm/scripts/migrations/001_base.sql
  python3 crm/scripts/dump_schema.py --out -         # prints the SQL to stdout
  python3 crm/scripts/dump_schema.py --db <file.sqlite> --out <file>
  python3 crm/scripts/dump_schema.py --json          # prints {tables: {name: [columns]}, indexes: {...}}
"""
import argparse
import glob
import json
import os
import re
import sqlite3
import sys
import urllib.parse

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_GLOB = "/tmp/wtest/state/v3/d1/*/*.sqlite"
DEFAULT_OUT = os.path.join(HERE, "migrations", "001_base.sql")

HEADER = """\
-- Generated from the production-shaped scratch copy. Do not run on production.
-- Base schema for test and new databases only (spec 6.2). Written by crm/scripts/dump_schema.py,
-- which reads the scratch D1 schema read-only (sqlite mode=ro) and copies no rows.
-- Apply order on a test database: 001_base.sql, then 003_site_meta.sql, then 004_suggestions_runs.sql.
-- Safe to run more than once.
"""

# The seed row of crm/scripts/migrations/002_site_editing.sql, kept here as a literal.
SEED = (
    "INSERT OR IGNORE INTO client_programs (k, commission, updated_at, updated_by)\n"
    "  VALUES ('soro', '30% recurring for 12 months', '2026-10-13', 'Claude');\n"
)


def find_db(explicit):
    if explicit:
        return explicit
    found = sorted(glob.glob(DEFAULT_GLOB))
    if not found:
        return None
    # One D1 binding is expected; if there are several files, the largest is the real copy.
    found.sort(key=os.path.getsize, reverse=True)
    return found[0]


def open_ro(path):
    uri = "file:" + urllib.parse.quote(os.path.abspath(path)) + "?mode=ro"
    return sqlite3.connect(uri, uri=True)


def schema_objects(conn):
    """(type, name, table, sql) for every CREATE TABLE / CREATE INDEX, in creation order."""
    rows = conn.execute(
        "SELECT type, name, tbl_name, sql FROM sqlite_master "
        "WHERE type IN ('table', 'index') AND sql IS NOT NULL ORDER BY rowid"
    ).fetchall()
    return [r for r in rows if not (r[1].startswith(("_cf_", "sqlite_")) or r[2].startswith(("_cf_", "sqlite_")))]


def idempotent(sql):
    sql = "\n".join(line.rstrip() for line in sql.strip().splitlines())
    sql = re.sub(r"^CREATE\s+TABLE\s+(?!IF\s+NOT\s+EXISTS\b)", "CREATE TABLE IF NOT EXISTS ", sql, flags=re.I)
    sql = re.sub(r"^CREATE\s+(UNIQUE\s+)?INDEX\s+(?!IF\s+NOT\s+EXISTS\b)",
                 lambda m: "CREATE " + (m.group(1) or "") + "INDEX IF NOT EXISTS ", sql, flags=re.I)
    return sql.rstrip(";") + ";"


def render(objects):
    parts = [HEADER]
    for _typ, _name, _tbl, sql in objects:
        parts.append(idempotent(sql) + "\n")
    parts.append("-- Seed row of 002_site_editing.sql.\n" + SEED)
    return "\n".join(parts)


def quote_ident(s):
    return '"' + s.replace('"', '""') + '"'


def describe(conn):
    """Table -> column names, index -> {table, columns}: the shape schema.test.mjs compares."""
    tables, indexes = {}, {}
    for typ, name, tbl, _sql in schema_objects(conn):
        if typ == "table":
            tables[name] = [r[1] for r in conn.execute("PRAGMA table_info(%s)" % quote_ident(name))]
        else:
            indexes[name] = {"table": tbl, "columns": [r[2] for r in conn.execute("PRAGMA index_info(%s)" % quote_ident(name))]}
    return {"tables": tables, "indexes": indexes}


def main(argv):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--db", help="scratch sqlite file (default: the one under /tmp/wtest/state/v3/d1/)")
    ap.add_argument("--out", default=DEFAULT_OUT, help="output file, or - for stdout")
    ap.add_argument("--json", action="store_true", help="print the table/column/index shape as JSON instead")
    a = ap.parse_args(argv)
    db = find_db(a.db)
    if not db or not os.path.exists(db):
        print("dump_schema.py: no scratch D1 sqlite found (looked for %s)" % (a.db or DEFAULT_GLOB), file=sys.stderr)
        return 3
    conn = open_ro(db)
    try:
        if a.json:
            print(json.dumps(describe(conn), indent=1, sort_keys=True))
            return 0
        text = render(schema_objects(conn))
    finally:
        conn.close()
    if a.out == "-":
        sys.stdout.write(text)
    else:
        with open(a.out, "w", encoding="utf-8") as f:
            f.write(text)
        print("dump_schema.py: wrote %s" % a.out, file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
