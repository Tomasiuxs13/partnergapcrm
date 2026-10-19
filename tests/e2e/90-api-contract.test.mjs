// API contract (spec 6.3, 6.4, 6.6, 6.7, 6.3.14; T1, T1b, T1c, T9, T11, T12, T17, T22, T23, T24, T29, T30, T33,
// T35). Owner B1.
//   - every write path writes the golden edits rows (tests/e2e/golden): PATCH, outcome, activity, bulk ids
//     mode, bulk rows mode (= the PATCH rows), add site, add contact, program PUT (decoded key, T23), and
//     Add as contact from a suggestion (T33)
//   - bulk: changed is a number, only_if_empty, chunks of 90, Undo in rows mode (T11), stored client tokens
//     kept (T12), the Free-plan limits
//   - statements per request within the Free budget (50; spec 6.6), counted by the middleware on local hosts
//     (header X-PGCRM-Count: 1 -> X-D1-Statements)
//   - GET /api/edits: the d5e91d9 keys plus old, contact_id and state; paging and filters
//   - the read-only guard by host (T30), the exact contact duplicate check (T9), Settings (D1 only, admins),
//     suggestions and runs, team activity, the contacts index, about
//   - no email address in any response except the partner profile and the contacts index (spec 6.7)
//   - a second server without 003/004 (T29), then 004 and 003 applied while it runs
//   - in the browser: sign-in with a name and the deep link kept (T1), changing the name (T1b), "Someone
//     else" (T1c), a 401 on save (T17), sign-out clearing the page cache, and legacy.html (T24)
// Every write goes to this file's own fixture servers (startServer), never to the shared run.sh server.
// Run: bash tests/e2e/run.sh tests/e2e/90-api-contract.test.mjs   (screenshots: SHOTS_DIR, default /tmp/shots-b1)
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import {
  startServer, apiClient, d1, d1All, fixture, loadGolden, goldenCase, applyBefore, editsAfter, maxEditN, stripEdit,
  assertGolden, replayCase, sortEdits, sqlLit, signedInPage, browser, closeBrowser, PASSWORD,
} from "./lib.mjs";
import { V2_COLS } from "../../lib/crm.js";

const SHOTS = process.env.SHOTS_DIR || "/tmp/shots-b1";
const EMAIL_RE = /[^\s"'@<>(),;:]+@[^\s"'@<>(),;:]+\.[a-z]{2,}/i;
const FREE_BUDGET = 50;
const UNAVAILABLE = { error: "Not available yet", unavailable: true };

let server, client, target, fx;

before(async () => {
  server = await startServer({ extra: true });
  target = { persistDir: server.persistDir, root: server.root };
  client = await apiClient(server.baseUrl);
  fx = fixture({ today: server.today });
});

after(async () => {
  await closeBrowser();
  if (server) await server.stop();
});

const call = (method, url, body, headers) => client.call(method, url, body, headers);
const q = (sql) => d1(sql, target);
const ids = (group) => fx.groups[group].slice();
const inList = (list) => list.map(sqlLit).join(", ");

/** A call that also reports how many D1 statements the request ran. */
async function counted(method, url, body) {
  const r = await call(method, url, body, { "X-PGCRM-Count": "1" });
  const h = r.headers.get("x-d1-statements");
  assert.ok(h != null, "X-D1-Statements on " + method + " " + url + " (" + r.status + ")");
  return { ...r, statements: Number(h) };
}

/** Any request with any Host header (Node's fetch drops Host), signed in with the session cookie. */
function callAs(host, method, url, body, { base = server.baseUrl, cookie = client.cookie, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(base);
    const data = body === undefined ? null : JSON.stringify(body);
    const h = { Host: host, ...headers };
    if (cookie) h.Cookie = cookie;
    if (data) { h["Content-Type"] = "application/json"; h["Content-Length"] = Buffer.byteLength(data); }
    const req = http.request({ host: u.hostname, port: u.port, path: url, method, headers: h }, (res) => {
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
    if (data) req.write(data);
    req.end();
  });
}

function noEmail(r, where) {
  const m = EMAIL_RE.exec(r.text || "");
  assert.equal(m, null, where + " shows an email address: " + (m && m[0]));
}

// ---------- 1. golden write paths (T22, T23) ----------

test("every write path writes the golden edits rows (PATCH, activity, bulk ids, add site, add contact, program)", async () => {
  const files = ["patch-partner", "activity-log", "bulk-update", "add-site", "add-contact", "client-program"];
  let n = 0;
  for (const file of files) {
    const g = loadGolden(file);
    for (const c of g.cases) {
      let r;
      if (/d5e91d9-bug/.test(c.name)) {
        // T23: the key is decoded now, so the request writes client-program#partial's row with
        // field = the stored key "botanical synthesis".
        const partial = goldenCase("client-program", "partial");
        const fixed = { ...c, status: 200, response: { ok: true }, edits: partial.edits.map((e) => ({ ...e, field: "botanical synthesis" })) };
        r = await replayCase(fixed, { client, target });
        assert.ok(r.ok, file + "#" + c.name + " (decoded)\n" + r.errors.join("\n"));
        const prog = await call("GET", "/api/clients");
        assert.ok(JSON.stringify(prog.json).includes("botanical synthesis"), "GET /api/clients finds the program row");
      } else {
        r = await replayCase(c, { client, target, order: g.row_order });
        assert.ok(r.ok, file + "#" + c.name + "\n" + r.errors.join("\n"));
      }
      n++;
      if (file === "bulk-update" && c.status === 200) {
        const j = r.response.json;
        assert.equal(typeof j.changed, "number", "bulk changed is a number (legacy.html)");
        assert.equal(j.changed, j.changed_ids.length);
        assert.deepEqual(j.failed, []);
        for (const id of j.changed_ids) {
          assert.ok(j.before[id] && "owner" in j.before[id] && "clients" in j.before[id], "before has the columns of " + id);
          assert.equal(j.v2[id].length, V2_COLS.length, "v2 row of " + id);
          assert.equal(j.v2[id][0], id);
        }
      }
      if (file === "patch-partner" && c.status === 200) assert.equal(r.response.json.v2.length, V2_COLS.length, "PATCH returns v2");
    }
  }
  assert.ok(n >= 46, "replayed " + n + " cases");
});

test("outcome = the golden PATCH rows, then the golden activity row (Interested)", async () => {
  const patch = goldenCase("patch-partner", "interested");
  const act = goldenCase("activity-log", "interested");
  await applyBefore(patch.before, target);
  const n0 = await maxEditN(target);
  const r = await counted("POST", "/api/partner/PG-00577/outcome", { by: "Kamile", fields: patch.request.body.fields,
    activity: { type: act.request.body.type, summary: act.request.body.summary, client: act.request.body.client } });
  assert.equal(r.status, 201, r.text.slice(0, 300));
  assertGolden([...patch.edits, ...act.edits], await editsAfter(n0, target), { vars: { activity_n: String(r.json.activity.n) } });
  assert.ok(r.statements <= FREE_BUDGET, "outcome ran " + r.statements + " statements");
});

// ---------- 2. bulk rows mode (Undo) = the PATCH rows ----------

test("bulk rows mode writes exactly the PATCH golden rows, in request order", async () => {
  const g = loadGolden("patch-partner");
  const ok = g.cases.filter((c) => c.status === 200);
  const idOf = (c) => c.request.url.split("/").pop();
  // One site per request: each = its PATCH case.
  for (const c of ok) {
    await applyBefore(c.before, target);
    const id = idOf(c);
    const n0 = await maxEditN(target);
    const r = await counted("POST", "/api/bulk", { by: "Kamile", rows: [{ id, fields: c.request.body.fields }] });
    assert.equal(r.status, 200, c.name + ": " + r.text.slice(0, 300));
    assertGolden(c.edits, await editsAfter(n0, target), { message: "rows mode " + c.name });
    assert.equal(r.json.changed, c.edits.length ? 1 : 0, c.name + ": changed");
    assert.deepEqual(r.json.changed_ids, c.edits.length ? [id] : []);
    assert.deepEqual(r.json.failed, []);
    if (c.edits.length) {
      for (const e of c.edits) {
        const old = r.json.before[id][e.field];
        assert.equal(old == null ? null : String(old), e.old, c.name + " before." + e.field);
      }
      assert.equal(r.json.v2[id].length, V2_COLS.length);
    }
  }
  // All of them in one request: the same rows, site after site.
  for (const c of ok) await applyBefore(c.before, target);
  const n0 = await maxEditN(target);
  const r = await counted("POST", "/api/bulk", { by: "Kamile", rows: ok.map((c) => ({ id: idOf(c), fields: c.request.body.fields })) });
  assert.equal(r.status, 200);
  assertGolden(ok.flatMap((c) => c.edits), await editsAfter(n0, target), { message: "one rows-mode request" });
  assert.equal(r.json.changed, ok.filter((c) => c.edits.length).length);
  assert.ok(r.statements <= FREE_BUDGET, "rows mode ran " + r.statements);

  // Bad rows are reported, the others are saved.
  await applyBefore({ "PG-00593": { stage: "Contacted", next_due: null }, "PG-00594": { next_step: null } }, target);
  const n1 = await maxEditN(target);
  const bad = await call("POST", "/api/bulk", { by: "Kamile", rows: [
    { id: "PG-00593", fields: { stage: "Bogus" } }, { id: "PG-99999", fields: { stage: "Contacted" } },
    { id: "PG-00594", fields: { next_step: "Rows mode check" } }] });
  assert.equal(bad.status, 200);
  assert.deepEqual(bad.json.failed, [{ ids: ["PG-00593"], error: "Pick a stage from the list." }, { ids: ["PG-99999"], error: "Not found" }]);
  assert.deepEqual(bad.json.changed_ids, ["PG-00594"]);
  assert.deepEqual((await editsAfter(n1, target)).map(stripEdit), [{ by_whom: "Kamile", kind: "update", account_id: "PG-00594", contact_id: null,
    field: "next_step", old: null, new: "Rows mode check", applied: 0 }]);

  // At most meta.limits.bulk_rows sites (20 on Free) per request.
  const meta = await call("GET", "/api/meta");
  assert.equal(meta.json.limits.bulk_rows, 20);
  const many = ids("kamile-contacted-nodate").slice(0, 21).map((id) => ({ id, fields: { next_step: "x" } }));
  const tooMany = await call("POST", "/api/bulk", { by: "Kamile", rows: many });
  assert.equal(tooMany.status, 400);
  assert.deepEqual(tooMany.json, { error: "Send at most 20 sites at a time." });
  assert.equal((await call("POST", "/api/bulk", { by: "Kamile", rows: [] })).status, 400);
  assert.equal(await maxEditN(target), n1 + 1, "the refused requests wrote nothing");
});

// ---------- 3. bulk ids mode: T11, T12, only_if_empty, limits ----------

test("T11: Follow up next week on 100 sites in chunks of 90, only_if_empty keeps next steps, Undo in rows of 20", async () => {
  const list = ids("kamile-contacted-nodate").slice(20, 120);
  assert.equal(list.length, 100);
  const kept = list.slice(0, 5);
  await d1All(kept.map((id, i) => `UPDATE partners SET next_step = 'Kept step ${i}' WHERE id = ${sqlLit(id)}`).join(";\n") + ";", target);
  const read = async () => new Map((await q(`SELECT id, next_step, next_due FROM partners WHERE id IN (${inList(list)})`)).map((r) => [r.id, r]));
  const orig = await read();
  const fields = { next_step: "Follow up", next_due: "2026-11-09" };
  const wantStep = list.filter((id) => !orig.get(id).next_step);
  const wantDue = list.filter((id) => orig.get(id).next_due !== fields.next_due);
  const n0 = await maxEditN(target);
  const merged = { changed: 0, changed_ids: [], before: {}, v2: {} };
  for (const part of [list.slice(0, 90), list.slice(90)]) {
    const r = await counted("POST", "/api/bulk", { by: "Kamile", ids: part, fields, only_if_empty: ["next_step"] });
    assert.equal(r.status, 200, r.text.slice(0, 300));
    assert.ok(r.statements <= FREE_BUDGET, "ids mode (90 ids, 2 fields) ran " + r.statements);
    assert.equal(typeof r.json.changed, "number");
    merged.changed += r.json.changed;
    merged.changed_ids.push(...r.json.changed_ids);
    Object.assign(merged.before, r.json.before);
    Object.assign(merged.v2, r.json.v2);
  }
  const changed = list.filter((id) => wantStep.includes(id) || wantDue.includes(id));
  assert.equal(merged.changed, changed.length);
  assert.deepEqual(merged.changed_ids, changed);
  assert.deepEqual(Object.keys(merged.v2).sort(), changed.slice().sort(), "v2 rows for the changed sites (no list re-download)");
  const now1 = await read();
  for (const [i, id] of kept.entries()) assert.equal(now1.get(id).next_step, "Kept step " + i, "only_if_empty kept " + id);
  for (const id of wantStep) assert.equal(now1.get(id).next_step, "Follow up");
  for (const id of list) assert.equal(now1.get(id).next_due, "2026-11-09");
  const rows = await editsAfter(n0, target);
  assert.equal(rows.length, wantStep.length + wantDue.length);
  assert.ok(rows.every((e) => e.kind === "update" && e.by_whom === "Kamile" && e.applied === 0));
  // Undo: rows mode from `before`, 20 sites per request.
  const undo = merged.changed_ids.map((id) => ({ id, fields: { next_step: merged.before[id].next_step, next_due: merged.before[id].next_due } }));
  const n1 = await maxEditN(target);
  for (let i = 0; i < undo.length; i += 20) {
    const r = await counted("POST", "/api/bulk", { by: "Kamile", rows: undo.slice(i, i + 20) });
    assert.equal(r.status, 200, r.text.slice(0, 300));
    assert.ok(r.statements <= FREE_BUDGET, "rows mode (20 sites) ran " + r.statements);
    assert.deepEqual(r.json.failed, []);
  }
  const back = await read();
  for (const id of list) assert.deepEqual(back.get(id), orig.get(id), "Undo restored " + id);
  assert.equal((await editsAfter(n1, target)).length, rows.length, "Undo writes the reverse rows");
});

test("T12: stored client tokens are kept (bulk add Soro, PATCH add Soro)", async () => {
  const ml = fx.partners.find((p) => p.clients === "MailerLite/MailerSend").id;
  const ul = fx.partners.find((p) => p.clients === "Ultahost" && !fx.groups["kamile-new-sugg"].includes(p.id)).id;
  let n0 = await maxEditN(target);
  const r = await call("POST", "/api/bulk", { by: "Kamile", ids: [ml, ul], fields: { add_client: "Soro" } });
  assert.equal(r.status, 200);
  assert.equal(r.json.changed, 2);
  assert.deepEqual(sortEdits((await editsAfter(n0, target)).map(stripEdit)), sortEdits([
    { by_whom: "Kamile", kind: "update", account_id: ml, contact_id: null, field: "clients", old: "MailerLite/MailerSend", new: "MailerLite/MailerSend, Soro", applied: 0 },
    { by_whom: "Kamile", kind: "update", account_id: ul, contact_id: null, field: "clients", old: "Ultahost", new: "Ultahost, Soro", applied: 0 },
  ]));
  // Already there (any case or spacing; "/" separates tokens too): nothing changes.
  n0 = await maxEditN(target);
  for (const [id, v] of [[ml, "soro"], [ul, " SORO "], [ml, "MailerSend"], [ml, "mailerlite"], [ul, "UltaHost"]]) {
    const again = await call("POST", "/api/bulk", { by: "Kamile", ids: [id], fields: { add_client: v } });
    assert.equal(again.json.changed, 0, id + " " + v);
  }
  assert.equal(await maxEditN(target), n0);
  // The inline editor saves the whole text through PATCH: existing tokens stay as they are.
  await applyBefore({ [ul]: { clients: "Ultahost" } }, target);
  const p = await call("PATCH", "/api/partner/" + ul, { by: "Kamile", fields: { clients: "Ultahost, Soro" } });
  assert.equal(p.json.partner.clients, "Ultahost, Soro");
  // A Melograno product token is added by its product; bad names are refused.
  await applyBefore({ [ul]: { clients: "Ultahost" } }, target);
  const mel = await call("POST", "/api/bulk", { by: "Kamile", ids: [ul], fields: { add_client: "melograno - trafft" } });
  assert.equal(mel.json.changed, 1);
  assert.equal((await q(`SELECT clients FROM partners WHERE id = ${sqlLit(ul)}`))[0].clients, "Ultahost, Melograno - Trafft");
  for (const v of ["A, B", "a/b", "x", "50%_off"]) {
    const b = await call("POST", "/api/bulk", { by: "Kamile", ids: [ul], fields: { add_client: v } });
    assert.equal(b.status, 400, v);
    assert.deepEqual(b.json, { error: "Client names are 2–40 characters, without commas or slashes." });
  }
});

test("bulk ids mode: type, unknown ids, 100 ids in one request, and the Free-plan size limit", async () => {
  const list = ids("kamile-contacted-nodate").slice(120, 125);
  await d1All(`UPDATE partners SET type = 'Review' WHERE id = ${sqlLit(list[0])}; UPDATE partners SET type = NULL WHERE id = ${sqlLit(list[1])};`, target);
  const n0 = await maxEditN(target);
  const r = await call("POST", "/api/bulk", { by: "Kamile", ids: [...list.slice(0, 2), "PG-99999"], fields: { type: "Review" }, only_if_empty: ["type", "owner"] });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.changed_ids, [list[1]]);
  assert.deepEqual(r.json.failed, [{ ids: ["PG-99999"], error: "Not found" }]);
  assert.deepEqual((await editsAfter(n0, target)).map((e) => [e.account_id, e.field, e.old, e.new]), [[list[1], "type", null, "Review"]]);
  // legacy.html may send more than 90 ids: the server splits them, and leaves v2 out above 90.
  const hundred = ids("kamile-contacted-nodate").slice(0, 100);
  const big = await counted("POST", "/api/bulk", { by: "Kamile", ids: hundred, fields: { next_step: "Hundred check" } });
  assert.equal(big.status, 200);
  assert.equal(big.json.changed, 100);
  assert.deepEqual(big.json.v2, {});
  assert.ok(big.statements <= FREE_BUDGET, "100 ids ran " + big.statements);
  // Six fields on 270 ids (unknown ids: the statements run, nothing matches) fit the Free budget; more do not.
  const fake = (n) => Array.from({ length: n }, (_, i) => "ZZ-" + String(i).padStart(5, "0"));
  const six = { owner: "Kamile", stage: "Contacted", next_due: "2026-11-09", next_step: "x", type: "Review", add_client: "Soro" };
  const ok = await counted("POST", "/api/bulk", { by: "Kamile", ids: fake(270), fields: six });
  assert.equal(ok.status, 200, ok.text.slice(0, 200));
  assert.equal(ok.json.changed, 0);
  assert.ok(ok.statements <= FREE_BUDGET, "270 ids x 6 fields ran " + ok.statements);
  const tooMany = await call("POST", "/api/bulk", { by: "Kamile", ids: fake(271), fields: six });
  assert.equal(tooMany.status, 400);
  assert.deepEqual(tooMany.json, { error: "Send at most 270 sites at a time." });
  const one = await counted("POST", "/api/bulk", { by: "Kamile", ids: fake(500), fields: { owner: "Kamile" } });
  assert.equal(one.status, 200, "one field: 500 ids");
  assert.ok(one.statements <= FREE_BUDGET, "500 ids x 1 field ran " + one.statements);
});

// ---------- 4. GET /api/edits ----------

test("GET /api/edits: the d5e91d9 keys plus old, contact_id and state; paging and filters", async () => {
  const LEGACY_KEYS = ["n", "at", "by_whom", "kind", "account_id", "field", "new", "applied"];
  const r = await counted("GET", "/api/edits");
  assert.equal(r.status, 200);
  assert.deepEqual(Object.keys(r.json), ["pending", "recent"], "no params: the same top-level keys as today");
  assert.equal(r.json.recent.length, 40);
  assert.deepEqual(Object.keys(r.json.recent[0]), [...LEGACY_KEYS, "old", "contact_id", "state"]);
  const [{ c: pending }] = await q("SELECT COUNT(*) AS c FROM edits WHERE applied = 0");
  assert.equal(r.json.pending, pending);
  const db40 = await q("SELECT n, at, by_whom, kind, account_id, field, new, applied FROM edits ORDER BY n DESC LIMIT 40");
  r.json.recent.forEach((row, i) => {
    for (const k of LEGACY_KEYS) {
      if (k === "new" && typeof db40[i].new === "string" && EMAIL_RE.test(db40[i].new)) continue; // emails are hidden (6.7)
      assert.deepEqual(row[k], db40[i][k], "recent[" + i + "]." + k);
    }
  });
  assert.ok(r.statements <= FREE_BUDGET);

  // States: copied (applied = 1), not_copied (applied = 0 below the highest applied n; the fixture's
  // conflict n = 7 sits under max applied 18), waiting (the rest).
  const all = [];
  let before = "";
  for (let page = 0; page < 50; page++) {
    const p = await counted("GET", "/api/edits?limit=200" + (before ? "&before=" + before : ""));
    assert.equal(p.status, 200);
    assert.deepEqual(Object.keys(p.json), ["pending", "recent", "next_before", "max_applied_n"]);
    assert.equal(p.json.max_applied_n, 18);
    assert.ok(p.statements <= FREE_BUDGET);
    all.push(...p.json.recent);
    if (p.json.next_before == null) break;
    assert.equal(p.json.next_before, p.json.recent[p.json.recent.length - 1].n);
    before = String(p.json.next_before);
  }
  const [{ c: total }] = await q("SELECT COUNT(*) AS c FROM edits");
  assert.equal(all.length, total, "paging reaches every row");
  assert.equal(new Set(all.map((e) => e.n)).size, total, "once");
  for (const e of all) assert.equal(e.state, e.applied === 1 ? "copied" : e.n < 18 ? "not_copied" : "waiting", "state of n " + e.n);
  assert.equal(all.find((e) => e.n === 7).state, "not_copied");
  for (const st of ["waiting", "copied", "not_copied"]) {
    const f = await call("GET", "/api/edits?state=" + st + "&limit=200");
    assert.ok(f.json.recent.length > 0, st);
    assert.ok(f.json.recent.every((e) => e.state === st), st);
  }
  const by = await call("GET", "/api/edits?by=Vik&limit=200");
  assert.ok(by.json.recent.length > 0 && by.json.recent.every((e) => e.by_whom === "Vik"));
  const acc = await call("GET", "/api/edits?account=PG-00577");
  assert.ok(acc.json.recent.length > 0 && acc.json.recent.every((e) => e.account_id === "PG-00577"));
  const day = all[all.length - 1].at.slice(0, 10);
  const dated = await call("GET", "/api/edits?from=" + day + "&to=" + day + "&limit=200");
  assert.ok(dated.json.recent.length > 0 && dated.json.recent.every((e) => e.at.slice(0, 10) === day));
  const small = await call("GET", "/api/edits?limit=5");
  assert.equal(small.json.recent.length, 5);
  assert.equal(small.json.next_before, small.json.recent[4].n);
  const next = await call("GET", "/api/edits?limit=5&before=" + small.json.next_before);
  assert.ok(next.json.recent.every((e) => e.n < small.json.next_before), "the next page starts below");
  for (const badQ of ["state=nope", "before=abc", "from=31/10/2026"]) assert.equal((await call("GET", "/api/edits?" + badQ)).status, 400, badQ);
});

// ---------- 5. statements per request (spec 6.6) ----------

test("every endpoint stays within the Free plan's 50 statements per request", async () => {
  const sugg = fx.suggestions.find((s) => s.status === "open" && s.kind === "email").id;
  const reqs = [
    ["GET", "/api/meta"], ["GET", "/api/partners?v=2"], ["GET", "/api/partners"], ["GET", "/api/partners?v=2&ids=PG-00001,PG-00002"],
    ["GET", "/api/partner/PG-00377"], ["GET", "/api/partner/PG-00377/about"], ["GET", "/api/edits"], ["GET", "/api/edits?limit=200"],
    ["GET", "/api/team-activity?days=30"], ["GET", "/api/suggestions?owner=Kamile"], ["GET", "/api/suggestions?account=PG-00002"],
    ["GET", "/api/suggestions"], ["GET", "/api/runs?limit=50"], ["GET", "/api/settings"], ["GET", "/api/contacts-index"], ["GET", "/api/clients"],
    ["PATCH", "/api/partner/PG-00578", { by: "Kamile", fields: goldenCase("patch-partner", "deal-terms").request.body.fields }],
    ["POST", "/api/partner/PG-00596/activity", { by: "Kamile", type: "Call", summary: "Budget check" }],
    ["POST", "/api/partner/PG-00596/outcome", { by: "Kamile", fields: { stage: "Negotiating", next_step: "Agree terms" }, activity: { type: "Email", summary: "Budget" } }],
    ["POST", "/api/partners", { by: "Kamile", name: "Budget Check Site", domain: "budget-check.example.test" }],
    ["POST", "/api/partner/PG-00596/contacts", { by: "Kamile", first_name: "Budget", email: "budget@budget-check.example.test" }],
    ["PUT", "/api/clients/soro", goldenCase("client-program", "soro-full").request.body],
    ["POST", "/api/suggestions/" + encodeURIComponent(sugg), { by: "Kamile", status: "dismissed" }],
    ["POST", "/api/suggestions/" + encodeURIComponent(sugg), { by: "Kamile", status: "open" }],
    ["PUT", "/api/settings", { by: "Jonas", allow_dnc: false }],
  ];
  // The worst rows-mode request: 20 sites with every editable field changed.
  const rowsIds = ids("kamile-contacted-nodate").slice(130, 150);
  const all13 = { stage: "Negotiating", owner: "Gaby", clients: "Soro", type: "Review", next_step: "Agree terms", next_due: "2026-11-09",
    deal_model: "Flat fee", deal_flat: "100", deal_pct: "10", deal_value: "1000", content_url: "https://x.example.test/a", live_date: "2026-10-01", tracking_id: "T-1" };
  reqs.push(["POST", "/api/bulk", { by: "Kamile", rows: rowsIds.map((id) => ({ id, fields: all13 })) }]);
  // The worst ids-mode request the page sends: 90 sites, every field.
  reqs.push(["POST", "/api/bulk", { by: "Kamile", ids: ids("kamile-contacted-nodate").slice(0, 90),
    fields: { owner: "Gaby", stage: "Replied", next_due: "2026-11-10", next_step: "Answer", type: "Review", add_client: "Weglot" } }]);
  const counts = [];
  for (const [m, u, b] of reqs) {
    const r = await counted(m, u, b);
    assert.ok(r.status < 300, m + " " + u + ": " + r.status + " " + r.text.slice(0, 200));
    counts.push(m + " " + u.split("?")[0] + " " + r.statements);
    assert.ok(r.statements <= FREE_BUDGET, m + " " + u + " ran " + r.statements + " statements");
  }
  console.log("# statements: " + counts.join(", "));
  const [{ c: saved }] = await q(`SELECT COUNT(*) AS c FROM partners WHERE id IN (${inList(rowsIds)}) AND stage = 'Negotiating' AND tracking_id = 'T-1'`);
  assert.equal(saved, 20, "the 20-site rows request saved");
  // The count is a local test aid only: other hosts never get it.
  const prod = await callAs("partnergap-crm.pages.dev", "GET", "/api/meta", undefined, { headers: { "X-PGCRM-Count": "1" } });
  assert.equal(prod.status, 200);
  assert.equal(prod.headers["x-d1-statements"], undefined);
});

// ---------- 6. read-only hosts (T30) ----------

test("T30: preview hosts are read-only; production and local hosts write; a read-only GET never writes kv_meta", async () => {
  const preview = "crm-easy-site.partnergap-crm.pages.dev";
  const writes = [["POST", "/api/bulk", { by: "Kamile", ids: ["PG-00593"], fields: { next_step: "No" } }],
    ["PATCH", "/api/partner/PG-00593", { by: "Kamile", fields: { next_step: "No" } }], ["PUT", "/api/clients/soro", { by: "Kamile", network: "x" }],
    ["PUT", "/api/settings", { by: "Jonas", allow_dnc: true }], ["DELETE", "/api/partner/PG-00593"], ["POST", "/api/nope", {}],
    ["POST", "/api/partners", { by: "Kamile", name: "Preview" }]];
  const n0 = await maxEditN(target);
  for (const host of [preview, "preview.partnergap-crm.pages.dev", "partnergap-crm.example.test"]) {
    for (const [m, u, b] of writes) {
      const r = await callAs(host, m, u, b);
      assert.equal(r.status, 403, host + " " + m + " " + u);
      assert.deepEqual(r.json, { error: "This copy is read-only." });
      assert.match(r.headers["content-type"], /application\/json/);
    }
    const meta = await callAs(host, "GET", "/api/meta");
    assert.equal(meta.status, 200);
    assert.equal(meta.json.read_only, true, host);
  }
  assert.equal(await maxEditN(target), n0, "nothing written");
  for (const host of ["partnergap-crm.pages.dev", "localhost", "127.0.0.1"]) {
    assert.equal((await callAs(host, "GET", "/api/meta")).json.read_only, false, host);
  }
  const prodWrite = await callAs("partnergap-crm.pages.dev", "PATCH", "/api/partner/PG-00593", { by: "Kamile", fields: { next_step: "Prod host" } });
  assert.equal(prodWrite.status, 200, "the production host writes");
  // Sign-in still works on a preview (it is not an /api/ write).
  assert.equal((await callAs(preview, "GET", "/login", undefined, { cookie: "" })).status, 200);
  // A data change moves the sheet signature: a preview GET leaves kv_meta alone, a local GET records it.
  const kv = () => q("SELECT k, v, at FROM kv_meta WHERE k IN ('sheet_sig', 'last_sheet_change') ORDER BY k");
  await call("GET", "/api/meta");
  const k0 = await kv();
  await q("INSERT INTO partners (id, name) VALUES ('PG-09990', 'Signature probe')");
  try {
    await callAs(preview, "GET", "/api/meta");
    await callAs(preview, "GET", "/api/partners?v=2");
    assert.deepEqual(await kv(), k0, "no kv_meta write on a read-only GET");
    await call("GET", "/api/meta");
    assert.notDeepEqual(await kv(), k0, "a writable host records the change");
  } finally {
    await q("DELETE FROM partners WHERE id = 'PG-09990'");
  }
  // The catch-all (T35).
  const nope = await call("GET", "/api/nope");
  assert.equal(nope.status, 404);
  assert.deepEqual(nope.json, UNAVAILABLE);
});

// ---------- 7. contacts: exact duplicate check (T9) and Add as contact (T33) ----------

test("T9: the duplicate check matches whole addresses only, also inside a stored list", async () => {
  const site = "PG-00596";
  const add = (email, extra = {}) => call("POST", "/api/partner/" + site + "/contacts", { by: "Kamile", first_name: "Dup", email, ...extra });
  const n0 = await maxEditN(target);
  // ann@x.example.test and joann@x.example.test both exist; parts of addresses are not duplicates.
  for (const email of ["oann@x.example.test", "nn@x.example.test", "a@y.example.tes", "b@y.example.tes", "y@y.example.test"]) {
    const r = await add(email);
    assert.equal(r.status, 201, email + ": " + r.text.slice(0, 200));
  }
  const [ann] = await q("SELECT id, account_id FROM contacts WHERE email = 'ann@x.example.test'");
  const [joann] = await q("SELECT id, account_id FROM contacts WHERE email = 'joann@x.example.test'");
  for (const [email, want] of [["ann@x.example.test", ann], ["  JoAnn@X.example.test ", joann], ["b@y.example.test", null], ["a@y.example.test", null]]) {
    const r = await add(email);
    assert.equal(r.status, 409, email);
    assert.equal(r.json.error, "This email is already in the CRM");
    assert.deepEqual(Object.keys(r.json.duplicate), ["id", "account_id", "owner", "name", "domain"]);
    if (want) assert.deepEqual([r.json.duplicate.id, r.json.duplicate.account_id], [want.id, want.account_id], email);
    noEmail(r, "409 for " + email);
  }
  assert.equal((await add("ann@x.example.test", { force: true })).status, 201, "Add anyway");
  // LIKE wildcards in the typed address are plain characters.
  await q("INSERT INTO contacts (id, account_id, first_name, email) VALUES ('C-T9-1', 'PG-00596', 'Wild', 'a1b@w.example.test')");
  try {
    assert.equal((await add("a_b@w.example.test")).status, 201, "_ is not a wildcard");
  } finally {
    await q("DELETE FROM contacts WHERE id = 'C-T9-1'");
  }
  const rows = await editsAfter(n0, target);
  assert.equal(rows.length, 7);
  assert.ok(rows.every((e) => e.kind === "create_contact" && e.account_id === site));
});

test("T33: Add as contact writes the golden create_contact row and marks the suggestion used; Dismiss writes no edits row", async () => {
  const s = fx.suggestions.find((x) => x.kind === "candidate" && x.status === "open" && x.linkedin && x.title);
  const [first, ...rest] = s.name.split(" ");
  const n0 = await maxEditN(target);
  const r = await call("POST", "/api/partner/" + s.account_id + "/contacts", { by: "Kamile", first_name: first, last_name: rest.join(" "),
    title: s.title, linkedin: s.linkedin, client: s.client });
  assert.equal(r.status, 201);
  // The golden create_contact shape (add-contact#full): same keys in the same order, email "" when none.
  const vars = assertGolden([{ by_whom: "Kamile", kind: "create_contact", account_id: s.account_id, contact_id: "{{new_contact_id}}", field: null, old: null,
    new: JSON.stringify({ first_name: first, last_name: rest.join(" "), title: s.title, email: "", linkedin: s.linkedin, client: s.client }), applied: 0 }],
  await editsAfter(n0, target));
  assert.equal(vars.new_contact_id, r.json.contact.id);
  assert.deepEqual(Object.keys(JSON.parse(goldenCase("add-contact", "full").edits[0].new)), ["first_name", "last_name", "title", "email", "linkedin", "client"]);
  const n1 = await maxEditN(target);
  const used = await counted("POST", "/api/suggestions/" + encodeURIComponent(s.id), { by: "Kamile", status: "used" });
  assert.equal(used.status, 200, used.text.slice(0, 200));
  const { reviewed_at: at, ...rest1 } = used.json.suggestion;
  assert.deepEqual(rest1, { id: s.id, account_id: s.account_id, kind: "candidate", status: "used", reviewed_by: "Kamile" });
  assert.match(at, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
  assert.equal(used.json.v2[0], s.account_id);
  assert.equal(await maxEditN(target), n1, "no edits row for a suggestion status");
  const list = await call("GET", "/api/suggestions?account=" + s.account_id);
  assert.equal(list.json.rows.find((x) => x.id === s.id).status, "used");
  const profile = await call("GET", "/api/partner/" + s.account_id);
  assert.ok(!profile.json.suggestions.some((x) => x.id === s.id), "the profile lists open suggestions only");

  // Dismiss (the raw id with its colons works too), then open again.
  const d = fx.suggestions.find((x) => x.kind === "email" && x.status === "open" && x.account_id !== s.account_id);
  const dis = await call("POST", "/api/suggestions/" + d.id, { by: "Gaby", status: "dismissed" });
  assert.equal(dis.status, 200);
  assert.equal(dis.json.suggestion.reviewed_by, "Gaby");
  assert.equal(await maxEditN(target), n1);
  const owner = fx.partners.find((p) => p.id === d.account_id).owner;
  const open = await call("GET", "/api/suggestions?owner=" + encodeURIComponent(owner));
  assert.ok(!open.json.rows.some((x) => x.id === d.id), "a dismissed suggestion leaves the open list");
  const reopen = await call("POST", "/api/suggestions/" + encodeURIComponent(d.id), { by: "Gaby", status: "open" });
  assert.deepEqual([reopen.json.suggestion.status, reopen.json.suggestion.reviewed_by, reopen.json.suggestion.reviewed_at], ["open", null, null]);
  const nf = await call("POST", "/api/suggestions/nope", { by: "Kamile", status: "used" });
  assert.equal(nf.status, 404);
  assert.deepEqual(nf.json, { error: "Not found" });
  assert.equal((await call("POST", "/api/suggestions/" + encodeURIComponent(d.id), { by: "Kamile", status: "done" })).status, 400);
  assert.equal(await maxEditN(target), n1);
});

// ---------- 8. reads: suggestions, runs, team activity, contacts index, profile, about ----------

test("suggestions, runs, team activity, the contacts index, the profile and about", async () => {
  const all = await call("GET", "/api/suggestions?status=all");
  assert.equal(all.status, 200);
  assert.equal(all.json.rows.length, fx.suggestions.length);
  const keys = Object.keys(all.json.rows[0]);
  for (const k of ["id", "run_date", "kind", "account_id", "client", "name", "title", "linkedin", "source", "subject", "body", "note",
    "status", "reviewed_by", "reviewed_at", "owner", "has_email"]) assert.ok(keys.includes(k), k);
  assert.ok(!keys.includes("to_email"), "to_email stays out of the list (has_email says whether there is one)");
  assert.equal(all.json.rows.find((x) => x.account_id === "PG-00377").has_email, true);
  const kam = await call("GET", "/api/suggestions?owner=Kamile");
  assert.ok(kam.json.rows.length > 0 && kam.json.rows.every((x) => x.owner === "Kamile" && x.status === "open"));
  assert.equal((await call("GET", "/api/suggestions?status=nope")).status, 400);

  const runs = await call("GET", "/api/runs?limit=2");
  assert.deepEqual(runs.json.rows.map((r) => r.n), [3, 2]);
  assert.equal(runs.json.rows[0].summary.edits_applied, 14, "summary is parsed");

  const ta = await counted("GET", "/api/team-activity?days=7");
  assert.equal(ta.status, 200);
  assert.equal(ta.json.days, 7);
  assert.match(ta.json.since, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
  const k = ta.json.by.Kamile;
  assert.deepEqual(Object.keys(k), ["total", "update", "activity", "create_account", "create_contact", "client_program", "last_at"]);
  assert.equal(k.total, k.update + k.activity + k.create_account + k.create_contact + k.client_program);
  const [{ c: kc }] = await q(`SELECT COUNT(*) AS c FROM edits WHERE by_whom = 'Kamile' AND at >= ${sqlLit(ta.json.since)}`);
  assert.equal(k.total, kc);

  const ci = await counted("GET", "/api/contacts-index");
  assert.equal(ci.status, 200);
  assert.deepEqual(ci.json.cols, ["id", "account_id", "name", "email_lc"]);
  const [{ c: cc }] = await q("SELECT COUNT(*) AS c FROM contacts");
  assert.equal(ci.json.rows.length, cc);
  assert.ok(ci.json.rows.some((r) => r[3] === "ann@x.example.test" && r[2] === "Ann Hill"));
  assert.equal(ci.headers.get("cache-control"), "private, no-store");

  const p = await counted("GET", "/api/partner/PG-00377");
  assert.equal(p.status, 200);
  for (const key of ["partner", "contacts", "activity", "about", "about_pending", "history", "suggestions"]) assert.ok(key in p.json, key);
  assert.ok(p.json.contacts.some((c) => c.email === "joann@x.example.test"), "the profile keeps emails");
  assert.ok(Array.isArray(p.json.suggestions) && p.json.suggestions.some((x) => x.to_email), "open suggestions in full");
  const hist = await call("GET", "/api/partner/PG-00577");
  assert.deepEqual(Object.keys(hist.json.history.edits[0]), ["n", "at", "by_whom", "kind", "field", "old", "new", "state", "contact_id"]);
  assert.ok(hist.json.history.edits.length <= 200);
  assert.ok(hist.json.activity.every((a) => "n" in a));
  const nf = await call("GET", "/api/partner/PG-99999");
  assert.equal(nf.status, 404);
  assert.deepEqual(nf.json, { error: "Not found" });

  assert.equal((await call("GET", "/api/partner/PG-99999/about")).status, 404);
  const chan = fx.partners.find((x) => /\//.test(x.domain || "")).id;
  assert.deepEqual((await call("GET", "/api/partner/" + chan + "/about")).json, { title: "", description: "" }, "no fetch for a channel path");
  for (const bad of ["", "not a domain", "https://", "a b.example.test"]) {
    const r = await call("GET", "/api/about?domain=" + encodeURIComponent(bad));
    assert.equal(r.status, 400, JSON.stringify(bad));
    assert.deepEqual(r.json, { error: "That doesn't look like a website address." });
  }
});

// ---------- 9. Settings (D3, D11) ----------

test("Settings: admins only, D1 only (no edits row), the team reaches /api/meta and the sign-in form", async () => {
  const snap = await q("SELECT k, v, at, by_whom FROM kv_meta WHERE k IN ('team', 'clients', 'allow_dnc', 'settings_log') ORDER BY k");
  const n0 = await maxEditN(target);
  try {
    const g = await counted("GET", "/api/settings");
    assert.equal(g.status, 200);
    assert.deepEqual(Object.keys(g.json), ["team", "clients", "allow_dnc"]);
    const team = g.json.team;
    assert.ok(Array.isArray(team) && team.some((m) => m.name === "Vik" && m.home === "team"));
    const no = await call("PUT", "/api/settings", { by: "Kamile", allow_dnc: true });
    assert.equal(no.status, 403);
    assert.deepEqual(no.json, { error: "Only Jonas or Vik can change settings." });
    for (const [b, msg] of [[{ by: "Jonas" }, "Nothing to save."], [{ by: "Jonas", allow_dnc: "yes" }, "allow_dnc is true or false."],
      [{ by: "Jonas", team: [{ name: "X" }] }, "Each team name needs 2–40 letters (spaces, ' and - are fine)."],
      [{ by: "Jonas", team: [{ name: "Kamile" }, { name: "kamile" }] }, "kamile is on the list twice."],
      [{ by: "Jonas", team: [{ name: "Kamile", active: false }] }, "Keep at least one person on the team."],
      [{ by: "Jonas", clients: [{ name: "Bad, Name" }] }, "A client name can't contain , / or ;."],
      [{ by: "Jonas", clients: [{ k: "nosuch", name: "Other" }] }, "A client's key can't be changed (nosuch)."]]) {
      const r = await call("PUT", "/api/settings", b);
      assert.equal(r.status, 400, JSON.stringify(b));
      assert.deepEqual(r.json, { error: msg });
    }
    // Add a person, then make them inactive: the sign-in form follows.
    const put = await counted("PUT", "/api/settings", { by: "vik", team: [...team, { name: "Zed Example" }], allow_dnc: true });
    assert.equal(put.status, 200, put.text.slice(0, 300));
    assert.equal(put.json.saved, 2);
    const [byVik] = await q("SELECT by_whom FROM kv_meta WHERE k = 'team'");
    assert.equal(byVik.by_whom, "Vik", "the admin's name is stored as listed");
    const meta = await call("GET", "/api/meta");
    assert.ok(meta.json.team.some((m) => m.name === "Zed Example"));
    assert.equal(meta.json.features.dnc, true);
    let form = await fetch(server.baseUrl + "/login").then((x) => x.text());
    assert.match(form, /<option>Zed Example<\/option>/);
    await call("PUT", "/api/settings", { by: "Jonas", team: [...team, { name: "Zed Example", active: false }], allow_dnc: false });
    form = await fetch(server.baseUrl + "/login").then((x) => x.text());
    assert.doesNotMatch(form, /Zed Example/, "inactive names leave the sign-in form");
    assert.equal((await call("GET", "/api/meta")).json.features.dnc, false);
    // Clients: a new one gets its name in lower case as k; it shows in /api/meta.
    const cl = await call("PUT", "/api/settings", { by: "Jonas", clients: [{ name: "Newclient Example", what: "Testing" }] });
    assert.equal(cl.status, 200, cl.text.slice(0, 300));
    assert.deepEqual(cl.json.clients, [{ k: "newclient example", name: "Newclient Example", what: "Testing" }]);
    assert.ok((await call("GET", "/api/meta")).json.clients.some((c) => c.k === "newclient example"));
    const [log] = await q("SELECT v, by_whom FROM kv_meta WHERE k = 'settings_log'");
    assert.equal(JSON.parse(log.v).by, "Jonas", "settings_log says who saved");
    assert.equal(await maxEditN(target), n0, "Settings write no edits row");
  } finally {
    await q("DELETE FROM kv_meta WHERE k IN ('team', 'clients', 'allow_dnc', 'settings_log')");
    for (const r of snap) await q(`INSERT INTO kv_meta (k, v, at, by_whom) VALUES (${sqlLit(r.k)}, ${sqlLit(r.v)}, ${sqlLit(r.at)}, ${sqlLit(r.by_whom)})`);
  }
});

// ---------- 10. no email addresses outside the profile and the contacts index (spec 6.7) ----------

test("no email address in any GET except the partner profile and the contacts index", async () => {
  // A contact added with only an email is among /api/edits' newest rows now (create_contact).
  assert.equal((await call("POST", "/api/partner/PG-00595/contacts", { by: "Kamile", email: "only-email@scan.example.test" })).status, 201);
  // A 'daily' run, so /api/meta's freshness.last_run carries the address too (lib/freshness.js hides it).
  await q("INSERT INTO runs (n, name, started_at, status, summary) VALUES (99, 'daily', '2026-10-01T05:00:00Z', 'error', '{\"error\":\"bounce from x@scan.example.test\"}')");
  try {
    const urls = ["/api/meta", "/api/partners?v=2", "/api/partners", "/api/partners?v=2&ids=PG-00377,PG-00595", "/api/edits", "/api/edits?limit=200",
      "/api/edits?account=PG-00595", "/api/team-activity?days=90", "/api/suggestions", "/api/suggestions?status=all", "/api/suggestions?account=PG-00377",
      "/api/suggestions?owner=Jonas&status=all", "/api/runs?limit=50", "/api/settings", "/api/clients", "/api/nope"];
    for (const u of urls) {
      const r = await call("GET", u);
      assert.ok(r.status === 200 || u === "/api/nope", u + " " + r.status);
      noEmail(r, u);
    }
    const ed = await call("GET", "/api/edits");
    const row = ed.json.recent.find((e) => e.kind === "create_contact" && e.account_id === "PG-00595");
    assert.equal(JSON.parse(row.new).email, "(email hidden)");
    const runs = await call("GET", "/api/runs?limit=50");
    assert.equal(runs.json.rows.find((r) => r.n === 99).summary.error, "bounce from (email hidden)");
    const lastRun = (await call("GET", "/api/meta")).json.freshness.last_run;
    assert.equal(lastRun.n, 99);
    assert.equal(lastRun.summary.error, "bounce from (email hidden)");
    // Signed out: nothing at all.
    for (const u of ["/api/partner/PG-00377", "/api/contacts-index", "/api/edits", "/api/suggestions"]) {
      const r = await fetch(server.baseUrl + u, { redirect: "manual" });
      assert.equal(r.status, 401, u);
      noEmail({ text: await r.text() }, "signed-out " + u);
    }
  } finally {
    await q("DELETE FROM runs WHERE n = 99");
  }
});

// ---------- 11. sign-in form and headers (6.3.14) ----------

test("sign-in form: names A to Z, Someone else, the hint line, pg_me, errors, caching headers, logout", async () => {
  const page = await fetch(server.baseUrl + "/login?next=%2F%3Fh%3D%2523sites").then((r) => r.text());
  const names = [...page.matchAll(/<option>([^<]+)<\/option>/g)].map((m) => m[1]);
  assert.ok(names.length >= 8 && names.includes("Kamile") && !names.includes("Jay"));
  assert.deepEqual(names, names.slice().sort((a, b) => a.localeCompare(b)), "A to Z");
  assert.match(page, /<option value="__other">Someone else \(type your name\)<\/option>/);
  assert.match(page, /name="who_other"/);
  assert.match(page, /Your edits are signed with this name\./);
  assert.match(page, /Don't know the password\? Ask Jonas\./);
  assert.match(page, /name="next" value="\/\?h=%23sites"/, "next keeps the hash");
  const post = (form) => fetch(server.baseUrl + "/login", { method: "POST", body: new URLSearchParams(form), redirect: "manual" });
  let r = await post({ password: PASSWORD, who: "Kamile", next: "/?h=%23sites" });
  assert.equal(r.status, 303);
  assert.equal(r.headers.get("location"), "/?h=%23sites");
  const cookies = r.headers.getSetCookie();
  assert.ok(cookies.some((c) => /^pg_session=[^;]+; Path=\/; Max-Age=2592000; HttpOnly; Secure; SameSite=Lax$/.test(c)));
  assert.ok(cookies.includes("pg_me=Kamile; Path=/; Max-Age=2592000; Secure; SameSite=Lax"));
  r = await post({ password: PASSWORD, who: "__other", who_other: "  Rūta  O'Neil-Smith ", next: "/" });
  assert.equal(r.status, 303);
  assert.ok(r.headers.getSetCookie().includes("pg_me=" + encodeURIComponent("Rūta O'Neil-Smith") + "; Path=/; Max-Age=2592000; Secure; SameSite=Lax"));
  r = await post({ password: PASSWORD, next: "/" });
  assert.equal(r.status, 303, "an API client signs in without a name");
  assert.equal(r.headers.getSetCookie().length, 1);
  for (const [form, status, msg] of [
    [{ password: "nope", who: "Kamile" }, 401, "Wrong password. Try again."],
    [{ password: PASSWORD, who: "Nobody" }, 400, "Pick your name from the list, or Someone else."],
    [{ password: PASSWORD, who: "" }, 400, "Pick your name from the list, or Someone else."],
    [{ password: PASSWORD, who: "__other", who_other: "R2" }, 400, "Type your name: 2–40 letters (spaces, &#39; and - are fine)."],
  ]) {
    r = await post(form);
    assert.equal(r.status, status, JSON.stringify(form));
    assert.ok((await r.text()).includes(msg), msg);
    assert.equal(r.headers.getSetCookie().length, 0, "no cookie on an error");
  }
  // pg_me preselects the name; an unknown one preselects Someone else with the name typed in.
  const pre = await fetch(server.baseUrl + "/login", { headers: { Cookie: "pg_me=Gaby" } }).then((x) => x.text());
  assert.match(pre, /<option selected>Gaby<\/option>/);
  const preOther = await fetch(server.baseUrl + "/login", { headers: { Cookie: "pg_me=Rita" } }).then((x) => x.text());
  assert.match(preOther, /<option value="__other" selected>/);
  assert.match(preOther, /name="who_other"[^>]*value="Rita"/);
  // Headers, favicon, logout.
  const apiRes = await call("GET", "/api/meta");
  assert.equal(apiRes.headers.get("cache-control"), "private, no-store");
  assert.equal(apiRes.headers.get("x-robots-tag"), "noindex");
  const js = await fetch(server.baseUrl + "/js/app.js", { headers: { Cookie: client.cookie } });
  assert.equal(js.headers.get("cache-control"), "private, no-cache");
  const ico = await fetch(server.baseUrl + "/favicon.ico", { redirect: "manual" });
  assert.equal(ico.status, 302);
  assert.equal(ico.headers.get("location"), "/favicon.svg");
  assert.equal((await fetch(server.baseUrl + "/favicon.svg")).status, 200, "the icon needs no sign-in");
  const out = await fetch(server.baseUrl + "/logout", { redirect: "manual", headers: { Cookie: client.cookie } });
  assert.equal(out.status, 302);
  assert.equal(out.headers.get("location"), "/login?bye=1");
  assert.match(out.headers.getSetCookie()[0], /^pg_session=; Path=\/; Max-Age=0/);
  assert.match(await fetch(server.baseUrl + "/login?bye=1").then((x) => x.text()), /You&#39;re signed out\./);
});

// ---------- 12. in the browser: T1, T1b, T1c, T17, sign-out, T24 ----------

const footName = (page) => page.locator("[data-foot] .sh-me").first().textContent();
const lastEditBy = async (id) => (await q(`SELECT by_whom FROM edits WHERE account_id = ${sqlLit(id)} ORDER BY n DESC LIMIT 1`))[0].by_whom;
function hashParams(url) {
  const h = new URL(url).hash.slice(1);
  const i = h.indexOf("?");
  return { page: i < 0 ? h : h.slice(0, i), params: Object.fromEntries(new URLSearchParams(i < 0 ? "" : h.slice(i + 1))) };
}
// A write through the app's own api module, which signs the edit with the current name.
const appWrite = (page, id, step) => page.evaluate(([i, s]) => import("/js/core/api.js")
  .then((m) => m.api.update(i, { next_step: s })).then(() => "ok", (e) => String(e && e.status)), [id, step]);

test("T1, T1b: a deep link survives sign-in with a name; the footer changes the name for the next edits", async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  const b = await browser();
  const context = await b.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  try {
    const deep = "#sites?tab=all&q=" + encodeURIComponent("rob@x.example.test") + "&rec=PG-00377";
    await page.goto(server.baseUrl + "/" + deep);
    assert.equal(new URL(page.url()).pathname, "/login", "sent to sign-in");
    await page.waitForFunction(() => /[?&]h=/.test(document.forms[0].elements.next.value));
    await page.screenshot({ path: path.join(SHOTS, "login-1440.png") });
    await page.fill('input[name="password"]', PASSWORD);
    await page.selectOption('select[name="who"]', "Kamile");
    await Promise.all([page.waitForURL((u) => new URL(u).pathname === "/"), page.click('button[type="submit"]')]);
    await page.waitForFunction(() => location.hash.startsWith("#sites"), null, { timeout: 15000 });
    const h = hashParams(page.url());
    assert.equal(h.page, "sites");
    assert.deepEqual({ tab: h.params.tab, q: h.params.q, rec: h.params.rec }, { tab: "all", q: "rob@x.example.test", rec: "PG-00377" });
    assert.equal((await context.cookies()).find((c) => c.name === "pg_me").value, "Kamile");
    assert.equal(await page.evaluate(() => localStorage.getItem("pgcrm-me")), '"Kamile"');
    await page.waitForSelector("[data-foot] .sh-me");
    assert.equal((await footName(page)).replace(/\s+/g, " ").trim(), "Signed in as Kamile · change");

    // T1b: change the name in the footer, reload, and the next edit is signed with it.
    await page.goto(server.baseUrl + "/#today");
    await page.waitForSelector("[data-foot] .sh-me");
    await page.locator('[data-foot] [data-act="me"]').first().click();
    const sel = "dialog.ui-modal[open] select[name=who]";
    await page.waitForSelector(sel);
    assert.equal(await page.textContent("dialog.ui-modal[open] .ui-modal-title"), "Change your name");
    assert.equal(await page.inputValue(sel), "Kamile", "the current name is preselected");
    const opts = await page.locator(sel + " option").allTextContents();
    assert.equal(opts[opts.length - 1], "Someone else (type your name)");
    assert.deepEqual(opts.slice(0, -1), opts.slice(0, -1).sort((a, b) => a.localeCompare(b)), "names A to Z, as on the sign-in form");
    await page.screenshot({ path: path.join(SHOTS, "me-change-1440.png") });
    await page.selectOption(sel, "Jonas");
    await page.click('dialog.ui-modal[open] button:has-text("Use this name")');
    await page.waitForFunction(() => /Signed in as Jonas/.test(document.querySelector("[data-foot] .sh-me").textContent));
    await page.reload();
    await page.waitForSelector("[data-foot] .sh-me");
    assert.match(await footName(page), /Signed in as Jonas/);
    assert.equal((await context.cookies()).find((c) => c.name === "pg_me").value, "Jonas");
    assert.equal(await appWrite(page, "PG-00590", "T1b check"), "ok");
    assert.equal(await lastEditBy("PG-00590"), "Jonas");
  } finally {
    await context.close();
  }
});

test("T1c: Someone else (Rita) signs edits as Rita and never joins the team menus", async () => {
  const b = await browser();
  for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
    const phone = viewport.width < 500;
    const context = await b.newContext({ viewport, ...(phone ? { isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : {}) });
    const page = await context.newPage();
    try {
      await page.goto(server.baseUrl + "/login");
      await page.fill('input[name="password"]', PASSWORD);
      assert.equal(await page.isVisible('input[name="who_other"]'), false, "hidden until Someone else");
      await page.selectOption('select[name="who"]', "__other");
      assert.equal(await page.evaluate(() => document.activeElement.name), "who_other", "the name field gets the focus");
      // A bad name is caught before sending, so the password stays typed in.
      await page.fill('input[name="who_other"]', "R2");
      await page.click('button[type="submit"]');
      assert.equal(await page.textContent("#err"), "Type your name: 2–40 letters (spaces, ' and - are fine).");
      assert.equal(new URL(page.url()).pathname, "/login");
      assert.equal(await page.inputValue('input[name="password"]'), PASSWORD);
      assert.equal(await page.getAttribute('input[name="who_other"]', "aria-invalid"), "true");
      await page.fill('input[name="who_other"]', "Rita");
      await page.screenshot({ path: path.join(SHOTS, "login-other-" + viewport.width + ".png") });
      await Promise.all([page.waitForURL((u) => new URL(u).pathname === "/"), page.click('button[type="submit"]')]);
      await page.waitForSelector("[data-foot] .sh-me", { state: "attached" });
      assert.match(await footName(page), /Signed in as Rita/);
      assert.equal(await page.evaluate(() => localStorage.getItem("pgcrm-me")), '"Rita"');
      if (phone) continue;
      assert.equal(await appWrite(page, "PG-00589", "T1c check"), "ok");
      assert.equal(await lastEditBy("PG-00589"), "Rita");
      const team = await page.evaluate(() => import("/js/core/meta.js").then((m) => m.get().team.map((t) => t.name)));
      assert.ok(team.length > 5 && !team.includes("Rita"), "Rita is not in the team list");
      // The footer form opens on Someone else with Rita typed in; Rita is not one of the names.
      await page.locator('[data-foot] [data-act="me"]').first().click();
      await page.waitForSelector("dialog.ui-modal[open] input[name=who_other]");
      assert.equal(await page.inputValue("dialog.ui-modal[open] select[name=who]"), "__other");
      assert.ok(!(await page.locator("dialog.ui-modal[open] select[name=who] option").allTextContents()).includes("Rita"), "Rita is not a name to pick");
      assert.equal(await page.inputValue("dialog.ui-modal[open] input[name=who_other]"), "Rita");
      // A bad name is refused in place.
      await page.fill("dialog.ui-modal[open] input[name=who_other]", "R");
      await page.click('dialog.ui-modal[open] button:has-text("Use this name")');
      await page.waitForSelector("dialog.ui-modal[open] .ui-error:not([hidden])");
      await page.screenshot({ path: path.join(SHOTS, "me-other-error-1440.png") });
      await page.fill("dialog.ui-modal[open] input[name=who_other]", "Rita Vale");
      await page.click('dialog.ui-modal[open] button:has-text("Use this name")');
      await page.waitForFunction(() => /Signed in as Rita Vale/.test(document.querySelector("[data-foot] .sh-me").textContent));
    } finally {
      await context.close();
    }
  }
});

test("signed in without a name: the first edit asks once, then uses that name", async () => {
  const s = await signedInPage({ base: server.baseUrl, viewport: { width: 390, height: 844 }, contextOptions: { isMobile: true, hasTouch: true, deviceScaleFactor: 2 } });
  const { page, context } = s;
  try {
    assert.equal((await context.cookies()).find((c) => c.name === "pg_me"), undefined, "no name yet");
    await page.waitForSelector("[data-foot] .sh-me", { state: "attached" });
    assert.match(await footName(page), /Signed in · pick your name/);
    const write = appWrite(page, "PG-00587", "First write");
    await page.waitForSelector("dialog.ui-modal[open] select[name=who]");
    assert.equal(await page.textContent("dialog.ui-modal[open] .ui-modal-title"), "Who's making this change?");
    assert.equal(await page.inputValue("dialog.ui-modal[open] select[name=who]"), "", "nobody is preselected");
    await page.click('dialog.ui-modal[open] button:has-text("Use this name")');
    await page.waitForSelector("dialog.ui-modal[open] .ui-error:not([hidden])");
    assert.equal(await page.textContent("dialog.ui-modal[open] .ui-error"), "Pick your name.");
    await page.screenshot({ path: path.join(SHOTS, "me-first-write-390.png") });
    await page.selectOption("dialog.ui-modal[open] select[name=who]", "Gaby");
    await page.click('dialog.ui-modal[open] button:has-text("Use this name")');
    assert.equal(await write, "ok");
    assert.equal(await lastEditBy("PG-00587"), "Gaby");
    assert.equal(await page.evaluate(() => localStorage.getItem("pgcrm-me")), '"Gaby"');
    assert.match(await footName(page), /Signed in as Gaby/);
  } finally {
    await s.close();
  }
});

test("T17: a 401 on save goes to sign-in with the hash kept, and back", async () => {
  const s = await signedInPage({ base: server.baseUrl, name: "Kamile", next: "/#sites?tab=waiting" });
  const { page, context } = s;
  try {
    await page.waitForFunction(() => location.hash.startsWith("#sites"));
    await context.clearCookies({ name: "pg_session" });
    await Promise.all([page.waitForURL((u) => new URL(u).pathname === "/login", { timeout: 15000 }), appWrite(page, "PG-00588", "T17").catch(() => null)]);
    assert.equal(new URL(page.url()).searchParams.get("next"), "/?h=" + encodeURIComponent("#sites?tab=waiting"));
    assert.equal(await page.inputValue('select[name="who"]'), "Kamile", "pg_me preselects the name");
    await page.fill('input[name="password"]', PASSWORD);
    await Promise.all([page.waitForURL((u) => new URL(u).pathname === "/"), page.click('button[type="submit"]')]);
    await page.waitForFunction(() => location.hash === "#sites?tab=waiting", null, { timeout: 15000 });
  } finally {
    await s.close();
  }
});

test("sign-out clears the page cache and the ETag key", async () => {
  const s = await signedInPage({ base: server.baseUrl, name: "Kamile" });
  const { page } = s;
  try {
    await page.evaluate(async () => {
      localStorage.setItem("pgcrm-cache-etag", 'W/"x"');
      const c = await caches.open("pgcrm");
      await c.put("/probe", new Response("x"));
    });
    await page.goto(server.baseUrl + "/logout");
    await page.waitForSelector(".note");
    assert.equal(await page.textContent(".note"), "You're signed out.");
    await page.waitForFunction(() => caches.has("pgcrm").then((x) => !x));
    assert.equal(await page.evaluate(() => localStorage.getItem("pgcrm-cache-etag")), null);
    assert.equal((await page.goto(server.baseUrl + "/api/meta")).status(), 401, "signed out");
  } finally {
    await s.close();
  }
});

test("T24: legacy.html signs in, lists and saves a stage", async () => {
  const id = ids("monica-contacted")[5];
  const [{ stage: was }] = await q(`SELECT stage FROM partners WHERE id = ${sqlLit(id)}`);
  const to = was === "Replied" ? "Contacted" : "Replied";
  const s = await signedInPage({ base: server.baseUrl, name: "Kamile", next: "/legacy.html#sites" });
  const { page, watch } = s;
  try {
    await page.waitForSelector("tr[data-rec]", { timeout: 20000 });
    assert.ok((await page.locator("tr[data-rec]").count()) > 10, "the list shows sites");
    await page.evaluate((i) => { location.hash = "rec-" + i; }, id);
    await page.waitForSelector('#dr-form select[name="stage"]');
    const n0 = await maxEditN(target);
    await page.selectOption('#dr-form select[name="stage"]', to);
    await page.click("#dr-save");
    await page.waitForFunction(() => /Saved\./.test(document.body.textContent));
    assert.deepEqual((await editsAfter(n0, target)).map(stripEdit), [{ by_whom: "Kamile", kind: "update", account_id: id, contact_id: null,
      field: "stage", old: was, new: to, applied: 0 }]);
    // The change log reads GET /api/edits.
    await page.evaluate(() => { location.hash = "changes"; });
    await page.waitForFunction(() => /Changed/.test(document.querySelector('[data-page="changes"]').textContent));
    assert.deepEqual(watch.pageErrors, []);
    assert.deepEqual(watch.failed.filter((f) => f.status >= 500), []);
  } finally {
    await s.close();
  }
});

// ---------- 13. a server without 003/004 (T29) ----------

test("T29: without 003/004 every endpoint answers (no 500s); 004 and 003 applied while it runs switch the features on", async () => {
  const bare = await startServer({ extra: false });
  try {
    const c = await apiClient(bare.baseUrl);
    const tables = (await bare.d1("SELECT name FROM sqlite_master WHERE type = 'table'")).map((r) => r.name);
    for (const t of ["kv_meta", "suggestions", "runs"]) assert.ok(!tables.includes(t), t + " is missing");
    for (const u of ["/api/settings", "/api/suggestions", "/api/suggestions?owner=Kamile", "/api/runs"]) {
      const r = await c.call("GET", u);
      assert.equal(r.status, 404, u);
      assert.deepEqual(r.json, UNAVAILABLE, u);
    }
    for (const [m, u, b] of [["PUT", "/api/settings", { by: "Jonas", allow_dnc: true }], ["POST", "/api/suggestions/x", { by: "Kamile", status: "used" }]]) {
      const r = await c.call(m, u, b);
      assert.equal(r.status, 404, u);
      assert.deepEqual(r.json, UNAVAILABLE);
    }
    const ok = [["GET", "/api/meta"], ["GET", "/api/partners?v=2"], ["GET", "/api/partners"], ["GET", "/api/contacts-index"], ["GET", "/api/edits"],
      ["GET", "/api/edits?limit=10&state=waiting"], ["GET", "/api/team-activity"], ["GET", "/api/partner/PG-00377"], ["GET", "/api/clients"],
      ["POST", "/api/bulk", { by: "Kamile", ids: ["PG-00593"], fields: { next_step: "Bare ids" } }],
      ["POST", "/api/bulk", { by: "Kamile", rows: [{ id: "PG-00593", fields: { next_step: "Bare rows" } }] }],
      ["PATCH", "/api/partner/PG-00593", { by: "Kamile", fields: { next_step: "Bare patch" } }]];
    for (const [m, u, b] of ok) {
      const r = await c.call(m, u, b, { "X-PGCRM-Count": "1" });
      assert.equal(r.status, 200, m + " " + u + ": " + r.text.slice(0, 200));
      assert.ok(Number(r.headers.get("x-d1-statements")) <= FREE_BUDGET, u);
    }
    assert.equal((await c.call("GET", "/api/partner/PG-00377")).json.suggestions, null);
    assert.match(await fetch(bare.baseUrl + "/login").then((x) => x.text()), /<option>Kamile<\/option>/, "the sign-in form uses the built-in team");
    assert.equal((await c.call("GET", "/api/meta")).json.features.suggestions, false);

    await bare.applyMigrations(["004_suggestions_runs.sql"]);
    await bare.seedOptional();
    const s = await c.call("GET", "/api/suggestions?status=all");
    assert.equal(s.status, 200);
    assert.equal(s.json.rows.length, fx.suggestions.length);
    assert.equal((await c.call("GET", "/api/runs")).json.rows.length, 3);
    assert.ok((await c.call("GET", "/api/partner/PG-00002")).json.suggestions.length > 0);
    assert.equal((await c.call("GET", "/api/meta")).json.features.suggestions, true);
    assert.equal((await c.call("GET", "/api/settings")).status, 404, "Settings wait for 003");
    await bare.applyMigrations(["003_site_meta.sql"]);
    const st = await c.call("GET", "/api/settings");
    assert.equal(st.status, 200);
    assert.deepEqual(st.json, { team: null, clients: null, allow_dnc: false });
  } finally {
    await bare.stop();
  }
});
