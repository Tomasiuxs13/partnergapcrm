// Record panel: the "Log what happened" box (spec 4.2, 4.5, Appendix A). Owner F1. No side effects at
// import time.
//   - 3-4 outcome buttons for the stage, plus More ▾. One click saves at once with the note and the chip
//     that are set; Not interested / Not a fit, Counter-offer, Signed, Placement is live and Do not contact
//     open their small form first (actions.runOutcome).
//   - "Add a note (optional)".
//   - Follow-up chips: Auto (the outcome's own date; preselected) · Tomorrow · 3 days · Next week ·
//     2 weeks · Pick… · None.
//   - [Save note] with only a note, [Save follow-up] with only a chip, [Save note + follow-up] with both.
// The panel (index.js) owns the state ({note, chip, pickIso, busy, err}) and the saves; this module draws
// the parts and words the toasts.
import { html, raw } from "../../core/dom.js";
import { date as fmtDate } from "../../core/format.js";
import { outcomesFor, buttonLabel, CHIPS, chipDate, autoFollowUp } from "../../core/outcomes.js";

const short = (iso) => fmtDate(iso, "short");
const has = (v) => v != null && String(v).trim() !== "";

// The chip as outcome()/buildOutcomeRequest() take it: undefined for Auto, an ISO date for Pick…, else the id.
export function chipValue(st) {
  if (!st || !st.chip || st.chip === "auto") return undefined;
  if (st.chip === "pick") return st.pickIso || undefined;
  return st.chip;
}

// The date the chip stands for: undefined (Auto), "" (None) or 'YYYY-MM-DD'.
export function chipIso(st, today) {
  const v = chipValue(st);
  if (v === undefined) return undefined;
  const d = chipDate(v, today);
  return d == null ? undefined : d;
}

// What one click on an outcome does, for its tooltip: "Moves to Negotiating · follow-up Thu 22 Oct".
function outcomeTip(r, o, { meta, today, st }) {
  if (o.popover) return "Opens a short form first";
  if (o.needsNote) return "Write a note about the call first";
  const parts = [];
  const moves = { emailed: "Contacted", replied: "Replied", interested: "Negotiating", reopen: "Contacted" }[o.id];
  if (moves && moves !== r.stage) parts.push("Moves to " + moves);
  const picked = chipIso(st, today);
  const due = picked !== undefined ? picked : autoFollowUp(r, o.id, { meta, today });
  if (due) parts.push("follow-up " + short(due));
  return parts.join(" · ");
}

export function outsHtml(r, st, { meta, today }) {
  const { primary, more } = outcomesFor(r, { meta });
  const busy = !!(st && st.busy);
  const dis = busy ? raw(" disabled") : "";
  return html`${primary.map((o, i) => {
    const tip = outcomeTip(r, o, { meta, today, st });
    return html`<button type="button" class="ui-btn${i === 0 ? " is-primary" : ""}" data-outcome="${o.id}"${tip ? html` title="${tip}"` : ""}${dis}>${buttonLabel(o)}${o.popover ? "…" : ""}</button>`;
  })}${more.length ? html`<button type="button" class="ui-btn is-ghost" data-pmore aria-haspopup="menu"${dis}>More <span aria-hidden="true">▾</span></button>` : ""}`;
}

// The items of More ▾ (and of the phone footer's menu): label, hint "→ 22 Oct" or "…" for a form.
export function moreItems(r, list, { meta, today }) {
  return list.map((o) => {
    const due = autoFollowUp(r, o.id, { meta, today });
    return { label: buttonLabel(o), value: o.id, hint: o.popover ? "…" : due ? "→ " + fmtDate(due, "day") : "" };
  });
}

export function chipsHtml(st, today) {
  return html`${CHIPS.map((c) => {
    const on = st.chip === c.id;
    let label = c.label;
    if (c.id === "pick" && st.pickIso && on) label = short(st.pickIso);
    let tip = "";
    if (c.id === "auto") tip = "Each button above sets its own follow-up date";
    else if (c.id === "none") tip = "No follow-up date";
    else if (c.id !== "pick") tip = short(chipDate(c.id, today));
    return html`<button type="button" class="ui-chipbtn rc-chip" data-pchip="${c.id}" aria-pressed="${on ? "true" : "false"}"${tip ? html` title="${tip}"` : ""}${st.busy ? raw(" disabled") : ""}>${label}</button>`;
  })}`;
}

export function actsHtml(st, today) {
  const note = has(st.note);
  const iso = chipIso(st, today);
  const chip = iso !== undefined;
  let hint = "";
  if (st.busy) hint = "Saving…";
  else if (chip) hint = iso ? "Follow-up " + short(iso) : "No follow-up date";
  const dis = st.busy ? raw(" disabled") : "";
  const both = note && chip;
  return html`<span class="ui-small rc-hint" aria-live="polite">${hint}</span>${both
    ? html`<button type="button" class="ui-btn" data-psave="both"${dis}>Save note + follow-up</button>`
    : html`<button type="button" class="ui-btn" data-psave="note"${note && !st.busy ? "" : raw(" disabled")}>Save note</button><button type="button" class="ui-btn" data-psave="follow"${chip && !st.busy ? "" : raw(" disabled")}>Save follow-up</button>`}`;
}

export function errHtml(st) {
  if (!st.err) return html``;
  return html`${st.err} <button type="button" class="ui-linkbtn" data-pretry>Retry</button>`;
}

// The whole box. With readOnly, a line saying so instead of the controls.
export function renderLog(r, st, { meta, today, readOnly = false, roText = "" } = {}) {
  const title = html`<h3 class="ui-card-title rc-card-title" id="rc-log-h">Log what happened</h3>`;
  if (readOnly) return html`${title}<p class="ui-small rc-muted">${roText}</p>`;
  return html`${title}
<div class="ui-outs rc-outs" role="group" aria-label="What happened" data-pouts>${outsHtml(r, st, { meta, today })}</div>
<label class="sr-only" for="rc-note">Add a note (optional)</label>
<textarea id="rc-note" class="ui-input rc-note" rows="2" placeholder="Add a note (optional)" maxlength="2000" data-pnote>${st.note || ""}</textarea>
<fieldset class="ui-fieldset rc-follow"><legend class="ui-label rc-legend">Follow-up</legend><div class="ui-chips rc-chips" data-pchips>${chipsHtml(st, today)}</div></fieldset>
<p class="ui-error rc-err" role="alert" data-perr${st.err ? "" : raw(" hidden")}>${errHtml(st)}</p>
<div class="ui-logbox-acts rc-acts" data-pacts>${actsHtml(st, today)}</div>`;
}

// ---------- Toast wording (the panel saves quietly and says what happened itself) ----------

const FIELDS = ["stage", "owner", "clients", "type", "next_step", "next_due", "deal_model", "deal_flat", "deal_pct",
  "deal_value", "content_url", "live_date", "tracking_id"];

const val = (v) => (v == null ? "" : String(v));

// The stored fields of a Record (for Undo and for wording).
export function snapshot(r) {
  const out = {};
  for (const k of FIELDS) out[k] = r ? val(r[k]) : "";
  return out;
}

// The fields that changed, with their old values: what Undo sends back.
export function revertOf(before, after) {
  const out = {};
  for (const k of FIELDS) if (val(before[k]) !== val(after && after[k])) out[k] = val(before[k]);
  return out;
}

// "Moved to Negotiating · follow-up Thu 22 Oct", "Follow-up Mon 26 Oct", "Logged: Had a call".
export function outcomeText(o, before, after) {
  const a = after || {};
  const due = has(a.next_due) ? short(a.next_due) : "";
  if (o.id === "claim") return "Claimed" + (due ? " · follow-up " + due : "");
  if (val(a.stage) !== val(before.stage) && has(a.stage)) return "Moved to " + a.stage + (due ? " · follow-up " + due : "");
  if (due && val(a.next_due) !== val(before.next_due)) return "Follow-up " + due;
  return "Logged: " + buttonLabel(o);
}

export function followText(iso) {
  return iso ? "Follow-up " + short(iso) : "Follow-up cleared";
}
