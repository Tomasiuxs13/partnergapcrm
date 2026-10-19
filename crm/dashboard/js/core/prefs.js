// localStorage conveniences (me, dismissed banners, recent sites, cache ETag), always in try/catch
// (spec 5.1). G0 stub; owner G1-A. The API below is a placeholder that G1-A may change.

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
