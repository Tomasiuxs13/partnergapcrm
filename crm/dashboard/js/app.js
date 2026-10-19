// Entry module: boot (spec 5.3), the static NAV registry and the page registry.
// G0 stub; owner G1-A. Every page is imported statically (no lazy loading, spec 5.1).
import * as meta from "./core/meta.js";
import * as me from "./core/me.js";
import * as store from "./core/store.js";
import * as router from "./core/router.js";
import * as keys from "./core/keys.js";
import { api } from "./core/api.js";
import { todayIso } from "./core/format.js";
import * as shell from "./shell/shell.js";
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
import { openRecord } from "./features/record/index.js";
import todayPage from "./pages/today.js";
import sitesPage from "./pages/sites.js";
import dealsPage from "./pages/deals.js";
import clientsPage from "./pages/clients.js";
import teamPage from "./pages/team.js";
import historyPage from "./pages/history.js";
import helpPage from "./pages/help.js";

// Nav metadata lives only here (spec 5.4). badge(ctx) returns a number or null.
export const NAV = [
  { id: "today", label: "Today", icon: "today", group: "main", order: 1, badge: (ctx) => null },
  { id: "sites", label: "Sites", icon: "sites", group: "main", order: 2, badge: (ctx) => null },
  { id: "deals", label: "Deals", icon: "deals", group: "main", order: 3, badge: (ctx) => null },
  { id: "clients", label: "Clients", icon: "clients", group: "main", order: 4, badge: (ctx) => null },
  { id: "team", label: "Team overview", icon: "team", group: "more", order: 5, badge: (ctx) => null },
  { id: "help", label: "Help", icon: "help", group: "more", order: 6, badge: (ctx) => null },
];

// The first page is the fallback for an empty or unknown hash.
export const PAGES = [todayPage, sitesPage, dealsPage, clientsPage, teamPage, historyPage, helpPage];

function uiKit() {
  return Object.assign({}, toastUi, dialogUi, menuUi, pillsUi, listUi, filtersUi, emptyUi, skeletonUi, chartsUi);
}

function makeCtx(route, ui) {
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
    ui,
    openRecord,
    today: todayIso(),
  };
}

let active = null;

function show(main, ui, route, prev) {
  const page = PAGES.find((p) => p.id === route.page) || PAGES[0];
  const ctx = makeCtx(router.current(), ui);
  if (active && active.page === page && prev && prev.sub === route.sub) {
    page.update(ctx, { prev });
    return;
  }
  if (active) active.page.unmount();
  const root = document.createElement("div");
  root.className = "page";
  root.setAttribute("data-page", page.id);
  main.replaceChildren(root);
  active = { page, root };
  page.mount(root, ctx);
  document.title = page.title(ctx) + " · PartnerGap CRM";
  const h1 = root.querySelector("h1");
  if (h1) h1.focus({ preventScroll: true });
}

async function boot() {
  await meta.load();
  me.init();
  await store.load();
  const main = shell.mount({ nav: NAV });
  const ui = uiKit();
  router.onChange((route, prev) => show(main, ui, route, prev));
  router.start(PAGES);
  keys.start();
}

boot().catch((err) => {
  console.error(err);
  toastUi.toast("Something went wrong.", { kind: "error", sticky: true });
});
