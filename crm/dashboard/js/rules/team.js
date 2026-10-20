// Team overview rules (spec 2.2.5, Appendix B.7): Needs a decision, Stuck, the Team table, the Data clean-up
// counts, the Charts and where each number leads. Pure: everything takes derived Records
// (js/core/model.js#derive) and {meta, today}. Owner F6. No side effects at import time.
//
// Readings of Appendix B.7 used here (tests/unit/rules-team.test.mjs fixes them):
// - "B.1 rule N" is that rule's own test, for every owner, without Today's first-match order: an overdue
//   Negotiating deal is both "overdue now" and in Needs a decision.
// - Owners compare trimmed and ignoring case, as on Sites. Team rows: the active team (meta.team), then past
//   owners who still own sites ("Jay"), then "No owner" when some site has none.
// - Needs a decision is grouped by owner: the biggest group first (ties by name), "No owner" last; inside a
//   group the longest-quiet first (no activity date at all first), then by id.
// - The "Waiting on client?" hint: the next step names one of the site's clients (display name, stored token
//   or alias), or has the word "waiting" or "client". The program card has no contact-name field, so there
//   are no manager contact names to match.
// - Unanswered replies (Stuck): Replied, inside the reply window, not handled, and the reply at least
//   meta.sla.Replied (3) days old. No snooze test (B.7 lists none).
// - Every number opens a list with the same count: target() names a Sites view when Sites can show exactly
//   those sites, otherwise the Team overview's own list (#team?show=<flag>&owner=<name|none>). SITES_FLAGS
//   lists the flags Sites itself filters with flag=<id> (empty until it does; NEEDS.md, F6 1).
import { daysBetween, toDay } from "../core/format.js";
import { splitClients, clientLabel } from "../core/meta.js";
import { isNoReply } from "./sites.js";
import { isQuiet } from "./deals.js";

const has = (v) => v != null && String(v).trim() !== "";
const keyOf = (s) => String(s == null ? "" : s).trim().toLowerCase();
const SLA_REPLIED = 3;
const NO_OWNER = "No owner";

function sla(meta, k, fallback) {
  const v = meta && meta.sla ? Number(meta.sla[k]) : NaN;
  return isFinite(v) ? v : fallback;
}

function byId(a, b) {
  return String(a.id).localeCompare(String(b.id), "en", { numeric: true });
}

// Ascending by key (null first or last), then by id.
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

// NEW- ids first, then the PG number: the Sites "newest first" order (sort descending).
function newest(r) {
  const m = /(\d+)\s*$/.exec(String(r.id || ""));
  return (r.isNew ? 10000000 : 0) + (m ? Number(m[1]) : 0);
}
const newestFirst = (list) => list.sort((a, b) => newest(b) - newest(a) || byId(a, b));

// ---------- predicates (B.1, B.4, B.7) ----------

/** B.1 rule 1: not closed and the follow-up date is before today. */
export function isOverdue(r, { today } = {}) {
  return !!r && !r.closed && !!r.due && !!today && r.due < today;
}

/** B.1 rule 2: Replied, inside the reply window, not handled, not snoozed ("Replies waiting"). */
export function isReplyWaiting(r) {
  return !!r && r.stage === "Replied" && !!r.replyFresh && !r.handled && !r.snoozed;
}

/** Stuck "Unanswered replies (3+ days)": Replied, fresh, not handled, the reply at least sla.Replied days old. */
export function isUnanswered(r, { meta, today } = {}) {
  if (!r || r.stage !== "Replied" || !r.replyFresh || r.handled || !r.replyDate || !today) return false;
  const n = daysBetween(r.replyDate, today);
  return n != null && n >= sla(meta, "Replied", SLA_REPLIED);
}

/** B.1 rule 3: Negotiating, not waiting on the client, not snoozed. */
export function isDecision(r) {
  return !!r && r.stage === "Negotiating" && !r.waitingOnClient && !r.snoozed;
}

const UNCATEGORIZED = /^\s*uncategori[sz]ed\s*$/i;

/** A stored client token that isn't written the canonical way, or isn't a known client (B.4 clean-up). */
export function hasOddClient(r, { meta } = {}) {
  const parts = (r && r.clientParts) || splitClients(meta, r && r.clients);
  return parts.some((p) => !p.known || p.raw !== clientLabel(meta, p));
}

// The lists a number can open. label: the list's heading; desc: one line under it; test(r, {meta, today});
// order(list, {meta, today}): the order the list shows (sorts in place and returns it).
export const FLAGS = {
  owns: { label: "All sites", desc: "Every site, in every stage.", test: () => true, order: newestFirst },
  prospects: { label: "Prospects", desc: "Not contacted yet (New or Researching).", test: (r) => !!r.notContacted, order: newestFirst },
  emailed: { label: "Emailed", desc: "Emailed and waiting for an answer.", test: (r) => r.stage === "Contacted",
    order: (list) => sortBy(list, (r) => r.lastActivity) },
  negotiating: { label: "Negotiating", desc: "Talking terms.", test: (r) => r.stage === "Negotiating",
    order: (list) => sortBy(list, (r) => r.lastActivity, { nulls: "first" }) },
  active: { label: "Active", desc: "Agreed to work with us.", test: (r) => r.stage === "Active", order: newestFirst },
  replies: { label: "Replies waiting", desc: "Wrote back recently and nobody has answered yet.", test: isReplyWaiting,
    order: (list) => sortBy(list, (r) => r.replyDate) },
  overdue: { label: "Overdue follow-ups", desc: "The follow-up date has passed.", test: isOverdue,
    order: (list) => sortBy(list, (r) => r.due) },
  quiet: { label: "Deals going quiet", desc: "Talking terms, or signed without a placement, and nothing has happened for a while.",
    test: (r, o) => isQuiet(r, o), order: (list) => sortBy(list, (r) => r.quietDays, { desc: true }) },
  unanswered: { label: "Unanswered replies", desc: "Wrote back 3 or more days ago and nobody has answered yet.", test: isUnanswered,
    order: (list) => sortBy(list, (r) => r.replyDate) },
  noreply: { label: "No reply in 14+ days", desc: "Emailed more than 14 days ago, with no answer and no later follow-up date.",
    test: (r, o) => isNoReply(r, o), order: (list) => sortBy(list, (r) => r.lastActivity) },
  unowned: { label: "Unowned new prospects", desc: "New sites nobody owns yet (big sites left out).",
    test: (r) => !!r.notContacted && !has(r.owner) && !r.isPlatform, order: newestFirst },
  decision: { label: "Needs a decision", desc: "Negotiating deals that wait on us, not on the client.", test: isDecision,
    order: (list) => sortBy(list, (r) => r.lastActivity, { nulls: "first" }) },
  replied_nodate: { label: "Replied with no date", desc: "Replied sites without a reply date or a last touch.",
    test: (r) => r.stage === "Replied" && !r.replyDate, order: newestFirst },
  replied_old: { label: "Replied, last touch over 30 days", desc: "Replied sites whose last touch is more than 30 days old.",
    test: (r, { today } = {}) => {
      if (r.stage !== "Replied" || !today) return false;
      const t = toDay(r.last_touch);
      const n = t ? daysBetween(t, today) : null;
      return n != null && n > 30;
    },
    order: (list) => sortBy(list, (r) => toDay(r.last_touch)) },
  no_owner: { label: "No owner", desc: "Open sites (not Lost or Do not contact) without an owner.",
    test: (r) => !has(r.owner) && !r.closed, order: newestFirst },
  odd_clients: { label: "Client name variants", desc: "A client written another way than its name (such as “Ultahost”), or not a known client.",
    test: (r, o) => hasOddClient(r, o), order: newestFirst },
  no_type: { label: "Type not set", desc: "Sites whose type is empty or was never chosen.", test: (r) => !has(r.type) || UNCATEGORIZED.test(String(r.type)),
    order: newestFirst },
};

export const FLAG_IDS = Object.keys(FLAGS);

// The flags Sites filters itself with flag=<id> (spec 2.2.5 "Sites filtered by that owner (and stage or flag)").
// Empty until Sites reads flag= (NEEDS.md, F6 1); those numbers open the Team overview's own list meanwhile.
export const SITES_FLAGS = [];

function ownerTest(owner) {
  if (owner == null || owner === "" || owner === "all") return () => true;
  if (owner === "none") return (r) => !has(r.owner);
  const k = keyOf(owner);
  return (r) => keyOf(r.owner) === k;
}

/** The sites behind one number: the flag's sites, of one owner (a name, "none" or nothing = everyone), in order. */
export function flagged(records, flag, { meta, today, owner } = {}) {
  const f = FLAGS[flag];
  if (!f) return [];
  const mine = ownerTest(owner);
  const o = { meta, today };
  const list = (Array.isArray(records) ? records : []).filter((r) => r && mine(r) && f.test(r, o));
  return f.order(list, o);
}

/**
 * Where a number leads: {page: "sites", params} when Sites shows exactly those sites, else
 * {page: "team", params: {show, owner?}} (the Team overview's own list). owner: a name, "none" or null.
 * Sites hides big sites unless big=1, so the links that count every site add it.
 */
export function target(flag, { owner = null } = {}) {
  const o = owner == null || owner === "" ? null : String(owner);
  const own = o ? { owner: o } : {};
  switch (flag) {
    case "owns": return { page: "sites", params: Object.assign({ tab: "all" }, own, { big: "1" }) };
    case "emailed": return { page: "sites", params: { tab: "waiting", owner: o || "all" } };
    case "negotiating": return { page: "sites", params: Object.assign({ tab: "all" }, own, { stage: "Negotiating", big: "1" }) };
    case "active": return { page: "sites", params: Object.assign({ tab: "all" }, own, { stage: "Active", big: "1" }) };
    case "noreply": if (!o) return { page: "sites", params: { tab: "waiting", quiet: "14", owner: "all" } }; break;
    case "unowned": if (!o) return { page: "sites", params: { tab: "unowned" } }; break;
    case "replied_nodate": if (!o) return { page: "sites", params: { tab: "all", preset: "replied_nodate", big: "1" } }; break;
    default: break;
  }
  if (SITES_FLAGS.includes(flag)) return { page: "sites", params: Object.assign({ tab: "all", flag }, own, { big: "1" }) };
  return { page: "team", params: Object.assign({ show: flag }, own) };
}

// ---------- Needs a decision ----------

function clientWords(r, meta) {
  const out = new Set();
  for (const p of r.clientParts || splitClients(meta, r.clients)) {
    for (const w of [p.name, p.raw, p.k, clientLabel(meta, p)]) if (has(w)) out.add(keyOf(w));
    const c = ((meta && meta.clients) || []).find((x) => x.k === p.k);
    for (const a of (c && c.aliases) || []) if (has(a)) out.add(keyOf(a));
  }
  return Array.from(out).filter((w) => w.length >= 3);
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The "Waiting on client?" hint (B.7): the next step names the site's client, or says "waiting" or "client". */
export function decisionHint(r, { meta } = {}) {
  if (!r || r.waitingOnClient) return false;
  const text = keyOf(r.nextText != null ? r.nextText : r.next_step);
  if (!text) return false;
  if (/\b(waiting|client)\b/.test(text)) return true;
  return clientWords(r, meta).some((w) => new RegExp("(^|[^a-z0-9])" + escapeRe(w) + "($|[^a-z0-9])").test(text));
}

// Active team names by lower-case key (the team's own spelling as the value).
function teamIndex(meta) {
  const m = new Map();
  for (const t of (meta && meta.team) || []) {
    if (!t || !has(t.name) || t.active === false) continue;
    const k = keyOf(t.name);
    if (!m.has(k)) m.set(k, String(t.name).trim());
  }
  return m;
}

/**
 * Needs a decision (B.7 = B.1 rule 3, every owner), grouped by owner:
 * [{owner, key, none, records: [Record]}], the biggest group first, "No owner" last.
 */
export function needsDecision(records, { meta, today } = {}) {
  const groups = new Map();
  for (const r of Array.isArray(records) ? records : []) {
    if (!isDecision(r)) continue;
    const k = keyOf(r.owner);
    if (!groups.has(k)) groups.set(k, { owner: k ? String(r.owner).trim() : NO_OWNER, key: k, none: !k, records: [] });
    groups.get(k).records.push(r);
  }
  const team = teamIndex(meta);
  const list = Array.from(groups.values());
  for (const g of list) {
    if (team.has(g.key)) g.owner = team.get(g.key);
    FLAGS.decision.order(g.records, { meta, today });
  }
  return list.sort((a, b) => (a.none - b.none) || (b.records.length - a.records.length) || a.owner.localeCompare(b.owner));
}

// ---------- Stuck ----------

export const STUCK = ["overdue", "unanswered", "quiet", "noreply", "unowned"];

/** The 5 Stuck counts (B.7), every owner: {overdue, unanswered, quiet, noreply, unowned}. */
export function stuck(records, { meta, today } = {}) {
  const out = { overdue: 0, unanswered: 0, quiet: 0, noreply: 0, unowned: 0 };
  const o = { meta, today };
  for (const r of Array.isArray(records) ? records : []) {
    if (!r) continue;
    for (const k of STUCK) if (FLAGS[k].test(r, o)) out[k]++;
  }
  return out;
}

// ---------- Team table ----------

/** The clients a person manages (meta.clients[].managers), display names in meta order. */
export function managedClients(name, { meta } = {}) {
  const k = keyOf(name);
  if (!k) return [];
  return ((meta && meta.clients) || []).filter((c) => (c.managers || []).some((m) => keyOf(m) === k))
    .map((c) => ({ name: c.name || String(c.k), slug: c.slug || String(c.k).replace(/\s+/g, "-") }));
}

// The Team table columns that count sites (each opens a list, target()).
export const COUNTS = ["owns", "prospects", "emailed", "negotiating", "active", "replies", "overdue", "quiet"];

/**
 * The Team table (B.7), one row per person:
 * [{name, key, past, none, owns, prospects, emailed, negotiating, active, replies, overdue, quiet,
 *   clients: [{name, slug}], changes, lastAt}]
 * activity = GET /api/team-activity ({by: {Name: {total, last_at}}}); null when it isn't available, and then
 * changes and lastAt are null. Order: the active team by sites owned (most first, ties by name), then past
 * owners who still own sites, then "No owner".
 */
export function teamRows(records, activity, { meta, today } = {}) {
  const team = teamIndex(meta);
  const people = new Map();
  const blank = (name, past, none) => ({ name, key: none ? "" : keyOf(name), past, none, owns: 0, prospects: 0, emailed: 0,
    negotiating: 0, active: 0, replies: 0, overdue: 0, quiet: 0, clients: none ? [] : managedClients(name, { meta }),
    changes: null, lastAt: null });
  for (const [k, name] of team) people.set(k, blank(name, false, false));
  const o = { meta, today };
  for (const r of Array.isArray(records) ? records : []) {
    if (!r) continue;
    const k = keyOf(r.owner);
    let p = people.get(k);
    if (!p) {
      p = k ? blank(String(r.owner).trim(), true, false) : blank(NO_OWNER, false, true);
      people.set(k, p);
    }
    p.owns++;
    if (r.notContacted) p.prospects++;
    if (r.stage === "Contacted") p.emailed++;
    else if (r.stage === "Negotiating") p.negotiating++;
    else if (r.stage === "Active") p.active++;
    if (isReplyWaiting(r)) p.replies++;
    if (isOverdue(r, o)) p.overdue++;
    if (isQuiet(r, o)) p.quiet++;
  }
  const by = activity && activity.by && typeof activity.by === "object" ? activity.by : null;
  if (by) {
    for (const p of people.values()) if (!p.none) p.changes = 0;
    for (const [name, a] of Object.entries(by)) {
      const p = people.get(keyOf(name));
      if (!p || p.none || !a) continue;
      p.changes += Number(a.total) || 0;
      if (a.last_at && (!p.lastAt || String(a.last_at) > p.lastAt)) p.lastAt = String(a.last_at);
    }
  }
  const rank = (p) => (p.none ? 2 : p.past ? 1 : 0);
  return Array.from(people.values()).sort((a, b) => rank(a) - rank(b) || b.owns - a.owns || a.name.localeCompare(b.name));
}

// ---------- Data clean-up (B.4 clean-up counts) ----------

export const CLEANUP = ["replied_nodate", "replied_old", "no_owner", "odd_clients", "no_type"];

/**
 * {replied_nodate, replied_old, no_owner, odd_clients, no_type, tokens: [{raw, name, n}]}: the clean-up counts
 * (the same numbers as rules/sites.js#cleanupCounts) and the odd client tokens, most frequent first
 * (name: the canonical name, '' for a token that isn't a known client).
 */
export function cleanup(records, { meta, today } = {}) {
  const out = { replied_nodate: 0, replied_old: 0, no_owner: 0, odd_clients: 0, no_type: 0, tokens: [] };
  const tokens = new Map();
  const o = { meta, today };
  for (const r of Array.isArray(records) ? records : []) {
    if (!r) continue;
    for (const k of CLEANUP) if (FLAGS[k].test(r, o)) out[k]++;
    for (const p of r.clientParts || splitClients(meta, r.clients)) {
      const name = p.known ? clientLabel(meta, p) : "";
      if (p.known && p.raw === name) continue;
      const t = tokens.get(p.raw) || { raw: p.raw, name, n: 0 };
      t.n++;
      tokens.set(p.raw, t);
    }
  }
  out.tokens = Array.from(tokens.values()).sort((a, b) => b.n - a.n || a.raw.localeCompare(b.raw));
  return out;
}

// ---------- Charts ----------

const DR_BANDS = ["80+", "60-79", "40-59", "20-39", "0-19"];
const NOT_EMAILED = ["", "New", "Researching"];
const WROTE_BACK = ["Replied", "Negotiating", "Active", "Lost"];
const MAIN_STAGES = ["New", "Researching", "Contacted", "Replied", "Negotiating", "Active", "Lost"];

function top(map, n) {
  return Array.from(map.entries()).sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0]))).slice(0, n);
}

/**
 * The six charts (spec 2.2.5): {pipeline, clients, types, countries, dr, replyRate}, each a list of
 * {label, value, params?, tone?}. params: the Sites view with the same sites (none for the reply rate).
 * Pipeline lists the seven stages (Do not contact only when a site has it). Reply rate by owner = sites that
 * wrote back (Replied, Negotiating, Active, Lost) out of the sites emailed (every stage but New and
 * Researching), as a whole percent, for owners with 10 or more emailed (as on the old Reports page).
 */
export function charts(records, { meta } = {}) {
  const list = (Array.isArray(records) ? records : []).filter(Boolean);
  const stageList = ((meta && meta.stages) || []).map((s) => s.name);
  const byStage = new Map(stageList.map((s) => [s, 0]));
  const byClient = new Map();
  const types = new Map();
  const countries = new Map();
  const dr = new Map(DR_BANDS.map((b) => [b, 0]));
  const owners = new Map();
  for (const r of list) {
    if (has(r.stage)) byStage.set(r.stage, (byStage.get(r.stage) || 0) + 1);
    for (const k of r.ck || []) byClient.set(k, (byClient.get(k) || 0) + 1);
    if (has(r.type) && !UNCATEGORIZED.test(String(r.type))) types.set(String(r.type), (types.get(String(r.type)) || 0) + 1);
    if (has(r.country)) countries.set(String(r.country), (countries.get(String(r.country)) || 0) + 1);
    if (r.drb && dr.has(r.drb)) dr.set(r.drb, dr.get(r.drb) + 1);
    if (has(r.owner) && !NOT_EMAILED.includes(r.stage || "")) {
      const k = keyOf(r.owner);
      const o = owners.get(k) || { name: String(r.owner).trim(), emailed: 0, replied: 0 };
      o.emailed++;
      if (WROTE_BACK.includes(r.stage)) o.replied++;
      owners.set(k, o);
    }
  }
  const team = teamIndex(meta);
  const color = (name) => {
    const s = ((meta && meta.stages) || []).find((x) => x.name === name);
    return s && s.color ? s.color : "";
  };
  const clients = [...((meta && meta.clients) || []), ...((meta && meta.past_clients) || [])]
    .map((c) => ({ label: c.name || String(c.k), value: byClient.get(c.k) || 0, params: { tab: "all", client: c.slug || String(c.k).replace(/\s+/g, "-"), big: "1" } }))
    .filter((c) => c.value > 0)
    .sort((a, b) => b.value - a.value || a.label.localeCompare(b.label));
  return {
    pipeline: Array.from(byStage.entries()).filter(([s, n]) => n > 0 || MAIN_STAGES.includes(s))
      .map(([s, n]) => ({ label: s, value: n, tone: color(s), params: { tab: "all", stage: s, big: "1" } })),
    clients,
    types: top(types, 10).map(([t, n]) => ({ label: t, value: n, params: { tab: "all", type: t, big: "1" } })),
    countries: top(countries, 10).map(([c, n]) => ({ label: c, value: n, params: { tab: "all", country: c, big: "1" } })),
    dr: DR_BANDS.map((b) => ({ label: "DR " + b, value: dr.get(b), params: { tab: "all", drb: b, big: "1" } })),
    replyRate: Array.from(owners.values()).filter((o) => o.emailed >= 10)
      .map((o) => ({ label: team.get(keyOf(o.name)) || o.name, value: Math.round((o.replied / o.emailed) * 100), emailed: o.emailed, replied: o.replied }))
      .sort((a, b) => b.value - a.value || a.label.localeCompare(b.label)),
  };
}

// ---------- Morning copy card (suggestions and runs) ----------

export const SUGGESTION_KINDS = [
  { id: "candidate", label: "Suggested contacts" },
  { id: "email", label: "Suggested emails (test mode)" },
  { id: "slack_ask", label: "Ownership checks" },
];

/**
 * Open suggestions by kind and client: {total, sites, kinds: [{id, label, n}], clients: [{name, n}]}.
 * rows: GET /api/suggestions rows (a row without a status counts as open).
 */
export function suggestionSummary(rows, { meta } = {}) {
  const open = (Array.isArray(rows) ? rows : []).filter((s) => s && (!has(s.status) || s.status === "open"));
  const kinds = SUGGESTION_KINDS.map((k) => ({ id: k.id, label: k.label, n: open.filter((s) => s.kind === k.id).length }));
  const other = open.filter((s) => !SUGGESTION_KINDS.some((k) => k.id === s.kind)).length;
  if (other) kinds.push({ id: "other", label: "Other suggestions", n: other });
  const clients = new Map();
  for (const s of open) {
    const parts = splitClients(meta, s.client);
    const name = parts.length ? parts[0].name : "No client";
    clients.set(name, (clients.get(name) || 0) + 1);
  }
  return {
    total: open.length,
    sites: new Set(open.map((s) => String(s.account_id))).size,
    kinds: kinds.filter((k) => k.n > 0),
    clients: Array.from(clients.entries()).map(([name, n]) => ({ name, n })).sort((a, b) => b.n - a.n || a.name.localeCompare(b.name)),
  };
}

/** The latest run of each kind: {daily, discovery} (GET /api/runs rows; null when there is none). */
export function latestRuns(rows) {
  const out = { daily: null, discovery: null };
  for (const r of Array.isArray(rows) ? rows : []) {
    if (!r || !r.name || !(r.name in out)) continue;
    if (!out[r.name] || Number(r.n) > Number(out[r.name].n)) out[r.name] = r;
  }
  return out;
}
