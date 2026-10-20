// Unit tests for js/rules/team.js (spec 2.2.5, Appendix B.7). Owner F6.
// The records are the synthetic fixture (tests/fixtures/make-seed.mjs) turned into v2 rows the way
// lib/crm.js#v2Sql builds them (contacts and activity joined), then model.derive. The expected numbers are
// worked out here from the raw fixture rows with plain JS (B.1 / B.7 by hand), not with the rules modules,
// so the test is not circular. Every number's target() is then checked against what that list shows:
// rules/sites.js#siteView for a Sites link (the same function the Sites page counts with), flagged() for
// the Team overview's own list.
import { test } from "node:test";
import assert from "node:assert/strict";
import { derive } from "../../crm/dashboard/js/core/model.js";
import * as team from "../../crm/dashboard/js/rules/team.js";
import { siteView, cleanupCounts, noReply } from "../../crm/dashboard/js/rules/sites.js";
import { buildFixture, fixtureMeta, TEAM, PAST_OWNER } from "../fixtures/make-seed.mjs";

const TODAY = "2026-10-20"; // a Tuesday
const meta = fixtureMeta();

function v2Rows(fx) {
  const by = (list, key) => {
    const m = new Map();
    for (const x of list) (m.get(x[key]) || m.set(x[key], []).get(x[key])).push(x);
    return m;
  };
  const contacts = by(fx.contacts, "account_id");
  const acts = by(fx.activity, "account_id");
  const sugg = by(fx.suggestions.filter((s) => s.status === "open" && ["candidate", "email"].includes(s.kind)), "account_id");
  const max = (list, k) => list.reduce((m, x) => (x[k] != null && (m == null || x[k] > m) ? x[k] : m), null);
  return fx.partners.map((p) => {
    const cs = contacts.get(p.id) || [];
    return Object.assign({}, p, {
      label: p.name || p.domain || "Unnamed creator",
      last_email: max(cs, "last_email"),
      replied_contact: cs.length ? Math.max(...cs.map((c) => Number(c.replied) || 0)) : null,
      act_at: max(acts.get(p.id) || [], "date"),
      sugg: (sugg.get(p.id) || []).length || null,
    });
  });
}

const fx = buildFixture({ today: TODAY });
const raw = v2Rows(fx);
const recs = raw.map((r) => derive(r, { meta, today: TODAY }));
const O = { meta, today: TODAY };
const sorted = (list) => list.slice().sort((a, b) => a.localeCompare(b, "en", { numeric: true }));
const idsOf = (list) => sorted(list.map((r) => r.id));

// ---------- B.1 / B.7 by hand, on the raw rows ----------

const has = (v) => v != null && String(v).trim() !== "";
const day = (v) => (has(v) ? String(v).slice(0, 10) : null);
const daysAgo = (iso) => Math.round((Date.parse(TODAY + "T00:00:00Z") - Date.parse(iso + "T00:00:00Z")) / 86400000);
const own = (r) => (has(r.owner) ? String(r.owner).trim().toLowerCase() : "");
const closed = (r) => r.stage === "Lost" || r.stage === "Do not contact";
const snoozed = (r) => !!day(r.next_due) && day(r.next_due) > TODAY;
const waiting = (r) => /^\s*waiting on client:/i.test(r.next_step || "");
function lastAct(r) {
  const days = [r.last_touch, r.last_email, r.act_at, r.updated_at].map(day).filter(Boolean);
  return days.length ? days.sort().pop() : null;
}
function reply(r) {
  if (Number(r.replied_contact) > 0 && day(r.last_email)) return { date: day(r.last_email), win: 30 };
  if (day(r.last_touch)) return { date: day(r.last_touch), win: 7 };
  return null;
}
function handled(r) {
  const rp = reply(r);
  if (!rp) return false;
  return (!!day(r.act_at) && day(r.act_at) >= rp.date) || (has(r.updated_by) && !!day(r.updated_at) && day(r.updated_at) >= rp.date);
}
const fresh = (r) => { const rp = reply(r); return !!rp && daysAgo(rp.date) <= rp.win; };
const H = {
  overdue: (r) => !closed(r) && !!day(r.next_due) && day(r.next_due) < TODAY,
  replies: (r) => r.stage === "Replied" && fresh(r) && !handled(r) && !snoozed(r),
  unanswered: (r) => r.stage === "Replied" && fresh(r) && !handled(r) && daysAgo(reply(r).date) >= 3,
  quiet: (r) => {
    const la = lastAct(r);
    if (!la || snoozed(r)) return false;
    if (r.stage === "Negotiating") return daysAgo(la) > 7;
    if (r.stage === "Active" && !has(r.content_url)) return daysAgo(la) > 14;
    return false;
  },
  noreply: (r) => r.stage === "Contacted" && !snoozed(r) && (!lastAct(r) || daysAgo(lastAct(r)) > 14),
  unowned: (r, rec) => ["New", "Researching"].includes(r.stage) && !has(r.owner) && !rec.isPlatform,
  decision: (r) => r.stage === "Negotiating" && !waiting(r) && !snoozed(r),
};
const pairs = raw.map((r, i) => [r, recs[i]]);
const count = (fn, owner) => pairs.filter(([r, rec]) => (owner === undefined || own(r) === owner) && fn(r, rec)).length;

// ---------- the Team table ----------

test("teamRows: one row per team member (Denisse and Egle too), then the past owner, then No owner", () => {
  const rows = team.teamRows(recs, null, O);
  const names = rows.map((p) => p.name);
  for (const n of TEAM) assert.ok(names.includes(n), n + " has a row");
  assert.ok(names.includes(PAST_OWNER), "the past owner has a row");
  assert.equal(names[names.length - 1], "No owner");
  assert.equal(names[names.length - 2], PAST_OWNER, "past owners after the team");
  assert.equal(rows.find((p) => p.name === PAST_OWNER).past, true);
  assert.equal(rows.find((p) => p.name === "Denisse").past, false);
  const active = rows.filter((p) => !p.past && !p.none);
  for (let i = 1; i < active.length; i++) {
    const a = active[i - 1], b = active[i];
    assert.ok(a.owns > b.owns || (a.owns === b.owns && a.name.localeCompare(b.name) <= 0), "most sites first: " + a.name + ", " + b.name);
  }
  assert.equal(rows.length, TEAM.length + 2);
});

test("teamRows: every count is B.7 worked out by hand from the raw rows", () => {
  const rows = team.teamRows(recs, null, O);
  for (const p of rows) {
    const k = p.none ? "" : p.name.toLowerCase();
    const exp = {
      owns: count(() => true, k),
      prospects: count((r) => ["New", "Researching"].includes(r.stage), k),
      emailed: count((r) => r.stage === "Contacted", k),
      negotiating: count((r) => r.stage === "Negotiating", k),
      active: count((r) => r.stage === "Active", k),
      replies: count(H.replies, k),
      overdue: count(H.overdue, k),
      quiet: count(H.quiet, k),
    };
    const got = {};
    for (const c of team.COUNTS) got[c] = p[c];
    assert.deepEqual(got, exp, p.name);
  }
  const total = rows.reduce((s, p) => s + p.owns, 0);
  assert.equal(total, raw.length, "every site is in exactly one row");
  // The fixture's shape, so these checks keep meaning something.
  const kamile = rows.find((p) => p.name === "Kamile");
  assert.ok(kamile.replies > 0 && kamile.overdue > 0 && kamile.quiet > 0 && kamile.prospects > 0);
  assert.ok(rows.find((p) => p.name === "Gaby").prospects > 0);
});

test("teamRows: clients managed come from meta.clients[].managers", () => {
  const rows = team.teamRows(recs, null, O);
  const names = (n) => rows.find((p) => p.name === n).clients.map((c) => c.name);
  assert.deepEqual(names("Kamile"), ["UltaHost", "MailerLite", "MailerSend", "Headway", "GuardBlinds"]);
  assert.deepEqual(names("Jonas"), ["Soro", "TransferGO"]);
  assert.deepEqual(names("Eivyda"), ["Desktronic", "Botanical Synthesis", "Melograno"]);
  assert.deepEqual(names("Sandra"), []);
  assert.deepEqual(names("No owner"), []);
  assert.deepEqual(rows.find((p) => p.name === "Jonas").clients[0], { name: "Soro", slug: "soro" });
  assert.deepEqual(team.managedClients("kamile ", { meta }).length, 5, "names compare trimmed, ignoring case");
});

test("teamRows: changes this week and last active from /api/team-activity; null when it isn't there", () => {
  const activity = {
    since: "2026-10-13T13:00:00Z", days: 7,
    by: {
      Kamile: { total: 5, last_at: "2026-10-20T07:31:00Z" },
      kamile: { total: 2, last_at: "2026-10-19T09:00:00Z" },
      Someone: { total: 3, last_at: "2026-10-20T10:00:00Z" },
      Jay: { total: 0, last_at: "2026-09-01T08:00:00Z" },
      Stranger: { total: 9, last_at: "2026-10-20T11:00:00Z" },
    },
  };
  const rows = team.teamRows(recs, activity, O);
  const p = (n) => rows.find((x) => x.name === n);
  assert.equal(p("Kamile").changes, 7, "the same name in another case adds up");
  assert.equal(p("Kamile").lastAt, "2026-10-20T07:31:00Z");
  assert.equal(p("Jonas").changes, 0, "no edits: 0");
  assert.equal(p("Jonas").lastAt, null);
  assert.equal(p(PAST_OWNER).lastAt, "2026-09-01T08:00:00Z");
  assert.equal(p("No owner").changes, null, "No owner has no changes");
  assert.ok(!rows.some((x) => x.name === "Stranger" || x.name === "Someone"), "names without sites or a team place get no row");
  const none = team.teamRows(recs, null, O);
  assert.ok(none.every((x) => x.changes === null && x.lastAt === null));
});

// ---------- Stuck ----------

test("stuck: the five counts are B.7 by hand, and match Sites where Sites shows them", () => {
  const s = team.stuck(recs, O);
  assert.deepEqual(s, {
    overdue: count(H.overdue),
    unanswered: count(H.unanswered),
    quiet: count(H.quiet),
    noreply: count(H.noreply),
    unowned: count(H.unowned),
  });
  for (const k of team.STUCK) assert.ok(s[k] > 0, k + " has sites in the fixture");
  assert.equal(s.noreply, noReply(recs, O).length, "No reply in 14+ days = rules/sites.js noReply");
  assert.equal(s.unowned, siteView(recs, { meta, today: TODAY, tab: "unowned" }).counts.unowned);
});

// ---------- every number opens a list with the same count ----------

// What the target shows: Sites through siteView (as pages/sites.js passes the URL), or this page's list.
function shows(t, me = "Kamile") {
  if (t.page === "team") {
    return team.flagged(recs, t.params.show, { meta, today: TODAY, owner: t.params.owner || null }).length;
  }
  assert.equal(t.page, "sites");
  const p = t.params;
  for (const k of Object.keys(p)) assert.ok(["tab", "owner", "stage", "big", "quiet", "preset", "flag"].includes(k), "a param Sites reads: " + k);
  assert.ok(!p.flag || team.SITES_FLAGS.includes(p.flag), "flag= only for the flags Sites filters");
  const v = siteView(recs, { meta, me, today: TODAY, tab: p.tab, owner: p.owner, stage: p.stage, big: p.big === "1", quiet: p.quiet === "14", preset: p.preset });
  return v.rows.length;
}

test("target: every Team table number opens a list with the same count", () => {
  const rows = team.teamRows(recs, null, O);
  let checked = 0, sites = 0;
  for (const p of rows) {
    for (const c of team.COUNTS) {
      if (!p[c]) continue;
      const t = team.target(c, { owner: p.none ? "none" : p.name });
      assert.equal(shows(t), p[c], p.name + " " + c + " → " + JSON.stringify(t));
      // The person signed in doesn't change a list that names its owner.
      assert.equal(shows(t, "Jonas"), p[c], p.name + " " + c + " as Jonas");
      checked++;
      if (t.page === "sites") sites++;
    }
  }
  assert.ok(checked > 40 && sites > 20, "the fixture has many nonzero numbers (" + checked + ", " + sites + " on Sites)");
});

test("target: every Stuck tile and clean-up count opens a list with the same count", () => {
  const s = team.stuck(recs, O);
  for (const k of team.STUCK) assert.equal(shows(team.target(k)), s[k], k);
  assert.deepEqual(team.target("noreply"), { page: "sites", params: { tab: "waiting", quiet: "14", owner: "all" } });
  assert.deepEqual(team.target("unowned"), { page: "sites", params: { tab: "unowned" } });
  const c = team.cleanup(recs, O);
  for (const k of team.CLEANUP) if (c[k]) assert.equal(shows(team.target(k)), c[k], k);
  assert.deepEqual(team.target("replied_nodate"), { page: "sites", params: { tab: "all", preset: "replied_nodate", big: "1" } });
});

test("target: Sites links where Sites shows exactly those sites, else the Team overview's own list", () => {
  assert.deepEqual(team.target("owns", { owner: "Gaby" }), { page: "sites", params: { tab: "all", owner: "Gaby", big: "1" } });
  assert.deepEqual(team.target("owns", { owner: "none" }), { page: "sites", params: { tab: "all", owner: "none", big: "1" } });
  assert.deepEqual(team.target("emailed", { owner: "Gaby" }), { page: "sites", params: { tab: "waiting", owner: "Gaby" } });
  assert.deepEqual(team.target("negotiating", { owner: "Vik" }), { page: "sites", params: { tab: "all", owner: "Vik", stage: "Negotiating", big: "1" } });
  assert.deepEqual(team.target("active", { owner: "Vik" }), { page: "sites", params: { tab: "all", owner: "Vik", stage: "Active", big: "1" } });
  assert.deepEqual(team.target("prospects", { owner: "Gaby" }), { page: "team", params: { show: "prospects", owner: "Gaby" } });
  assert.deepEqual(team.target("overdue"), { page: "team", params: { show: "overdue" } });
  assert.deepEqual(team.target("noreply", { owner: "Kamile" }), { page: "team", params: { show: "noreply", owner: "Kamile" } });
  // Gaby and Tomas have Researching prospects, which Sites can't show beside New for someone else: so the
  // Team overview's list, and not Sites › Mine (which is only ever the signed-in person's).
  const res = recs.filter((r) => r.stage === "Researching" && has(r.owner)).map((r) => r.owner);
  assert.ok(res.length > 0, "the fixture has owned Researching sites");
});

// ---------- the lists ----------

test("flagged: owner name, none or everyone; each list in its order", () => {
  const gaby = team.flagged(recs, "prospects", { meta, today: TODAY, owner: "gaby" });
  assert.equal(gaby.length, count((r) => ["New", "Researching"].includes(r.stage), "gaby"));
  assert.ok(gaby.some((r) => r.stage === "Researching"));
  const none = team.flagged(recs, "prospects", { meta, today: TODAY, owner: "none" });
  assert.equal(none.length, count((r) => ["New", "Researching"].includes(r.stage), ""));
  const overdue = team.flagged(recs, "overdue", O);
  assert.equal(overdue.length, count(H.overdue));
  for (let i = 1; i < overdue.length; i++) assert.ok(overdue[i - 1].due <= overdue[i].due, "oldest follow-up first");
  const quiet = team.flagged(recs, "quiet", O);
  for (let i = 1; i < quiet.length; i++) assert.ok(quiet[i - 1].quietDays >= quiet[i].quietDays, "quietest first");
  assert.deepEqual(team.flagged(recs, "nope", O), []);
  assert.deepEqual(team.flagged(null, "owns", O), []);
  for (const f of team.FLAG_IDS) {
    assert.ok(team.FLAGS[f].label && team.FLAGS[f].desc, f + " has a heading and a line");
    assert.ok(!/record|outcome|daily run|sync|uncategorized|snooze/i.test(team.FLAGS[f].label + " " + team.FLAGS[f].desc), f + ": vocabulary (2.5)");
  }
});

// ---------- Needs a decision ----------

test("needsDecision: B.1 rule 3 for every owner, grouped by owner, biggest group first", () => {
  const groups = team.needsDecision(recs, O);
  const expIds = idsOf(pairs.filter(([r]) => H.decision(r)).map(([, rec]) => rec));
  assert.deepEqual(idsOf(groups.flatMap((g) => g.records)), expIds);
  const want = ["J-neg-1", "J-neg-2", "J-neg-3", "J-neg-marker", "K-neg-decision", "vik-neg", "E-neg-1"].map((t) => fx.groups[t][0]);
  assert.deepEqual(expIds, sorted(want), "the fixture's decision rows");
  assert.deepEqual(groups.map((g) => g.owner), ["Jonas", "Eivyda", "Kamile", "Vik"]);
  assert.deepEqual(groups[0].records.map((r) => r.id), ["J-neg-marker", "J-neg-3", "J-neg-2", "J-neg-1"].map((t) => fx.groups[t][0]),
    "longest quiet first");
  for (const t of ["K-neg-waiting", "J-neg-wait-1", "E-neg-wait", "K-neg-snoozed"]) {
    assert.ok(!expIds.includes(fx.groups[t][0]), t + " is left out (waiting on the client, or snoozed)");
  }
  // Unowned and lower-case owners.
  const extra = [
    derive(Object.assign({}, raw[0], { id: "PG-09001", owner: null, stage: "Negotiating", next_step: null, next_due: null }), O),
    derive(Object.assign({}, raw[0], { id: "PG-09002", owner: "vik ", stage: "Negotiating", next_step: null, next_due: null }), O),
  ];
  const g2 = team.needsDecision(recs.concat(extra), O);
  assert.equal(g2[g2.length - 1].owner, "No owner");
  assert.equal(g2[g2.length - 1].none, true);
  assert.equal(g2.find((g) => g.owner === "Vik").records.length, 2, "owners compare trimmed, ignoring case; the team's spelling shows");
});

function rec(over = {}) {
  return derive(Object.assign({ id: "PG-09100", domain: "edge.example.test", name: "Edge", owner: "Jonas", stage: "Negotiating",
    clients: "Soro", next_step: null, next_due: null, last_touch: null }, over), O);
}

test("decisionHint: the next step names the client, or says waiting or client", () => {
  const yes = [
    ["Waiting for Soro to sign", "Soro"],
    ["Soro to confirm the budget", "Soro"],
    ["Ping soro again", "Soro"],
    ["Ask the client about dates", "TransferGO"],
    ["Chase TransferGO legal", "TransferGO"],
    ["ultahost pricing", "UltaHost"],
    ["Trafft budget from Melograno", "Melograno - Trafft"],
    ["We are waiting", "Soro"],
  ];
  for (const [next, clients] of yes) assert.equal(team.decisionHint(rec({ next_step: next, clients }), { meta }), true, next);
  const no = [
    ["Agree terms", "Soro"],
    ["Write the sorority article", "Soro"],
    ["Send the contract", "TransferGO"],
    ["Clientele review", "Soro"],
    ["", "Soro"],
    [null, "Soro"],
  ];
  for (const [next, clients] of no) assert.equal(team.decisionHint(rec({ next_step: next, clients }), { meta }), false, String(next));
  assert.equal(team.decisionHint(rec({ next_step: "Waiting on client: Soro to sign" }), { meta }), false, "already ticked");
  assert.equal(team.decisionHint(null, { meta }), false);
});

test("isUnanswered and isReplyWaiting: snooze, handled and the 3-day line", () => {
  const base = { stage: "Replied", last_touch: "2026-10-17" }; // 3 days ago, by touch (7-day window)
  assert.equal(team.isUnanswered(rec(base), O), true);
  assert.equal(team.isUnanswered(rec({ ...base, last_touch: "2026-10-18" }), O), false, "2 days");
  assert.equal(team.isUnanswered(rec({ ...base, last_touch: "2026-10-12" }), O), false, "outside the 7-day window");
  assert.equal(team.isUnanswered(rec({ ...base, act_at: "2026-10-18" }), O), false, "handled");
  assert.equal(team.isUnanswered(rec({ ...base, next_due: "2026-10-25" }), O), true, "B.7 has no snooze test");
  assert.equal(team.isReplyWaiting(rec({ ...base, next_due: "2026-10-25" })), false, "B.1 rule 2 skips snoozed sites");
  assert.equal(team.isReplyWaiting(rec(base)), true);
  assert.equal(team.isOverdue(rec({ stage: "Lost", next_due: "2026-10-01" }), O), false, "closed");
  assert.equal(team.isOverdue(rec({ next_due: "2026-10-19" }), O), true);
  assert.equal(team.isOverdue(rec({ next_due: "2026-10-20" }), O), false, "due today isn't overdue");
});

// ---------- Data clean-up ----------

test("cleanup: the same numbers as rules/sites.js#cleanupCounts", () => {
  const c = team.cleanup(recs, O);
  const s = cleanupCounts(recs, O);
  assert.deepEqual(
    { replied_nodate: c.replied_nodate, replied_old: c.replied_old, no_owner: c.no_owner, odd_clients: c.odd_clients, no_type: c.no_type },
    { replied_nodate: s.repliedNoDate, replied_old: s.repliedOldTouch, no_owner: s.noOwner, odd_clients: s.oddClients, no_type: s.noType });
  assert.deepEqual(c.tokens, s.clientTokens);
  assert.ok(c.replied_nodate > 0 && c.no_owner > 0 && c.odd_clients > 0 && c.no_type > 0);
  assert.equal(c.tokens[0].raw, "Ultahost");
  assert.equal(c.tokens[0].name, "UltaHost");
  assert.equal(c.no_owner, count((r) => !has(r.owner) && !closed(r)));
  assert.equal(c.no_type, count((r) => !has(r.type) || /^\s*uncategori[sz]ed\s*$/i.test(r.type)));
  assert.ok(raw.some((r) => /^uncategorized$/i.test(r.type || "")), "the fixture has Uncategorized types");
});

// ---------- Charts ----------

test("charts: pipeline, clients, types, countries, DR bands and reply rate", () => {
  const c = team.charts(recs, { meta });
  assert.equal(c.pipeline.reduce((s, x) => s + x.value, 0), raw.length, "every site in one stage");
  assert.deepEqual(c.pipeline.slice(0, 7).map((x) => x.label), ["New", "Researching", "Contacted", "Replied", "Negotiating", "Active", "Lost"]);
  for (const x of c.pipeline) {
    assert.equal(x.value, count((r) => r.stage === x.label), x.label);
    assert.deepEqual(x.params, { tab: "all", stage: x.label, big: "1" });
    assert.equal(shows({ page: "sites", params: x.params }), x.value, "the bar opens the same sites: " + x.label);
  }
  assert.equal(c.pipeline.find((x) => x.label === "Negotiating").tone, "neg");
  const ulta = c.clients.find((x) => x.label === "UltaHost");
  assert.equal(ulta.value, recs.filter((r) => r.ck.includes("ultahost")).length);
  assert.deepEqual(ulta.params, { tab: "all", client: "ultahost", big: "1" });
  assert.ok(c.clients.some((x) => x.label === "Weglot"), "past clients count too");
  assert.ok(c.types.length <= 10 && c.countries.length <= 10);
  assert.ok(!c.types.some((x) => /uncategori/i.test(x.label)), "Type not set isn't a type");
  for (let i = 1; i < c.types.length; i++) assert.ok(c.types[i - 1].value >= c.types[i].value);
  assert.equal(c.dr.reduce((s, x) => s + x.value, 0), recs.filter((r) => r.drb).length);
  assert.deepEqual(c.dr.map((x) => x.label), ["DR 80+", "DR 60-79", "DR 40-59", "DR 20-39", "DR 0-19"]);
  // Reply rate by owner, by hand.
  const emailed = (o) => raw.filter((r) => own(r) === o && has(r.stage) && !["New", "Researching"].includes(r.stage));
  for (const x of c.replyRate) {
    const e = emailed(x.label.toLowerCase());
    const w = e.filter((r) => ["Replied", "Negotiating", "Active", "Lost"].includes(r.stage));
    assert.ok(e.length >= 10);
    assert.equal(x.emailed, e.length, x.label);
    assert.equal(x.value, Math.round((w.length / e.length) * 100), x.label);
    assert.equal(x.params, undefined, "no list behind a rate");
  }
  assert.ok(c.replyRate.some((x) => x.label === "Kamile"));
  assert.ok(!c.replyRate.some((x) => x.label === "Sandra"), "fewer than 10 emailed");
});

// ---------- Morning run card ----------

test("suggestionSummary and latestRuns on the fixture's suggestions and runs", () => {
  const sum = team.suggestionSummary(fx.suggestions, { meta });
  const open = fx.suggestions.filter((s) => s.status === "open");
  assert.equal(sum.total, open.length);
  assert.equal(sum.sites, new Set(open.map((s) => s.account_id)).size);
  assert.deepEqual(sum.kinds.map((k) => [k.id, k.n]), [
    ["candidate", open.filter((s) => s.kind === "candidate").length],
    ["email", open.filter((s) => s.kind === "email").length],
    ["slack_ask", open.filter((s) => s.kind === "slack_ask").length],
  ]);
  assert.equal(sum.clients[0].name, "UltaHost");
  assert.ok(sum.clients.some((c) => c.name === "No client"));
  assert.equal(sum.clients.reduce((s, c) => s + c.n, 0), open.length);
  assert.deepEqual(team.suggestionSummary(null, { meta }), { total: 0, sites: 0, kinds: [], clients: [] });
  const last = team.latestRuns(fx.runs);
  assert.equal(last.daily.n, 3);
  assert.equal(last.discovery.n, 1);
  assert.deepEqual(team.latestRuns(null), { daily: null, discovery: null });
});
