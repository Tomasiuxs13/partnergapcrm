// Record page: Deals (several per site, one per client) and Files (links to contracts, price lists,
// briefs), from the profile (GET /api/partner/:id deals, files; null before migration 006, when the
// record keeps the older Deal terms and Placement cards). Tomas asked for both on 2026-10-21.
//   - renderDeals: one block per deal: client, stage, terms, value, next step, placement, tracking ID,
//     its files; [+ Add deal] and [Edit] open openDealForm().
//   - renderFiles: every file link on the site, newest first; [+ Add file link] opens openFileForm().
// The forms are modals (ui/dialog.js) that save with POST /api/partner/:id/deals, PATCH /api/deal/:id
// and POST /api/partner/:id/files, and resolve to the server's answer (or null when cancelled).
// No side effects at import time.
import { html, raw, safeUrl } from "../../core/dom.js";
import { date as fmtDate, money, todayIso, dueLabel } from "../../core/format.js";
import * as metaMod from "../../core/meta.js";
import { api } from "../../core/api.js";
import { openModal } from "../../ui/dialog.js";
import { parseClients } from "../../ui/inline-edit.js";
import { stageDot } from "../../ui/pills.js";

export const DEAL_STAGES = ["Negotiating", "Active", "Lost"];
export const FILE_KINDS = ["Contract", "Price list", "Brief", "Invoice", "Other"];
const STAGE_TEXT = { Negotiating: "Negotiating", Active: "Signed", Lost: "Lost" };

const has = (v) => v != null && String(v).trim() !== "";
const val = (v) => (v == null ? "" : String(v));

/** The profile's deals, or null when the site has no deals table yet (before migration 006). */
export function profileDeals(state) {
  const p = state && state.profile;
  return p && Array.isArray(p.deals) ? p.deals : null;
}

/** The profile's file links, or null before migration 006. */
export function profileFiles(state) {
  const p = state && state.profile;
  return p && Array.isArray(p.files) ? p.files : null;
}

/** "Signed" for Active, "Live" once a signed deal has a live date or placement link. */
export function dealStageText(d) {
  if (d && d.stage === "Active" && (has(d.live_date) || has(d.content_url))) return "Live";
  return STAGE_TEXT[d && d.stage] || (d && d.stage) || "";
}

/** "Flat fee + commission · $350 + 30%" */
export function dealTerms(d) {
  const parts = [];
  if (has(d.deal_flat)) parts.push(money(d.deal_flat) || String(d.deal_flat));
  if (has(d.deal_pct)) parts.push(String(d.deal_pct).replace(/%$/, "") + "%");
  return [d.deal_model, parts.join(" + ")].filter((x) => has(x)).join(" · ");
}

function shortUrl(u) {
  const s = String(u || "").replace(/^https?:\/\//i, "").replace(/^www\./i, "").replace(/\/$/, "");
  return s.length > 48 ? s.slice(0, 47) + "…" : s;
}

function fileLink(f) {
  const url = safeUrl(f.url);
  const name = f.label || f.kind || "File";
  return url ? html`<a href="${url}" target="_blank" rel="noopener noreferrer">${name} <span aria-hidden="true">↗</span></a>` : html`<span>${name}</span>`;
}

function dealBlock(d, files, { readOnly, today }) {
  const terms = dealTerms(d);
  const stage = dealStageText(d);
  const live = has(d.live_date) ? String(d.live_date).slice(0, 10) : "";
  const place = safeUrl(d.content_url);
  const lines = [];
  if (terms) lines.push(html`<p class="rc-terms">${terms}</p>`);
  const facts = [];
  if (has(d.deal_value)) facts.push(html`<dt>Deal value</dt><dd>${money(d.deal_value) || d.deal_value}</dd>`);
  if (has(d.owner)) facts.push(html`<dt>Owner</dt><dd>${d.owner}</dd>`);
  if (d.stage !== "Lost" && has(d.next_step)) facts.push(html`<dt>Next step</dt><dd>${d.next_step}${has(d.next_due) ? html` <span class="rc-muted">· ${dueLabel(String(d.next_due).slice(0, 10), today) || fmtDate(d.next_due)}</span>` : ""}</dd>`);
  if (d.content_url) facts.push(html`<dt>Placement</dt><dd>${place ? html`<a href="${place}" target="_blank" rel="noopener noreferrer">${shortUrl(place)} <span aria-hidden="true">↗</span></a>` : d.content_url}</dd>`);
  if (live) facts.push(html`<dt>${live > today ? "Goes live" : "Went live"}</dt><dd>${fmtDate(live, live.slice(0, 4) !== today.slice(0, 4) ? "year" : "short")}</dd>`);
  if (has(d.tracking_id)) facts.push(html`<dt>Tracking ID</dt><dd>${d.tracking_id}</dd>`);
  if (has(d.notes)) facts.push(html`<dt>Notes</dt><dd class="rc-pre">${d.notes}</dd>`);
  const mine = (files || []).filter((f) => f.deal_id === d.id);
  if (mine.length) facts.push(html`<dt>Files</dt><dd>${mine.map((f, i) => html`${i ? ", " : ""}${fileLink(f)}`)}</dd>`);
  const edit = readOnly ? "" : html`<button type="button" class="ui-btn is-sm is-ghost" data-pdl="edit" data-deal="${d.id}" aria-label="${"Edit the " + (d.client || "") + " deal"}">Edit</button>`;
  return html`<li class="rc-dealitem${d.stage === "Lost" ? " is-lost" : ""}" data-dealid="${d.id}">
<div class="rc-dealhead"><span class="rc-dealclient">${d.client || "No client"}</span><span class="ui-pill ui-stage">${stageDot(d.stage)}<span class="ui-pill-text">${stage}</span></span>${edit}</div>
${lines}${facts.length ? html`<dl class="rc-dl">${facts}</dl>` : !terms ? html`<p class="ui-small rc-muted">No terms yet.</p>` : ""}
</li>`;
}

/** The Deals card. Open deals first (Active, then Negotiating), Lost last. */
export function renderDeals(r, state, { readOnly = false, today = todayIso() } = {}) {
  const deals = profileDeals(state) || [];
  const files = profileFiles(state) || [];
  const rank = { Active: 0, Negotiating: 1, Lost: 2 };
  const list = deals.slice().sort((a, b) => (rank[a.stage] ?? 3) - (rank[b.stage] ?? 3) || String(a.created || "").localeCompare(String(b.created || "")));
  const open = list.filter((d) => d.stage !== "Lost").length;
  const add = readOnly ? "" : html`<button type="button" class="ui-btn is-sm" data-pdl="add">+ Add deal</button>`;
  const count = list.length ? html` <span class="rc-count">${open === list.length ? String(list.length) : open + " open · " + list.length}</span>` : "";
  return html`<div class="rc-card-head"><h3 class="ui-card-title rc-card-title" id="rc-deals-h">Deals${count}</h3>${add}</div>${list.length
    ? html`<ul class="rc-deallist">${list.map((d) => dealBlock(d, files, { readOnly, today }))}</ul>`
    : html`<p class="ui-small rc-muted">No deals yet. A deal is one client's terms with this site${readOnly ? "" : ": use + Add deal"}.</p>`}`;
}

/** The Files card: every link, newest first, with its type, deal and who added it. */
export function renderFiles(r, state, { readOnly = false } = {}) {
  const files = profileFiles(state) || [];
  const deals = profileDeals(state) || [];
  const dealName = (id) => {
    const d = deals.find((x) => x.id === id);
    return d ? (d.client || "Deal") + " deal" : "";
  };
  const add = readOnly ? "" : html`<button type="button" class="ui-btn is-sm" data-pfl="add">+ Add file link</button>`;
  return html`<div class="rc-card-head"><h3 class="ui-card-title rc-card-title" id="rc-files-h">Files${files.length ? html` <span class="rc-count">${String(files.length)}</span>` : ""}</h3>${add}</div>${files.length
    ? html`<ul class="rc-filelist">${files.map((f) => html`<li class="rc-file"><span class="rc-file-name">${fileLink(f)}</span><span class="ui-small rc-muted">${[f.kind, f.deal_id ? dealName(f.deal_id) : "", (f.added_by ? f.added_by + ", " : "") + (f.added_at ? fmtDate(String(f.added_at).slice(0, 10), "day") : "")].filter(Boolean).join(" · ")}</span></li>`)}</ul>`
    : html`<p class="ui-small rc-muted">No files yet. Add a link to a contract, price list or brief (Google Drive, Dropbox).</p>`}`;
}

// ---------- Forms ----------

// Client choices: the site's own clients first, then the other active clients (Melograno by product).
function clientChoices(record, current) {
  const m = metaMod.get();
  const mine = parseClients(record && record.clients).flat().map((t) => t.raw);
  const others = [];
  for (const c of m.clients || []) {
    if (c.past) continue;
    if (Array.isArray(c.products) && c.products.length) {
      const tpl = c.token || "{name} - {product}";
      for (const p of c.products) others.push(tpl.replace("{name}", c.name).replace("{product}", p));
    } else others.push(c.name);
  }
  const low = (s) => String(s).toLowerCase();
  const rest = others.filter((o) => !mine.some((x) => low(x) === low(o)));
  if (current && !mine.concat(rest).some((x) => low(x) === low(current))) mine.unshift(current);
  return { mine, rest };
}

function numText(v) {
  const s = String(v == null ? "" : v).trim();
  if (!s) return "";
  const n = Number(s.replace(/[$,%\s]/g, ""));
  return isFinite(n) && n >= 0 ? String(n) : null;
}

const sel = (a, b) => (String(a) === String(b) ? raw(" selected") : "");

function fail(modal, msg, field) {
  const err = modal.el.querySelector(".ui-error");
  err.textContent = msg;
  err.hidden = false;
  for (const x of modal.el.querySelectorAll("[aria-invalid]")) x.removeAttribute("aria-invalid");
  const f = field ? modal.el.querySelector('[name="' + field + '"]') : null;
  if (f) {
    f.setAttribute("aria-invalid", "true");
    f.focus();
  }
  return false;
}

function busy(modal, on) {
  for (const b of modal.el.querySelectorAll(".ui-modal-foot button")) b.disabled = !!on;
}

/**
 * Add or edit a deal. deal = null adds one. Resolves to the server's answer ({deal, partner, v2}) or null.
 */
export function openDealForm(record, deal = null) {
  const m = metaMod.get();
  if (!record || m.read_only) return Promise.resolve(null);
  const d = deal || { stage: "Negotiating", owner: record.owner || "" };
  const { mine, rest } = clientChoices(record, d.client);
  const models = (m.deal_models || []).slice();
  if (has(d.deal_model) && !models.includes(d.deal_model)) models.push(d.deal_model);
  const team = (m.team || []).map((t) => (typeof t === "string" ? t : t.name)).filter(Boolean);
  if (has(d.owner) && !team.includes(d.owner)) team.push(d.owner);
  const body = html`<div class="ui-form rc-dealform">
<div class="ui-grid2">
<label class="ui-field"><span class="ui-label">Client</span><select class="ui-input" name="client"><option value="">Pick a client</option>${mine.length ? html`<optgroup label="This site's clients">${mine.map((c) => html`<option${sel(c, d.client)}>${c}</option>`)}</optgroup>` : ""}<optgroup label="${mine.length ? "Other clients" : "Clients"}">${rest.map((c) => html`<option${sel(c, d.client)}>${c}</option>`)}</optgroup></select></label>
<label class="ui-field"><span class="ui-label">Stage</span><select class="ui-input" name="stage">${DEAL_STAGES.map((s) => html`<option value="${s}"${sel(s, d.stage)}>${STAGE_TEXT[s]}</option>`)}</select></label>
<label class="ui-field"><span class="ui-label">Deal type</span><select class="ui-input" name="deal_model"><option value="">Not set</option>${models.map((x) => html`<option${sel(x, d.deal_model)}>${x}</option>`)}</select></label>
<label class="ui-field"><span class="ui-label">Owner</span><select class="ui-input" name="owner"><option value="">Nobody</option>${team.map((x) => html`<option${sel(x, d.owner)}>${x}</option>`)}</select></label>
<label class="ui-field"><span class="ui-label">Flat fee ($)</span><input class="ui-input" name="deal_flat" type="text" inputmode="decimal" autocomplete="off" value="${val(d.deal_flat)}"></label>
<label class="ui-field"><span class="ui-label">Commission (%)</span><input class="ui-input" name="deal_pct" type="text" inputmode="decimal" autocomplete="off" value="${val(d.deal_pct)}"></label>
<label class="ui-field"><span class="ui-label">Deal value ($)</span><input class="ui-input" name="deal_value" type="text" inputmode="decimal" autocomplete="off" value="${val(d.deal_value)}"></label>
<label class="ui-field"><span class="ui-label">Tracking ID</span><input class="ui-input" name="tracking_id" type="text" maxlength="80" autocomplete="off" value="${val(d.tracking_id)}"></label>
<label class="ui-field is-wide"><span class="ui-label">Next step</span><input class="ui-input" name="next_step" type="text" maxlength="500" autocomplete="off" value="${val(d.next_step)}"></label>
<label class="ui-field"><span class="ui-label">Next step due</span><input class="ui-input" name="next_due" type="date" value="${val(d.next_due).slice(0, 10)}"></label>
<label class="ui-field"><span class="ui-label">Went live on</span><input class="ui-input" name="live_date" type="date" value="${val(d.live_date).slice(0, 10)}"></label>
<label class="ui-field is-wide"><span class="ui-label">Placement link</span><input class="ui-input" name="content_url" type="url" placeholder="https://" autocomplete="off" value="${val(d.content_url)}"></label>
<label class="ui-field is-wide"><span class="ui-label">Notes</span><textarea class="ui-input" name="notes" rows="3" maxlength="2000">${val(d.notes)}</textarea></label>
</div>
<p class="ui-error" role="alert" hidden></p>
</div>`;
  let answer = null;
  const modal = openModal({
    title: deal ? "Edit " + (deal.client || "") + " deal" : "Add deal",
    body,
    size: "lg",
    className: "rc-deal-modal",
    actions: [
      { label: "Cancel", kind: "ghost", value: null },
      {
        label: deal ? "Save deal" : "Add deal",
        kind: "primary",
        onClick: async (mod) => {
          const get = (n) => String(mod.el.querySelector('[name="' + n + '"]').value || "").trim();
          const next = {};
          for (const k of ["client", "stage", "deal_model", "owner", "tracking_id", "next_step", "next_due", "live_date", "content_url", "notes"]) next[k] = get(k);
          if (!next.client) return fail(mod, "Pick the client this deal is for.", "client");
          for (const k of ["deal_flat", "deal_pct", "deal_value"]) {
            const n = numText(get(k));
            if (n === null) return fail(mod, k === "deal_pct" ? "Commission is a percentage up to 100." : "Use a number, like 350.", k);
            next[k] = n;
          }
          if (next.deal_pct && Number(next.deal_pct) > 100) return fail(mod, "Commission is a percentage up to 100.", "deal_pct");
          if (next.content_url && !/^https?:\/\/\S+$/i.test(next.content_url)) return fail(mod, "The placement link starts with http:// or https://.", "content_url");
          let fields = next;
          if (deal) {
            fields = {};
            for (const k of Object.keys(next)) {
              const a = val(deal[k]);
              const b = next[k];
              const num = ["deal_flat", "deal_pct", "deal_value"].includes(k);
              if (num ? (a === "" ? b !== "" : b === "" || Number(a) !== Number(b)) : (k.endsWith("_date") || k === "next_due" ? a.slice(0, 10) : a) !== b) fields[k] = b;
            }
            if (!Object.keys(fields).length) return undefined;
          }
          busy(mod, true);
          try {
            answer = deal ? await api.updateDeal(deal.id, fields) : await api.createDeal(record.id, fields);
            if (answer == null) throw Object.assign(new Error(""), { friendly: "Deals aren't switched on yet. Nothing was saved." });
          } catch (e) {
            busy(mod, false);
            if (e && e.status === 401) return undefined;
            return fail(mod, "Not saved. " + ((e && (e.friendly || e.message)) || "Try again."));
          }
          return undefined;
        },
      },
    ],
  });
  return modal.result.then(() => answer);
}

/** Add a file link to the site (optionally to one of its deals). Resolves to {file} or null. */
export function openFileForm(record, deals = []) {
  const m = metaMod.get();
  if (!record || m.read_only) return Promise.resolve(null);
  const body = html`<div class="ui-form rc-fileform">
<label class="ui-field"><span class="ui-label">Link to the file</span><input class="ui-input" name="url" type="url" placeholder="https://drive.google.com/…" autocomplete="off" required></label>
<p class="ui-small rc-muted">Upload the file to Google Drive (or Dropbox) first, share it with the team, then paste its link here.</p>
<div class="ui-grid2">
<label class="ui-field"><span class="ui-label">Name</span><input class="ui-input" name="label" type="text" maxlength="120" autocomplete="off" placeholder="Signed contract"></label>
<label class="ui-field"><span class="ui-label">Type</span><select class="ui-input" name="kind">${FILE_KINDS.map((k) => html`<option>${k}</option>`)}</select></label>
${deals.length ? html`<label class="ui-field is-wide"><span class="ui-label">For deal</span><select class="ui-input" name="deal_id"><option value="">The whole site</option>${deals.map((d) => html`<option value="${d.id}">${(d.client || "No client") + " (" + dealStageText(d) + ")"}</option>`)}</select></label>` : ""}
</div>
<p class="ui-error" role="alert" hidden></p>
</div>`;
  let answer = null;
  const modal = openModal({
    title: "Add file link",
    body,
    size: "md",
    className: "rc-file-modal",
    actions: [
      { label: "Cancel", kind: "ghost", value: null },
      {
        label: "Add file",
        kind: "primary",
        onClick: async (mod) => {
          const get = (n) => {
            const el = mod.el.querySelector('[name="' + n + '"]');
            return el ? String(el.value || "").trim() : "";
          };
          const f = { url: get("url"), label: get("label"), kind: get("kind") || "Other", deal_id: get("deal_id") || null };
          if (!f.url) return fail(mod, "Paste the link to the file.", "url");
          if (!/^https:\/\/\S+$/i.test(f.url)) return fail(mod, "The link must start with https://.", "url");
          busy(mod, true);
          try {
            answer = await api.addFile(record.id, f);
            if (answer == null) throw Object.assign(new Error(""), { friendly: "Files aren't switched on yet. Nothing was saved." });
          } catch (e) {
            busy(mod, false);
            if (e && e.status === 401) return undefined;
            return fail(mod, "Not saved. " + ((e && (e.friendly || e.message)) || "Try again."));
          }
          return undefined;
        },
      },
    ],
  });
  return modal.result.then(() => answer);
}
