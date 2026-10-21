// localStorage conveniences (me, dismissed banners, recent sites, cache ETag), always in try/catch
// (spec 5.1). Owner G1-A. Never use it for state that must survive: it can be empty at any time.
// Keys in use: pgcrm-me (me.js), pgcrm-cache-etag (cache.js), pgcrm-dismiss-<banner> (shell.js).

export function get(key, fallback = null) {
  try {
    const v = localStorage.getItem(key);
    return v == null ? fallback : v;
  } catch (e) {
    return fallback;
  }
}

export function set(key, value) {
  try { localStorage.setItem(key, String(value)); } catch (e) { /* storage blocked */ }
}

export function remove(key) {
  try { localStorage.removeItem(key); } catch (e) { /* storage blocked */ }
}

export function getJSON(key, fallback = null) {
  const v = get(key, null);
  if (v == null) return fallback;
  try { return JSON.parse(v); } catch (e) { return fallback; }
}

export function setJSON(key, value) {
  try { set(key, JSON.stringify(value)); } catch (e) { /* not serialisable */ }
}
