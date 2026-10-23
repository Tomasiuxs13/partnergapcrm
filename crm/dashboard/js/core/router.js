// Hash router: #<page>[/<sub>][?k=v&...] (spec 2.4, 4.2, 5.4). Owner G1-A. No side effects at import.
//
// - Legacy URLs are redirected with replaceState: #home, #prospecting, #tasks, #partners (only while no
//   Partners page exists; it is back since 2026-10-23), #reports, #campaigns, #changes, #client-<slug>,
//   #rec-<ID> and #rec/<ID> (2.4). An empty hash or an unknown
//   page goes to the home page (me.home(): Today, or Team overview for Vik), keeping `rec`.
// - start() turns /?h=<encoded hash> from sign-in back into the hash (replaceState).
// - Guards: on a route change every guard gets the next route. If one returns false or a promise,
//   the router puts the previous hash back with history.replaceState at once; when every guard
//   then allows it, the new hash is applied again (spec 4.2 "Discard your note?").
// - The window 'hashchange' listener lives in shell.js (spec 5.1); it calls sync().
let pageIds = [];
let homeId = "today";
let cur = { page: "", sub: "", params: {} };
let curHash = "";
let started = false;
let token = 0;
const listeners = new Set();
const guards = new Set();

const LEGACY = {
  home: { page: "today" },
  tasks: { page: "today" },
  prospecting: { page: "sites", params: { tab: "mine" } },
  partners: { page: "deals" },
  reports: { page: "team" },
  campaigns: { page: "clients" },
  changes: { page: "history" },
};

function decode(s) {
  try { return decodeURIComponent(s); } catch (e) { return s; }
}

function parse(hash) {
  const h = String(hash || "").replace(/^#/, "");
  const qi = h.indexOf("?");
  const path = qi < 0 ? h : h.slice(0, qi);
  const segs = path.split("/");
  const params = {};
  if (qi >= 0) for (const [k, v] of new URLSearchParams(h.slice(qi + 1))) params[k] = v;
  return { page: decode(segs[0] || ""), sub: decode(segs.slice(1).join("/")), params };
}

const copy = (r) => ({ page: r.page, sub: r.sub, params: Object.assign({}, r.params) });

// Where a hash should really go: {route, redirect}. redirect is true for legacy, empty and unknown.
function resolve(hash) {
  const h = String(hash || "").replace(/^#/, "");
  let m = /^rec[-/](.+?)(?:\?.*)?$/.exec(h);
  if (m) return { route: { page: homeId, sub: "", params: { rec: decode(m[1]) } }, redirect: true };
  m = /^client-([^?]+)(?:\?.*)?$/.exec(h);
  if (m) return { route: { page: "clients", sub: decode(m[1]), params: {} }, redirect: true };
  const r = parse(hash);
  const legacy = LEGACY[r.page];
  if (legacy && !pageIds.includes(r.page)) {
    const params = Object.assign({}, legacy.params || {});
    if (r.params.rec) params.rec = r.params.rec;
    return { route: { page: legacy.page, sub: "", params }, redirect: true };
  }
  if (!pageIds.includes(r.page)) {
    return { route: { page: homeId, sub: "", params: r.params.rec ? { rec: r.params.rec } : {} }, redirect: true };
  }
  return { route: r, redirect: false };
}

function sameRoute(a, b) {
  return a.page === b.page && a.sub === b.sub && href(a.page, a.params, a.sub) === href(b.page, b.params, b.sub);
}

function commit(next) {
  const prev = cur;
  cur = copy(next);
  curHash = location.hash;
  for (const fn of Array.from(listeners)) {
    try { fn(copy(cur), copy(prev)); } catch (e) { if (typeof console !== "undefined") console.error(e); }
  }
}

function setUrl(hash, replace) {
  const url = location.pathname + location.search + hash;
  if (replace) history.replaceState(history.state, "", url);
  else history.pushState(null, "", url);
}

// Runs the guards for `next`. urlChanged: the address bar already shows `next` (a link click, Back,
// or a typed URL); push/replace: how to write the URL once allowed (programmatic navigation).
function transition(next, { urlChanged, replace }) {
  const nextHash = href(next.page, next.params, next.sub);
  if (started && sameRoute(next, cur)) {
    if (urlChanged && location.hash !== curHash) setUrl(curHash || nextHash, true);
    return;
  }
  const my = ++token;
  const results = [];
  let wait = false;
  if (started) {
    for (const g of Array.from(guards)) {
      let r;
      try { r = g(copy(next)); } catch (e) { r = true; }
      results.push(r);
      if (r === false || (r && typeof r.then === "function")) wait = true;
    }
  }
  if (!wait) {
    if (!urlChanged || location.hash !== nextHash) setUrl(nextHash, urlChanged ? true : replace);
    commit(next);
    return;
  }
  // Show the previous route while the guard decides.
  if (urlChanged) setUrl(curHash, true);
  Promise.all(results.map((r) => Promise.resolve(r).catch(() => false))).then((answers) => {
    if (my !== token) return;
    if (answers.some((a) => a === false)) return;
    setUrl(nextHash, urlChanged ? true : replace);
    commit(next);
  });
}

// Applies location.hash (called by shell.js on 'hashchange', and by start()).
export function sync() {
  if (!started) return;
  const { route, redirect } = resolve(location.hash);
  if (redirect) setUrl(href(route.page, route.params, route.sub), true);
  transition(route, { urlChanged: true, replace: true });
}

// pages: the page modules (their ids); opts.home: the landing page id (me.home(meta)).
export function start(pages, { home } = {}) {
  pageIds = (pages || []).map((p) => (p && typeof p === "object" ? p.id : p)).filter(Boolean);
  homeId = home && pageIds.includes(home) ? home : pageIds[0] || "today";
  // /?h=<encoded hash> from sign-in (spec 5.3, 6.3.14): put the hash back, drop the parameter.
  const sp = new URLSearchParams(location.search);
  if (sp.has("h")) {
    const h = sp.get("h") || "";
    sp.delete("h");
    const rest = sp.toString();
    const hash = !h || h === "#" ? "" : h.charAt(0) === "#" ? h : "#" + h;
    history.replaceState(history.state, "", location.pathname + (rest ? "?" + rest : "") + hash);
  }
  const { route, redirect } = resolve(location.hash);
  if (redirect || !location.hash) setUrl(href(route.page, route.params, route.sub), true);
  started = false;
  cur = { page: "", sub: "", params: {} };
  commit(route);
  started = true;
}

// The landing page for empty, unknown and #rec- links (changes when the person changes).
export function setHome(id) {
  if (id && (!pageIds.length || pageIds.includes(id))) homeId = id;
}

export function current() {
  return copy(cur);
}

export function href(page, params = {}, sub = "") {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params || {})) if (v != null && v !== "") qs.set(k, String(v));
  const q = qs.toString();
  const s = sub ? "/" + String(sub).replace(/[?#%\s]/g, (c) => encodeURIComponent(c)) : "";
  return "#" + page + s + (q ? "?" + q : "");
}

export function go(page, params = {}, { sub = "", replace = false } = {}) {
  if (!started) {
    setUrl(href(page, params, sub), true);
    return;
  }
  const { route } = resolve(href(page, params, sub));
  transition(route, { urlChanged: false, replace });
}

// Changes only the given params; null or undefined deletes one.
export function setParams(patch, { replace = false } = {}) {
  const params = Object.assign({}, cur.params);
  for (const [k, v] of Object.entries(patch || {})) {
    if (v == null) delete params[k];
    else params[k] = v;
  }
  go(cur.page, params, { sub: cur.sub, replace });
}

// fn(route, prev) after every route change (and once at start, with an empty prev).
export function onChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// fn(next) -> boolean | Promise<boolean>. On false the previous hash is already restored
// (history.replaceState) and nothing changes.
export function addGuard(fn) {
  guards.add(fn);
  return () => guards.delete(fn);
}
