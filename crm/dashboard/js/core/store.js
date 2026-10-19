// The one store for sites (spec 5.4, 4.11). Owner G1-A. No side effects at import time.
//
// load(): renders from Cache Storage when there is a cached list (reason 'load'), then applies the
// conditional GET started in index.html in the background: 304 keeps the cache, 200 replaces it
// (reason 'refresh' when a cached list was shown, else 'load'). load() resolves after the cache
// step; whenLoaded() resolves once the network answer (or its failure) has been applied.
// upsert()/patchLocal() merge column by column and notify {reason:'edit'|'bulk', ids}.
// Notifications are coalesced per microtask and held while setBusy()'s check says the UI is busy
// (an open menu, popover or inline editor, or a dirty record panel), then flushed.
import { api, readPartners } from "./api.js";
import * as cache from "./cache.js";
import * as meta from "./meta.js";
import * as bus from "./bus.js";
import { derive, fromV1Row, fromV2Row, V2_COLS, DERIVED } from "./model.js";
import { todayIso, lastRunAt } from "./format.js";

const raws = new Map(); // id -> raw v2 object
const recs = new Map(); // id -> derived Record
const subs = new Set();
const held = new Map(); // reason -> Set of ids, or null for "everything"
const DERIVED_KEYS = new Set(DERIVED);
const ORDER = ["load", "refresh", "bulk", "edit"];

let list = null;
let cols = V2_COLS.slice();
let busyCheck = () => false;
let flushQueued = false;
let holdTimer = null;
let derivedWith = { meta: null, today: null };
let dayCheckedAt = 0;
let network = null;
let networkDone = false;
let refreshing = null;
let lastCheck = 0;
let listening = false;

// loadedAt: when the shown list was generated (X-Generated-At, else when it arrived).
// fromCache: the shown list came from Cache Storage (still true after a 304 confirmed it).
// pending: edits waiting for the morning copy (from meta.freshness, then setPending()).
// build: meta.build when the list was loaded. loading/error/checkedAt/etag: network state.
// legacyRows: TEMP until G1-B, true while the list came from the v1 positional rows.
export const status = {
  loadedAt: null, fromCache: false, pending: null, build: null,
  loading: false, error: null, checkedAt: null, etag: null, legacyRows: false,
};

const hasWindow = () => typeof window !== "undefined";
const snapshot = () => (hasWindow() && window.__SNAPSHOT__) || null;

function emitStatus() {
  bus.emit("store:status", status);
}

function ctxNow() {
  return { meta: meta.get(), today: todayIso() };
}

// Re-derives every row when the day or the meta object changed (quiet days, client names).
function keepDerivedCurrent() {
  const now = Date.now();
  if (now - dayCheckedAt < 30000 && derivedWith.meta === meta.get()) return;
  dayCheckedAt = now;
  const c = ctxNow();
  if (c.today === derivedWith.today && c.meta === derivedWith.meta) return;
  rederive(c);
}

function rederive(c) {
  for (const [id, raw] of raws) recs.set(id, derive(raw, c));
  derivedWith = c;
  list = null;
}

const same = (a, b) => String(a == null ? "" : a) === String(b == null ? "" : b);

function changed(a, b) {
  for (const k of cols) if (!same(a[k], b[k])) return true;
  return false;
}

function setAll(objs, reason) {
  const c = ctxNow();
  let ids = null;
  if (reason === "refresh") {
    ids = [];
    const seen = new Set();
    for (const o of objs) {
      const id = String(o.id);
      seen.add(id);
      const old = raws.get(id);
      if (!old || changed(old, o)) ids.push(id);
    }
    for (const id of raws.keys()) if (!seen.has(id)) ids.push(id);
  }
  raws.clear();
  recs.clear();
  for (const o of objs) {
    if (!o || o.id == null || o.id === "") continue;
    const id = String(o.id);
    const raw = Object.assign({}, o, { id });
    raws.set(id, raw);
    recs.set(id, derive(raw, c));
  }
  derivedWith = c;
  dayCheckedAt = Date.now();
  list = null;
  if (reason === "refresh" && !ids.length) return;
  notify(reason, ids);
}

function notify(reason, ids) {
  if (!held.has(reason)) held.set(reason, ids ? new Set(ids) : null);
  else {
    const set = held.get(reason);
    if (!ids) held.set(reason, null);
    else if (set) for (const id of ids) set.add(id);
  }
  if (!flushQueued) {
    flushQueued = true;
    queueMicrotask(flush);
  }
}

// Delivers held notifications now, unless the UI is busy (then it checks again shortly).
export function flush() {
  flushQueued = false;
  if (!held.size) return;
  let busy = false;
  try { busy = !!busyCheck(); } catch (e) { busy = false; }
  if (busy) {
    if (!holdTimer) holdTimer = setTimeout(() => { holdTimer = null; flush(); }, 250);
    return;
  }
  const batch = Array.from(held.entries()).sort((a, b) => ORDER.indexOf(a[0]) - ORDER.indexOf(b[0]));
  held.clear();
  for (const [reason, set] of batch) {
    const evt = set ? { reason, ids: Array.from(set) } : { reason };
    for (const fn of Array.from(subs)) {
      try { fn(evt); } catch (e) { if (typeof console !== "undefined") console.error(e); }
    }
  }
}

// app.js wires this to ui.isBusy() || record.isDirty().
export function setBusy(fn) {
  busyCheck = typeof fn === "function" ? fn : () => false;
}

const isV2 = (d) => d && typeof d === "object" && !Array.isArray(d) && Array.isArray(d.cols) && Array.isArray(d.rows);

function applyResult(r, reason) {
  const d = r && r.data;
  if (Array.isArray(d)) {
    // TEMP until G1-B: /api/partners?v=2 still answers with the v1 positional rows. Map them to the
    // v2 names; never cache them (the cache key and ETag belong to the v2 list).
    setAll(d.map(fromV1Row), reason);
    status.legacyRows = true;
    status.etag = null;
    cache.clear();
  } else if (isV2(d)) {
    cols = d.cols.slice();
    setAll(d.rows.map((row) => fromV2Row(row, cols)), reason);
    status.legacyRows = false;
    status.etag = r.etag || null;
    cache.write(r.text != null ? r.text : d, { etag: r.etag || null, generatedAt: r.generatedAt || null });
  } else {
    throw new Error("The site list isn't available.");
  }
  status.fromCache = false;
  status.loadedAt = r.generatedAt || new Date().toISOString();
  status.error = null;
  markChecked();
}

function markChecked() {
  lastCheck = Date.now();
  status.checkedAt = new Date(lastCheck).toISOString();
}

function failText(e) {
  if (e && e.status === 401) return null;
  return (e && (e.friendly || e.message)) || "The site list couldn't be loaded.";
}

// Applies a partners result; on a 304 that the shown list can't answer, asks again without ETag.
async function settle(promise, { cachedEtag, sentEtag }) {
  try {
    let r = await promise;
    if (r && r.status === 304) {
      if (raws.size && cachedEtag && sentEtag && cachedEtag === sentEtag) {
        status.error = null;
        markChecked();
        return;
      }
      r = await api.partners({});
    }
    if (!r || r.status === 304) throw new Error("The site list isn't available.");
    applyResult(r, raws.size ? "refresh" : "load");
  } catch (e) {
    status.error = failText(e);
  }
}

export async function load() {
  const m = meta.get();
  status.build = m.build == null ? null : m.build;
  status.pending = m.freshness && m.freshness.pending != null ? Number(m.freshness.pending) : null;
  if (!listening) {
    listening = true;
    bus.on("meta", () => {
      rederive(ctxNow());
      if (raws.size) notify("refresh", null);
    });
  }
  const snap = snapshot();
  if (snap) {
    cols = Array.isArray(snap.cols) ? snap.cols.slice() : V2_COLS.slice();
    setAll((snap.rows || []).map((row) => (Array.isArray(row) ? fromV2Row(row, cols) : row)), "load");
    status.loadedAt = snap.builtAt || null;
    networkDone = true;
    network = Promise.resolve();
    emitStatus();
    return;
  }
  let cached = null;
  try { cached = await cache.read(); } catch (e) { cached = null; }
  if (cached && isV2(cached.data)) {
    cols = cached.data.cols.slice();
    setAll(cached.data.rows.map((row) => fromV2Row(row, cols)), "load");
    status.fromCache = true;
    status.loadedAt = cached.generatedAt || cached.cachedAt;
    status.etag = cached.etag;
  } else {
    cached = null;
  }
  status.loading = true;
  emitStatus();
  const boot = hasWindow() && window.__boot ? window.__boot.partners : null;
  // The boot fetch in index.html sent localStorage's ETag; without it, ask with the cached one.
  const sentEtag = boot ? cache.etag() : cached ? cached.etag : null;
  const promise = boot ? readPartners(boot) : api.partners({ etag: sentEtag });
  network = settle(promise, { cachedEtag: cached ? cached.etag : null, sentEtag }).then(() => {
    networkDone = true;
    status.loading = false;
    emitStatus();
  });
}

// Resolves when the first network answer (or its failure) has been applied.
export function whenLoaded() {
  return network || Promise.resolve();
}

export function all() {
  keepDerivedCurrent();
  if (!list) list = Array.from(recs.values());
  return list.slice();
}

export function get(id) {
  if (id == null) return undefined;
  keepDerivedCurrent();
  return recs.get(String(id));
}

export function size() {
  return recs.size;
}

function mergeInto(target, fields) {
  for (const [k, v] of Object.entries(fields || {})) {
    if (v === undefined || DERIVED_KEYS.has(k)) continue;
    target[k] = v;
  }
  return target;
}

// Accepts a v2 row array (in the list's cols order) or an object of column values. Merges column by
// column into the stored row (never replaces it wholesale) and notifies {reason, ids: [id]}.
// opts.reason: 'edit' (default) or 'bulk'.
export function upsert(v2RowOrObject, { reason = "edit" } = {}) {
  const obj = Array.isArray(v2RowOrObject) ? fromV2Row(v2RowOrObject, cols) : v2RowOrObject;
  if (!obj || typeof obj !== "object" || obj.id == null || obj.id === "") return undefined;
  const id = String(obj.id);
  const raw = mergeInto(Object.assign({}, raws.get(id) || {}), obj);
  raw.id = id;
  raws.set(id, raw);
  const rec = derive(raw, ctxNow());
  recs.set(id, rec);
  list = null;
  notify(reason, [id]);
  return rec;
}

// Optimistic local change of an existing row (rolled back by patching the old values).
export function patchLocal(id, fields, { reason = "edit" } = {}) {
  const key = String(id);
  const cur = raws.get(key);
  if (!cur) return undefined;
  const raw = mergeInto(Object.assign({}, cur), fields);
  raw.id = key;
  raws.set(key, raw);
  const rec = derive(raw, ctxNow());
  recs.set(key, rec);
  list = null;
  notify(reason, [key]);
  return rec;
}

export function remove(id) {
  const key = String(id);
  if (!raws.delete(key)) return;
  recs.delete(key);
  list = null;
  notify("edit", [key]);
}

// fn({reason: 'load'|'refresh'|'edit'|'bulk', ids?}); returns the unsubscribe function.
export function subscribe(fn) {
  subs.add(fn);
  return () => subs.delete(fn);
}

// Revalidates with If-None-Match (full: true asks for the whole list). 304 keeps everything.
export function refresh({ full = false } = {}) {
  if (snapshot()) return Promise.resolve();
  if (network && !networkDone) return network;
  if (refreshing) return refreshing;
  status.loading = true;
  emitStatus();
  const etag = full ? null : status.etag;
  refreshing = settle(api.partners({ etag }), { cachedEtag: status.etag, sentEtag: etag }).then(() => {
    refreshing = null;
    status.loading = false;
    emitStatus();
  });
  return refreshing;
}

// Focus/visibility revalidation rule (spec 4.11): the last check is over 10 minutes old, or this is
// the first check after a weekday morning copy (08:47 Vilnius + 15 minutes).
export function shouldRevalidate(nowMs = Date.now()) {
  if (snapshot() || refreshing || !networkDone) return false;
  if (nowMs - lastCheck > 10 * 60000) return true;
  const m = meta.get();
  const run = lastRunAt(nowMs, m.timezone || "Europe/Vilnius", meta.runTime(m)) + 15 * 60000;
  return isFinite(run) && run <= nowMs && lastCheck < run;
}

// The footer's "N changes copy to the Google Sheet…" count.
export function setPending(n) {
  const v = n == null || n === "" || !isFinite(Number(n)) ? null : Number(n);
  if (v === status.pending) return;
  status.pending = v;
  emitStatus();
}
