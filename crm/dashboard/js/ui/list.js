// createList: a table at >= 640 px and cards below (CSS), sort, paging, selection, CSV (spec 4.7, 5.4).
// Owner G1-C. No side effects at import time.
//
// createList(root, {id, rows?, fetchPage?, columns, sort, pageSize, selectable, bulk?, csv = true,
//   csvName, empty, queueLabel, ...extras}) -> {refresh(), selected(), destroy(), ...}
// - rows: () => Record[] (client-side; sorted and paged here), or fetchPage({page, per, sort, dir,
//   params}) -> {rows, total} (server-paged; "Load more" appends, CSV covers the fetched pages).
// - columns: catalog ids (columns.js) or column objects {id, label, cell(row, cx), sort?(row), priority,
//   csv?}. sort: {key, dir} | 'key' | '-key' (a column id or a columns.js SORTS key such as 'newest').
// - Row markup (spec 4.7): the name cell is a real <a href="#…&rec=ID">; <tr> has no tabindex, so
//   Enter on the link opens the panel once and it stays open. A click elsewhere on a row (not on a
//   control) follows the same link.
// - csv (default true): "Export CSV" downloads the current filtered rows, all pages, formula-safe (T26),
//   with a BOM, as partnergap-<csvName|id>-<date>.csv.
// - refresh() keeps the sort, page, selection, scroll and focus; editors are popovers, so they stay.
// Extras: openRecord(id, {queue}) (with queueLabel the queue is the list's sorted ids), onFilter(param,
//   value) ("Filter by this" in the pill menus), csvColumns, noun [one, many], label (table caption),
//   recOf(row) -> site id (default row.id for site rows), link(row) -> href, params (for fetchPage),
//   onState({sort, dir, page, per}), loading() -> boolean (skeleton while true and empty).
import { html, raw, render, on } from "../core/dom.js";
import { num, plural, todayIso } from "../core/format.js";
import * as router from "../core/router.js";
import * as store from "../core/store.js";
import * as metaMod from "../core/meta.js";
import { resolveColumn, SORTS } from "./columns.js";
import { bindInlineEdits } from "./inline-edit.js";
import { emptyState } from "./empty.js";
import { skeletonRows } from "./skeleton.js";

// ---------- CSV ----------

const FORMULA = /^[=+\-@\t\r]/;

// One CSV cell: a leading = + - @ tab or CR gets an apostrophe (T26); quotes when needed.
export function csvCell(v) {
  let s = v == null ? "" : typeof v === "number" && !isFinite(v) ? "" : String(v);
  if (FORMULA.test(s)) s = "'" + s;
  if (/[",\r\n\t]/.test(s) || /^\s|\s$/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
  return s;
}

function textOf(safe) {
  const s = String(safe == null ? "" : safe);
  if (!/[<&]/.test(s)) return s.trim();
  if (typeof document === "undefined") return s.replace(/<[^>]*>/g, "").trim();
  const t = document.createElement("template");
  t.innerHTML = s;
  return (t.content.textContent || "").replace(/\s+/g, " ").trim();
}

// The CSV columns [{label, value(row)}] of a set of columns (a column's csv list expands to several).
export function csvColumnsOf(columns, cx) {
  const out = [];
  for (const c of columns) {
    if (!c || c.csv === false) continue;
    if (Array.isArray(c.csv)) for (const x of c.csv) out.push({ label: x.label, value: x.value });
    else if (typeof c.csv === "function") out.push({ label: c.csvLabel || c.label, value: c.csv });
    else if (typeof c.cell === "function") out.push({ label: c.label, value: (r) => textOf(c.cell(r, cx)) });
  }
  return out;
}

// The whole file: BOM, a header row, then one line per row (CRLF).
export function toCsv(rows, csvCols) {
  const lines = [csvCols.map((c) => csvCell(c.label)).join(",")];
  for (const r of rows) lines.push(csvCols.map((c) => {
    let v;
    try { v = c.value(r); } catch (e) { v = ""; }
    return csvCell(v);
  }).join(","));
  return "﻿" + lines.join("\r\n") + "\r\n";
}

export function downloadText(name, text, host, type = "text/csv;charset=utf-8") {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.hidden = true;
  (host || document.body).appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export function csvFileName(name, today = todayIso()) {
  const slug = String(name || "list").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "list";
  return "partnergap-" + slug + "-" + today + ".csv";
}

// ---------- Sorting ----------

function parseSort(s) {
  if (!s) return { key: null, dir: "asc" };
  if (typeof s === "string") return s.startsWith("-") ? { key: s.slice(1), dir: "desc" } : { key: s, dir: "asc" };
  return { key: s.key || null, dir: s.dir === "desc" ? "desc" : "asc" };
}

function compareValues(a, b) {
  const ea = a == null || a === "";
  const eb = b == null || b === "";
  if (ea || eb) return ea && eb ? 0 : ea ? 1 : -1; // empty values last in both directions
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a).localeCompare(String(b), "en", { numeric: true, sensitivity: "base" });
}

function sortRows(list, fn, dir) {
  if (!fn) return list.slice();
  const keyed = list.map((r, i) => {
    let k;
    try { k = fn(r); } catch (e) { k = null; }
    return { r, k, i };
  });
  const sign = dir === "desc" ? -1 : 1;
  keyed.sort((x, y) => {
    const ex = x.k == null || x.k === "";
    const ey = y.k == null || y.k === "";
    if (ex || ey) return ex && ey ? x.i - y.i : ex ? 1 : -1;
    return sign * compareValues(x.k, y.k) || x.i - y.i;
  });
  return keyed.map((x) => x.r);
}

// ---------- createList ----------

const SORT_ICON = raw('<svg class="ui-sorticon" viewBox="0 0 24 24" aria-hidden="true"><path class="ui-sort-up" d="M8 10l4-4 4 4"/><path class="ui-sort-dn" d="M8 14l4 4 4-4"/></svg>');

export function createList(root, opts = {}) {
  const {
    id = "list", rows, fetchPage, columns = ["site"], sort, pageSize, selectable = false, bulk,
    csv = true, csvName, empty, queueLabel, openRecord, onFilter, csvColumns, noun = ["site", "sites"],
    label, recOf, link, params, onState, loading,
  } = opts;
  if (!root) return { refresh() {}, selected() { return []; }, destroy() {} };
  const cols = columns.map(resolveColumn).filter(Boolean);
  const server = typeof fetchPage === "function";
  const state = {
    sort: parseSort(sort),
    page: 1,
    pages: 1,
    per: Number(pageSize) || (server ? 100 : 50),
    selected: new Set(),
    sorted: [],
    fetched: [],
    total: 0,
    loadingMore: false,
    fetchError: null,
    token: 0,
    params: params || {},
  };
  const readOnly = () => !!metaMod.get().read_only;
  const canSelect = () => !!selectable && !readOnly();
  const keyOf = (r) => (r && r.id != null ? String(r.id) : "");
  const recId = (r) => (typeof recOf === "function" ? recOf(r) : r && r.id != null && "stage" in r ? String(r.id) : null);
  const byKey = new Map();

  function rowLink(r) {
    const rid = recId(r);
    if (typeof link === "function") return link(r);
    if (!rid) return "";
    const cur = router.current();
    return router.href(cur.page || "today", Object.assign({}, cur.params, { rec: rid }), cur.sub);
  }
  const cx = () => ({ link: rowLink, today: todayIso(), readOnly: readOnly() });

  function sortFn() {
    const k = state.sort.key;
    if (!k) return null;
    const c = cols.find((x) => x.id === k);
    if (c && typeof c.sort === "function") return c.sort;
    if (SORTS[k]) return SORTS[k].value;
    return null;
  }

  function computeClient() {
    let list = [];
    try { list = typeof rows === "function" ? rows() || [] : Array.isArray(rows) ? rows : []; } catch (e) {
      if (typeof console !== "undefined") console.error(e);
      list = [];
    }
    state.sorted = sortRows(list, sortFn(), state.sort.dir);
    state.total = state.sorted.length;
  }

  function current() {
    return server ? state.fetched : state.sorted;
  }

  function visible() {
    if (server) return state.fetched;
    const start = (state.page - 1) * state.per;
    return state.sorted.slice(start, start + state.per * state.pages);
  }

  function pageCount() {
    return Math.max(1, Math.ceil(state.total / state.per));
  }

  function clampPage() {
    const max = pageCount();
    if (state.page > max) state.page = max;
    if (state.page < 1) state.page = 1;
  }

  function pruneSelection() {
    const all = new Set(current().map(keyOf));
    for (const k of Array.from(state.selected)) if (!all.has(k)) state.selected.delete(k);
  }

  // ---------- Markup ----------

  render(root, html`<div class="ui-list" data-list="${id}">
<div class="ui-list-head"><p class="ui-list-count" data-count></p><div class="ui-list-tools" data-tools></div></div>
<div class="ui-bulkbar" data-bulk hidden></div>
<div class="ui-list-body" data-lbody></div>
<div class="ui-pager" data-pager></div>
</div>`);
  const el = root.querySelector(".ui-list");
  const countEl = el.querySelector("[data-count]");
  const toolsEl = el.querySelector("[data-tools]");
  const bulkEl = el.querySelector("[data-bulk]");
  const bodyEl = el.querySelector("[data-lbody]");
  const pagerEl = el.querySelector("[data-pager]");

  function headHtml() {
    const sel = canSelect();
    const page = visible();
    const allOn = page.length > 0 && page.every((r) => state.selected.has(keyOf(r)));
    const someOn = page.some((r) => state.selected.has(keyOf(r)));
    return html`<thead><tr>${sel ? html`<th class="ui-sel" scope="col"><input type="checkbox" data-selall aria-label="${"Select all " + page.length + " on this page"}"${allOn ? raw(" checked") : ""}${!allOn && someOn ? raw(' data-mixed="1"') : ""}></th>` : ""}${cols.map((c) => {
      const sortable = typeof c.sort === "function";
      const on = state.sort.key === c.id;
      const aria = sortable ? (on ? (state.sort.dir === "desc" ? "descending" : "ascending") : "none") : null;
      const cls = "is-p" + (c.priority || 2) + (c.align === "num" ? " is-num" : "") + (c.className ? " " + c.className : "");
      const text = c.labelHidden ? html`<span class="sr-only">${c.label}</span>` : html`${c.label}`;
      return html`<th scope="col" class="${cls}"${aria ? raw(' aria-sort="' + aria + '"') : ""}${c.title ? html` title="${c.title}"` : ""}>${sortable ? html`<button type="button" class="ui-sortbtn${on ? " is-on is-" + state.sort.dir : ""}" data-sort="${c.id}">${text}${SORT_ICON}</button>` : text}</th>`;
    })}</tr></thead>`;
  }

  function rowHtml(r, c) {
    const k = keyOf(r);
    const rid = recId(r);
    const sel = canSelect();
    const name = r.label || r.domain || r.id || "";
    return html`<tr data-key="${k}"${rid ? html` data-rec="${rid}"` : ""}${state.selected.has(k) ? raw(' class="is-selected"') : ""}>${sel ? html`<td class="ui-sel"><input type="checkbox" data-sel="${k}" aria-label="${"Select " + name}"${state.selected.has(k) ? raw(" checked") : ""}></td>` : ""}${cols.map((col) => {
      let cell;
      try { cell = col.cell(r, c); } catch (e) { cell = html`<span class="ui-faint">—</span>`; }
      const cls = "is-p" + (col.priority || 2) + (col.align === "num" ? " is-num" : "") + (col.className ? " " + col.className : "") + " is-c-" + col.id;
      return html`<td class="${cls}" data-label="${col.labelHidden ? "" : col.label}">${cell}</td>`;
    })}</tr>`;
  }

  function emptyHtml() {
    if (typeof empty === "function") {
      const v = empty();
      return v && v.s !== undefined ? v : emptyState(v || {});
    }
    if (empty && empty.s !== undefined) return empty;
    return emptyState(empty || { title: "No " + noun[1] + " match.", body: "Try removing a filter." });
  }

  function isLoading() {
    if (typeof loading === "function") {
      try { return !!loading(); } catch (e) { return false; }
    }
    if (server) return state.loadingMore && !state.fetched.length;
    return !!(store.status && store.status.loading) && store.size() === 0;
  }

  function drawBody() {
    const page = visible();
    byKey.clear();
    for (const r of current()) byKey.set(keyOf(r), r);
    if (!page.length) {
      if (isLoading()) render(bodyEl, skeletonRows(6));
      else if (server && state.fetchError) render(bodyEl, html`<div class="ui-empty" role="alert"><p class="ui-empty-title">${state.fetchError}</p><button type="button" class="ui-btn" data-lretry>Try again</button></div>`);
      else render(bodyEl, emptyHtml());
      return;
    }
    const c = cx();
    render(bodyEl, html`<div class="ui-table-wrap"><table class="ui-table${canSelect() ? " is-selectable" : ""}">${label ? html`<caption class="sr-only">${label}</caption>` : ""}${headHtml()}<tbody>${page.map((r) => rowHtml(r, c))}</tbody></table></div>`);
    const all = bodyEl.querySelector("[data-selall]");
    if (all && all.hasAttribute("data-mixed")) all.indeterminate = true;
  }

  function countText() {
    const n = state.total;
    const words = num(n) + " " + plural(n, noun[0], noun[1]);
    if (server && state.fetched.length < n) return "Showing " + num(state.fetched.length) + " of " + words;
    return words;
  }

  function drawTools() {
    const sortable = cols.filter((c) => typeof c.sort === "function");
    const sortSel = sortable.length
      ? html`<label class="ui-sortsel"><span class="sr-only">Sort by</span><select class="ui-input" data-sortsel>${!state.sort.key || !sortable.some((c) => c.id === state.sort.key) ? html`<option value="">Sort: default</option>` : ""}${sortable.map((c) => html`<option value="${c.id}:asc"${state.sort.key === c.id && state.sort.dir === "asc" ? raw(" selected") : ""}>Sort: ${c.label} ↑</option><option value="${c.id}:desc"${state.sort.key === c.id && state.sort.dir === "desc" ? raw(" selected") : ""}>Sort: ${c.label} ↓</option>`)}</select></label>`
      : "";
    render(toolsEl, html`${sortSel}${csv ? html`<button type="button" class="ui-btn is-sm is-ghost" data-csv><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v11M7 10l5 5 5-5M5 20h14"/></svg>Export CSV</button>` : ""}`);
  }

  function drawPager() {
    if (server) {
      const more = state.fetched.length < state.total;
      render(pagerEl, more ? html`<button type="button" class="ui-btn" data-load${state.loadingMore ? raw(" disabled aria-busy=\"true\"") : ""}>${state.loadingMore ? "Loading…" : "Load more"}</button>` : html``);
      pagerEl.hidden = !more;
      return;
    }
    const pages = pageCount();
    const start = state.total ? (state.page - 1) * state.per + 1 : 0;
    const end = Math.min(state.total, (state.page - 1 + state.pages) * state.per);
    const lastShown = state.page + state.pages - 1;
    const remaining = state.total - end;
    pagerEl.hidden = state.total <= Math.min(50, state.per) && state.per === 50;
    render(pagerEl, html`<span class="ui-pager-info">${num(start)}–${num(end)} of ${num(state.total)}</span>
<span class="ui-pager-nav"><button type="button" class="ui-btn is-sm is-ghost" data-page="prev"${state.page <= 1 ? raw(" disabled") : ""}>Previous</button><span class="ui-pager-page">Page ${num(Math.min(lastShown, pages))} of ${num(pages)}</span><button type="button" class="ui-btn is-sm is-ghost" data-page="next"${lastShown >= pages ? raw(" disabled") : ""}>Next</button></span>
<label class="ui-pager-per"><span>Rows per page</span><select class="ui-input" data-per><option value="50"${state.per === 50 ? raw(" selected") : ""}>50</option><option value="100"${state.per === 100 ? raw(" selected") : ""}>100</option></select></label>
${remaining > 0 ? html`<button type="button" class="ui-btn ui-more-btn" data-more>Show ${num(Math.min(state.per, remaining))} more</button>` : ""}`);
  }

  // ---------- Selection and bulk ----------

  let bulkApi = null;
  function selectedIds() {
    const order = current().map(keyOf);
    return order.filter((k) => state.selected.has(k));
  }
  function drawBulk() {
    if (!canSelect()) {
      bulkEl.hidden = true;
      return;
    }
    const ids = selectedIds();
    if (typeof bulk === "function") {
      if (!bulkApi) {
        bulkApi = bulk(bulkEl, { selected: selectedIds, clear: clearSelection, refresh: () => api.refresh(), list: api }) || null;
      }
      if (bulkApi && typeof bulkApi.update === "function") bulkApi.update(ids);
    } else {
      render(bulkEl, html`<span class="ui-bulk-count">${num(ids.length)} selected</span><button type="button" class="ui-linkbtn" data-selclear>Clear selection</button>`);
    }
    bulkEl.hidden = ids.length === 0;
  }
  function clearSelection() {
    state.selected.clear();
    drawBody();
    drawBulk();
  }

  // ---------- Focus keeping ----------

  const FOCUS_ATTRS = ["data-open", "data-edit", "data-row-act", "data-sel", "data-sort"];
  function rememberFocus() {
    const a = document.activeElement;
    if (!a || !el.contains(a)) return null;
    const row = a.closest("[data-key]");
    const attr = FOCUS_ATTRS.find((x) => a.hasAttribute(x));
    return { key: row ? row.getAttribute("data-key") : null, attr, value: attr ? a.getAttribute(attr) : null, pager: !!a.closest("[data-pager]"), tools: !!a.closest("[data-tools]") };
  }
  function restoreFocus(f) {
    if (!f) return;
    let target = null;
    const esc = (v) => (typeof CSS !== "undefined" && CSS.escape ? CSS.escape(v) : String(v).replace(/"/g, '\\"'));
    if (f.key != null) {
      const row = bodyEl.querySelector('[data-key="' + esc(f.key) + '"]');
      if (row) target = f.attr ? row.querySelector("[" + f.attr + '="' + esc(f.value) + '"]') : row.querySelector("a,button,input");
    } else if (f.attr) {
      target = el.querySelector("[" + f.attr + '="' + esc(f.value) + '"]');
    }
    if (target) target.focus({ preventScroll: true });
  }

  function drawAll() {
    const f = rememberFocus();
    countEl.textContent = countText();
    drawTools();
    drawBody();
    drawPager();
    drawBulk();
    restoreFocus(f);
  }

  function emitState() {
    if (typeof onState === "function") onState({ sort: state.sort.key, dir: state.sort.dir, page: state.page, per: state.per });
  }

  // ---------- Server paging ----------

  async function fetchMore({ reset = false, pages = 1 } = {}) {
    const my = ++state.token;
    state.loadingMore = true;
    state.fetchError = null;
    if (reset) {
      state.fetched = [];
      state.total = 0;
    }
    drawAll();
    try {
      let page = reset ? 1 : Math.floor(state.fetched.length / state.per) + 1;
      const got = reset ? [] : state.fetched.slice();
      let total = state.total;
      for (let i = 0; i < pages; i++) {
        const r = await fetchPage({ page, per: state.per, sort: state.sort.key, dir: state.sort.dir, params: state.params });
        if (my !== state.token) return;
        if (!r) {
          state.fetchError = "Not available yet";
          break;
        }
        got.push(...(r.rows || []));
        total = r.total != null ? Number(r.total) : got.length + ((r.rows || []).length >= state.per ? state.per : 0);
        if (!(r.rows || []).length || got.length >= total) break;
        page++;
      }
      state.fetched = got;
      state.total = Math.max(total, got.length);
    } catch (e) {
      if (my !== state.token) return;
      state.fetchError = (e && (e.friendly || e.message)) || "Couldn't load this list.";
    }
    state.loadingMore = false;
    pruneSelection();
    drawAll();
  }

  // ---------- Events ----------

  function openRow(a, e) {
    const rid = a.getAttribute("data-open");
    if (!rid) return;
    if (e && (e.ctrlKey || e.metaKey || e.shiftKey || e.altKey || e.button === 1)) return; // new tab
    if (typeof openRecord !== "function") return; // the link sets rec; the router opens the panel
    e.preventDefault();
    let queue;
    if (queueLabel) {
      const ids = current().map(recId).filter(Boolean);
      const index = ids.indexOf(rid);
      if (index >= 0) queue = { ids, index, label: queueLabel };
    }
    openRecord(rid, queue ? { queue } : {});
  }

  const offs = [
    on(el, "click", "a[data-open]", (e, a) => openRow(a, e)),
    on(el, "click", "tbody tr", (e, tr) => {
      if (e.target.closest("a,button,input,select,textarea,label,summary,[data-edit],[popover]")) return;
      const sel = typeof window !== "undefined" && window.getSelection ? String(window.getSelection()) : "";
      if (sel) return;
      const a = tr.querySelector("a[data-open]");
      if (a) a.click();
    }),
    on(el, "click", "[data-sort]", (e, b) => {
      const k = b.getAttribute("data-sort");
      if (state.sort.key === k) state.sort.dir = state.sort.dir === "asc" ? "desc" : "asc";
      else {
        const c = cols.find((x) => x.id === k);
        state.sort = { key: k, dir: c && c.align === "num" ? "desc" : "asc" };
      }
      state.page = 1;
      state.pages = 1;
      emitState();
      if (server) fetchMore({ reset: true });
      else {
        computeClient();
        drawAll();
      }
    }),
    on(el, "change", "[data-sortsel]", (e, s) => {
      const [k, dir] = String(s.value || "").split(":");
      state.sort = { key: k || null, dir: dir === "desc" ? "desc" : "asc" };
      state.page = 1;
      state.pages = 1;
      emitState();
      if (server) fetchMore({ reset: true });
      else {
        computeClient();
        drawAll();
      }
    }),
    on(el, "click", "[data-page]", (e, b) => {
      const dir = b.getAttribute("data-page");
      state.page = dir === "prev" ? Math.max(1, state.page - 1) : state.page + state.pages;
      state.pages = 1;
      clampPage();
      emitState();
      drawAll();
      const t = bodyEl.querySelector("table");
      if (t && t.scrollIntoView) t.scrollIntoView({ block: "start" });
    }),
    on(el, "click", "[data-more]", () => {
      state.pages += 1;
      drawAll();
    }),
    on(el, "change", "[data-per]", (e, s) => {
      state.per = Number(s.value) === 100 ? 100 : 50;
      state.page = 1;
      state.pages = 1;
      emitState();
      drawAll();
    }),
    on(el, "click", "[data-load]", () => fetchMore()),
    on(el, "click", "[data-lretry]", () => fetchMore({ reset: true })),
    on(el, "change", "[data-sel]", (e, box) => {
      const k = box.getAttribute("data-sel");
      if (box.checked) state.selected.add(k);
      else state.selected.delete(k);
      const tr = box.closest("tr");
      if (tr) tr.classList.toggle("is-selected", box.checked);
      const all = bodyEl.querySelector("[data-selall]");
      if (all) {
        const page = visible();
        const n = page.filter((r) => state.selected.has(keyOf(r))).length;
        all.checked = n === page.length && n > 0;
        all.indeterminate = n > 0 && n < page.length;
      }
      drawBulk();
    }),
    on(el, "change", "[data-selall]", (e, box) => {
      for (const r of visible()) {
        if (box.checked) state.selected.add(keyOf(r));
        else state.selected.delete(keyOf(r));
      }
      const f = rememberFocus();
      drawBody();
      drawBulk();
      restoreFocus(f || { key: null, attr: "data-selall", value: "" });
      const again = bodyEl.querySelector("[data-selall]");
      if (again && document.activeElement !== again) again.focus({ preventScroll: true });
    }),
    on(el, "click", "[data-selclear]", () => clearSelection()),
    on(el, "click", "[data-csv]", () => api.exportCsv()),
    bindInlineEdits(el, { getRecord: (k) => byKey.get(String(k)) || null, onFilter }),
  ];

  const api = {
    // Re-reads the rows (or re-fetches the loaded pages) and redraws, keeping sort, page, selection,
    // scroll and focus. next: {params} for server lists, {sort, dir} to change the sort.
    refresh(next = {}) {
      if (next.sort !== undefined) state.sort = parseSort(next.dir === "desc" ? "-" + next.sort : next.sort);
      if (next.params) state.params = next.params;
      if (next.page != null) {
        state.page = Number(next.page) || 1;
        state.pages = 1;
      }
      if (server) {
        const pages = Math.max(1, Math.ceil(state.fetched.length / state.per));
        return fetchMore({ reset: true, pages: next.params ? 1 : pages });
      }
      computeClient();
      clampPage();
      pruneSelection();
      drawAll();
      return Promise.resolve();
    },
    selected() {
      return selectedIds();
    },
    clearSelection,
    // The rows a CSV export or a queue would use: every filtered row, sorted (all fetched pages).
    rows() {
      return current().slice();
    },
    exportCsv({ only } = {}) {
      const all = current();
      const pick = only ? all.filter((r) => only.includes(keyOf(r))) : all;
      const set = csvColumns ? csvColumns.map(resolveColumn).filter(Boolean) : cols;
      const text = toCsv(pick, csvColumnsOf(set, cx()));
      downloadText(csvFileName(csvName || id), text, el);
      return text;
    },
    destroy() {
      state.token++;
      for (const off of offs) off();
      if (bulkApi && typeof bulkApi.destroy === "function") bulkApi.destroy();
      render(root, html``);
    },
  };

  if (server) fetchMore({ reset: true });
  else {
    computeClient();
    drawAll();
  }
  return api;
}
