// The one store for sites (spec 5.4, 4.11). G0 stub; owner G1-A.
// load() waits for the boot fetch started in index.html and keeps the store empty.

const rows = new Map();
const subs = new Set();

export const status = { loadedAt: null, fromCache: false, pending: 0, build: null };

export async function load() {
  const boot = typeof window !== "undefined" && window.__boot ? window.__boot.partners : null;
  if (boot) await Promise.resolve(boot).catch(() => null);
  status.loadedAt = null;
}

export function all() { return Array.from(rows.values()); }

export function get(id) { return rows.get(id); }

export function upsert(v2RowOrObject) {
  const obj = v2RowOrObject && !Array.isArray(v2RowOrObject) ? v2RowOrObject : {};
  if (!obj.id) return Object.assign({}, obj);
  const merged = Object.assign({}, rows.get(obj.id) || {}, obj);
  rows.set(obj.id, merged);
  return merged;
}

export function patchLocal(id, fields) {
  const cur = rows.get(id);
  if (!cur) return undefined;
  const merged = Object.assign({}, cur, fields || {});
  rows.set(id, merged);
  return merged;
}

export function remove(id) { rows.delete(id); }

export function subscribe(fn) {
  subs.add(fn);
  return () => subs.delete(fn);
}

export async function refresh({ full = false } = {}) {}
