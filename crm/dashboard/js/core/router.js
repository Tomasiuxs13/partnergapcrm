// Hash router: #<page>[/<sub>][?k=v&...] (spec 2.4, 5.4). G0 stub; owner G1-A.
// Minimal working version: parses the hash, sends unknown pages home and notifies listeners.
// Not yet done (G1-A): legacy redirects, ?h= from sign-in, guards, the rec param and the record panel.

let pageIds = [];
let homeId = "today";
let cur = { page: "", sub: "", params: {} };
let started = false;
const listeners = new Set();
const guards = new Set();

function parse(hash) {
  const h = String(hash || "").replace(/^#/, "");
  const qi = h.indexOf("?");
  const path = qi < 0 ? h : h.slice(0, qi);
  const parts = path.split("/");
  const params = {};
  if (qi >= 0) for (const [k, v] of new URLSearchParams(h.slice(qi + 1))) params[k] = v;
  return { page: parts[0] || "", sub: parts.slice(1).join("/"), params };
}

function apply() {
  let next = parse(window.location.hash);
  if (!pageIds.includes(next.page)) {
    window.history.replaceState(null, "", href(homeId, next.params));
    next = parse(window.location.hash);
  }
  const prev = cur;
  cur = next;
  for (const fn of Array.from(listeners)) fn(cur, prev);
}

export function start(pages) {
  pageIds = (pages || []).map((p) => p && p.id).filter(Boolean);
  homeId = pageIds[0] || "today";
  if (!started) {
    started = true;
    window.addEventListener("hashchange", apply);
  }
  apply();
}

export function current() {
  return { page: cur.page, sub: cur.sub, params: Object.assign({}, cur.params) };
}

export function href(page, params = {}, sub = "") {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params || {})) if (v != null && v !== "") qs.set(k, v);
  const q = qs.toString();
  return "#" + page + (sub ? "/" + sub : "") + (q ? "?" + q : "");
}

export function go(page, params = {}, { sub = "", replace = false } = {}) {
  const h = href(page, params, sub);
  if (replace) {
    window.history.replaceState(null, "", h);
    apply();
  } else if (window.location.hash === h) {
    apply();
  } else {
    window.location.hash = h;
  }
}

export function setParams(patch, { replace = false } = {}) {
  const params = Object.assign({}, cur.params);
  for (const [k, v] of Object.entries(patch || {})) {
    if (v == null) delete params[k];
    else params[k] = v;
  }
  go(cur.page, params, { sub: cur.sub, replace });
}

export function onChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function addGuard(fn) {
  guards.add(fn);
  return () => guards.delete(fn);
}
