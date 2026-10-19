// Bulk bar for a list's page selection (spec 4.8). Owner F3. No side effects at import time.
//
// createBulkBar(root, {selected, clear, list, onDone}) -> {update(ids), destroy()}
//   createList({bulk: (el, o) => createBulkBar(el, o)}) mounts it in the list's bulk slot and calls
//   update(ids) whenever the selection changes; o = {selected() -> ids, clear(), refresh(), list}.
//   onDone(result, what) runs after a change was saved (what: owner, stage, client, type, follow, next).
//
// Bar: "N selected" · Assign owner ▾ · Set stage ▾ · Add client ▾ · Set type ▾ · Follow up ▾ ·
//   Set next step… · Export selected · Clear selection. Below 640 px the actions sit in one "Actions ▾" menu.
// - Page selection only: at most 100 sites (the Undo limit); over that the change buttons are disabled.
// - Every change goes through actions.bulk() (ids mode, chunks of meta.limits.bulk_ids, a progress toast,
//   "Updated 62 · 2 failed (Show)", Undo through rows mode in chunks of meta.limits.bulk_rows, the store
//   patched from the response's v2 rows; the list is never downloaded again). Menus pick a value and
//   actions.bulk asks to confirm over 20 sites. The three changes that need typing open a small dialog
//   that states the change and is the confirmation:
//     - Set stage › Lost asks for one reason for all (and Do not contact, with the flag, for a note). It
//       empties next step and follow-up date and writes no activity rows (as the old bulk did), so the
//       reason only words the result toast.
//     - Set next step… (text, optionally only where a site has none yet).
//     - Add client › Other… (2-40 characters, no commas or slashes).
import { html, raw, render, on } from "../core/dom.js";
import { num, plural } from "../core/format.js";
import * as metaMod from "../core/meta.js";
import * as me from "../core/me.js";
import * as actions from "./actions.js";
import { openMenu } from "./menu.js";
import { openModal } from "./dialog.js";
import { toast } from "./toast.js";

export const BULK_MAX = 100;
const SHEET = "This also updates the Google Sheet on the next weekday morning.";
const meta = () => metaMod.get();
const has = (v) => v != null && String(v).trim() !== "";
const sites = (n) => num(n) + " " + plural(n, "site");

const caret = raw('<svg class="ui-caret" viewBox="0 0 24 24" aria-hidden="true"><path d="M7 10l5 5 5-5"/></svg>');

const ACTIONS = [
  { id: "owner", label: "Assign owner", menu: true },
  { id: "stage", label: "Set stage", menu: true },
  { id: "client", label: "Add client", menu: true },
  { id: "type", label: "Set type", menu: true },
  { id: "follow", label: "Follow up", menu: true },
  { id: "next", label: "Set next step…" },
  { id: "export", label: "Export selected", always: true },
];

function teamNames() {
  return (meta().team || []).filter((t) => t && t.active !== false).map((t) => t.name).filter(Boolean);
}

// ---------- the value pickers ----------

function ownerItems() {
  const mine = me.get();
  const items = [];
  if (mine) items.push({ label: mine, value: mine, hint: "me" });
  for (const n of teamNames()) if (n !== mine) items.push({ label: n, value: n });
  items.push({ divider: true }, { label: "No owner", value: "" });
  return items;
}

function stageItems() {
  const m = meta();
  const dnc = !!(m.features && m.features.dnc);
  const stages = (m.stages || []).slice().sort((a, b) => (a.order || 0) - (b.order || 0));
  const main = stages.filter((s) => s.in_path || s.name === "Lost");
  const extra = stages.filter((s) => !main.includes(s) && (s.name !== "Do not contact" || dnc));
  const item = (s) => ({ label: s.name, value: s.name, desc: s.desc, hint: s.name === "Lost" || s.name === "Do not contact" ? "…" : "" });
  const items = main.map(item);
  if (extra.length) items.push({ label: "More", more: extra.map(item) });
  return items;
}

function productToken(c, p) {
  return (c.token || "{name} - {product}").replace("{name}", c.name).replace("{product}", p);
}

function clientItems() {
  const m = meta();
  const items = [];
  for (const c of (m.clients || []).filter((x) => !x.past)) {
    if (c.products && c.products.length) {
      items.push({ label: c.name, more: c.products.map((p) => ({ label: productToken(c, p), value: productToken(c, p) })) });
    } else {
      items.push({ label: c.name, value: c.name });
    }
  }
  const past = m.past_clients || [];
  if (past.length) {
    items.push({ heading: "Past clients" });
    for (const c of past) items.push({ label: c.name, value: c.name });
  }
  items.push({ divider: true }, { label: "Other…", value: "\u0000other" });
  return items;
}

function typeItems() {
  const items = (meta().affiliate_types || []).map((t) => ({ label: t, value: t }));
  items.push({ divider: true }, { label: "Type not set", value: "" });
  return items;
}

// ---------- the dialogs ----------

function fieldError(form, msg, name) {
  const p = form.querySelector(".ui-error");
  if (p) {
    p.textContent = msg || "";
    p.hidden = !msg;
  }
  for (const el of form.querySelectorAll("[aria-invalid]")) el.removeAttribute("aria-invalid");
  const el = name ? form.querySelector('[name="' + name + '"]') : null;
  if (el && msg) {
    el.setAttribute("aria-invalid", "true");
    if (p && p.id) el.setAttribute("aria-describedby", p.id);
    if (el.focus) el.focus();
  }
}

// A small dialog that states the change and collects what it needs. read(form) -> {value} | {error, field}.
// Resolves to the value, or null when cancelled.
function ask({ title, body, confirmLabel, danger = false, read }) {
  return new Promise((resolve) => {
    let value = null;
    const m = openModal({
      title,
      size: "sm",
      className: "si-bulk-dialog",
      body: html`<div class="si-bulk-form">${body}<p class="ui-error" id="si-bulk-err" role="alert" hidden></p></div>`,
      actions: [
        { label: "Cancel", value: false, kind: "ghost" },
        {
          label: confirmLabel, value: true, kind: danger ? "danger" : "primary",
          onClick(modal) {
            const r = read(modal.el);
            if (r && r.error) {
              fieldError(modal.el, r.error, r.field);
              return false;
            }
            value = r ? r.value : null;
            return true;
          },
        },
      ],
      onClose: (v) => resolve(v === true ? value : null),
    });
    if (!m || !m.el) resolve(null);
  });
}

function askLost(n, stage) {
  const dnc = stage === "Do not contact";
  const reasons = (meta().lost_reasons || []).length ? meta().lost_reasons : ["Not a fit", "Other"];
  const body = dnc
    ? html`<p class="si-bulk-note">${SHEET} Their next step and follow-up date are cleared.</p><label class="ui-field"><span class="ui-label">Why? (one note for all)</span><input type="text" name="reason" class="ui-input" maxlength="200" autocomplete="off"></label>`
    : html`<p class="si-bulk-note">${SHEET} Their next step and follow-up date are cleared.</p><fieldset class="ui-fieldset"><legend class="ui-label">Pick one reason for all of them</legend><div class="ui-radios">${reasons.map((r) => html`<label class="ui-radio"><input type="radio" name="reason" value="${r}"><span>${r}</span></label>`)}</div></fieldset>`;
  return ask({
    title: "Change stage to " + stage + " for " + sites(n) + "?",
    body,
    confirmLabel: dnc ? "Mark " + sites(n) + " as Do not contact" : "Move " + sites(n) + " to Lost",
    danger: true,
    read(el) {
      if (dnc) {
        const v = String((el.querySelector('input[name="reason"]') || {}).value || "").trim();
        return v ? { value: v } : { error: "Write why.", field: "reason" };
      }
      const picked = el.querySelector('input[name="reason"]:checked');
      return picked ? { value: picked.value } : { error: "Pick a reason.", field: "reason" };
    },
  });
}

function askNext(n) {
  return ask({
    title: "Set the next step of " + sites(n),
    body: html`<label class="ui-field"><span class="ui-label">Next step</span><input type="text" name="next" class="ui-input" maxlength="480" autocomplete="off" placeholder="For example: Send the media kit"></label><label class="ui-check"><input type="checkbox" name="empty" checked><span>Only where there is no next step yet</span></label><p class="si-bulk-note">${SHEET}</p>`,
    confirmLabel: "Set next step",
    read(el) {
      const v = String((el.querySelector('input[name="next"]') || {}).value || "").replace(/\s+/g, " ").trim();
      if (!v) return { error: "Write the next step.", field: "next" };
      return { value: { text: v, onlyIfEmpty: !!(el.querySelector('input[name="empty"]') || {}).checked } };
    },
  });
}

function askOtherClient(n) {
  return ask({
    title: "Add a client to " + sites(n),
    body: html`<label class="ui-field"><span class="ui-label">Client name</span><input type="text" name="client" class="ui-input" maxlength="40" autocomplete="off"></label><p class="si-bulk-note">Sites that already have it are left as they are. ${SHEET}</p>`,
    confirmLabel: "Add client",
    read(el) {
      const v = String((el.querySelector('input[name="client"]') || {}).value || "").replace(/\s+/g, " ").trim();
      if (!v) return { error: "Type a client name.", field: "client" };
      if (v.length < 2 || v.length > 40) return { error: "Use 2 to 40 characters.", field: "client" };
      if (/[,/%_\\]/.test(v)) return { error: "Use one name without commas or slashes.", field: "client" };
      const known = metaMod.client(meta(), v);
      if (known) {
        const c = (meta().clients || []).concat(meta().past_clients || []).find((x) => x.k === known.k);
        if (c && !known.product) return { value: c.name };
        if (c && known.product && c.products) {
          const p = c.products.find((x) => x.toLowerCase() === String(known.product).toLowerCase());
          if (p) return { value: productToken(c, p) };
        }
      }
      return { value: v };
    },
  });
}

// ---------- the bar ----------

export function createBulkBar(root, opts = {}) {
  if (!root) return { update() {}, destroy() {} };
  const { selected = () => [], clear = () => {}, list = null, onDone } = opts;
  let ids = [];
  let busy = false;

  function draw() {
    const n = ids.length;
    const over = n > BULK_MAX;
    const off = (a) => busy || (over && !a.always);
    render(root, html`<div class="si-bulk" role="group" aria-label="${"Change the " + sites(n) + " you selected"}"${busy ? raw(' aria-busy="true"') : ""}>
<p class="si-bulk-count" aria-live="polite"><b>${num(n)}</b> selected</p>
<div class="si-bulk-acts">${ACTIONS.map((a) => html`<button type="button" class="ui-btn is-sm si-bulk-btn" data-bulk="${a.id}"${a.menu ? raw(' aria-haspopup="menu"') : a.id === "next" ? raw(' aria-haspopup="dialog"') : ""}${off(a) ? raw(" disabled") : ""}>${a.label}${a.menu ? caret : ""}</button>`)}</div>
<button type="button" class="ui-btn is-sm si-bulk-menu" data-bulk="menu" aria-haspopup="menu"${busy ? raw(" disabled") : ""}>Actions${caret}</button>
<button type="button" class="ui-linkbtn si-bulk-clear" data-bulk="clear">Clear selection</button>
${over ? html`<p class="si-bulk-over" role="status">Bulk changes work on up to ${num(BULK_MAX)} sites at a time. Clear some of the selection to change them.</p>` : ""}
</div>`);
  }

  function current() {
    try { return (selected() || []).slice(); } catch (e) { return ids.slice(); }
  }

  async function run(what, fn) {
    if (busy) return null;
    busy = true;
    draw();
    let r = null;
    try {
      r = await fn();
    } finally {
      busy = false;
      ids = current();
      draw();
    }
    if (r && !r.cancelled && typeof onDone === "function") onDone(r, what);
    return r;
  }

  // The button the next menu opens from: the action's own button, or "Actions ▾" on phones.
  function anchorFor(id) {
    const own = root.querySelector('[data-bulk="' + id + '"]');
    const visible = own && own.getClientRects().length > 0;
    return visible ? own : root.querySelector('[data-bulk="menu"]') || own;
  }

  async function act(id) {
    const list = current();
    const n = list.length;
    if (!n) return;
    if (id === "clear") {
      clear();
      return;
    }
    if (id === "export") {
      if (opts.list && typeof opts.list.exportCsv === "function") opts.list.exportCsv({ only: list });
      return;
    }
    if (n > BULK_MAX) {
      toast("Bulk changes work on up to " + num(BULK_MAX) + " sites at a time.", { kind: "error" });
      return;
    }
    const anchor = anchorFor(id);
    if (id === "owner") {
      const v = await openMenu(anchor, { items: ownerItems(), label: "Assign owner", search: teamNames().length > 8 });
      if (v == null) return;
      await run("owner", () => actions.bulk(list, { owner: v }, { label: has(v) ? "Owner: " + v : "Owner removed" }));
    } else if (id === "stage") {
      const v = await openMenu(anchor, { items: stageItems(), label: "Set stage" });
      if (v == null) return;
      if (v === "Lost" || v === "Do not contact") {
        const reason = await askLost(n, v);
        if (reason == null) return;
        await run("stage", () => actions.bulk(list, { stage: v }, { confirm: false, label: (v === "Lost" ? "Moved to Lost" : "Marked as Do not contact") + " (" + reason + ")" }));
      } else {
        await run("stage", () => actions.bulk(list, { stage: v }, { label: "Moved to " + v }));
      }
    } else if (id === "client") {
      const v = await openMenu(anchor, { items: clientItems(), label: "Add client", search: true });
      if (v == null) return;
      let token = v;
      let confirm = true;
      if (v === "\u0000other") {
        token = await askOtherClient(n);
        if (token == null) return;
        confirm = false;
      }
      await run("client", () => actions.bulk(list, { add_client: token }, { confirm, label: "Added " + token }));
    } else if (id === "type") {
      const v = await openMenu(anchor, { items: typeItems(), label: "Set type", search: true });
      if (v == null) return;
      await run("type", () => actions.bulk(list, { type: v }, { label: has(v) ? "Type: " + v : "Type cleared" }));
    } else if (id === "follow") {
      await run("follow", () => actions.followUpMenu(anchor, list));
    } else if (id === "next") {
      const v = await askNext(n);
      if (v == null) return;
      await run("next", () => actions.bulk(list, { next_step: v.text }, { confirm: false, onlyIfEmpty: v.onlyIfEmpty ? ["next_step"] : undefined, label: "Next step saved" }));
    }
  }

  async function phoneMenu(btn) {
    const n = current().length;
    const items = ACTIONS.map((a) => ({ label: a.label.replace(/…$/, ""), value: a.id, disabled: n > BULK_MAX && !a.always }));
    const v = await openMenu(btn, { items, label: "Change the " + sites(n) + " you selected" });
    if (v) await act(v);
  }

  const offs = [
    on(root, "click", "[data-bulk]", (e, b) => {
      const id = b.getAttribute("data-bulk");
      if (b.disabled) return;
      if (id === "menu") phoneMenu(b);
      else act(id);
    }),
  ];

  draw();
  return {
    update(next) {
      ids = Array.isArray(next) ? next.slice() : current();
      draw();
    },
    destroy() {
      for (const off of offs) off();
      render(root, html``);
    },
  };
}
