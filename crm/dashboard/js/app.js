// Entry module: boot (spec 5.3), the static NAV registry and the page registry. Owner G1-A.
// Every page is imported statically (no lazy loading, spec 5.1).
//
// Page update(ctx, change) receives one of:
//   {kind:'route', route, prev}   same page and sub, other params (rec-only changes are skipped)
//   {kind:'store', reason, ids?}  a store notification ('load'|'refresh'|'edit'|'bulk')
//   {kind:'meta'}  {kind:'me'}    /api/meta was re-read, or the person changed
// ctx.announce(text) makes a polite screen-reader announcement (spec 4.13, "Sites, 36 sites"). Called
// during mount(), it replaces the page-title announcement of the route change; later calls announce at once.
import * as meta from "./core/meta.js";
import * as me from "./core/me.js";
import * as store from "./core/store.js";
import * as router from "./core/router.js";
import * as keys from "./core/keys.js";
import * as bus from "./core/bus.js";
import { api } from "./core/api.js";
import { todayIso } from "./core/format.js";
import * as shell from "./shell/shell.js";
import { openMePicker } from "./shell/me-picker.js";
import * as actions from "./ui/actions.js";
import * as toastUi from "./ui/toast.js";
import * as dialogUi from "./ui/dialog.js";
import * as menuUi from "./ui/menu.js";
import * as pillsUi from "./ui/pills.js";
import * as listUi from "./ui/list.js";
import * as filtersUi from "./ui/filters.js";
import * as emptyUi from "./ui/empty.js";
import * as skeletonUi from "./ui/skeleton.js";
import * as chartsUi from "./ui/charts.js";
import * as inlineEditUi from "./ui/inline-edit.js";
import * as columnsUi from "./ui/columns.js";
import * as record from "./features/record/index.js";
import * as search from "./features/search.js";
import { openAddSite } from "./features/add-site.js";
import { doNowCount } from "./rules/today.js";
import todayPage from "./pages/today.js";
import sitesPage from "./pages/sites.js";
import dealsPage from "./pages/deals.js";
import clientsPage from "./pages/clients.js";
import teamPage from "./pages/team.js";
import historyPage from "./pages/history.js";
import helpPage from "./pages/help.js";

// Nav metadata lives only here (spec 5.4). badge(ctx) returns a number or null.
// group: 'main' and 'more' are in the sidebar (a divider between them); 'hidden' pages are reached
// from the footer sync line, and on compact screens from More. tab: a bottom tab on compact screens;
// every other page is listed in the More sheet. params: the nav link's params (2.4: Sites opens Mine).
export const NAV = [
  {
    id: "today", label: "Today", icon: "today", group: "main", order: 1, tab: true,
    badge: (ctx) => doNowCount(ctx.store.all(), { meta: ctx.meta, today: ctx.today, me: ctx.me.get() }),
  },
  { id: "sites", label: "Sites", icon: "sites", group: "main", order: 2, tab: true, params: { tab: "mine" } },
  { id: "deals", label: "Deals", icon: "deals", group: "main", order: 3, tab: true },
  { id: "clients", label: "Clients", icon: "clients", group: "main", order: 4 },
  { id: "team", label: "Team overview", icon: "team", group: "more", order: 5 },
  { id: "help", label: "Help", icon: "help", group: "more", order: 6 },
  { id: "history", label: "Edit history", icon: "history", group: "hidden", order: 7 },
];

// The first page is the fallback when no home page is known.
export const PAGES = [todayPage, sitesPage, dealsPage, clientsPage, teamPage, historyPage, helpPage];

const NOT_FOUND = "That site wasn't found (it may have been renamed after the morning copy)";

let ui = null;
let main = null;
let active = null; // {page, root, sub}
let mounting = null; // {text} while a page mounts: what it passed to ctx.announce()

function announce(text) {
  if (mounting) mounting.text = text == null ? "" : String(text);
  else shell.announce(text);
}

function uiKit() {
  return Object.assign({}, toastUi, dialogUi, menuUi, pillsUi, listUi, filtersUi, emptyUi, skeletonUi, chartsUi,
    inlineEditUi, columnsUi);
}

export function makeCtx(route = router.current()) {
  return {
    route,
    setParams: router.setParams,
    go: router.go,
    href: router.href,
    store,
    me,
    meta: meta.get(),
    api,
    actions,
    ui: ui || (ui = uiKit()),
    openRecord: record.openRecord,
    today: todayIso(),
    announce,
  };
}

// A page error must not take the shell down: show a short note and let the global handler toast it.
function pageFailed(root, err) {
  if (typeof console !== "undefined") console.error(err);
  if (root && !root.firstChild) {
    root.innerHTML = '<h1 tabindex="-1">Something went wrong</h1><p>This page couldn\'t be shown. ' +
      'Reload the page to try again.</p>';
  }
  setTimeout(() => { throw err; }, 0);
}

function pageFor(id) {
  return PAGES.find((p) => p.id === id) || PAGES[0];
}

function updateActive(change) {
  if (!active) return;
  try {
    active.page.update(makeCtx(), change);
  } catch (err) {
    pageFailed(active.root, err);
  }
}

function sameExceptRec(a, b) {
  const pa = Object.assign({}, a.params);
  const pb = Object.assign({}, b.params);
  delete pa.rec;
  delete pb.rec;
  return router.href(a.page, pa, a.sub) === router.href(b.page, pb, b.sub);
}

function show(route, prev) {
  const page = pageFor(route.page);
  const ctx = makeCtx(route);
  if (active && active.page === page && active.sub === route.sub) {
    if (prev && sameExceptRec(route, prev)) return; // only the record panel changed
    try {
      page.update(ctx, { kind: "route", route, prev });
    } catch (err) {
      pageFailed(active.root, err);
    }
    return;
  }
  if (active) {
    try { active.page.unmount(); } catch (err) { if (typeof console !== "undefined") console.error(err); }
  }
  const root = document.createElement("div");
  root.className = "page";
  root.setAttribute("data-page", page.id);
  main.replaceChildren(root);
  if (typeof window !== "undefined" && window.scrollTo) window.scrollTo(0, 0);
  active = { page, root, sub: route.sub };
  const said = (mounting = { text: null });
  try {
    page.mount(root, ctx);
  } catch (err) {
    pageFailed(root, err);
  } finally {
    mounting = null;
  }
  let title = "";
  try { title = page.title(ctx) || ""; } catch (err) { title = ""; }
  document.title = (title ? title + " · " : "") + "PartnerGap CRM";
  shell.setTitle(title);
  // Spec 4.13: on a route change the page h1 gets focus and a polite announcement: the page's own
  // (ctx.announce during mount, "Sites, 36 sites"), else its title.
  if (prev && prev.page) {
    const h1 = root.querySelector("h1");
    if (h1) {
      if (!h1.hasAttribute("tabindex")) h1.setAttribute("tabindex", "-1");
      h1.focus({ preventScroll: true });
    }
    shell.announce(said.text || title);
  } else if (said.text) {
    shell.announce(said.text);
  }
}

// Spec 2.4: an unknown rec id shows a toast and drops the param (once the list has loaded).
let recCheck = 0;
async function checkRec(id) {
  const my = ++recCheck;
  if (!store.get(id)) await store.whenLoaded();
  if (my !== recCheck) return;
  if (router.current().params.rec !== id || store.get(id)) return;
  if (store.size() === 0) return; // the list didn't load; the shell's banner says so
  toastUi.toast(NOT_FOUND, { kind: "error" });
  router.setParams({ rec: null }, { replace: true });
}

function setReadOnly() {
  if (meta.get().read_only) document.documentElement.setAttribute("data-readonly", "");
  else document.documentElement.removeAttribute("data-readonly");
}

function onEscape() {
  let open = null;
  try { open = record.currentRecordId(); } catch (e) { open = null; }
  if (open) record.closeRecord();
}

function addSite() {
  if (!meta.get().read_only) openAddSite();
}

async function boot() {
  await meta.load();
  me.init();
  setReadOnly(); // spec 5.3 step 3: writes are disabled before the first render
  me.setAsker(() => openMePicker(null));
  store.setBusy(() => {
    let busy = false;
    try { busy = !!menuUi.isBusy(); } catch (e) { busy = false; }
    try { busy = busy || !!record.isDirty(); } catch (e) { /* no panel yet */ }
    return busy;
  });
  await store.load();
  main = shell.mount({ nav: NAV, ctx: () => makeCtx(), onSearch: () => search.openSearch(), onAddSite: addSite });
  if (!main) return;

  router.onChange((route, prev) => {
    show(route, prev);
    const rec = route.params.rec;
    if (rec && rec !== (prev && prev.params ? prev.params.rec : undefined)) checkRec(rec);
  });
  store.subscribe((n) => updateActive({ kind: "store", reason: n && n.reason, ids: n && n.ids }));
  bus.on("meta", () => {
    setReadOnly();
    router.setHome(me.home(meta.get()));
    updateActive({ kind: "meta" });
  });
  bus.on("me", () => {
    router.setHome(me.home(meta.get()));
    updateActive({ kind: "me" });
    shell.refreshBadges();
  });
  // The record panel opens and closes only from router.onChange (spec 4.2). If it exports start(),
  // it subscribes here: after the page listener, so a reload with rec mounts the page, then the panel.
  if (typeof record.start === "function") record.start(makeCtx);

  router.start(PAGES, { home: me.home(meta.get()) });
  // Search's "Recently opened" list records every site the panel opens from boot on. start() is an extra
  // export beyond spec 5.4, so a search module without it (such as 00-smoke's stub) still boots.
  if (typeof search.start === "function") search.start();
  keys.start({
    search: () => search.openSearch(),
    addSite,
    escape: onEscape,
    queue: (dir) => bus.emit("queue", { dir }),
    open: (id) => record.openRecord(id),
  });
}

boot().catch((err) => {
  if (typeof console !== "undefined") console.error(err);
  toastUi.toast("Something went wrong.", { kind: "error", sticky: true });
});
