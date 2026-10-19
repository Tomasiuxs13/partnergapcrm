// Outcome catalogue (Appendix A) and the request builder for POST /api/partner/:id/outcome (6.3.3).
// Pure: everything takes meta, today and me as arguments. Owner G1-C. No side effects at import time.
//
// Readings of Appendix A used here (the same ones tests/unit/outcomes.test.mjs fixes):
// - Auto follow-up: +N working days when N <= 3, else +N calendar days. "Stage default" (Had a call)
//   is meta.follow_up_days[stage] under the same rule.
// - `fields` keys come in EDITABLE order (lib/crm.js), so the PATCH half writes the golden rows in order.
// - Clearing a field sends "".
// - terms = {deal_model, deal_flat, deal_pct, deal_value}; in summaries "$350 + 30%", "$350" or "30%".
// - The activity `client` is the display name of the site's first client token ("Ultahost" -> "UltaHost").
// - An outcome that can't be built (Placement is live without an http(s) link, Had a call without a
//   note, Do not contact while the flag is off, Assign to client manager without a manager) throws an
//   Error whose message is a plain sentence for the person.
import { addDays, addWorkingDays, nextMonday, money, pct } from "./format.js";
import { splitClients, clientLabel } from "./meta.js";
import { setWaitingOnClient } from "./model.js";

// Same order as lib/crm.js EDITABLE (the old PATCH writes one update row per key, in request order).
export const FIELD_ORDER = ["stage", "owner", "clients", "type", "next_step", "next_due", "deal_model", "deal_flat",
  "deal_pct", "deal_value", "content_url", "live_date", "tracking_id"];

const TERM_KEYS = ["deal_model", "deal_flat", "deal_pct", "deal_value"];

// popover: the small form shown before saving: 'reason', 'terms' (required), 'terms?' (optional) or
// 'link'; null for one-click outcomes. needsNote: the note box must have text.
// days: the automatic follow-up (null = none; 'stage' = meta.follow_up_days[stage]). next: next_step.
export const OUTCOMES = [
  { id: "emailed", label: "Sent first email", popover: null, days: 7, next: "Follow up if no reply" },
  { id: "followed_up", label: "Sent a follow-up", popover: null, days: { Contacted: 7, Replied: 2, default: 7 }, next: "Follow up if no reply" },
  { id: "replied", label: "They replied", popover: null, days: 2, next: "Answer their reply" },
  { id: "interested", label: "Interested", popover: null, days: 3, next: "Agree terms" },
  { id: "not_interested", label: "Not interested", popover: "reason", days: null, closes: true },
  { id: "approve", label: "Approve offer", popover: null, days: 1, next: "Send agreement and brief" },
  { id: "counter", label: "Counter-offer", popover: "terms", days: 3, next: "Wait for their answer to the counter-offer" },
  { id: "ask_client", label: "Ask the client", popover: null, days: 3, next: "decision on the offer" },
  { id: "signed", label: "Signed", popover: "terms?", days: 14, next: "Check the placement is live" },
  { id: "live", label: "Placement is live", popover: "link", days: 30, next: "Check results" },
  { id: "bounced", label: "Bounced / wrong person", popover: null, days: 2, next: "Find a new contact" },
  { id: "called", label: "Had a call", popover: null, needsNote: true, days: "stage", next: null },
  { id: "dnc", label: "Do not contact (flag)", popover: "reason", days: null, closes: true, flag: "dnc" },
  { id: "claim", label: "Claim", popover: null, days: 2, next: "Find the right contact and email", nextIfEmpty: true },
  { id: "assign_manager", label: "Assign to client manager", popover: null, days: null },
  { id: "not_fit", label: "Not a fit", popover: "reason", days: null, closes: true },
  { id: "reopen", label: "Reopen", popover: null, days: 7, next: "Follow up" },
];

const BY_ID = new Map(OUTCOMES.map((o) => [o.id, o]));

export function outcome(id) {
  return BY_ID.get(id) || null;
}

// The button text: "Do not contact" without the catalogue's "(flag)" note.
export function buttonLabel(o) {
  const x = typeof o === "string" ? outcome(o) : o;
  return x ? x.label.replace(/\s*\(flag\)$/, "") : "";
}

const STAGE_BUTTONS = {
  New: { primary: ["emailed", "not_fit", "claim"], more: ["dnc"] },
  Researching: { primary: ["emailed", "not_fit", "claim"], more: ["dnc"] },
  Contacted: { primary: ["replied", "followed_up", "not_interested"], more: ["interested", "bounced", "dnc"] },
  Replied: { primary: ["interested", "followed_up", "not_interested"], more: ["ask_client", "signed", "called", "bounced"] },
  Negotiating: { primary: ["approve", "counter", "ask_client", "not_interested"], more: ["signed", "called"] },
  Active: { primary: ["live", "called"], more: ["not_interested"] },
  Lost: { primary: ["reopen"], more: [] },
  "Do not contact": { primary: ["reopen"], more: [] },
};

const has = (v) => v != null && String(v).trim() !== "";

function dncOn(meta) {
  return !!(meta && meta.features && meta.features.dnc);
}

// {primary, more}: the outcome objects that fit the site's stage (Appendix A). Claim only when the
// site has no owner; Do not contact only with meta.features.dnc. A site without a stage counts as New.
export function outcomesFor(record, { meta } = {}) {
  const stage = (record && record.stage) || "New";
  const set = STAGE_BUTTONS[stage] || STAGE_BUTTONS.New;
  const keep = (id) => {
    if (id === "claim" && has(record && record.owner)) return false;
    if (id === "dnc" && !dncOn(meta)) return false;
    return true;
  };
  return {
    primary: set.primary.filter(keep).map(outcome),
    more: set.more.filter(keep).map(outcome),
  };
}

// ---------- Dates ----------

// +n days: working days when n <= 3 (Appendix A), else calendar days.
export function autoDate(today, n) {
  const k = Number(n);
  if (!isFinite(k) || !today) return "";
  return k <= 3 ? addWorkingDays(today, k) : addDays(today, k);
}

// The follow-up chips of the Log what happened box (4.2). The Follow up menu (4.5) uses the same ids
// with its own labels. Working-day presets skip weekends.
export const CHIPS = [
  { id: "auto", label: "Auto" },
  { id: "tomorrow", label: "Tomorrow" },
  { id: "3d", label: "3 days" },
  { id: "week", label: "Next week" },
  { id: "2w", label: "2 weeks" },
  { id: "pick", label: "Pick…" },
  { id: "none", label: "None" },
];

// A chip id (or an ISO date) as a date: 'none'/'clear' give "" (no date); unknown ids give null.
export function chipDate(chip, today) {
  switch (chip) {
    case "tomorrow": return addWorkingDays(today, 1);
    case "3d": return addWorkingDays(today, 3);
    case "week":
    case "monday": return nextMonday(today);
    case "2w": return addDays(today, 14);
    case "none":
    case "clear": return "";
    default:
      return /^\d{4}-\d{2}-\d{2}$/.test(String(chip || "")) ? String(chip) : null;
  }
}

function autoDays(o, stage, meta) {
  if (o.days == null) return null;
  if (o.days === "stage") {
    const d = meta && meta.follow_up_days ? meta.follow_up_days[stage] : null;
    return d == null ? null : Number(d);
  }
  if (typeof o.days === "object") return o.days[stage] != null ? o.days[stage] : o.days.default;
  return o.days;
}

// The date the outcome proposes before any chip ("" when it proposes none).
export function autoFollowUp(record, outcomeId, { meta, today } = {}) {
  const o = outcome(outcomeId);
  if (!o) return "";
  const n = autoDays(o, (record && record.stage) || "New", meta);
  return n == null ? "" : autoDate(today, n);
}

// ---------- Text ----------

const num = (v) => {
  if (v == null || v === "") return null;
  const n = Number(String(v).replace(/[$,%\s]/g, ""));
  return isFinite(n) ? n : null;
};

// "$350 + 30%", "$350", "30%", or the deal value ("$1,200") when only that is known; "" otherwise.
export function termsText(terms) {
  const t = terms || {};
  const flat = num(t.deal_flat);
  const p = num(t.deal_pct);
  const parts = [];
  if (flat != null) parts.push(money(flat));
  if (p != null) parts.push(pct(p));
  if (parts.length) return parts.join(" + ");
  const v = num(t.deal_value);
  return v != null ? money(v) : "";
}

const clean = (s) => String(s == null ? "" : s).replace(/\s+/g, " ").trim();
const noStop = (s) => clean(s).replace(/[.\s]+$/, "");

// "Head. note" or "Head." (a sentence and the optional note).
function sentence(head, note) {
  const n = clean(note);
  return noStop(head) + "." + (n ? " " + n : "");
}

// "Head: detail. note", or "Head. note" when there is no detail.
function labelled(head, detail, note) {
  const d = noStop(detail);
  return d ? sentence(head + ": " + d, note) : sentence(head, note);
}

// The display name of the site's first client token ("UltaHost", "Melograno - Trafft"), or null.
export function firstClientName(record, meta) {
  const parts = splitClients(meta, record && record.clients);
  return parts.length ? clientLabel(meta, parts[0]) || null : null;
}

// The first manager of the site's first client (Assign to client manager), or null.
export function clientManager(record, meta) {
  const parts = splitClients(meta, record && record.clients);
  if (!parts.length) return null;
  const c = ((meta && meta.clients) || []).find((x) => x.k === parts[0].k);
  return c && Array.isArray(c.managers) && c.managers.length ? c.managers[0] : null;
}

const HTTP = /^https?:\/\/[^\s]+$/i;

function fail(message) {
  const e = new Error(message);
  e.friendly = message;
  return e;
}

function ordered(fields) {
  const out = {};
  for (const k of FIELD_ORDER) if (k in fields) out[k] = fields[k];
  return out;
}

// Only the deal fields the person gave (undefined and null are left out; "" clears one).
function termFields(terms) {
  const out = {};
  if (!terms || typeof terms !== "object") return out;
  for (const k of TERM_KEYS) if (terms[k] !== undefined && terms[k] !== null) out[k] = terms[k];
  return out;
}

const hasTerms = (terms) => !!termsText(terms) || has(terms && terms.deal_model);

// {fields, activity}: the body of POST /api/partner/:id/outcome (6.3.3) without `by`.
// opts: note, reason, terms, link, date (Placement is live: the went-live date, default today),
// followUp (a chip id or an ISO date; 'auto' or undefined = the outcome's own date; 'none' = no date),
// me, meta, today. Throws an Error with a plain message when the outcome can't be built.
export function buildOutcomeRequest(record, outcomeId, { note, reason, terms, link, date, followUp, me, meta, today } = {}) {
  const o = outcome(outcomeId);
  if (!o) throw fail("Pick what happened.");
  const r = record || {};
  const stage = r.stage || "New";
  const n = clean(note);
  const why = clean(reason);
  const fields = {};
  let activity = null;
  const client = firstClientName(r, meta);
  const act = (type, summary) => {
    activity = { type, summary: clean(summary).slice(0, 2000) };
    if (client) activity.client = client;
  };

  // The follow-up date: the chip when one is picked, else the outcome's automatic date.
  let due = autoFollowUp(r, o.id, { meta, today });
  const picked = followUp == null || followUp === "auto" ? null : chipDate(followUp, today);
  if (picked != null) due = picked;
  const setFollowUp = (nextStep) => {
    if (nextStep != null) fields.next_step = nextStep;
    fields.next_due = due;
  };

  switch (o.id) {
    case "emailed":
      fields.stage = "Contacted";
      setFollowUp(o.next);
      act("Email", sentence("Sent first email", n));
      break;
    case "followed_up":
      setFollowUp(o.next);
      act("Email", sentence("Sent a follow-up", n));
      break;
    case "replied":
      fields.stage = "Replied";
      setFollowUp(o.next);
      act("Email", n ? "They replied: " + n : "They replied");
      break;
    case "interested":
      fields.stage = "Negotiating";
      setFollowUp(o.next);
      act("Email", sentence("Interested", n));
      break;
    case "not_interested":
      fields.stage = "Lost";
      fields.next_step = "";
      fields.next_due = "";
      act(stage === "Contacted" || stage === "Replied" ? "Email" : "Deal update", labelled("Not interested", why, n));
      break;
    case "approve": {
      setFollowUp(o.next);
      const t = termsText(r);
      act("Deal update", t ? sentence("Approved " + t, n) : sentence("Approved the offer", n));
      break;
    }
    case "counter":
      if (!hasTerms(terms)) throw fail("Add the terms of the counter-offer.");
      setFollowUp(o.next);
      Object.assign(fields, termFields(terms));
      act("Deal update", labelled("Countered", termsText(terms) || clean(terms.deal_model), n));
      break;
    case "ask_client":
      setFollowUp(setWaitingOnClient(n || o.next, true));
      act("Note", n ? "Asked client: " + n : "Asked client:");
      break;
    case "signed": {
      fields.stage = "Active";
      setFollowUp(o.next);
      Object.assign(fields, termFields(terms));
      const t = hasTerms(terms) ? termsText(terms) || clean(terms.deal_model) : termsText(r);
      act("Deal update", labelled("Signed", t, n));
      break;
    }
    case "live": {
      const url = clean(link);
      if (!HTTP.test(url)) throw fail("Add the placement link (it starts with http:// or https://).");
      const day = /^\d{4}-\d{2}-\d{2}$/.test(String(date || "")) ? String(date) : today;
      setFollowUp(o.next);
      fields.content_url = url;
      fields.live_date = day;
      act("Content live", n ? url + " " + n : url);
      break;
    }
    case "bounced":
      setFollowUp(o.next);
      act("Note", sentence("Bounced or wrong person", n));
      break;
    case "called":
      if (!n) throw fail("Write a short note about the call.");
      if (due) fields.next_due = due;
      else if (picked === "") fields.next_due = "";
      act("Call", n);
      break;
    case "dnc":
      if (!dncOn(meta)) throw fail("\"Do not contact\" isn't turned on yet.");
      fields.stage = "Do not contact";
      fields.next_step = "";
      fields.next_due = "";
      act("Note", why ? "Do not contact: " + noStop(why) : "Do not contact");
      break;
    case "claim":
      if (!has(me)) throw fail("Pick your name first.");
      fields.owner = me;
      if (!has(r.next_step)) fields.next_step = o.next;
      fields.next_due = due;
      break;
    case "assign_manager": {
      const m = clientManager(r, meta);
      if (!m) throw fail("This site's client has no manager.");
      fields.owner = m;
      break;
    }
    case "not_fit":
      fields.stage = "Lost";
      fields.next_step = "";
      fields.next_due = "";
      act("Note", why ? "Not a fit: " + noStop(why) + (n ? ". " + n : "") : sentence("Not a fit", n));
      break;
    case "reopen":
      fields.stage = "Contacted";
      setFollowUp(o.next);
      act("Note", sentence("Reopened", n));
      break;
    default:
      throw fail("Pick what happened.");
  }
  return { fields: ordered(fields), activity };
}
