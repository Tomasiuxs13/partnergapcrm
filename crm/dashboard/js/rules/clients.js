// Client numbers, the Clients list rows, the client page sections and the monthly report (spec 2.2.4,
// Appendix B.6). Pure: every function takes {meta, today} explicitly and reads derived Records
// (js/core/model.js#derive). No side effects at import time. Owner F5.
//
// - A site belongs to a client when its canonical client set (Record.ck, from meta.splitClients) holds the
//   client's stored key k. Stored tokens are never rewritten (D8): "Ultahost" and "UltaHost" both count for
//   UltaHost. Melograno counts every product unless one is picked; then only tokens of that product count.
// - clientMetrics: sites, prospects (New + Researching), emailed (Contacted), replied (Replied), in talks
//   (Negotiating), active, live (Active with a placement link), waiting (Waiting on client, not closed), lost,
//   byStage, and the reply rate of the old site: every site that wrote back (Replied, Negotiating, Active,
//   Lost) out of every site emailed (any stage except New, Researching and empty).
// - clientRows: one row per active client, in meta order. pastClientRows: the past clients. clientTotals:
//   the "All clients" row, every site with an active client counted once.
// - buildReport: the client-safe monthly report. It never holds next-step text, notes, contact emails,
//   internal ids or owner names: site names come from name or domain only ("Unnamed creator" otherwise),
//   and every string is scrubbed of email addresses.
import { toDay, num, money, pct, plural, date as fmtDate, normName } from "../core/format.js";
import { client as findClient } from "../core/meta.js";

const has = (v) => v != null && String(v).trim() !== "";

export const NOT_CONTACTED = ["New", "Researching"];
// Wrote back, including "no" (the old reply-rate numerator).
export const WROTE_BACK = ["Replied", "Negotiating", "Active", "Lost"];
export const TERMS_NONE = "terms not agreed yet";
export const REPORT_NOTE = "Counts marked approx. use each site's latest contact date, so a site contacted again later counts in the later month.";
const CLOSED = ["Lost", "Do not contact"];
const EMAIL_RE = /[A-Z0-9._%+'-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const HAS_EMAIL = /[A-Z0-9._%+'-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;

// ---------- Clients ----------

function fullClient(meta, k) {
  const m = meta || {};
  const cur = (m.clients || []).find((c) => c && c.k === k);
  if (cur) return Object.assign({}, cur, { past: false });
  const old = (m.past_clients || []).find((c) => c && c.k === k);
  return old ? Object.assign({}, old, { past: true }) : null;
}

const slugOf = (k) => String(k).trim().toLowerCase().replace(/\s+/g, "-");

/**
 * The meta client for a stored key, URL slug, name or alias: {k, slug, name, what, managers, markets,
 * products, token, aliases, past}, or null. An object with a `k` is looked up by that key.
 */
export function clientOf(meta, keyOrSlug) {
  if (keyOrSlug && typeof keyOrSlug === "object") return keyOrSlug.k != null ? clientOf(meta, keyOrSlug.k) : null;
  const s = String(keyOrSlug == null ? "" : keyOrSlug).trim();
  if (!s) return null;
  const direct = fullClient(meta, s) || fullClient(meta, s.toLowerCase());
  const hit = direct ? { k: direct.k } : findClient(meta, s);
  if (!hit) return null;
  const c = fullClient(meta, hit.k);
  if (!c) return null;
  return Object.assign(c, { slug: c.slug || slugOf(c.k), name: c.name || String(c.k) });
}

// The canonical spelling of one of the client's products ("amelia" -> "Amelia"), or null.
export function productOf(client, value) {
  if (!client || !has(value)) return null;
  const want = normName(value);
  return (client.products || []).find((p) => normName(p) === want) || null;
}

// The stored token a new site for this client (and product) gets: "Soro", "Melograno - Amelia".
export function clientToken(client, product) {
  if (!client) return "";
  if (!product) return client.name;
  return (client.token || "{name} - {product}").replace("{name}", client.name).replace("{product}", product);
}

// The Sites filter value for the client (and product): "soro", "melograno-amelia" (as ui/filters.js builds it).
export function clientParam(client, product) {
  if (!client) return "";
  const base = client.slug || slugOf(client.k);
  return product ? base + "-" + normName(product).replace(/\s+/g, "-") : base;
}

// Does the record belong to the client (and product)?
export function inClient(r, client, product) {
  if (!r || !client) return false;
  if (!product) return (r.ck || []).includes(client.k);
  const want = normName(product);
  return (r.clientParts || []).some((p) => p.k === client.k && normName(p.product || "") === want);
}

function resolve(meta, client, product) {
  const c = clientOf(meta, client);
  const p = c ? productOf(c, product) : null;
  return { c, p };
}

/** The client's sites: {meta, client (key, slug or object), product?}. */
export function sitesFor(records, { meta, client, product } = {}) {
  const { c, p } = resolve(meta, client, product);
  if (!c) return [];
  return (records || []).filter((r) => inClient(r, c, p));
}

// ---------- Metrics (B.6) ----------

function blank() {
  return { sites: 0, prospects: 0, emailed: 0, replied: 0, contacted: 0, wroteBack: 0, inTalks: 0, active: 0, live: 0,
    waiting: 0, lost: 0, byStage: {}, replyRate: null };
}

function add(m, r) {
  const st = r.stage || "";
  m.sites++;
  m.byStage[st] = (m.byStage[st] || 0) + 1;
  if (NOT_CONTACTED.includes(st)) m.prospects++;
  if (st === "Contacted") m.emailed++;
  if (st === "Replied") m.replied++;
  if (st && !NOT_CONTACTED.includes(st)) m.contacted++;
  if (WROTE_BACK.includes(st)) m.wroteBack++;
  if (st === "Negotiating") m.inTalks++;
  if (st === "Active") {
    m.active++;
    if (has(r.content_url)) m.live++;
  }
  if (st === "Lost") m.lost++;
  if (r.waitingOnClient && !CLOSED.includes(st)) m.waiting++;
}

function finish(m) {
  m.replyRate = m.contacted ? m.wroteBack / m.contacted : null;
  return m;
}

/** B.6 numbers for one client (or one Melograno product). */
export function clientMetrics(records, { meta, client, product } = {}) {
  const m = blank();
  for (const r of sitesFor(records, { meta, client, product })) add(m, r);
  return finish(m);
}

// "36%" for a 0..1 rate; "–" without one.
export function rateText(rate) {
  return rate == null ? "–" : pct(Math.round(rate * 100));
}

function rowsFor(records, list, meta) {
  const by = new Map();
  for (const c of list) by.set(c.k, blank());
  for (const r of records || []) {
    if (!r || !r.ck || !r.ck.length) continue;
    for (const k of r.ck) {
      const m = by.get(k);
      if (m) add(m, r);
    }
  }
  return list.map((c) => ({ client: clientOf(meta, c.k) || c, metrics: finish(by.get(c.k)) }));
}

/** One row per active client, in meta order: [{client, metrics}]. */
export function clientRows(records, { meta } = {}) {
  return rowsFor(records, ((meta && meta.clients) || []).filter((c) => c && c.k != null), meta);
}

/** One row per past client (Weglot, Termly), in meta order. */
export function pastClientRows(records, { meta } = {}) {
  return rowsFor(records, ((meta && meta.past_clients) || []).filter((c) => c && c.k != null), meta);
}

/** The "All clients" row: every site with at least one active client, counted once. {clients, metrics}. */
export function clientTotals(records, { meta } = {}) {
  const keys = new Set(((meta && meta.clients) || []).filter((c) => c && c.k != null).map((c) => c.k));
  const m = blank();
  for (const r of records || []) {
    if (r && r.ck && r.ck.some((k) => keys.has(k))) add(m, r);
  }
  return { clients: keys.size, metrics: finish(m) };
}

// ---------- Client page sections ----------

// "PG-00412" -> 412; NEW- ids sort above every PG id (they are the newest).
function idRank(id) {
  const s = String(id || "");
  const n = Number((/(\d+)\s*$/.exec(s) || [0, 0])[1]) || 0;
  return /^NEW-/i.test(s) ? 1e9 + n : n;
}

const newestFirst = (a, b) => idRank(b.id) - idRank(a.id);
const dayOrEmpty = (v) => toDay(v) || "";

/** Waiting on client: the client's open sites whose next step starts with "Waiting on client:", longest wait first. */
export function waitingList(records, opts = {}) {
  return sitesFor(records, opts)
    .filter((r) => r.waitingOnClient && !CLOSED.includes(r.stage || ""))
    .sort((a, b) => dayOrEmpty(a.lastActivity).localeCompare(dayOrEmpty(b.lastActivity)) || newestFirst(a, b));
}

/** Deals: Negotiating, then Active; most recent activity first within each. */
export function dealList(records, opts = {}) {
  const order = { Negotiating: 0, Active: 1 };
  return sitesFor(records, opts)
    .filter((r) => r.stage === "Negotiating" || r.stage === "Active")
    .sort((a, b) => order[a.stage] - order[b.stage] || dayOrEmpty(b.lastActivity).localeCompare(dayOrEmpty(a.lastActivity)) || newestFirst(a, b));
}

/** Live placements: Active with a placement link, newest live date first (no date last). */
export function liveList(records, opts = {}) {
  return sitesFor(records, opts)
    .filter((r) => r.stage === "Active" && has(r.content_url))
    .sort((a, b) => {
      const da = dayOrEmpty(a.live_date), db = dayOrEmpty(b.live_date);
      if (da && db) return db.localeCompare(da) || newestFirst(a, b);
      return da ? -1 : db ? 1 : newestFirst(a, b);
    });
}

function goodDr(r) {
  const n = r.dr == null || r.dr === "" ? NaN : Number(r.dr);
  return isFinite(n) && n >= 20 && n <= 80;
}

/** Best new prospects: not contacted, not a big site; DR 20–80 first, then newest. {rows (≤ limit), total}. */
export function bestProspects(records, { meta, client, product, limit = 10 } = {}) {
  const all = sitesFor(records, { meta, client, product }).filter((r) => r.notContacted && !r.isPlatform);
  all.sort((a, b) => (goodDr(b) ? 1 : 0) - (goodDr(a) ? 1 : 0) || newestFirst(a, b));
  return { rows: all.slice(0, limit), total: all.length };
}

/** Pipeline bars: [{stage, n, color}] for every stage in meta order ("Do not contact" only when used or on). */
export function pipelineRows(records, { meta, client, product } = {}) {
  const m = clientMetrics(records, { meta, client, product });
  const dnc = !!(meta && meta.features && meta.features.dnc);
  const stages = ((meta && meta.stages) || []).slice().sort((a, b) => (a.order || 0) - (b.order || 0));
  return stages
    .filter((s) => s.name !== "Do not contact" || dnc || m.byStage[s.name] > 0)
    .map((s) => ({ stage: s.name, n: m.byStage[s.name] || 0, color: s.color || "" }));
}

// ---------- Client-safe text ----------

function scrub(s) {
  return String(s == null ? "" : s).replace(EMAIL_RE, "(email hidden)").replace(/\s+/g, " ").trim();
}

/** The name a client may see: the site name, else its website, else "Unnamed creator" (never a contact or an id). */
export function safeName(r) {
  if (!r) return "Unnamed creator";
  return scrub(r.name) || scrub(r.domain) || "Unnamed creator";
}

const isUnnamed = (r) => !scrub(r && r.name) && !scrub(r && r.domain);

const numOrNull = (v) => {
  if (v == null || v === "") return null;
  const n = Number(v);
  return isFinite(n) ? n : null;
};

/** Deal terms a client may see: "Flat fee + commission · $350 + 30%" from the model, flat fee and %; "" without. */
export function clientTerms(r) {
  if (!r) return "";
  const parts = [];
  const flat = numOrNull(r.deal_flat);
  const p = numOrNull(r.deal_pct);
  if (flat != null) parts.push(money(flat));
  if (p != null) parts.push(pct(p));
  return [scrub(r.deal_model), parts.join(" + ")].filter(Boolean).join(" · ");
}

/**
 * "Copy list for client": what is waiting on the client, client-safe (name, terms and the text after
 * "Waiting on client:"). No owners, ids, notes or emails.
 */
export function waitingCopyText(list, { client, product, today } = {}) {
  const who = client ? clientToken(client, product) : "you";
  const head = "Waiting on " + who + (today ? " (" + fmtDate(today, "year") + ")" : "");
  const lines = (list || []).map((r) => {
    const terms = clientTerms(r);
    const what = scrub(r.nextText);
    return "- " + safeName(r) + (terms ? " (" + terms + ")" : "") + (what ? ": " + what : "");
  });
  return [head, "", ...lines].join("\n");
}

// ---------- Monthly report ----------

const pad = (n) => String(n).padStart(2, "0");

/** The report months: the current month and the 5 before it, newest first ("2026-10", "2026-09", …). */
export function reportMonths(today, n = 6) {
  const d = toDay(today);
  if (!d) return [];
  let y = Number(d.slice(0, 4));
  let m = Number(d.slice(5, 7));
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push(y + "-" + pad(m));
    m--;
    if (m < 1) { m = 12; y--; }
  }
  return out;
}

/** The report's default month: last month. */
export function defaultMonth(today) {
  return reportMonths(today, 2)[1] || "";
}

/** "2026-09" -> "September 2026". */
export function monthLabel(ym) {
  return /^\d{4}-\d{2}$/.test(String(ym || "")) ? fmtDate(ym + "-01", "month") : "";
}

const inMonth = (v, ym) => {
  const d = toDay(v);
  return !!d && d.slice(0, 7) === ym;
};

// One collator (localeCompare with options builds a new one on each call; same order).
let nameOrder = null;
const byName = (a, b) => {
  if (!nameOrder) nameOrder = new Intl.Collator("en", { sensitivity: "base" });
  return nameOrder.compare(safeName(a), safeName(b));
};

/**
 * The monthly report for a client (and product), client-safe (spec 2.2.4). Returns null for an unknown
 * client, else {title, client, product, month, monthLabel, contacted, replies, inTalks: [{name, terms}],
 * activeCount, live: [{name, website, url, date}], pipeline, warnings: [text], text}.
 * - contacted: sites emailed (any stage except New/Researching) whose last touch is in the month (approx.)
 * - replies: sites that wrote back whose reply date (Record.replyDate) is in the month (approx.)
 * - live: live_date in the month and on or before today; the link only when it is http(s)
 * - warnings: deals in talks without terms, live dates after today (left out), unnamed creators, placements
 *   without a web link
 */
export function buildReport(records, { meta, client, product, month, today } = {}) {
  const { c, p } = resolve(meta, client, product);
  if (!c) return null;
  const ym = /^\d{4}-\d{2}$/.test(String(month || "")) ? month : defaultMonth(today);
  const label = monthLabel(ym);
  const sites = (records || []).filter((r) => inClient(r, c, p));
  const m = blank();
  for (const r of sites) add(m, r);
  finish(m);

  let contacted = 0;
  let replies = 0;
  for (const r of sites) {
    const st = r.stage || "";
    if (st && !NOT_CONTACTED.includes(st) && inMonth(r.last_touch, ym)) contacted++;
    if (WROTE_BACK.includes(st) && inMonth(r.replyDate, ym)) replies++;
  }

  const talks = sites.filter((r) => r.stage === "Negotiating").sort(byName);
  const inTalks = talks.map((r) => ({ name: safeName(r), terms: clientTerms(r) }));
  const noTerms = inTalks.filter((x) => !x.terms).length;

  const day = toDay(today) || "";
  const liveRows = sites.filter((r) => inMonth(r.live_date, ym) && (!day || toDay(r.live_date) <= day))
    .sort((a, b) => dayOrEmpty(a.live_date).localeCompare(dayOrEmpty(b.live_date)) || byName(a, b));
  const live = liveRows.map((r) => {
    const raw = String(r.content_url == null ? "" : r.content_url).trim();
    const url = /^https?:\/\/[^\s"'<>]+$/i.test(raw) && !HAS_EMAIL.test(raw) ? raw : "";
    const name = safeName(r);
    const dom = scrub(r.domain);
    return { name, website: dom && dom !== name ? dom : "", url, date: toDay(r.live_date) };
  });
  const future = day ? sites.filter((r) => toDay(r.live_date) && toDay(r.live_date) > day)
    .sort((a, b) => dayOrEmpty(a.live_date).localeCompare(dayOrEmpty(b.live_date))) : [];
  const unnamed = talks.filter(isUnnamed).length + liveRows.filter(isUnnamed).length;
  const noLink = live.filter((x) => !x.url).length;

  const warnings = [];
  if (noTerms) {
    warnings.push(num(noTerms) + " " + plural(noTerms, "deal") + " in talks " + (noTerms === 1 ? "has" : "have") +
      " no terms yet, so " + (noTerms === 1 ? "it shows" : "they show") + " as “" + TERMS_NONE + "”.");
  }
  if (future.length) {
    const dates = future.slice(0, 3).map((r) => fmtDate(r.live_date, "short")).join(", ") + (future.length > 3 ? ", …" : "");
    warnings.push(num(future.length) + " " + plural(future.length, "placement has a live date", "placements have live dates") +
      " after today (" + dates + "), so " + (future.length === 1 ? "it is" : "they are") + " left out until then.");
  }
  if (unnamed) {
    warnings.push(num(unnamed) + " " + plural(unnamed, "site has", "sites have") + " no name or website, so " +
      (unnamed === 1 ? "it shows" : "they show") + " as “Unnamed creator”. Add a name on the site to fix this.");
  }
  if (noLink) {
    warnings.push(num(noLink) + " live " + plural(noLink, "placement has", "placements have") + " no web link, so " +
      (noLink === 1 ? "it shows" : "they show") + " without one.");
  }

  const pipeline = num(m.sites) + " " + plural(m.sites, "site") + " in total: " + num(m.prospects) + " not contacted yet, " +
    num(m.contacted) + " contacted so far, " + num(m.wroteBack) + " wrote back (" + rateText(m.replyRate) + " reply rate), " +
    num(m.inTalks) + " in talks and " + num(m.active) + " active " + plural(m.active, "partner") + ".";

  const report = {
    title: clientToken(c, p) + " affiliate report, " + label,
    client: c.name,
    product: p,
    month: ym,
    monthLabel: label,
    contacted,
    replies,
    inTalks,
    activeCount: m.active,
    live,
    pipeline,
    warnings,
    text: "",
  };
  report.text = reportText(report);
  return report;
}

/** The report as plain text, ready to paste into an email (Copy as email). */
export function reportText(r) {
  if (!r) return "";
  const lines = [
    r.title,
    "",
    "In " + r.monthLabel,
    "- Sites contacted (approx.): " + num(r.contacted),
    "- Replies (approx.): " + num(r.replies),
    "- Placements that went live: " + num(r.live.length),
    "",
    "Now",
    "- Deals in talks: " + num(r.inTalks.length),
    "- Active partners: " + num(r.activeCount),
    "",
    "Placements live in " + r.monthLabel,
  ];
  if (r.live.length) {
    for (const x of r.live) {
      lines.push("- " + x.name + (x.website ? " (" + x.website + ")" : "") + (x.date ? ", live " + fmtDate(x.date, "day") : "") +
        (x.url ? ": " + x.url : ""));
    }
  } else {
    lines.push("None went live in " + r.monthLabel + ".");
  }
  lines.push("", "Deals in talks now");
  if (r.inTalks.length) for (const x of r.inTalks) lines.push("- " + x.name + ": " + (x.terms || TERMS_NONE));
  else lines.push("No deals in talks right now.");
  lines.push("", "Pipeline", r.pipeline, "", REPORT_NOTE);
  return lines.map(scrub).join("\n");
}
