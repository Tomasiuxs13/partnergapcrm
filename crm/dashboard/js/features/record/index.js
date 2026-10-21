// The record panel (spec 4.2, 5.4). Owner F1 (G1-C wrote the first basic panel). Only the router opens or
// closes it. No side effects at import time.
//
// Parts: header.js (sticky header), log.js (Log what happened), next-step.js, timeline.js, contacts.js,
// suggestions.js, deal.js (Deal terms, Placement), details.js, queue.js (queue mode).
//
// - One direction: openRecord(id, {queue, focus}) keeps the queue in memory by id (queue.js) and calls
//   router.setParams({rec}). start() subscribes to router.onChange, which alone opens, switches and closes
//   the panel. A reload with rec opens the site without a queue.
// - It opens at once from the store. The profile (GET /api/partner/:id: contacts, activity, history,
//   suggestions, about) loads in the background with skeletons; in queue mode the next site's profile is
//   fetched ahead. Every response is tagged with its site id: a late one never writes into another site's
//   panel and shows no success toast there (the store row still updates; a failure toast names the site).
// - Saves from the Log what happened box run quietly through actions.js; the panel words the toast (with
//   Undo), shows a failure inline ("Not saved. … Retry"), and in queue mode always moves on to the next site
//   after a save ("All done for now." at the end). The 5 outcomes with a form use actions' own form and toasts.
// - Unsaved guard: isDirty() is true while the note box, the add-contact form or an open editor in the panel
//   holds unsaved text. ×, Esc, the scrim and queue ‹ › ask through closeRecord()/the router guard; Back,
//   links and route changes ask through router.addGuard; shell.js asks on beforeunload.
// - A 401 saves the draft (note, chip, add-contact form) to sessionStorage; it comes back after sign-in.
// - #layer-panel (data-layer) sits outside .app; .app is inert while the panel is open and Tab stays in the
//   layer. Menus and popovers opened in the panel mount into #layer-panel (top layer).
import { html, render, on, copyText } from "../../core/dom.js";
import * as router from "../../core/router.js";
import * as store from "../../core/store.js";
import * as bus from "../../core/bus.js";
import * as metaMod from "../../core/meta.js";
import { api, readOnlyText } from "../../core/api.js";
import { todayIso } from "../../core/format.js";
import { outcomesFor, outcome as outcomeDef, termsText } from "../../core/outcomes.js";
import * as actions from "../../ui/actions.js";
import { bindInlineEdits } from "../../ui/inline-edit.js";
import { openMenu, closeAll } from "../../ui/menu.js";
import { confirm, trapFocus } from "../../ui/dialog.js";
import { toast } from "../../ui/toast.js";
import { setQueue, getQueue, clearQueue, neighbour, queueFor, queueHtml } from "./queue.js";
import { renderHeader, toolsHtml, metaHtml, subHtml, aboutHtml, aboutText, labelOf, siteUrl } from "./header.js";
import { renderLog, outsHtml, chipsHtml, actsHtml, errHtml, chipValue, chipIso, moreItems, snapshot, revertOf,
  outcomeText, followText } from "./log.js";
import { renderNextStep } from "./next-step.js";
import { renderTimeline } from "./timeline.js";
import { renderContacts, readAddForm, checkContact, firstEmail, sheetUrl, sheetToast, ADD_FIELDS } from "./contacts.js";
import { renderSuggestions, openRows, splitName, copyTextOf } from "./suggestions.js";
import { renderDeal, renderPlacement, showDeal, showPlacement, editDeal, editPlacement } from "./deal.js";
import { renderDetails } from "./details.js";
import { renderDeals, renderFiles, profileDeals, openDealForm, openFileForm } from "./deals.js";

const DRAFT_KEY = "pgcrm-panel-draft";
const PROFILE_TTL = 60000;
const PROFILE_MAX = 40;
const SYNC_SENTENCE = "Copies to the Google Sheet on the next weekday morning (08:47).";

// Parts drawn from the store row, and from the profile.
const RECORD_PARTS = ["title", "sub", "tools", "meta", "queue", "outs", "acts", "next", "deal", "place", "details", "foot"];
const PROFILE_PARTS = ["about", "timeline", "contacts", "sugg", "tools", "details", "deals", "files", "deal", "place"];

const profiles = new Map(); // site id -> {data, at}
const inflight = new Map(); // site id -> Promise of the profile
let started = false;
let pendingOpener = null;
let pendingFocus = null;
let profileSeq = 0;
let state = null;
let leaving = false; // a 401 is sending the page to sign-in

const meta = () => metaMod.get();
const readOnly = () => !!meta().read_only;
const snapshotMode = () => typeof window !== "undefined" && !!window.__SNAPSHOT__;
const has = (v) => v != null && String(v).trim() !== "";
const exists = (id) => !!store.get(id);
const lowerFirst = (s) => s.charAt(0).toLowerCase() + s.slice(1);

// ---------- Public API ----------

// Opens a site (the router does the work). queue: {ids, index, label, primary?} for queue mode.
// focus: 'log' | 'contacts' | 'deal' | 'next' scrolls that part into view.
export function openRecord(id, { queue, focus } = {}) {
  if (!id) return;
  const key = String(id);
  if (queue && Array.isArray(queue.ids) && queue.ids.length) setQueue(key, queue);
  else if (!state || state.id !== key) clearQueue(key);
  if (focus !== undefined) pendingFocus = focus;
  if (state && state.id === key) {
    state.queue = getQueue(key);
    draw(["queue", "outs"]);
    applyFocus();
    return;
  }
  if (typeof document !== "undefined" && !state) {
    const a = document.activeElement;
    pendingOpener = a && a !== document.body ? a : null;
  }
  router.setParams({ rec: key });
}

// Closes the panel (asks first when something typed isn't saved, unless force). Resolves to true when the
// panel closes (or was not open).
export async function closeRecord({ force = false } = {}) {
  if (!state) return true;
  if (!force && isDirty()) {
    const ok = await askDiscard();
    if (!ok) return false;
  }
  clearDraft();
  router.setParams({ rec: null });
  return true;
}

export function currentRecordId() {
  return state ? state.id : null;
}

export function isDirty() {
  return !!state && !leaving && dirtyKind() !== "";
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
      if (ok) clearDraft();
      return ok;
    });
  });
  bus.on("queue", (d) => {
    const dir = d && typeof d === "object" ? d.dir : d;
    if (state && state.queue) step(dir > 0 ? 1 : -1);
  });
  // A deal changed elsewhere (the Deals page's Stage ▾): the site's cached profile is out of date.
  bus.on("deals:changed", (d) => {
    if (d && d.id != null) profiles.delete(String(d.id));
  });
  bus.on("unauthorized", () => {
    // The draft is kept for after sign-in, so the page may leave without asking (beforeunload).
    saveDraft();
    leaving = true;
  });
}

// ---------- Unsaved guard ----------

function formChanged(form) {
  for (const el of Array.from(form.elements || [])) {
    if (el.type === "checkbox" || el.type === "radio") {
      if (el.checked !== el.defaultChecked) return true;
    } else if (el.tagName === "SELECT") {
      const def = Array.from(el.options).findIndex((o) => o.defaultSelected);
      if (el.selectedIndex !== (def < 0 ? 0 : def)) return true;
    } else if ((el.tagName === "TEXTAREA" || el.tagName === "INPUT") && !/^(button|submit|reset)$/.test(el.type)) {
      if (el.value !== el.defaultValue) return true;
    }
  }
  return false;
}

// 'note' | 'form' | '' (nothing unsaved).
function dirtyKind() {
  if (!state) return "";
  if (has(state.note)) return "note";
  if (state.add && ADD_FIELDS.some((k) => has(state.add[k]))) return "form";
  const layer = state.layer;
  if (layer) for (const form of layer.querySelectorAll(".ui-pop form")) if (formChanged(form)) return "form";
  return "";
}

function askDiscard() {
  const note = dirtyKind() === "note";
  return confirm({
    title: note ? "Discard your note?" : "Discard your changes?",
    body: note ? "The note you typed hasn't been saved." : "What you typed hasn't been saved.",
    confirmLabel: "Discard",
    cancelLabel: "Keep editing",
    danger: true,
  });
}

function noteBox() {
  return state && state.el ? state.el.querySelector("[data-pnote]") : null;
}

function clearDraft() {
  if (!state) return;
  state.note = "";
  const box = noteBox();
  if (box) box.value = "";
  const hadForm = !!state.add;
  state.add = null;
  state.addErr = "";
  state.addDupe = null;
  state.addSugg = null;
  closeAll(state.layer);
  if (hadForm) draw(["contacts"]);
  draw(["acts"]);
}

// A 401 sends the page to sign-in: keep what was typed for this site (spec 4.2).
function saveDraft() {
  if (!state) return;
  const d = { id: state.id, note: state.note || "", chip: state.chip, pickIso: state.pickIso, add: state.add || null };
  if (!has(d.note) && !d.add) return;
  try { sessionStorage.setItem(DRAFT_KEY, JSON.stringify(d)); } catch (e) { /* storage blocked */ }
}

function restoreDraft() {
  let d = null;
  try { d = JSON.parse(sessionStorage.getItem(DRAFT_KEY) || "null"); } catch (e) { d = null; }
  if (!d || d.id !== state.id) return false;
  try { sessionStorage.removeItem(DRAFT_KEY); } catch (e) { /* storage blocked */ }
  state.note = String(d.note || "");
  state.chip = d.chip || "auto";
  state.pickIso = d.pickIso || "";
  if (state.chip === "pick" && !state.pickIso) state.chip = "auto";
  if (d.add && typeof d.add === "object") state.add = d.add;
  return true;
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

// ---------- Profile (GET /api/partner/:id) ----------

function remember(id, data) {
  profiles.delete(id);
  profiles.set(id, { data, at: Date.now() });
  while (profiles.size > PROFILE_MAX) profiles.delete(profiles.keys().next().value);
}

function fresh(c) {
  return !!c && Date.now() - c.at < PROFILE_TTL;
}

function fetchProfile(id, { force = false } = {}) {
  if (!force && inflight.has(id)) return inflight.get(id);
  const p = api.partner(id).then((data) => {
    if (data && typeof data === "object") remember(id, data);
    return data;
  });
  inflight.set(id, p);
  const done = () => { if (inflight.get(id) === p) inflight.delete(id); };
  p.then(done, done);
  return p;
}

function suggFrom(data) {
  return data && Array.isArray(data.suggestions) ? data.suggestions : null;
}

function applyProfile(data) {
  state.profile = data;
  state.profileState = "ok";
  state.sugg = suggFrom(data);
  const t = aboutText(data.about);
  if (t) state.aboutText = t;
}

async function loadProfile(id, { force = false } = {}) {
  if (!state || state.id !== id) return;
  if (snapshotMode()) {
    state.profileState = "snapshot";
    draw(PROFILE_PARTS);
    return;
  }
  const my = ++profileSeq;
  state.profileSeq = my;
  let data = null;
  let err = null;
  try {
    data = await fetchProfile(id, { force });
  } catch (e) {
    err = e;
  }
  if (!state || state.id !== id || state.profileSeq !== my) return; // a late answer for another site
  if (err) {
    if (err.status === 401) return;
    if (!state.profile) state.profileState = "error";
    draw(PROFILE_PARTS);
    return;
  }
  if (data == null || typeof data !== "object") {
    state.profile = null;
    state.profileState = "na";
    draw(PROFILE_PARTS);
    return;
  }
  applyProfile(data);
  draw(PROFILE_PARTS);
  afterProfile(id);
}

function afterProfile(id) {
  loadAbout(id);
  prefetchNext();
}

// The About line: from the profile, or GET …/about when the profile says it is pending (6.3.9).
async function loadAbout(id) {
  const p = state && state.id === id ? state.profile : null;
  if (!p || state.aboutText || !p.about_pending) return;
  let a = null;
  try { a = await api.about(id); } catch (e) { a = null; }
  if (!a || !aboutText(a)) return;
  p.about = a;
  p.about_pending = false;
  if (!state || state.id !== id) return;
  state.aboutText = aboutText(a);
  draw(["about"]);
}

function prefetchNext() {
  if (!state || !state.queue || snapshotMode()) return;
  const n = neighbour(state.queue, 1, exists);
  if (n && !fresh(profiles.get(n.id)) && !inflight.has(n.id)) fetchProfile(n.id).catch(() => null);
}

// ---------- Markup ----------

function emailState(r) {
  const list = state && state.profile && Array.isArray(state.profile.contacts) ? state.profile.contacts : null;
  if (list) return firstEmail(state.profile) ? "ready" : list.length ? "noemail" : "none";
  return Number(r.contacts) > 0 ? "unknown" : "none";
}

function suggCount() {
  return openRows(state.sugg).filter((s) => ["candidate", "email", "slack_ask"].includes(s.kind)).length;
}

function footHtml(ro) {
  return html`${ro ? "" : html`<button type="button" class="ui-btn is-primary rc-foot-btn" data-pfoot="log" aria-haspopup="menu">Log what happened <span aria-hidden="true">▾</span></button><button type="button" class="ui-btn rc-foot-btn" data-pfoot="follow" aria-haspopup="menu">Follow up <span aria-hidden="true">▾</span></button>`}<button type="button" class="ui-btn rc-foot-more" data-pact="more" aria-haspopup="menu" aria-label="More actions"><span aria-hidden="true">⋯</span></button>`;
}

function hidden(on) {
  return on ? html` hidden` : "";
}

// The site's own Deal terms and Placement cards give way to the Deals card once the site has a deal
// (migration 006 starts one for every site with terms). A site without one keeps them.
const hasDeals = () => (profileDeals(state) || []).length > 0;

function panelHtml(r) {
  const ro = readOnly();
  const roText = readOnlyText();
  const today = todayIso();
  const m = meta();
  const head = { queue: state.queue, aboutText: state.aboutText, aboutOpen: state.aboutOpen, emailState: emailState(r), copyEmail: !snapshotMode() };
  const multi = profileDeals(state) !== null;
  const deal = !hasDeals() && showDeal(r, { showAll: state.showAll || state.dealForced });
  const place = !hasDeals() && showPlacement(r, { showAll: state.showAll });
  return html`<div class="ui-panel-scrim" data-pclose="scrim"></div>
<section class="ui-panel rc-panel" role="dialog" aria-modal="true" aria-labelledby="rp-title" data-panel="${r.id}">
${renderHeader(r, head, { readOnly: ro, roText, exists })}
<div class="ui-panel-body rc-body" data-pbody><div class="rc-cols">
<div class="rc-left">
<section class="ui-card rc-card rc-contacts" aria-labelledby="rc-ct-h" data-psec="contacts">${renderContacts(r, state, { meta: m, today, readOnly: ro, lookup: store.get })}</section>
<section class="ui-card rc-card rc-files" aria-labelledby="rc-files-h" data-psec="files"${hidden(!multi)}>${multi ? renderFiles(r, state, { readOnly: ro }) : ""}</section>
<section class="ui-card rc-card rc-detcard" aria-labelledby="rc-det-h" data-psec="details">${renderDetails(r, state, { today, readOnly: ro })}</section>
</div>
<div class="rc-main">
<section class="ui-card ui-logbox rc-card rc-log" aria-labelledby="rc-log-h" data-psec="log" data-plog>${renderLog(r, state, { meta: m, today, readOnly: ro, roText })}</section>
<section class="ui-card rc-card rc-nextcard" aria-label="Next step" data-psec="next">${renderNextStep(r, { today, readOnly: ro })}</section>
<section class="ui-card rc-card rc-tlcard" aria-labelledby="rc-tl-h" data-psec="timeline">${renderTimeline(r, state, { today })}</section>
</div>
<div class="rc-side">
<section class="ui-card rc-card rc-deals" aria-labelledby="rc-deals-h" data-psec="deals"${hidden(!multi)}>${multi ? renderDeals(r, state, { readOnly: ro, today }) : ""}</section>
<section class="ui-card rc-card rc-deal" aria-labelledby="rc-deal-h" data-psec="deal"${hidden(!deal)}>${deal ? renderDeal(r, { readOnly: ro }) : ""}</section>
<section class="ui-card rc-card rc-place" aria-labelledby="rc-place-h" data-psec="place"${hidden(!place)}>${place ? renderPlacement(r, { readOnly: ro, today }) : ""}</section>
<section class="ui-card rc-card rc-sugg" aria-labelledby="rc-sg-h" data-psec="sugg"${hidden(!suggCount())}>${renderSuggestions(r, state, { readOnly: ro })}</section>
</div>
</div></div>
<footer class="rc-foot" data-pfootbar>${footHtml(ro)}</footer>
</section>`;
}

// ---------- Open, switch, close ----------

function newState(id, layer, opener, showAll) {
  return {
    id, layer, el: null, opener, offs: [],
    queue: getQueue(id),
    note: "", chip: "auto", pickIso: "", busy: false, err: "", retry: null,
    profile: null, profileState: "loading", profileSeq: 0, sugg: null, suggOpen: {},
    aboutText: "", aboutOpen: false, timelineAll: false, notesOpen: false, tlOpen: {}, contactsAll: false,
    showAll, dealForced: false, detailsOpen: false,
    add: null, addErr: "", addField: "", addDupe: null, addBusy: false, addSugg: null,
  };
}

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
  state = newState(id, layer, opener, switching ? state.showAll : false);
  const restored = restoreDraft();
  const cached = profiles.get(id);
  if (snapshotMode()) state.profileState = "snapshot";
  else if (cached) applyProfile(cached.data);
  render(layer, panelHtml(rec));
  state.el = layer.querySelector(".ui-panel");
  bind();
  if (!switching) {
    const app = document.querySelector(".app");
    if (app) app.inert = true;
    document.documentElement.setAttribute("data-panel-open", "");
  }
  const h2 = state.el.querySelector("[data-ptitle]");
  if (h2) h2.focus({ preventScroll: true });
  applyFocus();
  if (restored) toast("Your unsaved note is back. Save it when you're ready.", { kind: "info" });
  if (snapshotMode()) return;
  if (cached) afterProfile(id);
  if (!fresh(cached)) loadProfile(id);
}

function applyFocus() {
  const f = pendingFocus;
  pendingFocus = null;
  if (!state || !state.el || !f) return;
  if (f === "deal" && !state.dealForced) {
    state.dealForced = true;
    draw(["deal"]);
  }
  const sec = { log: "log", contacts: "contacts", deal: "deal", next: "next" }[f];
  const el = sec ? state.el.querySelector('[data-psec="' + sec + '"]') : null;
  if (el && el.scrollIntoView) el.scrollIntoView({ block: "nearest" });
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

// ---------- Drawing parts ----------

const FOCUS_ATTRS = ["data-edit", "data-outcome", "data-pchip", "data-psave", "data-pq", "data-pclose", "data-pact", "data-pmore",
  "data-ptl", "data-pti", "data-pnotes", "data-pcall", "data-padd", "data-pdeal", "data-pplace", "data-pwait", "data-pfoot", "data-pretry",
  "data-psugg-add", "data-psugg-dismiss", "data-psugg-copy", "data-psugg-more", "data-pcopy", "data-pabout-more", "data-preload"];

function focusKey(a) {
  const q = (v) => (typeof CSS !== "undefined" && CSS.escape ? CSS.escape(v) : String(v).replace(/"/g, ""));
  for (const attr of FOCUS_ATTRS) {
    if (!a.hasAttribute(attr)) continue;
    const v = a.getAttribute(attr);
    return v ? "[" + attr + '="' + q(v) + '"]' : "[" + attr + "]";
  }
  if (a.name && a.closest("[data-paddform]")) return '[data-paddform] [name="' + q(a.name) + '"]';
  return null;
}

function draw(parts) {
  if (!state || !state.el) return;
  const r = store.get(state.id);
  if (!r) return;
  const el = state.el;
  const ro = readOnly();
  const today = todayIso();
  const m = meta();
  const active = document.activeElement;
  const keep = active && el.contains(active) && active !== el.querySelector("[data-pnote]") ? focusKey(active) : null;
  const q = (sel) => el.querySelector(sel);
  const put = (sel, safe) => {
    const node = q(sel);
    if (node) render(node, safe);
    return node;
  };
  for (const p of parts) {
    switch (p) {
      case "title": {
        const h2 = q("[data-ptitle]");
        const t = labelOf(r);
        if (h2 && h2.textContent !== t) h2.textContent = t;
        break;
      }
      case "sub": put("[data-psub]", subHtml(r)); break;
      case "tools": put("[data-ptools]", toolsHtml(r, { emailState: emailState(r), copyEmail: !snapshotMode() })); break;
      case "meta": put("[data-pmeta]", metaHtml(r, { readOnly: ro, roText: readOnlyText() })); break;
      case "about": {
        const node = put("[data-pabout]", aboutHtml(state.aboutText, state.aboutOpen));
        if (node) {
          node.hidden = !state.aboutText;
          node.classList.toggle("is-open", !!state.aboutOpen);
        }
        break;
      }
      case "queue": {
        const node = put("[data-pqueue]", queueHtml(state.queue, exists));
        if (node) node.hidden = !state.queue;
        break;
      }
      case "outs": if (!ro) put("[data-pouts]", outsHtml(r, state, { meta: m, today })); break;
      case "chips": if (!ro) put("[data-pchips]", chipsHtml(state, today)); break;
      case "acts": if (!ro) put("[data-pacts]", actsHtml(state, today)); break;
      case "err": {
        const node = put("[data-perr]", errHtml(state));
        if (node) node.hidden = !state.err;
        break;
      }
      case "next": put('[data-psec="next"]', renderNextStep(r, { today, readOnly: ro })); break;
      case "timeline": put('[data-psec="timeline"]', renderTimeline(r, state, { today })); break;
      case "contacts": put('[data-psec="contacts"]', renderContacts(r, state, { meta: m, today, readOnly: ro, lookup: store.get })); break;
      case "sugg": {
        const node = put('[data-psec="sugg"]', renderSuggestions(r, state, { readOnly: ro }));
        if (node) node.hidden = !suggCount();
        break;
      }
      case "deals":
      case "files": {
        const node = q('[data-psec="' + p + '"]');
        const on = profileDeals(state) !== null;
        if (node) {
          node.hidden = !on;
          render(node, !on ? html`` : p === "deals" ? renderDeals(r, state, { readOnly: ro, today }) : renderFiles(r, state, { readOnly: ro }));
        }
        break;
      }
      case "deal": {
        const node = q('[data-psec="deal"]');
        const on = !hasDeals() && showDeal(r, { showAll: state.showAll || state.dealForced });
        if (node) {
          node.hidden = !on;
          render(node, on ? renderDeal(r, { readOnly: ro }) : html``);
        }
        break;
      }
      case "place": {
        const node = q('[data-psec="place"]');
        const on = !hasDeals() && showPlacement(r, { showAll: state.showAll });
        if (node) {
          node.hidden = !on;
          render(node, on ? renderPlacement(r, { readOnly: ro, today }) : html``);
        }
        break;
      }
      case "details": put('[data-psec="details"]', renderDetails(r, state, { today, readOnly: ro })); break;
      case "foot": put("[data-pfootbar]", footHtml(ro)); break;
      default: break;
    }
  }
  if (keep && !el.contains(document.activeElement)) {
    const t = el.querySelector(keep);
    if (t && !t.disabled) t.focus({ preventScroll: true });
  }
}

// ---------- Queue ----------

function step(dir) {
  if (!state || !state.queue) return;
  const n = neighbour(state.queue, dir, exists);
  if (n) openRecord(n.id, { queue: queueFor(state.queue, n.index) });
}

// After a save in queue mode the panel always moves on; after the last site it closes.
function advance() {
  if (!state || !state.queue) return;
  const q = state.queue;
  const n = neighbour(q, 1, exists);
  if (n) {
    openRecord(n.id, { queue: queueFor(q, n.index) });
    return;
  }
  toast("All done for now.", { kind: "info" });
  closeRecord({ force: true });
}

// ---------- Saves from the Log what happened box ----------

function setBusy(id, on) {
  if (!state || state.id !== id) return;
  state.busy = on;
  draw(["outs", "chips", "acts"]);
}

function clearErr(id) {
  if (!state || state.id !== id || !state.err) return;
  state.err = "";
  state.retry = null;
  draw(["err"]);
}

// A success toast, only while that site is still open: a save that lands after the panel moved on to
// another site updates the store quietly (spec T16). Failures always say so (failed()).
function say(id, label, text, opts = {}) {
  void label;
  if (!state || state.id !== id) return;
  toast(text, Object.assign({ kind: "success" }, opts));
}

// A failed save: inline ("Not saved. … Retry") while the site is open, else a toast that names it.
function failed(id, label, e, retry) {
  if (e && e.status === 401) return;
  const why = (e && (e.friendly || e.message)) || "Check your connection and try again.";
  if (state && state.id === id) {
    state.err = "Not saved. " + why;
    state.retry = () => {
      clearErr(id);
      retry();
    };
    draw(["err"]);
    return;
  }
  toast(label + " · Not saved. " + why, { kind: "error", action: { label: "Retry", fn: retry } });
}

async function undoFields(id, revert, message, keepNote) {
  let back = null;
  let err = null;
  try {
    back = await actions.update(id, revert, { undo: false, quiet: true, throw: true });
  } catch (e) {
    err = e;
  }
  if (!back) {
    if (!(err && err.status === 401)) toast("Couldn't undo that. " + ((err && err.friendly) || "Try again."), { kind: "error" });
    return;
  }
  toast(message + (keepNote ? " The note stays in the history." : ""), { kind: "info" });
  profiles.delete(id);
  if (state && state.id === id) {
    draw(RECORD_PARTS);
    loadProfile(id, { force: true });
  }
}

// After a successful save: clear the box, then move on (queue mode) or reload the timeline.
function saved(id) {
  profiles.delete(id);
  if (!state || state.id !== id) return;
  state.note = "";
  state.chip = "auto";
  state.pickIso = "";
  state.err = "";
  state.retry = null;
  state.busy = false;
  const box = noteBox();
  if (box) box.value = "";
  draw(RECORD_PARTS.concat(["chips", "err"]));
  if (state.queue) {
    advance();
    return;
  }
  loadProfile(id, { force: true });
}

function addTerms(id) {
  if (state && state.id === id) {
    state.dealForced = true;
    draw(["deal"]);
    const b = state.el.querySelector('[data-pdeal="edit"]');
    if (b) {
      b.scrollIntoView({ block: "nearest" });
      editDeal(b, store.get(id)).then(() => draw(RECORD_PARTS));
    }
    return;
  }
  openRecord(id, { focus: "deal" });
}

async function quietOutcome(id, o, opts) {
  const rec = store.get(id);
  if (!rec) return;
  const before = snapshot(rec);
  const label = labelOf(rec);
  const terms = termsText(rec);
  clearErr(id);
  setBusy(id, true);
  let r = null;
  try {
    r = await actions.outcome(id, o.id, Object.assign({}, opts, { quiet: true, throw: true }));
  } catch (e) {
    setBusy(id, false);
    failed(id, label, e, () => quietOutcome(id, o, opts));
    return;
  }
  setBusy(id, false);
  if (!r) {
    failed(id, label, null, () => quietOutcome(id, o, opts));
    return;
  }
  const after = store.get(id) || r;
  const revert = revertOf(before, after);
  const keepNote = o.id !== "claim" && o.id !== "assign_manager";
  say(id, label, outcomeText(o, before, after), {
    undo: Object.keys(revert).length ? () => undoFields(id, revert, "stage" in revert ? "Stage restored." : "Change undone.", keepNote) : undefined,
    action: o.id === "approve" && !terms ? { label: "Add terms", fn: () => addTerms(id) } : undefined,
  });
  saved(id);
}

async function clickOutcome(btn, outcomeId) {
  if (!state || state.busy || readOnly()) return;
  const id = state.id;
  const rec = store.get(id);
  const o = outcomeDef(outcomeId);
  if (!rec || !o) return;
  closeAll(state.layer);
  const opts = { note: state.note, followUp: chipValue(state) };
  if (o.popover || (o.needsNote && !has(opts.note))) {
    // The small form (reason, terms, link, or the note of a call): actions' form, toasts and Undo.
    const r = await actions.runOutcome(btn, rec, outcomeId, Object.assign({}, opts, { onAddTerms: () => addTerms(id) }));
    if (r) saved(id);
    return;
  }
  await quietOutcome(id, o, opts);
}

async function saveFollow(id, label, iso, prefix = "") {
  const rec = store.get(id);
  if (!rec) return;
  const fields = {};
  if (iso && !has(rec.next_step)) fields.next_step = "Follow up";
  fields.next_due = iso || "";
  const before = snapshot(rec);
  clearErr(id);
  setBusy(id, true);
  let r = null;
  try {
    r = await actions.update(id, fields, { quiet: true, throw: true });
  } catch (e) {
    setBusy(id, false);
    failed(id, label, e, () => saveFollow(id, label, iso, prefix));
    return;
  }
  setBusy(id, false);
  if (!r) {
    failed(id, label, null, () => saveFollow(id, label, iso, prefix));
    return;
  }
  const revert = revertOf(before, store.get(id) || r);
  const text = followText(iso);
  say(id, label, prefix ? prefix + lowerFirst(text) : text, {
    undo: Object.keys(revert).length ? () => undoFields(id, revert, "Change undone.", false) : undefined,
  });
  saved(id);
}

async function saveNote(id, label, text, iso) {
  clearErr(id);
  setBusy(id, true);
  let r = null;
  try {
    r = await actions.note(id, text, { quiet: true, throw: true });
  } catch (e) {
    setBusy(id, false);
    failed(id, label, e, () => saveNote(id, label, text, iso));
    return;
  }
  setBusy(id, false);
  if (!r) {
    failed(id, label, null, () => saveNote(id, label, text, iso));
    return;
  }
  if (iso === undefined) {
    say(id, label, "Note saved.");
    saved(id);
    return;
  }
  // The note is in; the follow-up is the second half (it can be retried on its own).
  if (state && state.id === id) {
    state.note = "";
    const box = noteBox();
    if (box) box.value = "";
  }
  await saveFollow(id, label, iso, "Note saved · ");
}

function clickSave(what) {
  if (!state || state.busy || readOnly()) return;
  const id = state.id;
  const rec = store.get(id);
  if (!rec) return;
  const label = labelOf(rec);
  const text = String(state.note || "");
  const iso = chipIso(state, todayIso());
  if (what === "note" && has(text)) saveNote(id, label, text, undefined);
  else if (what === "follow" && iso !== undefined) saveFollow(id, label, iso);
  else if (what === "both" && has(text) && iso !== undefined) saveNote(id, label, text, iso);
}

async function pickChip(b) {
  if (!state || state.busy) return;
  const c = b.getAttribute("data-pchip");
  if (c === "pick") {
    const iso = await actions.pickDate(b, { value: state.pickIso || "", label: "Follow-up date" });
    if (!state || !iso) return;
    state.pickIso = iso;
    state.chip = "pick";
  } else {
    state.chip = state.chip === c && c !== "auto" ? "auto" : c;
  }
  draw(["chips", "acts", "outs"]);
}

async function moreOutcomes(b) {
  const rec = store.get(state.id);
  if (!rec || state.busy) return;
  const { more } = outcomesFor(rec, { meta: meta() });
  const picked = await openMenu(b, { label: "More", items: moreItems(rec, more, { meta: meta(), today: todayIso() }) });
  if (picked && state) clickOutcome(b, picked);
}

// ---------- Header tools and the ⋯ menu ----------

async function copyEmail() {
  const id = state.id;
  let prof = state.profile || (profiles.get(id) && profiles.get(id).data) || null;
  if (!prof && !snapshotMode()) {
    try { prof = await fetchProfile(id); } catch (e) { prof = null; }
  }
  const email = firstEmail(prof);
  if (!email) {
    toast(prof ? "No contact on this site has an email yet." : "Couldn't load the contacts. Try again.", { kind: prof ? "info" : "error" });
    return;
  }
  const ok = await copyText(email);
  toast(ok ? "Copied " + email : "Couldn't copy. The email is " + email, { kind: ok ? "success" : "info" });
}

function phone() {
  try { return window.matchMedia("(max-width: 639.98px)").matches; } catch (e) { return false; }
}

async function moreMenu(b) {
  const r = store.get(state.id);
  if (!r) return;
  const sheet = sheetUrl(meta(), r.id);
  const items = [];
  if (phone()) {
    const es = emailState(r);
    if (!snapshotMode()) items.push({ label: "Copy email", value: "copy-email", disabled: es === "none" || es === "noemail" });
    if (siteUrl(r)) items.push({ label: "Visit site ↗", value: "visit" });
    if (items.length) items.push({ divider: true });
  }
  items.push({ label: "Open in sheet", value: "sheet", disabled: !sheet, desc: sheet ? "" : r.isNew ? "Reaches the Google Sheet on the next weekday morning" : "" });
  items.push({ label: "Copy link", value: "link" }, { label: "Copy ID", value: "id" }, { divider: true });
  items.push({ label: state.showAll ? "Show fewer fields" : "Show all fields", value: "all" });
  items.push({ label: "See all changes", value: "history" });
  const v = await openMenu(b, { items, label: "More actions" });
  if (!v || !state || state.id !== r.id) return;
  if (v === "copy-email") copyEmail();
  else if (v === "visit") window.open(siteUrl(r), "_blank", "noopener");
  else if (v === "sheet") {
    await copyText(r.id);
    window.open(sheet, "_blank", "noopener");
    toast(sheetToast(r.id), { kind: "info" });
  } else if (v === "link") {
    const ok = await copyText(location.href);
    toast(ok ? "Link copied" : "Couldn't copy the link.", { kind: ok ? "success" : "error" });
  } else if (v === "id") {
    const ok = await copyText(r.id);
    toast(ok ? r.id + " copied" : "Couldn't copy the ID.", { kind: ok ? "success" : "error" });
  } else if (v === "all") {
    state.showAll = !state.showAll;
    state.detailsOpen = false;
    draw(["deal", "place", "details"]);
    if (state.showAll) {
      const d = state.el.querySelector('[data-psec="deal"]');
      if (d && d.scrollIntoView) d.scrollIntoView({ block: "nearest" });
    }
  } else if (v === "history") {
    router.go("history", { account: r.id });
  }
}

// ---------- Contacts and suggestions ----------

function openAdd(prefill, suggId) {
  state.add = Object.assign({ first_name: "", last_name: "", email: "", title: "", client: "", linkedin: "" }, prefill || {});
  if (!state.add.client) {
    const r = store.get(state.id);
    state.add.client = (r && r.cl && r.cl[0]) || "";
  }
  state.addErr = "";
  state.addField = "";
  state.addDupe = null;
  state.addSugg = suggId || null;
  draw(["contacts"]);
  const form = state.el.querySelector("[data-paddform]");
  if (!form) return;
  if (form.scrollIntoView) form.scrollIntoView({ block: "nearest" });
  const first = suggId ? form.elements.email : form.elements.first_name;
  if (first) first.focus({ preventScroll: true });
}

function closeAdd() {
  state.add = null;
  state.addErr = "";
  state.addField = "";
  state.addDupe = null;
  state.addSugg = null;
  draw(["contacts"]);
  const b = state.el.querySelector('[data-padd="open"]');
  if (b) b.focus({ preventScroll: true });
}

async function submitAdd(force) {
  const id = state.id;
  const rec = store.get(id);
  const form = state.el.querySelector("[data-paddform]");
  if (!rec || !form || state.addBusy) return;
  const c = readAddForm(form);
  state.add = c;
  const bad = checkContact(c);
  if (bad) {
    state.addErr = bad.error;
    state.addField = bad.field;
    draw(["contacts"]);
    const f = state.el.querySelector('[data-paddform] [name="' + bad.field + '"]');
    if (f) f.focus();
    return;
  }
  const label = labelOf(rec);
  const sugg = state.addSugg;
  state.addErr = "";
  state.addField = "";
  state.addBusy = true;
  if (!force) state.addDupe = null;
  draw(["contacts"]);
  const body = {};
  for (const k of ["first_name", "last_name", "title", "email", "linkedin", "client"]) if (c[k]) body[k] = c[k];
  let r = null;
  try {
    r = await api.addContact(id, body, { force: !!force });
    if (r == null) throw Object.assign(new Error("This isn't available yet. Nothing was saved."), { friendly: "This isn't available yet. Nothing was saved." });
  } catch (e) {
    if (e && e.status === 401) return;
    const why = (e && (e.friendly || e.message)) || "Try again.";
    if (state && state.id === id) {
      state.addBusy = false;
      state.addErr = "Not saved. " + why;
      draw(["contacts"]);
    } else {
      toast(label + " · Contact not added. " + why, { kind: "error" });
    }
    return;
  }
  if (r.conflict) {
    if (state && state.id === id) {
      state.addBusy = false;
      state.addDupe = r.duplicate || {};
      draw(["contacts"]);
      const b = state.el.querySelector('[data-padd="force"]');
      if (b) b.focus({ preventScroll: true });
    } else {
      toast(label + " · Not added: that email is already in the CRM.", { kind: "error" });
    }
    return;
  }
  // Added. A suggestion it came from is marked used (D1 only, no edits row).
  if (sugg) {
    try { await api.setSuggestion(sugg, "used"); } catch (e) { /* the contact is in; the row stays open */ }
    const p = profiles.get(id);
    for (const list of [state && state.id === id ? state.sugg : null, p && p.data ? p.data.suggestions : null]) {
      for (const s of Array.isArray(list) ? list : []) if (String(s.id) === String(sugg)) s.status = "used";
    }
  }
  const cur = store.get(id);
  if (cur) store.patchLocal(id, { contacts: (Number(cur.contacts) || 0) + 1 });
  profiles.delete(id);
  say(id, label, "Contact added. " + SYNC_SENTENCE);
  if (state && state.id === id) {
    state.add = null;
    state.addBusy = false;
    state.addDupe = null;
    state.addSugg = null;
    draw(["contacts", "sugg", "tools"]);
    loadProfile(id, { force: true });
  }
}

// After a deal or file write: the site row (its stage or clients may follow the deal), a fresh profile,
// and a note for the Deals page.
function dealSaved(id, r, text) {
  if (r && r.v2) store.upsert(r.v2);
  profiles.delete(id);
  bus.emit("deals:changed", { id });
  say(id, "", text + " " + SYNC_SENTENCE);
  if (state && state.id === id) loadProfile(id, { force: true });
}

function findSugg(sid) {
  return (Array.isArray(state.sugg) ? state.sugg : []).find((s) => String(s.id) === String(sid)) || null;
}

async function dismissSugg(sid) {
  const id = state.id;
  const label = labelOf(store.get(id));
  const s = findSugg(sid);
  if (!s) return;
  s.status = "dismissed";
  draw(["sugg"]);
  const back = () => {
    s.status = "open";
    if (state && state.id === id) draw(["sugg"]);
  };
  let r = null;
  let err = null;
  try { r = await api.setSuggestion(sid, "dismissed"); } catch (e) { err = e; }
  if (err || r == null) {
    if (err && err.status === 401) return;
    back();
    toast("Couldn't dismiss the suggestion. " + ((err && err.friendly) || "This isn't available yet."), { kind: "error" });
    return;
  }
  say(id, label, "Suggestion dismissed.", {
    undo: async () => {
      try {
        const u = await api.setSuggestion(sid, "open");
        if (u == null) throw new Error("not available");
        back();
        toast("Suggestion restored.", { kind: "info" });
      } catch (e) {
        if (!(e && e.status === 401)) toast("Couldn't restore the suggestion. Try again.", { kind: "error" });
      }
    },
  });
}

async function copySugg(sid) {
  const s = findSugg(sid);
  if (!s) return;
  const ok = await copyText(copyTextOf(s));
  toast(ok ? (s.kind === "slack_ask" ? "Message copied" : "Text copied") : "Couldn't copy the text.", { kind: ok ? "success" : "error" });
}

// ---------- Events ----------

function onKeydown(e) {
  if (e.key !== "Escape" || e.defaultPrevented) return;
  let other = null;
  try { other = document.querySelector(":popover-open:not(#toasts)"); } catch (x) { other = null; }
  if (other || document.querySelector("dialog[open]")) return;
  e.preventDefault();
  closeRecord();
}

function bind() {
  const el = state.el;
  const layer = state.layer;
  const offs = state.offs;
  const id = () => state.id;
  offs.push(trapFocus(layer));
  offs.push(on(layer, "click", "[data-pclose]", (e) => {
    e.preventDefault();
    closeRecord();
  }));
  offs.push(on(el, "keydown", null, onKeydown));
  offs.push(on(el, "click", "[data-pq]", (e, b) => step(Number(b.getAttribute("data-pq")) > 0 ? 1 : -1)));
  // Log what happened
  offs.push(on(el, "click", "[data-outcome]", (e, b) => clickOutcome(b, b.getAttribute("data-outcome"))));
  offs.push(on(el, "click", "[data-pmore]", (e, b) => moreOutcomes(b)));
  offs.push(on(el, "input", "[data-pnote]", (e, box) => {
    state.note = box.value;
    draw(["acts"]);
  }));
  offs.push(on(el, "click", "[data-pchip]", (e, b) => pickChip(b)));
  offs.push(on(el, "click", "[data-psave]", (e, b) => clickSave(b.getAttribute("data-psave"))));
  offs.push(on(el, "click", "[data-pretry]", () => {
    if (state && state.retry) state.retry();
  }));
  // Header
  offs.push(on(el, "click", "[data-pact]", (e, b) => {
    const act = b.getAttribute("data-pact");
    if (act === "copy-email") copyEmail();
    else if (act === "more") moreMenu(b);
  }));
  offs.push(on(el, "change", "[data-pwait]", async (e, box) => {
    const sid = id();
    box.disabled = true;
    await actions.setWaiting(sid, box.checked);
    if (state && state.id === sid) draw(["meta", "next"]);
  }));
  offs.push(on(el, "click", "[data-pabout-more]", () => {
    state.aboutOpen = !state.aboutOpen;
    draw(["about"]);
  }));
  // Timeline
  offs.push(on(el, "click", "[data-ptl]", () => {
    state.timelineAll = !state.timelineAll;
    draw(["timeline"]);
  }));
  offs.push(on(el, "click", "[data-pti]", (e, b) => {
    const k = b.getAttribute("data-pti");
    state.tlOpen[k] = !state.tlOpen[k];
    draw(["timeline"]);
  }));
  offs.push(on(el, "click", "[data-pnotes]", () => {
    state.notesOpen = !state.notesOpen;
    draw(["timeline"]);
  }));
  offs.push(on(el, "click", "[data-preload]", () => {
    state.profileState = "loading";
    draw(PROFILE_PARTS);
    loadProfile(id(), { force: true });
  }));
  // Contacts
  offs.push(on(el, "click", "[data-pcall]", () => {
    state.contactsAll = !state.contactsAll;
    draw(["contacts"]);
  }));
  offs.push(on(el, "click", "[data-pcopy]", async (e, b) => {
    const email = b.getAttribute("data-pcopy");
    const ok = await copyText(email);
    toast(ok ? "Copied " + email : "Couldn't copy the email.", { kind: ok ? "success" : "error" });
  }));
  offs.push(on(el, "click", "[data-psheet]", (e, a) => {
    const cid = a.getAttribute("data-psheet");
    copyText(cid);
    toast(sheetToast(cid), { kind: "info" });
  }));
  offs.push(on(el, "click", "[data-padd]", (e, b) => {
    const what = b.getAttribute("data-padd");
    if (what === "open") openAdd();
    else if (what === "cancel") closeAdd();
    else if (what === "force") submitAdd(true);
  }));
  offs.push(on(el, "input", "[data-paddform]", (e) => {
    const t = e.target;
    if (!state.add || !t || !t.name) return;
    state.add[t.name] = t.value;
  }));
  offs.push(on(el, "change", "[data-paddform] select", (e, s) => {
    if (state.add) state.add[s.name] = s.value;
  }));
  offs.push(on(el, "submit", "[data-paddform]", (e) => {
    e.preventDefault();
    submitAdd(false);
  }));
  offs.push(on(el, "click", "[data-popen]", (e, b) => {
    const other = b.getAttribute("data-popen");
    state.add = null;
    state.addDupe = null;
    openRecord(other);
  }));
  // Suggestions
  offs.push(on(el, "click", "[data-psugg-add]", (e, b) => {
    const s = findSugg(b.getAttribute("data-psugg-add"));
    if (!s) return;
    openAdd(Object.assign(splitName(s.name), { title: s.title || "", linkedin: s.linkedin || "", client: s.client || "" }), s.id);
  }));
  offs.push(on(el, "click", "[data-psugg-dismiss]", (e, b) => dismissSugg(b.getAttribute("data-psugg-dismiss"))));
  offs.push(on(el, "click", "[data-psugg-copy]", (e, b) => copySugg(b.getAttribute("data-psugg-copy"))));
  offs.push(on(el, "click", "[data-psugg-more]", (e, b) => {
    const sid = b.getAttribute("data-psugg-more");
    state.suggOpen[sid] = !state.suggOpen[sid];
    draw(["sugg"]);
  }));
  // Deal terms, Placement, Details
  offs.push(on(el, "click", "[data-pdeal]", async (e, b) => {
    const sid = id();
    await editDeal(b, store.get(sid));
    if (state && state.id === sid) draw(RECORD_PARTS);
  }));
  offs.push(on(el, "click", "[data-pplace]", async (e, b) => {
    const sid = id();
    await editPlacement(b, store.get(sid));
    if (state && state.id === sid) draw(RECORD_PARTS);
  }));
  // Deals and file links (migration 006): modals, then a fresh profile.
  offs.push(on(el, "click", "[data-pdl]", async (e, b) => {
    const sid = id();
    const rec = store.get(sid);
    if (!rec || readOnly()) return;
    const deals = profileDeals(state) || [];
    const deal = b.getAttribute("data-pdl") === "edit" ? deals.find((d) => d.id === b.getAttribute("data-deal")) || null : null;
    const r = await openDealForm(rec, deal);
    if (r) dealSaved(sid, r, deal ? "Deal saved." : "Deal added.");
  }));
  offs.push(on(el, "click", "[data-pfl]", async () => {
    const sid = id();
    const rec = store.get(sid);
    if (!rec || readOnly()) return;
    const r = await openFileForm(rec, profileDeals(state) || []);
    if (r) dealSaved(sid, r, "File link added.");
  }));
  offs.push(on(el, "toggle", "[data-pdetails]", (e, d) => {
    if (e.target === d) state.detailsOpen = d.open;
  }));
  // Phone footer: Log what happened ▾ and Follow up ▾ (⋯ is [data-pact="more"]).
  offs.push(on(el, "click", "[data-pfoot]", async (e, b) => {
    const sid = id();
    const rec = store.get(sid);
    if (!rec || state.busy) return;
    const r = b.getAttribute("data-pfoot") === "log"
      ? await actions.logMenu(b, rec, { note: state.note, followUp: chipValue(state) })
      : await actions.followUpMenu(b, rec);
    if (r) saved(sid);
  }));
  // Stage, owner, clients, next step and type editors (inline-edit.js).
  offs.push(bindInlineEdits(el, { getRecord: (k) => store.get(k), onDone: () => draw(RECORD_PARTS) }));
  offs.push(store.subscribe((n) => {
    if (!state) return;
    if (n && n.ids && !n.ids.includes(state.id)) return;
    if (!store.get(state.id)) return;
    draw(state.profile ? RECORD_PARTS : RECORD_PARTS.concat(["contacts"]));
  }));
}
