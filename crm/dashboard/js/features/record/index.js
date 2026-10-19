// Record panel entry points (spec 4.2, 5.4). Only the router opens or closes the panel.
// Owner G1-C (this basic panel), then F1 (the full panel: header.js, log.js, timeline.js, …).
//
// The basic panel shows the label, ID and domain, the stage path and the stage, owner and client
// widgets (inline edits), the Log what happened box (outcome buttons + More ▾, a note, the follow-up
// chips, Save note / Save follow-up), the next-step line and the queue strip.
//
// - One direction: openRecord(id, {queue}) keeps the queue in memory by id and calls
//   router.setParams({rec}). start() subscribes to router.onChange, which alone opens, switches and
//   closes the panel. A reload with rec opens the site without a queue.
// - Unsaved guard: isDirty() is true while the note box has text. A route change asks "Discard your
//   note?" through router.addGuard; ×, Esc and the scrim go through closeRecord(), which asks too.
// - #layer-panel (data-layer) sits outside .app; .app is inert while the panel is open. Menus and
//   popovers opened in the panel mount into #layer-panel (top layer), so they stay clickable.
// - Esc: keys.js closes the panel through app.js; the panel also listens for Esc on its own root, so
//   it closes while a toast is showing (keys.js treats the open #toasts popover as a layer).
// No side effects at import time.
import { html, raw, render, on, safeUrl } from "../../core/dom.js";
import * as router from "../../core/router.js";
import * as store from "../../core/store.js";
import * as bus from "../../core/bus.js";
import * as metaMod from "../../core/meta.js";
import { todayIso, date as fmtDate, num } from "../../core/format.js";
import { outcomesFor, buttonLabel, CHIPS, chipDate, autoFollowUp } from "../../core/outcomes.js";
import * as actions from "../../ui/actions.js";
import { stagePath, stagePill, ownerChip, clientTags, avatar, newDot, dueBadge, waitingBadge } from "../../ui/pills.js";
import { bindInlineEdits } from "../../ui/inline-edit.js";
import { openMenu, closeAll } from "../../ui/menu.js";
import { confirm } from "../../ui/dialog.js";

const queues = new Map(); // site id -> {ids, index, label}
let started = false;
let pendingOpener = null;
let pendingFocus = null; // openRecord's focus option (a section to show first; used by the full panel)
let state = null; // the open panel: {id, layer, el, opener, queue, note, chip, pickIso, offs, busy, done}

const X_ICON = raw('<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>');

function meta() {
  return metaMod.get();
}

function readOnly() {
  return !!meta().read_only;
}

// ---------- Public API ----------

// Opens a site (the router does the work). queue: {ids, index, label} for queue mode.
export function openRecord(id, { queue, focus } = {}) {
  if (!id) return;
  const key = String(id);
  if (queue && Array.isArray(queue.ids) && queue.ids.length) {
    const index = queue.index != null ? Number(queue.index) : queue.ids.indexOf(key);
    queues.set(key, { ids: queue.ids.slice(), index: index >= 0 ? index : queue.ids.indexOf(key), label: queue.label || "" });
  } else if (!state || state.id !== key) {
    queues.delete(key);
  }
  if (focus !== undefined) pendingFocus = focus;
  if (typeof document !== "undefined" && !state) {
    const a = document.activeElement;
    pendingOpener = a && a !== document.body ? a : null;
  }
  router.setParams({ rec: key });
}

// Closes the panel (asks first when the note box has text, unless force). Resolves to true when the
// panel closes (or was not open).
export async function closeRecord({ force = false } = {}) {
  if (!state) return true;
  if (!force && isDirty()) {
    const ok = await askDiscard();
    if (!ok) return false;
  }
  if (state) {
    state.note = "";
    const box = state.el && state.el.querySelector("[data-pnote]");
    if (box) box.value = "";
  }
  router.setParams({ rec: null });
  return true;
}

export function currentRecordId() {
  return state ? state.id : null;
}

export function isDirty() {
  return !!(state && String(state.note || "").trim());
}

// Called once by app.js (after the page listener, so a reload with rec mounts the page first).
export function start(makeCtx) {
  if (started) return;
  started = true;
  void makeCtx;
  router.onChange((route) => sync(route));
  router.addGuard((next) => {
    if (!state || !isDirty()) return true;
    if (next && next.params && next.params.rec === state.id) return true;
    return askDiscard().then((ok) => {
      if (ok && state) {
        state.note = "";
        const box = state.el && state.el.querySelector("[data-pnote]");
        if (box) box.value = "";
      }
      return ok;
    });
  });
  bus.on("queue", (d) => {
    const dir = d && typeof d === "object" ? d.dir : d;
    if (state && state.queue) step(dir > 0 ? 1 : -1);
  });
}

// ---------- Router sync ----------

function sync(route) {
  const id = route && route.params ? route.params.rec || null : null;
  if (!id) {
    if (state) teardown();
    return;
  }
  if (state && state.id === id) return;
  if (!store.get(id)) {
    if (state) teardown();
    // Not loaded yet (first visit): wait for the list. Unknown ids are dropped by app.js.
    store.whenLoaded().then(() => {
      const cur = router.current().params.rec;
      if (cur === id && store.get(id) && (!state || state.id !== id)) sync(router.current());
    });
    return;
  }
  show(id);
}

function askDiscard() {
  return confirm({
    title: "Discard your note?",
    body: "The note you typed hasn't been saved.",
    confirmLabel: "Discard",
    cancelLabel: "Keep editing",
    danger: true,
  });
}

// ---------- Markup ----------

function queueHtml(q) {
  if (!q) return "";
  const n = q.ids.length;
  return html`<div class="ui-queue" role="group" aria-label="Queue"><button type="button" class="ui-x" data-pq="-1" aria-label="Previous site"${q.index <= 0 ? raw(" disabled") : ""}>‹</button><span class="ui-queue-text">${num(q.index + 1)} of ${num(n)}${q.label ? " · " + q.label : ""}</span><button type="button" class="ui-x" data-pq="1" aria-label="Next site"${q.index >= n - 1 ? raw(" disabled") : ""}>›</button></div>`;
}

function siteLink(r) {
  const u = r.domain ? safeUrl("https://" + String(r.domain).replace(/^https?:\/\//i, "")) : "";
  return u ? html` · <a href="${u}" target="_blank" rel="noopener noreferrer">${r.domain} ↗</a>` : r.domain ? html` · ${r.domain}` : "";
}

function metaHtml(r) {
  return html`${stagePath(r)}${stagePill(r)}${ownerChip(r)}${clientTags(r)}`;
}

function outsHtml(r) {
  if (readOnly()) return html`<p class="ui-small">Read-only copy.</p>`;
  const { primary, more } = outcomesFor(r, { meta: meta() });
  return html`${primary.map((o) => html`<button type="button" class="ui-btn" data-outcome="${o.id}">${buttonLabel(o)}${o.popover ? "…" : ""}</button>`)}${more.length ? html`<button type="button" class="ui-btn is-ghost" data-pmore aria-haspopup="menu">More <span aria-hidden="true">▾</span></button>` : ""}`;
}

function chipsHtml() {
  const today = todayIso();
  return html`${CHIPS.map((c) => {
    const on = state.chip === c.id;
    let label = c.label;
    if (c.id === "pick" && state.pickIso) label = "Pick… " + fmtDate(state.pickIso, "short");
    const tip = c.id === "auto" ? "The outcome's own follow-up date" : c.id === "pick" || c.id === "none" ? "" : fmtDate(chipDate(c.id, today), "short");
    return html`<button type="button" class="ui-chipbtn" data-pchip="${c.id}" aria-pressed="${on ? "true" : "false"}"${tip ? html` title="${tip}"` : ""}>${label}</button>`;
  })}`;
}

function chipValue() {
  if (!state || state.chip === "auto") return undefined;
  if (state.chip === "pick") return state.pickIso || undefined;
  return state.chip;
}

function actsHtml(r) {
  const noteOn = !!String(state.note || "").trim();
  const v = chipValue();
  const iso = v === undefined ? null : chipDate(v, todayIso());
  const hint = iso === null ? "" : iso ? "Follow-up " + fmtDate(iso, "short") : "No follow-up date";
  return html`<span class="ui-small" aria-live="polite">${hint}</span><button type="button" class="ui-btn" data-psave="note"${noteOn ? "" : raw(" disabled")}>Save note</button><button type="button" class="ui-btn" data-psave="follow"${v === undefined ? raw(" disabled") : ""}>Save follow-up</button>`;
}

function nextHtml(r) {
  const text = r.nextText || "";
  const due = dueBadge(r, { today: todayIso(), noDate: !r.closed && !!text });
  const body = html`${waitingBadge(r)}${text ? html`<span class="ui-next-text">${text}</span>` : html`<span class="ui-faint">No next step</span>`}`;
  const edit = readOnly()
    ? html`<span class="ui-next">${body}</span>`
    : html`<button type="button" class="ui-next is-edit" data-edit="next" data-id="${r.id}" aria-label="${"Next step: " + (r.next_step || "none") + ". Edit"}">${body} <span aria-hidden="true">✎</span></button>`;
  return html`<div class="ui-nextline"><b>Next:</b> ${edit} ${due}</div>`;
}

function panelHtml(r) {
  const label = r.label || r.domain || r.id;
  return html`<div class="ui-panel-scrim" data-pclose="scrim"></div>
<section class="ui-panel" role="dialog" aria-modal="true" aria-labelledby="rp-title" data-panel="${r.id}">
<header class="ui-panel-head">
<div data-pqueue>${queueHtml(state.queue)}</div>
<div class="ui-panel-top">${avatar(label, { size: "lg" })}<div class="ui-panel-title"><h2 id="rp-title" tabindex="-1" data-ptitle>${label}</h2><p class="ui-panel-sub"><span class="ui-id">${r.id}</span>${siteLink(r)}${newDot(r)}</p></div><button type="button" class="ui-x" data-pclose="x" aria-label="Close">${X_ICON}</button></div>
<div class="ui-panel-meta" data-pmeta>${metaHtml(r)}</div>
</header>
<div class="ui-panel-body" data-pbody>
<section class="ui-card ui-logbox" aria-labelledby="rp-log" data-plog>
<h3 class="ui-card-title" id="rp-log">Log what happened</h3>
<div class="ui-outs" role="group" aria-label="What happened" data-pouts>${outsHtml(r)}</div>
<label class="sr-only" for="rp-note">Add a note (optional)</label>
<textarea id="rp-note" class="ui-input" rows="2" placeholder="Add a note (optional)" maxlength="2000" data-pnote data-write>${state.note || ""}</textarea>
<fieldset class="ui-fieldset" data-write><legend class="ui-label">Follow up</legend><div class="ui-chips" data-pchips>${chipsHtml()}</div></fieldset>
<p class="ui-error" role="alert" data-perr hidden></p>
<div class="ui-logbox-acts" data-pacts data-write>${actsHtml(r)}</div>
</section>
<section class="ui-card" aria-label="Next step" data-pnext>${nextHtml(r)}</section>
</div>
</section>`;
}

function doneHtml() {
  return html`<section class="ui-card ui-done" role="status"><h3 class="ui-card-title">All done for now.</h3><p class="ui-small">That was the last site in this queue.</p><button type="button" class="ui-btn is-primary" data-pclose="done">Close</button></section>`;
}

// ---------- Open, switch, close ----------

function show(id) {
  const rec = store.get(id);
  const layer = document.getElementById("layer-panel");
  if (!rec || !layer) return;
  const switching = !!state;
  if (switching) {
    closeAll(layer);
    for (const off of state.offs) off();
  }
  const opener = switching ? state.opener : pendingOpener;
  pendingOpener = null;
  state = {
    id,
    layer,
    el: null,
    opener,
    queue: queues.get(id) || null,
    note: "",
    chip: "auto",
    pickIso: "",
    offs: [],
    busy: false,
  };
  render(layer, panelHtml(rec));
  state.el = layer.querySelector(".ui-panel");
  bind();
  if (!switching) {
    const app = document.querySelector(".app");
    if (app) app.inert = true;
    document.documentElement.setAttribute("data-panel-open", "");
  }
  pendingFocus = null;
  const h2 = state.el.querySelector("[data-ptitle]");
  if (h2) h2.focus({ preventScroll: true });
}

function teardown() {
  if (!state) return;
  const { layer, opener, id } = state;
  closeAll(layer);
  for (const off of state.offs) off();
  state = null;
  render(layer, html``);
  const app = document.querySelector(".app");
  if (app) app.inert = false;
  document.documentElement.removeAttribute("data-panel-open");
  let target = opener && opener.isConnected ? opener : null;
  if (!target && typeof CSS !== "undefined" && CSS.escape) target = document.querySelector('.app a[data-open="' + CSS.escape(id) + '"]');
  if (!target) target = document.querySelector(".app main h1, .app h1");
  if (target && typeof target.focus === "function") {
    try { target.focus({ preventScroll: true }); } catch (e) { /* not focusable */ }
  }
}

// ---------- Redraw on store changes ----------

function redraw(parts = ["meta", "outs", "next", "title"]) {
  if (!state || !state.el) return;
  const r = store.get(state.id);
  if (!r) return;
  const el = state.el;
  const active = document.activeElement;
  const keep = active && el.contains(active) ? focusKey(active) : null;
  if (parts.includes("title")) {
    const label = r.label || r.domain || r.id;
    const h2 = el.querySelector("[data-ptitle]");
    if (h2 && h2.textContent !== label) h2.textContent = label;
  }
  if (parts.includes("meta")) render(el.querySelector("[data-pmeta]"), metaHtml(r));
  if (parts.includes("outs")) render(el.querySelector("[data-pouts]"), outsHtml(r));
  if (parts.includes("next")) render(el.querySelector("[data-pnext]"), nextHtml(r));
  if (parts.includes("chips")) render(el.querySelector("[data-pchips]"), chipsHtml());
  if (parts.includes("acts") || parts.includes("chips")) render(el.querySelector("[data-pacts]"), actsHtml(r));
  if (keep && !el.contains(document.activeElement)) {
    const t = el.querySelector(keep);
    if (t) t.focus({ preventScroll: true });
  }
}

function focusKey(a) {
  for (const attr of ["data-edit", "data-outcome", "data-pchip", "data-psave", "data-pq", "data-pclose"]) {
    if (a.hasAttribute(attr)) return "[" + attr + '="' + a.getAttribute(attr).replace(/"/g, "") + '"]';
  }
  if (a.hasAttribute("data-pmore")) return "[data-pmore]";
  return null;
}

// ---------- Queue ----------

function step(dir) {
  if (!state || !state.queue) return;
  const q = state.queue;
  const i = q.index + dir;
  if (i < 0 || i >= q.ids.length) return;
  const id = q.ids[i];
  if (!store.get(id)) {
    q.index = i;
    return step(dir);
  }
  openRecord(id, { queue: { ids: q.ids, index: i, label: q.label } });
}

// After a save in queue mode the panel always moves on; at the end it says "All done for now".
function advance() {
  if (!state || !state.queue) return;
  const q = state.queue;
  for (let i = q.index + 1; i < q.ids.length; i++) {
    if (store.get(q.ids[i])) {
      openRecord(q.ids[i], { queue: { ids: q.ids, index: i, label: q.label } });
      return;
    }
  }
  const body = state.el.querySelector("[data-pbody]");
  render(body, doneHtml());
  const b = body.querySelector("[data-pclose]");
  if (b) b.focus({ preventScroll: true });
}

// ---------- Events ----------

function showError(msg) {
  const p = state && state.el ? state.el.querySelector("[data-perr]") : null;
  if (!p) return;
  p.textContent = msg || "";
  p.hidden = !msg;
}

function afterSave(ok) {
  if (!state) return;
  if (!ok) return;
  state.note = "";
  state.chip = "auto";
  state.pickIso = "";
  const box = state.el.querySelector("[data-pnote]");
  if (box) box.value = "";
  showError("");
  redraw(["meta", "outs", "next", "title", "chips", "acts"]);
  advance();
}

async function runOutcome(btn, outcomeId) {
  const rec = store.get(state.id);
  if (!rec || state.busy) return;
  const id = state.id;
  state.busy = true;
  try {
    const r = await actions.runOutcome(btn, rec, outcomeId, { note: state.note, followUp: chipValue() });
    if (state && state.id === id) afterSave(!!r);
  } finally {
    if (state && state.id === id) state.busy = false;
  }
}

function bind() {
  const el = state.el;
  const layer = state.layer;
  const offs = state.offs;
  offs.push(on(layer, "click", "[data-pclose]", (e) => {
    e.preventDefault();
    closeRecord();
  }));
  offs.push(on(el, "keydown", null, (e) => {
    if (e.key !== "Escape" || e.defaultPrevented) return;
    let other = null;
    try { other = document.querySelector(":popover-open:not(#toasts)"); } catch (x) { other = null; }
    if (other || document.querySelector("dialog[open]")) return;
    e.preventDefault();
    closeRecord();
  }));
  offs.push(on(el, "click", "[data-pq]", (e, b) => step(Number(b.getAttribute("data-pq")) > 0 ? 1 : -1)));
  offs.push(on(el, "click", "[data-outcome]", (e, b) => runOutcome(b, b.getAttribute("data-outcome"))));
  offs.push(on(el, "click", "[data-pmore]", async (e, b) => {
    const rec = store.get(state.id);
    if (!rec) return;
    const { more } = outcomesFor(rec, { meta: meta() });
    const today = todayIso();
    const id = await openMenu(b, {
      label: "More outcomes",
      items: more.map((o) => {
        const due = autoFollowUp(rec, o.id, { meta: meta(), today });
        return { label: buttonLabel(o), value: o.id, hint: o.popover ? "…" : due ? "→ " + fmtDate(due, "day") : "" };
      }),
    });
    if (id && state) runOutcome(b, id);
  }));
  offs.push(on(el, "input", "[data-pnote]", (e, box) => {
    state.note = box.value;
    redraw(["acts"]);
  }));
  offs.push(on(el, "click", "[data-pchip]", async (e, b) => {
    const c = b.getAttribute("data-pchip");
    if (c === "pick") {
      const iso = await actions.pickDate(b, { value: state.pickIso || "", label: "Follow-up date" });
      if (!state || !iso) return;
      state.pickIso = iso;
    }
    state.chip = c;
    redraw(["chips"]);
  }));
  offs.push(on(el, "click", "[data-psave]", async (e, b) => {
    if (!state || state.busy) return;
    const id = state.id;
    const what = b.getAttribute("data-psave");
    state.busy = true;
    let ok = false;
    try {
      if (what === "note") ok = !!(await actions.note(id, state.note));
      else {
        const v = chipValue();
        if (v === undefined) return;
        ok = !!(await actions.followUp(id, chipDate(v, todayIso()) || null));
      }
    } finally {
      if (state && state.id === id) state.busy = false;
    }
    if (state && state.id === id) afterSave(ok);
  }));
  // Store notifications wait while the note box has text (spec 4.11), so redraw after an edit here.
  offs.push(bindInlineEdits(el, { getRecord: (k) => store.get(k), onDone: () => redraw() }));
  offs.push(store.subscribe((n) => {
    if (!state) return;
    if (n && n.ids && !n.ids.includes(state.id)) return;
    if (!store.get(state.id)) return;
    redraw();
  }));
}
