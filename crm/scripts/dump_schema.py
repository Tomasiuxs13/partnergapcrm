#!/usr/bin/env python3
"""Read-only dump of the scratch D1 schema into migrations/001_base.sql (spec 6.2).

G0 stub; owner G1-D. The real script opens the scratch sqlite under /tmp/wtest/state/v3/d1/
read-only (?mode=ro) and writes every CREATE TABLE / CREATE INDEX (excluding _cf_*) plus the
seed client_programs row.
"""
import sys

if __name__ == "__main__":
    sys.exit("dump_schema.py is not written yet (G1-D).")
