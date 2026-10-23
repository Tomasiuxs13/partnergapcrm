// Partners (Tomas, 2026-10-23): which sites work with which clients, the Partners page list, and the
// partners a client page suggests. Pure functions over store records and GET /api/deals rows; no DOM and
// no side effects at import.
//
// How a site relates to a client (one link per client):
//   - partner: a deal for that client is Signed or Live (deal stage Active), or the site is at Active and
//     has no deals (before migration 006, or a site whose deal was never added): every client on it
//   - program: the site came from the master partner list ("Past work (import)") at Replied, which is that
//     list's "Active / Responded": it was in the client's affiliate program
//   - talks: a deal for that client is Negotiating (or the site is, without deals)
// A client page suggests the sites linked to another client in the same category (meta client
// .category, set in Help › Settings) that aren't with this client yet: partners first, then program
// partners, then sites in talks, each by DR.
import { client as metaClient } from "../core/meta.js";
import { clientOf } from "./clients.js";

export const KINDS = ["partner", "program", "talks"];
export const KIND_TEXT = { partner: "Partner", program: "Past program partner", talks: "In talks" };
export const IMPORT_SOURCE = "Past work (import)";
export const SUGGEST_LIMIT = 12;

const CLOSED = ["Lost", "Do not contact"];
const RANK = { partner: 0, program: 1, talks: 2 };
const has = (v) => v != null && String(v).trim() !== "";
const low = (s) => String(s == null ? "" : s).trim().toLowerCase();

function dealsBySite(deals) {
  const by = new Map();
  for (const d of Array.isArray(deals) ? deals : []) {
    const k = String(d.account_id);
    if (!by.has(k)) by.set(k, []);
    by.get(k).push(d);
  }
  return by;
}

// One link per client key, keeping the strongest kind.
function addLink(links, link) {
  const i = links.findIndex((x) => x.k === link.k);
  if (i < 0) links.push(link);
  else if (RANK[link.kind] < RANK[links[i].kind]) links[i] = link;
}

/**
 * The site's links to clients: [{k, name, kind, dealId?, live?}], strongest first. siteDeals: the site's
 * deals (or null/[] when it has none).
 */
export function siteLinks(r, siteDeals, { meta } = {}) {
  const links = [];
  if (!r || r.stage === "Do not contact") return links;
  const deals = Array.isArray(siteDeals) ? siteDeals : [];
  for (const d of deals) {
    if (d.stage !== "Active" && d.stage !== "Negotiating") continue;
    const c = metaClient(meta, d.client);
    const k = c ? c.k : low(d.client);
    if (!k) continue;
    const live = d.stage === "Active" && (has(d.live_date) || has(d.content_url));
    addLink(links, { k, name: c ? c.name : String(d.client), kind: d.stage === "Active" ? "partner" : "talks", dealId: String(d.id), live });
  }
  const parts = r.clientParts || [];
  if (!deals.length && (r.stage === "Active" || r.stage === "Negotiating")) {
    const kind = r.stage === "Active" ? "partner" : "talks";
    for (const p of parts) addLink(links, { k: p.k, name: p.name, kind, live: kind === "partner" && has(r.content_url) });
  }
  if (r.stage === "Replied" && r.source === IMPORT_SOURCE) {
    for (const p of parts) addLink(links, { k: p.k, name: p.name, kind: "program" });
  }
  return links.sort((a, b) => RANK[a.kind] - RANK[b.kind] || a.name.localeCompare(b.name));
}

const byDr = (a, b) => (b.r.dr ?? -1) - (a.r.dr ?? -1) || (b.r.traffic ?? -1) - (a.r.traffic ?? -1) ||
  String(a.r.label).localeCompare(String(b.r.label));

/**
 * The Partners page rows: every site that is a partner or past program partner of at least one client.
 * [{r, links, kind ('partner' | 'program'), live}], partners first, then by DR. tab: 'all' | 'now' | 'program'.
 * client: a client key, slug or name to keep only that client's partners.
 */
export function partnerRows(records, deals, { meta, tab = "all", client = "", owner = "" } = {}) {
  const by = dealsBySite(deals);
  const c = client ? clientOf(meta, client) : null;
  const out = [];
  for (const r of records || []) {
    let links = siteLinks(r, by.get(String(r.id)), { meta }).filter((l) => l.kind !== "talks");
    if (c) links = links.filter((l) => l.k === c.k);
    if (!links.length) continue;
    const kind = links[0].kind;
    if (tab === "now" && kind !== "partner") continue;
    if (tab === "program" && kind !== "program") continue;
    if (owner === "none" ? has(r.owner) : owner && low(r.owner) !== low(owner)) continue;
    out.push({ r, links, kind, live: links.some((l) => l.live) });
  }
  return out.sort((a, b) => RANK[a.kind] - RANK[b.kind] || byDr(a, b));
}

/** {all, now, program}: how many sites each Partners tab holds (no client or owner filter). */
export function partnerCounts(records, deals, { meta } = {}) {
  const rows = partnerRows(records, deals, { meta });
  return { all: rows.length, now: rows.filter((x) => x.kind === "partner").length, program: rows.filter((x) => x.kind === "program").length };
}

/** The clients (current and past) whose category is the client's, without the client itself. */
export function sameCategory(meta, c) {
  const cat = c && has(c.category) ? low(c.category) : "";
  if (!cat) return [];
  const all = ((meta && meta.clients) || []).map((x) => Object.assign({ past: false }, x))
    .concat(((meta && meta.past_clients) || []).map((x) => Object.assign({}, x, { past: true })));
  return all.filter((x) => x.k !== c.k && low(x.category) === cat);
}

/**
 * Suggested partners for a client: {category, others, rows: [{r, via}], total}. category is null when the
 * client has none (the page asks for one). others: the clients in the same category. via: the links to
 * those clients, strongest first. Sites already with this client (a client tag or any deal for it), Lost,
 * Do not contact and big platforms are left out.
 */
export function suggestedPartners(records, deals, { meta, client, limit = SUGGEST_LIMIT } = {}) {
  const c = clientOf(meta, client);
  if (!c) return { category: null, others: [], rows: [], total: 0 };
  const category = has(c.category) ? String(c.category) : null;
  const others = sameCategory(meta, c);
  if (!category || !others.length) return { category, others, rows: [], total: 0 };
  const keys = new Set(others.map((x) => x.k));
  const by = dealsBySite(deals);
  const out = [];
  for (const r of records || []) {
    if (CLOSED.includes(r.stage) || r.isPlatform) continue;
    if ((r.ck || []).includes(c.k)) continue;
    const siteDeals = by.get(String(r.id)) || [];
    if (siteDeals.some((d) => { const x = metaClient(meta, d.client); return (x ? x.k : low(d.client)) === c.k; })) continue;
    const via = siteLinks(r, siteDeals, { meta }).filter((l) => keys.has(l.k));
    if (!via.length) continue;
    out.push({ r, via });
  }
  out.sort((a, b) => RANK[a.via[0].kind] - RANK[b.via[0].kind] || b.via.length - a.via.length || byDr(a, b));
  return { category, others, rows: out.slice(0, Math.max(0, limit)), total: out.length };
}

/** "Partner of MailerLite · past program partner of UltaHost" (the via line of a suggestion). */
export function viaText(via) {
  const groups = [];
  for (const kind of KINDS) {
    const names = (via || []).filter((l) => l.kind === kind).map((l) => l.name);
    if (!names.length) continue;
    const list = names.length > 2 ? names.slice(0, 2).join(", ") + " and " + (names.length - 2) + " more" : names.join(" and ");
    groups.push((kind === "partner" ? "Partner of " : kind === "program" ? "past program partner of " : "in talks with ") + list);
  }
  const s = groups.join(" · ");
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : "";
}
