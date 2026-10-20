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

// A contact's email score as the score of its site in the Sites group: the site of an exact address ranks
// above a site whose domain is the email's domain (ann@x.example.test belongs to Annex Reviews, not x.example.test).
const CONTACT_SITE = { 100: 105, 80: 85 };

// The best `limit` contacts: {rows: [{c, s}], total, sites}, best first (score, then named before unnamed,
// then the name). sites: Map(site id -> score) of the sites whose contacts have the typed email (exact or
// prefix), for scoreSite().
export function searchContacts(list, q, { limit = LIMITS.contacts } = {}) {
  const top = [];
  const sites = new Map();
  let total = 0;
  const better = (a, b) => (a.s !== b.s ? a.s > b.s : !!a.c.name !== !!b.c.name ? !!a.c.name : (a.c.name || a.c.all) < (b.c.name || b.c.all));
  for (let i = 0; i < list.length; i++) {
    const s = scoreContact(list[i], q);
    if (!s) continue;
    total++;
    if (q.email && CONTACT_SITE[s] && list[i].acc) {
      const prev = sites.get(list[i].acc) || 0;
      if (CONTACT_SITE[s] > prev) sites.set(list[i].acc, CONTACT_SITE[s]);
    }
    const hit = { c: list[i], s };
    if (top.length >= limit && !better(hit, top[top.length - 1])) continue;
    let k = top.length;
    while (k > 0 && better(hit, top[k - 1])) k--;
    top.splice(k, 0, hit);
    if (top.length > limit) top.pop();
  }
  return { rows: top, total, sites };
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


// ---------- The dialog ----------

let ui = null; // the open dialog: {dialog, input, grid, note, live, rows, active, ...}

const ICONS = {
  search: '<circle cx="11" cy="11" r="7"/><path d="M21 21l-5-5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  client: '<path d="M4 20V8l8-4 8 4v12"/><path d="M9 20v-6h6v6"/>',
  list: '<path d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
};
const icon = (name) => raw('<svg viewBox="0 0 24 24" aria-hidden="true">' + ICONS[name] + "</svg>");

const readOnly = () => !!(metaMod.get() || {}).read_only;

function siteEntries() {
  const recs = store.all();
  const out = new Array(recs.length);
  for (let i = 0; i < recs.length; i++) out[i] = siteEntry(recs[i]);
  return out;
}

function recentRecords() {
  const out = [];
  for (const id of recentIds()) {
    const r = store.get(id);
    if (r) out.push(r);
    if (out.length >= LIMITS.recent) break;
  }
  return out;
}

// What one input shows: {q, recent, sites, contacts, goto, add}. Pure apart from reading the store and
// the contacts index.
function compute(q) {
  const res = { q, recent: null, sites: null, contacts: null, goto: [], add: "" };
  if (!q.raw) {
    res.recent = recentRecords();
    return res;
  }
  let contactSites = null;
  if (contacts.state === "ready") {
    res.contacts = searchContacts(contacts.list, q);
    if (q.email) contactSites = res.contacts.sites;
  }
  res.sites = searchSites(siteEntries(), q, { contactSites });
  res.goto = goTo(q, { meta: metaMod.get() });
  if (q.dom && !res.sites.domainHit) res.add = q.dom;
  return res;
}

// ----- rows -----

function ownerHtml(owner) {
  if (!has(owner)) return html`<span class="se-owner is-none">No owner</span>`;
  const mine = owner === me.get();
  return html`<span class="se-owner">${avatar(owner, { size: "xs" })}<span>${mine ? owner + " (me)" : owner}</span></span>`;
}

function siteRow(rec, i, today) {
  const label = rec.label || rec.name || rec.domain || rec.id;
  const bits = [];
  if (rec.domain && rec.domain !== label) bits.push(rec.domain);
  bits.push(rec.stage || "No stage");
  if (rec.cl && rec.cl.length) bits.push(rec.cl.join(", "));
  const when = rec.lastActivity ? ago(rec.lastActivity, today) : "";
  const claim = !has(rec.owner) && !readOnly();
  return html`<div role="row" class="se-row" data-i="${i}">
<div role="gridcell" class="se-cell" id="${"se-opt-" + i}" aria-selected="false">
  <span class="se-lead">${stageDot(rec.stage)}</span>
  <span class="se-main"><span class="se-title"><span class="se-name">${label}</span>${newDot(rec)}</span><span class="se-sub">${bits.join(" · ")}</span></span>
  <span class="se-side">${ownerHtml(rec.owner)}${when ? html`<span class="se-when">Last activity ${when}</span>` : ""}</span>
</div>
<div role="gridcell" class="se-actcell">${claim ? html`<button type="button" class="ui-btn is-sm se-claim" data-claim="${rec.id}" aria-label="${"Claim " + label}" title="Make it yours, with a follow-up in 2 working days">Claim</button>` : ""}</div>
</div>`;
}

function contactRow(hit, i) {
  const c = hit.c;
  const site = store.get(c.acc);
  const siteLabel = site ? site.label || site.name || site.domain || site.id : c.acc;
  const title = c.name || c.emails[0] || "Unnamed contact";
  const bits = [];
  if (c.emails.length && (c.name || c.emails.length > 1)) bits.push(c.emails.join(", "));
  bits.push("at " + siteLabel);
  return html`<div role="row" class="se-row" data-i="${i}">
<div role="gridcell" class="se-cell" id="${"se-opt-" + i}" aria-selected="false">
  <span class="se-lead">${avatar(c.name || c.emails[0] || "?", { size: "xs" })}</span>
  <span class="se-main"><span class="se-title"><span class="se-name">${title}</span></span><span class="se-sub">${bits.join(" · ")}</span></span>
  <span class="se-side">${ownerHtml(site ? site.owner : "")}</span>
</div>
<div role="gridcell" class="se-actcell"></div>
</div>`;
}

function simpleRow(i, lead, title, sub) {
  return html`<div role="row" class="se-row" data-i="${i}">
<div role="gridcell" class="se-cell" id="${"se-opt-" + i}" aria-selected="false">
  <span class="se-lead">${lead}</span>
  <span class="se-main"><span class="se-title"><span class="se-name">${title}</span></span>${sub ? html`<span class="se-sub">${sub}</span>` : ""}</span>
</div>
<div role="gridcell" class="se-actcell"></div>
</div>`;
}

function noteRow(text, { tone = "", action = null } = {}) {
  return html`<div role="row" class="${"se-note-row" + (tone ? " is-" + tone : "")}"><div role="gridcell" class="se-note-cell" aria-colspan="2"><span>${text}</span>${action
    ? html` <button type="button" class="ui-linkbtn" data-note-act="${action.act}">${action.label}</button>` : ""}</div></div>`;
}

// A group of rows with a heading row; title null: no heading (label: its accessible name).
function group(id, title, count, rows, { label = "" } = {}) {
  if (title == null) return html`<div role="rowgroup" class="${"se-group is-" + id}" aria-label="${label}">${rows}</div>`;
  return html`<div role="rowgroup" class="${"se-group is-" + id}" aria-labelledby="${"se-h-" + id}">
<div role="row" class="se-ghead"><span role="columnheader" id="${"se-h-" + id}" aria-colspan="2">${title}${count ? html` <span class="se-gcount">${count}</span>` : ""}</span></div>
${rows}
</div>`;
}

// The grid's markup and the selectable rows ({key, kind, ...}) in order.
function build(res) {
  const q = res.q;
  const today = todayIso();
  const rows = [];
  const parts = [];
  const add = (row) => {
    rows.push(row);
    return rows.length - 1;
  };
  if (res.recent) {
    if (res.recent.length) {
      parts.push(group("recent", "Recently opened", "", res.recent.map((r) => siteRow(r, add({ key: "s:" + r.id, kind: "site", id: r.id }), today))));
    }
    return { rows, markup: html`${parts}` };
  }
  const s = res.sites;
  if (s.rows.length) {
    const list = s.rows.map((h) => siteRow(h.e.rec, add({ key: "s:" + h.e.id, kind: "site", id: h.e.id }), today));
    if (s.total > s.rows.length) {
      const i = add({ key: "more", kind: "more" });
      list.push(simpleRow(i, icon("list"), "See all " + num(s.total) + " matching sites", "Opens Sites with this search"));
    }
    parts.push(group("sites", "Sites", s.total > s.rows.length ? s.rows.length + " of " + num(s.total) : String(s.total), list));
  }
  if (res.add) {
    const text = readOnly() ? "Not in the CRM: " + res.add : "Not in the CRM: Add " + res.add;
    const list = readOnly()
      ? [noteRow(text)]
      : [simpleRow(add({ key: "add", kind: "add", domain: res.add }), icon("plus"), text, "Opens Add site with this address filled in")];
    parts.push(group("add", null, "", list, { label: "Not in the CRM" }));
  }
  const cq = q.name.length >= 2 || q.email || q.dom || q.id;
  if (cq) {
    let list = [];
    let count = "";
    if (contacts.state === "ready" && res.contacts) {
      const c = res.contacts;
      list = c.rows.map((h) => contactRow(h, add({ key: "c:" + h.c.id, kind: "contact", id: h.c.acc, cid: h.c.id })));
      if (c.total) count = c.total > c.rows.length ? c.rows.length + " of " + num(c.total) : String(c.total);
      if (!c.total && q.email) {
        list.push(noteRow("No contacts match “" + q.raw + "”. New contacts from the sheet appear the next weekday morning."));
      }
    } else if (contacts.state === "loading" || contacts.state === "idle") {
      list.push(noteRow("Looking up contacts…", { tone: "muted" }));
    } else if (contacts.state === "none") {
      list.push(noteRow("Contact search: Not available yet.", { tone: "muted" }));
    } else if (contacts.state === "error") {
      list.push(noteRow("Couldn't load the contacts.", { tone: "muted", action: { act: "retry", label: "Try again" } }));
    }
    if (list.length) parts.push(group("contacts", "Contacts", count, list));
  }
  if (res.goto.length) {
    parts.push(group("goto", "Go to", "", res.goto.map((g) => {
      if (g.kind === "client") {
        const i = add({ key: "g:c:" + g.client.k, kind: "client", client: g.client });
        return simpleRow(i, icon("client"), g.client.name, g.past ? "Client page · past client" : "Client page" + (g.client.what ? " · " + g.client.what : ""));
      }
      const i = add({ key: "g:p:" + g.name, kind: "person", name: g.name });
      return simpleRow(i, avatar(g.name, { size: "xs" }), g.name, g.name === me.get() ? "Your sites" : "Sites owned by " + g.name);
    })));
  }
  return { rows, markup: html`${parts}` };
}

// ----- drawing -----

function emptyText(res) {
  if (!res.recent || res.recent.length) return "";
  return "Type a site name, paste a link or an email, or type an ID such as PG-00123.";
}

function summary(res) {
  if (res.recent) return res.recent.length ? res.recent.length + " recently opened " + plural(res.recent.length, "site") : "";
  const bits = [];
  if (res.sites && res.sites.total) bits.push(num(res.sites.total) + " " + plural(res.sites.total, "site"));
  if (res.contacts && res.contacts.total) bits.push(num(res.contacts.total) + " " + plural(res.contacts.total, "contact"));
  if (res.goto.length) bits.push(res.goto.length + " to go to");
  if (res.add && !bits.length) return "Not in the CRM";
  return bits.length ? bits.join(", ") : "No matches";
}

function setActive(i, { scroll = true } = {}) {
  if (!ui) return;
  const prev = ui.grid.querySelector('.se-cell[aria-selected="true"]');
  if (prev) {
    prev.setAttribute("aria-selected", "false");
    prev.parentElement.classList.remove("is-active");
  }
  if (i == null || i < 0 || i >= ui.rows.length) {
    ui.active = -1;
    ui.input.removeAttribute("aria-activedescendant");
    return;
  }
  ui.active = i;
  const cell = ui.grid.querySelector("#se-opt-" + i);
  if (!cell) return;
  cell.setAttribute("aria-selected", "true");
  cell.parentElement.classList.add("is-active");
  ui.input.setAttribute("aria-activedescendant", cell.id);
  if (scroll) cell.parentElement.scrollIntoView({ block: "nearest" });
}

// One pass for the current input (every keystroke): search, draw, keep the active row when asked.
function run({ keep = false } = {}) {
  if (!ui) return;
  const q = parseQuery(ui.input.value);
  const keepKey = keep && ui.active >= 0 && ui.rows[ui.active] ? ui.rows[ui.active].key : null;
  const res = compute(q);
  const { rows, markup } = build(res);
  ui.rows = rows;
  ui.res = res;
  render(ui.grid, markup);
  const hasRows = ui.grid.firstElementChild != null;
  ui.grid.hidden = !hasRows;
  ui.input.setAttribute("aria-expanded", hasRows ? "true" : "false");
  const text = emptyText(res);
  ui.note.textContent = text;
  ui.note.hidden = !text;
  ui.noMatch.hidden = !(q.raw && !hasRows);
  if (!ui.noMatch.hidden) render(ui.noMatch, html`<p class="se-nomatch-h">Nothing matches “${q.raw}”.</p><p>Try a link, a domain, an email, a name or an ID such as PG-00123.</p>`);
  let next = rows.length ? 0 : -1;
  if (keepKey) {
    const k = rows.findIndex((r) => r.key === keepKey);
    if (k >= 0) next = k;
  }
  setActive(next, { scroll: false });
  if (next === 0) ui.body.scrollTop = 0;
  clearTimeout(ui.timers.live);
  const said = summary(res);
  ui.timers.live = setTimeout(() => {
    if (ui) ui.live.textContent = said;
  }, 500);
}

// ----- actions -----

function activate(i) {
  if (!ui) return;
  const row = ui.rows[i];
  if (!row) return;
  const input = ui.input.value.trim();
  close();
  switch (row.kind) {
    case "site":
      openRecord(row.id);
      break;
    case "contact":
      openRecord(row.id, { focus: "contacts" });
      break;
    case "client":
      router.go("clients", {}, { sub: row.client.slug || row.client.k });
      break;
    case "person":
      router.go("sites", { tab: "all", owner: row.name === me.get() ? "me" : row.name });
      break;
    case "add":
      openAddSite(input || row.domain);
      break;
    case "more":
      router.go("sites", { tab: "all", q: input });
      break;
    default:
      break;
  }
}

async function claim(btn) {
  const id = btn.getAttribute("data-claim");
  btn.disabled = true;
  btn.textContent = "Claiming…";
  let rec = null;
  try {
    rec = await actions.claim(id);
  } catch (e) {
    rec = null;
  }
  if (!ui) return;
  if (!rec && btn.isConnected) {
    btn.disabled = false;
    btn.textContent = "Claim";
  }
  run({ keep: true });
  if (ui) ui.input.focus();
}

function onKey(e) {
  if (!ui || e.isComposing) return;
  const n = ui.rows.length;
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    if (e.target !== ui.input) ui.input.focus();
    e.preventDefault();
    if (!n) return;
    const d = e.key === "ArrowDown" ? 1 : -1;
    setActive(ui.active < 0 ? (d > 0 ? 0 : n - 1) : (ui.active + d + n) % n);
  } else if (e.key === "Enter" && e.target === ui.input) {
    e.preventDefault();
    if (ui.active >= 0) activate(ui.active);
  } else if ((e.ctrlKey || e.metaKey) && (e.key === "k" || e.key === "K")) {
    e.preventDefault();
    ui.input.focus();
    ui.input.select();
  }
}

function close() {
  if (!ui) return;
  const u = ui;
  ui = null;
  for (const t of Object.values(u.timers)) clearTimeout(t);
  for (const off of u.offs) off();
  releaseToasts(u.dialog);
  if (u.dialog.open) u.dialog.close();
  u.dialog.remove();
  const o = u.opener;
  if (o && o.isConnected && typeof o.focus === "function") {
    try { o.focus({ preventScroll: true }); } catch (e) { /* not focusable */ }
  }
}

// True while the search dialog is open.
export function isOpen() {
  return !!ui;
}

// Opens Search (spec 4.3). query: text to start with (selected, so typing replaces it).
export function openSearch({ query = "" } = {}) {
  if (typeof document === "undefined") return;
  start();
  if (ui) {
    if (query) {
      ui.input.value = query;
      run();
    }
    ui.input.focus();
    ui.input.select();
    return;
  }
  const dialog = document.createElement("dialog");
  dialog.className = "se-dialog";
  dialog.setAttribute("aria-label", "Search");
  render(dialog, html`<div class="se-box">
<div class="se-bar">
  <span class="se-glass">${icon("search")}</span>
  <input class="se-input" type="text" role="combobox" aria-expanded="false" aria-controls="se-grid" aria-haspopup="grid" aria-autocomplete="list"
    aria-label="Search sites, contacts, clients and people" aria-describedby="se-keys" placeholder="Search or paste a link…"
    autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" enterkeyhint="go" maxlength="300">
  <button type="button" class="se-close" data-close aria-label="Close search"><kbd class="se-esc">Esc</kbd><span class="se-cancel">Cancel</span></button>
</div>
<div class="se-body">
  <p class="se-hint" data-note hidden></p>
  <div class="se-nomatch" data-nomatch hidden></div>
  <div role="grid" id="se-grid" class="se-grid" aria-label="Search results" hidden></div>
</div>
<p class="se-keys" id="se-keys"><span><kbd>↑</kbd><kbd>↓</kbd> move</span><span><kbd>Enter</kbd> open</span><span><kbd>Esc</kbd> close</span></p>
<p class="sr-only" aria-live="polite" data-live></p>
</div>`);
  const u = {
    dialog,
    input: dialog.querySelector(".se-input"),
    grid: dialog.querySelector(".se-grid"),
    body: dialog.querySelector(".se-body"),
    note: dialog.querySelector("[data-note]"),
    noMatch: dialog.querySelector("[data-nomatch]"),
    live: dialog.querySelector("[data-live]"),
    rows: [],
    res: null,
    active: -1,
    timers: {},
    offs: [],
    opener: document.activeElement && document.activeElement !== document.body ? document.activeElement : null,
  };
  ui = u;
  u.offs.push(trapFocus(dialog));
  u.offs.push(on(u.input, "input", null, () => run()));
  u.offs.push(on(dialog, "keydown", null, onKey));
  u.offs.push(on(dialog, "click", "[data-close]", () => close()));
  u.offs.push(on(dialog, "click", "[data-claim]", (e, b) => {
    e.stopPropagation();
    claim(b);
  }));
  u.offs.push(on(dialog, "click", "[data-note-act]", () => {
    if (contacts.state === "error") contacts.state = "idle";
    loadContacts();
    run({ keep: true });
  }));
  u.offs.push(on(u.grid, "click", ".se-row[data-i]", (e, row) => {
    if (e.target.closest("button")) return;
    activate(Number(row.getAttribute("data-i")));
  }));
  u.offs.push(on(u.grid, "mousemove", ".se-row[data-i]", (e, row) => {
    const i = Number(row.getAttribute("data-i"));
    if (i !== u.active) setActive(i, { scroll: false });
  }));
  // Esc: close (the browser would close the dialog without cleaning up). A click on the backdrop closes too.
  const onCancel = (e) => {
    e.preventDefault();
    close();
  };
  dialog.addEventListener("cancel", onCancel);
  u.offs.push(() => dialog.removeEventListener("cancel", onCancel));
  u.offs.push(on(dialog, "click", null, (e) => {
    if (e.target !== dialog) return;
    const r = dialog.getBoundingClientRect();
    if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) close();
  }));
  // A store change (a claim, a refresh) redraws the results; the active row stays.
  u.offs.push(store.subscribe(() => {
    if (ui === u) run({ keep: true });
  }));

  document.body.appendChild(dialog);
  dialog.showModal();
  raiseToasts(dialog);
  u.input.value = query || "";
  run();
  u.input.focus();
  if (query) u.input.select();
  loadContacts();
  // Warm the per-site search fields after the first paint, so the first keystroke is as fast as the rest.
  u.timers.warm = setTimeout(() => {
    if (ui === u) siteEntries();
  }, 0);
}

// Test and measurement aid: the number of /api/contacts-index requests this page session made.
export function contactsFetches() {
  return contacts.fetches;
}
