// The snapshot builder's Sheets path (spec 4.14; crm/scripts/snapshot/sheet.mjs). Owner G3-6.
// The Friday digest gives build_snapshot.mjs a Google Sheets dump of Accounts!A1:AC (and maybe Contacts!A1:Q
// and 'Activity log'!A1:H). These tests prove the rows it embeds are the ones GET /api/partners?v=2 serves
// after crm/scripts/build_d1_import.py loaded the same dumps: the real importer (python3) writes the SQL,
// node:sqlite loads it after 001_base.sql (then 003 and 004, as on the site), and the server's own query
// (lib/crm.js#v2Sql) reads it back. The dumps are synthetic (tests/fixtures/sheets, *.example.test).
// tests/e2e/96-snapshot does the same through a fixture server and local D1.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { V2_COLS, v2Sql, binaryCompare, contactLabel } from "../../lib/crm.js";
import { sheetRows, isSheetDump, pyStrip, pyFloat, num, amount, day, noEmail, SheetError } from "../../crm/scripts/snapshot/sheet.mjs";
import { buildSnapshot, SnapshotError, EMAIL_RE } from "../../crm/scripts/build_snapshot.mjs";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SHEETS = path.join(ROOT, "tests", "fixtures", "sheets");
const IMPORTER = path.join(ROOT, "crm", "scripts", "build_d1_import.py");
const MIG = path.join(ROOT, "crm", "scripts", "migrations");
const BUILDER = path.join(ROOT, "crm", "scripts", "build_snapshot.mjs");
const AS_OF = "2026-10-20T12:00:00Z";
const NOW = new Date("2026-10-20T13:00:00.000Z");

const load = (name) => JSON.parse(fs.readFileSync(path.join(SHEETS, name), "utf8"));
const ACCOUNTS = load("accounts.json");
const CONTACTS = load("contacts.json");
const ACTIVITY = load("activity.json");
// The page gets the rows as JSON, so they are compared as JSON (where -0 and 0 are the same).
const asJson = (v) => JSON.parse(JSON.stringify(v));

// node:sqlite prints an ExperimentalWarning on load; keep it out of the test output.
async function sqlite() {
  const emit = process.emitWarning;
  process.emitWarning = function (w, ...rest) {
    if (/SQLite/i.test(String(w && w.message ? w.message : w))) return;
    return emit.call(process, w, ...rest);
  };
  try {
    return (await import("node:sqlite")).DatabaseSync;
  } finally {
    process.emitWarning = emit;
  }
}

/** GET /api/partners?v=2's rows after build_d1_import.py loaded these dumps (a header-only dump for a missing tab). */
async function serverRows({ accounts, contacts = null, activity = null }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pg-sheet-"));
  try {
    const file = (name, body) => {
      fs.writeFileSync(path.join(dir, name), JSON.stringify(body));
      return path.join(dir, name);
    };
    const empty = (dump) => ({ range: dump.range, values: [dump.values[0]] });
    const sql = path.join(dir, "import.sql");
    execFileSync("python3", ["-I", IMPORTER, file("a.json", accounts), file("c.json", contacts || empty(CONTACTS)),
      file("l.json", activity || empty(ACTIVITY)), sql], { encoding: "utf8" });
    const DatabaseSync = await sqlite();
    const db = new DatabaseSync(":memory:");
    for (const f of [path.join(MIG, "001_base.sql"), sql, path.join(MIG, "003_site_meta.sql"), path.join(MIG, "004_suggestions_runs.sql")]) {
      db.exec(fs.readFileSync(f, "utf8"));
    }
    const rows = db.prepare(v2Sql({ mode: "list", sugg: true })).all().map((r) => V2_COLS.map((c) => r[c]));
    db.close();
    return rows;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** The importer's own helpers on each input: [{num, amount, day, no_email, strip}] ("error: <name>" where Python raises). */
function pythonHelpers(inputs) {
  const code = `
import importlib.util, json, math, sys
spec = importlib.util.spec_from_file_location("imp", sys.argv[1])
imp = importlib.util.module_from_spec(spec)
spec.loader.exec_module(imp)
def run(f, s):
    try:
        v = f(s)
    except Exception as e:
        return "error: " + type(e).__name__
    return repr(v) if isinstance(v, float) and not math.isfinite(v) else v
out = []
for s in json.load(sys.stdin):
    out.append({"num": run(imp.num, s), "amount": run(imp.amount, s), "day": run(imp.day, s), "no_email": run(imp.no_email, s), "strip": s.strip()})
print(json.dumps(out, allow_nan=False))
`;
  const r = spawnSync("python3", ["-I", "-c", code, IMPORTER], { input: JSON.stringify(inputs), encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}

// ---------- the same rows as the site ----------

test("a Sheets dump of Accounts, Contacts and the Activity log gives the rows the site serves after build_d1_import.py", async () => {
  const want = await serverRows({ accounts: ACCOUNTS, contacts: CONTACTS, activity: ACTIVITY });
  const got = sheetRows({ accounts: ACCOUNTS, contacts: CONTACTS, activity: ACTIVITY });
  assert.deepEqual(got.cols, V2_COLS);
  assert.equal(got.rows.length, 15, "15 sites with an Account ID");
  assert.deepEqual(asJson(got.rows), asJson(want));
  assert.deepEqual(got.warnings, []);
  assert.deepEqual(got.counts, { sites: 15, contacts: 13, activity: 5 });

  // The fixture covers what the importer and the v2 query do; a few spot checks name them.
  const row = (id) => Object.fromEntries(V2_COLS.map((c, i) => [c, got.rows.find((r) => r[0] === id)[i]]));
  assert.deepEqual(got.rows.map((r) => r[0]).slice(-3), ["PG-00013", "PG-00099", "PG-00100"], "sorted by id, ids stripped");
  assert.equal(row("PG-00002").next_step, "Write to [email in sheet] about terms");
  assert.equal(row("PG-00002").last_touch, "2026-10-06", "serial date 46301");
  assert.equal(row("PG-00002").next_due, "2026-10-20", "serial date 46315.75");
  assert.equal(row("PG-00002").owner, "Jonas", "Python's strip(), no-break space included");
  assert.equal(row("PG-00002").traffic, 1234);
  assert.equal(row("PG-00002").label, "beta-coupons.example.test", "no name: the domain");
  assert.equal(row("PG-00003").domain, "", "a Domain with @ is blanked");
  assert.equal(row("PG-00003").dr, -3);
  assert.equal(row("PG-00003").traffic, null, "12.5K is not a number");
  assert.deepEqual([row("PG-00003").deal_flat, row("PG-00003").deal_pct, row("PG-00003").deal_value], [1200.5, 12.5, 0.12]);
  assert.deepEqual([row("PG-00009").deal_flat, row("PG-00009").deal_pct, row("PG-00009").deal_value], [0.38, 2.67, 1], "round(x, 2) as Python");
  assert.equal(row("PG-00004").label, "Unnamed creator", "a channel path with @ is blanked like an address");
  assert.equal(row("PG-00006").label, "Zed", "a named, primary contact first");
  assert.equal(row("PG-00007").label, "a.second", "else the primary contact's local part");
  assert.equal(row("PG-00008").label, "Unnamed creator");
  assert.deepEqual([row("PG-00001").contacts, row("PG-00001").last_email, row("PG-00001").replied_contact, row("PG-00001").act_at],
    [2, "2026-10-10", 1, "2026-10-14"], "MAX over contacts and activity (serial 46309) in BINARY order");
  assert.deepEqual([row("PG-00002").contacts, row("PG-00002").last_email, row("PG-00002").replied_contact], [1, "", 0]);
  assert.deepEqual([row("PG-00010").contacts, row("PG-00010").last_email, row("PG-00010").act_at, row("PG-00010").sugg], [0, null, null, null]);
  assert.equal(row("PG-00013").next_step, "Mail [email in sheet] today", "Python's \\w takes letters beyond ASCII");
  assert.equal(EMAIL_RE.test(JSON.stringify(got.rows)), false);
});

test("Accounts alone gives the rows the site serves after an import with empty Contacts and Activity log tabs", async () => {
  const want = await serverRows({ accounts: ACCOUNTS });
  const got = sheetRows({ accounts: ACCOUNTS });
  assert.deepEqual(asJson(got.rows), asJson(want));
  assert.ok(got.rows.every((r) => r[V2_COLS.indexOf("contacts")] === 0 && r[V2_COLS.indexOf("act_at")] === null));
  assert.equal(got.rows.find((r) => r[0] === "PG-00006")[V2_COLS.indexOf("label")], "Unnamed creator", "no contact to name it");
});

test("the importer's helpers, input by input, against Python itself", () => {
  const inputs = [
    "", "0", "45", "45.9", "-3.7", " 1,234 ", "12.5K", "1_000", "1__0", "_1", "1_", "1e3", "1E-2", ".5", "5.", "+7", "-0", "-0.4",
    "nan", "NaN", "-inf", "Infinity", "1e400", "$1,200.50", "12.5%", "0.125", "0.375", "2.675", "1.005", "0.005", "0.015", "0.025",
    "-0.001", "-1.555", "  $ 2,000 ", "1 000", "  42  ", "\x1c5\x1f", "\x855", "﻿7", "​8", "9　",
    "123456789012.345", "1e-20", "46301", "46301.75", "4630", "463010", "46301.", "00001", "99999", "2026-10-20", "10/20/2026",
    "write to ana.berg@x.example.test today", "a@b.example.test", "jürgen@münchen.example.test", "x@y", "o'brien@x.example.test",
    "two: a@x.example.test, b@y.example.test", "@x.example.test", "user@.example.test", "name@host.example.test.", "日本@例え.テスト",
  ];
  const py = pythonHelpers(inputs);
  inputs.forEach((s, i) => {
    const p = py[i];
    const where = JSON.stringify(s);
    // num: int(float()); Python stops on inf (OverflowError), the snapshot takes null.
    assert.deepEqual(asJson(num(s)), p.num === "error: OverflowError" ? null : asJson(p.num), "num " + where);
    // amount: Python round()s nan/inf into SQL the importer can't run; the snapshot takes null.
    assert.deepEqual(asJson(amount(s)), ["nan", "inf", "-inf"].includes(p.amount) ? null : asJson(p.amount), "amount " + where);
    assert.equal(day(s), p.day, "day " + where);
    assert.equal(noEmail(s), p.no_email, "no_email " + where);
    assert.equal(pyStrip(s), p.strip, "strip " + where);
  });
  assert.equal(pyFloat("1__0"), undefined);
  assert.ok(Number.isNaN(pyFloat(" nan ")));
});

// ---------- shapes, warnings and refusals ----------

test("isSheetDump tells a Sheets dump from an API body", () => {
  assert.equal(isSheetDump(ACCOUNTS), true);
  assert.equal(isSheetDump({ values: [] }), true, "range is optional");
  assert.equal(isSheetDump({ v: 2, cols: ["id"], rows: [] }), false);
  assert.equal(isSheetDump([["PG-00001"]]), false);
  assert.equal(isSheetDump(null), false);
});

test("sheetRows refuses the wrong dump and notes what the importer would refuse", () => {
  const refuses = (input, want) => assert.throws(() => sheetRows(input), (e) => e instanceof SheetError && want.test(e.message));
  refuses({ accounts: CONTACTS }, /--rows: a Sheets dump must start at Accounts!A1/);
  refuses({ accounts: { values: [] } }, /no header row/);
  refuses({ accounts: { values: [["Account ID", "Domain"], "PG-1"] } }, /row 2 of the dump is not a list/);
  refuses({ accounts: { majorDimension: "COLUMNS", values: [["Account ID", "PG-1"], ["Domain", "a.example.test"]] } }, /by rows/);
  refuses({ accounts: ACCOUNTS, contacts: ACTIVITY }, /--contacts-sheet: a Sheets dump must be Contacts!A1:Q/);
  refuses({ accounts: ACCOUNTS, activity: CONTACTS }, /--activity-sheet: a Sheets dump must start at 'Activity log'!A1/);
  refuses({ accounts: { values: [["Account ID", "Domain"], ["PG-1", { formula: "=A1" }]] } }, /not text/);

  // A repeated Account ID keeps its last row; repeated contact IDs are counted; a moved header is noted.
  const head = ACCOUNTS.values[0].slice();
  head[12] = "Status";
  const s = sheetRows({
    accounts: { values: [head, ["PG-00001", "first.example.test"], ["PG-00002", "b.example.test"], ["PG-00001", "second.example.test", "", "", "", "", "", 41, "", "", "", "", "Replied"]] },
    contacts: { values: [CONTACTS.values[0], ["C-1", "PG-00001"], ["C-1", "PG-00001", "", "Ana"], ["C-2", "PG-00002", "", "", "", "", "", "", "", "", "", true]] },
  });
  assert.deepEqual(s.rows.map((r) => [r[0], r[1], r[V2_COLS.indexOf("dr")], r[V2_COLS.indexOf("stage")], r[V2_COLS.indexOf("contacts")]]),
    [["PG-00001", "second.example.test", 41, "Replied", 2], ["PG-00002", "b.example.test", null, "", 1]], "numbers and true/false cells read as the sheet shows them");
  assert.equal(s.warnings.length, 3, s.warnings.join("\n"));
  assert.match(s.warnings[0], /^Accounts column M is headed "Status" \(expected "Stage"\); it is read by position/);
  assert.match(s.warnings[1], /^Contacts has 1 repeated contact ID; build_d1_import.py refuses such a sheet\.$/);
  assert.match(s.warnings[2], /^Accounts has 1 repeated Account ID; the last row of each is used\./);
});

test("contactLabel and binaryCompare follow SQLite (named first, then primary, then id; TRIM of spaces only)", () => {
  assert.equal(contactLabel([]), null);
  assert.equal(contactLabel([{ id: "C-2", email: "b@x.example.test" }, { id: "C-1", email: "a@x.example.test" }]), "a");
  assert.equal(contactLabel([{ id: "C-1", email: "a@x.example.test" }, { id: "C-2", first_name: " ", last_name: "Lee" }]), "Lee");
  assert.equal(contactLabel([{ id: "C-1", first_name: "Al", primary_contact: 0 }, { id: "C-2", first_name: "Bo", primary_contact: 1 }]), "Bo");
  assert.equal(contactLabel([{ id: "C-1", email: "@x.example.test" }, { id: "C-2", first_name: " \t" }]), "\t", "TRIM keeps a tab");
  assert.ok(binaryCompare("PG-00010", "PG-00009") > 0);
  assert.ok(binaryCompare("a", "ab") < 0);
  assert.ok(binaryCompare("￿", "\u{10000}") < 0, "code point order, not UTF-16 units");
  assert.equal(binaryCompare("é", "é"), 0);
});

test("buildSnapshot takes a Sheets dump in rows (by its shape) and embeds the converted rows", async () => {
  const { html, stats } = await buildSnapshot({ rows: ACCOUNTS, contactsSheet: CONTACTS, activitySheet: ACTIVITY, asOf: AS_OF, now: NOW });
  const data = JSON.parse(/<script type="application\/json" id="pg-snapshot-data">([^]*?)<\/script>/.exec(html)[1]);
  const want = sheetRows({ accounts: ACCOUNTS, contacts: CONTACTS, activity: ACTIVITY });
  assert.deepEqual(data.cols, V2_COLS);
  assert.deepEqual(data.rows, asJson(want.rows));
  assert.equal(stats.source, "sheet");
  assert.deepEqual(stats.sheet, { sites: 15, contacts: 13, activity: 5 });
  assert.equal(html.match(EMAIL_RE), null, "the contact emails were read, never embedded");
  for (const row of CONTACTS.values.slice(1)) if (row[6] && row[6].includes("@")) assert.ok(!html.includes(row[6].trim()), "email leaked");

  // An address in a column the importer doesn't scrub is refused like any other input, or hidden on request.
  const bad = JSON.parse(JSON.stringify(ACCOUNTS));
  bad.values[1][9] = "kamile@team.example.test";
  await assert.rejects(buildSnapshot({ rows: bad, asOf: AS_OF, now: NOW }),
    (e) => e instanceof SnapshotError && /1 input value looks like an email address/.test(e.message) && /rows: PG-00001 owner \(k…@t…\)/.test(e.message));
  const hidden = await buildSnapshot({ rows: bad, asOf: AS_OF, now: NOW, redact: true });
  assert.equal(hidden.stats.redacted, 1);

  await assert.rejects(buildSnapshot({ rows: { v: 2, cols: ["id"], rows: [] }, contactsSheet: CONTACTS, now: NOW }),
    (e) => e instanceof SnapshotError && /--contacts-sheet and --activity-sheet go with a Sheets dump of Accounts!A1:AC in --rows/.test(e.message));
  await assert.rejects(buildSnapshot({ rows: CONTACTS, now: NOW }), (e) => e instanceof SnapshotError && /must start at Accounts!A1/.test(e.message));
  await assert.rejects(buildSnapshot({ rows: { list: [] }, now: NOW }), (e) => e instanceof SnapshotError && /or a Sheets dump of Accounts!A1:AC/.test(e.message));
});

test("the command line builds from Sheets dumps: --rows accounts.json --contacts-sheet --activity-sheet", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pg-sheet-cli-"));
  try {
    const out = path.join(dir, "snap.html");
    let r = spawnSync(process.execPath, [BUILDER, "--rows", path.join(SHEETS, "accounts.json"), "--contacts-sheet", path.join(SHEETS, "contacts.json"),
      "--activity-sheet", path.join(SHEETS, "activity.json"), "--as-of", AS_OF, "--out", out], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /15 sites, \d+ KB/);
    assert.match(r.stdout, /from the Sheets dump: Accounts, Contacts \(13\), Activity log \(5\)/);
    assert.ok(fs.statSync(out).size > 100000);
    r = spawnSync(process.execPath, [BUILDER, "--rows", path.join(SHEETS, "accounts.json"), "--as-of", AS_OF, "--out", out], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /no Contacts dump: 0 contacts each.*no Activity log dump: no activity dates/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
