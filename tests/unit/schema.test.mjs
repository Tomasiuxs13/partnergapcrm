// 001_base.sql against a fresh dump of the scratch D1 schema (spec 6.2), and the synthetic fixture
// against 001 (spec 8). Owner G1-D. Uses node:sqlite in memory; no wrangler, no server.
// The scratch comparison is skipped when /tmp/wtest/state/v3/d1/ has no sqlite file. It reads the
// schema only (dump_schema.py --json opens the copy read-only and reads no rows).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { buildFixture, seedSql, OPTIONAL_TABLES, addDays } from "../fixtures/make-seed.mjs";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const MIG = path.join(ROOT, "crm/scripts/migrations");
const BASE = fs.readFileSync(path.join(MIG, "001_base.sql"), "utf8");
const SCRATCH_DIR = "/tmp/wtest/state/v3/d1";
const HEADER = "-- Generated from the production-shaped scratch copy. Do not run on production.";

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

async function openMemory() {
  const DatabaseSync = await sqlite();
  return new DatabaseSync(":memory:");
}

// The shape dump_schema.py --json prints: {tables: {name: [columns]}, indexes: {name: {table, columns}}}.
function shape(db) {
  const tables = {}, indexes = {};
  const objs = db.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE type IN ('table','index') AND sql IS NOT NULL ORDER BY rowid").all();
  for (const o of objs) {
    if (/^(_cf_|sqlite_)/.test(o.name) || /^(_cf_|sqlite_)/.test(o.tbl_name)) continue;
    const q = '"' + o.name.replace(/"/g, '""') + '"';
    if (o.type === "table") tables[o.name] = db.prepare("PRAGMA table_info(" + q + ")").all().map((r) => r.name);
    else indexes[o.name] = { table: o.tbl_name, columns: db.prepare("PRAGMA index_info(" + q + ")").all().map((r) => r.name) };
  }
  return { tables, indexes };
}

// Order-free form: the table, column and index SETS (spec 6.2).
function sets(s) {
  const t = {}, i = {};
  for (const [k, v] of Object.entries(s.tables)) t[k] = v.slice().sort();
  for (const [k, v] of Object.entries(s.indexes)) i[k] = v.table + "(" + v.columns.join(",") + ")";
  return { tables: Object.fromEntries(Object.entries(t).sort()), indexes: Object.fromEntries(Object.entries(i).sort()) };
}

const hasStatements = (sql) => sql.split("\n").some((l) => l.trim() && !l.trim().startsWith("--"));
const count = (db, sql) => db.prepare(sql).get().c;

function scratchFile() {
  try {
    for (const d of fs.readdirSync(SCRATCH_DIR)) {
      for (const f of fs.readdirSync(path.join(SCRATCH_DIR, d))) if (f.endsWith(".sqlite")) return path.join(SCRATCH_DIR, d, f);
    }
  } catch { /* absent */ }
  return null;
}

test("001 has the header, only idempotent CREATEs and the soro seed", () => {
  assert.equal(BASE.split("\n")[0], HEADER);
  const code = BASE.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
  const creates = code.match(/\bCREATE\s+(UNIQUE\s+)?(TABLE|INDEX)\b[^;]*/gi) || [];
  assert.ok(creates.length >= 5, "the CREATE statements");
  for (const c of creates) assert.match(c, /^CREATE\s+(UNIQUE\s+)?(TABLE|INDEX)\s+IF\s+NOT\s+EXISTS\b/i, c.split("\n")[0]);
  const inserts = code.match(/\bINSERT\b[^;]*;/gi) || [];
  assert.equal(inserts.length, 1, "one INSERT");
  assert.match(inserts[0], /^INSERT OR IGNORE INTO client_programs \(k, commission, updated_at, updated_by\)\s+VALUES \('soro', '30% recurring for 12 months', '2026-10-13', 'Claude'\);$/);
  assert.doesNotMatch(code, /\b(DROP|DELETE|UPDATE|ALTER|REPLACE)\b/i, "nothing but CREATE and the seed");
  assert.doesNotMatch(code, /\b_cf_|\bsqlite_/i, "no internal tables");
  assert.doesNotMatch(BASE, /@(?!\w+\.example\.test)[\w-]+\.[a-z]{2,}/i, "no email addresses");
});

test("001 applies to an empty database and is idempotent", async () => {
  const db = await openMemory();
  db.exec(BASE);
  const once = shape(db);
  assert.deepEqual(Object.keys(once.tables).sort(), ["activity", "client_programs", "contacts", "edits", "partners"]);
  assert.equal(count(db, "SELECT COUNT(*) c FROM client_programs"), 1);
  db.exec(BASE);
  assert.deepEqual(shape(db), once, "same schema after a second run");
  assert.equal(count(db, "SELECT COUNT(*) c FROM client_programs"), 1, "the seed row once");
  assert.deepEqual({ ...db.prepare("SELECT k, commission, updated_by FROM client_programs").get() },
    { k: "soro", commission: "30% recurring for 12 months", updated_by: "Claude" });
  db.close();
});

const SCRATCH = scratchFile();
test("001 matches a fresh dump of the scratch D1 schema", { skip: !SCRATCH && "no scratch D1 copy under " + SCRATCH_DIR }, async () => {
  const r = spawnSync("python3", ["-I", path.join(ROOT, "crm/scripts/dump_schema.py"), "--json", "--db", SCRATCH], { encoding: "utf8", cwd: ROOT });
  assert.equal(r.status, 0, "dump_schema.py --json: " + r.stderr);
  const fresh = JSON.parse(r.stdout);
  const db = await openMemory();
  db.exec(BASE);
  const mine = shape(db);
  db.close();
  assert.deepEqual(sets(mine), sets(fresh), "tables, columns and indexes of 001 = the scratch schema; re-run crm/scripts/dump_schema.py");
});

// ---------- the fixture against the schema ----------

const TODAY = "2026-10-22";

// 003/004 as files once G1-B and B1 write them; until then the DDL of spec 6.2, so the optional
// rows of the seed are still checked against the agreed columns.
const SPEC_003_004 = `
CREATE TABLE IF NOT EXISTS kv_meta (k TEXT PRIMARY KEY, v TEXT, at TEXT, by_whom TEXT);
CREATE TABLE IF NOT EXISTS suggestions (id TEXT PRIMARY KEY, run_date TEXT NOT NULL, kind TEXT NOT NULL, account_id TEXT NOT NULL,
  client TEXT, name TEXT, title TEXT, linkedin TEXT, source TEXT, to_email TEXT, subject TEXT, body TEXT, note TEXT,
  status TEXT NOT NULL DEFAULT 'open', reviewed_by TEXT, reviewed_at TEXT);
CREATE TABLE IF NOT EXISTS runs (n INTEGER PRIMARY KEY, name TEXT NOT NULL, started_at TEXT, finished_at TEXT, status TEXT, summary TEXT);`;

function extraSql() {
  const files = ["003_site_meta.sql", "004_suggestions_runs.sql"].map((f) => fs.readFileSync(path.join(MIG, f), "utf8"));
  return files.every(hasStatements) ? { sql: files.join("\n"), from: "003/004 files" } : { sql: SPEC_003_004, from: "spec 6.2 DDL (003/004 are still stubs)" };
}

test("the fixture's base rows load into 001 and give its counts", async () => {
  const fx = buildFixture({ today: TODAY });
  const db = await openMemory();
  db.exec(BASE);
  db.exec(seedSql(fx, { tables: [] }));
  assert.equal(count(db, "SELECT COUNT(*) c FROM partners"), 600);
  assert.equal(count(db, "SELECT COUNT(*) c FROM contacts"), 2000);
  assert.equal(count(db, "SELECT COUNT(*) c FROM activity"), fx.counts.activity);
  assert.equal(count(db, "SELECT COUNT(*) c FROM edits"), fx.counts.edits);
  assert.equal(count(db, "SELECT COUNT(*) c FROM edits WHERE applied = 0"), fx.counts.edits_pending);
  const byStage = Object.fromEntries(db.prepare("SELECT stage, COUNT(*) c FROM partners GROUP BY stage").all().map((r) => [r.stage, r.c]));
  assert.deepEqual(byStage, fx.counts.by_stage);
  const maxApplied = count(db, "SELECT MAX(n) c FROM edits WHERE applied = 1");
  assert.ok(count(db, `SELECT COUNT(*) c FROM edits WHERE applied = 0 AND n < ${maxApplied}`) >= 1, "a conflict row (spec 8)");
  assert.equal(count(db, "SELECT COUNT(*) c FROM contacts WHERE email = 'ann@x.example.test'"), 1);
  assert.equal(count(db, "SELECT COUNT(*) c FROM contacts WHERE email = 'joann@x.example.test'"), 1);
  assert.equal(count(db, "SELECT COUNT(*) c FROM contacts WHERE email = 'a@y.example.test; b@y.example.test'"), 1);
  assert.equal(count(db, "SELECT COUNT(*) c FROM partners WHERE domain = 'dupe.example.test'"), 1);
  assert.equal(count(db, "SELECT COUNT(*) c FROM partners WHERE next_step LIKE '%INTERNAL-MARKER-7%'"), 1);
  assert.equal(count(db, "SELECT COUNT(*) c FROM partners WHERE (domain IS NULL OR domain = '') AND (name IS NULL OR name = '')"), 20);
  assert.equal(count(db, "SELECT COUNT(*) c FROM partners p WHERE (domain IS NULL OR domain = '') AND (name IS NULL OR name = '') " +
    "AND NOT EXISTS (SELECT 1 FROM contacts c WHERE c.account_id = p.id)"), 0, "every nameless creator has contacts");
  assert.equal(count(db, "SELECT COUNT(*) c FROM partners WHERE domain NOT LIKE '%example.test' AND domain NOT LIKE 'youtube.com/@pgfixture%'"), 0);
  assert.equal(count(db, "SELECT COUNT(*) c FROM contacts WHERE email IS NOT NULL AND email NOT LIKE '%example.test'"), 0);
  db.close();
});

test("the optional rows load only into the 003/004 tables", async (t) => {
  const fx = buildFixture({ today: TODAY });
  const { sql, from } = extraSql();
  t.diagnostic("003/004 schema from " + from);
  const db = await openMemory();
  db.exec(BASE);
  db.exec(sql);
  db.exec(seedSql(fx, { tables: OPTIONAL_TABLES }));
  assert.equal(count(db, "SELECT COUNT(*) c FROM kv_meta WHERE k = 'team'"), 1);
  const team = JSON.parse(db.prepare("SELECT v FROM kv_meta WHERE k = 'team'").get().v);
  assert.ok(team.some((m) => m.name === "Denisse"), "the kv team override adds Denisse");
  assert.equal(count(db, "SELECT COUNT(*) c FROM suggestions"), fx.counts.suggestions);
  assert.deepEqual(db.prepare("SELECT DISTINCT kind FROM suggestions ORDER BY kind").all().map((r) => r.kind), ["candidate", "email", "slack_ask"]);
  assert.equal(count(db, "SELECT COUNT(*) c FROM suggestions WHERE status = 'open'"), fx.counts.suggestions_open);
  assert.equal(count(db, "SELECT COUNT(*) c FROM suggestions s WHERE NOT EXISTS (SELECT 1 FROM partners p WHERE p.id = s.account_id)"), 0);
  assert.equal(count(db, "SELECT COUNT(*) c FROM runs"), fx.counts.runs);
  db.close();
  // Without 003/004 the seed leaves those tables alone (the T29 server).
  assert.doesNotMatch(seedSql(fx, { tables: [] }), /\bINTO (kv_meta|suggestions|runs)\b/);
  assert.match(seedSql(fx, { tables: [], base: true }), /INSERT INTO partners/);
  assert.doesNotMatch(seedSql(fx, { tables: OPTIONAL_TABLES, base: false }), /INSERT INTO partners/);
});

test("the fixture is deterministic and its dates follow the run day", () => {
  const a = seedSql(buildFixture({ today: TODAY }), { tables: OPTIONAL_TABLES });
  const b = seedSql(buildFixture({ today: TODAY }), { tables: OPTIONAL_TABLES });
  assert.equal(a, b, "same day, same SQL");
  const later = buildFixture({ today: "2026-11-05" });
  const now = buildFixture({ today: TODAY });
  assert.deepEqual(later.counts, now.counts, "the same counts on any day");
  assert.deepEqual(later.groups, now.groups, "the same ids in each group");
  const id = now.groups["kamile-contacted-20d"][0];
  assert.equal(now.partners.find((p) => p.id === id).last_touch, addDays(TODAY, -20));
  assert.equal(later.partners.find((p) => p.id === id).last_touch, addDays("2026-11-05", -20));
});
