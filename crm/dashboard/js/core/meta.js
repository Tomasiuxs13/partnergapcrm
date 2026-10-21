// Site constants from GET /api/meta (spec 5.4, 6.3.1). Owner G1-A.
// load() reads the boot fetch started in index.html (or the snapshot's meta), get() returns it.
// The helpers take meta explicitly so rule modules stay pure. No side effects at import time.
import { api, configure, readResponse } from "./api.js";
import * as bus from "./bus.js";

const STAGES = [
  { name: "New", desc: "Found, not contacted yet", color: "new", order: 1, not_contacted: true, closed: false, in_path: true },
  { name: "Researching", desc: "Finding the right contact", color: "research", order: 2, not_contacted: true, closed: false, in_path: false },
  { name: "Contacted", desc: "Emailed, waiting for an answer", color: "contacted", order: 3, not_contacted: false, closed: false, in_path: true },
  { name: "Replied", desc: "Wrote back; the owner answers next", color: "replied", order: 4, not_contacted: false, closed: false, in_path: true },
  { name: "Negotiating", desc: "Talking terms", color: "neg", order: 5, not_contacted: false, closed: false, in_path: true },
  { name: "Active", desc: "Agreed to work with us", color: "active", order: 6, not_contacted: false, closed: false, in_path: true },
  { name: "Lost", desc: "Said no or went quiet", color: "lost", order: 7, not_contacted: false, closed: true, in_path: false },
  { name: "Do not contact", desc: "Never email this site again", color: "dnc", order: 8, not_contacted: false, closed: true, in_path: false, flag: "dnc" },
];

// The neutral shape every key falls back to (also used under a real /api/meta body).
function base() {
  return {
    v: 2,
    build: null,
    read_only: false,
    stages: STAGES.map((s) => Object.assign({}, s)),
    deal_models: [],
    activity_types: [],
    affiliate_types: [],
    team: [],
    admins: [],
    clients: [],
    past_clients: [],
    sla: {},
    follow_up_days: {},
    reply_window: { email: 30, touch: 7 },
    noreply_cap: 10,
    lost_reasons: [],
    platform_domains: [],
    platform_dr: 90,
    schedule: [],
    timezone: "Europe/Vilnius",
    prod_host: "partnergap-crm.pages.dev",
    sheet_url: "",
    test_mode: true,
    limits: { plan: "free", bulk_ids: 90, bulk_rows: 20 },
    features: { settings: false, suggestions: false, runs: false, dnc: false },
    freshness: null,
  };
}

const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);

// Server values win; nested objects (limits, features, sla...) are merged one level deep.
function merge(into, body) {
  for (const [k, v] of Object.entries(body || {})) {
    into[k] = isObj(v) && isObj(into[k]) ? Object.assign({}, into[k], v) : v;
  }
  return into;
}

// Writes are allowed only on the production host and on local hosts (spec 4.14 b).
export function hostAllowsWrites(host, prodHost) {
  const h = String(host || "").toLowerCase();
  return h === String(prodHost || "partnergap-crm.pages.dev").toLowerCase() ||
    h === "localhost" || h === "127.0.0.1" || h === "[::1]" || h === "::1";
}

let current = null;

function finish(m, { snapshot = false } = {}) {
  const host = typeof location !== "undefined" ? location.hostname : "localhost";
  m.read_only = !!(snapshot || m.read_only || !hostAllowsWrites(host, m.prod_host));
  configure({ readOnly: m.read_only, prodHost: m.prod_host, limits: m.limits });
  current = m;
  return m;
}

export async function load() {
  const w = typeof window !== "undefined" ? window : {};
  if (w.__SNAPSHOT__) {
    finish(merge(base(), w.__SNAPSHOT__.meta || {}), { snapshot: true });
    return;
  }
  let body = null;
  try {
    body = w.__boot && w.__boot.meta ? await readResponse(w.__boot.meta) : await api.meta();
  } catch (e) {
    body = null;
  }
  // Without a usable /api/meta body (an error, or a 404 "unavailable") the neutral shape is used.
  finish(isObj(body) && Array.isArray(body.stages) ? merge(base(), body) : base());
}

// Re-reads /api/meta (freshness, build, overrides). Keeps the current values if it fails.
export async function refresh() {
  if (typeof window !== "undefined" && window.__SNAPSHOT__) return get();
  let body = null;
  try { body = await api.meta(); } catch (e) { body = null; }
  if (isObj(body) && Array.isArray(body.stages)) {
    finish(merge(base(), body));
    bus.emit("meta", current);
  }
  return get();
}

export function get() {
  if (!current) current = base();
  return current;
}

export function stage(meta, name) {
  const list = (meta && meta.stages) || [];
  return list.find((s) => s.name === name) || null;
}

// The weekday time of the morning copy ("08:47", Vilnius), read from meta.schedule.
export function runTime(meta) {
  const list = (meta && meta.schedule) || [];
  const row = list.find((x) => /daily|morning copy/i.test((x && x.name) || "")) || null;
  const m = row && /(\d{1,2}):(\d{2})/.exec(row.when || "");
  return m ? m[1].padStart(2, "0") + ":" + m[2] : "08:47";
}

// ---------- Clients ----------

// "Botanical Synthesis", "botanical-synthesis" and "botanicalsynthesis" all compact to one key.
function compact(s) {
  return String(s == null ? "" : s).normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

const slugOf = (k) => String(k).trim().toLowerCase().replace(/\s+/g, "-");

const indexes = new WeakMap();
function index(meta) {
  if (!meta || typeof meta !== "object") return { byKey: new Map(), withProducts: [], byProduct: new Map(), split: new Map() };
  let ix = indexes.get(meta);
  if (ix) return ix;
  ix = { byKey: new Map(), withProducts: [], byProduct: new Map(), split: new Map() };
  const add = (c, past) => {
    if (!c || c.k == null) return;
    const entry = { k: String(c.k), slug: c.slug || slugOf(c.k), name: c.name || String(c.k), past, products: c.products || null, token: c.token || null };
    for (const key of [c.k, c.name, c.slug, ...(c.aliases || [])]) {
      const ck = compact(key);
      if (ck && !ix.byKey.has(ck)) ix.byKey.set(ck, entry);
    }
    if (entry.products && entry.products.length) {
      ix.withProducts.push(entry);
      for (const p of entry.products) ix.byProduct.set(compact(p), { entry, product: p });
    }
  };
  for (const c of meta.clients || []) add(c, false);
  for (const c of meta.past_clients || []) add(c, true);
  indexes.set(meta, ix);
  return ix;
}

const pick = (e, product) => {
  const out = { k: e.k, slug: e.slug, name: e.name, past: e.past };
  if (product) out.product = product;
  return out;
};

// A known client by stored key, URL slug, name, alias or raw sheet token. Melograno tokens carry
// the product: client(meta, "Melograno - Trafft") -> {k: 'melograno', ..., product: 'Trafft'}.
export function client(meta, keyOrRaw) {
  const s = String(keyOrRaw == null ? "" : keyOrRaw).trim();
  if (!s) return null;
  const ix = index(meta);
  const c = compact(s);
  const hit = ix.byKey.get(c);
  if (hit) return pick(hit, null);
  for (const e of ix.withProducts) {
    for (const prefix of [compact(e.name), compact(e.k)]) {
      if (prefix && c.startsWith(prefix)) {
        const rest = c.slice(prefix.length);
        const p = ix.byProduct.get(rest);
        if (p && p.entry === e) return pick(e, p.product);
        const m = /[-:–]\s*(.+)$/.exec(s);
        return pick(e, rest ? (m ? m[1].trim() : rest) : null);
      }
    }
  }
  const p = ix.byProduct.get(c);
  if (p) return pick(p.entry, p.product);
  return null;
}

// Splits a stored clients value on "," and "/". Raw tokens are kept as they are (spec D8).
// Unknown tokens get k = the lower-cased token (as the old clientKey()) and name = the token.
export function splitClients(meta, raw) {
  const s = String(raw == null ? "" : raw);
  if (!s.trim()) return [];
  const ix = index(meta);
  const cached = ix.split.get(s);
  if (cached) return cached.map((t) => Object.assign({}, t));
  const out = [];
  for (const tok of s.split(/\s*[,/]\s*/)) {
    const t = tok.trim();
    if (!t) continue;
    const c = client(meta, t);
    if (c) {
      const part = { k: c.k, name: c.name, raw: t, slug: c.slug, past: c.past, known: true };
      if (c.product) part.product = c.product;
      out.push(part);
    } else {
      const k = t.toLowerCase();
      out.push({ k, name: t, raw: t, slug: slugOf(k), past: false, known: false });
    }
  }
  ix.split.set(s, out);
  return out.map((t) => Object.assign({}, t));
}

// The display name of a split token: "UltaHost", or "Melograno - Trafft" for a product token.
export function clientLabel(meta, part) {
  if (!part) return "";
  if (!part.product) return part.name;
  const c = ((meta && meta.clients) || []).find((x) => x.k === part.k);
  const tpl = (c && c.token) || "{name} - {product}";
  return tpl.replace("{name}", part.name).replace("{product}", part.product);
}

// Big platforms (spec D7): a root host in meta.platform_domains, or DR >= platform_dr, and never a
// creator channel path (youtube.com/@name keeps its own row and is a prospect).
export function isPlatform(meta, domain, dr) {
  const d = String(domain == null ? "" : domain).trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/+$/, "");
  if (!d || d.includes("/")) return false;
  if (((meta && meta.platform_domains) || []).includes(d)) return true;
  const n = dr == null || dr === "" ? NaN : Number(dr);
  const min = meta && meta.platform_dr != null ? Number(meta.platform_dr) : 90;
  return isFinite(n) && n >= min;
}
