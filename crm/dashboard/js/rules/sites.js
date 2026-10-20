// Sites rules (spec 2.2.2, Appendix B.4). Pure: every function takes {meta, today, me} explicitly and
// reads derived Records (js/core/model.js#derive). No side effects at import time. Owner F3.
//
// - Tabs: mine = not contacted (New, Researching) and owner = me; unowned = not contacted and no owner;
//   waiting = Contacted; all = every stage. Big sites (meta platforms, D7) are hidden unless big is on,
//   on every tab except waiting.
// - quiet=14 ("No reply in 14+ days") = B.1 rule 6 without the cap: Contacted, not snoozed, and quiet for
//   more than meta.sla.Contacted days or with no activity date at all. Oldest first, undated last.
// - Owner on the tabs: mine and unowned define the owner themselves; waiting defaults to "me" when the URL
//   has no owner (owner=all shows everyone); all has no default.
// - Presets (All only): activity = sort by last activity, newest first; replied_nodate = Replied with no
//   reply date; sugg = has an open suggestion (the page maps it to the sugg=1 filter).
// - cleanupCounts(): the numbers of the Data clean-up card (Team overview, F6).
import { daysBetween, toDay } from "../core/format.js";
import { splitClients, clientLabel } from "../core/meta.js";

const has = (v) => v != null && String(v).trim() !== "";
const same = (a, b) => String(a == null ? "" : a).trim().toLowerCase() === String(b == null ? "" : b).trim().toLowerCase();

export const TAB_IDS = ["mine", "unowned", "waiting", "all"];

// The tabs in display order. `empty` is the tab's own empty state (spec 4.10) when no filter is on.
export const TABS = [
  {
    id: "mine", label: "Mine to contact", desc: "New sites you own. Find a contact and send the first email.",
    empty: { title: "No new prospects for you.", body: "Monday's discovery adds new sites for your clients.", action: { label: "Show Unowned", act: "tab-unowned" } },
  },
  {
    id: "unowned", label: "Unowned", desc: "New sites nobody owns yet. Claim one to work on it.",
    empty: { title: "Every new site has an owner.", body: "Monday's discovery adds new sites." },
  },
  {
    id: "waiting", label: "Waiting for reply", desc: "Emailed and waiting for an answer.",
    empty: { title: "No sites are waiting for a reply.", body: "Sites move here when you log “Sent first email”." },
  },
  {
    id: "all", label: "All", desc: "Every site in the CRM, in every stage.",
    empty: { title: "No sites yet.", body: "Add one with “+ Add site”." },
  },
];

// #sites with no tab shows All (spec 2.4: that was the old All sites URL).
export function tabOf(id) {
  return TAB_IDS.includes(id) ? id : "all";
}

export function tabInfo(id) {
  return TABS.find((t) => t.id === tabOf(id));
}

// Big sites are hidden on every tab except Waiting for reply (B.4).
export function hidesBig(tab) {
  return tabOf(tab) !== "waiting";
}

// The owner filter a tab applies: null (anyone), "me", "none" or a name.
export function ownerFilter(tab, owner) {
  const t = tabOf(tab);
  if (t === "mine" || t === "unowned") return null;
  const o = owner == null ? "" : String(owner).trim();
  if (o === "all" || o === "any") return null;
  if (!o) return t === "waiting" ? "me" : null;
  return o;
}

function ownerMatches(r, filter, me) {
  if (!filter) return true;
  if (filter === "me") return has(me) && same(r.owner, me);
  if (filter === "none") return !has(r.owner);
  return same(r.owner, filter);
}

// Is the record in this tab (before the big-sites rule and the filters)?
export function inTab(r, tab, { me } = {}) {
  if (!r) return false;
  switch (tabOf(tab)) {
    case "mine": return !!r.notContacted && has(me) && same(r.owner, me);
    case "unowned": return !!r.notContacted && !has(r.owner);
    case "waiting": return r.stage === "Contacted";
    default: return true;
  }
}

// {mine, unowned, waiting, all}: the records of each tab (B.4). Big sites are left out of mine, unowned
// and all unless `big` is true.
export function tabs(records, { meta, me, big = false } = {}) {
  const out = { mine: [], unowned: [], waiting: [], all: [] };
  for (const r of records || []) {
    if (!r) continue;
    if (r.stage === "Contacted") out.waiting.push(r);
    if (!big && r.isPlatform) continue;
    out.all.push(r);
    if (r.notContacted) {
      if (!has(r.owner)) out.unowned.push(r);
      else if (has(me) && same(r.owner, me)) out.mine.push(r);
    }
  }
  return out;
}

function dueOf(r) {
  return r.due || toDay(r.next_due) || null;
}

// B.1 rule 6 without the cap (quiet=14).
export function isNoReply(r, { meta, today } = {}) {
  if (!r || r.stage !== "Contacted") return false;
  const due = dueOf(r);
  if (due && today && due > today) return false; // snoozed
  if (!r.lastActivity) return true;
  const sla = meta && meta.sla && meta.sla.Contacted != null ? Number(meta.sla.Contacted) : 14;
  const quiet = today ? daysBetween(r.lastActivity, today) : r.quietDays;
  return quiet != null && quiet > sla;
}

// The "No reply in 14+ days" sites, oldest activity first, undated last (no cap).
export function noReply(records, { meta, today } = {}) {
  const list = (records || []).filter((r) => isNoReply(r, { meta, today }));
  const keyed = list.map((r, i) => ({ r, i, k: r.lastActivity || null }));
  keyed.sort((a, b) => {
    if (!a.k || !b.k) return a.k === b.k ? a.i - b.i : a.k ? -1 : 1;
    return a.k < b.k ? -1 : a.k > b.k ? 1 : a.i - b.i;
  });
  return keyed.map((x) => x.r);
}

// Quick presets on All (B.4). `test` filters; `sort`/`dir` sort.
export const presets = {
  activity: { id: "activity", label: "Recently active", sort: "last_activity", dir: "desc" },
  replied_nodate: { id: "replied_nodate", label: "Replied, no date", test: (r) => !!r && r.stage === "Replied" && !r.replyDate },
  sugg: { id: "sugg", label: "Has a suggestion", test: (r) => !!r && Number(r.sugg) > 0 },
};

export const PRESET_IDS = ["activity", "replied_nodate", "sugg"];

// The sort a list shows: the URL's, else the preset's or quiet's, else newest first (spec 2.2.2).
// Keys are column ids of js/ui/columns.js or its SORTS ("newest", "last_activity").
const DESC_FIRST = ["newest", "dr", "traffic", "last_activity", "contacts"];
export function defaultDir(key) {
  return DESC_FIRST.includes(key) ? "desc" : "asc";
}

export function sortFor({ sort, dir, quiet, preset } = {}) {
  if (has(sort)) return { key: String(sort), dir: dir === "asc" || dir === "desc" ? dir : defaultDir(String(sort)) };
  return baseSort({ quiet, preset });
}

// The sort the page falls back to without a sort param.
export function baseSort({ quiet, preset } = {}) {
  if (preset === "activity") return { key: "last_activity", dir: "desc" };
  if (has(quiet)) return { key: "last_activity", dir: "asc" };
  return { key: "newest", dir: "desc" };
}

// Short names for every sort a Sites list can show (the Sort menu, or a column header's sort): each one says
// what comes first, and fits the Sort menu on a phone.
const SORT_WORDS = {
  newest: ["Oldest first", "Newest first"],
  site: ["Name (A–Z)", "Name (Z–A)"],
  stage: ["Stage (New first)", "Stage (Lost first)"],
  owner: ["Owner (A–Z)", "Owner (Z–A)"],
  clients: ["Client (A–Z)", "Client (Z–A)"],
  dr: ["Lowest DR first", "Highest DR first"],
  traffic: ["Least traffic first", "Most traffic first"],
  last_activity: ["Quietest first", "Recently active first"],
  next: ["Next follow-up first", "Latest follow-up first"],
};

export function sortLabel(key, dir) {
  const w = SORT_WORDS[key];
  if (w) return w[dir === "desc" ? 1 : 0];
  return String(key || "").replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase()) + (dir === "desc" ? " (Z–A)" : " (A–Z)");
}

// The sort choices of the page's Sort menu (spec 2.2.2: newest first, then Name, DR, Traffic, Last activity
// and Follow-up date). "Quietest first" (longest without activity) is the order of "No reply in 14+ days".
export const SORT_CHOICES = [
  ["newest", "desc"], ["site", "asc"], ["dr", "desc"], ["traffic", "desc"], ["last_activity", "desc"],
  ["last_activity", "asc"], ["next", "asc"],
].map(([key, dir]) => ({ key, dir, label: sortLabel(key, dir) }));

/**
 * One pass over records that already passed the shared filters (search, client, type, country, DR, source,
 * has contact, has suggestion). Applies the tab, the big-sites rule, the tab's owner filter, the stage
 * filter (All only), the preset (All only) and quiet (Waiting only).
 * Returns {rows, counts: {mine, unowned, waiting, all}, quiet}: the rows of `tab`, what each tab would
 * show with these filters, and the "No reply in 14+ days" count of Waiting for reply (quiet on or off).
 */
export function siteView(records, { meta, me, today, tab, owner, stage, big = false, quiet = false, preset } = {}) {
  const t = tabOf(tab);
  const counts = { mine: 0, unowned: 0, waiting: 0, all: 0 };
  const rows = [];
  let quietCount = 0;
  const ownWaiting = ownerFilter("waiting", owner);
  const ownAll = ownerFilter("all", owner);
  const pre = has(preset) && presets[preset] && presets[preset].test ? presets[preset].test : null;
  const wantQuiet = !!quiet && quiet !== "0";
  for (const r of records || []) {
    if (!r) continue;
    const hidden = !big && r.isPlatform;
    if (r.notContacted && !hidden) {
      if (!has(r.owner)) {
        counts.unowned++;
        if (t === "unowned") rows.push(r);
      } else if (has(me) && same(r.owner, me)) {
        counts.mine++;
        if (t === "mine") rows.push(r);
      }
    }
    if (r.stage === "Contacted" && ownerMatches(r, ownWaiting, me)) {
      const q = isNoReply(r, { meta, today });
      if (q) quietCount++;
      if (!wantQuiet || q) {
        counts.waiting++;
        if (t === "waiting") rows.push(r);
      }
    }
    if (!hidden && ownerMatches(r, ownAll, me) && (!has(stage) || same(r.stage, stage)) && (!pre || pre(r))) {
      counts.all++;
      if (t === "all") rows.push(r);
    }
  }
  return { rows, counts, quiet: quietCount };
}

// ---------- Clean-up counts (B.4; shown on Team overview) ----------

const isUncategorized = (v) => /^\s*uncategori[sz]ed\s*$/i.test(String(v == null ? "" : v));

// A stored client token that isn't written the canonical way ("Ultahost" for UltaHost), or isn't a known
// client at all. Returns the canonical name ('' for an unknown token), or null when the token is fine.
function oddToken(meta, part) {
  if (!part) return null;
  if (!part.known) return "";
  const label = clientLabel(meta, part);
  return part.raw === label ? null : label;
}

/**
 * {repliedNoDate, repliedOldTouch, noOwner, oddClients, noType, clientTokens}:
 * - repliedNoDate: Replied with no reply date (no last touch, no replied contact email)
 * - repliedOldTouch: Replied with a last touch more than 30 days before today
 * - noOwner: no owner and not closed (Lost, Do not contact)
 * - oddClients: sites with a client token that isn't canonical or isn't a known client
 * - noType: type empty or "Uncategorized" (shown as "Type not set")
 * - clientTokens: [{raw, name, n}] those tokens, most frequent first (name '' = not a known client)
 */
export function cleanupCounts(records, { meta, today } = {}) {
  const out = { repliedNoDate: 0, repliedOldTouch: 0, noOwner: 0, oddClients: 0, noType: 0, clientTokens: [] };
  const tokens = new Map();
  for (const r of records || []) {
    if (!r) continue;
    if (r.stage === "Replied") {
      if (!r.replyDate) out.repliedNoDate++;
      const touch = toDay(r.last_touch);
      const age = touch && today ? daysBetween(touch, today) : null;
      if (age != null && age > 30) out.repliedOldTouch++;
    }
    const closed = r.closed != null ? !!r.closed : r.stage === "Lost" || r.stage === "Do not contact";
    if (!has(r.owner) && !closed) out.noOwner++;
    if (!has(r.type) || isUncategorized(r.type)) out.noType++;
    const parts = r.clientParts || splitClients(meta, r.clients);
    let odd = false;
    for (const p of parts) {
      const name = oddToken(meta, p);
      if (name == null) continue;
      odd = true;
      const t = tokens.get(p.raw) || { raw: p.raw, name, n: 0 };
      t.n++;
      tokens.set(p.raw, t);
    }
    if (odd) out.oddClients++;
  }
  out.clientTokens = Array.from(tokens.values()).sort((a, b) => b.n - a.n || a.raw.localeCompare(b.raw));
  return out;
}
