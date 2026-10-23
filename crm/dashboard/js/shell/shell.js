// App shell (spec 2.1, 4.11, 4.12, 4.13, 4.14). Owner G1-A.
// Sidebar (>= 1024 px) or top bar + bottom tabs + More sheet (< 1024 px), built from app.js NAV;
// the footer (name, sync line, freshness, Refresh, Google Sheet, Sign out); the banners (read-only,
// new build, load errors, the morning copy); the polite announcer. This module and keys.js are the
// only ones with global listeners (spec 5.1): hashchange (-> router.sync), focus/visibility
// revalidation, beforeunload (dirty record panel) and the uncaught-error toast.
import { html, raw, render, $, $$, copyText } from "../core/dom.js";
import * as router from "../core/router.js";
import * as store from "../core/store.js";
import * as meta from "../core/meta.js";
import * as me from "../core/me.js";
import * as bus from "../core/bus.js";
import * as prefs from "../core/prefs.js";
import * as cache from "../core/cache.js";
import { api, pendingWrites } from "../core/api.js";
import { date, num, plural, todayIso, toDay, daysBetween, zonedParts, lastRunAt, nextRunAt } from "../core/format.js";
import { openMePicker } from "./me-picker.js";
import { isDirty } from "../features/record/index.js";
import { toast } from "../ui/toast.js";
import { trapFocus } from "../ui/dialog.js";

const I = {
  today: '<path d="M9 11l3 3 8-8"/><path d="M20 12v7a2 2 0 01-2 2H6a2 2 0 01-2-2V5a2 2 0 012-2h9"/>',
  sites: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 010 18M12 3a14 14 0 000 18"/>',
  deals: '<rect x="3" y="4" width="5" height="16" rx="1"/><rect x="10" y="4" width="5" height="11" rx="1"/><rect x="17" y="4" width="4" height="7" rx="1"/>',
  clients: '<path d="M4 21V7l8-4 8 4v14"/><path d="M9 21v-6h6v6"/>',
  team: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0113 0"/><circle cx="17" cy="9" r="2.5"/><path d="M16 14.2a5 5 0 016 4.8"/>',
  help: '<circle cx="12" cy="12" r="9"/><path d="M9.6 9.3a2.5 2.5 0 014.9.7c0 1.7-2.5 2.2-2.5 3.8"/><path d="M12 17.2h.01"/>',
  history: '<path d="M12 8v4l3 2"/><circle cx="12" cy="12" r="9"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="M21 21l-5-5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  more: '<circle cx="5" cy="12" r="1.2"/><circle cx="12" cy="12" r="1.2"/><circle cx="19" cy="12" r="1.2"/>',
  refresh: '<path d="M20 12a8 8 0 11-2.34-5.66"/><path d="M20 4v5h-5"/>',
  sheet: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M3 15h18M9 3v18"/>',
  out: '<path d="M15 4h4a1 1 0 011 1v14a1 1 0 01-1 1h-4"/><path d="M10 17l5-5-5-5"/><path d="M15 12H3"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  records: '<path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z"/>',
  partners: '<path d="M8 12l3 3 6-6"/><path d="M12 21a9 9 0 100-18 9 9 0 000 18z"/>',
  contacts: '<rect x="4" y="3" width="16" height="18" rx="2"/><circle cx="12" cy="10" r="3"/><path d="M7.5 17.5a5 5 0 019 0"/>',
  chev: '<path d="M9 6l6 6-6 6"/>',
};
const MARK = '<svg viewBox="0 0 24 24" aria-hidden="true" class="sh-mark-svg"><circle cx="6" cy="12" r="3"/><circle cx="18" cy="6" r="3"/><circle cx="18" cy="18" r="3"/><path d="M8.6 10.6l6.8-3.2M8.6 13.4l6.8 3.2"/></svg>';

const icon = (name) => raw('<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">' + (I[name] || "") + "</svg>");

let app = null;
let main = null;
let navItems = [];
let ctxFn = () => ({});
let handlers = {};
let badgeQueued = false;
let pendingTimer = null;
let lastErr = null;
let lastErrToast = 0;
let announceTimer = null;

const TEST_TIP = "Outreach is in test mode. Nothing is sent from this site.";
const MORE_PAGES = new Set();
// The sidebar's Records group (Partners, Contacts; Tomas, 2026-10-23): a <details> that opens on its own
// pages and otherwise remembers whether it was left open.
const GROUP_KEY = "pgcrm-nav-records";

// The nav item a page belongs to: its own, or the one whose `also` lists it (#contact/… → Contacts).
function navOf(page) {
  return navItems.find((n) => n.id === page) || navItems.find((n) => Array.isArray(n.also) && n.also.includes(page)) || null;
}

// ---------- Footer ----------

function nextRunWords(nowMs) {
  const m = meta.get();
  const tz = m.timezone || "Europe/Vilnius";
  const hhmm = meta.runTime(m);
  const next = nextRunAt(nowMs, tz, hhmm);
  if (!isFinite(next)) return "on the next weekday morning (" + hhmm + ")";
  const d = daysBetween(zonedParts(nowMs, tz).day, zonedParts(next, tz).day);
  const day = d === 0 ? "today" : d === 1 ? "tomorrow" : "on " + date(zonedParts(next, tz).day, "long").split(" ")[0];
  return day + " at " + hhmm;
}

export function syncText(nowMs = Date.now()) {
  if (pendingWrites() > 0) return "Saving…";
  const n = store.status.pending;
  if (n == null) return "All saved";
  if (n === 0) return "All saved · nothing waiting for the Google Sheet";
  return "All saved · " + num(n) + " " + plural(n, "change") + " copy to the Google Sheet " + nextRunWords(nowMs);
}

// {text, warn, title} for the footer freshness line, or null when meta has no freshness yet.
export function freshnessLine(nowMs = Date.now()) {
  const m = meta.get();
  const f = m.freshness;
  if (!f || typeof f !== "object") return null;
  const tz = m.timezone || "Europe/Vilnius";
  const src = (f.last_run && f.last_run.finished_at) || f.last_sheet_change || null;
  const z = zonedParts(nowMs, tz);
  const srcMs = src ? Date.parse(src) : NaN;
  const seenToday = isFinite(srcMs) && zonedParts(srcMs, tz).day === z.day;
  const weekday = z.wd >= 1 && z.wd <= 5;
  const old = src ? daysBetween(toDay(src), todayIso(new Date(nowMs))) : null;
  const when = src ? (old != null && old > 6 ? date(src, "datetime") : date(src, "weekdayTime")) : "";
  if (weekday && z.hh >= 10 && !seenToday) {
    return { text: "No sheet update seen yet today", warn: true, title: when ? "Sheet data from " + when : "" };
  }
  return src ? { text: "Sheet data from " + when, warn: false, title: "" } : null;
}

function footHtml() {
  const name = me.get();
  const m = meta.get();
  const fresh = freshnessLine();
  const busy = store.status.loading;
  return html`<div class="sh-me">${name
    ? html`Signed in as <b>${name}</b> · <button type="button" class="sh-link" data-act="me">change</button>`
    : html`Signed in · <button type="button" class="sh-link" data-act="me">pick your name</button>`}</div>
<a class="sh-sync" href="${router.href("history")}" data-sync>${syncText()}</a>
${fresh ? html`<p class="sh-fresh${fresh.warn ? " is-warn" : ""}" title="${fresh.title}" data-fresh>${fresh.text}</p>` : ""}
<div class="sh-foot-acts">
<button type="button" class="sh-link" data-act="refresh" ${busy ? raw("aria-busy=\"true\"") : ""}>${icon("refresh")}<span>${busy ? "Refreshing…" : "Refresh"}</span></button>
${m.sheet_url ? html`<a class="sh-link" href="${m.sheet_url}" target="_blank" rel="noopener">${icon("sheet")}<span>Google Sheet ↗</span></a>` : ""}
<a class="sh-link" href="/logout" data-act="signout">${icon("out")}<span>Sign out</span></a>
</div>`;
}

function renderFooters() {
  if (!app) return;
  for (const el of $$("[data-foot]", app)) render(el, footHtml());
}

function updateSyncLine() {
  if (!app) return;
  for (const el of $$("[data-sync]", app)) el.textContent = syncText();
}

// After writes settle, re-read the waiting count from /api/meta freshness.pending. (GET /api/edits'
// `pending` also counts the "not copied" conflict edits, which never copy.)
function refreshPending(delay = 1500) {
  if (meta.get().read_only) return;
  clearTimeout(pendingTimer);
  pendingTimer = setTimeout(async () => {
    try {
      const r = await api.meta();
      const f = r && r.freshness;
      if (f && f.pending != null) store.setPending(f.pending);
    } catch (e) { /* the footer keeps its last count */ }
  }, delay);
}

// ---------- Banners ----------

// The amber "didn't pick up N changes" banner (spec 4.11): now >= the last weekday run + 2 h and a
// waiting edit is older than that run, or the latest daily run ended with an error. freshness counts
// only waiting edits (not the "not copied" conflicts); N is stale_pending, the waiting edits older than
// stale_before. A freshness read before this run (stale_before earlier) counted only older edits: N = pending.
export function morningCopyBanner(nowMs = Date.now()) {
  const m = meta.get();
  const f = m.freshness;
  if (!f || typeof f !== "object") return null;
  if (f.last_run && f.last_run.status === "error") {
    return "This morning's copy to the Google Sheet stopped with an error. Your changes are saved here. If this is still showing tomorrow, tell Jonas.";
  }
  const run = lastRunAt(nowMs, m.timezone || "Europe/Vilnius", meta.runTime(m));
  if (!isFinite(run) || nowMs < run + 2 * 3600000) return null;
  const oldest = f.oldest_pending_at ? Date.parse(f.oldest_pending_at) : NaN;
  if (!(oldest < run)) return null;
  const before = f.stale_before ? Date.parse(f.stale_before) : NaN;
  const n = Number(f.stale_pending != null && before >= run ? f.stale_pending : f.pending) || 0;
  if (n <= 0) return null;
  return "This morning's copy to the Google Sheet didn't pick up " + num(n) + " " + plural(n, "change") +
    ". They're saved here. If this is still showing tomorrow, tell Jonas.";
}

function shownAt(iso) {
  if (!iso) return "";
  return toDay(iso) === todayIso() ? date(iso, "time") || date(iso) : date(iso, "datetime");
}

function bannersHtml() {
  const m = meta.get();
  const st = store.status;
  const out = [];
  if (m.read_only) {
    const when = shownAt(st.loadedAt);
    out.push(html`<div class="sh-banner is-info" role="status" data-banner="readonly">Read-only copy${when ? " · data from " + when : ""}</div>`);
  }
  const build = typeof window !== "undefined" ? window.BUILD : null;
  if (m.build && build && m.build !== build) {
    out.push(html`<div class="sh-banner is-info" role="status" data-banner="build">A new version is ready · <button type="button" class="sh-bbtn" data-act="reload">Reload</button></div>`);
  }
  if (st.error) {
    if (store.size() > 0) {
      const when = shownAt(st.loadedAt);
      out.push(html`<div class="sh-banner is-warn" role="alert" data-banner="refresh">Couldn't refresh.${when ? " Showing data from " + when + "." : ""} <button type="button" class="sh-bbtn" data-act="retry">Retry</button></div>`);
    } else {
      out.push(html`<div class="sh-banner is-error" role="alert" data-banner="load">Couldn't load the site list. <button type="button" class="sh-bbtn" data-act="retry">Retry</button>${m.sheet_url ? html` <a class="sh-bbtn" href="${m.sheet_url}" target="_blank" rel="noopener">Open the Google Sheet</a>` : ""}</div>`);
    }
  }
  const morning = morningCopyBanner();
  if (morning && prefs.get("pgcrm-dismiss-fresh") !== todayIso()) {
    out.push(html`<div class="sh-banner is-warn" role="status" data-banner="fresh"><span>${morning}</span><button type="button" class="sh-x" data-act="dismiss-fresh" aria-label="Dismiss for today">${icon("close")}</button></div>`);
  }
  return out;
}

function renderBanners() {
  const el = app && $("[data-banners]", app);
  if (!el) return;
  render(el, html`${bannersHtml()}`);
  el.hidden = !el.firstElementChild;
}

// ---------- Nav ----------

function navLink(n, cls) {
  const h = router.href(n.id, n.params || {});
  return html`<a class="${cls}" href="${h}" data-nav="${n.id}">${icon(n.icon || n.id)}<span class="sh-label">${n.label}</span>${typeof n.badge === "function" ? html`<span class="sh-badge" data-badge="${n.id}" aria-hidden="true" hidden></span>` : ""}</a>`;
}

function shellHtml() {
  const sorted = navItems.slice().sort((a, b) => (a.order || 0) - (b.order || 0));
  const mainItems = sorted.filter((n) => n.group === "main");
  const recordItems = sorted.filter((n) => n.group === "records");
  const moreItems = sorted.filter((n) => n.group === "more");
  const tabItems = sorted.filter((n) => n.tab);
  const sheetItems = sorted.filter((n) => !n.tab);
  const m = meta.get();
  const test = m.test_mode !== false;
  return html`<a class="sh-skip" href="#main" data-act="skip">Skip to main content</a>
<aside class="sh-side" aria-label="CRM sections">
  <div class="sh-brand"><span class="sh-mark">${raw(MARK)}</span><span>PartnerGap CRM</span></div>
  <nav class="sh-nav" aria-label="Main">${mainItems.map((n) => navLink(n, "sh-nav-a"))}${recordItems.length ? groupHtml(recordItems) : ""}<div class="sh-sep" role="presentation"></div>${moreItems.map((n) => navLink(n, "sh-nav-a"))}</nav>
  <div class="sh-foot" data-foot="side"></div>
</aside>
<div class="sh-main">
  <header class="sh-top">
    <span class="sh-glyph" aria-hidden="true">${raw(MARK)}</span>
    <span class="sh-title" data-title></span>
    <button type="button" class="sh-search" data-act="search" aria-label="Search or paste a link (Ctrl K)" aria-keyshortcuts="Control+K Meta+K /">${icon("search")}<span class="sh-search-text">Search or paste a link…</span><kbd class="sh-kbd">Ctrl K</kbd></button>
    ${test ? html`<span class="sh-test" tabindex="0" title="${TEST_TIP}" aria-label="Test mode. ${TEST_TIP}"><span aria-hidden="true">●</span> Test<span class="sh-test-more"> mode</span></span>` : ""}
    <button type="button" class="sh-add" data-act="add" data-write aria-label="Add site">${icon("plus")}<span class="sh-add-text">Add site</span></button>
  </header>
  <div class="sh-banners" data-banners hidden></div>
  <main id="main" class="sh-content" tabindex="-1" aria-busy="false"></main>
</div>
<nav class="sh-tabs" aria-label="Main">${tabItems.map((n) => navLink(n, "sh-tab"))}<button type="button" class="sh-tab" data-act="search" aria-label="Search">${icon("search")}<span class="sh-label">Search</span></button><button type="button" class="sh-tab" data-act="more" data-more aria-haspopup="dialog">${icon("more")}<span class="sh-label">More</span></button></nav>
<dialog class="sh-more" aria-labelledby="sh-more-h">
  <div class="sh-more-head"><h2 id="sh-more-h">More</h2><button type="button" class="sh-x" data-act="close-more" aria-label="Close">${icon("close")}</button></div>
  <nav class="sh-more-nav" aria-label="More pages">${sheetItems.map((n) => navLink(n, "sh-more-a"))}</nav>
  <div class="sh-foot" data-foot="more"></div>
</dialog>
<div class="sr-only" aria-live="polite" aria-atomic="true" data-announce></div>`;
}

function groupHtml(items) {
  const here = navOf(router.current().page);
  const open = (here && here.group === "records") || prefs.get(GROUP_KEY) === "1";
  return html`<details class="sh-group" data-sh-group${open ? raw(" open") : ""}><summary class="sh-nav-a sh-group-h">${icon("records")}<span class="sh-label">Records</span><span class="sh-chev">${icon("chev")}</span></summary><div class="sh-group-items">${items.map((n) => navLink(n, "sh-nav-a sh-sub-a"))}</div></details>`;
}

function setActive(route) {
  if (!app) return;
  const n = navOf(route.page);
  const id = n ? n.id : route.page;
  for (const a of $$("[data-nav]", app)) {
    if (a.getAttribute("data-nav") === id) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  }
  const group = $("[data-sh-group]", app);
  if (group && n && n.group === "records" && !group.open) group.open = true;
  const more = $("[data-more]", app);
  if (more) more.classList.toggle("is-on", MORE_PAGES.has(id));
}

// The Records group remembers being left open or closed ("toggle" doesn't bubble, so this listens in capture).
function onToggle(e) {
  const d = e.target;
  if (d && d.matches && d.matches("[data-sh-group]")) prefs.set(GROUP_KEY, d.open ? "1" : "0");
}

function updateBadges() {
  badgeQueued = false;
  if (!app) return;
  let c = null;
  for (const n of navItems) {
    if (typeof n.badge !== "function") continue;
    let v = null;
    try {
      c = c || ctxFn();
      v = n.badge(c);
    } catch (e) {
      v = null;
    }
    const count = Number(v) || 0;
    for (const el of $$('[data-badge="' + n.id + '"]', app)) {
      el.textContent = count <= 0 ? "" : count > 99 ? "99+" : String(count);
      el.hidden = count <= 0;
      const link = el.closest("a");
      if (link) {
        if (count > 0) link.setAttribute("aria-label", n.label + ", " + count + " to do now");
        else link.removeAttribute("aria-label");
      }
    }
  }
}

function queueBadges() {
  if (badgeQueued) return;
  badgeQueued = true;
  (typeof requestAnimationFrame === "function" ? requestAnimationFrame : (f) => setTimeout(f, 16))(updateBadges);
}

function setBusy() {
  if (main) main.setAttribute("aria-busy", String(!!store.status.loading && store.size() === 0));
}

// ---------- Actions ----------

const trapped = new WeakSet(); // More sheets whose Tab and Shift+Tab cycle inside, as in every other dialog

function openMore() {
  const d = app && $(".sh-more", app);
  if (!d || d.open) return;
  renderFooters();
  d.showModal();
  if (!trapped.has(d)) {
    trapped.add(d);
    trapFocus(d);
  }
  // Toasts stay above dialogs (spec 4.9): put the toast popover back on top.
  const t = document.getElementById("toasts");
  try {
    if (t && t.matches(":popover-open")) { t.hidePopover(); t.showPopover(); }
  } catch (e) { /* no Popover API */ }
}

function closeMore() {
  const d = app && $(".sh-more", app);
  if (d && d.open) d.close();
}

async function changeMe(anchor) {
  try {
    const picked = await openMePicker(anchor);
    if (typeof picked === "string" && picked && picked !== me.get()) me.set(picked);
  } catch (e) { /* picker closed */ }
}

export async function refreshAll() {
  const jobs = [store.refresh(), meta.refresh().then(() => store.setPending(
    meta.get().freshness && meta.get().freshness.pending != null ? meta.get().freshness.pending : store.status.pending))];
  renderFooters();
  await Promise.allSettled(jobs);
  renderAll();
}

function onClick(e) {
  const el = e.target.closest("[data-act]");
  if (el && app.contains(el)) {
    const act = el.getAttribute("data-act");
    switch (act) {
      case "skip":
        e.preventDefault();
        if (main) main.focus();
        return;
      case "search":
        closeMore();
        if (handlers.onSearch) handlers.onSearch();
        return;
      case "add":
        closeMore();
        if (handlers.onAddSite && !meta.get().read_only) handlers.onAddSite();
        return;
      case "more":
        openMore();
        return;
      case "close-more":
        closeMore();
        return;
      case "me":
        changeMe(el);
        return;
      case "refresh":
        refreshAll();
        return;
      case "retry":
        store.refresh({ full: store.size() === 0 });
        return;
      case "reload":
        location.reload();
        return;
      case "dismiss-fresh":
        prefs.set("pgcrm-dismiss-fresh", todayIso());
        renderBanners();
        return;
      case "signout":
        e.preventDefault();
        cache.clear().finally(() => location.assign("/logout"));
        return;
      default:
        return;
    }
  }
  // Links in the More sheet close it; clicks on its backdrop too.
  const more = e.target.closest(".sh-more");
  if (more && (e.target === more || e.target.closest("a[href^='#']"))) closeMore();
}

// ---------- Global listeners (spec 5.1: only here and in keys.js) ----------

function safeDirty() {
  try { return !!isDirty(); } catch (e) { return false; }
}

function revalidate() {
  if (document.visibilityState === "hidden") return;
  if (!store.shouldRevalidate()) return;
  store.refresh();
  meta.refresh().then(() => renderAll());
  refreshPending(0);
}

export function errorDetails() {
  const e = lastErr;
  return [
    "PartnerGap CRM",
    "Build: " + (typeof window !== "undefined" ? window.BUILD : ""),
    "Server build: " + (meta.get().build || ""),
    "Page: " + location.hash,
    "Browser: " + navigator.userAgent,
    "When: " + new Date().toISOString(),
    e ? "Error: " + e.message + (e.stack ? "\n" + e.stack : "") : "Error: none recorded",
  ].join("\n");
}

// The last uncaught error, for Help's "Report a problem".
export function lastError() {
  return lastErr;
}

function reportError(err) {
  if (!err) return;
  if (err.status === 401 || err.name === "AbortError") return;
  const message = String((err && err.message) || err);
  if (/ResizeObserver loop/.test(message)) return;
  lastErr = { message, stack: err && err.stack ? String(err.stack) : "", at: new Date().toISOString() };
  const now = Date.now();
  if (now - lastErrToast < 5000) return;
  lastErrToast = now;
  try {
    toast("Something went wrong.", { kind: "error", sticky: true, action: { label: "Copy details", fn: () => copyText(errorDetails()) } });
  } catch (e) { /* toast not ready */ }
}

let globalsOn = false;
function listenGlobally() {
  if (globalsOn) return;
  globalsOn = true;
  window.addEventListener("hashchange", () => router.sync());
  window.addEventListener("focus", revalidate);
  document.addEventListener("visibilitychange", revalidate);
  window.addEventListener("beforeunload", (e) => {
    if (safeDirty()) {
      e.preventDefault();
      e.returnValue = "";
    }
  });
  window.addEventListener("error", (e) => reportError(e.error || { message: e.message }));
  window.addEventListener("unhandledrejection", (e) => reportError(e.reason));
}

// ---------- Public ----------

function renderAll() {
  renderFooters();
  renderBanners();
  queueBadges();
  setBusy();
}

// The compact top bar title (app.js sets it on every page change).
export function setTitle(text) {
  const el = app && $("[data-title]", app);
  if (el) el.textContent = text || "";
}

// A polite screen-reader announcement ("Sites, 36 sites").
export function announce(text) {
  const el = app && $("[data-announce]", app);
  if (!el) return;
  clearTimeout(announceTimer);
  el.textContent = "";
  announceTimer = setTimeout(() => { el.textContent = text || ""; }, 60);
}

// Re-reads every badge (app.js calls it after store, meta and name changes).
export function refreshBadges() {
  queueBadges();
}

// nav: app.js NAV; ctx(): the current page context (for NAV badges);
// onSearch(), onAddSite(): the top bar and tab actions. Returns <main id="main">.
export function mount({ nav = [], ctx, onSearch, onAddSite } = {}) {
  app = document.querySelector(".app");
  if (!app) return null;
  navItems = nav.slice();
  ctxFn = typeof ctx === "function" ? ctx : () => ({});
  handlers = { onSearch, onAddSite };
  MORE_PAGES.clear();
  for (const n of navItems) if (!n.tab) MORE_PAGES.add(n.id);
  render(app, shellHtml());
  main = $("#main", app);
  app.addEventListener("click", onClick);
  app.addEventListener("toggle", onToggle, true);
  router.onChange((route) => setActive(route));
  store.subscribe(() => { queueBadges(); setBusy(); });
  bus.on("store:status", () => { renderBanners(); renderFooters(); setBusy(); });
  bus.on("meta", () => renderAll());
  bus.on("me", () => { renderFooters(); queueBadges(); });
  bus.on("api:writes", (n) => {
    updateSyncLine();
    if (n === 0) refreshPending();
  });
  listenGlobally();
  renderAll();
  return main;
}
