// Unit tests for js/core/store.js (spec 5.4, 4.11): a full list that was requested before a local write
// and arrives after it must not undo that write (merge-by-column upsert, "local writes survive"), and
// it must not go into Cache Storage as the server sent it. Fetch, Cache Storage and localStorage are
// stubbed in memory; nothing here talks to a server. The globals are restored at the end (the hooks are
// scoped to the describe block, because tests/unit/index.js loads every test file into one process).
import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import * as store from "../../crm/dashboard/js/core/store.js";
import { V2_COLS } from "../../crm/dashboard/js/core/model.js";

const KEY = "/api/partners?v=2";
const saved = {};
const fetches = []; // {url, init, answer(response)}
const cacheMap = new Map(); // key -> {text, headers}
const ls = new Map();

function row(id, over = {}) {
  const o = { id, domain: id.toLowerCase() + ".example.test", name: "Site " + id, label: "Site " + id, owner: "Kamile",
    stage: "Contacted", next_step: "Old step", clients: "Soro", ...over };
  return V2_COLS.map((k) => (k in o ? o[k] : null));
}
const body = (rows) => ({ v: 2, cols: V2_COLS.slice(), rows });
const ok = (b, etag) => new Response(JSON.stringify(b), {
  status: 200, headers: { "content-type": "application/json", ETag: etag, "X-Generated-At": "2026-10-19T08:00:00Z" },
});
const notModified = () => new Response(null, { status: 304 });

function cached() {
  const c = cacheMap.get(KEY);
  return c ? { data: JSON.parse(c.text), etag: c.headers.get("ETag") } : null;
}
const col = (data, id, k) => {
  const r = data.rows.find((x) => x[0] === id);
  return r ? r[data.cols.indexOf(k)] : undefined;
};
const lastFetch = () => fetches[fetches.length - 1];
const settle = () => new Promise((r) => setTimeout(r, 0));

describe("store.js with stubbed fetch, Cache Storage and localStorage", () => {
  before(() => {
    for (const k of ["fetch", "caches", "localStorage"]) saved[k] = Object.getOwnPropertyDescriptor(globalThis, k);
    const def = (k, v) => Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true });
    def("fetch", (url, init) => new Promise((resolve) => fetches.push({ url: String(url), init, answer: resolve })));
    def("caches", {
      async open() {
        return {
          async match(key) {
            const c = cacheMap.get(key);
            return c ? new Response(c.text, { headers: c.headers }) : undefined;
          },
          async put(key, res) {
            cacheMap.set(key, { text: await res.text(), headers: new Headers(res.headers) });
          },
        };
      },
      async delete() { cacheMap.clear(); return true; },
    });
    def("localStorage", {
      getItem: (k) => (ls.has(k) ? ls.get(k) : null),
      setItem: (k, v) => ls.set(k, String(v)),
      removeItem: (k) => ls.delete(k),
    });
  });

  after(() => {
    for (const [k, d] of Object.entries(saved)) {
      if (d) Object.defineProperty(globalThis, k, d);
      else delete globalThis[k];
    }
  });

  test("a warm load: writes made while the list is on its way survive it, and the stale body is not cached as sent", async () => {
    // Cache Storage holds yesterday's list.
    cacheMap.set(KEY, { text: JSON.stringify(body([row("PG-00001"), row("PG-00002"), row("PG-00003")])),
      headers: new Headers({ "Content-Type": "application/json", ETag: 'W/"old"' }) });
    ls.set("pgcrm-cache-etag", 'W/"old"');
    await store.load();
    assert.equal(store.size(), 3, "rendered from the cache");
    assert.equal(store.status.fromCache, true);
    const req = lastFetch();
    assert.ok(req && req.url.startsWith(KEY), "the list request is on its way");

    // While it is on its way: a save (optimistic patch, then the server's v2 row), a new site and a removal.
    store.patchLocal("PG-00001", { next_step: "Saved while loading" });
    store.upsert(row("NEW-0009", { stage: "New", next_step: "Added while loading" }));
    store.remove("PG-00003");
    assert.equal(store.get("PG-00001").next_step, "Saved while loading");

    // The list was generated before those writes. Someone else changed PG-00001's owner and PG-00002's stage.
    req.answer(ok(body([row("PG-00001", { owner: "Gaby" }), row("PG-00002", { stage: "Replied" }), row("PG-00003")]), 'W/"stale"'));
    await store.whenLoaded();
    await settle();

    assert.equal(store.get("PG-00001").next_step, "Saved while loading", "the saved column keeps its local value");
    assert.equal(store.get("PG-00001").owner, "Gaby", "other columns of that row come from the list");
    assert.equal(store.get("PG-00002").stage, "Replied", "untouched rows come from the list");
    assert.equal(store.get("NEW-0009") && store.get("NEW-0009").next_step, "Added while loading", "a site added meanwhile stays");
    assert.equal(store.get("PG-00003"), undefined, "a row removed meanwhile stays removed");
    assert.equal(store.status.error, null);
    assert.equal(store.status.fromCache, false);

    await settle();
    const c = cached();
    assert.ok(c, "the merged list is cached");
    assert.equal(c.etag, null, "without the stale body's ETag");
    assert.equal(ls.has("pgcrm-cache-etag"), false, "no ETag kept for the next boot");
    assert.equal(store.status.etag, null);
    assert.equal(col(c.data, "PG-00001", "next_step"), "Saved while loading", "the cache holds the saved value");
    assert.equal(col(c.data, "PG-00001", "owner"), "Gaby");
    assert.equal(col(c.data, "NEW-0009", "stage"), "New");
    assert.equal(col(c.data, "PG-00003", "id"), undefined);
  });

  test("refresh(): with no write in flight the server's body is cached as sent, with its ETag", async () => {
    const p = store.refresh();
    const req = lastFetch();
    assert.equal(req.init.headers["If-None-Match"], undefined, "no ETag after a merged load: a full request");
    const fresh = body([row("PG-00001", { owner: "Gaby", next_step: "Saved while loading" }), row("PG-00002", { stage: "Replied" }),
      row("NEW-0009", { stage: "New", next_step: "Added while loading" })]);
    req.answer(ok(fresh, 'W/"fresh"'));
    await p;
    await settle();
    const c = cached();
    assert.equal(c.etag, 'W/"fresh"');
    assert.deepEqual(c.data, fresh);
    assert.equal(ls.get("pgcrm-cache-etag"), 'W/"fresh"');
    assert.equal(store.status.etag, 'W/"fresh"');
  });

  test("refresh(): a save made while the full list downloads keeps its value; a 304 keeps everything", async () => {
    const p = store.refresh({ full: true });
    const req = lastFetch();
    store.upsert({ id: "PG-00002", next_step: "Saved during refresh", updated_by: "Kamile" });
    req.answer(ok(body([row("PG-00001", { owner: "Gaby", next_step: "Saved while loading" }), row("PG-00002", { stage: "Lost", next_step: "Old step" }),
      row("NEW-0009", { stage: "New" })]), 'W/"older"'));
    await p;
    await settle();
    assert.equal(store.get("PG-00002").next_step, "Saved during refresh");
    assert.equal(store.get("PG-00002").updated_by, "Kamile");
    assert.equal(store.get("PG-00002").stage, "Lost", "the list's other columns apply");
    assert.equal(store.get("NEW-0009").next_step, "Old step", "a row not written meanwhile takes the list's values");
    assert.equal(col(cached().data, "PG-00002", "next_step"), "Saved during refresh");
    assert.equal(cached().etag, null);

    // Writes after the answer was applied are no longer watched: the next list wins as usual.
    const p2 = store.refresh({ full: true });
    lastFetch().answer(ok(body([row("PG-00001"), row("PG-00002", { next_step: "Changed in the sheet" })]), 'W/"next"'));
    await p2;
    await settle();
    assert.equal(store.get("PG-00002").next_step, "Changed in the sheet");
    assert.equal(store.get("NEW-0009"), undefined, "renamed or removed on the server");
    assert.equal(cached().etag, 'W/"next"');

    const p3 = store.refresh();
    assert.equal(lastFetch().init.headers["If-None-Match"], 'W/"next"');
    store.patchLocal("PG-00001", { stage: "Replied" });
    lastFetch().answer(notModified());
    await p3;
    assert.equal(store.get("PG-00001").stage, "Replied", "a 304 keeps the local rows");
    assert.equal(cached().etag, 'W/"next"', "and the cache");
  });
});
