// Record derivation (spec 5.4, Appendix B definitions). Pure; owner G1-A.
// Record = the v2 columns (6.3.2) plus derived fields:
//   cl (display client names), ck (client keys), clientParts (splitClients output), label, drb,
//   isNew, isPlatform, notContacted, closed, lastActivity, quietDays, replyDate, replySource,
//   replyFresh, handled, snoozed, waitingOnClient, nextText, due, q.
// All dates are local calendar dates 'YYYY-MM-DD'; `today` is passed in, never read here.
import { toDay, daysBetween, normName } from "./format.js";
import { splitClients, clientLabel, isPlatform } from "./meta.js";

// Column order of GET /api/partners?v=2 (spec 6.3.2).
export const V2_COLS = ["id", "domain", "name", "label", "type", "dr", "traffic", "owner", "stage", "last_touch",
  "clients", "country", "contacts", "next_step", "next_due", "deal_model", "deal_flat", "deal_pct", "deal_value",
  "live_date", "content_url", "tracking_id", "source", "updated_at", "updated_by", "last_email", "replied_contact",
  "act_at", "sugg"];

// The keys derive() adds. store.upsert() ignores them when a whole Record is passed back in.
export const DERIVED = ["cl", "ck", "clientParts", "drb", "isNew", "isPlatform", "notContacted", "closed",
  "lastActivity", "quietDays", "replyDate", "replySource", "replyFresh", "handled", "snoozed", "waitingOnClient",
  "nextText", "due", "q"];

// NUMERIC: "dr", "traffic", "deal_flat", "deal_pct", "deal_value" become numbers or null where present;
// COUNTS: "contacts" and "sugg" always become numbers (0 when empty). See the end of derive().
const NOT_CONTACTED = ["New", "Researching"];
const CLOSED = ["Lost", "Do not contact"];
const WAITING = /^\s*waiting on client:\s*/i;

const numOrNull = (v) => {
  if (v == null || v === "") return null;
  const n = Number(v);
  return isFinite(n) ? n : null;
};

const has = (v) => v != null && v !== "";

// DR bands as on the old site: 80+, 60-79, 40-59, 20-39, 0-19 ('' without a DR).
export function drBand(dr) {
  const n = numOrNull(dr);
  if (n == null) return "";
  return n >= 80 ? "80+" : n >= 60 ? "60-79" : n >= 40 ? "40-59" : n >= 20 ? "20-39" : "0-19";
}

function maxDay(...list) {
  let best = null;
  for (const v of list) {
    if (v == null || v === "") continue;
    const d = toDay(v);
    if (d && (!best || d > best)) best = d;
  }
  return best;
}

// Speed (spec 6.6, G3-4): a record is built as one object literal (a spread of the raw row plus the
// derived keys), so V8 keeps it in fast-property mode. Copying and then deleting or adding keys one by
// one, as before, cost about 14 µs a site (100 ms for 7,500) and left slow (dictionary) objects that
// every rule and list then read slowly. The result is the same: the raw columns (NUMERIC normalized
// where present, COUNTS always numbers) plus the DERIVED keys, id and label.
export function derive(raw, { meta, today } = {}) {
  const src = raw || {};
  const id = src.id == null ? "" : String(src.id);
  const stage = src.stage || "";
  const dr = numOrNull(src.dr);

  const parts = splitClients(meta, src.clients);
  const cl = [];
  const ck = [];
  for (const p of parts) {
    const label = clientLabel(meta, p);
    if (!cl.includes(label)) cl.push(label);
    if (!ck.includes(p.k)) ck.push(p.k);
  }

  const lastActivity = maxDay(src.last_touch, src.last_email, src.act_at, src.updated_at);
  const quietDays = lastActivity && today ? daysBetween(lastActivity, today) : null;

  let replyDate = null;
  let replySource = null;
  const repliedContact = src.replied_contact === true || Number(src.replied_contact) > 0;
  const emailDay = repliedContact ? toDay(src.last_email) : null;
  if (emailDay) {
    replyDate = emailDay;
    replySource = "email";
  } else {
    const touchDay = toDay(src.last_touch);
    if (touchDay) {
      replyDate = touchDay;
      replySource = "touch";
    }
  }
  const win = (meta && meta.reply_window) || { email: 30, touch: 7 };
  const age = replyDate && today ? daysBetween(replyDate, today) : null;
  const replyFresh = age != null && age <= Number(win[replySource] != null ? win[replySource] : replySource === "email" ? 30 : 7);
  const actDay = toDay(src.act_at);
  const updDay = has(src.updated_by) ? toDay(src.updated_at) : null;
  const handled = !!replyDate && ((!!actDay && actDay >= replyDate) || (!!updDay && updDay >= replyDate));

  const due = toDay(src.next_due);
  const next = parseNext(src.next_step);
  const label = src.label || src.name || src.domain || "Unnamed creator";

  const r = {
    ...src,
    id,
    label,
    cl,
    ck,
    clientParts: parts,
    drb: drBand(dr),
    isNew: /^NEW-/i.test(id),
    isPlatform: isPlatform(meta, src.domain, dr),
    notContacted: NOT_CONTACTED.includes(stage),
    closed: CLOSED.includes(stage),
    lastActivity,
    quietDays,
    replyDate,
    replySource,
    replyFresh,
    handled,
    snoozed: !!(due && today && due > today),
    waitingOnClient: next.waitingOnClient,
    nextText: next.text,
    due: due || null,
    q: [id, src.domain, src.name, label, src.next_step].filter(has).join(" ").toLowerCase() + " " + normName(label),
  };
  // NUMERIC where present, COUNTS always (named stores keep the record's shape fast).
  if ("dr" in src) r.dr = dr;
  if ("traffic" in src) r.traffic = numOrNull(src.traffic);
  if ("deal_flat" in src) r.deal_flat = numOrNull(src.deal_flat);
  if ("deal_pct" in src) r.deal_pct = numOrNull(src.deal_pct);
  if ("deal_value" in src) r.deal_value = numOrNull(src.deal_value);
  r.contacts = numOrNull(src.contacts) || 0;
  r.sugg = numOrNull(src.sugg) || 0;
  return r;
}

// Adds or removes the "Waiting on client: " prefix (spec D2). The rest of the text is kept.
// setWaitingOnClient("Agree terms", true) -> "Waiting on client: Agree terms";
// setWaitingOnClient("Waiting on client: Agree terms", false) -> "Agree terms".
export function setWaitingOnClient(nextStep, on) {
  const { text } = parseNext(nextStep);
  return on ? ("Waiting on client: " + text).trim() : text;
}

// {waitingOnClient, text}: the flag and the next step without the prefix (case-insensitive).
export function parseNext(nextStep) {
  const s = String(nextStep == null ? "" : nextStep);
  if (WAITING.test(s)) return { waitingOnClient: true, text: s.replace(WAITING, "").trim() };
  return { waitingOnClient: false, text: s.trim() };
}

// Per cols array: an object with every column set to undefined (Object.fromEntries keeps it in
// fast-property mode). Filled by key one at a time, a fresh {} turns into a slow dictionary object
// after about a dozen keys.
const shapes = new WeakMap();

function shapeOf(cols) {
  let t = shapes.get(cols);
  if (!t) {
    t = Object.fromEntries(cols.map((k) => [k, undefined]));
    shapes.set(cols, t);
  }
  return t;
}

// A v2 row array (cols order) as an object.
export function fromV2Row(row, cols = V2_COLS) {
  const o = { ...shapeOf(cols) };
  for (let i = 0; i < cols.length; i++) o[cols[i]] = row[i];
  return o;
}
