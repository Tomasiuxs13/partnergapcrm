// PATCH /api/partner/:id and PUT /api/settings against a stub D1 (NEEDS "G2 checkpoint 1", spec 4.11):
// a field check's sentence is a 400 with that sentence, and a D1 failure (a real Error) is thrown, so the
// Pages runtime answers 500 and the page shows "The server couldn't save this…", never the raw D1 text.
// No wrangler, no server: the handlers are plain functions of {request, env, params}.
import { test } from "node:test";
import assert from "node:assert/strict";
import { onRequestPatch } from "../../functions/api/partner/[id].js";
import { onRequestPut } from "../../functions/api/settings.js";

const D1_TEXT = "D1_ERROR: internal error; reference = 0123456789abcdef";

// A stub D1: prepare(sql).bind(...).first()/all()/run(), and batch(). `fail(sql)` says which reads throw;
// `batchFails` makes every batch throw (the write of a PATCH).
function stubDb({ row = null, tables = [], fail = () => false, batchFails = false } = {}) {
  const calls = { batch: 0 };
  const stmt = (sql, args = []) => ({
    sql,
    args,
    bind: (...a) => stmt(sql, a),
    async first() {
      if (fail(sql)) throw new Error(D1_TEXT);
      return /FROM partners/i.test(sql) ? row : null;
    },
    async all() {
      if (fail(sql)) throw new Error(D1_TEXT);
      if (/sqlite_master/i.test(sql)) return { results: args.filter((n) => tables.includes(n)).map((name) => ({ name })) };
      return { results: [] };
    },
    async run() {
      if (fail(sql)) throw new Error(D1_TEXT);
      return { meta: {} };
    },
  });
  return {
    calls,
    prepare: (sql) => stmt(sql),
    async batch(list) {
      calls.batch++;
      if (batchFails) throw new Error(D1_TEXT);
      return list.map(() => ({ results: [], meta: {} }));
    },
  };
}

const ROW = { id: "PG-00001", site: "alpha.example.test", domain: "alpha.example.test", stage: "Contacted", owner: "Kamile", next_step: null, next_due: null, clients: null };
const req = (url, method, b) => new Request("http://127.0.0.1" + url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) });
const patch = (db, fields) => onRequestPatch({ request: req("/api/partner/PG-00001", "PATCH", { by: "Kamile", fields }), env: { PARTNERS_DB: db }, params: { id: "PG-00001" } });
const put = (db, b) => onRequestPut({ request: req("/api/settings", "PUT", Object.assign({ by: "Jonas" }, b)), env: { PARTNERS_DB: db } });

test("PATCH /api/partner/:id: a bad value is a 400 with the field check's sentence", async () => {
  const db = stubDb({ row: ROW });
  const r = await patch(db, { stage: "Somewhere" });
  assert.equal(r.status, 400);
  assert.deepEqual(await r.json(), { error: "Pick a stage from the list." });
  assert.equal(db.calls.batch, 0, "nothing written");
});

test("PATCH /api/partner/:id: a D1 failure is thrown (a 500), never a 400 with the D1 text", async () => {
  const db = stubDb({ row: ROW, batchFails: true });
  await assert.rejects(() => patch(db, { next_step: "Send the rate card" }), (e) => e instanceof Error && e.message === D1_TEXT);
  assert.equal(db.calls.batch, 1);
  // A failed read of the row is thrown too (it was never inside the catch).
  const db2 = stubDb({ row: ROW, fail: (sql) => /FROM partners/i.test(sql) });
  await assert.rejects(() => patch(db2, { next_step: "Send the rate card" }), (e) => e instanceof Error && e.message === D1_TEXT);
});

test("PUT /api/settings: a bad value is a 400 with the sentence; a D1 failure inside the checks is thrown", async () => {
  const db = stubDb({ tables: ["kv_meta"] });
  const r = await put(db, { team: "Kamile" });
  assert.equal(r.status, 400);
  assert.deepEqual(await r.json(), { error: "The team must be a list of names." });
  const r2 = await put(db, { allow_dnc: "yes" });
  assert.equal(r2.status, 400);
  assert.deepEqual(await r2.json(), { error: "allow_dnc is true or false." });
  // The clients check reads the stored list first: that read failing is a D1 failure, not a bad value.
  const failing = stubDb({ tables: ["kv_meta"], fail: (sql) => /FROM kv_meta/i.test(sql) });
  await assert.rejects(() => put(failing, { clients: [{ name: "Soro" }] }), (e) => e instanceof Error && e.message === D1_TEXT);
});
