// Add site (spec 3 F4, 4.3, 7.2 F7) and the exact duplicate check. Owner F7. No side effects at import time.
//
// openAddSite(prefill) opens a modal form. prefill: a website or a name (string), or
// {domain, name, clients, owner, type, stage, next_step, next_due, notes}.
// - Website: the duplicate check runs on the in-memory list as you type, with the rules of lib/crm.js
//   findDomain(): the same site, a subdomain either way, or a channel path on the same host. normDomain()
//   cleans the input first, so a pasted URL, a www. address and a trailing path find the same site. Hosts
//   are compared label by label, never as substrings (e.example.test never matches dupe.example.test).
// - A duplicate shows "Already in the CRM" with [Open site] [Ask <owner> (copy message)] [Add anyway]. The
//   server's 409 (a site the page hasn't loaded yet) shows the same box.
// - Clients: chips for the active clients; Melograno opens its products; "Other…" takes a typed name (2-40
//   characters, no commas or slashes). Every token it adds uses the canonical name (spec D8).
// - Owner (me first) and Type (pick-list); stage, follow-up date, next step and notes under "More details".
// - Name (P1): prefilled from GET /api/about?domain= while the field is untouched, and a "similar name" hint
//   (Levenshtein distance <= 2) that never blocks.
// - Discard guard on ×, Esc, the backdrop and Cancel. The modal's footer stays in view (a bottom sheet on
//   phones, where nothing gets focus on open, so the keyboard doesn't cover the form).
// - On success the store gets the v2 row, the site opens and the toast says "Added. It reaches the Google
//   Sheet on the next weekday morning."
// search.js uses domainKey, domainMatch and findDuplicates (this module never imports search.js).
import { html, render, on, copyText } from "../core/dom.js";
import { normDomain, normName } from "../core/format.js";
import * as store from "../core/store.js";
import * as metaMod from "../core/meta.js";
import * as me from "../core/me.js";
import { api, readOnlyText } from "../core/api.js";
import { openModal, confirm } from "../ui/dialog.js";
import { toast } from "../ui/toast.js";
import { stageDot } from "../ui/pills.js";
import { openRecord } from "./record/index.js";

const ADDED = "Added. It reaches the Google Sheet on the next weekday morning.";
const NOT_SITE = "That doesn't look like a website address.";
const NEED_ONE = "Add a website or a name.";
const TEST = "Nothing is sent from this site.";
// The v1 row of POST /api/partners (used only when the response has no v2 row).
const V1_COLS = ["id", "domain", "name", "type", "dr", "traffic", "owner", "stage", "last_touch", "clients", "country",
  "contacts", "next_step", "next_due", "deal_model", "deal_flat", "deal_pct", "deal_value", "live_date", "content_url"];

const meta = () => metaMod.get();
const has = (v) => v != null && String(v).trim() !== "";

// ---------- Domain matching (shared with search.js) ----------

// A stored domain as findDomain() compares it (lower-case, no "www."), also cleaned of a scheme, "m.", a
// query or hash and trailing slashes, which a sheet cell sometimes holds. "" when there is none.
export function domainKey(domain) {
  const d = String(domain == null ? "" : domain).trim().toLowerCase();
  if (!d) return "";
  return d.replace(/^[a-z][a-z0-9+.-]*:\/\//, "").replace(/^(www|m)\./, "").split(/[?#\s]/)[0].replace(/\/+$/, "");
}

// How a stored domain key d relates to a cleaned input q (normDomain): 'exact' (the same site), 'path' (d is
// a channel or path on q), 'sub' (d is a subdomain of q), 'parent' (q is a subdomain of d), or '' (no match).
// These are findDomain()'s four rules, so the page and the server's 409 agree.
export function domainMatch(q, d) {
  if (!q || !d) return "";
  if (d === q) return "exact";
  const lq = q.length;
  const ld = d.length;
  if (ld > lq + 1) {
    if (d.charCodeAt(lq) === 47 && d.startsWith(q)) return "path"; // "/"
    if (d.charCodeAt(ld - lq - 1) === 46 && d.endsWith(q)) return "sub"; // "."
  }
  if (lq > ld + 1 && q.charCodeAt(lq - ld - 1) === 46 && q.endsWith(d)) return "parent";
  return "";
}

const KIND_ORDER = { exact: 0, path: 1, sub: 2, parent: 3 };
const keys = new WeakMap();

function keyOf(rec) {
  let k = keys.get(rec);
  if (k === undefined) {
    k = domainKey(rec.domain);
    keys.set(rec, k);
  }
  return k;
}

// The sites whose domain matches the input (any text: a URL, a www. host, a bare domain or a channel URL),
// exact matches first, at most `max` (findDomain() returns 5). [{record, kind}].
export function findDuplicates(records, input, { max = 5 } = {}) {
  const q = normDomain(input);
  if (!q) return [];
  const out = [];
  for (const r of records || []) {
    if (!r || !r.domain) continue;
    const kind = domainMatch(q, keyOf(r));
    if (kind) out.push({ record: r, kind });
  }
  out.sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || String(a.record.id).localeCompare(String(b.record.id)));
  return out.slice(0, max);
}

// ---------- Similar names (P1) ----------

// Levenshtein distance, or max + 1 as soon as it is certainly larger than max.
export function distance(a, b, max = 2) {
  if (a === b) return 0;
  const la = a.length;
  const lb = b.length;
  if (Math.abs(la - lb) > max) return max + 1;
  let prev = new Array(lb + 1);
  let cur = new Array(lb + 1);
  for (let j = 0; j <= lb; j++) prev[j] = j;
  for (let i = 1; i <= la; i++) {
    cur[0] = i;
    let best = i;
    const ca = a.charCodeAt(i - 1);
    for (let j = 1; j <= lb; j++) {
      const v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ca === b.charCodeAt(j - 1) ? 0 : 1));
      cur[j] = v;
      if (v < best) best = v;
    }
    if (best > max) return max + 1;
    const t = prev;
    prev = cur;
    cur = t;
  }
  return prev[lb];
}

const names = new WeakMap();
function nameOf(rec) {
  let n = names.get(rec);
  if (n === undefined) {
    n = normName(rec.name || "");
    names.set(rec, n);
  }
  return n;
}

// Sites whose name is the same or nearly the same as the typed one (distance <= 1 below 8 characters,
// <= 2 from 8). Names under 4 characters are not compared. [{record, d}], closest first, at most max.
export function similarNames(records, name, { max = 2, skip = new Set() } = {}) {
  const q = normName(name);
  if (q.length < 4) return [];
  const limit = q.length < 8 ? 1 : 2;
  const out = [];
  for (const r of records || []) {
    if (!r || skip.has(r.id)) continue;
    const n = nameOf(r);
    if (!n || Math.abs(n.length - q.length) > limit) continue;
    const d = distance(q, n, limit);
    if (d <= limit) out.push({ record: r, d });
  }
  out.sort((a, b) => a.d - b.d || String(a.record.label || a.record.name).localeCompare(String(b.record.label || b.record.name)));
  return out.slice(0, max);
}

// ---------- Small helpers ----------

let current = null; // the open form's state, or null

// True while the Add site form holds something the person typed (for a beforeunload guard).
export function isDirty() {
  return !!(current && current.dirty && current.dirty());
}

const chipKey = (k, product) => String(k || "").toLowerCase() + "|" + String(product || "").toLowerCase();

function canonicalToken(c, product) {
  if (!product) return c.name;
  return (c.token || "{name} - {product}").replace("{name}", c.name).replace("{product}", product);
}

function activeClients() {
  return (meta().clients || []).filter((c) => c && c.k != null && !c.past);
}

function teamList() {
  return (meta().team || []).filter((t) => t && t.name && t.active !== false).map((t) => String(t.name))
    .sort((a, b) => a.localeCompare(b));
}

function stageList() {
  const m = meta();
  return (m.stages || []).filter((s) => s && s.name && (!s.flag || (m.features && m.features[s.flag])))
    .slice().sort((a, b) => (a.order || 0) - (b.order || 0)).map((s) => s.name);
}

// Chips for a clients value: known clients use their canonical names, anything else stays as typed.
function tokensFrom(raw) {
  const out = [];
  for (const t of String(raw == null ? "" : raw).split(/\s*[,/]\s*/)) {
    const s = t.trim();
    if (!s) continue;
    const c = metaMod.client(meta(), s);
    const full = c ? (meta().clients || []).concat(meta().past_clients || []).find((x) => x.k === c.k) : null;
    const key = c ? chipKey(c.k, c.product) : chipKey(s.toLowerCase(), "");
    if (!out.some((x) => x.key === key)) out.push({ key, token: full ? canonicalToken(full, c.product || "") : s });
  }
  return out;
}

function normalizePrefill(p) {
  if (p == null) return {};
  if (typeof p === "string") return normDomain(p) ? { domain: p.trim() } : { name: p.trim() };
  if (typeof p === "object") return Object.assign({}, p);
  return {};
}

// "Ask <owner>" only for an active team member who isn't me.
function askable(owner) {
  return has(owner) && owner !== me.get() && teamList().includes(owner);
}

// The message "Ask <owner>" copies (spec 3 F4). Nothing is sent from the site.
export function askMessage(dupe, { me: who, clients = [] } = {}) {
  const site = dupe.label && dupe.domain && dupe.label !== dupe.domain ? dupe.domain + " (" + dupe.label + ")" : dupe.domain || dupe.label;
  const forWhat = clients.length ? " for " + clients.join(", ") : "";
  const stage = dupe.stage ? ", " + dupe.stage : "";
  return "Hi " + dupe.owner + ", " + site + " is yours in the CRM (" + dupe.id + stage + "). I'd like to pitch it" + forWhat +
    ". OK if I reach out, or would you rather do it?" + (who ? " " + who : "");
}

// "Mashable | Tech news" -> "Mashable": a page title up to its first separator, at most 120 characters.
export function nameFromTitle(title) {
  const t = String(title == null ? "" : title).replace(/\s+/g, " ").trim();
  if (!t) return "";
  const first = t.split(/\s+[|·•–—-]\s+|\s*:\s+/)[0].trim();
  return (first.length >= 2 ? first : t).slice(0, 120);
}

// ---------- Markup ----------

function chipsHtml(st) {
  const picked = new Set(st.picked.map((t) => t.key));
  const chip = (key, label) => html`<button type="button" class="ui-chipbtn" aria-pressed="${picked.has(key) ? "true" : "false"}" data-chip="${key}">${label}</button>`;
  const main = [];
  const known = new Set();
  let products = null;
  for (const c of activeClients()) {
    if (c.products && c.products.length) {
      for (const p of c.products) known.add(chipKey(c.k, p));
      const n = c.products.filter((p) => picked.has(chipKey(c.k, p))).length;
      const open = st.open === c.k || n > 0;
      main.push(html`<button type="button" class="ui-chipbtn is-group" aria-expanded="${open ? "true" : "false"}" aria-controls="se-add-products" data-group="${c.k}">${c.name}${n ? " · " + n : ""} ▾</button>`);
      if (open) products = c;
    } else {
      known.add(chipKey(c.k, ""));
      main.push(chip(chipKey(c.k, ""), c.name));
    }
  }
  // Typed ("Other…") and prefilled unknown tokens are chips too, so a click removes them.
  for (const t of st.picked) if (!known.has(t.key)) main.push(chip(t.key, t.token));
  main.push(html`<button type="button" class="ui-chipbtn is-other" aria-expanded="${st.other ? "true" : "false"}" aria-controls="se-add-otherbox" data-other-toggle>Other…</button>`);
  const prod = products
    ? html`<p class="se-products-h" id="se-add-products-h">${products.name}: pick the product</p><div class="ui-chips" role="group" aria-labelledby="se-add-products-h">${products.products.map((p) => chip(chipKey(products.k, p), p))}</div>`
    : "";
  return html`<div class="ui-chips">${main}</div><div class="se-products" id="se-add-products"${products ? "" : html` hidden`}>${prod}</div>`;
}

function bodyHtml(st) {
  const m = meta();
  const mine = me.get() || "";
  const owners = [{ v: mine, t: mine ? mine + " (me)" : "Me" }].concat(teamList().filter((n) => n !== mine).map((n) => ({ v: n, t: n })));
  if (has(st.init.owner) && !owners.some((o) => o.v === st.init.owner)) owners.push({ v: st.init.owner, t: st.init.owner });
  const ownerSel = has(st.init.owner) ? st.init.owner : mine;
  const types = (m.affiliate_types || []).slice();
  if (has(st.init.type) && !types.includes(st.init.type)) types.push(st.init.type);
  const stageSel = has(st.init.stage) ? st.init.stage : "New";
  const moreOpen = has(st.init.next_step) || has(st.init.next_due) || has(st.init.notes) || stageSel !== "New";
  return html`<div class="se-add">
<div class="ui-field">
  <label class="ui-label" for="se-add-domain">Website</label>
  <input id="se-add-domain" name="domain" class="ui-input" type="text" inputmode="url" autocomplete="off" autocapitalize="off" spellcheck="false" maxlength="300" placeholder="Paste a link, for example mashable.com" value="${st.init.domain || ""}" aria-describedby="se-add-domain-hint">
  <p class="se-hint" id="se-add-domain-hint" data-domain-hint>Paste any link to the site. It's checked against the CRM as you type.</p>
</div>
<div data-dupes></div>
<div class="ui-field">
  <label class="ui-label" for="se-add-name">Name <span class="se-opt">(optional)</span></label>
  <input id="se-add-name" name="name" class="ui-input" type="text" autocomplete="off" maxlength="120" placeholder="Leave empty to use the website" value="${st.init.name || ""}" aria-describedby="se-add-name-hint">
  <p class="se-hint" id="se-add-name-hint" data-name-hint hidden></p>
</div>
<fieldset class="ui-fieldset se-clients">
  <legend class="ui-label">Clients <span class="se-opt">(optional)</span></legend>
  <div data-chips>${chipsHtml(st)}</div>
  <div class="se-otherbox" id="se-add-otherbox" data-otherbox${st.other ? "" : html` hidden`}>
    <label class="sr-only" for="se-add-other">Other client</label>
    <input id="se-add-other" name="other" class="ui-input" type="text" autocomplete="off" maxlength="40" placeholder="Client name" aria-describedby="se-add-other-err">
    <button type="button" class="ui-btn" data-other-add>Add</button>
  </div>
  <p class="ui-error" id="se-add-other-err" data-other-err hidden></p>
</fieldset>
<div class="ui-grid2 se-pair">
  <div class="ui-field">
    <label class="ui-label" for="se-add-owner">Owner</label>
    <select id="se-add-owner" name="owner" class="ui-input">${owners.map((o) => html`<option value="${o.v}"${o.v === ownerSel ? html` selected` : ""}>${o.t}</option>`)}</select>
  </div>
  <div class="ui-field">
    <label class="ui-label" for="se-add-type">Type</label>
    <select id="se-add-type" name="type" class="ui-input"><option value="">Type not set</option>${types.map((t) => html`<option value="${t}"${t === st.init.type ? html` selected` : ""}>${t}</option>`)}</select>
  </div>
</div>
<details class="se-more"${moreOpen ? html` open` : ""}>
  <summary>More details <span class="se-opt">(stage, follow-up, notes)</span></summary>
  <div class="ui-grid2 se-pair">
    <div class="ui-field">
      <label class="ui-label" for="se-add-stage">Stage</label>
      <select id="se-add-stage" name="stage" class="ui-input">${stageList().map((s) => html`<option value="${s}"${s === stageSel ? html` selected` : ""}>${s}</option>`)}</select>
    </div>
    <div class="ui-field">
      <label class="ui-label" for="se-add-due">Follow-up date</label>
      <input id="se-add-due" name="next_due" class="ui-input" type="date" value="${st.init.next_due || ""}">
    </div>
    <div class="ui-field is-wide">
      <label class="ui-label" for="se-add-next">Next step</label>
      <input id="se-add-next" name="next_step" class="ui-input" type="text" autocomplete="off" maxlength="500" placeholder="For example: Find the editor's email" value="${st.init.next_step || ""}">
    </div>
    <div class="ui-field is-wide">
      <label class="ui-label" for="se-add-notes">Notes</label>
      <textarea id="se-add-notes" name="notes" class="ui-input" rows="3" maxlength="2000">${st.init.notes || ""}</textarea>
    </div>
  </div>
</details>
<p class="ui-error se-saveerr" data-err role="alert" hidden></p>
</div>`;
}

// One duplicate as the box shows it: {id, domain, label, owner, stage, cl, kind}.
function dupeOf(rec, kind) {
  return { id: String(rec.id), domain: rec.domain || "", label: rec.label || rec.name || rec.domain || String(rec.id),
    owner: rec.owner || "", stage: rec.stage || "", cl: rec.cl || [], kind };
}

// A row of the server's 409 ({id, domain, name, owner, stage, clients}); the store row when the page has it.
function dupeFromServer(row, input) {
  const rec = store.get(row.id);
  const kind = domainMatch(normDomain(input), domainKey(row.domain)) || "exact";
  if (rec) return dupeOf(rec, kind);
  const cl = [];
  for (const p of metaMod.splitClients(meta(), row.clients)) {
    const l = metaMod.clientLabel(meta(), p);
    if (!cl.includes(l)) cl.push(l);
  }
  return { id: String(row.id), domain: row.domain || "", label: row.name || row.domain || String(row.id), owner: row.owner || "",
    stage: row.stage || "", cl, kind };
}

const KIND_TEXT = { path: "a channel on this site", sub: "a subdomain of this address", parent: "the main site of this address" };

function dupesHtml(list) {
  if (!list.length) return html``;
  const mine = me.get();
  const many = list.length > 1;
  return html`<section class="se-dupe" aria-labelledby="se-dupe-h" data-dupe-box>
<p class="se-dupe-h" id="se-dupe-h"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3.5l9.5 16.5h-19z"/><path d="M12 10v4.5M12 17.5h.01"/></svg>Already in the CRM</p>
<ul class="se-dupe-list">${list.map((d) => html`<li class="se-dupe-row" data-dupe="${d.id}">
  <p class="se-dupe-site">${stageDot(d.stage)}<strong>${d.label}</strong>${d.domain && d.domain !== d.label ? html` <span class="se-dom">${d.domain}</span>` : ""}</p>
  <p class="se-dupe-meta">${[d.stage || "No stage", d.owner ? (d.owner === mine ? "owned by you" : "owned by " + d.owner) : "no owner",
    d.cl.length ? d.cl.join(", ") : ""].filter(Boolean).join(" · ")}${KIND_TEXT[d.kind] ? " · " + KIND_TEXT[d.kind] : ""}</p>
  <div class="se-dupe-acts">
    <button type="button" class="ui-btn is-sm" data-open-dupe="${d.id}"${many ? html` aria-label="${"Open " + d.label}"` : ""}>Open site</button>
    ${askable(d.owner) ? html`<button type="button" class="ui-btn is-sm" data-ask="${d.id}">Ask ${d.owner} (copy message)</button>` : ""}
  </div>
</li>`)}</ul>
<div class="se-dupe-foot"><span>A different site at this address?</span><button type="button" class="ui-btn is-sm" data-force>Add anyway</button></div>
</section>`;
}

function askDiscard() {
  return confirm({
    title: "Discard this site?",
    body: "What you typed here isn't saved.",
    confirmLabel: "Discard",
    cancelLabel: "Keep editing",
    danger: true,
  });
}

// Puts the new site into the store (the v2 row, else the v1 row) and returns its id.
function applyAdded(r) {
  if (Array.isArray(r.v2)) {
    const rec = store.upsert(r.v2);
    if (rec) return rec.id;
  }
  if (Array.isArray(r.row)) {
    const o = {};
    V1_COLS.forEach((k, i) => { o[k] = r.row[i] === "" ? null : r.row[i]; });
    o.source = "Added on site";
    o.updated_at = new Date().toISOString().replace(/\.\d+Z$/, "Z");
    o.updated_by = me.get() || null;
    const rec = store.upsert(o);
    if (rec) return rec.id;
  }
  return (r.row && r.row[0]) || null;
}

// ---------- Open ----------

export function openAddSite(prefill) {
  if (meta().read_only) {
    toast(readOnlyText(), { kind: "error" });
    return null;
  }
  if (current && current.modal) {
    current.focusFirst();
    return current.modal;
  }
  const init = normalizePrefill(prefill);
  const st = {
    init,
    picked: tokensFrom(init.clients),
    open: null,
    other: false,
    dupes: [],
    serverFor: null, // the website the server's 409 answered for
    saving: false,
    done: false,
    nameTouched: has(init.name),
    namePrefilled: "",
    aboutFor: "",
    timers: {},
    modal: null,
    dirty: () => false,
    focusFirst: () => {},
  };
  current = st;

  const modal = openModal({
    title: "Add site",
    size: "md",
    className: "se-addmodal",
    body: bodyHtml(st),
    canClose: () => st.done || !st.dirty() || askDiscard(),
    onClose: () => {
      for (const t of Object.values(st.timers)) clearTimeout(t);
      if (current === st) current = null;
    },
    actions: [
      { label: "Cancel", kind: "ghost", value: null, onClick: async () => (st.dirty() && !(await askDiscard()) ? false : undefined) },
      { label: "Add site", kind: "primary", onClick: () => { submit(false); return false; } },
    ],
  });
  st.modal = modal;
  const el = modal.el;
  const body = modal.body;
  const form = el.querySelector("form");
  const field = (n) => form.elements[n];
  const primary = el.querySelector(".ui-modal-foot [type=submit]");
  primary.setAttribute("data-add-submit", "");
  const domainInput = field("domain");
  const nameInput = field("name");
  const otherInput = field("other");
  const snapshot = () => JSON.stringify([domainInput.value.trim(), nameInput.value.trim(), st.picked.map((t) => t.key),
    otherInput.value.trim(), field("owner").value, field("type").value, field("stage").value, field("next_due").value,
    field("next_step").value.trim(), field("notes").value.trim()]);
  const initial = snapshot();
  st.dirty = () => !st.done && snapshot() !== initial;
  st.focusFirst = () => (domainInput.value.trim() ? nameInput : domainInput).focus();

  // ----- the duplicate check -----
  const domainHint = body.querySelector("[data-domain-hint]");
  const dupesEl = body.querySelector("[data-dupes]");
  const HINT = domainHint.textContent;

  function setDomainState(kind, text) {
    domainHint.textContent = text || HINT;
    domainHint.classList.toggle("is-ok", kind === "ok");
    domainHint.classList.toggle("is-error", kind === "error");
    if (kind === "error") domainInput.setAttribute("aria-invalid", "true");
    else domainInput.removeAttribute("aria-invalid");
  }

  function showDupes(list) {
    st.dupes = list;
    render(dupesEl, dupesHtml(list));
    primary.disabled = list.length > 0 || st.saving;
    primary.title = list.length ? "Already in the CRM. Open it, or choose Add anyway." : "";
  }

  function checkDomain({ strict = false } = {}) {
    const v = domainInput.value.trim();
    if (st.serverFor != null && st.serverFor === v) return; // keep the server's answer for this address
    st.serverFor = null;
    if (!v) {
      setDomainState("", "");
      showDupes([]);
      return;
    }
    const q = normDomain(v);
    if (!q) {
      showDupes([]);
      setDomainState(strict ? "error" : "", strict ? NOT_SITE : "");
      return;
    }
    const found = findDuplicates(store.all(), v).map((x) => dupeOf(x.record, x.kind));
    showDupes(found);
    if (found.length) setDomainState("", "Saved as " + q + ".");
    else {
      setDomainState("ok", "Not in the CRM yet. Saved as " + q + ".");
      scheduleAbout(q);
    }
    scheduleSimilar();
  }

  // ----- the name: prefill from the site's title, similar names (both P1) -----
  const nameHint = body.querySelector("[data-name-hint]");

  function setNameHint(content) {
    render(nameHint, content || html``);
    nameHint.hidden = !content;
  }

  function scheduleAbout(q) {
    clearTimeout(st.timers.about);
    if (st.nameTouched || q.includes("/") || st.aboutFor === q) return;
    st.timers.about = setTimeout(async () => {
      st.aboutFor = q;
      let r = null;
      try { r = await api.aboutDomain(q); } catch (e) { r = null; }
      const title = nameFromTitle(r && r.title);
      if (!title || st.done || st.nameTouched || normDomain(domainInput.value) !== q) return;
      nameInput.value = title;
      st.namePrefilled = title;
      scheduleSimilar();
    }, 450);
  }

  function scheduleSimilar() {
    clearTimeout(st.timers.similar);
    st.timers.similar = setTimeout(() => {
      const name = nameInput.value.trim();
      const skip = new Set(st.dupes.map((d) => d.id));
      const hits = name ? similarNames(store.all(), name, { skip }) : [];
      const from = st.namePrefilled && name === st.namePrefilled ? html`<span>From the site's title. Change it if it's wrong.</span>` : null;
      if (!hits.length) {
        setNameHint(from);
        return;
      }
      setNameHint(html`${from}${from ? html`<br>` : ""}<span class="se-similar">Similar name in the CRM: ${hits.map((h, i) => html`${i ? ", " : ""}<button type="button" class="se-linkbtn" data-open-dupe="${h.record.id}">${h.record.label || h.record.name}</button> (${h.record.owner || "no owner"})`)}</span>`);
    }, 200);
  }

  on(domainInput, "input", null, () => {
    if (st.namePrefilled && nameInput.value === st.namePrefilled && !st.nameTouched) {
      nameInput.value = "";
      st.namePrefilled = "";
    }
    clearSaveError();
    checkDomain();
  });
  on(domainInput, "blur", null, () => checkDomain({ strict: true }));
  on(nameInput, "input", null, () => {
    st.nameTouched = nameInput.value.trim() !== "" && nameInput.value !== st.namePrefilled;
    clearSaveError();
    scheduleSimilar();
  });

  // ----- client chips -----
  const chipsEl = body.querySelector("[data-chips]");
  const otherBox = body.querySelector("[data-otherbox]");
  const otherErr = body.querySelector("[data-other-err]");

  function drawChips(focus) {
    render(chipsEl, chipsHtml(st));
    if (!focus) return;
    const b = focus === "__other" ? chipsEl.querySelector("[data-other-toggle]")
      : chipsEl.querySelector('[data-chip="' + CSS.escape(focus) + '"],[data-group="' + CSS.escape(focus) + '"]');
    if (b) b.focus();
  }

  function otherError(msg) {
    otherErr.textContent = msg || "";
    otherErr.hidden = !msg;
    if (msg) otherInput.setAttribute("aria-invalid", "true");
    else otherInput.removeAttribute("aria-invalid");
    return !msg;
  }

  function addOther() {
    const v = String(otherInput.value || "").replace(/\s+/g, " ").trim();
    if (!v) return otherError("Type a client name.");
    if (v.length < 2 || v.length > 40) return otherError("Use 2 to 40 characters.");
    if (/[,/]/.test(v)) return otherError("Use one name without commas or slashes.");
    const [t] = tokensFrom(v);
    if (t && !st.picked.some((x) => x.key === t.key)) st.picked.push(t);
    otherInput.value = "";
    otherError("");
    drawChips();
    otherInput.focus();
    return true;
  }

  on(chipsEl, "click", "[data-chip]", (e, b) => {
    const key = b.getAttribute("data-chip");
    const i = st.picked.findIndex((t) => t.key === key);
    if (i >= 0) st.picked.splice(i, 1);
    else {
      const [k, product] = key.split("|");
      const c = activeClients().find((x) => String(x.k).toLowerCase() === k);
      const prod = c && c.products ? c.products.find((p) => p.toLowerCase() === product) : "";
      st.picked.push({ key, token: c ? canonicalToken(c, prod || "") : b.textContent.trim() });
    }
    drawChips(key);
  });
  on(chipsEl, "click", "[data-group]", (e, b) => {
    const k = b.getAttribute("data-group");
    st.open = b.getAttribute("aria-expanded") === "true" ? null : k;
    drawChips(k);
  });
  on(chipsEl, "click", "[data-other-toggle]", () => {
    st.other = !st.other;
    otherBox.hidden = !st.other;
    if (!st.other) otherError("");
    drawChips(st.other ? null : "__other");
    if (st.other) otherInput.focus();
  });
  on(otherBox, "click", "[data-other-add]", () => addOther());
  on(otherInput, "keydown", null, (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      addOther();
    }
  });

  // ----- the duplicate box -----
  on(body, "click", "[data-open-dupe]", (e, b) => {
    st.done = true; // the site exists: leave without the discard question
    modal.close(null);
    openRecord(b.getAttribute("data-open-dupe"));
  });
  on(body, "click", "[data-ask]", async (e, b) => {
    const d = st.dupes.find((x) => x.id === b.getAttribute("data-ask"));
    if (!d) return;
    const ok = await copyText(askMessage(d, { me: me.get(), clients: st.picked.map((t) => t.token) }));
    toast(ok ? "Message for " + d.owner + " copied. Paste it in Slack. " + TEST : "Couldn't copy the message. " + TEST,
      { kind: ok ? "success" : "error" });
  });
  on(body, "click", "[data-force]", () => submit(true));

  // ----- save -----
  const errEl = body.querySelector("[data-err]");
  function saveError(msg) {
    errEl.textContent = msg || "";
    errEl.hidden = !msg;
  }
  function clearSaveError() {
    if (!errEl.hidden) saveError("");
  }

  function read() {
    return {
      domain: domainInput.value.trim(),
      name: nameInput.value.trim(),
      owner: field("owner").value,
      stage: field("stage").value || "New",
      clients: st.picked.map((t) => t.token).join(", "),
      type: field("type").value,
      next_step: field("next_step").value.trim(),
      next_due: field("next_due").value,
      notes: field("notes").value.trim(),
    };
  }

  function busy(flag) {
    st.saving = flag;
    primary.textContent = flag ? "Adding…" : "Add site";
    primary.disabled = flag || st.dupes.length > 0;
    const force = body.querySelector("[data-force]");
    if (force) force.disabled = flag;
  }

  async function submit(force) {
    if (st.saving) return;
    if (otherInput.value.trim() && !addOther()) return;
    const v = read();
    if (!v.domain && !v.name) {
      setDomainState("error", NEED_ONE);
      domainInput.focus();
      return;
    }
    if (v.domain && !normDomain(v.domain)) {
      setDomainState("error", NOT_SITE);
      domainInput.focus();
      return;
    }
    if (!force && st.dupes.length) {
      const btn = body.querySelector("[data-open-dupe]");
      if (btn) btn.focus();
      return;
    }
    saveError("");
    busy(true);
    let r;
    try {
      r = await api.addSite(v, { force: !!force });
    } catch (e) {
      busy(false);
      if (e && e.status === 401) return;
      const msg = (e && (e.friendly || e.message)) || "Try again.";
      if (e && e.status === 400 && /website/i.test(msg)) setDomainState("error", msg);
      saveError("Not saved. " + msg);
      return;
    }
    busy(false);
    if (r == null) {
      saveError("Adding sites isn't available yet.");
      return;
    }
    if (r.conflict) {
      const list = (r.duplicates || []).map((row) => dupeFromServer(row, v.domain));
      st.serverFor = v.domain;
      showDupes(list);
      if (!list.length) saveError(r.error || "Already in the CRM.");
      const btn = body.querySelector("[data-open-dupe]");
      if (btn) btn.focus();
      return;
    }
    const id = applyAdded(r);
    st.done = true;
    modal.close(id);
    if (id) openRecord(id);
    toast(ADDED, { kind: "success" });
  }

  // Desktop: the cursor waits in the website field (paste right away, flow F4). Phones and touch screens:
  // nothing gets the cursor, so the keyboard doesn't cover the form (spec 4.12); the title takes focus.
  const touch = typeof matchMedia === "function" && matchMedia("(max-width: 639.98px), (pointer: coarse)").matches;
  if (touch) {
    const h = el.querySelector(".ui-modal-title");
    if (h) h.focus({ preventScroll: true });
  } else {
    st.focusFirst();
  }
  if (init.domain) checkDomain();
  return modal;
}
