// Edit history (spec 2.2.6, 4.7, 4.10, 4.11). Page module contract (spec 5.4). Owner F8.
//
// Every change made on this site, newest first, and whether the morning copy took it to the Google Sheet:
//   When (local time) · Who · What ("Stage: Replied → Negotiating", "Added site", "Added contact Rob Tester",
//   "Logged Email", "Changed Soro program") · Site (opens it) · Sheet: Waiting / Copied to the sheet /
//   Not copied – a sheet edit won; check the sheet.
// The list is server-paged (createList({fetchPage}), 100 per page, "Load more"): GET /api/edits with
// before/limit and the filters. The API pages by edit number (next_before), so the page keeps the cursor of
// each loaded page. Filters live in the URL (spec 2.4): state=waiting|copied|not_copied (four buttons),
// by=<name> (Person menu) and account=<site id> (set by the record panel's ⋯ › See all changes; shown as a
// chip). The header count is the waiting edits: /api/meta freshness.pending (never /api/edits' bare
// `pending`, which also counts the "not copied" ones), or /api/edits?state=waiting before migration 003.
// Read-only page: it writes nothing. A missing endpoint shows "Not available yet"; the snapshot says
// "Open the live site to see this".
import { html, render, on } from "../core/dom.js";
import { num, plural, date as fmtDate, toDay, daysBetween } from "../core/format.js";
import * as metaMod from "../core/meta.js";
import * as bus from "../core/bus.js";
import { createList } from "../ui/list.js";
import { openMenu } from "../ui/menu.js";
import { emptyState, EMPTY } from "../ui/empty.js";
import { avatar } from "../ui/pills.js";
import { changeText } from "../features/record/timeline.js";

const PER = 100;
const STATES = [
  { id: "", label: "All" },
  { id: "waiting", label: "Waiting" },
  { id: "copied", label: "Copied" },
  { id: "not_copied", label: "Not copied" },
];
const STATE_TEXT = {
  waiting: "Waiting",
  copied: "Copied to the sheet",
  not_copied: "Not copied – a sheet edit won; check the sheet",
};
const SHEET_SHOWS = "Changes made directly in the Google Sheet show here the next weekday morning.";
const SNAPSHOT_TEXT = "Open the live site to see this.";

const has = (v) => v != null && String(v).trim() !== "";
const title = () => "Edit history";
const clip = (s, n) => {
  const t = String(s == null ? "" : s).replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n - 1).trimEnd() + "…" : t;
};
const parseJson = (s) => {
  if (s && typeof s === "object") return s;
  try { return JSON.parse(String(s || "")); } catch (e) { return null; }
};
const isSnapshot = () => typeof window !== "undefined" && !!window.__SNAPSHOT__;

let st = null; // the mounted page's state

// ---------- params ----------

function params(ctx) {
  const p = (ctx && ctx.route && ctx.route.params) || {};
  const out = {};
  if (has(p.by)) out.by = String(p.by).trim().slice(0, 40);
  if (STATE_TEXT[p.state]) out.state = p.state;
  if (has(p.account)) out.account = String(p.account).trim().slice(0, 40);
  return out;
}

const filtered = (p) => !!(p.by || p.state || p.account);
const sameParams = (a, b) => (a.by || "") === (b.by || "") && (a.state || "") === (b.state || "") && (a.account || "") === (b.account || "");

// ---------- the waiting count ----------

function runTime(ctx) {
  return metaMod.runTime(ctx.meta);
}

// "12 changes copy to the Google Sheet on the next weekday morning (08:47)." (Appendix C)
export function waitingSentence(n, hhmm = "08:47") {
  if (n == null) return "Changes copy to the Google Sheet on the next weekday morning (" + hhmm + ").";
  if (n === 0) return "Nothing is waiting for the Google Sheet.";
  return num(n) + " " + plural(n, "change") + " " + (n === 1 ? "copies" : "copy") +
    " to the Google Sheet on the next weekday morning (" + hhmm + ").";
}

function pendingFromMeta(m) {
  const f = m && m.freshness;
  return f && typeof f === "object" && f.pending != null && isFinite(Number(f.pending)) ? Number(f.pending) : null;
}

// Re-reads the waiting count (and the "not copied" count for the note) from the server.
async function readCounts() {
  if (!st || isSnapshot()) return;
  const my = st;
  const api = my.ctx.api;
  let n = null;
  try {
    n = pendingFromMeta(await api.meta());
  } catch (e) { n = null; }
  if (n == null) {
    // Before migration 003 there is no freshness: count the waiting edits themselves.
    try {
      const r = await api.edits({ state: "waiting", limit: 200 });
      if (r && Array.isArray(r.recent)) n = r.recent.length + (r.next_before != null ? 1 : 0);
    } catch (e) { n = null; }
  }
  let conflicts = null;
  try {
    const r = await api.edits({ state: "not_copied", limit: 200 });
    if (r && Array.isArray(r.recent)) conflicts = r.recent.length;
  } catch (e) { conflicts = null; }
  if (st !== my) return;
  if (n != null) {
    my.pending = n;
    try { my.ctx.store.setPending(n); } catch (e) { /* the footer keeps its count */ }
  }
  my.conflicts = conflicts;
  drawHead();
}

// ---------- rows ----------

function personFrom(obj) {
  if (!obj) return "";
  return [obj.first_name, obj.last_name].filter((x) => has(x)).join(" ").trim();
}

// What the edit did, in words: {text, sub}. sub is a second, quieter line (an activity's summary).
export function whatOf(e, { meta } = {}) {
  const j = parseJson(e.new);
  switch (e.kind) {
    case "update":
      return { text: changeText(e), sub: "" };
    case "create_account":
      return { text: "Added site", sub: "" };
    case "create_contact": {
      const who = personFrom(j);
      return { text: who ? "Added contact " + who : "Added a contact", sub: "" };
    }
    case "activity": {
      const type = (j && j.type) || "Note";
      return { text: "Logged " + type, sub: j && has(j.summary) ? clip(j.summary, 140) : "" };
    }
    case "client_program": {
      const c = metaMod.client(meta, e.field);
      return { text: "Changed " + (c ? c.name : String(e.field || "a client")) + " program", sub: "" };
    }
    case "create_deal":
      return { text: "Added " + ((j && j.client) || "a") + " deal", sub: j && has(j.stage) ? (j.stage === "Active" ? "Signed" : j.stage) : "" };
    case "deal_update": {
      const f = String(e.field || "");
      const dot = f.lastIndexOf(".");
      const col = dot > 0 ? f.slice(dot + 1) : f;
      const st = (v) => (col === "stage" && v === "Active" ? "Signed" : v);
      return { text: "Deal " + (dot > 0 ? f.slice(0, dot) + " · " : "") + changeText({ field: col, old: st(e.old), new: st(e.new) }), sub: "" };
    }
    case "create_file":
      return { text: "Added file " + ((j && j.label) || ""), sub: j && has(j.kind) ? j.kind : "" };
    default:
      return { text: String(e.kind || "Change"), sub: "" };
  }
}

function toRow(e, ctx) {
  const what = whatOf(e, { meta: ctx.meta });
  const acc = has(e.account_id) ? String(e.account_id) : "";
  const site = acc ? ctx.store.get(acc) : null;
  let label = site ? site.label || site.domain || acc : "";
  if (!label && e.kind === "create_account") {
    const j = parseJson(e.new);
    label = (j && (j.name || j.domain)) || "";
  }
  return {
    id: "e" + e.n,
    n: e.n,
    at: e.at || "",
    by: e.by_whom || "",
    kind: e.kind,
    what: what.text,
    sub: what.sub,
    account: acc,
    siteLabel: label || acc,
    inStore: !!site,
    clientK: e.kind === "client_program" ? String(e.field || "") : "",
    state: STATE_TEXT[e.state] ? e.state : "waiting",
  };
}

// "Today 08:10", "Yesterday 16:00", "Thu 22 Oct 14:00", "22 Oct 2025 14:00" (local time, Appendix C).
export function whenText(at, today) {
  const day = toDay(at);
  if (!day) return "";
  const t = fmtDate(at, "time");
  const d = daysBetween(day, today);
  if (d === 0) return "Today " + t;
  if (d === 1) return "Yesterday " + t;
  if (today && day.slice(0, 4) !== String(today).slice(0, 4)) return (fmtDate(at, "year") + " " + t).trim();
  return fmtDate(at, "datetime");
}

// ---------- columns ----------

function siteHref(r) {
  if (!st || !r.account || !r.inStore) return "";
  const cur = st.ctx.route;
  return st.ctx.href(cur.page || "history", Object.assign({}, cur.params, { rec: r.account }), cur.sub || "");
}

function clientCell(k) {
  const c = metaMod.client(st ? st.ctx.meta : null, k);
  const name = c ? c.name : k;
  return c && st
    ? html`<a class="hi-site" href="${st.ctx.href("clients", {}, c.slug)}">${name}</a><span class="hi-id">Client program</span>`
    : html`<span class="hi-site">${name}</span>`;
}

const WHEN = {
  id: "when", label: "When", priority: 2, className: "hi-c-when",
  cell: (r, cx) => html`<time class="hi-when" datetime="${r.at}" title="${(fmtDate(r.at, "year") + " " + fmtDate(r.at, "time")).trim()}">${whenText(r.at, (cx && cx.today) || (st && st.ctx.today))}</time>`,
  csv: (r) => r.at,
};
const WHO = {
  id: "who", label: "Who", priority: 1, className: "hi-c-who",
  cell: (r) => (r.by ? html`<span class="hi-who">${avatar(r.by, { size: "xs" })}<span>${r.by}</span></span>` : html`<span class="ui-faint">—</span>`),
  csv: (r) => r.by,
};
const WHAT = {
  id: "what", label: "What", priority: 1, className: "hi-c-what",
  cell: (r) => html`<span class="hi-what">${r.what}</span>${r.sub ? html`<span class="hi-what-sub">${r.sub}</span>` : ""}`,
  csv: (r) => (r.sub ? r.what + ": " + r.sub : r.what),
};
const SITE = {
  id: "site", label: "Site", priority: 1, className: "hi-c-site",
  sort: null, // the catalog's site column sorts; this list is in edit order (server-paged)
  cell: (r) => {
    if (r.clientK) return clientCell(r.clientK);
    if (!r.account) return html`<span class="ui-faint">—</span>`;
    const href = siteHref(r);
    const name = href
      ? html`<a class="ui-row-link hi-site" href="${href}" data-open="${r.account}">${r.siteLabel}</a>`
      : html`<span class="hi-site" title="Not in the site list now (it may have been renamed after the morning copy)">${r.siteLabel}</span>`;
    return html`${name}${r.siteLabel !== r.account ? html`<span class="hi-id">${r.account}</span>` : ""}`;
  },
  csv: [
    { label: "Site ID", value: (r) => r.account || "" },
    { label: "Site", value: (r) => (r.clientK ? (metaMod.client(st && st.ctx.meta, r.clientK) || { name: r.clientK }).name : r.siteLabel) },
  ],
};
const SHEET = {
  id: "sheet", label: "Sheet", priority: 1, className: "hi-c-sheet",
  cell: (r) => {
    if (r.state === "not_copied") {
      const url = st && st.ctx.meta.sheet_url;
      return html`<span class="hi-state is-not_copied">Not copied – a sheet edit won; ${url
        ? html`<a href="${url}" target="_blank" rel="noopener">check the sheet<span class="sr-only"> (opens the Google Sheet in a new tab)</span></a>`
        : "check the sheet"}</span>`;
    }
    if (r.state === "copied") return html`<span class="hi-state is-copied">Copied to the sheet</span>`;
    return html`<span class="hi-state is-waiting" title="${"Copies to the Google Sheet on the next weekday morning (" + (st ? runTime(st.ctx) : "08:47") + ")"}">Waiting</span>`;
  },
  csv: (r) => STATE_TEXT[r.state],
};
const COLS = [WHEN, WHO, WHAT, SITE, SHEET];

// ---------- the list ----------

// One page of edits. The API pages by edit number: page n+1 starts below page n's last edit.
async function fetchPage({ page, per, params: p }) {
  if (!st) return { rows: [], total: 0 };
  const my = st;
  if (page === 1) my.cursors = new Map();
  const before = page > 1 ? my.cursors.get(page) : undefined;
  if (page > 1 && before == null) return { rows: [], total: (page - 1) * per };
  const r = await my.ctx.api.edits({ before, limit: per, by: p.by, state: p.state, account: p.account });
  if (r == null || !Array.isArray(r.recent)) return null;
  const rows = r.recent.map((e) => toRow(e, my.ctx));
  const more = r.next_before != null;
  if (more) my.cursors.set(page + 1, r.next_before);
  const loaded = (page - 1) * per + rows.length;
  my.loaded = loaded;
  my.more = more;
  my.fetchedOnce = true;
  setTimeout(afterFetch, 0);
  return { rows, total: typeof r.total === "number" ? r.total : more ? loaded + 1 : loaded };
}

function countText() {
  if (!st.fetchedOnce) return "";
  const n = st.loaded || 0;
  if (st.more) return "Showing the newest " + num(n) + " " + plural(n, "change");
  if (!n) return "";
  return num(n) + " " + plural(n, "change");
}

function afterFetch() {
  if (!st) return;
  const el = st.root.querySelector("[data-hi-count]");
  if (el) el.textContent = countText();
  const csv = st.root.querySelector("[data-hi-csv]");
  if (csv) csv.disabled = !(st.loaded > 0);
  const p = params(st.ctx);
  const n = st.loaded || 0;
  const said = n ? countText() : filtered(p) ? "No changes match" : "No edits yet";
  if (said !== st.said) {
    st.said = said;
    st.ctx.announce(st.announced ? said : "Edit history, " + said.charAt(0).toLowerCase() + said.slice(1));
    st.announced = true;
  }
}

function emptyFor() {
  if (!st) return EMPTY.history;
  if (filtered(params(st.ctx))) return { title: "No changes match.", body: "Try removing a filter.", action: { label: "Clear filters", act: "clear" } };
  return EMPTY.history;
}

function makeList() {
  const el = st.root.querySelector("[data-hi-list]");
  st.list = createList(el, {
    id: "edit-history",
    fetchPage,
    params: params(st.ctx),
    columns: COLS,
    pageSize: PER,
    csv: false, // the header has the Export CSV button
    csvName: "edit-history",
    noun: ["change", "changes"],
    label: "Edit history, newest first",
    empty: () => emptyState(emptyFor()),
    recOf: (r) => (r.inStore ? r.account : null),
    link: (r) => siteHref(r),
    openRecord: (id) => st && st.ctx.openRecord(id),
  });
}

// ---------- header and filter bar ----------

function headHtml() {
  const ctx = st.ctx;
  const n = st.pending;
  const conflicts = st.conflicts || 0;
  const p = params(ctx);
  return html`<p class="hi-sub"><span data-hi-waiting>${waitingSentence(n, runTime(ctx))}</span> ${SHEET_SHOWS}</p>${conflicts && p.state !== "not_copied"
    ? html`<p class="hi-note"><span>${num(conflicts)} ${plural(conflicts, "change")} ${conflicts === 1 ? "wasn't" : "weren't"} copied: someone changed the same cell in the Google Sheet later.</span> <button type="button" class="ui-linkbtn" data-hi-state="not_copied">Show ${conflicts === 1 ? "it" : "them"}</button></p>`
    : ""}`;
}

function drawHead() {
  if (!st) return;
  const el = st.root.querySelector("[data-hi-head]");
  if (el) render(el, headHtml());
}

const caret = html`<svg class="ui-caret" viewBox="0 0 24 24" aria-hidden="true"><path d="M7 10l5 5 5-5"/></svg>`;
const xIcon = html`<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>`;

function siteChipLabel(ctx, id) {
  const r = ctx.store.get(id);
  return r ? (r.label || r.domain || id) : id;
}

function barHtml() {
  const ctx = st.ctx;
  const p = params(ctx);
  const cur = p.state || "";
  const chips = [];
  if (p.by) chips.push({ field: "by", label: "Person: " + p.by });
  if (p.account) chips.push({ field: "account", label: "Site: " + siteChipLabel(ctx, p.account) });
  return html`<div class="hi-frow"><div class="hi-states" role="group" aria-label="Sheet">${STATES.map((s) => html`<button type="button" class="ui-chipbtn hi-state-btn" data-hi-state="${s.id}" aria-pressed="${cur === s.id ? "true" : "false"}">${s.label}</button>`)}</div><button type="button" class="ui-fbtn${p.by ? " is-set" : ""}" data-hi-person aria-haspopup="menu">Person${p.by ? html`<span class="sr-only">: ${p.by}</span>` : ""}${caret}</button></div>${chips.length
    ? html`<div class="ui-chiprow hi-chips"><span class="sr-only">Active filters:</span>${chips.map((c) => html`<span class="ui-fchip">${c.label}<button type="button" class="ui-fchip-x" data-hi-remove="${c.field}" aria-label="${"Remove filter " + c.label}">${xIcon}</button></span>`)}<button type="button" class="ui-linkbtn" data-hi-clear>Clear all</button></div>`
    : ""}`;
}

function drawBar() {
  if (!st) return;
  const el = st.root.querySelector("[data-hi-bar]");
  if (!el) return;
  const a = document.activeElement;
  let keep = null;
  if (a && el.contains(a)) {
    if (a.hasAttribute("data-hi-state")) keep = '[data-hi-state="' + a.getAttribute("data-hi-state") + '"]';
    else if (a.hasAttribute("data-hi-person")) keep = "[data-hi-person]";
  }
  render(el, barHtml());
  if (keep) {
    const again = el.querySelector(keep);
    if (again) again.focus({ preventScroll: true });
  }
}

// People for the Person menu: me first, then the team (A to Z), then past team members.
function personItems(ctx) {
  const mine = ctx.me.get();
  const team = (ctx.meta.team || []).filter((m) => m && m.name);
  const byName = (a, b) => a.localeCompare(b);
  const active = team.filter((m) => m.active !== false).map((m) => m.name).sort(byName);
  const past = team.filter((m) => m.active === false).map((m) => m.name).sort(byName);
  const cur = params(ctx).by || "";
  const items = [];
  const seen = new Set();
  const add = (name, extra = {}) => {
    if (!name || seen.has(name.toLowerCase())) return;
    seen.add(name.toLowerCase());
    items.push(Object.assign({ label: name, value: name, checked: cur.toLowerCase() === name.toLowerCase() }, extra));
  };
  if (mine) add(mine, { hint: "you" });
  for (const n of active) add(n);
  for (const n of past) add(n, { desc: "past team member" });
  if (cur) add(cur);
  if (cur) items.push({ divider: true }, { label: "Anyone", value: "\u0000any" });
  return items;
}

async function pickPerson(btn) {
  const items = personItems(st.ctx);
  const v = await openMenu(btn, { items, label: "Person", search: items.length > 8 });
  if (v == null || !st) return;
  st.ctx.setParams({ by: v === "\u0000any" ? null : v });
}

function clearFilters() {
  st.ctx.setParams({ by: null, state: null, account: null });
}

function bind() {
  const root = st.root;
  st.offs.push(on(root, "click", "[data-hi-state]", (e, b) => st.ctx.setParams({ state: b.getAttribute("data-hi-state") || null })));
  st.offs.push(on(root, "click", "[data-hi-person]", (e, b) => pickPerson(b)));
  st.offs.push(on(root, "click", "[data-hi-remove]", (e, b) => st.ctx.setParams({ [b.getAttribute("data-hi-remove")]: null })));
  st.offs.push(on(root, "click", "[data-hi-clear]", () => clearFilters()));
  st.offs.push(on(root, "click", "[data-empty-act]", (e, b) => {
    if (b.getAttribute("data-empty-act") === "clear") clearFilters();
  }));
  st.offs.push(on(root, "click", "[data-hi-csv]", () => {
    if (st.list && st.loaded > 0) st.list.exportCsv();
  }));
  // The footer's count changes after a save (the shell re-reads freshness.pending): keep the header in step.
  st.offs.push(bus.on("store:status", () => {
    if (!st) return;
    const n = st.ctx.store.status ? st.ctx.store.status.pending : null;
    if (n != null && n !== st.pending) {
      st.pending = n;
      drawHead();
    }
  }));
}

// A short signature of rows as drawn: an edit's number, state and site (label and link).
const sigOf = (list) => list.map((r) => r.n + ":" + r.state + ":" + r.siteLabel + ":" + (r.inStore ? 1 : 0)).join("|");

// After a save (a new edits row), a refresh or a meta re-read: re-read the first page and redraw the
// list only when it changed (the list's own refresh re-fetches every loaded page and shows skeleton rows
// meanwhile, so it isn't called for nothing).
async function quietRefresh() {
  if (!st || !st.list || !st.fetchedOnce || isSnapshot()) return;
  const my = st;
  readCounts();
  const p = params(my.ctx);
  let r;
  try {
    r = await my.ctx.api.edits({ limit: PER, by: p.by, state: p.state, account: p.account });
  } catch (e) { return; }
  if (st !== my || !my.list || !r || !Array.isArray(r.recent) || !sameParams(p, params(my.ctx))) return;
  const fresh = sigOf(r.recent.map((e) => toRow(e, my.ctx)));
  const shown = sigOf(my.list.rows().slice(0, PER));
  if (fresh !== shown) my.list.refresh();
}

function scheduleRefresh(ms) {
  if (!st) return;
  clearTimeout(st.refreshTimer);
  st.refreshTimer = setTimeout(quietRefresh, ms);
}

export default {
  id: "history",
  title,
  mount(root, ctx) {
    if (st) this.unmount();
    st = {
      root, ctx, offs: [], list: null, cursors: new Map(), loaded: 0, more: false, fetchedOnce: false,
      pending: pendingFromMeta(ctx.meta), conflicts: null, said: "", announced: false, refreshTimer: 0,
      shown: params(ctx),
    };
    if (st.pending == null && ctx.store.status && ctx.store.status.pending != null) st.pending = ctx.store.status.pending;
    render(root, html`<div class="hi-page"><header class="hi-head"><h1 tabindex="-1">Edit history</h1><div data-hi-head></div></header>
<div class="hi-bar"><div class="hi-filters" data-hi-bar></div><div class="hi-tools"><p class="hi-count" data-hi-count></p><button type="button" class="ui-btn is-sm is-ghost" data-hi-csv disabled><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v11M7 10l5 5 5-5M5 20h14"/></svg>Export CSV</button></div></div>
<div class="hi-list" data-hi-list></div></div>`);
    drawHead();
    drawBar();
    bind();
    if (isSnapshot()) {
      render(root.querySelector("[data-hi-list]"), emptyState({ title: SNAPSHOT_TEXT }));
      root.querySelector(".hi-bar").hidden = true;
      return;
    }
    makeList();
    readCounts();
  },
  update(ctx, change) {
    if (!st) return;
    st.ctx = ctx;
    const kind = change && change.kind;
    if (kind === "route") {
      const p = params(ctx);
      drawBar();
      drawHead();
      if (!sameParams(p, st.shown)) {
        st.shown = p;
        st.said = "";
        if (st.list) st.list.refresh({ params: p });
      }
      return;
    }
    if (kind === "meta") {
      // Refresh, or the page coming back into view: the morning copy may have copied some edits.
      const n = pendingFromMeta(ctx.meta);
      if (n != null) st.pending = n;
      drawHead();
      drawBar();
      scheduleRefresh(300);
      return;
    }
    if (kind === "store") {
      // A save made from this page (the record panel) writes edits rows; a refresh may bring renamed ids.
      const r = change.reason;
      if (r === "edit" || r === "bulk") scheduleRefresh(1200);
      else if (r === "refresh" || r === "load") scheduleRefresh(300);
      drawBar();
    }
  },
  unmount() {
    if (!st) return;
    clearTimeout(st.refreshTimer);
    for (const off of st.offs) {
      try { off(); } catch (e) { /* already gone */ }
    }
    try { if (st.list) st.list.destroy(); } catch (e) { /* already gone */ }
    st = null;
  },
};
