// Cache Storage for the v2 site list (spec 4.11): cache 'pgcrm', key /api/partners?v=2, and its
// ETag in localStorage 'pgcrm-cache-etag'. Written only after a full 200 load, never per patch.
// Quota and other errors are ignored. Owner G1-A. No side effects at import time.
import * as prefs from "./prefs.js";

const NAME = "pgcrm";
const KEY = "/api/partners?v=2";
const ETAG = "pgcrm-cache-etag";

const available = () => typeof caches !== "undefined";

// {data, etag, generatedAt, cachedAt} or null. early: the read index.html started at boot (a promise of
// {data, headers} or null), used instead of reading again; it is read again when that one failed.
export async function read(early = null) {
  if (!available()) return null;
  try {
    let hit;
    if (early) {
      try { hit = await early; } catch (e) { hit = undefined; }
    }
    if (hit === undefined) {
      const c = await caches.open(NAME);
      const res = await c.match(KEY);
      hit = res ? { data: await res.json(), headers: res.headers } : null;
    }
    if (!hit) return null;
    return {
      data: hit.data,
      etag: hit.headers.get("ETag") || null,
      generatedAt: hit.headers.get("X-Generated-At") || null,
      cachedAt: hit.headers.get("X-Cached-At") || null,
    };
  } catch (e) {
    return null;
  }
}

// Stores the body (an object or its JSON text) with its ETag. Returns true when it was stored.
export async function write(data, { etag = null, generatedAt = null } = {}) {
  if (!available()) return false;
  try {
    const body = typeof data === "string" ? data : JSON.stringify(data);
    const headers = { "Content-Type": "application/json", "X-Cached-At": new Date().toISOString() };
    if (etag) headers.ETag = etag;
    if (generatedAt) headers["X-Generated-At"] = generatedAt;
    const c = await caches.open(NAME);
    await c.put(KEY, new Response(body, { headers }));
    if (etag) prefs.set(ETAG, etag);
    else prefs.remove(ETAG);
    return true;
  } catch (e) {
    prefs.remove(ETAG);
    return false;
  }
}

export async function clear() {
  prefs.remove(ETAG);
  if (!available()) return;
  try { await caches.delete(NAME); } catch (e) { /* ignore */ }
}

// The ETag the boot fetch sends as If-None-Match.
export function etag() {
  return prefs.get(ETAG, null);
}
