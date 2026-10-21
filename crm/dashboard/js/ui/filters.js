// URL-synced filter chips (spec 4.7, 2.2.2, 2.4). Owner G1-C. No side effects at import time.
//
// createFilterBar(root, {fields, params, onChange, records}) renders the in-list search box, one menu
// button per field and the active filters as chips with × plus "Clear all". It never keeps state of
// its own: every change goes to onChange(patch, {replace}) (default: router.setParams with page reset),
// and the page calls bar.update(params) when the route changes. Below 640 px the field buttons move
// into a "Filters" bottom sheet (a <dialog>; the menus open inside it).
//
// URL values (spec 2.4): q, client (slug, key or name; "melograno-amelia" = one Melograno product;
// "none" = no client), owner (name | me | none), stage, type ("none" = Type not set), country, drb
// (80+, 60-79, 40-59, 20-39, 0-19), source, has_contact (1 | 0), sugg (1), big (1), waiting (1).
// applyFilters() applies all of them except `big`: hiding big sites depends on the tab (B.4), so the
// page does it.
import { html, raw, render, on } from "../core/dom.js";
import { normName, normDomain } from "../core/format.js";
import * as metaMod from "../core/meta.js";
import * as me from "../core/me.js";
import * as router from "../core/router.js";
import * as store from "../core/store.js";
import { openMenu } from "./menu.js";
import { openModal } from "./dialog.js";

const has = (v) => v != null && String(v).trim() !== "";
const DR_BANDS = ["80+", "60-79", "40-59", "20-39", "0-19"];

// Field definitions. options(records, meta, me) -> [{value, label}]; toggles take "1".
export const FILTERS = {
  q: { label: "Search", search: true },
  client: { label: "Client", options: clientOptions },
  owner: { label: "Owner", options: ownerOptions },
  stage: { label: "Stage", options: (recs, m) => (m.stages || []).filter((s) => s.name !== "Do not contact" || (m.features && m.features.dnc) || recs.some((r) => r.stage === s.name)).map((s) => ({ value: s.name, label: s.name, desc: s.desc })) },
  type: { label: "Type", options: (recs, m) => withData((m.affiliate_types || []).map((t) => ({ value: t, label: t })), recs, "type").concat([{ value: "none", label: "Type not set" }]) },
  country: { label: "Country", options: (recs) => fromData(recs, "country") },
  drb: { label: "DR", options: () => DR_BANDS.map((b) => ({ value: b, label: "DR " + b })) },
  source: { label: "Source", options: (recs) => fromData(recs, "source") },
  has_contact: { label: "Has contact", toggle: true },
  sugg: { label: "Has suggestion", toggle: true },
  big: { label: "Show big sites", toggle: true },
  waiting: { label: "Waiting on client", toggle: true },
};

// Values of a column, most frequent first.
function fromData(recs, key) {
  const counts = new Map();
  for (const r of recs || []) {
    const v = r && r[key];
    if (has(v)) counts.set(String(v), (counts.get(String(v)) || 0) + 1);
  }
  return Array.from(counts.entries()).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([v, n]) => ({ value: v, label: v, hint: String(n) }));
}

function withData(list, recs, key) {
  const seen = new Set(list.map((x) => x.value));
  return list.concat(fromData(recs, key).filter((x) => !seen.has(x.value)).map((x) => ({ value: x.value, label: x.label })));
}

function clientOptions(recs, m) {
  const out = [];
  for (const c of m.clients || []) {
    if (c.products && c.products.length) {
      out.push({ value: c.slug || c.k, label: c.name + " (all)" });
      for (const p of c.products) out.push({ value: (c.slug || c.k) + "-" + normName(p).replace(/\s+/g, "-"), label: (c.token || "{name} - {product}").replace("{name}", c.name).replace("{product}", p) });
    } else {
      out.push({ value: c.slug || c.k, label: c.name });
    }
  }
  for (const c of m.past_clients || []) out.push({ value: c.slug || c.k, label: c.name, desc: "past client" });
  out.push({ value: "none", label: "No client" });
  return out;
}

function ownerOptions(recs, m, mine) {
  const out = [];
  if (mine) out.push({ value: "me", label: "Me", hint: mine });
  out.push({ value: "none", label: "No owner" });
  const team = (m.team || []).filter((t) => t && t.active !== false).map((t) => t.name);
  for (const n of team) if (n !== mine) out.push({ value: n, label: n });
  for (const o of fromData(recs, "owner")) if (o.value !== mine && !team.includes(o.value)) out.push({ value: o.value, label: o.value, desc: "past owner" });
  return out;
}

// The chip text for one filter: "Client: Melograno - Amelia", "Owner: Me", "DR 80+", "Has contact".
export function chipLabel(field, value, { meta = metaMod.get() } = {}) {
  const f = FILTERS[field] || { label: field };
  const v = String(value);
  if (f.toggle) return v === "0" ? "No " + f.label.toLowerCase().replace(/^has /, "") : f.label;
  switch (field) {
    case "q": return "“" + v + "”";
    case "client": {
      if (v === "none") return "No client";
      const c = metaMod.client(meta, v);
      if (!c) return "Client: " + v;
      return "Client: " + (c.product ? metaMod.clientLabel(meta, c) : c.name + (isProductClient(meta, c.k) ? " (all)" : ""));
    }
    case "owner": return v === "me" ? "Owner: Me" : v === "none" ? "No owner" : "Owner: " + v;
    case "type": return v === "none" ? "Type not set" : "Type: " + v;
    case "drb": return "DR " + v;
    default: return f.label + ": " + v;
  }
}

function isProductClient(meta, k) {
  const c = (meta.clients || []).find((x) => x.k === k);
  return !!(c && c.products && c.products.length);
}

// ---------- applyFilters ----------

function clientMatcher(value, meta) {
  const v = String(value);
  if (v === "none") return (r) => !(r.ck && r.ck.length) && !has(r.clients);
  const c = metaMod.client(meta, v);
  if (!c) {
    const k = v.toLowerCase();
    return (r) => (r.clientParts || metaMod.splitClients(meta, r.clients)).some((p) => p.k === k || normName(p.raw) === normName(v));
  }
  const prod = c.product ? normName(c.product) : null;
  return (r) => (r.clientParts || metaMod.splitClients(meta, r.clients)).some((p) => p.k === c.k && (!prod || normName(p.product || "") === prod));
}

function textMatcher(q) {
  const t = String(q).trim().toLowerCase();
  if (!t) return null;
  const nn = normName(t);
  const dom = normDomain(t);
  return (r) => {
    const hay = r.q || [r.id, r.domain, r.name, r.label, r.next_step].filter(has).join(" ").toLowerCase();
    if (hay.includes(t)) return true;
    if (nn && hay.includes(nn)) return true;
    return !!(dom && r.domain && String(r.domain).toLowerCase().includes(dom));
  };
}

const eq = (a, b) => String(a == null ? "" : a).toLowerCase() === String(b == null ? "" : b).toLowerCase();

// The records that match every filter in params (spec 2.4 names; unknown params are ignored).
export function applyFilters(records, params, { meta = metaMod.get(), me: mine = me.get() } = {}) {
  const p = params || {};
  const tests = [];
  if (has(p.q)) {
    const m = textMatcher(p.q);
    if (m) tests.push(m);
  }
  if (has(p.client)) tests.push(clientMatcher(p.client, meta));
  if (has(p.owner)) {
    const o = String(p.owner);
    if (o === "none") tests.push((r) => !has(r.owner));
    else if (o === "me") tests.push((r) => has(mine) && eq(r.owner, mine));
    else tests.push((r) => eq(r.owner, o));
  }
  if (has(p.stage)) tests.push((r) => eq(r.stage, p.stage));
  if (has(p.type)) tests.push(p.type === "none" ? (r) => !has(r.type) : (r) => eq(r.type, p.type));
  if (has(p.country)) tests.push((r) => eq(r.country, p.country));
  if (has(p.drb)) tests.push((r) => (r.drb || "") === String(p.drb));
  if (has(p.source)) tests.push((r) => eq(r.source, p.source));
  if (p.has_contact === "1") tests.push((r) => Number(r.contacts) > 0);
  else if (p.has_contact === "0") tests.push((r) => !(Number(r.contacts) > 0));
  if (p.sugg === "1") tests.push((r) => Number(r.sugg) > 0);
  if (p.waiting === "1") tests.push((r) => !!r.waitingOnClient);
  const list = Array.isArray(records) ? records : [];
  if (!tests.length) return list.slice();
  return list.filter((r) => tests.every((t) => t(r)));
}

// The active filter chips for params: [{field, value, label}].
export function activeFilters(params, fields, { meta = metaMod.get() } = {}) {
  const out = [];
  for (const f of fields) {
    const v = params && params[f];
    if (!has(v)) continue;
    out.push({ field: f, value: String(v), label: chipLabel(f, v, { meta }) });
  }
  return out;
}

// ---------- createFilterBar ----------

const caret = raw('<svg class="ui-caret" viewBox="0 0 24 24" aria-hidden="true"><path d="M7 10l5 5 5-5"/></svg>');

function fieldButtons(fields, params) {
  return fields.filter((f) => f !== "q" && FILTERS[f]).map((f) => {
    const def = FILTERS[f];
    const v = params[f];
    if (def.toggle) {
      const on = v === "1";
      return html`<button type="button" class="ui-fbtn is-toggle" data-ffield="${f}" aria-pressed="${on ? "true" : "false"}">${def.label}</button>`;
    }
    return html`<button type="button" class="ui-fbtn${has(v) ? " is-set" : ""}" data-ffield="${f}" aria-haspopup="menu">${def.label}${has(v) ? html`<span class="sr-only">: ${chipLabel(f, v)}</span>` : ""}${caret}</button>`;
  });
}

// fields: filter names in display order (see FILTERS); params: the current URL params;
// onChange(patch, {replace}); records(): the rows the data-driven options come from (default store.all);
// chips(params): more active filters the page applies itself, [{field, label, title?}], shown first as chips with ×
// (the × and "Clear all" set that param to null), such as Sites' flag=<id> from a Team overview number.
// Returns {update(params), destroy()}.
export function createFilterBar(root, { fields = [], params = {}, onChange, records, label = "Filters", chips: extraChips } = {}) {
  if (!root) return { update() {}, destroy() {} };
  const list = (fields || []).filter((f) => FILTERS[f]);
  const hasSearch = list.includes("q");
  let cur = Object.assign({}, params || {});
  let timer = null;
  let sheet = null;
  const change = (patch, opts = {}) => {
    const p = Object.assign({}, patch);
    if (!("page" in p)) p.page = null;
    if (typeof onChange === "function") onChange(p, opts);
    else router.setParams(p, { replace: !!opts.replace });
  };
  const rows = () => {
    try { return typeof records === "function" ? records() || [] : store.all(); } catch (e) { return []; }
  };

  render(root, html`<div class="ui-filters">
<div class="ui-frow">
${hasSearch ? html`<label class="ui-fsearch"><span class="sr-only">Search in this list</span><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="M21 21l-5-5"/></svg><input type="search" class="ui-input" data-fq placeholder="Search in this list" value="${cur.q || ""}" autocomplete="off" spellcheck="false"></label>` : ""}
<div class="ui-fbtns" role="group" aria-label="${label}" data-fbtns></div>
<button type="button" class="ui-fbtn ui-fsheet-btn" data-fsheet aria-haspopup="dialog">${label}<span data-fcount></span></button>
</div>
<div class="ui-chiprow" data-fchips></div>
</div>`);
  const btns = root.querySelector("[data-fbtns]");
  const chips = root.querySelector("[data-fchips]");
  const count = root.querySelector("[data-fcount]");
  const input = root.querySelector("[data-fq]");

  const extra = () => {
    let out = [];
    try { out = typeof extraChips === "function" ? extraChips(cur) || [] : []; } catch (e) { out = []; }
    return out.filter((c) => c && c.field && has(c.label) && !list.includes(c.field));
  };

  function draw() {
    render(btns, html`${fieldButtons(list, cur)}`);
    if (sheet) render(sheet.body.querySelector("[data-fbtns-sheet]"), html`${fieldButtons(list, cur)}`);
    const active = extra().concat(activeFilters(cur, list));
    render(chips, active.length ? html`<span class="sr-only">Active filters:</span>${active.map((a) => html`<span class="ui-fchip"${a.title ? html` title="${a.title}"` : ""}>${a.label}<button type="button" class="ui-fchip-x" data-fremove="${a.field}" aria-label="${"Remove filter " + a.label}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg></button></span>`)}<button type="button" class="ui-linkbtn" data-fclear>Clear all</button>` : html``);
    chips.hidden = !active.length;
    const n = active.filter((a) => a.field !== "q").length;
    count.textContent = n ? " (" + n + ")" : "";
    if (input && document.activeElement !== input) input.value = cur.q || "";
  }

  async function pickField(btn, f) {
    const def = FILTERS[f];
    if (def.toggle) {
      change({ [f]: cur[f] === "1" ? null : "1" });
      return;
    }
    const opts = def.options(rows(), metaMod.get(), me.get()) || [];
    const items = opts.map((o) => ({ label: o.label, value: o.value, desc: o.desc, hint: o.hint, checked: String(cur[f] || "") === String(o.value) }));
    if (has(cur[f])) items.push({ divider: true }, { label: "Any " + def.label.toLowerCase(), value: "\u0000any" });
    const v = await openMenu(btn, { items, label: def.label, search: items.length > 8 });
    if (v == null) return;
    change({ [f]: v === "\u0000any" ? null : v });
  }

  const offs = [
    on(root, "click", "[data-ffield]", (e, b) => pickField(b, b.getAttribute("data-ffield"))),
    on(root, "click", "[data-fremove]", (e, b) => change({ [b.getAttribute("data-fremove")]: null })),
    on(root, "click", "[data-fclear]", () => {
      const patch = {};
      for (const f of list) patch[f] = null;
      for (const c of extra()) patch[c.field] = null;
      change(patch);
    }),
    on(root, "click", "[data-fsheet]", (e, b) => {
      sheet = openModal({
        title: label,
        body: html`<div class="ui-fbtns is-sheet" role="group" aria-label="${label}" data-fbtns-sheet></div>`,
        actions: [{ label: "Done", kind: "primary" }],
        className: "is-sheet",
        onClose: () => { sheet = null; },
      });
      on(sheet.el, "click", "[data-ffield]", (ev, fb) => pickField(fb, fb.getAttribute("data-ffield")));
      draw();
    }),
  ];
  if (input) {
    offs.push(on(input, "input", null, () => {
      clearTimeout(timer);
      timer = setTimeout(() => change({ q: input.value.trim() || null }, { replace: true }), 120);
    }));
    offs.push(on(input, "keydown", null, (e) => {
      if (e.key === "Escape" && input.value) {
        e.preventDefault();
        e.stopPropagation();
        input.value = "";
        clearTimeout(timer);
        change({ q: null }, { replace: true });
      }
    }));
  }
  draw();

  return {
    update(next) {
      cur = Object.assign({}, next || {});
      draw();
    },
    destroy() {
      clearTimeout(timer);
      for (const off of offs) off();
      if (sheet) sheet.close();
      render(root, html``);
    },
  };
}
