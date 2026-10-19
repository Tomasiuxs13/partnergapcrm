// Sites (spec 2.2.2, Appendix B.4, 4.7, 4.8). Page module contract (spec 5.4). Owner F3.
//
// Header: h1 "Sites" and one line about the open tab. Four tabs (links, counts follow the filters):
// Mine to contact · Unowned · Waiting for reply · All. Then the filter bar (ui/filters.js; on phone a
// Filters sheet), one row of tab tools (Waiting: "No reply in 14+ days (N)" and Start; All: the quick
// presets) with the Sort menu, and the list (ui/list.js) with the bulk bar (ui/bulk.js).
//
// URL (spec 2.4): tab (mine | unowned | waiting | all; none = All), the filter params of ui/filters.js,
// quiet=14 (Waiting only), preset=activity | replied_nodate (All only; "Has a suggestion" is sugg=1),
// sort + dir (only when they differ from the default sort), page (when > 1).
// - Waiting for reply shows my sites when the URL has no owner; owner=all shows everyone's.
// - Mine to contact and Unowned define the owner themselves; Stage and the presets are on All only;
//   "Show big sites" is on every tab but Waiting (B.4). Filters a tab doesn't offer stay in the URL but
//   don't apply there, so they come back with the tab.
// - A tab link keeps the filters and drops quiet, preset, sort and page.
// Rows: Unowned new sites get [Claim] and [Assign to <client manager>]; other rows [Log what happened ▾]
// [Follow up ▾]. Every write goes through ui/actions.js (bulk through ui/bulk.js). The page redraws in
// place on store, meta and route changes; it never remounts.
import { html, raw, render, on } from "../core/dom.js";
import { num, plural } from "../core/format.js";
import { clientManager, firstClientName } from "../core/outcomes.js";
import { TABS, tabOf, tabInfo, siteView, sortFor, baseSort, defaultDir, SORT_CHOICES } from "../rules/sites.js";
import { createList } from "../ui/list.js";
import { createFilterBar, applyFilters } from "../ui/filters.js";
import { CSV_SITES, resolveColumn } from "../ui/columns.js";
import { rowActions } from "../ui/inline-edit.js";
import { EMPTY } from "../ui/empty.js";
import { createBulkBar } from "../ui/bulk.js";

const SHARED = ["q", "client", "type", "country", "drb", "source", "has_contact", "sugg"];
const FIELDS = {
  mine: ["q", "client", "type", "country", "drb", "source", "has_contact", "sugg", "big"],
  unowned: ["q", "client", "type", "country", "drb", "source", "has_contact", "sugg", "big"],
  waiting: ["q", "client", "owner", "type", "country", "drb", "source", "has_contact", "sugg"],
  all: ["q", "client", "owner", "stage", "type", "country", "drb", "source", "has_contact", "sugg", "big"],
};
// Params a tab link carries over.
const KEEP = ["q", "client", "owner", "stage", "type", "country", "drb", "source", "has_contact", "sugg", "big"];
const QUIET = "No reply in 14+ days";
const PRESET_CHIPS = [
  { id: "activity", label: "Recently active", title: "Sort by last activity, newest first" },
  { id: "replied_nodate", label: "Replied, no date", title: "Replied sites without a reply date" },
  { id: "sugg", label: "Has a suggestion", title: "Sites with a contact or email suggested by the morning run" },
];
const FOCUS_ATTRS = ["data-si-quiet", "data-si-start", "data-si-preset", "data-si-sort", "data-si-csv"];

const has = (v) => v != null && String(v).trim() !== "";
const title = () => "Sites";
const sites = (n) => num(n) + " " + plural(n, "site");

let st = null; // the mounted page's state

function fresh(root, ctx) {
  return {
    root, ctx,
    offs: [],
    frame: 0,
    pending: null,
    tab: null,
    list: null,
    bar: null,
    view: null,
    key: "",
    applied: null, // {key, dir, page} the list shows
    ranks: new Map(), // sort key -> Map(site id -> rank), until the store changes
    announced: false,
    sayTimer: 0,
  };
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

function quietOn(p) {
  return has(p.quiet) && p.quiet !== "0";
}

function sharedParams(p) {
  const out = {};
  for (const k of SHARED) if (has(p[k])) out[k] = p[k];
  return out;
}

function dataKey(ctx, p) {
  return JSON.stringify([tabOf(p.tab), me(ctx), SHARED.map((k) => p[k] || ""), p.owner || "", p.stage || "", p.big || "",
    p.quiet || "", p.preset || ""]);
}

// {rows, counts, quiet, tab}: one pass (rules/sites.js#siteView) over the records that pass the shared filters.
function compute(ctx) {
  const p = params(ctx);
  const mine = me(ctx);
  const base = applyFilters(ctx.store.all(), sharedParams(p), { meta: ctx.meta, me: mine });
  const v = siteView(base, {
    meta: ctx.meta, me: mine, today: ctx.today, tab: p.tab, owner: p.owner, stage: p.stage, big: p.big === "1",
    quiet: quietOn(p) ? p.quiet : "", preset: p.preset,
  });
  v.tab = tabOf(p.tab);
  return v;
}

// The params the filter bar shows: Waiting for reply shows its default owner as "Owner: Me".
function barParams(tab, p) {
  const out = Object.assign({}, p);
  const all = p.owner === "all" || p.owner === "any";
  if (tab === "waiting" && !has(p.owner)) out.owner = "me";
  else if (all) delete out.owner;
  if (p.preset === "sugg") out.sugg = "1";
  return out;
}

// Anything that narrows the tab (for the empty state and "Clear filters").
function filtered(tab, p) {
  if (SHARED.some((k) => has(p[k]))) return true;
  if (tab === "waiting") return quietOn(p) || (has(p.owner) && p.owner !== "me" && p.owner !== "all" && p.owner !== "any");
  if (tab === "all") return (has(p.owner) && p.owner !== "all" && p.owner !== "any") || has(p.stage) || has(p.preset);
  return false;
}

function keepParams(p) {
  const out = {};
  for (const k of KEEP) if (has(p[k])) out[k] = p[k];
  return out;
}

function tabHref(ctx, id, p) {
  return ctx.href("sites", Object.assign({ tab: id }, keepParams(p)));
}

// The sort and dir params for a sort, given the page's default (both null when they match it).
function sortParams(key, dir, base) {
  if (!key || (key === base.key && dir === base.dir)) return { sort: null, dir: null };
  return { sort: key, dir: dir === defaultDir(key) ? null : dir };
}

function sortLabel(key, dir) {
  const c = SORT_CHOICES.find((x) => x.key === key && x.dir === dir);
  if (c) return c.label;
  const col = resolveColumn(key);
  return (col ? col.label : key) + (dir === "desc" ? " (Z–A, highest first)" : " (A–Z, lowest first)");
}

// The params that decide the sort: quiet only counts on Waiting for reply, the presets only on All.
function effective(p) {
  const tab = tabOf(p.tab);
  return {
    sort: p.sort, dir: p.dir,
    quiet: tab === "waiting" && quietOn(p) ? p.quiet : "",
    preset: tab === "all" ? p.preset : "",
  };
}

// ---------- markup ----------

function claimCell(r, cx) {
  if (cx && cx.readOnly) return html``;
  if (has(r.owner) || !r.notContacted) return rowActions(r);
  const ctx = st ? st.ctx : null;
  const m = ctx ? clientManager(r, ctx.meta) : null;
  const name = r.label || r.domain || r.id;
  const client = m && ctx ? firstClientName(r, ctx.meta) : "";
  return html`<span class="si-claim"><button type="button" class="ui-btn is-sm" data-row-act="claim" data-id="${r.id}" aria-label="${"Claim " + name}" title="You become the owner, with a follow-up in 2 working days">Claim</button>${m ? html`<button type="button" class="ui-btn is-sm is-ghost" data-row-act="assign" data-id="${r.id}" aria-label="${"Assign " + name + " to " + m}" title="${m + " manages " + (client || "this client")}">Assign to ${m}</button>` : ""}</span>`;
}

// ---------- fast sort keys ----------
// ui/list.js compares text with localeCompare(…, {numeric, sensitivity}), about 20 times slower than an
// Intl.Collator: sorting 7,500 sites by name took 350 ms. The text and date columns here sort by numbers
// instead, in the same order: a date as YYYYMMDD, a text as its rank among every site (one Intl.Collator
// sort per column, kept until the store changes). See NEEDS.md (F3 1).
const COLLATOR = typeof Intl !== "undefined" && Intl.Collator ? new Intl.Collator("en", { numeric: true, sensitivity: "base" }) : null;
const TEXT_KEYS = {
  site: (r) => r.label,
  owner: (r) => r.owner,
  clients: (r) => (r.cl || []).join(", "),
};

function dayKey(v) {
  const s = v == null ? "" : String(v).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? Number(s.slice(0, 4) + s.slice(5, 7) + s.slice(8, 10)) : null;
}

function ranks(key) {
  let m = st.ranks.get(key);
  if (m) return m;
  const get = TEXT_KEYS[key];
  const list = [];
  for (const r of st.ctx.store.all()) {
    const v = get(r);
    if (has(v)) list.push([String(v).toLowerCase(), String(r.id)]);
  }
  const cmp = COLLATOR ? COLLATOR.compare : (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  list.sort((a, b) => cmp(a[0], b[0]));
  m = new Map();
  let rank = 0;
  let prev = null;
  for (const [v, id] of list) {
    if (prev === null || cmp(prev, v) !== 0) rank++;
    prev = v;
    m.set(id, rank);
  }
  st.ranks.set(key, m);
  return m;
}

const textSort = (key) => (r) => {
  if (!st) return null;
  const n = ranks(key).get(String(r.id));
  return n == null ? null : n;
};

const SORTED = {
  site: { id: "site", sort: textSort("site") },
  owner: { id: "owner", sort: textSort("owner") },
  clients: { id: "clients", sort: textSort("clients") },
  last_activity: { id: "last_activity", sort: (r) => dayKey(r.lastActivity) },
  next: { id: "next", sort: (r) => dayKey(r.due) },
};
const col = (id, extra) => Object.assign({ id }, SORTED[id] || {}, extra || {});

const ACTIONS_COL = { id: "actions", label: "Actions", labelHidden: true, priority: 1, className: "is-actions si-acts", cell: claimCell, csv: false };
// Columns per tab (spec 2.2.2), minus the one that says nothing there: Owner on Mine to contact and
// Unowned (every row has the same owner), Traffic on Waiting for reply (they're already emailed). The CSV
// always has the full set (CSV_SITES).
const COLUMNS = {
  mine: [col("site"), "stage", col("clients"), "dr", "traffic", col("last_activity"), col("next"), ACTIONS_COL],
  unowned: [col("site"), "stage", col("clients"), "dr", "traffic", col("last_activity"), col("next"), ACTIONS_COL],
  waiting: [col("site"), "stage", col("owner"), col("clients"), "dr", col("last_activity"), col("next"), ACTIONS_COL],
  all: [col("site"), "stage", col("owner"), col("clients"), "dr", col("traffic", { className: "si-c-traffic" }), col("last_activity"), col("next"), ACTIONS_COL],
};
const SORT_KEYS = ["newest", "last_activity"]; // columns.js SORTS: sortable without a column

function sortable(tab, key) {
  return SORT_KEYS.includes(key) || COLUMNS[tabOf(tab)].some((c) => (typeof c === "string" ? c : c.id) === key && key !== "actions");
}

function tabsHtml(ctx, p) {
  return html`<nav class="si-tabs" aria-label="Site lists"><ul class="si-tablist">${TABS.map((t) => html`<li><a class="si-tab" data-si-tab="${t.id}" href="${tabHref(ctx, t.id, p)}"><span class="si-tab-label">${t.label}</span><span class="si-tab-n" data-si-n></span></a></li>`)}</ul></nav>`;
}

function drawTabs(ctx, p, v) {
  const tab = tabOf(p.tab);
  const ok = loaded(ctx) && v;
  for (const a of st.root.querySelectorAll("[data-si-tab]")) {
    const id = a.getAttribute("data-si-tab");
    a.setAttribute("href", tabHref(ctx, id, p));
    if (id === tab) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
    const n = a.querySelector("[data-si-n]");
    const text = ok ? num(v.counts[id] || 0) : "";
    if (n && n.textContent !== text) n.textContent = text;
  }
  const sub = st.root.querySelector("[data-si-sub]");
  const info = tabInfo(tab);
  if (sub && sub.textContent !== info.desc) sub.textContent = info.desc;
}

function quietHtml(p, v) {
  const on = quietOn(p);
  const n = v ? v.quiet : 0;
  const start = on && v && v.rows.length
    ? html`<button type="button" class="ui-btn is-sm is-primary si-start" data-si-start aria-describedby="si-start-hint"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>Start</button><span class="si-hint" id="si-start-hint">Opens them one by one, oldest first.</span>`
    : "";
  return html`<div class="si-chips" role="group" aria-label="Waiting for reply"><button type="button" class="ui-chipbtn" data-si-quiet aria-pressed="${on ? "true" : "false"}" title="Emailed more than 14 days ago with no answer and no later follow-up date">${QUIET} <span class="si-chip-n">(${num(n)})</span></button>${start}</div>`;
}

function presetsHtml(p) {
  return html`<div class="si-chips" role="group" aria-label="Quick views">${PRESET_CHIPS.map((c) => {
    const on = c.id === "sugg" ? p.sugg === "1" || p.preset === "sugg" : p.preset === c.id;
    return html`<button type="button" class="ui-chipbtn" data-si-preset="${c.id}" aria-pressed="${on ? "true" : "false"}" title="${c.title}">${c.label}</button>`;
  })}</div>`;
}

function sortHtml(p) {
  const cur = sortFor(effective(p));
  const list = SORT_CHOICES.filter((c) => sortable(p.tab, c.key));
  if (!list.some((c) => c.key === cur.key && c.dir === cur.dir)) list.push({ key: cur.key, dir: cur.dir, label: sortLabel(cur.key, cur.dir) });
  return html`<label class="si-sort"><span class="si-sort-l">Sort</span><select class="ui-input" data-si-sort>${list.map((c) => html`<option value="${c.key + ":" + c.dir}"${c.key === cur.key && c.dir === cur.dir ? raw(" selected") : ""}>${c.label}</option>`)}</select></label>`;
}

function rememberFocus(el) {
  const a = document.activeElement;
  if (!a || !el.contains(a)) return null;
  const attr = FOCUS_ATTRS.find((x) => a.hasAttribute(x));
  return attr ? { attr, value: a.getAttribute(attr) } : null;
}

function restoreFocus(el, f) {
  if (!f) return;
  const sel = "[" + f.attr + (f.value ? '="' + String(f.value).replace(/"/g, '\\"') + '"' : "") + "]";
  const t = el.querySelector(sel) || (f.attr === "data-si-start" ? el.querySelector("[data-si-quiet]") : null);
  if (t) t.focus({ preventScroll: true });
}

// One row: the tab's chips on the left; the count, Sort and Export CSV on the right (the list's own head,
// with its count and Export button, is hidden; Export calls the list's exportCsv()).
function drawTools(ctx, p, v) {
  const el = st.root.querySelector("[data-si-tools]");
  if (!el) return;
  const tab = tabOf(p.tab);
  const f = rememberFocus(el);
  const left = tab === "waiting" ? quietHtml(p, v) : tab === "all" ? presetsHtml(p) : "";
  const n = v && loaded(ctx) ? v.rows.length : null;
  render(el, html`${left}<div class="si-tools-r"><p class="si-count" data-si-count>${n == null ? "" : sites(n)}</p>${sortHtml(p)}<button type="button" class="ui-btn is-sm is-ghost si-csv" data-si-csv data-csv><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v11M7 10l5 5 5-5M5 20h14"/></svg>Export CSV</button></div>`);
  restoreFocus(el, f);
}

// ---------- empty states (spec 4.10) ----------

function emptyFor() {
  const ctx = st.ctx;
  const p = params(ctx);
  const tab = tabOf(p.tab);
  if (filtered(tab, p)) {
    if (tab === "waiting" && quietOn(p) && !SHARED.some((k) => has(p[k]))) {
      return { title: "No site has waited 14+ days for a reply.", body: "Every emailed site heard from you in the last 14 days or has a later follow-up date.", action: { label: "Show all waiting", act: "quiet-off" } };
    }
    return { title: EMPTY.filtered.title, body: EMPTY.filtered.body, action: { label: "Clear filters", act: "clear" } };
  }
  if (tab === "mine" && !me(ctx)) return { title: "Pick your name to see your sites.", body: "", action: { label: "Show all sites", act: "tab-all" } };
  if (tab === "waiting" && p.owner !== "all" && p.owner !== "any") {
    return { title: "None of your sites are waiting for a reply.", body: "Sites move here when you log “Sent first email”.", action: { label: "Show everyone's", act: "owner-all" } };
  }
  return tabInfo(tab).empty;
}

function emptyAct(act) {
  const ctx = st.ctx;
  const p = params(ctx);
  if (act === "clear") {
    const patch = { quiet: null, preset: null, sort: null, dir: null, page: null };
    for (const k of KEEP) patch[k] = null;
    ctx.setParams(patch);
  } else if (act === "quiet-off") {
    ctx.setParams({ quiet: null, sort: null, dir: null, page: null });
  } else if (act === "owner-all") {
    ctx.setParams({ owner: "all", page: null });
  } else if (/^tab-/.test(act)) {
    ctx.go("sites", Object.assign({ tab: act.slice(4) }, keepParams(p)));
  }
}

// ---------- list ----------

function queueLabel() {
  const p = params(st.ctx);
  const tab = tabOf(p.tab);
  return tab === "waiting" && quietOn(p) ? QUIET : tabInfo(tab).label;
}

function openRow(id, o) {
  const ctx = st.ctx;
  const q = o && o.queue;
  if (!q) return ctx.openRecord(id);
  const p = params(ctx);
  const quiet = tabOf(p.tab) === "waiting" && quietOn(p);
  return ctx.openRecord(id, { queue: Object.assign({}, q, { label: queueLabel() }, quiet ? { primary: "followed_up" } : {}) });
}

// The person sorted or paged in the list: put it in the URL (replace), so the route update finds the
// list already showing it.
function onListState(s) {
  const ctx = st.ctx;
  const p = params(ctx);
  st.applied = { key: s.sort, dir: s.dir, page: s.page || 1 };
  const patch = { page: s.page > 1 ? String(s.page) : null };
  let preset = p.preset;
  if (preset === "activity" && s.sort && !(s.sort === "last_activity" && s.dir === "desc")) {
    patch.preset = null;
    preset = null;
  }
  Object.assign(patch, sortParams(s.sort, s.dir, baseSort(effective(Object.assign({}, p, { preset })))));
  ctx.setParams(patch, { replace: true });
}

// "Show only …" in a pill menu: the filter on this tab, or on All when this tab doesn't offer it.
function filterBy(param, value) {
  const ctx = st.ctx;
  const p = params(ctx);
  const tab = tabOf(p.tab);
  const v = value == null || value === "" ? (param === "owner" ? "none" : null) : value;
  if (FIELDS[tab].includes(param)) {
    onBarChange({ [param]: v, page: null });
    return;
  }
  ctx.go("sites", Object.assign({ tab: "all" }, keepParams(p), { [param]: v }));
}

function makeList(tab) {
  const el = st.root.querySelector("[data-si-list]");
  if (st.list) st.list.destroy();
  el.setAttribute("data-tab", tab);
  const p = params(st.ctx);
  const s = sortFor(effective(p));
  st.applied = { key: s.key, dir: s.dir, page: Number(p.page) || 1 };
  st.list = createList(el, {
    id: "sites",
    rows: () => (st && st.view ? st.view.rows : []),
    columns: COLUMNS[tab],
    sort: { key: s.key, dir: s.dir },
    selectable: true,
    bulk: (bulkEl, o) => createBulkBar(bulkEl, o),
    csv: false, // Export CSV sits in the page's tool row and calls exportCsv()
    csvColumns: CSV_SITES,
    csvName: "sites-" + tab,
    empty: () => emptyFor(),
    queueLabel: "Sites",
    openRecord: openRow,
    onFilter: filterBy,
    label: tabInfo(tab).label,
    onState: onListState,
  });
  if (st.applied.page > 1) st.list.refresh({ page: st.applied.page });
}

function onBarChange(patch, opts = {}) {
  const ctx = st.ctx;
  const p = params(ctx);
  const tab = tabOf(p.tab);
  const out = Object.assign({}, patch);
  if ("owner" in out && tab === "waiting") {
    if (out.owner == null) out.owner = "all"; // the "Owner: Me" chip was removed: everyone's
    else if (out.owner === "me") out.owner = null; // the default
  }
  if ("sugg" in out && out.sugg == null && p.preset === "sugg") out.preset = null;
  ctx.setParams(out, { replace: !!opts.replace });
}

function makeBar(tab) {
  const el = st.root.querySelector("[data-si-filters]");
  if (st.bar) st.bar.destroy();
  st.bar = createFilterBar(el, {
    fields: FIELDS[tab],
    params: barParams(tab, params(st.ctx)),
    onChange: onBarChange,
    records: () => st.ctx.store.all(),
    label: "Filters",
  });
}

// ---------- drawing ----------

function say(text, { now = false } = {}) {
  clearTimeout(st.sayTimer);
  if (now) {
    st.ctx.announce(text);
    return;
  }
  st.sayTimer = setTimeout(() => {
    if (st) st.ctx.announce(text);
  }, 700);
}

// what: 'route' (params changed), 'store' (rows changed), 'all' (meta or person changed; first draw).
function draw(what = "all") {
  if (!st) return;
  st.frame = 0;
  const ctx = st.ctx;
  const p = params(ctx);
  const tab = tabOf(p.tab);
  const switched = tab !== st.tab;
  if (switched) {
    st.tab = tab;
    st.view = null;
    st.key = "";
    makeBar(tab);
  }
  const key = dataKey(ctx, p);
  const changed = key !== st.key || what !== "route";
  if (changed) {
    st.view = loaded(ctx) ? compute(ctx) : { rows: [], counts: { mine: 0, unowned: 0, waiting: 0, all: 0 }, quiet: 0, tab };
    st.key = key;
  }
  drawTabs(ctx, p, st.view);
  if (!switched && st.bar) st.bar.update(barParams(tab, p));
  drawTools(ctx, p, st.view);
  if (switched || !st.list) {
    makeList(tab);
  } else {
    const s = sortFor(effective(p));
    const page = Number(p.page) || 1;
    const a = st.applied || {};
    const moved = a.key !== s.key || a.dir !== s.dir || a.page !== page;
    if (moved || (what === "route" && changed)) {
      st.applied = { key: s.key, dir: s.dir, page };
      st.list.refresh({ sort: s.key, dir: s.dir, page });
    } else if (what !== "route") {
      st.list.refresh(); // rows changed: keep sort, page, "Show more", selection and focus
    }
  }
  const n = st.view.rows.length;
  if (!st.announced) {
    if (loaded(ctx)) {
      st.announced = true;
      say("Sites, " + sites(n), { now: true });
    }
  } else if (what === "route" && switched) {
    say(tabInfo(tab).label + ", " + sites(n));
  } else if (what === "route" && changed) {
    say(sites(n));
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

// ---------- events ----------

function bind() {
  const root = st.root;
  st.offs.push(on(root, "click", "[data-si-quiet]", () => {
    const p = params(st.ctx);
    st.ctx.setParams({ quiet: quietOn(p) ? null : "14", sort: null, dir: null, page: null });
  }));
  st.offs.push(on(root, "click", "[data-si-start]", () => {
    const rows = st.list ? st.list.rows() : [];
    const ids = rows.map((r) => String(r.id)).filter(Boolean);
    if (!ids.length) return;
    st.ctx.openRecord(ids[0], { queue: { ids, index: 0, label: QUIET, primary: "followed_up" } });
  }));
  st.offs.push(on(root, "click", "[data-si-preset]", (e, b) => {
    const id = b.getAttribute("data-si-preset");
    const p = params(st.ctx);
    if (id === "sugg") {
      const onNow = p.sugg === "1" || p.preset === "sugg";
      st.ctx.setParams({ sugg: onNow ? null : "1", preset: p.preset === "sugg" ? null : p.preset, page: null });
      return;
    }
    const onNow = p.preset === id;
    st.ctx.setParams({ preset: onNow ? null : id, sort: null, dir: null, page: null });
  }));
  st.offs.push(on(root, "change", "[data-si-sort]", (e, sel) => {
    const [key, d] = String(sel.value || "").split(":");
    const dir = d === "desc" ? "desc" : "asc";
    const p = params(st.ctx);
    const patch = { page: null };
    let preset = p.preset;
    if (preset === "activity" && !(key === "last_activity" && dir === "desc")) {
      patch.preset = null;
      preset = null;
    }
    Object.assign(patch, sortParams(key, dir, baseSort(effective(Object.assign({}, p, { preset })))));
    st.ctx.setParams(patch, { replace: true });
  }));
  st.offs.push(on(root, "click", "[data-si-csv]", () => {
    if (st.list) st.list.exportCsv();
  }));
  st.offs.push(on(root, "click", "[data-empty-act]", (e, b) => emptyAct(b.getAttribute("data-empty-act"))));
}

export default {
  id: "sites",
  title,
  mount(root, ctx) {
    if (st) this.unmount();
    st = fresh(root, ctx);
    const p = params(ctx);
    render(root, html`<div class="si-page"><header class="si-head"><h1 tabindex="-1">Sites</h1><p class="si-sub" data-si-sub>${tabInfo(p.tab).desc}</p></header>${tabsHtml(ctx, p)}<div class="si-filters" data-si-filters></div><div class="si-tools" data-si-tools></div><div class="si-list" data-si-list></div></div>`);
    bind();
    draw("all");
    if (!st.announced) ctx.announce("Sites");
  },
  update(ctx, change) {
    if (!st) return;
    st.ctx = ctx;
    const kind = change && change.kind;
    if (kind === "route") {
      // Params changed (tab, filters, sort, page): draw now, so the list follows the URL at once.
      let w = "route";
      if (st.frame) {
        const caf = typeof cancelAnimationFrame === "function" ? cancelAnimationFrame : clearTimeout;
        caf(st.frame);
        st.frame = 0;
        if (st.pending) w = "all";
        st.pending = null;
      }
      draw(w);
      return;
    }
    st.ranks.clear();
    schedule(kind === "store" ? "store" : "all");
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
