// Unit tests for js/rules/deals.js (spec 2.2.3, Appendix B.5). Owner F4.
// The records are the synthetic fixture (tests/fixtures/make-seed.mjs) turned into v2 rows the way
// lib/crm.js#v2Sql builds them (contacts and activity joined), then model.derive. The expected groups are
// worked out here from the raw fixture rows, without the rules module, so the test is not circular.
import { test } from "node:test";
import assert from "node:assert/strict";
import { derive } from "../../crm/dashboard/js/core/model.js";
import { dealGroups, dealValue, groupOf, isQuiet, lostRecently, GROUPS, LOST_DAYS } from "../../crm/dashboard/js/rules/deals.js";
import { buildFixture, fixtureMeta, addDays } from "../fixtures/make-seed.mjs";

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
  const max = (list, k) => list.reduce((m, x) => (x[k] != null && (m == null || x[k] > m) ? x[k] : m), null);
  return fx.partners.map((p) => {
    const cs = contacts.get(p.id) || [];
    return Object.assign({}, p, {
      label: p.name || p.domain || "Unnamed creator",
      last_email: max(cs, "last_email"),
      replied_contact: cs.length ? Math.max(...cs.map((c) => Number(c.replied) || 0)) : null,
      act_at: max(acts.get(p.id) || [], "date"),
      sugg: null,
    });
  });
}

const fx = buildFixture({ today: TODAY });
const raw = v2Rows(fx);
const recs = raw.map((r) => derive(r, { meta, today: TODAY }));
const ids = (list) => list.map((r) => r.id);
const sorted = (list) => list.slice().sort((a, b) => a.localeCompare(b, "en", { numeric: true }));

// The last activity of a raw row, by hand: max(last_touch, last_email, act_at, date(updated_at)).
function lastAct(r) {
  const days = [r.last_touch, r.last_email, r.act_at, r.updated_at ? String(r.updated_at).slice(0, 10) : null].filter(Boolean);
  return days.length ? days.sort().pop() : null;
}
const daysAgo = (iso) => Math.round((Date.parse(TODAY + "T00:00:00Z") - Date.parse(iso + "T00:00:00Z")) / 86400000);
const money = (v) => (v == null || v === "" ? null : Number(v));

// A neutral record for the edge cases.
function rec(over = {}, today = TODAY) {
  return derive(Object.assign({
    id: "PG-09001", domain: "edge.example.test", name: "Edge Deal", label: "Edge Deal", type: null, dr: 30, traffic: null,
    owner: "Jonas", stage: "Negotiating", last_touch: null, clients: "Soro", country: null, contacts: 1, next_step: null,
    next_due: null, deal_model: null, deal_flat: null, deal_pct: null, deal_value: null, live_date: null, content_url: null,
    tracking_id: null, source: null, updated_at: null, updated_by: null, last_email: null, replied_contact: null, act_at: null,
    sugg: null,
  }, over), { meta, today });
}

test("the groups are B.5 on the fixture, worked out from the raw rows", () => {
  const g = dealGroups(recs, { meta, today: TODAY });
  const exp = {
    negotiating: raw.filter((r) => r.stage === "Negotiating").map((r) => r.id),
    signed: raw.filter((r) => r.stage === "Active" && !r.content_url).map((r) => r.id),
    live: raw.filter((r) => r.stage === "Active" && r.content_url).map((r) => r.id),
    lost: raw.filter((r) => r.stage === "Lost" && lastAct(r) && daysAgo(lastAct(r)) <= 30).map((r) => r.id),
  };
  for (const k of Object.keys(exp)) assert.deepEqual(sorted(ids(g[k])), sorted(exp[k]), k);
  assert.equal(g.negotiating.length, fx.counts.by_stage.Negotiating, "every Negotiating site is a deal");
  assert.equal(g.signed.length + g.live.length, fx.counts.by_stage.Active, "every Active site is signed or live");
  assert.ok(g.lost.length > 0 && g.lost.length < fx.counts.by_stage.Lost, "some Lost sites are recent, some are older");
  assert.equal(g.count, g.negotiating.length + g.signed.length + g.live.length + g.lost.length);
  // The fixture rows the report test relies on land where they should.
  assert.ok(ids(g.negotiating).includes(fx.groups["internal-marker"][0]));
  assert.ok(ids(g.live).includes(fx.groups["active-future-live"][0]), "a future live date is still Live (it has a link)");
  assert.ok(ids(g.signed).includes(fx.groups["J-act-signed"][0]));
  assert.ok(ids(g.lost).includes(fx.groups["lost-with-terms"][0]));
  // No other stage is ever a deal.
  for (const r of [...g.negotiating, ...g.signed, ...g.live, ...g.lost]) assert.ok(["Negotiating", "Active", "Lost"].includes(r.stage));
});

test("totals are sum(deal_value ?? deal_flat) for Negotiating and Signed, with the count that has a value", () => {
  const g = dealGroups(recs, { meta, today: TODAY });
  for (const k of ["negotiating", "signed"]) {
    const rows = raw.filter((r) => g[k].some((x) => x.id === r.id));
    const vals = rows.map((r) => (money(r.deal_value) != null ? money(r.deal_value) : money(r.deal_flat))).filter((v) => v != null);
    assert.equal(g.totals[k], vals.reduce((a, b) => a + b, 0), k + " total");
    assert.equal(g.valued[k], vals.length, k + " valued");
  }
  assert.ok(g.totals.negotiating > 0);
  assert.deepEqual(Object.keys(g.totals).sort(), ["negotiating", "signed"]);
  // Value wins over the flat fee; the flat fee stands in when there is no value; strings are read as numbers.
  assert.equal(dealValue(rec({ deal_value: 1000, deal_flat: 250 })), 1000);
  assert.equal(dealValue(rec({ deal_flat: 250 })), 250);
  assert.equal(dealValue({ deal_value: "$1,200", deal_flat: null }), 1200);
  assert.equal(dealValue({ deal_value: "", deal_flat: "350" }), 350);
  assert.equal(dealValue(rec({ deal_pct: 30 })), null, "a commission alone has no value");
  assert.equal(dealValue(null), null);
  // Cents add up exactly.
  const cents = dealGroups([rec({ id: "PG-1", deal_value: 0.1 }), rec({ id: "PG-2", deal_value: 0.2 }), rec({ id: "PG-3" })], { meta, today: TODAY });
  assert.equal(cents.totals.negotiating, 0.3);
  assert.equal(cents.valued.negotiating, 2);
  assert.equal(cents.totals.signed, 0);
});

test("Lost in the last 30 days counts local calendar days: day 30 is in, day 31 is out, no date is out", () => {
  const lost = (over) => rec(Object.assign({ stage: "Lost", next_step: null }, over));
  assert.equal(LOST_DAYS, 30);
  assert.equal(groupOf(lost({ last_touch: addDays(TODAY, -30) }), { today: TODAY }), "lost");
  assert.equal(groupOf(lost({ last_touch: addDays(TODAY, -31) }), { today: TODAY }), null);
  assert.equal(groupOf(lost({ last_touch: TODAY }), { today: TODAY }), "lost", "0 days is not 'no date'");
  assert.equal(groupOf(lost({}), { today: TODAY }), null, "no activity date at all");
  assert.equal(groupOf(lost({ last_touch: addDays(TODAY, 3) }), { today: TODAY }), "lost", "a future date counts as recent");
  // Any of the four dates counts (B definitions: last_touch, last_email, act_at, updated_at).
  assert.equal(groupOf(lost({ last_touch: addDays(TODAY, -90), act_at: addDays(TODAY, -2) }), { today: TODAY }), "lost");
  assert.equal(groupOf(lost({ last_touch: addDays(TODAY, -90), last_email: addDays(TODAY, -5) }), { today: TODAY }), "lost");
  assert.equal(lostRecently(lost({ last_touch: TODAY }), {}), false, "no today, no group");
  assert.equal(lostRecently(rec({ last_touch: TODAY }), { today: TODAY }), false, "only Lost sites");
});

test("a site moved to Lost today at 13:00 UTC is in Lost (the noon-UTC bug of the old page)", () => {
  // The old page computed floor((now - <date>T12:00Z) / 1 day): 0 after 12:00 UTC, and 0 || 999 dropped the site.
  const moved = rec({ stage: "Lost", last_touch: addDays(TODAY, -45), updated_at: TODAY + "T13:00:00Z", updated_by: "Jonas", act_at: TODAY });
  assert.equal(groupOf(moved, { today: TODAY }), "lost");
  const g = dealGroups([moved], { meta, today: TODAY });
  assert.deepEqual(ids(g.lost), [moved.id]);
  // The same at 23:59 UTC, whatever the local time zone makes of the timestamp.
  const late = rec({ stage: "Lost", updated_at: TODAY + "T23:59:00Z", updated_by: "Jonas" });
  assert.equal(groupOf(late, { today: TODAY }), "lost");
});

test("Active splits on the placement link; other stages are never deals", () => {
  assert.equal(groupOf(rec({ stage: "Active" }), { today: TODAY }), "signed");
  assert.equal(groupOf(rec({ stage: "Active", content_url: "https://p.example.test/a" }), { today: TODAY }), "live");
  assert.equal(groupOf(rec({ stage: "Active", content_url: "   " }), { today: TODAY }), "signed", "blank is no link");
  assert.equal(groupOf(rec({ stage: "Active", live_date: TODAY }), { today: TODAY }), "signed", "a date without a link is not live");
  for (const stage of ["New", "Researching", "Contacted", "Replied", "Do not contact", ""]) {
    assert.equal(groupOf(rec({ stage, last_touch: TODAY }), { today: TODAY }), null, stage || "no stage");
  }
  assert.equal(groupOf(null, { today: TODAY }), null);
});

test("Going quiet is B.1 rule 5: Negotiating > 7 days, Active without a link > 14 days, never when snoozed", () => {
  const q = (over) => isQuiet(rec(over), { meta });
  assert.equal(q({ last_touch: addDays(TODAY, -8) }), true);
  assert.equal(q({ last_touch: addDays(TODAY, -7) }), false, "7 days is not more than 7");
  assert.equal(q({}), false, "no activity date: no chip (there is no number to show)");
  assert.equal(q({ last_touch: addDays(TODAY, -20), next_due: addDays(TODAY, 2) }), false, "snoozed");
  assert.equal(q({ last_touch: addDays(TODAY, -20), next_due: addDays(TODAY, -2) }), true, "an overdue date is not a snooze");
  assert.equal(q({ stage: "Active", last_touch: addDays(TODAY, -15) }), true);
  assert.equal(q({ stage: "Active", last_touch: addDays(TODAY, -14) }), false);
  assert.equal(q({ stage: "Active", last_touch: addDays(TODAY, -60), content_url: "https://p.example.test/a" }), false, "live");
  assert.equal(q({ stage: "Lost", last_touch: addDays(TODAY, -60) }), false);
  // meta.sla wins over the built-in numbers.
  const strict = Object.assign({}, meta, { sla: Object.assign({}, meta.sla, { Negotiating: 2 }) });
  assert.equal(isQuiet(rec({ last_touch: addDays(TODAY, -3) }), { meta: strict }), true);
  // Every quiet fixture deal is open and has no future date.
  const g = dealGroups(recs, { meta, today: TODAY });
  const quiet = [...g.negotiating, ...g.signed].filter((r) => isQuiet(r, { meta }));
  assert.ok(quiet.length > 0, "the fixture has quiet deals");
  for (const r of quiet) assert.ok(!r.snoozed && r.quietDays > 7, r.id);
  for (const r of [...g.live, ...g.lost]) assert.equal(isQuiet(r, { meta }), false, r.id);
});

test("order inside each group", () => {
  const d = (n) => addDays(TODAY, n);
  const neg = [
    rec({ id: "PG-00010", last_touch: d(-2) }),
    rec({ id: "PG-00011", next_due: d(5), last_touch: d(-1) }),
    rec({ id: "PG-00012", next_due: d(-3), last_touch: d(-1) }),
    rec({ id: "PG-00013", last_touch: d(-20) }),
    rec({ id: "PG-00014" }),
    rec({ id: "PG-00015", next_due: d(5), last_touch: d(-9) }),
  ];
  const live = [
    rec({ id: "PG-00020", stage: "Active", content_url: "https://a.example.test", live_date: d(-40) }),
    rec({ id: "PG-00021", stage: "Active", content_url: "https://b.example.test" }),
    rec({ id: "PG-00022", stage: "Active", content_url: "https://c.example.test", live_date: d(-3) }),
    rec({ id: "PG-00023", stage: "Active", content_url: "https://d.example.test", live_date: d(10) }),
  ];
  const lost = [
    rec({ id: "PG-00030", stage: "Lost", last_touch: d(-20) }),
    rec({ id: "PG-00031", stage: "Lost", last_touch: d(-1) }),
    rec({ id: "PG-00032", stage: "Lost", last_touch: d(-10) }),
  ];
  const g = dealGroups([...neg, ...live, ...lost].reverse(), { meta, today: TODAY });
  // Overdue first, then by date; no date last, the longest-quiet first (no activity date before any date).
  assert.deepEqual(ids(g.negotiating), ["PG-00012", "PG-00015", "PG-00011", "PG-00014", "PG-00013", "PG-00010"]);
  assert.deepEqual(ids(g.live), ["PG-00023", "PG-00022", "PG-00020", "PG-00021"], "newest went-live date first, none last");
  assert.deepEqual(ids(g.lost), ["PG-00031", "PG-00032", "PG-00030"], "most recent first");
});

test("dealGroups is pure: new arrays, input untouched, empty and odd input", () => {
  const input = recs.slice();
  const before = JSON.stringify(input.map((r) => r.id));
  const a = dealGroups(input, { meta, today: TODAY });
  const b = dealGroups(input, { meta, today: TODAY });
  assert.equal(JSON.stringify(input.map((r) => r.id)), before);
  assert.notEqual(a.negotiating, b.negotiating);
  assert.deepEqual(ids(a.negotiating), ids(b.negotiating));
  const none = dealGroups([], { meta, today: TODAY });
  assert.deepEqual([none.negotiating, none.signed, none.live, none.lost], [[], [], [], []]);
  assert.deepEqual(none.totals, { negotiating: 0, signed: 0 });
  assert.equal(none.count, 0);
  assert.equal(dealGroups(null, {}).count, 0);
  assert.equal(dealGroups(undefined).count, 0);
  // Without today, Lost sites can't be dated, so none shows; the open groups still do.
  const noDay = dealGroups(recs, { meta });
  assert.equal(noDay.lost.length, 0);
  assert.equal(noDay.negotiating.length, fx.counts.by_stage.Negotiating);
});

test("GROUPS lists the four groups in display order with their headings", () => {
  assert.deepEqual(GROUPS.map((g) => g.id), ["negotiating", "signed", "live", "lost"]);
  assert.deepEqual(GROUPS.map((g) => g.label), ["Negotiating", "Signed, not live", "Live", "Lost in the last 30 days"]);
  assert.deepEqual(GROUPS.filter((g) => g.total).map((g) => g.id), ["negotiating", "signed"]);
  for (const g of GROUPS) assert.ok(g.desc && /\.$/.test(g.desc), g.id + " has a one-sentence description");
});
