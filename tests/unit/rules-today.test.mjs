// Unit tests for js/rules/today.js (spec 2.2.1, Appendix B.1-B.3). Owner F2.
// The records are the synthetic fixture (tests/fixtures/make-seed.mjs) turned into v2 rows the way
// lib/crm.js#v2Sql builds them (contacts, activity and open suggestions joined), then model.derive.
// Expected lists come from fx.intended, so the numbers are never written down twice.
import { test } from "node:test";
import assert from "node:assert/strict";
import { derive } from "../../crm/dashboard/js/core/model.js";
import {
  doNow, doNowCount, doNowInfo, newProspects, comingUp, filterDoNow, reasonOf, chipText, isMine, GROUPS, REASONS,
} from "../../crm/dashboard/js/rules/today.js";
import { buildFixture, fixtureMeta, addDays } from "../fixtures/make-seed.mjs";

const TODAY = "2026-10-22"; // a Thursday
const meta = fixtureMeta();

// v2 rows of the fixture (spec 6.3.2): the partners columns plus the joined lookups.
function v2Rows(fx) {
  const by = (list, key) => {
    const m = new Map();
    for (const x of list) (m.get(x[key]) || m.set(x[key], []).get(x[key])).push(x);
    return m;
  };
  const contacts = by(fx.contacts, "account_id");
  const acts = by(fx.activity, "account_id");
  const sugg = by(fx.suggestions.filter((s) => s.status === "open" && (s.kind === "candidate" || s.kind === "email")), "account_id");
  const max = (list, k) => list.reduce((m, x) => (x[k] != null && (m == null || x[k] > m) ? x[k] : m), null);
  return fx.partners.map((p) => {
    const cs = contacts.get(p.id) || [];
    const contactLabel = cs.map((c) => [c.first_name, c.last_name].filter(Boolean).join(" ") || (c.email || "").split("@")[0]).find(Boolean);
    return Object.assign({}, p, {
      label: p.name || p.domain || contactLabel || "Unnamed creator",
      last_email: max(cs, "last_email"),
      replied_contact: cs.length ? Math.max(...cs.map((c) => Number(c.replied) || 0)) : null,
      act_at: max(acts.get(p.id) || [], "date"),
      sugg: (sugg.get(p.id) || []).length || null,
    });
  });
}

function records(today = TODAY) {
  const fx = buildFixture({ today });
  return { fx, recs: v2Rows(fx).map((r) => derive(r, { meta, today })) };
}

const { fx, recs } = records();
const opts = (me, over = {}) => Object.assign({ meta, today: TODAY, me }, over);
const ids = (rows) => rows.map((x) => (x.record ? x.record.id : x.id));
const of = (rows, reason) => rows.filter((x) => x.reason === reason);
const one = (tag) => fx.groups[tag][0];

// A neutral record for the edge cases (derived with the fixture meta).
function rec(over = {}, today = TODAY) {
  return derive(Object.assign({
    id: "PG-09001", domain: "edge.example.test", name: "Edge Case", label: "Edge Case", type: null, dr: 30, traffic: null,
    owner: "Kamile", stage: "Contacted", last_touch: null, clients: "Ultahost", country: null, contacts: 1, next_step: null,
    next_due: null, deal_model: null, deal_flat: null, deal_pct: null, deal_value: null, live_date: null, content_url: null,
    tracking_id: null, source: null, updated_at: null, updated_by: null, last_email: null, replied_contact: null, act_at: null,
    sugg: null,
  }, over), { meta, today });
}

test("Kamile's Do now: the intended rows per reason, in display order", () => {
  const info = doNowInfo(recs, opts("Kamile"));
  const want = fx.intended.Kamile.doNow;
  for (const reason of ["overdue", "reply", "decision", "due", "quiet"]) {
    assert.deepEqual(ids(of(info.rows, reason)), want[reason], reason);
  }
  const noreply = of(info.rows, "noreply");
  assert.equal(noreply.length, want.noreply.count, "no-reply rows are capped at 10");
  assert.equal(info.noreplyTotal, want.noreply.candidates, "noreplyTotal counts them before the cap");
  for (const x of noreply) assert.ok(want.noreply.dated.includes(x.record.id), x.record.id + " is a dated no-reply site (undated last)");
  assert.deepEqual(ids(noreply), want.noreply.dated.slice().sort().slice(0, 10), "same date: id order");
  assert.deepEqual(info.rows.map((x) => x.reason), REASONS.flatMap((r) => Array(info.counts[r]).fill(r)), "reasons 1 -> 6");
  assert.equal(info.rows.length, fx.intended.Kamile.doNowCount);
  assert.equal(doNowCount(recs, opts("Kamile")), fx.intended.Kamile.doNowCount);
  for (const id of fx.intended.Kamile.notInDoNow) assert.ok(!ids(info.rows).includes(id), id + " stays out of Do now");
});

test("chips: Overdue Nd, Replied Nd ago, Your decision, Due today, Quiet Nd, No reply Nd", () => {
  const rows = doNow(recs, opts("Kamile"));
  const chip = (id) => rows.find((x) => x.record.id === id).chip;
  assert.equal(chip(one("K-od3")), "Overdue 6d");
  assert.equal(chip(one("K-od1")), "Overdue 3d");
  assert.equal(chip(one("K-od2")), "Overdue 1d");
  assert.equal(chip(one("K-due2")), "Replied 1d ago");
  assert.equal(chip(one("K-rep-b")), "Replied 5d ago", "an email-dated reply counts from the contact's last email");
  assert.equal(chip(one("K-neg-decision")), "Your decision");
  assert.equal(chip(one("K-due1")), "Due today");
  assert.equal(chip(one("K-act-quiet")), "Quiet 20d");
  assert.equal(chip(one("K-neg-waiting")), "Quiet 9d");
  assert.equal(of(rows, "noreply")[0].chip, "No reply 20d");
  assert.equal(chipText(rec({ stage: "Replied", last_touch: TODAY }), "reply", { today: TODAY }), "Replied today");
  assert.equal(chipText(rec({}), "noreply", { today: TODAY }), "No reply · no date");
});

test("the No date chip shows on reply and decision rows without a follow-up date only", () => {
  const rows = doNow(recs, opts("Kamile"));
  assert.deepEqual(ids(rows.filter((x) => x.noDate)), fx.intended.Kamile.noDateChip);
  assert.equal(rows.find((x) => x.record.id === one("K-due2")).noDate, false, "a reply with a date has no chip");
});

test("Jonas: the 6 email-dated replies are in, the 40 old touch-dated ones are not (7-day window)", () => {
  const info = doNowInfo(recs, opts("Jonas"));
  const want = fx.intended.Jonas.doNow;
  for (const reason of ["overdue", "decision", "quiet"]) assert.deepEqual(ids(of(info.rows, reason)), want[reason], reason);
  assert.deepEqual(ids(of(info.rows, "reply")).sort(), want.reply.slice().sort(), "email-dated replies");
  for (const x of of(info.rows, "reply")) assert.equal(x.chip, "Replied 10d ago");
  assert.deepEqual(ids(of(info.rows, "noreply")).sort(), want.noreply.dated.slice().sort());
  assert.equal(info.rows.length, fx.intended.Jonas.doNowCount);
  for (const id of fx.intended.Jonas.notInDoNow) assert.ok(!ids(info.rows).includes(id), id + " (old reply) stays out");
});

test("header chips: Replies = reply; Follow-ups = overdue, due, noreply; Deals = decision, quiet", () => {
  const info = doNowInfo(recs, opts("Kamile"));
  const k = fx.intended.Kamile.doNow;
  assert.deepEqual(GROUPS, { replies: ["reply"], followups: ["overdue", "due", "noreply"], deals: ["decision", "quiet"] });
  assert.equal(info.groups.all, fx.intended.Kamile.doNowCount);
  assert.equal(info.groups.replies, k.reply.length);
  assert.equal(info.groups.followups, k.overdue.length + k.due.length + k.noreply.count);
  assert.equal(info.groups.deals, k.decision.length + k.quiet.length);
  assert.deepEqual(ids(filterDoNow(info.rows, "replies")), k.reply);
  assert.deepEqual(ids(filterDoNow(info.rows, "deals")), k.decision.concat(k.quiet));
  assert.equal(filterDoNow(info.rows, "followups").length, info.groups.followups);
  assert.equal(filterDoNow(info.rows, "all").length, info.rows.length);
});

test("New prospects: mine, not contacted, no big sites, not snoozed; suggestions, contacts, NEW- ids, then newest", () => {
  const list = newProspects(recs, opts("Kamile"));
  const want = fx.intended.Kamile.newProspects;
  assert.equal(list.length, want.count);
  const sugg = want.withSuggestions.slice().sort().reverse();
  assert.deepEqual(ids(list.slice(0, 5)), sugg, "the 5 with an open suggestion first, newest first");
  assert.deepEqual(ids(list.slice(5, 7)), want.newIds, "then the NEW- ids (NEW-0002 before NEW-0001)");
  const rest = ids(list.slice(7));
  assert.deepEqual(rest, rest.slice().sort().reverse(), "then PG number descending");
  for (const r of list) assert.ok(r.owner === "Kamile" && r.notContacted && !r.isPlatform && !r.snoozed);

  const jonas = newProspects(recs, opts("Jonas"));
  assert.equal(jonas.length, fx.intended.Jonas.newProspects.count, "Jonas: 5");
  for (const id of fx.intended.Jonas.newProspects.platformsHidden) assert.ok(!ids(jonas).includes(id), id + " is a big site");
  const withContacts = jonas.filter((r) => r.contacts > 0).length;
  assert.ok(jonas.slice(0, withContacts).every((r) => r.contacts > 0), "sites with a contact come before the rest");
  assert.equal(jonas[withContacts].id, "NEW-0004", "then the NEW- id");
});

test("New prospects order: a contact beats a NEW- id; a snoozed or Researching site", () => {
  const list = newProspects([
    rec({ id: "PG-00010", stage: "New", contacts: 0 }),
    rec({ id: "NEW-0007", stage: "New", contacts: 0 }),
    rec({ id: "PG-00002", stage: "New", contacts: 2 }),
    rec({ id: "PG-00003", stage: "Researching", contacts: 0, sugg: 1 }),
    rec({ id: "PG-00004", stage: "New", contacts: 0, next_due: addDays(TODAY, 3) }),
    rec({ id: "PG-00005", stage: "New", contacts: 0, domain: "google.com" }),
  ], opts("Kamile"));
  assert.deepEqual(ids(list), ["PG-00003", "PG-00002", "NEW-0007", "PG-00010"]);
});

test("Coming up: mine, a future follow-up date, not closed, soonest first", () => {
  assert.deepEqual(ids(comingUp(recs, opts("Kamile"))), fx.intended.Kamile.comingUp);
  const list = comingUp([
    rec({ id: "PG-00001", next_due: addDays(TODAY, 9) }),
    rec({ id: "PG-00002", next_due: addDays(TODAY, 1) }),
    rec({ id: "PG-00003", next_due: addDays(TODAY, 1), stage: "Lost" }),
    rec({ id: "PG-00004", next_due: TODAY }),
    rec({ id: "PG-00005", next_due: addDays(TODAY, 2), owner: "Jonas" }),
  ], opts("Kamile"));
  assert.deepEqual(ids(list), ["PG-00002", "PG-00001"]);
});

test("first matching reason wins; closed, snoozed, waiting and live sites stay out", () => {
  const r = (over) => reasonOf(rec(over), { meta, today: TODAY });
  const ago = (n) => addDays(TODAY, -n);
  assert.equal(r({ stage: "Replied", last_touch: ago(1), next_due: ago(2) }), "overdue", "overdue before reply");
  assert.equal(r({ stage: "Lost", next_due: ago(2) }), null, "a closed site is never overdue");
  assert.equal(r({ stage: "Replied", last_touch: ago(1), next_due: addDays(TODAY, 1) }), null, "a snoozed reply waits");
  assert.equal(r({ stage: "Replied", last_touch: ago(8) }), null, "touch-dated replies: 7 days");
  assert.equal(r({ stage: "Replied", last_touch: ago(7) }), "reply");
  assert.equal(r({ stage: "Replied", last_email: ago(30), replied_contact: 1 }), "reply", "email-dated replies: 30 days");
  assert.equal(r({ stage: "Replied", last_email: ago(31), replied_contact: 1 }), null);
  assert.equal(r({ stage: "Replied", last_touch: ago(3), act_at: ago(2) }), null, "handled: activity after the reply");
  assert.equal(r({ stage: "Replied", last_touch: ago(3), updated_by: "Kamile", updated_at: ago(3) + "T12:00:00" }), null, "handled: edited on the site");
  assert.equal(r({ stage: "Negotiating", last_touch: ago(1) }), "decision");
  assert.equal(r({ stage: "Negotiating", last_touch: ago(3), next_step: "Waiting on client: sign-off" }), null, "waiting, not quiet yet");
  assert.equal(r({ stage: "Negotiating", last_touch: ago(8), next_step: "waiting on client: sign-off" }), "quiet", "waiting and quiet > 7d");
  assert.equal(r({ stage: "Contacted", next_due: TODAY, last_touch: ago(1) }), "due");
  assert.equal(r({ stage: "Active", last_touch: ago(15) }), "quiet");
  assert.equal(r({ stage: "Active", last_touch: ago(15), content_url: "https://x.example.test/p" }), null, "live placements are never quiet");
  assert.equal(r({ stage: "Active", last_touch: ago(14) }), null, "quiet means more than 14 days");
  assert.equal(r({ stage: "Contacted", last_touch: ago(15) }), "noreply");
  assert.equal(r({ stage: "Contacted", last_touch: ago(14) }), null);
  assert.equal(r({ stage: "Contacted" }), "noreply", "no date at all");
  assert.equal(r({ stage: "Contacted", next_due: addDays(TODAY, 3) }), null, "a follow-up date hides it");
  assert.equal(r({ stage: "New" }), null);
});

test("no-reply rows: oldest first, undated last, capped by meta.noreply_cap", () => {
  const list = [
    rec({ id: "PG-00001" }),
    rec({ id: "PG-00002", last_touch: addDays(TODAY, -20) }),
    rec({ id: "PG-00003", last_touch: addDays(TODAY, -40) }),
    rec({ id: "PG-00004", last_touch: addDays(TODAY, -15) }),
  ];
  assert.deepEqual(ids(doNow(list, opts("Kamile"))), ["PG-00003", "PG-00002", "PG-00004", "PG-00001"]);
  const capped = doNowInfo(list, opts("Kamile", { meta: Object.assign(fixtureMeta(), { noreply_cap: 2 }) }));
  assert.deepEqual(ids(capped.rows), ["PG-00003", "PG-00002"]);
  assert.equal(capped.noreplyTotal, 4);
  const noMeta = doNowInfo(Array.from({ length: 14 }, (_, i) => rec({ id: "PG-0010" + String(i).padStart(2, "0") })), { today: TODAY, me: "Kamile" });
  assert.equal(noMeta.rows.length, 10, "the cap defaults to 10");
});

test("decision: oldest activity first, sites without any date first", () => {
  const list = [
    rec({ id: "PG-00001", stage: "Negotiating", last_touch: addDays(TODAY, -2) }),
    rec({ id: "PG-00002", stage: "Negotiating" }),
    rec({ id: "PG-00003", stage: "Negotiating", last_touch: addDays(TODAY, -5) }),
  ];
  assert.deepEqual(ids(doNow(list, opts("Kamile"))), ["PG-00002", "PG-00003", "PG-00001"]);
});

test("owner = me ignores case and spaces; no me is everyone's view", () => {
  assert.equal(isMine(rec({ owner: " kamile " }), "Kamile"), true);
  assert.equal(isMine(rec({ owner: null }), "Kamile"), false);
  assert.equal(isMine(rec({ owner: "Jonas" }), "Kamile"), false);
  assert.equal(isMine(rec({ owner: null }), null), true);
  const all = doNowCount(recs, opts(null));
  assert.ok(all > fx.intended.Kamile.doNowCount, "the team view has more rows than Kamile's");
  assert.equal(doNowCount(recs, opts("Nobody")), 0);
  assert.deepEqual(newProspects(recs, opts("Nobody")), []);
  assert.deepEqual(comingUp(recs, opts("Nobody")), []);
});

test("pure: the input list and rows are not changed; the same day gives the same lists on any weekday", () => {
  const list = recs.slice(0, 200);
  const copy = JSON.stringify(list);
  doNow(list, opts("Kamile"));
  newProspects(list, opts("Kamile"));
  comingUp(list, opts("Kamile"));
  assert.equal(JSON.stringify(list), copy);
  for (const day of ["2026-10-24", "2026-10-26", "2027-01-01"]) { // a Saturday, a Monday, New Year
    const { fx: f2, recs: r2 } = records(day);
    const o = { meta, today: day };
    assert.equal(doNowCount(r2, Object.assign({ me: "Kamile" }, o)), f2.intended.Kamile.doNowCount, day + " Kamile");
    assert.equal(doNowCount(r2, Object.assign({ me: "Jonas" }, o)), f2.intended.Jonas.doNowCount, day + " Jonas");
    assert.deepEqual(ids(comingUp(r2, Object.assign({ me: "Kamile" }, o))), f2.intended.Kamile.comingUp, day + " Coming up");
  }
});
