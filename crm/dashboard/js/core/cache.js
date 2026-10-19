// Cache Storage for the v2 site list (spec 4.11): cache 'pgcrm', key /api/partners?v=2, and its
// ETag in localStorage 'pgcrm-cache-etag'. Written only after a full 200 load, never per patch.
// Quota and other errors are ignored. Owner G1-A. No side effects at import time.
import * as prefs from "./prefs.js";

const NAME = "pgcrm";
const KEY = "/api/partners?v=2";
const ETAG = "pgcrm-cache-etag";

const available = () => typeof caches !== "undefined";

// {data, etag, generatedAt, cachedAt} or null.
export async function read() {
  if (!available()) return null;
  try {
    const c = await caches.open(NAME);
    const res = await c.match(KEY);
    if (!res) return null;
    const data = await res.json();
    return {
      data,
      etag: res.headers.get("ETag") || null,
      generatedAt: res.headers.get("X-Generated-At") || null,
      cachedAt: res.headers.get("X-Cached-At") || null,
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
