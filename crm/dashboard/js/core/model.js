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

const NUMERIC = ["dr", "traffic", "deal_flat", "deal_pct", "deal_value"];
const COUNTS = ["contacts", "sugg"];
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

function maxDay(list) {
  let best = null;
  for (const v of list) {
    const d = toDay(v);
    if (d && (!best || d > best)) best = d;
  }
  return best;
}

export function derive(raw, { meta, today } = {}) {
  const r = Object.assign({}, raw || {});
  for (const k of DERIVED) delete r[k];
  for (const k of NUMERIC) if (k in r) r[k] = numOrNull(r[k]);
  for (const k of COUNTS) r[k] = numOrNull(r[k]) || 0;
  const id = r.id == null ? "" : String(r.id);
  const stage = r.stage || "";

  const parts = splitClients(meta, r.clients);
  const cl = [];
  const ck = [];
  for (const p of parts) {
    const label = clientLabel(meta, p);
    if (!cl.includes(label)) cl.push(label);
    if (!ck.includes(p.k)) ck.push(p.k);
  }

  const lastActivity = maxDay([r.last_touch, r.last_email, r.act_at, r.updated_at]);
  const quietDays = lastActivity && today ? daysBetween(lastActivity, today) : null;

  let replyDate = null;
  let replySource = null;
  const repliedContact = r.replied_contact === true || Number(r.replied_contact) > 0;
  if (repliedContact && toDay(r.last_email)) {
    replyDate = toDay(r.last_email);
    replySource = "email";
  } else if (toDay(r.last_touch)) {
    replyDate = toDay(r.last_touch);
    replySource = "touch";
  }
  const win = (meta && meta.reply_window) || { email: 30, touch: 7 };
  const age = replyDate && today ? daysBetween(replyDate, today) : null;
  const replyFresh = age != null && age <= Number(win[replySource] != null ? win[replySource] : replySource === "email" ? 30 : 7);
  const actDay = toDay(r.act_at);
  const updDay = has(r.updated_by) ? toDay(r.updated_at) : null;
  const handled = !!replyDate && ((!!actDay && actDay >= replyDate) || (!!updDay && updDay >= replyDate));

  const due = toDay(r.next_due);
  const next = parseNext(r.next_step);
  const label = r.label || r.name || r.domain || "Unnamed creator";

  return Object.assign(r, {
    id,
    label,
    cl,
    ck,
    clientParts: parts,
    drb: drBand(r.dr),
    isNew: /^NEW-/i.test(id),
    isPlatform: isPlatform(meta, r.domain, r.dr),
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
    q: [id, r.domain, r.name, label, r.next_step].filter(has).join(" ").toLowerCase() + " " + normName(label),
  });
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

// TEMP until G1-B: a v1 /api/partners positional row (functions/api/partners.js row()) as a v2 object.
// [id, domain, name, type, dr, traffic, owner, stage, last_touch, clients, country, contacts, next_step,
//  next_due, deal_model, deal_flat, deal_pct, deal_value, live_date, content_url]
export function fromV1Row(a) {
  const s = (v) => (v == null || v === "" ? null : v);
  return {
    id: a[0], domain: s(a[1]), name: s(a[2]), label: s(a[2]) || s(a[1]) || "Unnamed creator", type: s(a[3]),
    dr: s(a[4]), traffic: s(a[5]), owner: s(a[6]), stage: s(a[7]), last_touch: s(a[8]), clients: s(a[9]),
    country: s(a[10]), contacts: a[11] || 0, next_step: s(a[12]), next_due: s(a[13]), deal_model: s(a[14]),
    deal_flat: s(a[15]), deal_pct: s(a[16]), deal_value: s(a[17]), live_date: s(a[18]), content_url: s(a[19]),
    tracking_id: null, source: null, updated_at: null, updated_by: null, last_email: null, replied_contact: null,
    act_at: null, sugg: null,
  };
}

// A v2 row array (cols order) as an object.
export function fromV2Row(row, cols = V2_COLS) {
  const o = {};
  for (let i = 0; i < cols.length; i++) o[cols[i]] = row[i];
  return o;
}
