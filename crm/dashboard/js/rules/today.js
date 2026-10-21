// Today rules (spec 2.2.1, Appendix B.1-B.3): Do now, New prospects, Coming up and the nav badge count.
// Pure: everything takes records (model.derive output) and {meta, today, me}. Owner F2. No side effects at
// import time.
//
// Readings of Appendix B used here (tests/unit/rules-today.test.mjs fixes them):
// - "owner = me" compares the trimmed owner with `me`, ignoring case. A falsy `me` means everyone's sites
//   (the team view the snapshot shows, spec 4.14, where nobody is signed in).
// - Each site gets the first B.1 reason that matches, in the order overdue, reply, decision, due, quiet,
//   noreply. Rows show in that order; ties inside a reason keep id order (PG-00001 before PG-00002).
// - decision: "oldest lastActivity first" puts sites with no activity date at all first (they are the oldest).
// - noreply keeps at most meta.noreply_cap (10) rows; doNowInfo() also returns how many there were.
// - New prospects sort: open suggestion first, then has a contact, then NEW- ids, then the id number
//   descending (NEW-0002 before NEW-0001, PG-00500 before PG-00499).
import { daysBetween } from "../core/format.js";

export const REASONS = ["overdue", "reply", "decision", "due", "quiet", "noreply"];

// The Do now header chips (B.1): Replies = 2; Follow-ups = 1, 4, 6; Deals = 3, 5.
export const GROUPS = {
  replies: ["reply"],
  followups: ["overdue", "due", "noreply"],
  deals: ["decision", "quiet"],
};

const SLA = { Contacted: 14, Replied: 3, Negotiating: 7, ActiveNotLive: 14 };
const NOREPLY_CAP = 10;
const has = (v) => v != null && String(v).trim() !== "";

function sla(meta, key) {
  const v = meta && meta.sla ? Number(meta.sla[key]) : NaN;
  return isFinite(v) ? v : SLA[key];
}

function cap(meta) {
  const v = meta && meta.noreply_cap != null ? Number(meta.noreply_cap) : NaN;
  return isFinite(v) && v >= 0 ? v : NOREPLY_CAP;
}

// "PG-00577" -> 577, "NEW-0003" -> 3.
function idNumber(id) {
  const m = /(\d+)\s*$/.exec(String(id || ""));
  return m ? Number(m[1]) : 0;
}

// One collator for every comparison: localeCompare(b, "en", {numeric: true}) builds a new one on each
// call (same order, about 20 times slower; Today sorts thousands of sites).
let idOrder = null;

function byId(a, b) {
  if (!idOrder) idOrder = new Intl.Collator("en", { numeric: true });
  return idOrder.compare(String(a.id), String(b.id));
}

// Ascending by key (nulls where `nulls` says), then by id.
function sortBy(list, key, { desc = false, nulls = "last" } = {}) {
  return list.sort((a, b) => {
    const x = key(a), y = key(b);
    const nx = x == null, ny = y == null;
    if (nx || ny) {
      if (nx && ny) return byId(a, b);
      return (nx ? 1 : -1) * (nulls === "last" ? 1 : -1);
    }
    if (x !== y) return (x < y ? -1 : 1) * (desc ? -1 : 1);
    return byId(a, b);
  });
}

/** Whether the site is owned by `me` (trimmed, any case). A falsy `me` matches every site. */
export function isMine(record, me) {
  if (!me) return true;
  const o = record && record.owner != null ? String(record.owner).trim().toLowerCase() : "";
  return o !== "" && o === String(me).trim().toLowerCase();
}

function mine(records, me) {
  return (Array.isArray(records) ? records : []).filter((r) => r && isMine(r, me));
}

const isQuiet = (r, meta) => !r.snoozed && r.quietDays != null && (
  (r.stage === "Negotiating" && r.quietDays > sla(meta, "Negotiating")) ||
  (r.stage === "Active" && !has(r.content_url) && r.quietDays > sla(meta, "ActiveNotLive")));

/** The first B.1 reason that matches the site, or null. */
export function reasonOf(r, { meta, today } = {}) {
  if (!r) return null;
  const due = r.due || null;
  if (!r.closed && due && due < today) return "overdue";
  if (r.stage === "Replied" && r.replyFresh && !r.handled && !r.snoozed) return "reply";
  if (r.stage === "Negotiating" && !r.waitingOnClient && !r.snoozed) return "decision";
  if (due && due === today) return "due";
  if (isQuiet(r, meta)) return "quiet";
  if (r.stage === "Contacted" && !r.snoozed && (r.lastActivity == null || r.quietDays > sla(meta, "Contacted"))) return "noreply";
  return null;
}

/** The chip for a reason: "Overdue 3d", "Replied 2d ago", "Your decision", "Due today", "Quiet 9d", "No reply 16d". */
export function chipText(r, reason, { today } = {}) {
  switch (reason) {
    case "overdue": return "Overdue " + daysBetween(r.due, today) + "d";
    case "reply": {
      const n = daysBetween(r.replyDate, today);
      return n === 0 ? "Replied today" : "Replied " + n + "d ago";
    }
    case "decision": return "Your decision";
    case "due": return "Due today";
    case "quiet": return "Quiet " + r.quietDays + "d";
    case "noreply": return r.lastActivity == null ? "No reply · no date" : "No reply " + r.quietDays + "d";
    default: return "";
  }
}

/**
 * Do now with its details: {rows: [{record, reason, chip, noDate}], noreplyTotal, counts: {reason: n},
 * groups: {all, replies, followups, deals}}. noreplyTotal counts the no-reply sites before the cap.
 */
export function doNowInfo(records, { meta, today, me } = {}) {
  const buckets = { overdue: [], reply: [], decision: [], due: [], quiet: [], noreply: [] };
  for (const r of mine(records, me)) {
    const reason = reasonOf(r, { meta, today });
    if (reason) buckets[reason].push(r);
  }
  sortBy(buckets.overdue, (r) => r.due); // most overdue = the earliest date
  sortBy(buckets.reply, (r) => r.replyDate, { desc: true });
  sortBy(buckets.decision, (r) => r.lastActivity, { nulls: "first" });
  buckets.due.sort(byId);
  sortBy(buckets.quiet, (r) => r.quietDays, { desc: true });
  sortBy(buckets.noreply, (r) => r.lastActivity); // oldest first, undated last
  const noreplyTotal = buckets.noreply.length;
  buckets.noreply = buckets.noreply.slice(0, cap(meta));
  const rows = [];
  const counts = {};
  for (const reason of REASONS) {
    counts[reason] = buckets[reason].length;
    for (const record of buckets[reason]) {
      rows.push({
        record,
        reason,
        chip: chipText(record, reason, { today }),
        noDate: (reason === "reply" || reason === "decision") && !record.due,
      });
    }
  }
  const groups = { all: rows.length };
  for (const [g, reasons] of Object.entries(GROUPS)) groups[g] = reasons.reduce((n, x) => n + counts[x], 0);
  return { rows, noreplyTotal, counts, groups };
}

/** Do now (B.1): [{record, reason, chip, noDate}] in display order. */
export function doNow(records, opts = {}) {
  return doNowInfo(records, opts).rows;
}

/** The Today badge: the number of Do now rows (counted without sorting them). */
export function doNowCount(records, { meta, today, me } = {}) {
  let n = 0;
  let noreply = 0;
  for (const r of mine(records, me)) {
    const reason = reasonOf(r, { meta, today });
    if (reason === "noreply") noreply++;
    else if (reason) n++;
  }
  return n + Math.min(noreply, cap(meta));
}

/** The Do now rows of one header chip ('all', 'replies', 'followups', 'deals'). */
export function filterDoNow(rows, group) {
  const reasons = GROUPS[group];
  return reasons ? (rows || []).filter((x) => reasons.includes(x.reason)) : (rows || []).slice();
}

/** New prospects (B.2): every matching site in order; the page shows the first 7. */
export function newProspects(records, { me } = {}) {
  const list = mine(records, me).filter((r) => r.notContacted && !r.isPlatform && !r.snoozed);
  const key = (r) => [Number(r.sugg) > 0 ? 0 : 1, Number(r.contacts) > 0 ? 0 : 1, r.isNew ? 0 : 1, -idNumber(r.id)];
  return list.map((r) => ({ r, k: key(r) })).sort((a, b) => {
    for (let i = 0; i < a.k.length; i++) if (a.k[i] !== b.k[i]) return a.k[i] - b.k[i];
    return byId(a.r, b.r);
  }).map((x) => x.r);
}

/** Coming up (B.3): my open sites with a future follow-up date, soonest first. */
export function comingUp(records, { me } = {}) {
  return sortBy(mine(records, me).filter((r) => r.snoozed && !r.closed), (r) => r.due);
}
