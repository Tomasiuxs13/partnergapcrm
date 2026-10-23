// Contacts (Tomas, 2026-10-23): every person in the CRM, one row each. Page module contract (spec 5.4).
// Reached from the sidebar's Records group and the More sheet.
//
// Header: h1 "Contacts", one line, Export CSV. The filter bar (Search, Client, Owner) and one list: Name
// (opens the contact's own page, #contact/<id>), Title, Site (opens the site's record), Client, Email,
// Status, Last email, Owner (the site's). Search matches name, email, title, site and domain.
// The rows come from GET /api/contacts (asked once per mount, again on Retry); the site columns come from
// the store. The snapshot has no contacts (no email addresses leave the login), so it says so.
// URL: q, client, owner, and the list's sort and page.
import { html, render, on } from "../core/dom.js";
import { num, plural, date as fmtDate, ago } from "../core/format.js";
import { createList, toCsv, csvColumnsOf, downloadText, csvFileName } from "../ui/list.js";
import { createFilterBar, applyFilters } from "../ui/filters.js";
import { emptyState, EMPTY } from "../ui/empty.js";
import { skeletonRows } from "../ui/skeleton.js";
import { ownerChip } from "../ui/pills.js";

const FIELDS = ["q", "client", "owner"];
const SUB = "Everyone we have a name for, with the site they work at. Open a name for their page.";

const has = (v) => v != null && String(v).trim() !== "";
const low = (s) => String(s == null ? "" : s).toLowerCase();
const title = () => "Contacts";
const contactsText = (n) => num(n) + " " + plural(n, "contact");
const dash = html`<span class="ui-faint" aria-label="none">—</span>`;
const snapshotMode = () => typeof window !== "undefined" && !!window.__SNAPSHOT__;

let st = null; // the mounted page's state

function fresh(root, ctx) {
  // raw: undefined while GET /api/contacts is out, null when it failed or in the snapshot, else the rows.
  return { root, ctx, offs: [], list: null, bar: null, raw: undefined, rows: [], view: [], frame: 0, announced: false, sayTimer: 0 };
}

function params(ctx) {
  return (ctx && ctx.route && ctx.route.params) || {};
}

function me(ctx) {
  try { return ctx.me.get() || null; } catch (e) { return null; }
}

function filterParams(p) {
  const out = {};
  for (const k of FIELDS) if (has(p[k])) out[k] = String(p[k]);
  return out;
}

const filtered = (p) => FIELDS.some((k) => has(p[k]));

/** "Jane Doe", else the first or last name, else the id. */
export function contactName(c) {
  const n = [c.first_name, c.last_name].filter(has).join(" ").trim();
  return n || String(c.id || "");
}

// A contact row the filters understand: clients (the contact's client, else the site's), owner (the
// site's), and q, the text Search looks through.
function rowOf(c, site) {
  const name = contactName(c);
  const clients = has(c.client) ? String(c.client) : site ? site.clients || "" : "";
  return {
    id: String(c.id),
    contact: c,
    name,
    title: c.title || "",
    email: c.email || "",
    status: c.outreach_status || "",
    last_email: c.last_email || "",
    siteId: String(c.account_id || ""),
    site,
    label: site ? site.label || site.domain : String(c.account_id || ""),
    domain: site ? site.domain : "",
    owner: site ? site.owner || "" : "",
    clients,
    q: low([c.id, name, c.email, c.title, site && site.label, site && site.domain, c.account_id].filter(has).join(" ")),
  };
}

function buildRows(ctx) {
  if (!Array.isArray(st.raw)) return [];
  return st.raw.map((c) => rowOf(c, ctx.store.get(c.account_id) || null));
}

// ---------- columns ----------

function nameCell(r) {
  const href = st ? st.ctx.href("contact", {}, r.id) : "#";
  return html`<span class="ui-site"><a class="ui-row-link" href="${href}" data-open="${r.id}">${r.name}</a>${r.contact.primary_contact ? html`<span class="ui-sub">Main contact</span>` : ""}</span>`;
}

function siteCell(r) {
  if (!r.siteId) return dash;
  const p = st ? Object.assign({}, params(st.ctx), { rec: r.siteId }) : {};
  const href = st ? st.ctx.href("contacts", p) : "#";
  return r.site
    ? html`<a class="rv-tap" href="${href}" data-ct-site="${r.siteId}">${r.label}</a>`
    : html`<span class="ui-faint">${r.siteId}</span>`;
}

function lastCell(r, cx) {
  if (!has(r.last_email)) return dash;
  const d = String(r.last_email).slice(0, 10);
  return html`<span title="${fmtDate(d, "year")}">${ago(d, cx && cx.today)}</span>`;
}

const COLS = [
  { id: "name", label: "Name", priority: 1, className: "is-site", cell: nameCell, sort: (r) => low(r.name), csv: [{ label: "ID", value: (r) => r.id }, { label: "Name", value: (r) => r.name }] },
  { id: "title", label: "Title", priority: 2, cell: (r) => (has(r.title) ? html`${r.title}` : dash), sort: (r) => low(r.title) || null, csv: (r) => r.title },
  { id: "site", label: "Site", priority: 1, cell: siteCell, sort: (r) => low(r.label), csv: [{ label: "Site", value: (r) => r.label }, { label: "Domain", value: (r) => r.domain }] },
  { id: "client", label: "Client", priority: 2, cell: (r) => (has(r.contact.client) ? html`<span class="ui-tag">${r.contact.client}</span>` : dash), sort: (r) => low(r.contact.client) || null, csv: (r) => r.contact.client },
  { id: "email", label: "Email", priority: 2, className: "ct-c-email", cell: (r) => (has(r.email) ? html`<span class="ct-email">${r.email}</span>` : dash), sort: (r) => low(r.email) || null, csv: (r) => r.email },
  { id: "status", label: "Status", priority: 3, cell: (r) => (has(r.status) ? html`${r.status}` : dash), sort: (r) => low(r.status) || null, csv: (r) => r.status },
  { id: "last_email", label: "Last email", priority: 3, cell: lastCell, sort: (r) => r.last_email || null, csv: (r) => r.last_email },
  { id: "owner", label: "Owner", priority: 2, cell: (r) => ownerChip({ id: r.siteId, owner: r.owner }, { edit: false }), sort: (r) => low(r.owner) || null, csv: (r) => r.owner },
];

// ---------- drawing ----------

function say(text, { now = false } = {}) {
  clearTimeout(st.sayTimer);
  if (now) return st.ctx.announce(text);
  st.sayTimer = setTimeout(() => { if (st) st.ctx.announce(text); }, 700);
}

function noteHtml() {
  if (snapshotMode()) return emptyState({ title: "Contacts aren't in this copy.", body: "Open the live site to see them. This copy has no email addresses." });
  return emptyState({ title: "Contacts didn't load.", body: "Check your connection and try again.", action: { label: "Try again", act: "retry" } });
}

function draw(what = "all") {
  if (!st) return;
  st.frame = 0;
  const ctx = st.ctx;
  const p = params(ctx);
  if (st.bar && what !== "store") st.bar.update(filterParams(p));
  const body = st.root.querySelector("[data-ct-body]");
  const skel = st.root.querySelector("[data-ct-loading]");
  const emptyEl = st.root.querySelector("[data-ct-empty]");
  const listEl = st.root.querySelector("[data-ct-list]");
  const csv = st.root.querySelector("[data-ct-csv]");
  if (st.raw === undefined) {
    skel.hidden = false;
    body.setAttribute("aria-busy", "true");
    listEl.hidden = true;
    return;
  }
  skel.hidden = true;
  body.removeAttribute("aria-busy");
  if (st.raw === null) {
    listEl.hidden = true;
    emptyEl.hidden = false;
    render(emptyEl, noteHtml());
    if (csv) csv.disabled = true;
    return;
  }
  if (what !== "route") st.rows = buildRows(ctx);
  st.view = applyFilters(st.rows, filterParams(p), { meta: ctx.meta, me: me(ctx) });
  const none = !st.view.length;
  listEl.hidden = none;
  emptyEl.hidden = !none;
  render(emptyEl, none
    ? (filtered(p) ? emptyState({ title: "No contacts match.", body: EMPTY.filtered.body, action: { label: "Clear filters", act: "clear" } }) : emptyState({ title: "No contacts yet.", body: "Contacts from the sheet appear the next weekday morning." }))
    : html``);
  if (csv) csv.disabled = none;
  if (st.list) st.list.refresh();
  const text = none ? (filtered(p) ? "No contacts match" : "No contacts yet") : contactsText(st.view.length);
  if (!st.announced) {
    st.announced = true;
    say("Contacts, " + text.charAt(0).toLowerCase() + text.slice(1), { now: true });
  } else if (what === "route") {
    say(text);
  }
}

function schedule(what) {
  if (!st) return;
  st.pending = st.pending && st.pending !== what ? "all" : what;
  if (st.frame) return;
  const raf = typeof requestAnimationFrame === "function" ? requestAnimationFrame : (fn) => setTimeout(fn, 16);
  st.frame = raf(() => {
    if (!st) return;
    const w = st.pending || "all";
    st.pending = null;
    draw(w);
  }) || 1;
}

async function load() {
  const mine = st;
  st.raw = undefined;
  draw("all");
  let r = null;
  try {
    r = await st.ctx.api.contacts();
  } catch (e) {
    r = null;
  }
  if (st !== mine) return;
  st.raw = r && Array.isArray(r.rows) && Array.isArray(r.cols)
    ? r.rows.map((row) => Object.fromEntries(r.cols.map((c, i) => [c, row[i]])))
    : null;
  schedule("store");
}

function exportCsv() {
  if (!st.view.length) return;
  const rows = st.list ? st.list.rows() : st.view;
  downloadText(csvFileName("contacts", st.ctx.today), toCsv(rows, csvColumnsOf(COLS, { today: st.ctx.today })), st.root);
}

function bind() {
  const root = st.root;
  st.offs.push(on(root, "click", "[data-ct-csv]", () => exportCsv()));
  st.offs.push(on(root, "click", "[data-ct-site]", (e, a) => {
    if (e.ctrlKey || e.metaKey || e.shiftKey || e.altKey || e.button === 1) return; // new tab
    e.preventDefault();
    st.ctx.openRecord(a.getAttribute("data-ct-site"));
  }));
  st.offs.push(on(root, "click", "[data-empty-act]", (e, b) => {
    const act = b.getAttribute("data-empty-act");
    if (act === "retry") load();
    else if (act === "clear") {
      const patch = { page: null };
      for (const k of FIELDS) patch[k] = null;
      st.ctx.setParams(patch);
    }
  }));
}

export default {
  id: "contacts",
  title,
  mount(root, ctx) {
    if (st) this.unmount();
    st = fresh(root, ctx);
    render(root, html`<div class="ct-page"><header class="si-head"><div class="si-head-text"><h1 tabindex="-1">Contacts</h1><p class="si-sub">${SUB}</p></div><button type="button" class="ui-btn is-sm is-ghost pt-csv" data-ct-csv data-download><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v11M7 10l5 5 5-5M5 20h14"/></svg>Export CSV</button></header><div class="pt-filters" data-ct-filters></div><div class="pt-body" data-ct-body><div data-ct-loading hidden>${skeletonRows(6)}</div><div class="pt-list" data-ct-list></div><div data-ct-empty hidden></div></div></div>`);
    st.bar = createFilterBar(root.querySelector("[data-ct-filters]"), {
      fields: FIELDS,
      params: filterParams(params(ctx)),
      onChange: (patch, opts) => st && st.ctx.setParams(Object.assign({ page: null }, patch), { replace: !!(opts && opts.replace) }),
      records: () => (st ? st.ctx.store.all() : []),
      label: "Filters",
    });
    st.list = createList(root.querySelector("[data-ct-list]"), {
      id: "contacts",
      rows: () => (st ? st.view : []),
      columns: COLS,
      sort: { key: "name", dir: "asc" },
      csv: false, // one Export CSV in the header
      noun: ["contact", "contacts"],
      label: "Contacts",
      empty: () => html``,
      recOf: (r) => r.id,
      link: (r) => (st ? st.ctx.href("contact", {}, r.id) : "#"),
      // The name opens the contact's own page (not the site panel).
      openRecord: (id) => st && st.ctx.go("contact", {}, { sub: id }),
    });
    bind();
    load();
    if (!st.announced) ctx.announce("Contacts");
  },
  update(ctx, change) {
    if (!st) return;
    st.ctx = ctx;
    if (change && change.kind === "route") {
      draw("route");
      return;
    }
    schedule(change && change.kind === "store" ? "store" : "all");
  },
  unmount() {
    if (!st) return;
    const caf = typeof cancelAnimationFrame === "function" ? cancelAnimationFrame : clearTimeout;
    if (st.frame) caf(st.frame);
    clearTimeout(st.sayTimer);
    for (const off of st.offs) {
      try { off(); } catch (e) { /* already gone */ }
    }
    try { if (st.list) st.list.destroy(); } catch (e) { /* already gone */ }
    try { if (st.bar) st.bar.destroy(); } catch (e) { /* already gone */ }
    st = null;
  },
};
