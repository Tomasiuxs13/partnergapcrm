// Deal groups and totals (spec 2.2.3, Appendix B.5). Pure: everything takes derived Records
// (js/core/model.js#derive) and {meta, today}. Owner F4. No side effects at import time.
//
// Groups (B.5), in display order:
//   negotiating  stage Negotiating
//   signed       stage Active without a placement link (content_url)   "Signed, not live"
//   live         stage Active with a placement link
//   lost         stage Lost whose last activity is at most 30 local calendar days before today
// Readings used here (tests/unit/rules-deals.test.mjs fixes them):
// - Days are local calendar days (format.daysBetween), never "now minus noon UTC": a site moved to Lost
//   today is 0 days old at any hour (the old page dropped it after 12:00 UTC, because 0 counted as "no date").
// - A Lost site with no activity date at all is left out. A last activity after today (a typo in the sheet)
//   counts as recent, so the site stays visible.
// - Totals = sum(deal_value ?? deal_flat) for negotiating and signed (B.5), rounded to cents. `valued` says
//   how many sites in the group have a value, so the page can say a total leaves some out.
// - Going quiet = B.1 rule 5 (rules/today.js): not snoozed, and Negotiating quiet for more than
//   meta.sla.Negotiating days, or Active without a placement link quiet for more than meta.sla.ActiveNotLive.
// - Order inside a group: negotiating and signed by follow-up date (soonest first, no date last), then the
//   longest-quiet first; live by went-live date (newest first, no date last); lost by last activity (most
//   recent first). Ties keep id order.
import { daysBetween } from "../core/format.js";

export const LOST_DAYS = 30;

// The groups in display order. `total`: the group header shows the sum of the deal values.
export const GROUPS = [
  { id: "negotiating", label: "Negotiating", desc: "Talking terms.", total: true },
  { id: "signed", label: "Signed, not live", desc: "Agreed to work with us. No placement link yet.", total: true },
  { id: "live", label: "Live", desc: "Agreed, with a placement link.", total: false },
  { id: "lost", label: "Lost in the last 30 days", desc: "Said no or went quiet.", total: false },
];

const GROUP_IDS = GROUPS.map((g) => g.id);
const SLA = { Negotiating: 7, ActiveNotLive: 14 };
const has = (v) => v != null && String(v).trim() !== "";

function sla(meta, key) {
  const v = meta && meta.sla ? Number(meta.sla[key]) : NaN;
  return isFinite(v) ? v : SLA[key];
}

function num(v) {
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : Number(String(v).replace(/[$,%\s]/g, ""));
  return isFinite(n) ? n : null;
}

/** The deal's value for totals: deal_value, else deal_flat (B.5); null when neither is set. */
export function dealValue(r) {
  if (!r) return null;
  const v = num(r.deal_value);
  return v != null ? v : num(r.deal_flat);
}

/** Whether a Lost site's last activity is within the last 30 local calendar days. */
export function lostRecently(r, { today } = {}) {
  if (!r || r.stage !== "Lost" || !r.lastActivity || !today) return false;
  const d = daysBetween(r.lastActivity, today);
  return d != null && d <= LOST_DAYS;
}

/** The group id of a site ('negotiating' | 'signed' | 'live' | 'lost'), or null when it isn't a deal. */
export function groupOf(r, { today } = {}) {
  if (!r) return null;
  if (r.stage === "Negotiating") return "negotiating";
  if (r.stage === "Active") return has(r.content_url) ? "live" : "signed";
  if (lostRecently(r, { today })) return "lost";
  return null;
}

/** Going quiet (B.1 rule 5): the "Quiet 9d" chip on a deal row. */
export function isQuiet(r, { meta } = {}) {
  if (!r || r.snoozed || r.quietDays == null) return false;
  if (r.stage === "Negotiating") return r.quietDays > sla(meta, "Negotiating");
  if (r.stage === "Active" && !has(r.content_url)) return r.quietDays > sla(meta, "ActiveNotLive");
  return false;
}

function byId(a, b) {
  return String(a.id).localeCompare(String(b.id), "en", { numeric: true });
}

// Compares two keys; null goes first or last as asked. 0 when equal.
function cmp(x, y, { desc = false, nulls = "last" } = {}) {
  const nx = x == null, ny = y == null;
  if (nx || ny) return nx && ny ? 0 : (nx ? 1 : -1) * (nulls === "last" ? 1 : -1);
  if (x === y) return 0;
  return (x < y ? -1 : 1) * (desc ? -1 : 1);
}

const day = (v) => (has(v) ? String(v).slice(0, 10) : null);

const ORDER = {
  // Follow-up date soonest first (no date last), then the longest-quiet first (no activity date first).
  open: (a, b) => cmp(a.due || null, b.due || null) || cmp(a.lastActivity || null, b.lastActivity || null, { nulls: "first" }) || byId(a, b),
  live: (a, b) => cmp(day(a.live_date), day(b.live_date), { desc: true }) || byId(a, b),
  lost: (a, b) => cmp(a.lastActivity || null, b.lastActivity || null, { desc: true }) || byId(a, b),
};

function sum(list) {
  let cents = 0;
  for (const r of list) {
    const v = dealValue(r);
    if (v != null) cents += Math.round(v * 100);
  }
  return cents / 100;
}

/**
 * The deal groups (B.5): {negotiating, signed, live, lost, totals, valued, count}. Each group is a new array
 * of the records, in display order. totals: {negotiating, signed} (sum of deal_value ?? deal_flat);
 * valued: {negotiating, signed} (how many of them have a value); count: every deal in the four groups.
 * meta is not needed for the groups themselves; it is taken for the signature every rule shares.
 */
export function dealGroups(records, { meta, today } = {}) {
  void meta;
  const out = { negotiating: [], signed: [], live: [], lost: [] };
  for (const r of Array.isArray(records) ? records : []) {
    const g = groupOf(r, { today });
    if (g) out[g].push(r);
  }
  out.negotiating.sort(ORDER.open);
  out.signed.sort(ORDER.open);
  out.live.sort(ORDER.live);
  out.lost.sort(ORDER.lost);
  return Object.assign(out, {
    totals: { negotiating: sum(out.negotiating), signed: sum(out.signed) },
    valued: {
      negotiating: out.negotiating.filter((r) => dealValue(r) != null).length,
      signed: out.signed.filter((r) => dealValue(r) != null).length,
    },
    count: GROUP_IDS.reduce((n, g) => n + out[g].length, 0),
  });
}
