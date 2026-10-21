// Inline editors: stage, owner, next step, clients, type, follow-up date (spec 4.4). Owner G1-C.
// No side effects at import time. Every save goes through actions.js (optimistic, Undo toast).
//
// editField(anchorEl, record, field, {onFilter}) opens the editor for one field:
//   'stage'   menu of stages with descriptions (Researching under More; Do not contact only with the
//             flag). Lost opens the Not interested reason form; Do not contact its reason form.
//   'owner'   me first, then the team, "No owner", and an existing non-team value as "past owner".
//   'next'    next step text + date in one PATCH; the "Waiting on client: " prefix is kept.
//   'clients' chips: active clients, Melograno (opens its products), past clients, "Other…" (2-40
//             characters, no commas). Stored tokens are kept exactly (order, spelling and "/" groups);
//             added tokens use canonical names (spec D8).
//   'type'    meta.affiliate_types plus the current value.
//   'due'     the Follow up menu (date chips).
//   'waiting' toggles "Waiting on client".
// Menus end with "Filter by this" when opts.onFilter(param, value) is given (adds a URL chip).
// bindInlineEdits(root, {getRecord, onFilter, onDone}) wires [data-edit] buttons (pills.js) and
// [data-row-act] buttons (log, follow, claim, assign, outcome) inside root with one delegated listener.
import { html, raw, on, render } from "../core/dom.js";
import * as store from "../core/store.js";
import * as metaMod from "../core/meta.js";
import * as me from "../core/me.js";
import { parseNext, setWaitingOnClient } from "../core/model.js";
import { openMenu, openPopover } from "./menu.js";
import * as actions from "./actions.js";

const meta = () => metaMod.get();
const FILTER_ITEM = "\u0000filter";

function team() {
  return (meta().team || []).filter((t) => t && t.active !== false).map((t) => t.name).filter(Boolean);
}

function withFilter(items, opts, label) {
  if (typeof opts.onFilter !== "function") return items;
  return items.concat([{ divider: true }, { label: "Filter by this", value: FILTER_ITEM, desc: label }]);
}

// ---------- Stage ----------

async function editStage(anchor, record, opts) {
  const m = meta();
  const cur = record.stage || "";
  const stages = (m.stages || []).slice().sort((a, b) => (a.order || 0) - (b.order || 0));
  const dnc = !!(m.features && m.features.dnc);
  const main = stages.filter((s) => s.in_path || s.name === "Lost" || s.name === cur);
  const extra = stages.filter((s) => !main.includes(s) && (s.name !== "Do not contact" || dnc));
  const item = (s) => ({ label: s.name, value: s.name, desc: s.desc, checked: s.name === cur });
  const items = main.filter((s) => s.name !== "Do not contact" || dnc || s.name === cur).map(item);
  if (extra.length) items.push({ label: "More", more: extra.map(item) });
  const v = await openMenu(anchor, { items: withFilter(items, opts, cur ? "Show only " + cur : "Show sites without a stage"), label: "Stage" });
  if (v == null) return null;
  if (v === FILTER_ITEM) {
    opts.onFilter("stage", cur || null);
    return null;
  }
  if (v === cur) return null;
  if (v === "Lost") return actions.runOutcome(anchor, record, "not_interested", { onAddTerms: opts.onAddTerms });
  if (v === "Do not contact") return actions.runOutcome(anchor, record, "dnc", {});
  return actions.update(record.id, { stage: v });
}

// ---------- Owner ----------

async function editOwner(anchor, record, opts) {
  const cur = record.owner ? String(record.owner) : "";
  const mine = me.get();
  const names = team();
  const items = [];
  if (mine) items.push({ label: mine, value: mine, hint: "me", checked: cur === mine });
  for (const n of names) if (n !== mine) items.push({ label: n, value: n, checked: cur === n });
  items.push({ label: "No owner", value: "", checked: !cur });
  if (cur && cur !== mine && !names.includes(cur)) items.push({ label: cur, value: cur, desc: "past owner", checked: true });
  const filterValue = !cur ? "none" : cur === mine ? "me" : cur;
  const v = await openMenu(anchor, { items: withFilter(items, opts, cur ? "Show only " + cur + "'s sites" : "Show sites with no owner"), label: "Owner", search: items.length > 8 });
  if (v == null) return null;
  if (v === FILTER_ITEM) {
    opts.onFilter("owner", filterValue);
    return null;
  }
  if (v === cur) return null;
  return actions.update(record.id, { owner: v });
}

// ---------- Type ----------

async function editType(anchor, record, opts) {
  const cur = record.type ? String(record.type) : "";
  const list = (meta().affiliate_types || []).slice();
  if (cur && !list.includes(cur)) list.push(cur);
  const items = list.map((t) => ({ label: t, value: t, checked: t === cur }));
  items.push({ label: "Type not set", value: "", checked: !cur });
  const v = await openMenu(anchor, { items: withFilter(items, opts, cur ? "Show only " + cur : "Show sites with no type"), label: "Type", search: items.length > 8 });
  if (v == null) return null;
  if (v === FILTER_ITEM) {
    opts.onFilter("type", cur || "none");
    return null;
  }
  if (v === cur) return null;
  return actions.update(record.id, { type: v });
}

// ---------- Next step ----------

function editNext(anchor, record) {
  const parsed = parseNext(record.next_step);
  const showWaiting = parsed.waitingOnClient || record.stage === "Replied" || record.stage === "Negotiating";
  return new Promise((resolve) => {
    let saving = null;
    const pop = openPopover(anchor, html`<form class="ui-form" novalidate><h3 class="ui-pop-title">Next step</h3>
<label class="ui-field"><span class="ui-label">What's next</span><input type="text" name="text" class="ui-input" maxlength="480" value="${parsed.text}" autocomplete="off"></label>
<label class="ui-field"><span class="ui-label">Due</span><input type="date" name="due" class="ui-input" value="${record.next_due || ""}"></label>
${showWaiting ? html`<label class="ui-check"><input type="checkbox" name="waiting"${parsed.waitingOnClient ? raw(" checked") : ""}><span>Waiting on client</span></label>` : ""}
<div class="ui-form-acts"><button type="button" class="ui-btn is-ghost" data-f="cancel">Cancel</button><button type="submit" class="ui-btn is-primary">Save</button></div></form>`, {
      label: "Next step",
      className: "ui-pop-form",
      manual: true,
      onClose: () => resolve(saving ? saving : null),
      onOpen(el) {
        const form = el.querySelector("form");
        on(el, "click", '[data-f="cancel"]', () => pop.close());
        on(form, "submit", null, (e) => {
          e.preventDefault();
          const text = String(form.elements.text.value || "").trim();
          const waiting = form.elements.waiting ? form.elements.waiting.checked : parsed.waitingOnClient;
          const next = waiting ? setWaitingOnClient(text, true) : text;
          const due = String(form.elements.due.value || "");
          const fields = {};
          if (next !== String(record.next_step || "")) fields.next_step = next;
          if (due !== String(record.next_due || "")) fields.next_due = due;
          saving = Object.keys(fields).length ? actions.update(record.id, fields, { label: "Next step saved" }) : Promise.resolve(null);
          pop.close();
        });
      },
    });
    if (!pop.el) resolve(null);
  });
}

// ---------- Clients ----------

const keyOf = (k, product) => String(k || "").toLowerCase() + "|" + String(product || "").toLowerCase();

// The stored value as comma segments of "/"-separated tokens, each with its client key.
export function parseClients(raw) {
  const m = meta();
  const segs = String(raw == null ? "" : raw).split(/\s*,\s*/).filter((s) => s.trim());
  return segs.map((seg) => seg.split(/\s*\/\s*/).filter((t) => t.trim()).map((t) => {
    const c = metaMod.client(m, t);
    return { raw: t.trim(), key: c ? keyOf(c.k, c.product) : keyOf(t.trim().toLowerCase(), ""), known: !!c };
  }));
}

export function joinClients(segs) {
  return segs.map((seg) => seg.map((t) => t.raw).join("/")).filter(Boolean).join(", ");
}

// The token a chip adds: the canonical name, or "Melograno - Trafft" for a product.
function canonicalToken(c, product) {
  if (!product) return c.name;
  const tpl = c.token || "{name} - {product}";
  return tpl.replace("{name}", c.name).replace("{product}", product);
}

// Toggles one client (by key) in the parsed value. Removing keeps the other tokens exactly.
export function toggleClient(segs, key, token) {
  const present = segs.some((seg) => seg.some((t) => t.key === key));
  if (present) {
    return segs.map((seg) => seg.filter((t) => t.key !== key)).filter((seg) => seg.length);
  }
  return segs.concat([[{ raw: token, key, known: true }]]);
}

function clientsBody(segs, state) {
  const m = meta();
  const selected = new Set();
  for (const seg of segs) for (const t of seg) selected.add(t.key);
  const chip = (key, label, extra = "") => html`<button type="button" class="ui-chipbtn${extra}" aria-pressed="${selected.has(key) ? "true" : "false"}" data-key="${key}">${label}</button>`;
  const active = (m.clients || []).filter((c) => !c.past);
  const groups = [];
  const main = [];
  let productClient = null;
  for (const c of active) {
    if (c.products && c.products.length) {
      productClient = c;
      const any = c.products.some((p) => selected.has(keyOf(c.k, p)));
      main.push(html`<button type="button" class="ui-chipbtn is-group" aria-expanded="${state.open || any ? "true" : "false"}" data-group="${c.k}">${c.name} ▾</button>`);
    } else {
      main.push(chip(keyOf(c.k, ""), c.name));
    }
  }
  groups.push(html`<fieldset class="ui-fieldset"><legend class="ui-label">Clients</legend><div class="ui-chips">${main}</div></fieldset>`);
  if (productClient) {
    const c = productClient;
    const any = c.products.some((p) => selected.has(keyOf(c.k, p)));
    if (state.open || any) {
      groups.push(html`<fieldset class="ui-fieldset"><legend class="ui-label">${c.name} products</legend><div class="ui-chips">${c.products.map((p) => chip(keyOf(c.k, p), p))}</div></fieldset>`);
    }
  }
  const past = m.past_clients || [];
  if (past.length) {
    groups.push(html`<fieldset class="ui-fieldset"><legend class="ui-label">Past clients</legend><div class="ui-chips">${past.map((c) => chip(keyOf(c.k, ""), c.name))}</div></fieldset>`);
  }
  // Tokens on this site that no chip above covers (unknown names, a plain "Melograno").
  const covered = new Set();
  for (const c of active) {
    if (c.products && c.products.length) for (const p of c.products) covered.add(keyOf(c.k, p));
    else covered.add(keyOf(c.k, ""));
  }
  for (const c of past) covered.add(keyOf(c.k, ""));
  const others = [];
  for (const seg of segs) for (const t of seg) if (!covered.has(t.key) && !others.some((o) => o.key === t.key)) others.push(t);
  if (others.length) {
    groups.push(html`<fieldset class="ui-fieldset"><legend class="ui-label">Also on this site</legend><div class="ui-chips">${others.map((t) => chip(t.key, t.raw))}</div></fieldset>`);
  }
  return html`${groups}`;
}

function editClients(anchor, record) {
  let segs = parseClients(record.clients);
  const state = { open: false };
  return new Promise((resolve) => {
    let saving = null;
    const pop = openPopover(anchor, html`<form class="ui-form ui-clients-form" novalidate><h3 class="ui-pop-title">Clients</h3>
<div data-chips></div>
<div class="ui-field"><label class="ui-label" for="ui-other-client">Other…</label><div class="ui-inline"><input id="ui-other-client" type="text" name="other" class="ui-input" maxlength="40" placeholder="Client name" autocomplete="off"><button type="button" class="ui-btn" data-f="other">Add</button></div></div>
<p class="ui-error" id="ui-clients-err" role="alert" hidden></p>
<p class="ui-faint ui-small" data-preview></p>
<div class="ui-form-acts"><button type="button" class="ui-btn is-ghost" data-f="cancel">Cancel</button><button type="submit" class="ui-btn is-primary">Save</button></div></form>`, {
      label: "Clients",
      className: "ui-pop-form is-wide",
      manual: true,
      onClose: () => resolve(saving ? saving : null),
      onOpen(el) {
        const form = el.querySelector("form");
        const chips = el.querySelector("[data-chips]");
        const err = el.querySelector(".ui-error");
        const preview = el.querySelector("[data-preview]");
        const draw = (focusKey) => {
          render(chips, clientsBody(segs, state));
          const v = joinClients(segs);
          preview.textContent = v ? "Saved as: " + v : "No clients";
          if (focusKey) {
            const b = chips.querySelector('[data-key="' + CSS.escape(focusKey) + '"],[data-group="' + CSS.escape(focusKey) + '"]');
            if (b) b.focus();
          }
        };
        const fail = (msg) => {
          err.textContent = msg;
          err.hidden = !msg;
          const input = form.elements.other;
          if (msg) {
            input.setAttribute("aria-invalid", "true");
            input.setAttribute("aria-describedby", "ui-clients-err");
          } else {
            input.removeAttribute("aria-invalid");
          }
        };
        draw();
        on(chips, "click", "[data-group]", (e, b) => {
          state.open = !(b.getAttribute("aria-expanded") === "true");
          draw(b.getAttribute("data-group"));
        });
        on(chips, "click", "[data-key]", (e, b) => {
          const key = b.getAttribute("data-key");
          const [k, product] = key.split("|");
          const m = meta();
          const c = (m.clients || []).concat(m.past_clients || []).find((x) => String(x.k).toLowerCase() === k);
          const prodName = c && c.products ? c.products.find((p) => p.toLowerCase() === product) : null;
          const token = c ? canonicalToken(c, prodName || "") : b.textContent.trim();
          segs = toggleClient(segs, key, token);
          fail("");
          draw(key);
        });
        const addOther = () => {
          const input = form.elements.other;
          const v = String(input.value || "").replace(/\s+/g, " ").trim();
          if (!v) return fail("Type a client name.");
          if (v.length < 2 || v.length > 40) return fail("Use 2 to 40 characters.");
          if (/[,/]/.test(v)) return fail("Use one name without commas or slashes.");
          const c = metaMod.client(meta(), v);
          const key = c ? keyOf(c.k, c.product) : keyOf(v.toLowerCase(), "");
          if (!segs.some((seg) => seg.some((t) => t.key === key))) {
            const full = c ? (meta().clients || []).concat(meta().past_clients || []).find((x) => x.k === c.k) : null;
            segs = segs.concat([[{ raw: full ? canonicalToken(full, c.product || "") : v, key, known: !!c }]]);
          }
          input.value = "";
          fail("");
          draw();
        };
        on(form, "click", '[data-f="other"]', addOther);
        on(form, "keydown", 'input[name="other"]', (e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            addOther();
          }
        });
        on(el, "click", '[data-f="cancel"]', () => pop.close());
        on(form, "submit", null, (e) => {
          e.preventDefault();
          if (String(form.elements.other.value || "").trim()) addOther();
          const v = joinClients(segs);
          if (v.length > 200 || segs.length > 12) return fail("That's too many clients for one site.");
          saving = v !== String(record.clients || "") ? actions.update(record.id, { clients: v }) : Promise.resolve(null);
          pop.close();
        });
      },
    });
    if (!pop.el) resolve(null);
  });
}

// ---------- Public ----------

export async function editField(anchorEl, record, field, opts = {}) {
  if (!record || meta().read_only) return null;
  const rec = store.get(record.id) || record;
  switch (field) {
    case "stage": return editStage(anchorEl, rec, opts);
    case "owner": return editOwner(anchorEl, rec, opts);
    case "type": return editType(anchorEl, rec, opts);
    case "next":
    case "next_step": return editNext(anchorEl, rec);
    case "clients": return editClients(anchorEl, rec);
    case "due":
    case "next_due": return actions.followUpMenu(anchorEl, rec, { onDone: opts.onDone });
    case "waiting": return actions.setWaiting(rec.id, !rec.waitingOnClient);
    default: return null;
  }
}

// One delegated click listener for the editable widgets and row action buttons inside root.
// getRecord(id) defaults to store.get. Returns the function that removes the listener.
export function bindInlineEdits(root, { getRecord, onFilter, onDone } = {}) {
  const find = (el) => {
    const id = el.getAttribute("data-id") || (el.closest("[data-rec]") && el.closest("[data-rec]").getAttribute("data-rec"));
    if (!id) return null;
    return (getRecord && getRecord(id)) || store.get(id) || null;
  };
  const offEdit = on(root, "click", "[data-edit]", async (e, el) => {
    e.preventDefault();
    const rec = find(el);
    if (!rec) return;
    const r = await editField(el, rec, el.getAttribute("data-edit"), { onFilter, onDone });
    if (r && onDone) onDone(r);
  });
  const offAct = on(root, "click", "[data-row-act]", async (e, el) => {
    e.preventDefault();
    const rec = find(el);
    if (!rec || meta().read_only) return;
    const act = el.getAttribute("data-row-act");
    let r = null;
    if (act === "log") r = await actions.logMenu(el, rec);
    else if (act === "follow") r = await actions.followUpMenu(el, rec);
    else if (act === "claim") r = await actions.claim(rec.id);
    else if (act === "assign") r = await actions.outcome(rec.id, "assign_manager");
    else if (act === "outcome") r = await actions.runOutcome(el, rec, el.getAttribute("data-outcome"));
    else if (act === "more") {
      // Phone cards (spec 4.12): one ⋯ button that leads to the same two menus.
      const pick = await openMenu(el, { label: "Actions for " + (rec.label || rec.id), items: [
        { label: "Log what happened…", value: "log" },
        { label: "Follow up…", value: "follow" },
      ] });
      if (pick === "log") r = await actions.logMenu(el, rec);
      else if (pick === "follow") r = await actions.followUpMenu(el, rec);
    }
    if (r && onDone) onDone(r);
  });
  return () => {
    offEdit();
    offAct();
  };
}

// Row action buttons (for list cells and cards): Log what happened ▾ and Follow up ▾.
export function rowActions(record, { log = true, follow = true } = {}) {
  if (!record || meta().read_only) return html``;
  return html`<span class="ui-row-acts">${log ? html`<button type="button" class="ui-btn is-sm" data-row-act="log" data-id="${record.id}" aria-haspopup="menu" aria-label="${"Log what happened: " + (record.label || record.id)}">Log what happened <span aria-hidden="true">▾</span></button>` : ""}${follow ? html`<button type="button" class="ui-btn is-sm is-ghost" data-row-act="follow" data-id="${record.id}" aria-haspopup="menu" aria-label="${"Follow up: " + (record.label || record.id)}">Follow up <span aria-hidden="true">▾</span></button>` : ""}${log || follow ? html`<button type="button" class="ui-btn is-sm is-ghost ui-row-more" data-row-act="more" data-id="${record.id}" aria-haspopup="menu" aria-label="${"Actions: " + (record.label || record.id)}"><span aria-hidden="true">⋯</span></button>` : ""}</span>`;
}
