// Record panel: Deal terms and Placement (spec 4.2, 4.4), and their editors. Owner F1. No side effects at
// import time.
//   - Deal terms show when the stage is Negotiating or Active, or any deal field has a value (or with
//     "Show all fields"): "Flat fee + commission · $350 + 30%", deal value, tracking ID.
//     editDeal(): deal type, deal value, flat fee, commission %, tracking ID; one "Save terms" (one PATCH).
//   - Placement shows when the stage is Active, or a content link or live date is set (or with "Show all
//     fields"): the link and "Went live Thu 22 Oct". editPlacement(): content link + went live on (one PATCH).
// Both editors are popovers (ui/menu.js) that save through actions.update() (optimistic, Undo toast).
import { html, raw, on, safeUrl } from "../../core/dom.js";
import { date as fmtDate, money, todayIso } from "../../core/format.js";
import * as metaMod from "../../core/meta.js";
import { openPopover } from "../../ui/menu.js";
import * as actions from "../../ui/actions.js";

const DEAL_KEYS = ["deal_model", "deal_flat", "deal_pct", "deal_value", "tracking_id"];
const PLACE_KEYS = ["content_url", "live_date"];
const has = (v) => v != null && String(v).trim() !== "";
const val = (v) => (v == null ? "" : String(v));

export function hasDeal(r) {
  return !!r && DEAL_KEYS.some((k) => has(r[k]));
}

export function hasPlacement(r) {
  return !!r && PLACE_KEYS.some((k) => has(r[k]));
}

export function showDeal(r, { showAll = false } = {}) {
  return showAll || !!r && (r.stage === "Negotiating" || r.stage === "Active" || hasDeal(r));
}

export function showPlacement(r, { showAll = false } = {}) {
  return showAll || !!r && (r.stage === "Active" || hasPlacement(r));
}

function shortUrl(u) {
  const s = String(u || "").replace(/^https?:\/\//i, "").replace(/^www\./i, "").replace(/\/$/, "");
  return s.length > 52 ? s.slice(0, 51) + "…" : s;
}

const PEN = raw('<svg class="rc-pen" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16v4z"/></svg>');

export function renderDeal(r, { readOnly = false } = {}) {
  const parts = [];
  if (has(r.deal_flat)) parts.push(money(r.deal_flat) || String(r.deal_flat));
  if (has(r.deal_pct)) parts.push(String(r.deal_pct).replace(/%$/, "") + "%");
  const terms = [r.deal_model, parts.join(" + ")].filter((x) => has(x)).join(" · ");
  const edit = readOnly ? "" : html`<button type="button" class="ui-btn is-sm is-ghost rc-head-act" data-pdeal="edit" aria-label="Edit deal terms">${hasDeal(r) ? html`${PEN} Edit` : "Add terms"}</button>`;
  const rows = [];
  if (has(r.deal_value)) rows.push(html`<dt>Deal value</dt><dd>${money(r.deal_value) || r.deal_value}</dd>`);
  if (has(r.tracking_id)) rows.push(html`<dt>Tracking ID</dt><dd>${r.tracking_id}</dd>`);
  return html`<div class="rc-card-head"><h3 class="ui-card-title rc-card-title" id="rc-deal-h">Deal terms</h3>${edit}</div>${terms
    ? html`<p class="rc-terms">${terms}</p>` : !hasDeal(r) ? html`<p class="ui-small rc-muted">No terms yet.</p>` : ""}${rows.length ? html`<dl class="rc-dl">${rows}</dl>` : ""}`;
}

export function renderPlacement(r, { readOnly = false, today = todayIso() } = {}) {
  const edit = readOnly ? "" : html`<button type="button" class="ui-btn is-sm is-ghost rc-head-act" data-pplace="edit" aria-label="Edit placement">${hasPlacement(r) ? html`${PEN} Edit` : "Add placement"}</button>`;
  const url = safeUrl(r.content_url);
  const live = r.live_date ? String(r.live_date).slice(0, 10) : "";
  const lines = [];
  if (r.content_url) {
    lines.push(url
      ? html`<p class="rc-place-link"><a href="${url}" target="_blank" rel="noopener noreferrer">${shortUrl(url)} <span aria-hidden="true">↗</span></a></p>`
      : html`<p class="rc-place-link">${r.content_url}</p>`);
  }
  if (live) lines.push(html`<p class="ui-small">${live > today ? "Goes live " : "Went live "}${fmtDate(live, live.slice(0, 4) !== today.slice(0, 4) ? "year" : "short")}</p>`);
  return html`<div class="rc-card-head"><h3 class="ui-card-title rc-card-title" id="rc-place-h">Placement</h3>${edit}</div>${lines.length ? lines : html`<p class="ui-small rc-muted">No placement yet.</p>`}`;
}

// ---------- Editors ----------

function numText(v) {
  const s = String(v == null ? "" : v).trim();
  if (!s) return "";
  const n = Number(s.replace(/[$,%\s]/g, ""));
  return isFinite(n) && n >= 0 ? String(n) : null;
}

function popForm(anchorEl, body, { label, read }) {
  return new Promise((resolve) => {
    let saving = null;
    const pop = openPopover(anchorEl, html`<form class="ui-form" novalidate><h3 class="ui-pop-title">${label}</h3>${body}<p class="ui-error" id="rc-pop-err" role="alert" hidden></p><div class="ui-form-acts"><button type="button" class="ui-btn is-ghost" data-f="cancel">Cancel</button><button type="submit" class="ui-btn is-primary">${label === "Deal terms" ? "Save terms" : "Save"}</button></div></form>`, {
      label,
      className: "ui-pop-form",
      manual: true,
      onClose: () => resolve(saving ? saving : null),
      onOpen(el) {
        const form = el.querySelector("form");
        on(el, "click", '[data-f="cancel"]', () => pop.close());
        on(form, "submit", null, (e) => {
          e.preventDefault();
          const out = read(form);
          if (out.error) {
            const p = form.querySelector(".ui-error");
            p.textContent = out.error;
            p.hidden = false;
            for (const x of form.querySelectorAll("[aria-invalid]")) x.removeAttribute("aria-invalid");
            const f = out.field ? form.elements[out.field] : null;
            if (f) {
              f.setAttribute("aria-invalid", "true");
              f.setAttribute("aria-describedby", "rc-pop-err");
              f.focus();
            }
            return;
          }
          saving = out.save();
          pop.close();
        });
      },
    });
    if (!pop.el) resolve(null);
  });
}

// Deal terms editor: one PATCH of the changed fields. Resolves to the Record, or null.
export function editDeal(anchorEl, record) {
  const m = metaMod.get();
  if (!record || m.read_only) return Promise.resolve(null);
  const cur = (k) => val(record[k]);
  const models = (m.deal_models || []).slice();
  if (cur("deal_model") && !models.includes(cur("deal_model"))) models.push(cur("deal_model"));
  const body = html`<div class="ui-grid2"><label class="ui-field is-wide"><span class="ui-label">Deal type</span><select name="deal_model" class="ui-input"><option value="">Not set</option>${models.map((d) => html`<option${d === cur("deal_model") ? raw(" selected") : ""}>${d}</option>`)}</select></label>
<label class="ui-field"><span class="ui-label">Flat fee ($)</span><input type="text" inputmode="decimal" name="deal_flat" class="ui-input" value="${cur("deal_flat")}" autocomplete="off"></label>
<label class="ui-field"><span class="ui-label">Commission (%)</span><input type="text" inputmode="decimal" name="deal_pct" class="ui-input" value="${cur("deal_pct")}" autocomplete="off"></label>
<label class="ui-field"><span class="ui-label">Deal value ($)</span><input type="text" inputmode="decimal" name="deal_value" class="ui-input" value="${cur("deal_value")}" autocomplete="off"></label>
<label class="ui-field"><span class="ui-label">Tracking ID</span><input type="text" name="tracking_id" class="ui-input" maxlength="80" value="${cur("tracking_id")}" autocomplete="off"></label></div>`;
  return popForm(anchorEl, body, {
    label: "Deal terms",
    read(form) {
      const get = (n) => String(form.elements[n].value || "").trim();
      const next = { deal_model: get("deal_model"), tracking_id: get("tracking_id") };
      for (const k of ["deal_flat", "deal_pct", "deal_value"]) {
        const n = numText(get(k));
        if (n === null) return { error: k === "deal_pct" ? "Commission is a percentage up to 100." : "Use a number, like 350.", field: k };
        next[k] = n;
      }
      if (next.deal_pct && Number(next.deal_pct) > 100) return { error: "Commission is a percentage up to 100.", field: "deal_pct" };
      const fields = {};
      for (const k of DEAL_KEYS) {
        const a = val(record[k]);
        const b = next[k];
        if (k === "deal_model" || k === "tracking_id" ? a !== b : (a === "" ? b !== "" : b === "" || Number(a) !== Number(b))) fields[k] = b;
      }
      return { save: () => (Object.keys(fields).length ? actions.update(record.id, fields, { label: "Deal terms saved" }) : Promise.resolve(null)) };
    },
  });
}

// Placement editor: content link (http/s) and the went-live date; one PATCH.
export function editPlacement(anchorEl, record) {
  const m = metaMod.get();
  if (!record || m.read_only) return Promise.resolve(null);
  const body = html`<label class="ui-field"><span class="ui-label">Placement link</span><input type="url" name="content_url" class="ui-input" placeholder="https://" value="${val(record.content_url)}" autocomplete="off"></label>
<label class="ui-field"><span class="ui-label">Went live on</span><input type="date" name="live_date" class="ui-input" value="${val(record.live_date).slice(0, 10)}"></label>`;
  return popForm(anchorEl, body, {
    label: "Placement",
    read(form) {
      const link = String(form.elements.content_url.value || "").trim();
      const day = String(form.elements.live_date.value || "");
      if (link && !/^https?:\/\/\S+$/i.test(link)) return { error: "The link starts with http:// or https://.", field: "content_url" };
      const fields = {};
      if (link !== val(record.content_url)) fields.content_url = link;
      if (day !== val(record.live_date).slice(0, 10)) fields.live_date = day;
      return { save: () => (Object.keys(fields).length ? actions.update(record.id, fields, { label: "Placement saved" }) : Promise.resolve(null)) };
    },
  });
}

