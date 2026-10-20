// Search (spec 4.3): a <dialog> whose input is an ARIA combobox controlling a grid of results. Owner F7.
// No side effects at import time. Opened by Ctrl/Cmd+K, "/", the top bar field and the phone Search tab
// (app.js passes openSearch to keys.js and shell.js).
//
// Groups, in this order:
// 1. Sites (client-side, at most 8). Ranking: exact domain > subdomain or channel > id > name prefix > name word
//    > name substring > domain substring > next step substring. Each row shows the stage, name, domain, owner,
//    clients and last activity; an unowned row has an inline Claim button.
// 2. Contacts (at most 8), matched in memory against GET /api/contacts-index, fetched once per page session on
//    first use and never stored. Enter opens the contact's site with the Contacts section in view.
// 3. Go to (at most 3, only when the query matches a client or a person): the client page, or Sites filtered
//    by that owner.
// 4. "Not in the CRM: Add <domain>" when no site matches a domain-like query; it opens Add site prefilled.
// Input normalisation: lower-case and trimmed; a URL or host goes through format.js#normDomain (scheme, www./m.,
// query and hash dropped, channel paths kept, as cleanDomain); with "@" the contacts are searched by email and
// the email's domain is matched against sites; punctuation is dropped for name matching (normName).
// An empty input lists up to 8 recently opened sites (localStorage "pgcrm-recent", a convenience only).
// Keys: ↑/↓ move, Enter opens, Esc closes; Tab reaches the Claim buttons. A grid rather than a listbox,
// because a listbox option can't hold a button (axe nested-interactive) and the Claim button sits in the row.
//
// Speed (spec G6, under 30 ms per keystroke on 7.5k sites): every keystroke runs one synchronous pass over
// precomputed entries (a WeakMap per store record, so a changed record is the only one recomputed) and keeps
// the best 8 without sorting the whole list.
import { html, raw, render, on } from "../core/dom.js";
import { normDomain, normName, ago, todayIso, num, plural } from "../core/format.js";
import * as store from "../core/store.js";
import * as metaMod from "../core/meta.js";
import * as me from "../core/me.js";
import * as router from "../core/router.js";
import * as prefs from "../core/prefs.js";
import { api } from "../core/api.js";
import { trapFocus } from "../ui/dialog.js";
import { raiseToasts, releaseToasts } from "../ui/toast.js";
import * as actions from "../ui/actions.js";
import { stageDot, avatar, newDot } from "../ui/pills.js";
import { openRecord } from "./record/index.js";
import { openAddSite, domainKey, domainMatch } from "./add-site.js";

export const LIMITS = { sites: 8, contacts: 8, goto: 3, recent: 8 };
const RECENT_KEY = "pgcrm-recent";
const RECENT_KEEP = 20;

const has = (v) => v != null && String(v).trim() !== "";

// ---------- Query ----------

const ID_RE = /^(pg|newc|new|c)\s*-?\s*0*(\d{1,7})$/i;
const EMAIL_RE = /^[^\s@/]+@[^\s@/]*$/;

// The ways one input is read: {raw, lower, email, emailDom, dom, id: {p, n}, digits, name, nameS, wordsS}.
export function parseQuery(text) {
  const raw = String(text == null ? "" : text).replace(/\s+/g, " ").trim().slice(0, 300);
  const lower = raw.toLowerCase();
  const email = EMAIL_RE.test(lower) ? lower : "";
  const emailDom = email ? normDomain(email.slice(email.indexOf("@") + 1)) : "";
  const dom = email || /\s/.test(raw) ? "" : normDomain(raw);
  const m = ID_RE.exec(raw);
  const name = normName(raw);
  const words = name ? name.split(" ") : [];
  return {
    raw,
    lower,
    email,
    emailDom,
    dom,
    id: m ? { p: m[1].toUpperCase(), n: Number(m[2]) } : null,
    digits: /^\d{2,7}$/.test(raw) ? Number(raw) : null,
    name,
    nameS: " " + name,
    wordsS: words.length > 1 ? words.map((w) => " " + w) : null,
  };
}

// ---------- Sites ----------

const entries = new WeakMap();

// The precomputed search fields of one store record (recomputed only when the record object changes).
export function siteEntry(rec) {
  let e = entries.get(rec);
  if (e) return e;
  const id = String(rec.id == null ? "" : rec.id);
  const m = /^([A-Za-z]+)-0*(\d+)$/.exec(id);
  const lab = normName(rec.label || rec.name || rec.domain || "");
  e = {
    rec,
    id,
    idl: id.toLowerCase(),
    idP: m ? m[1].toUpperCase() : "",
    idN: m ? Number(m[2]) : -1,
    dom: domainKey(rec.domain),
    lab,
    labS: " " + lab,
    next: rec.next_step ? String(rec.next_step).toLowerCase() : "",
    act: rec.lastActivity || "",
  };
  entries.set(rec, e);
  return e;
}

// Higher is better; 0 = no match. contactSites: Map(site id -> score) from an email query's contacts.
export function scoreSite(e, q, contactSites) {
  if (q.email) {
    const c = contactSites && contactSites.get(e.id);
    if (c) return c;
    if (q.emailDom && e.dom) {
      const k = domainMatch(q.emailDom, e.dom);
      if (k) return k === "exact" ? 100 : 90;
    }
    return 0;
  }
  if (q.dom && e.dom) {
    const k = domainMatch(q.dom, e.dom);
    if (k) return k === "exact" ? 100 : 90;
  }
  if (q.id && e.idP === q.id.p && e.idN === q.id.n) return 80;
  if (q.digits != null && e.idN === q.digits) return 70;
  const n = q.name;
  if (n.length < 2) return 0;
  if (e.lab.startsWith(n)) return 60;
  if (e.dom && e.dom.startsWith(q.lower)) return 58;
  if (e.labS.includes(q.nameS)) return 50;
  if (q.wordsS && q.wordsS.every((w) => e.labS.includes(w))) return 45;
  if (e.lab.includes(n)) return 40;
  if (e.dom && e.dom.includes(q.lower)) return 38;
  if (e.idl.includes(q.lower)) return 30;
  if (e.next && e.next.includes(q.lower)) return 20;
  return 0;
}

// a ranks above b: score, then the most recent activity, then the name.
function above(a, b) {
  if (a.s !== b.s) return a.s > b.s;
  if (a.e.act !== b.e.act) return a.e.act > b.e.act;
  return a.e.lab < b.e.lab;
}

function keepTop(top, hit, limit) {
  if (top.length >= limit && !above(hit, top[top.length - 1])) return;
  let i = top.length;
  while (i > 0 && above(hit, top[i - 1])) i--;
  top.splice(i, 0, hit);
  if (top.length > limit) top.pop();
}

// The best `limit` sites for a parsed query: {rows: [{e, s}], total, domainHit}. domainHit: a site matched the
// domain of a domain-like query (no "Not in the CRM" footer then).
export function searchSites(list, q, { limit = LIMITS.sites, contactSites = null } = {}) {
  const top = [];
  let total = 0;
  let domainHit = false;
  for (let i = 0; i < list.length; i++) {
    const e = list[i];
    const s = scoreSite(e, q, contactSites);
    if (!s) continue;
    total++;
    if (q.dom && s >= 90) domainHit = true;
    keepTop(top, { e, s }, limit);
  }
  return { rows: top, total, domainHit };
}

// ---------- Contacts ----------

// GET /api/contacts-index {cols, rows} as search entries: {id, acc, name, nameN, nameS, emails, all}.
export function contactEntries(body) {
  if (!body || !Array.isArray(body.cols) || !Array.isArray(body.rows)) return [];
  const ix = (k) => body.cols.indexOf(k);
  const iId = ix("id"), iAcc = ix("account_id"), iName = ix("name"), iEmail = ix("email_lc");
  const out = new Array(body.rows.length);
  for (let i = 0; i < body.rows.length; i++) {
    const r = body.rows[i];
    const name = r[iName] == null ? "" : String(r[iName]).trim();
    const all = r[iEmail] == null ? "" : String(r[iEmail]).toLowerCase();
    const nameN = normName(name);
    const cid = String(r[iId] == null ? "" : r[iId]);
    const m = /^([A-Za-z]+)-0*(\d+)$/.exec(cid);
    out[i] = {
      id: cid,
      idP: m ? m[1].toUpperCase() : "",
      idN: m ? Number(m[2]) : -1,
      acc: String(r[iAcc] == null ? "" : r[iAcc]),
      name,
      nameN,
      nameS: " " + nameN,
      emails: all ? all.split(/[\s,;]+/).filter(Boolean) : [],
      all,
    };
  }
  return out;
}

export function scoreContact(c, q) {
  if (q.email) {
    for (const em of c.emails) if (em === q.email) return 100;
    for (const em of c.emails) if (em.startsWith(q.email)) return 80;
    return c.all.includes(q.email) ? 60 : 0;
  }
  if (q.id) return (q.id.p === "C" || q.id.p === "NEWC") && c.idP === q.id.p && c.idN === q.id.n ? 90 : 0;
  if (q.dom) return c.all.includes("@" + q.dom) ? 40 : 0;
  const n = q.name;
  if (n.length < 2) return 0;
  if (c.nameN.startsWith(n)) return 70;
  if (c.nameS.includes(q.nameS)) return 60;
  if (q.wordsS && q.wordsS.every((w) => c.nameS.includes(w))) return 55;
  if (c.nameN.includes(n)) return 45;
  return c.all.includes(q.lower) ? 40 : 0;
}

// The best `limit` contacts: [{c, s}], best first (score, then named before unnamed, then the name).
export function searchContacts(list, q, { limit = LIMITS.contacts } = {}) {
  const top = [];
  let total = 0;
  const better = (a, b) => (a.s !== b.s ? a.s > b.s : !!a.c.name !== !!b.c.name ? !!a.c.name : (a.c.name || a.c.all) < (b.c.name || b.c.all));
  for (let i = 0; i < list.length; i++) {
    const s = scoreContact(list[i], q);
    if (!s) continue;
    total++;
    const hit = { c: list[i], s };
    if (top.length >= limit && !better(hit, top[top.length - 1])) continue;
    let k = top.length;
    while (k > 0 && better(hit, top[k - 1])) k--;
    top.splice(k, 0, hit);
    if (top.length > limit) top.pop();
  }
  return { rows: top, total };
}

// ---------- Go to ----------

// Clients and people the query names (at most 3): [{kind: 'client', client, past} | {kind: 'person', name}].
export function goTo(q, { meta } = {}) {
  if (!meta || q.email || q.dom || q.id || q.digits != null || q.name.length < 2) return [];
  const hits = [];
  const word = (n) => n.startsWith(q.name) || (" " + n).includes(q.nameS);
  const clients = (meta.clients || []).map((c) => ({ c, past: !!c.past }))
    .concat((meta.past_clients || []).map((c) => ({ c, past: true })));
  const seen = new Set();
  for (const { c, past } of clients) {
    if (!c || c.k == null || seen.has(c.k)) continue;
    const keysN = [c.name, c.k, ...(c.aliases || []), ...(c.products || [])].map(normName).filter(Boolean);
    if (!keysN.some(word)) continue;
    seen.add(c.k);
    hits.push({ kind: "client", client: c, past, rank: normName(c.name) === q.name ? 3 : past ? 0 : 1, label: c.name });
  }
  for (const t of meta.team || []) {
    if (!t || !t.name || t.active === false) continue;
    const n = normName(t.name);
    if (!n.startsWith(q.name)) continue;
    hits.push({ kind: "person", name: String(t.name), rank: n === q.name ? 3 : 2, label: String(t.name) });
  }
  hits.sort((a, b) => b.rank - a.rank || a.label.localeCompare(b.label));
  return hits.slice(0, LIMITS.goto);
}

// ---------- Recently opened sites ----------

let recentStarted = false;

export function recentIds() {
  const list = prefs.getJSON(RECENT_KEY, []);
  return Array.isArray(list) ? list.filter((x) => typeof x === "string" && x) : [];
}

export function noteRecent(id) {
  if (!id) return;
  const key = String(id);
  const list = recentIds().filter((x) => x !== key);
  list.unshift(key);
  prefs.setJSON(RECENT_KEY, list.slice(0, RECENT_KEEP));
}

// Remembers every site the panel opens (router "rec"), so an empty search can list them. app.js may call it
// at boot; openSearch() and openAddSite() calls through here start it too.
export function start() {
  if (recentStarted) return;
  recentStarted = true;
  router.onChange((route) => {
    const id = route && route.params && route.params.rec;
    if (id) noteRecent(id);
  });
  const cur = router.current();
  if (cur && cur.params && cur.params.rec) noteRecent(cur.params.rec);
}

// ---------- Contacts index (once per page session, memory only) ----------

const contacts = { state: "idle", list: null, promise: null, fetches: 0 };

function loadContacts() {
  if (contacts.state === "ready" || contacts.state === "none" || contacts.promise) return contacts.promise;
  contacts.state = "loading";
  contacts.fetches++;
  contacts.promise = api.contactsIndex().then((body) => {
    if (body == null) {
      contacts.state = "none";
      return;
    }
    contacts.list = contactEntries(body);
    contacts.state = "ready";
  }).catch(() => {
    contacts.state = "error";
  }).finally(() => {
    contacts.promise = null;
    if (ui) run({ keep: true });
  });
  return contacts.promise;
}

