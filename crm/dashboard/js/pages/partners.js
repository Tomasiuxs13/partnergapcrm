// Partners (Tomas, 2026-10-23): every site that works, or worked, with one of our clients. Page module
// contract (spec 5.4). Reached from the sidebar's Records group and the More sheet.
//
// Header: h1 "Partners", one line about the open tab, Export CSV. Three tabs (links, counts follow the
// filters): All · Working now · Past program partners. Then the filter bar (Search, Client, Owner, Type,
// DR) and one list: Site, Partner of (one tag per client with how the site works with it; a tag with a
// deal opens the deal's page), Type, DR, Owner, Last activity. A row opens the site's record.
// What counts as a partner is rules/partners.js: a Signed or Live deal (or an Active site without deals),
// or a past program partner from the master partner list. GET /api/deals is shared with the client pages
// (features/deals-data.js); until it answers the sites' own stages are used.
// URL: tab (now | program; none = All), q, client, owner, type, drb, and the list's sort and page.
import { html, render, on } from "../core/dom.js";
import { num, plural } from "../core/format.js";
import { partnerRows, KIND_TEXT } from "../rules/partners.js";
import { loadDeals } from "../features/deals-data.js";
import { createList, toCsv, csvColumnsOf, downloadText, csvFileName } from "../ui/list.js";
import { createFilterBar, applyFilters } from "../ui/filters.js";
import { COLUMNS, resolveColumn } from "../ui/columns.js";
import { emptyState, EMPTY } from "../ui/empty.js";
import { ownerChip } from "../ui/pills.js";
import { skeletonRows } from "../ui/skeleton.js";
import * as bus from "../core/bus.js";

const FIELDS = ["q", "client", "owner", "type", "drb"];
const TABS = [
  { id: "all", label: "All", desc: "Sites that work with one of our clients now, or were in a client's affiliate program." },
  { id: "now", label: "Working now", desc: "Sites with a signed or live deal." },
  { id: "program", label: "Past program partners", desc: "Sites from the master partner list that were active in a client's affiliate program." },
];
const CSV_COLS = ["site", "owner", "type", "dr", "traffic", "country", "last_activity"];

const has = (v) => v != null && String(v).trim() !== "";
const title = () => "Partners";
const partnersText = (n) => num(n) + " " + plural(n, "partner");
const tabOf = (t) => (TABS.some((x) => x.id === t) ? t : "all");

let st = null; // the mounted page's state

function fresh(root, ctx) {
  // deals: undefined until GET /api/deals answers, null before migration 006 (or when it fails).
  return { root, ctx, offs: [], list: null, bar: null, view: null, byId: new Map(), deals: undefined, frame: 0, announced: false, sayTimer: 0 };
}

// ---------- data ----------

function params(ctx) {
  return (ctx && ctx.route && ctx.route.params) || {};
}

function me(ctx) {
  try { return ctx.me.get() || null; } catch (e) { return null; }
}

function loaded(ctx) {
  const s = ctx.store.status || {};
  return ctx.store.size() > 0 || !s.loading;
}

function filterParams(p) {
  const out = {};
  for (const k of FIELDS) if (has(p[k])) out[k] = String(p[k]);
  return out;
}

const filtered = (p) => FIELDS.some((k) => has(p[k]));

// {rows, counts}: the rows of the open tab and how many each tab holds with these filters. The client
// filter keeps the sites linked to that client (a deal for it counts even when the site's own client tags
// don't name it), so it is applied by partnerRows, not by applyFilters.
function compute(ctx) {
  const p = params(ctx);
  const f = filterParams(p);
  const client = f.client || "";
  delete f.client;
  const base = applyFilters(ctx.store.all(), f, { meta: ctx.meta, me: me(ctx) });
  const all = partnerRows(base, st.deals, { meta: ctx.meta, client });
  const counts = { all: all.length, now: 0, program: 0 };
  for (const x of all) counts[x.kind === "partner" ? "now" : "program"] += 1;
  const tab = tabOf(p.tab);
  const rows = tab === "all" ? all : all.filter((x) => (tab === "now" ? x.kind === "partner" : x.kind === "program"));
  return { rows, counts, tab };
}

// ---------- columns ----------

function linkText(l) {
  if (l.kind === "partner") return l.live ? "Live" : l.dealId ? "Signed" : "Partner";
  return l.kind === "program" ? "Past program" : KIND_TEXT[l.kind] || "";
}

function linksCell(r) {
  const item = st && st.byId.get(String(r.id));
  if (!item) return html``;
  return html`<span class="pt-links">${item.links.map((l) => {
    const inner = html`<span class="pt-link-name">${l.name}</span> <span class="pt-link-kind">${linkText(l)}</span>`;
    const cls = "ui-tag pt-link is-" + l.kind;
    return l.dealId
      ? html`<a class="${cls}" href="${st.ctx.href("deal", {}, l.dealId)}" title="${"Open the " + l.name + " deal"}">${inner}</a>`
      : html`<span class="${cls}">${inner}</span>`;
  })}</span>`;
}

const linksCsv = (r) => {
  const item = st && st.byId.get(String(r.id));
  return item ? item.links.map((l) => l.name + " (" + linkText(l) + ")").join(", ") : "";
};

const LINKS = { id: "partner_of", label: "Partner of", priority: 1, className: "pt-c-links", cell: linksCell, sort: (r) => (st && st.byId.has(String(r.id)) ? st.byId.get(String(r.id)).links[0].name.toLowerCase() : null), csv: linksCsv };
// Type and Owner read only here: the site's record edits them.
const TYPE = Object.assign({}, COLUMNS.type, { cell: (r, cx) => COLUMNS.type.cell(r, Object.assign({}, cx, { readOnly: true })) });
const OWNER = Object.assign({}, COLUMNS.owner, { cell: (r) => ownerChip(r, { edit: false }) });
const COLS = ["site", LINKS, TYPE, "dr", OWNER, "last_activity"];

// ---------- drawing ----------

function tabsHtml(ctx, p) {
  return html`<nav class="si-tabs" aria-label="Partner lists"><ul class="si-tablist">${TABS.map((t) => html`<li><a class="si-tab" data-pt-tab="${t.id}" href="${tabHref(ctx, t.id, p)}"><span class="si-tab-label">${t.label}</span><span class="si-tab-n" data-pt-n></span></a></li>`)}</ul></nav>`;
}

function tabHref(ctx, id, p) {
  return ctx.href("partners", Object.assign(id === "all" ? {} : { tab: id }, filterParams(p)));
}

function drawTabs(ctx, p, v) {
  const tab = tabOf(p.tab);
  for (const a of st.root.querySelectorAll("[data-pt-tab]")) {
    const id = a.getAttribute("data-pt-tab");
    a.setAttribute("href", tabHref(ctx, id, p));
    if (id === tab) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
    const n = a.querySelector("[data-pt-n]");
    const text = v && loaded(ctx) ? num(v.counts[id] || 0) : "";
    if (n && n.textContent !== text) n.textContent = text;
  }
  const sub = st.root.querySelector("[data-pt-sub]");
  const desc = TABS.find((t) => t.id === tab).desc;
  if (sub && sub.textContent !== desc) sub.textContent = desc;
}

function emptyHtml(ctx) {
  if (filtered(params(ctx))) return emptyState({ title: "No partners match.", body: EMPTY.filtered.body, action: { label: "Clear filters", act: "clear" } });
  return emptyState({ title: "No partners here yet.", body: "Sites show here once a deal is signed, or when the partner list says they were in a client's program." });
}

function say(text, { now = false } = {}) {
  clearTimeout(st.sayTimer);
  if (now) return st.ctx.announce(text);
  st.sayTimer = setTimeout(() => { if (st) st.ctx.announce(text); }, 700);
}

function draw(what = "all") {
  if (!st) return;
  st.frame = 0;
  const ctx = st.ctx;
  const p = params(ctx);
  if (st.bar && what !== "store") st.bar.update(filterParams(p));
  const body = st.root.querySelector("[data-pt-body]");
  const skel = st.root.querySelector("[data-pt-loading]");
  const emptyEl = st.root.querySelector("[data-pt-empty]");
  if (!loaded(ctx)) {
    st.view = { rows: [], counts: {}, tab: tabOf(p.tab) };
    skel.hidden = false;
    body.setAttribute("aria-busy", "true");
    drawTabs(ctx, p, null);
    return;
  }
  skel.hidden = true;
  body.removeAttribute("aria-busy");
  st.view = compute(ctx);
  st.byId = new Map(st.view.rows.map((x) => [String(x.r.id), x]));
  drawTabs(ctx, p, st.view);
  const none = !st.view.rows.length;
  emptyEl.hidden = !none;
  render(emptyEl, none ? emptyHtml(ctx) : html``);
  st.root.querySelector("[data-pt-list]").hidden = none;
  const csv = st.root.querySelector("[data-pt-csv]");
  if (csv) csv.disabled = none;
  if (st.list) st.list.refresh();
  const n = st.view.rows.length;
  const text = n ? partnersText(n) : filtered(p) ? "No partners match" : "No partners yet";
  if (!st.announced) {
    st.announced = true;
    say("Partners, " + text.charAt(0).toLowerCase() + text.slice(1), { now: true });
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

function getDeals(force) {
  const mine = st;
  loadDeals({ force }).then((list) => {
    if (st !== mine) return;
    st.deals = list;
    schedule("store");
  });
}

function exportCsv() {
  if (!st.view || !st.view.rows.length) return;
  const rows = st.list ? st.list.rows() : st.view.rows.map((x) => x.r);
  const cols = csvColumnsOf(["site", LINKS].map(resolveColumn).concat(CSV_COLS.slice(1).map(resolveColumn)).filter(Boolean), { today: st.ctx.today });
  downloadText(csvFileName("partners", st.ctx.today), toCsv(rows, cols), st.root);
}

function bind() {
  const root = st.root;
  st.offs.push(on(root, "click", "[data-pt-csv]", () => exportCsv()));
  st.offs.push(on(root, "click", "[data-empty-act]", (e, b) => {
    if (b.getAttribute("data-empty-act") !== "clear") return;
    const patch = { page: null };
    for (const k of FIELDS) patch[k] = null;
    st.ctx.setParams(patch);
  }));
  const onDeals = () => st && getDeals(true);
  bus.on("deals:changed", onDeals);
  st.offs.push(() => bus.off("deals:changed", onDeals));
}

export default {
  id: "partners",
  title,
  mount(root, ctx) {
    if (st) this.unmount();
    st = fresh(root, ctx);
    const p = params(ctx);
    render(root, html`<div class="pt-page"><header class="si-head"><div class="si-head-text"><h1 tabindex="-1">Partners</h1><p class="si-sub" data-pt-sub></p></div><button type="button" class="ui-btn is-sm is-ghost pt-csv" data-pt-csv data-download><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v11M7 10l5 5 5-5M5 20h14"/></svg>Export CSV</button></header>${tabsHtml(ctx, p)}<div class="pt-filters" data-pt-filters></div><div class="pt-body" data-pt-body><div data-pt-loading hidden>${skeletonRows(6)}</div><div class="pt-list" data-pt-list></div><div data-pt-empty hidden></div></div></div>`);
    st.bar = createFilterBar(root.querySelector("[data-pt-filters]"), {
      fields: FIELDS,
      params: filterParams(p),
      onChange: (patch, opts) => st && st.ctx.setParams(Object.assign({ page: null }, patch), { replace: !!(opts && opts.replace) }),
      records: () => (st ? st.ctx.store.all() : []),
      label: "Filters",
    });
    st.list = createList(root.querySelector("[data-pt-list]"), {
      id: "partners",
      rows: () => (st && st.view ? st.view.rows.map((x) => x.r) : []),
      columns: COLS,
      sort: { key: "dr", dir: "desc" },
      csv: false, // one Export CSV in the header
      noun: ["partner", "partners"],
      label: "Partners",
      empty: () => html``,
      loading: () => !(st && loaded(st.ctx)),
      queueLabel: "Partners",
      openRecord: (id, o) => st.ctx.openRecord(id, o || {}),
    });
    bind();
    draw("all");
    getDeals(false);
    if (!st.announced) ctx.announce("Partners");
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
