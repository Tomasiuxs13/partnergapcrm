// The snapshot bar (spec 4.14): "Snapshot of <date>, read-only" and the "View as" picker. Owner G3-6.
// Bundled into the snapshot only (entry.js calls start()). The bar sits above the shell's banners on every
// page. Today, Sites › Mine and the Today badge need a person: the picker sets me (core/me.js keeps the name
// in memory and, where the browser allows it, in localStorage; both writes are in try/catch). "Everyone"
// clears it, and Today then shows everyone's sites. No side effects at import time.
import { html, render } from "../../dashboard/js/core/dom.js";
import * as router from "../../dashboard/js/core/router.js";
import * as me from "../../dashboard/js/core/me.js";
import * as metaMod from "../../dashboard/js/core/meta.js";
import * as bus from "../../dashboard/js/core/bus.js";
import { date } from "../../dashboard/js/core/format.js";

const EVERYONE = "";
let bar = null;
let started = false;

function snap() {
  return (typeof window !== "undefined" && window.__SNAPSHOT__) || {};
}

/** "Snapshot of Tue 20 Oct 2026 19:00, read-only" (the time is left out when asOf has none). */
export function snapshotTitle(asOf) {
  const day = date(asOf, "short");
  if (!day) return "Snapshot, read-only";
  const year = date(asOf, "year").split(" ").pop();
  const time = date(asOf, "time");
  return "Snapshot of " + day + " " + year + (time ? " " + time : "") + ", read-only";
}

/** The picker's names: the active team A to Z, plus the current name when it is someone else. */
export function viewNames(meta, current) {
  const names = ((meta && meta.team) || [])
    .filter((m) => m && m.name && m.active !== false)
    .map((m) => String(m.name))
    .sort((a, b) => a.localeCompare(b));
  if (current && !names.includes(current)) names.push(current);
  return names;
}

function barHtml() {
  const m = metaMod.get();
  const s = snap();
  const cur = me.get() || EVERYONE;
  const host = m.prod_host || "partnergap-crm.pages.dev";
  return html`<p class="sn-text"><b>${snapshotTitle(s.asOf || s.builtAt)}.</b> <span class="sn-hint">To make changes, open ${host}.</span></p>
<label class="sn-who"><span class="sn-who-label">View as</span><select class="ui-input sn-select" data-sn-me aria-describedby="sn-who-hint">
<option value="${EVERYONE}"${cur === EVERYONE ? html` selected` : ""}>Everyone</option>
${viewNames(m, me.get()).map((n) => html`<option value="${n}"${n === cur ? html` selected` : ""}>${n}</option>`)}
</select></label><span class="sr-only" id="sn-who-hint">Today and Sites › Mine show this person's sites.</span>`;
}

function draw() {
  if (bar) render(bar, barHtml());
}

function mount() {
  if (bar && bar.isConnected) return;
  const banners = typeof document !== "undefined" ? document.querySelector(".app [data-banners]") : null;
  if (!banners || !banners.parentNode) return;
  bar = document.createElement("section");
  bar.className = "sh-banner is-info sn-bar";
  bar.setAttribute("aria-label", "Snapshot");
  bar.setAttribute("data-snapshot-bar", "");
  banners.parentNode.insertBefore(bar, banners);
  bar.addEventListener("change", (e) => {
    const sel = e.target && e.target.closest ? e.target.closest("[data-sn-me]") : null;
    if (!sel) return;
    me.set(sel.value === EVERYONE ? null : sel.value);
  });
  draw();
}

// Called once by entry.js, before the router starts: the bar mounts on the first route (the shell is up
// by then) and follows name changes.
export function start() {
  if (started) return;
  started = true;
  router.onChange(() => mount());
  bus.on("me", () => {
    const sel = bar && bar.querySelector("[data-sn-me]");
    if (sel && sel.value !== (me.get() || EVERYONE)) draw();
  });
}
