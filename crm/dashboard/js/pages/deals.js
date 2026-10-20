// Deals (spec 2.2.3, Appendix B.5, 4.7, 4.10, 4.12). Page module contract (spec 5.4). Owner F4.
//
// Header: h1 "Deals", one line about what is here, and Export CSV. Then the filter bar (ui/filters.js:
// Client, Owner (default everyone), Waiting on client; on phone a Filters sheet) and one list grouped by
// stage (rules/deals.js, B.5), each group hidden when it has no rows:
//   Negotiating (N · $ total) · Signed, not live (N · $ total) · Live (N) · Lost in the last 30 days (N)
// Each group is a ui/list.js list (a table at >= 640 px, cards below) with the same columns, so the groups
// line up: Site (name, then the Stage ▾ pill and the client tags), Terms ("$350 + 30%" over "Flat fee +
// commission"), Value (deal value, or the flat fee: what the total adds up), then Next step (+ due, "Waiting
// on client", "Quiet 9d") for open deals, Placement (link + went-live date) for Live, Last activity for Lost;
// Owner ▾ and [Log what happened ▾]. The Stage ▾ pill (ui/inline-edit.js, the record panel's own editor and
// write, with Undo) moves a deal in one click, as the old board's drag did: Negotiating → Active (Signed, not
// live); Lost asks for the reason. Signed → Live is Log what happened ▾ › Placement is live (the link). No
// Stage column: the group heading says it. A row opens the site in queue mode over its group.
// URL (spec 2.4): client, owner (name | me | none), waiting=1. Every write goes through ui/actions.js (the
// row editors and Log what happened). The four lists are made once at mount and refreshed in place on
// route, store, meta and person changes; nothing is remounted, so no listener is ever added twice.
// Export CSV: every deal the filters leave, group by group in the order shown, with the deal columns.
import { html, render, on, safeUrl } from "../core/dom.js";
import { num, plural, money, pct, date as fmtDate, ago } from "../core/format.js";
import { dealGroups, dealValue, isQuiet, GROUPS } from "../rules/deals.js";
import { createList, toCsv, csvColumnsOf, downloadText, csvFileName } from "../ui/list.js";
import { createFilterBar, applyFilters } from "../ui/filters.js";
import { COLUMNS, CSV_DEALS, resolveColumn } from "../ui/columns.js";
import { clientTags, newDot, waitingBadge, stagePill } from "../ui/pills.js";
import { rowActions } from "../ui/inline-edit.js";
import { emptyState, EMPTY } from "../ui/empty.js";
import { skeletonRows } from "../ui/skeleton.js";

const FIELDS = ["client", "owner", "waiting"];
const SUB = "Sites talking terms with us, signed or live, and the ones lost in the last 30 days.";
const VALUE_TIP = "Deal value, or the flat fee when no value is set";
const DOT = { negotiating: "neg", signed: "active", live: "active", lost: "lost" };
const FOCUS_ATTRS = ["data-open", "data-edit", "data-row-act", "data-sort"];

const has = (v) => v != null && String(v).trim() !== "";
const title = () => "Deals";
const dealsText = (n) => num(n) + " " + plural(n, "deal");
const dash = html`<span class="ui-faint" aria-label="none">—</span>`;

let st = null; // the mounted page's state

function fresh(root, ctx) {
  return { root, ctx, offs: [], lists: {}, bar: null, view: null, frame: 0, announced: false, sayTimer: 0 };
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

function filtered(p) {
  return FIELDS.some((k) => has(p[k]));
}

// {groups, byId}: the filtered deals in their groups, and each deal's group label (for the CSV).
function compute(ctx) {
  const list = applyFilters(ctx.store.all(), filterParams(params(ctx)), { meta: ctx.meta, me: me(ctx) });
  const groups = dealGroups(list, { meta: ctx.meta, today: ctx.today });
  const byId = new Map();
  for (const g of GROUPS) for (const r of groups[g.id]) byId.set(String(r.id), g.label);
  return { groups, byId };
}

// ---------- columns ----------

function shortUrl(u) {
  const s = String(u || "").replace(/^https?:\/\//i, "").replace(/^www\./i, "").replace(/\/$/, "");
  return s.length > 48 ? s.slice(0, 47) + "…" : s;
}

// "$350 + 30%" from the flat fee and the commission (the value has its own column).
function amounts(r) {
  return [money(r.deal_flat), pct(r.deal_pct)].filter(Boolean).join(" + ");
}

// The name, then the Stage ▾ pill (plain in read-only mode) and the client tags on the line under it.
function siteCell(r, cx) {
  const href = cx && cx.link ? cx.link(r) : "#";
  return html`<span class="ui-site dl-site"><a class="ui-row-link" href="${href}" data-open="${r.id}">${r.label || r.domain || r.id}</a>${newDot(r)}<span class="dl-tags">${stagePill(r, { edit: !(cx && cx.readOnly) })}${clientTags(r, { max: 2 })}</span></span>`;
}

function termsCell(r) {
  const model = has(r.deal_model) ? String(r.deal_model) : "";
  const amt = amounts(r);
  if (!model && !amt) return r.stage === "Lost" ? dash : html`<span class="ui-faint dl-noterms">No terms yet</span>`;
  return html`<span class="dl-terms">${amt ? html`<span class="dl-amt">${amt}</span>` : ""}${amt && model ? html`<span class="sr-only">, </span>` : ""}${model ? html`<span class="${amt ? "dl-model" : "dl-amt"}">${model}</span>` : ""}</span>`;
}

function valueCell(r) {
  const v = dealValue(r);
  return v == null ? dash : html`<span class="num">${money(v)}</span>`;
}

function quietChip(r) {
  if (!st || !isQuiet(r, { meta: st.ctx.meta })) return "";
  return html` <span class="ui-chip is-warn dl-quiet" title="${"No activity for " + r.quietDays + " days"}">Quiet ${r.quietDays}d</span>`;
}

function nextCell(r, cx) {
  return html`<span class="dl-next">${COLUMNS.next.cell(r, cx)}${quietChip(r)}</span>`;
}

function placementCell(r, cx) {
  const u = safeUrl(r.content_url);
  const live = has(r.live_date) ? String(r.live_date).slice(0, 10) : "";
  const today = (cx && cx.today) || "";
  const when = live ? (live > today ? "Goes live " : "Went live ") + fmtDate(live, live.slice(0, 4) === today.slice(0, 4) ? "day" : "year") : "";
  const link = u
    ? html`<a class="dl-plink" href="${u}" target="_blank" rel="noopener noreferrer" title="${u}">${shortUrl(u)}<span aria-hidden="true"> ↗</span><span class="sr-only"> (opens in a new tab)</span></a>`
    : has(r.content_url) ? html`<span class="dl-plink">${r.content_url}</span>` : "";
  if (!link && !when) return r.waitingOnClient ? waitingBadge(r) : dash;
  return html`<span class="dl-place">${r.waitingOnClient ? html`<span>${waitingBadge(r)}</span>` : ""}${link}${when ? html`<span class="dl-when">${when}</span>` : ""}</span>`;
}

// Live and Lost rows show no next step, so a "Waiting on client:" one still shows its badge (the filter finds it).
function lastCell(r, cx) {
  if (!r.lastActivity) return r.waitingOnClient ? waitingBadge(r) : dash;
  return html`${r.waitingOnClient ? html`${waitingBadge(r)} ` : ""}<span class="dl-last"><span>${fmtDate(r.lastActivity, "day")}</span> <span class="dl-ago">${ago(r.lastActivity, cx && cx.today)}</span></span>`;
}

function actsCell(r, cx) {
  return cx && cx.readOnly ? html`` : rowActions(r, { follow: false });
}

const SITE = { id: "site", label: "Site", priority: 1, className: "is-site dl-c-site", cell: siteCell };
const TERMS = { id: "terms", label: "Terms", priority: 2, className: "dl-c-terms", cell: termsCell, sort: (r) => amounts(r) || (has(r.deal_model) ? String(r.deal_model).toLowerCase() : null) };
const VALUE = { id: "value", label: "Value", title: VALUE_TIP, priority: 3, align: "num", className: "dl-c-value", cell: valueCell, sort: dealValue, csv: dealValue };
const NEXT = { id: "next", label: "Next step", priority: 2, className: "dl-c-what", cell: nextCell };
const PLACE = { id: "placement", label: "Placement", priority: 2, className: "dl-c-what", cell: placementCell, sort: (r) => (has(r.live_date) ? String(r.live_date).slice(0, 10) : null) };
const LAST = { id: "last_activity", label: "Last activity", priority: 2, className: "dl-c-what", cell: lastCell };
const OWNER = { id: "owner", label: "Owner", priority: 1, className: "dl-c-owner" };
const ACTS = { id: "actions", label: "Actions", labelHidden: true, priority: 1, className: "is-actions dl-c-acts", cell: actsCell, csv: false };

const COLS = {
  negotiating: [SITE, TERMS, VALUE, NEXT, OWNER, ACTS],
  signed: [SITE, TERMS, VALUE, NEXT, OWNER, ACTS],
  live: [SITE, TERMS, VALUE, PLACE, OWNER, ACTS],
  lost: [SITE, TERMS, VALUE, LAST, OWNER, ACTS],
};
// The order each list starts in (the same as rules/deals.js), shown on its column header.
const SORT = {
  negotiating: { key: "next", dir: "asc" },
  signed: { key: "next", dir: "asc" },
  live: { key: "placement", dir: "desc" },
  lost: { key: "last_activity", dir: "desc" },
};

// ---------- markup ----------

function groupHtml(g) {
  return html`<section class="dl-group" data-dl-group="${g.id}" aria-labelledby="${"dl-h-" + g.id}" hidden><div class="dl-ghead"><h2 class="dl-h" id="${"dl-h-" + g.id}" tabindex="-1"><span class="${"ui-dot is-" + DOT[g.id]}" aria-hidden="true"></span><span>${g.label}</span> <span class="dl-n" data-dl-n></span></h2><p class="dl-desc">${g.desc}</p></div><div class="dl-list" data-dl-list="${g.id}"></div></section>`;
}

// "(12 · $8,700)", "(3)"; the total only when at least one deal in the group has a value.
function countHtml(g, v) {
  const rows = v.groups[g.id];
  const n = rows.length;
  if (!g.total || !v.groups.valued[g.id]) return html`(${num(n)})`;
  const valued = v.groups.valued[g.id];
  const tip = "Total of " + (valued === n ? "the " + plural(n, "deal") : num(valued) + " of " + num(n) + " deals; the others have no value yet") + ". " + VALUE_TIP + ".";
  return html`(${num(n)} · <span class="dl-total" title="${tip}">${money(v.groups.totals[g.id])}</span>)`;
}

function emptyHtml(ctx) {
  if (filtered(params(ctx))) return emptyState({ title: EMPTY.filtered.title.replace("sites", "deals"), body: EMPTY.filtered.body, action: { label: "Clear filters", act: "clear" } });
  return emptyState(EMPTY.deals);
}

// ---------- focus ----------

// Where the focus is in a list, so it can come back after a refresh, also when a save moved the row to
// another group (a deal moved to Lost): same row and control, else the row's old group heading.
function focusInfo() {
  const a = typeof document !== "undefined" ? document.activeElement : null;
  if (!a || !st.root.contains(a) || !a.closest("[data-dl-list]")) return null;
  const row = a.closest("[data-key]");
  const group = a.closest("[data-dl-group]");
  const attr = FOCUS_ATTRS.find((x) => a.hasAttribute(x)) || null;
  return { key: row ? row.getAttribute("data-key") : null, attr, value: attr ? a.getAttribute(attr) : null, group: group ? group.getAttribute("data-dl-group") : null };
}

function restoreFocus(f) {
  if (!f) return;
  const a = document.activeElement;
  if (a && a !== document.body && st.root.contains(a) && a.isConnected) return; // the list kept it
  const esc = (v) => (typeof CSS !== "undefined" && CSS.escape ? CSS.escape(v) : String(v).replace(/"/g, '\\"'));
  let target = null;
  if (f.key) {
    const row = st.root.querySelector('[data-dl-group]:not([hidden]) [data-key="' + esc(f.key) + '"]');
    if (row) target = (f.attr && row.querySelector("[" + f.attr + '="' + esc(f.value || "") + '"]')) || row.querySelector("a[data-open]");
  }
  if (!target && f.group) {
    const sec = st.root.querySelector('[data-dl-group="' + f.group + '"]');
    target = sec && !sec.hidden ? sec.querySelector(".dl-h") : st.root.querySelector("h1");
  }
  if (target) target.focus({ preventScroll: true });
}

// ---------- drawing ----------

// Filter changes are announced 700 ms later, so quick changes give one announcement. The first count
// (spec 4.13, "Deals, 54 deals") goes at once: during mount it replaces the title announcement.
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

function makeLists() {
  for (const g of GROUPS) {
    const el = st.root.querySelector('[data-dl-list="' + g.id + '"]');
    st.lists[g.id] = createList(el, {
      id: "deals-" + g.id,
      rows: () => (st && st.view ? st.view.groups[g.id] : []),
      columns: COLS[g.id],
      sort: SORT[g.id],
      csv: false, // one Export CSV for the page, in the header
      noun: ["deal", "deals"],
      label: g.label,
      empty: () => html``,
      loading: () => false,
      queueLabel: g.label,
      openRecord: (id, o) => st.ctx.openRecord(id, o || {}),
    });
  }
}

// what: 'route' (filters changed), 'store' (rows changed), 'all' (first draw, meta or person changed).
function draw(what = "all") {
  if (!st) return;
  st.frame = 0;
  const ctx = st.ctx;
  const p = params(ctx);
  if (st.bar && what !== "store") st.bar.update(filterParams(p));
  const body = st.root.querySelector("[data-dl-body]");
  const skel = st.root.querySelector("[data-dl-loading]");
  const emptyEl = st.root.querySelector("[data-dl-empty]");
  if (!loaded(ctx)) {
    st.view = { groups: dealGroups([], {}), byId: new Map() };
    if (skel) skel.hidden = false;
    emptyEl.hidden = true;
    for (const s of st.root.querySelectorAll("[data-dl-group]")) s.hidden = true;
    body.setAttribute("aria-busy", "true");
    return;
  }
  body.removeAttribute("aria-busy");
  if (skel) skel.hidden = true;
  const f = focusInfo();
  st.view = compute(ctx);
  const v = st.view;
  for (const g of GROUPS) {
    const sec = st.root.querySelector('[data-dl-group="' + g.id + '"]');
    const n = v.groups[g.id].length;
    sec.hidden = n === 0;
    render(sec.querySelector("[data-dl-n]"), countHtml(g, v));
    if (st.lists[g.id]) st.lists[g.id].refresh();
  }
  const none = v.groups.count === 0;
  emptyEl.hidden = !none;
  if (none) render(emptyEl, emptyHtml(ctx));
  else render(emptyEl, html``);
  const csv = st.root.querySelector("[data-dl-csv]");
  if (csv) csv.disabled = none;
  restoreFocus(f);
  const text = v.groups.count ? dealsText(v.groups.count) : filtered(p) ? "No deals match" : "No deals yet";
  // "Deals, 54 deals" once the rows are there; "54 deals" again when the filters change.
  if (!st.announced) {
    st.announced = true;
    say("Deals, " + text.charAt(0).toLowerCase() + text.slice(1), { now: true });
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

// ---------- CSV ----------

function exportCsv() {
  const v = st.view;
  if (!v || !v.groups.count) return;
  const rows = [];
  for (const g of GROUPS) {
    const l = st.lists[g.id];
    rows.push(...(l ? l.rows() : v.groups[g.id]));
  }
  const cols = [{ label: "Group", value: (r) => v.byId.get(String(r.id)) || "" }].concat(csvColumnsOf(CSV_DEALS.map(resolveColumn).filter(Boolean), { today: st.ctx.today }));
  downloadText(csvFileName("deals", st.ctx.today), toCsv(rows, cols), st.root);
}

// ---------- events ----------

function clearFilters() {
  const patch = { page: null };
  for (const k of FIELDS) patch[k] = null;
  st.ctx.setParams(patch);
}

function bind() {
  const root = st.root;
  st.offs.push(on(root, "click", "[data-dl-csv]", () => exportCsv()));
  st.offs.push(on(root, "click", "[data-empty-act]", (e, b) => {
    if (b.getAttribute("data-empty-act") === "clear") clearFilters();
  }));
}

export default {
  id: "deals",
  title,
  mount(root, ctx) {
    if (st) this.unmount();
    st = fresh(root, ctx);
    render(root, html`<div class="dl-page"><header class="dl-head"><h1 tabindex="-1">Deals</h1><button type="button" class="ui-btn is-sm is-ghost dl-csv" data-dl-csv data-download><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v11M7 10l5 5 5-5M5 20h14"/></svg>Export CSV</button><p class="dl-sub">${SUB}</p></header><div class="dl-filters" data-dl-filters></div><div class="dl-body" data-dl-body><div class="dl-loading" data-dl-loading hidden>${skeletonRows(6)}</div>${GROUPS.map(groupHtml)}<div class="dl-empty" data-dl-empty hidden></div></div></div>`);
    st.bar = createFilterBar(root.querySelector("[data-dl-filters]"), {
      fields: FIELDS,
      params: filterParams(params(ctx)),
      onChange: (patch, opts) => st && st.ctx.setParams(patch, { replace: !!(opts && opts.replace) }),
      records: () => (st ? st.ctx.store.all() : []),
      label: "Filters",
    });
    st.view = loaded(ctx) ? compute(ctx) : { groups: dealGroups([], {}), byId: new Map() };
    makeLists();
    bind();
    draw("all");
    if (!st.announced) ctx.announce("Deals"); // rows not loaded yet: the count follows when they are
  },
  update(ctx, change) {
    if (!st) return;
    st.ctx = ctx;
    const kind = change && change.kind;
    if (kind === "route") {
      // Filters changed: draw now, so the list follows the URL at once.
      if (st.frame) {
        const caf = typeof cancelAnimationFrame === "function" ? cancelAnimationFrame : clearTimeout;
        caf(st.frame);
        st.frame = 0;
        st.pending = null;
      }
      draw("route");
      return;
    }
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
    for (const l of Object.values(st.lists)) {
      try { l.destroy(); } catch (e) { /* already gone */ }
    }
    try { if (st.bar) st.bar.destroy(); } catch (e) { /* already gone */ }
    st = null;
  },
};
