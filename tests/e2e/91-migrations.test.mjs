// Migrations and the backend core (spec 6.2, 6.3.1-6.3.3, 6.3.13, 7.1 G1-B, T22 for outcome/activity, T29-T31).
// Owner G1-B. This is the only test file G1-B owns, so besides the migrations it holds G1-B's acceptance checks:
//   - 001, 003 and 004 applied twice give identical schemas and row counts
//   - without 003/004 every endpoint works and the optional features are off; 003/004 applied while the
//     server runs switch them on at the next /api/meta (lib/tables.js caches positive answers only)
//   - /api/meta: kv_meta overrides (team, clients), allow_dnc, build = window.BUILD, read_only by host
//   - freshness writes kv_meta only on change and never on a read-only host
//   - GET /api/partners?v=2: shape, labels, values, ETag + 304, ids mode; v1 byte-for-byte the d5e91d9 shape
//   - POST /api/partner/:id/outcome = golden PATCH rows + golden activity row; activity and outcome are atomic
//   - every golden write path (PATCH, activity, bulk, add site, add contact, program) still writes its rows
// Every write goes to this file's own fixture server (startServer), never to the shared run.sh server.
// Run: bash tests/e2e/run.sh tests/e2e/91-migrations.test.mjs
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import {
  HARNESS_ROOT, startServer, apiClient, d1, d1All, migrationFiles, hasStatements, fixture, loadGolden, goldenCase,
  applyBefore, editsAfter, maxEditN, stripEdit, assertGolden, replayCase, sqlLit,
} from "./lib.mjs";
import { buildFixture, seedSql, OPTIONAL_TABLES } from "../fixtures/make-seed.mjs";
import { V2_COLS } from "../../lib/crm.js";

const MIG = path.join(HARNESS_ROOT, "crm", "scripts", "migrations");
const FILE_004 = path.join(MIG, "004_suggestions_runs.sql");
// Spec 6.2's DDL for 004, used only while B1's 004_suggestions_runs.sql is still a stub.
const SPEC_004 = `CREATE TABLE IF NOT EXISTS suggestions (id TEXT PRIMARY KEY, run_date TEXT NOT NULL, kind TEXT NOT NULL, account_id TEXT NOT NULL,
  client TEXT, name TEXT, title TEXT, linkedin TEXT, source TEXT, to_email TEXT, subject TEXT, body TEXT, note TEXT,
  status TEXT NOT NULL DEFAULT 'open', reviewed_by TEXT, reviewed_at TEXT);
CREATE INDEX IF NOT EXISTS suggestions_account ON suggestions (account_id, status);
CREATE INDEX IF NOT EXISTS suggestions_status ON suggestions (status, run_date);
CREATE TABLE IF NOT EXISTS runs (n INTEGER PRIMARY KEY, name TEXT NOT NULL, started_at TEXT, finished_at TEXT, status TEXT, summary TEXT);`;
const HAS_004 = hasStatements(FILE_004);

let server, client, target, fx;

before(async () => {
  server = await startServer({ extra: false });
  target = { persistDir: server.persistDir, root: server.root };
  client = await apiClient(server.baseUrl);
  fx = fixture({ today: server.today });
});

after(async () => {
  if (server) await server.stop();
});

const call = (method, url, body, headers) => client.call(method, url, body, headers);
const q = (sql) => d1(sql, target);

// A GET with any Host header (Node's fetch drops Host), signed in with the session cookie.
function getAs(host, url) {
  return new Promise((resolve, reject) => {
    const u = new URL(server.baseUrl);
    const req = http.request({ host: u.hostname, port: u.port, path: url, method: "GET", headers: { Host: host, Cookie: client.cookie } }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (text += c));
      res.on("end", () => {
        let json;
        try { json = JSON.parse(text); } catch (e) { json = undefined; }
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on("error", reject);
    req.end();
  });
}

async function apply004(t) {
  if (HAS_004) await d1All(null, { ...t, file: FILE_004 });
  else await d1All(SPEC_004, t);
}

// ---------- 1. migrations are idempotent ----------

async function snapshot(t) {
  const schema = await d1("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE substr(name, 1, 4) <> '_cf_' ORDER BY type, name", t);
  const tables = schema.filter((r) => r.type === "table").map((r) => r.name);
  // One statement per table: D1 caps the terms of a compound SELECT.
  const counts = (await d1All(tables.map((n) => `SELECT '${n}' AS t, COUNT(*) AS c FROM "${n}"`).join(";\n") + ";", t)).map((st) => st.results[0]);
  const kv = tables.includes("kv_meta") ? await d1("SELECT k, v, at, by_whom FROM kv_meta ORDER BY k", t) : [];
  return { schema, counts, kv };
}

test("001, 003 and 004 applied twice give identical schemas and row counts", async (t) => {
  if (!HAS_004) t.diagnostic("004_suggestions_runs.sql is still a stub (B1): checked 001 and 003 only");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pgcrm-mig-"));
  const tg = { persistDir: dir, root: HARNESS_ROOT };
  try {
    const files = migrationFiles({ only: ["001_base.sql", "003_site_meta.sql", "004_suggestions_runs.sql"] });
    assert.ok(files.some((f) => f.endsWith("003_site_meta.sql")), "003 holds SQL");
    const fx0 = buildFixture({ today: server.today });
    // The production path: a base schema with data, then 003 (and 004).
    await d1All(null, { ...tg, file: files[0] });
    fs.writeFileSync(path.join(dir, "seed.sql"), seedSql(fx0, { tables: [] }));
    await d1All(null, { ...tg, file: path.join(dir, "seed.sql") });
    for (const f of files.slice(1)) await d1All(null, { ...tg, file: f });
    const tables = (await d1("SELECT name FROM sqlite_master WHERE type = 'table'", tg)).map((r) => r.name);
    fs.writeFileSync(path.join(dir, "seed-optional.sql"), seedSql(fx0, { tables: OPTIONAL_TABLES.filter((n) => tables.includes(n)), base: false }));
    await d1All(null, { ...tg, file: path.join(dir, "seed-optional.sql") });
    const a = await snapshot(tg);
    for (const f of files) await d1All(null, { ...tg, file: f });
    const b = await snapshot(tg);
    assert.deepEqual(b.schema, a.schema, "same tables and indexes");
    assert.deepEqual(b.counts, a.counts, "same row counts");
    assert.deepEqual(b.kv, a.kv, "kv_meta untouched by the second run (site_meta_since keeps its time)");
    const names = a.schema.map((r) => r.name);
    for (const n of ["kv_meta", "edits_account", "edits_at", "edits_kind_field", "activity_account_date"]) assert.ok(names.includes(n), n + " exists");
    assert.ok(a.kv.some((r) => r.k === "site_meta_since" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(r.v)), "site_meta_since is set");
    assert.equal(a.counts.find((r) => r.t === "partners").c, 600, "003 does not touch the data");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------- 2. without 003/004 (T29) ----------

test("without 003/004 every endpoint works and the optional features are off", async () => {
  const tables = (await q("SELECT name FROM sqlite_master WHERE type = 'table'")).map((r) => r.name);
  for (const n of ["kv_meta", "suggestions", "runs"]) assert.ok(!tables.includes(n), n + " is missing on the bare server");

  const m = await call("GET", "/api/meta");
  assert.equal(m.status, 200, m.text.slice(0, 300));
  assert.equal(m.json.v, 2);
  assert.deepEqual(m.json.features, { settings: false, suggestions: false, runs: false, dnc: false });
  assert.equal(m.json.freshness, null, "no freshness before 003");
  assert.equal(m.json.read_only, false);
  assert.deepEqual(m.json.limits, { plan: "free", bulk_ids: 90, bulk_rows: 20 });
  assert.equal(m.json.team.length, 11);
  assert.equal(m.json.clients.length, 12);
  assert.deepEqual(m.json.stages.map((s) => s.name), ["New", "Researching", "Contacted", "Replied", "Negotiating", "Active", "Lost", "Do not contact"]);
  const html = fs.readFileSync(path.join(server.root, "crm", "dashboard", "index.html"), "utf8");
  const build = /window\.BUILD\s*=\s*['"]([^'"]*)['"]/.exec(html);
  assert.ok(build, "index.html sets window.BUILD");
  assert.equal(m.json.build, build[1], "meta.build = window.BUILD (the release sets both)");

  const v2 = await call("GET", "/api/partners?v=2");
  assert.equal(v2.status, 200);
  assert.deepEqual(v2.json.cols, V2_COLS);
  assert.equal(v2.json.rows.length, fx.partners.length);
  assert.ok(v2.json.rows.every((r) => r[V2_COLS.indexOf("sugg")] === null), "sugg is NULL without the suggestions table");

  const patch = goldenCase("patch-partner", "deal-terms");
  const r1 = await replayCase(patch, { client, target });
  assert.ok(r1.ok, r1.errors.join("\n"));
  const act = goldenCase("activity-log", "note-with-contact");
  const r2 = await replayCase(act, { client, target });
  assert.ok(r2.ok, r2.errors.join("\n"));
  await outcomeInterested("bare server");

  const after = (await q("SELECT name FROM sqlite_master WHERE type = 'table'")).map((r) => r.name);
  assert.deepEqual(after.sort(), tables.sort(), "GETs and writes create no table");
});

// ---------- 3. 003/004 while the server runs ----------

test("003/004 applied while the server runs switch the features on at the next /api/meta", async () => {
  const before = await call("GET", "/api/meta");
  assert.equal(before.json.features.settings, false);
  await server.applyMigrations(["003_site_meta.sql"]);
  await apply004(target);
  await server.seedOptional();

  const m = await call("GET", "/api/meta");
  assert.deepEqual(m.json.features, { settings: true, suggestions: true, runs: true, dnc: false });
  assert.ok(m.json.freshness && typeof m.json.freshness.pending === "number", "freshness is on");
  const daily = fx.runs.filter((r) => r.name === "daily").sort((a, b) => b.n - a.n)[0];
  assert.equal(m.json.freshness.last_run.n, daily.n);
  assert.equal(m.json.freshness.last_run.status, daily.status);
  assert.deepEqual(m.json.freshness.last_run.summary, JSON.parse(daily.summary));

  const v2 = await call("GET", "/api/partners?v=2");
  const si = V2_COLS.indexOf("sugg");
  const expect = {};
  for (const s of fx.suggestions) if (s.status === "open" && (s.kind === "candidate" || s.kind === "email")) expect[s.account_id] = (expect[s.account_id] || 0) + 1;
  const got = {};
  for (const r of v2.json.rows) if (r[si] !== null) got[r[0]] = r[si];
  assert.deepEqual(got, expect, "sugg = open candidate/email suggestions per site, NULL for none");
});

// ---------- 4. overrides and the Do not contact switch ----------

test("/api/meta merges the kv_meta team and clients overrides, and allow_dnc gates Do not contact", async () => {
  const kvBefore = await q("SELECT k, v, at, by_whom FROM kv_meta WHERE k IN ('team', 'clients', 'allow_dnc')");
  const team = [{ name: "Jonas", home: "team" }, { name: "Rita Example", active: false }, { name: "x" }];
  const clients = [{ k: "new client", name: "New Client", managers: ["Kamile"] }, { k: "soro", past: true }, { k: "ultahost", managers: ["Gaby"] }];
  await q(`INSERT OR REPLACE INTO kv_meta (k, v, at, by_whom) VALUES ('team', ${sqlLit(JSON.stringify(team))}, '2026-01-01T00:00:00Z', 'Jonas'),
    ('clients', ${sqlLit(JSON.stringify(clients))}, '2026-01-01T00:00:00Z', 'Jonas')`);
  try {
    const m = (await call("GET", "/api/meta")).json;
    assert.deepEqual(m.team.slice(0, 2), [{ name: "Jonas", home: "team" }, { name: "Rita Example", active: false }]);
    assert.deepEqual(m.team.slice(2).map((x) => x.name), ["Vik", "Kamile", "Eivyda", "Monica", "Mantvydas", "Gaby", "Sandra", "Tomas", "Denisse", "Egle"]);
    assert.ok(!m.team.some((x) => x.name === "x"), "names shorter than 2 characters are dropped");
    const nc = m.clients.find((c) => c.k === "new client");
    assert.deepEqual(nc, { k: "new client", slug: "new-client", name: "New Client", aliases: [], managers: ["Kamile"] });
    assert.ok(!m.clients.some((c) => c.k === "soro") && m.past_clients.some((c) => c.k === "soro" && c.name === "Soro"), "soro moved to past");
    const uh = m.clients.find((c) => c.k === "ultahost");
    assert.deepEqual([uh.name, uh.managers, uh.aliases], ["UltaHost", ["Gaby"], ["ultahost"]]);

    // Do not contact: refused while allow_dnc is off, stored once it is "1".
    const row = { stage: "Contacted", owner: "Tomas", clients: "Soro", next_step: null, next_due: null };
    await applyBefore({ "PG-00596": row }, target);
    let n0 = await maxEditN(target);
    const off = await call("PATCH", "/api/partner/PG-00596", { by: "Kamile", fields: { stage: "Do not contact" } });
    assert.equal(off.status, 400);
    assert.deepEqual(off.json, { error: "Pick a stage from the list." });
    const off2 = await call("POST", "/api/partner/PG-00596/outcome", { by: "Kamile", fields: { stage: "Do not contact" }, activity: { type: "Note", summary: "Do not contact: asked us to stop" } });
    assert.equal(off2.status, 400);
    assert.deepEqual(await editsAfter(n0, target), []);
    await q("INSERT OR REPLACE INTO kv_meta (k, v, at, by_whom) VALUES ('allow_dnc', '1', '2026-01-01T00:00:00Z', 'Jonas')");
    assert.equal((await call("GET", "/api/meta")).json.features.dnc, true);
    const on = await call("PATCH", "/api/partner/PG-00596", { by: "Kamile", fields: { stage: "Do not contact" } });
    assert.equal(on.status, 200, on.text);
    assert.deepEqual(on.json.changed, { stage: "Do not contact" });
    assertGolden([{ by_whom: "Kamile", kind: "update", account_id: "PG-00596", contact_id: null, field: "stage", old: "Contacted", new: "Do not contact", applied: 0 }],
      await editsAfter(n0, target));
    await applyBefore({ "PG-00596": row }, target);
  } finally {
    await q("DELETE FROM kv_meta WHERE k IN ('team', 'clients', 'allow_dnc')");
    if (kvBefore.length) {
      await q("INSERT INTO kv_meta (k, v, at, by_whom) VALUES " + kvBefore.map((r) => `(${sqlLit(r.k)}, ${sqlLit(r.v)}, ${sqlLit(r.at)}, ${sqlLit(r.by_whom)})`).join(", "));
    }
  }
});

// ---------- 5. freshness (T30, T31) ----------

test("freshness writes kv_meta only when the sheet signature changes, and never on a read-only host", async () => {
  const PREVIEW = "preview.partnergap-crm.pages.dev";
  const kvRows = () => q("SELECT k, v, at FROM kv_meta WHERE k IN ('sheet_sig', 'last_sheet_change') ORDER BY k");
  const expectSig = async () => {
    const [a] = await q("SELECT MAX(n) AS n FROM edits WHERE applied = 1");
    const [b] = await q("SELECT MAX(a.n) AS n FROM activity a LEFT JOIN edits e ON e.kind = 'activity' AND e.field = CAST(a.n AS TEXT) WHERE e.n IS NULL");
    const [c] = await q("SELECT id FROM partners WHERE id >= 'PG-' AND id < 'PG.' ORDER BY id DESC LIMIT 1");
    return [a.n ?? "", b.n ?? "", c ? c.id : ""].join("|");
  };
  await q("DELETE FROM kv_meta WHERE k IN ('sheet_sig', 'last_sheet_change')");

  // Read-only host: freshness is reported, nothing is written.
  const ro = await getAs(PREVIEW, "/api/meta");
  assert.equal(ro.status, 200);
  assert.equal(ro.json.read_only, true, "a preview host is read-only");
  assert.equal(ro.json.freshness.last_sheet_change, null);
  assert.deepEqual(await kvRows(), [], "no kv_meta write on a read-only GET");

  // Production-like host: the first GET stores the signature.
  const m1 = (await call("GET", "/api/meta")).json;
  const sig1 = await expectSig();
  let kv = await kvRows();
  assert.equal(kv.find((r) => r.k === "sheet_sig").v, sig1);
  assert.equal(m1.freshness.last_sheet_change, kv.find((r) => r.k === "last_sheet_change").v);
  const [p] = await q("SELECT COUNT(*) AS c, MIN(at) AS oldest FROM edits WHERE applied = 0");
  const [ap] = await q("SELECT MAX(n) AS n FROM edits WHERE applied = 1");
  assert.equal(m1.freshness.pending, p.c);
  assert.equal(m1.freshness.oldest_pending_at, p.oldest);
  assert.equal(m1.freshness.max_applied_n, ap.n);

  // No change: no write (a sentinel time would be overwritten by any write).
  await q("UPDATE kv_meta SET at = '2000-01-01T00:00:00Z' WHERE k IN ('sheet_sig', 'last_sheet_change')");
  const sentinel = await kvRows();
  await call("GET", "/api/meta");
  // A site write does not count as a sheet change.
  await applyBefore({ "PG-00595": { stage: "Contacted", next_step: null, next_due: null } }, target);
  const logged = await call("POST", "/api/partner/PG-00595/activity", { by: "Kamile", type: "Email", summary: "Sent a follow-up." });
  assert.equal(logged.status, 201);
  const m2 = (await call("GET", "/api/meta")).json;
  assert.equal(m2.freshness.pending, p.c + 1, "the new activity edit is waiting");
  assert.deepEqual(await kvRows(), sentinel, "unchanged signature: kv_meta not written");

  // A simulated morning run: one edit applied, one activity row from the sheet.
  await q("UPDATE edits SET applied = 1 WHERE n = (SELECT MIN(n) FROM edits WHERE applied = 0 AND n > (SELECT MAX(n) FROM edits WHERE applied = 1))");
  await q(`INSERT INTO activity (date, account_id, type, by_whom, summary) VALUES ('${server.today}', 'PG-00001', 'Email', 'Kamile', 'Logged in the sheet')`);
  const sig2 = await expectSig();
  assert.notEqual(sig2, sig1);
  await getAs(PREVIEW, "/api/meta");
  assert.deepEqual(await kvRows(), sentinel, "read-only host: still no write after the run");
  const m3 = (await call("GET", "/api/meta")).json;
  kv = await kvRows();
  assert.equal(kv.find((r) => r.k === "sheet_sig").v, sig2);
  assert.notEqual(kv.find((r) => r.k === "last_sheet_change").at, "2000-01-01T00:00:00Z");
  assert.equal(m3.freshness.last_sheet_change, kv.find((r) => r.k === "last_sheet_change").v);
});

// ---------- 6. GET /api/partners?v=2 ----------

// The reference v2 rows, computed in JS from D1 (spec 6.3.2 definitions), independent of lib/crm.js.
async function referenceRows() {
  const partners = await q("SELECT * FROM partners ORDER BY id");
  const contacts = await q("SELECT id, account_id, first_name, last_name, email, primary_contact, last_email, replied FROM contacts");
  const acts = await q("SELECT account_id, MAX(date) AS d FROM activity GROUP BY account_id");
  const sugg = await q("SELECT account_id, COUNT(*) AS c FROM suggestions WHERE status = 'open' AND kind IN ('candidate', 'email') GROUP BY account_id");
  const byAcc = new Map();
  for (const c of contacts) (byAcc.get(c.account_id) || byAcc.set(c.account_id, []).get(c.account_id)).push(c);
  const max = (xs) => xs.filter((x) => x != null).reduce((m, x) => (m == null || x > m ? x : m), null);
  const trim = (s) => s.replace(/^ +| +$/g, "");
  const filled = (v) => v != null && v !== "";
  const actAt = new Map(acts.map((r) => [r.account_id, r.d]));
  const sg = new Map(sugg.map((r) => [r.account_id, r.c]));
  return partners.map((p) => {
    const cs = byAcc.get(p.id) || [];
    let label = filled(p.name) ? p.name : filled(p.domain) ? p.domain : null;
    if (label == null) {
      const named = (c) => trim((c.first_name || "") + (c.last_name || "")) !== "";
      const usable = cs.filter((c) => named(c) || String(c.email || "").indexOf("@") > 0)
        .sort((a, b) => (named(a) ? 0 : 1) - (named(b) ? 0 : 1) || (b.primary_contact || 0) - (a.primary_contact || 0) || (a.id < b.id ? -1 : 1));
      const c = usable[0];
      const full = c ? trim((c.first_name || "") + " " + (c.last_name || "")) : "";
      label = full || (c ? trim(c.email.slice(0, c.email.indexOf("@"))) : "") || "Unnamed creator";
    }
    const extra = { label, last_email: max(cs.map((c) => c.last_email)), replied_contact: max(cs.map((c) => c.replied)),
      act_at: actAt.get(p.id) ?? null, sugg: sg.get(p.id) ?? null };
    return V2_COLS.map((k) => (k in extra ? extra[k] : p[k] ?? null));
  });
}

test("GET /api/partners?v=2: cols, rows, labels, ETag and 304, ids mode", async () => {
  const r1 = await call("GET", "/api/partners?v=2");
  assert.equal(r1.status, 200);
  assert.match(r1.type, /application\/json/);
  assert.equal(r1.headers.get("cache-control"), "private, no-store");
  assert.match(r1.headers.get("x-generated-at") || "", /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
  assert.deepEqual(Object.keys(r1.json), ["v", "cols", "rows"], "the generation time is a header, not in the body");
  assert.equal(r1.json.v, 2);
  assert.deepEqual(r1.json.cols, V2_COLS);
  const ref = await referenceRows();
  assert.equal(r1.json.rows.length, ref.length);
  for (let i = 0; i < ref.length; i++) assert.deepEqual(r1.json.rows[i], ref[i], "row " + ref[i][0]);
  const li = V2_COLS.indexOf("label");
  const nameless = r1.json.rows.filter((r) => !r[1] && !r[2]);
  assert.equal(nameless.length, fx.counts.nameless);
  assert.ok(nameless.every((r) => r[li] && r[li] !== "Unnamed creator"), "nameless creators are labelled from a contact");
  assert.ok(!r1.text.match(/[^\s"@]+@[^\s"@]+\.[a-z]{2,}/i), "no email address in the list");

  // ETag: the same twice, a matching If-None-Match gets 304 with an empty body.
  const etag = r1.headers.get("etag");
  assert.match(etag || "", /^W\/"[0-9a-f]{16}"$/);
  const r2 = await call("GET", "/api/partners?v=2");
  assert.equal(r2.headers.get("etag"), etag, "no data change: same ETag");
  const r3 = await call("GET", "/api/partners?v=2", undefined, { "If-None-Match": etag });
  assert.equal(r3.status, 304);
  assert.equal(r3.text, "");
  assert.equal(r3.headers.get("etag"), etag);
  assert.equal((await call("GET", "/api/partners?v=2", undefined, { "If-None-Match": 'W/"0000000000000000"' })).status, 200);

  // ids mode: the same rows, no ETag, never 304, at most 90 ids.
  const pick = [r1.json.rows[5][0], nameless[0][0], "PG-00577", "NO-SUCH-ID", r1.json.rows[0][0]];
  const r4 = await call("GET", "/api/partners?v=2&ids=" + pick.map(encodeURIComponent).join(","), undefined, { "If-None-Match": etag });
  assert.equal(r4.status, 200);
  assert.equal(r4.headers.get("etag"), null);
  assert.deepEqual(r4.json.cols, V2_COLS);
  const want = ref.filter((r) => pick.includes(r[0]));
  assert.deepEqual(r4.json.rows, want, "ids rows = the list rows, sorted by id");
  const many = Array.from({ length: 91 }, (_, i) => "PG-" + String(i + 1).padStart(5, "0"));
  const r5 = await call("GET", "/api/partners?v=2&ids=" + many.join(","));
  assert.equal(r5.status, 400);
  assert.equal((await call("GET", "/api/partners?v=2&ids=" + many.slice(0, 90).join(","))).json.rows.length, 90);

  // A write changes the ETag.
  await applyBefore({ "PG-00594": { next_step: null } }, target);
  await call("PATCH", "/api/partner/PG-00594", { by: "Kamile", fields: { next_step: "Check the ETag" } });
  const r6 = await call("GET", "/api/partners?v=2", undefined, { "If-None-Match": etag });
  assert.equal(r6.status, 200);
  assert.notEqual(r6.headers.get("etag"), etag);
});

test("GET /api/partners without v=2 keeps the d5e91d9 bytes", async () => {
  // d5e91d9's row() verbatim, applied to SELECT * FROM partners ORDER BY id.
  const row = (r) => [r.id, r.domain || "", r.name || "", r.type || "", r.dr, r.traffic, r.owner || "", r.stage || "", r.last_touch || "",
    r.clients || "", r.country || "", r.contacts || 0, r.next_step || "", r.next_due || "",
    r.deal_model || "", r.deal_flat ?? null, r.deal_pct ?? null, r.deal_value ?? null, r.live_date || "", r.content_url || ""];
  const rows = await q("SELECT * FROM partners ORDER BY id");
  const r = await call("GET", "/api/partners");
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("content-type"), "application/json");
  assert.equal(r.headers.get("etag"), null);
  assert.equal(r.text, JSON.stringify(rows.map(row)));
});

// ---------- 7. POST /api/partner/:id/outcome (T22) ----------

async function outcomeInterested(where) {
  const patch = goldenCase("patch-partner", "interested");
  const act = goldenCase("activity-log", "interested");
  await applyBefore(patch.before, target);
  const n0 = await maxEditN(target);
  const body = { by: "Kamile", fields: patch.request.body.fields,
    activity: { type: act.request.body.type, summary: act.request.body.summary, client: act.request.body.client } };
  const r = await call("POST", "/api/partner/PG-00577/outcome", body);
  assert.equal(r.status, 201, where + ": " + r.text.slice(0, 300));
  const rows = await editsAfter(n0, target);
  const vars = assertGolden([...patch.edits, ...act.edits], rows, { vars: { activity_n: String(r.json.activity.n) }, message: where + ": outcome rows" });
  const [a] = await q("SELECT n FROM activity WHERE account_id = 'PG-00577' ORDER BY n DESC LIMIT 1");
  assert.equal(rows[rows.length - 1].field, String(a.n), "edits.field = activity.n");
  assert.deepEqual(r.json.changed, patch.response.changed);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.partner.stage, "Negotiating");
  assert.equal(r.json.partner.last_touch, vars.today, "Email sets last_touch");
  assert.equal(r.json.last_touch, vars.today);
  assert.deepEqual({ ...r.json.activity, n: String(r.json.activity.n) }, { ...act.response.activity, n: String(a.n), date: vars.today });
  const ids = await call("GET", "/api/partners?v=2&ids=PG-00577");
  assert.deepEqual(r.json.v2, ids.json.rows[0], "the response's v2 row = the list row");
  return r;
}

test("POST /outcome writes the golden PATCH rows, then the golden activity row", async () => {
  await outcomeInterested("with 003/004");

  // client defaults to the site's first client, by its display name.
  await applyBefore({ "PG-00593": { stage: "Contacted", clients: "Ultahost, Soro", next_step: null, next_due: null } }, target);
  let n0 = await maxEditN(target);
  let r = await call("POST", "/api/partner/PG-00593/outcome", { by: "Kamile", activity: { type: "Email", summary: "Sent a follow-up." } });
  assert.equal(r.status, 201);
  assert.equal(r.json.activity.client, "UltaHost");
  assert.deepEqual(r.json.changed, {});
  let rows = await editsAfter(n0, target);
  assert.equal(rows.length, 1);
  assert.equal(JSON.parse(rows[0].new).client, "UltaHost");

  // Fields only: the golden PATCH rows, 200, no activity.
  const deal = goldenCase("patch-partner", "deal-terms");
  await applyBefore(deal.before, target);
  n0 = await maxEditN(target);
  r = await call("POST", "/api/partner/PG-00578/outcome", { by: "Kamile", fields: deal.request.body.fields });
  assert.equal(r.status, 200);
  assert.equal(r.json.activity, null);
  assert.equal(r.json.last_touch, undefined);
  assertGolden(deal.edits, await editsAfter(n0, target));
  assert.deepEqual(r.json.changed, deal.response.changed);

  // Activity only: the golden activity row.
  const note = goldenCase("activity-log", "note-with-contact");
  n0 = await maxEditN(target);
  r = await call("POST", "/api/partner/PG-00583/outcome", { by: "Kamile", activity: { type: "Note", summary: note.request.body.summary,
    contact_id: note.request.body.contact_id, client: note.request.body.client } });
  assert.equal(r.status, 201);
  assertGolden(note.edits, await editsAfter(n0, target), { vars: { activity_n: String(r.json.activity.n) } });

  // Checks run first: nothing is written on any error.
  await applyBefore(goldenCase("patch-partner", "interested").before, target);
  n0 = await maxEditN(target);
  const [acts0] = await q("SELECT COUNT(*) AS c FROM activity");
  const bad = [
    [{ by: "Kamile", fields: { stage: "Bogus" }, activity: { type: "Email", summary: "x" } }, 400, "Pick a stage from the list."],
    [{ by: "Kamile", fields: { next_due: "31/10/2026" } }, 400, "Use a date like 2026-10-31."],
    [{ by: "Kamile", fields: { stage: "Negotiating" }, activity: { type: "Tweet", summary: "x" } }, 400, "Pick what happened."],
    [{ by: "Kamile", fields: { stage: "Negotiating" }, activity: { type: "Note", summary: "  " } }, 400, "Write a short summary."],
    [{ by: "Kamile" }, 400, null],
    [{ by: "Kamile", fields: {}, activity: null }, 400, null],
  ];
  for (const [b, status, msg] of bad) {
    const x = await call("POST", "/api/partner/PG-00577/outcome", b);
    assert.equal(x.status, status, JSON.stringify(b));
    if (msg) assert.deepEqual(x.json, { error: msg });
    else assert.ok(x.json && typeof x.json.error === "string" && x.json.error.length > 5);
  }
  const nf = await call("POST", "/api/partner/PG-99999/outcome", { by: "Kamile", fields: { stage: "Contacted" } });
  assert.equal(nf.status, 404);
  assert.deepEqual(nf.json, { error: "Not found" });
  assert.deepEqual(await editsAfter(n0, target), []);
  assert.deepEqual(await q("SELECT COUNT(*) AS c FROM activity"), [acts0]);
  assert.equal((await q("SELECT stage FROM partners WHERE id = 'PG-00577'"))[0].stage, "Replied");
});

// ---------- 8. atomic writes ----------

test("activity and outcome are atomic: a failing edits insert leaves no half-written change", async () => {
  // A partial unique index makes the second edits row carrying the marker fail inside the batch.
  await q("CREATE UNIQUE INDEX IF NOT EXISTS g1b_atomic ON edits (kind) WHERE instr(new, 'ATOMIC-FAIL') > 0");
  await q("INSERT INTO edits (at, by_whom, kind, account_id, new, applied) VALUES ('2000-01-01T00:00:00Z', 'test', 'activity', 'PG-00001', 'ATOMIC-FAIL', 1)");
  const [dummy] = await q("SELECT MAX(n) AS n FROM edits");
  try {
    await applyBefore({ "PG-00596": { stage: "Replied", last_touch: "2026-01-02", next_step: null, next_due: null } }, target);
    const n0 = await maxEditN(target);
    const [a0] = await q("SELECT COUNT(*) AS c FROM activity");
    const r1 = await call("POST", "/api/partner/PG-00596/activity", { by: "Kamile", type: "Email", summary: "ATOMIC-FAIL activity" });
    assert.ok(r1.status >= 500, "the batch fails: " + r1.status);
    const r2 = await call("POST", "/api/partner/PG-00596/outcome", { by: "Kamile", fields: { stage: "Negotiating", next_step: "Agree terms" },
      activity: { type: "Email", summary: "ATOMIC-FAIL outcome" } });
    assert.ok(r2.status >= 500, "the batch fails: " + r2.status);
    assert.deepEqual(await editsAfter(n0, target), [], "no edits rows");
    assert.deepEqual(await q("SELECT COUNT(*) AS c FROM activity"), [a0], "no activity row (d5e91d9 kept one here)");
    assert.deepEqual(await q("SELECT stage, last_touch, next_step FROM partners WHERE id = 'PG-00596'"),
      [{ stage: "Replied", last_touch: "2026-01-02", next_step: null }], "the partner row is unchanged");
  } finally {
    await q("DROP INDEX IF EXISTS g1b_atomic");
    await q("DELETE FROM edits WHERE n = " + Number(dummy.n));
  }
});

// ---------- 9. every write path still writes the golden rows ----------

test("every golden write path still writes its rows after the lib/crm.js refactor", async () => {
  const files = ["patch-partner", "activity-log", "bulk-update", "add-site", "add-contact", "client-program"];
  let n = 0;
  for (const file of files) {
    const g = loadGolden(file);
    for (const c of g.cases) {
      // d5e91d9 answers 400 for a client key with a space; B1 fixes clients/[k].js (NEEDS.md, T23).
      if (/d5e91d9-bug/.test(c.name)) continue;
      const r = await replayCase(c, { client, target, order: g.row_order });
      assert.ok(r.ok, file + "#" + c.name + "\n" + r.errors.join("\n"));
      n++;
      if (file === "add-site" && c.status === 201) {
        const v2 = r.response.json.v2;
        assert.ok(Array.isArray(v2) && v2.length === V2_COLS.length, "Add site returns v2");
        assert.equal(v2[0], r.response.json.row[0]);
        assert.equal(v2[V2_COLS.indexOf("label")], r.response.json.row[2] || r.response.json.row[1]);
      }
    }
  }
  assert.ok(n >= 40, "replayed " + n + " cases");
});
