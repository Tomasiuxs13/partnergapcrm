// Unit tests for js/core/model.js (spec 5.4, Appendix B "Definitions"). Owner G1-D.
// derive() gets v2 rows (spec 6.3.2) and the fixture's meta (tests/fixtures/make-seed.mjs fixtureMeta()).
import { test } from "node:test";
import assert from "node:assert/strict";
import { derive, setWaitingOnClient, parseNext } from "../../crm/dashboard/js/core/model.js";
import { buildFixture, fixtureMeta } from "../fixtures/make-seed.mjs";

const TODAY = "2026-10-22"; // a Thursday
const meta = fixtureMeta();

// One v2 row (spec 6.3.2 cols) with neutral values.
function row(over = {}) {
  return {
    id: "PG-00010", domain: "hub.example.test", name: "Hub Daily", label: "Hub Daily", type: "Review", dr: 45, traffic: 1200,
    owner: "Kamile", stage: "Contacted", last_touch: null, clients: "Ultahost", country: "US", contacts: 2,
    next_step: "Follow up if no reply", next_due: null, deal_model: null, deal_flat: null, deal_pct: null, deal_value: null,
    live_date: null, content_url: null, tracking_id: null, source: null, updated_at: null, updated_by: null,
    last_email: null, replied_contact: null, act_at: null, sugg: null, ...over,
  };
}
const d = (over, today = TODAY) => derive(row(over), { meta, today });

test("derive keeps the v2 columns and does not change its input", () => {
  const raw = row({ next_due: "2026-10-30" });
  const copy = structuredClone(raw);
  const r = derive(raw, { meta, today: TODAY });
  assert.deepEqual(raw, copy, "input unchanged");
  for (const k of ["id", "domain", "name", "owner", "stage", "clients", "next_step", "next_due"]) assert.equal(r[k], raw[k], k);
});

test("lastActivity = max(last_touch, last_email, act_at, date(updated_at)); quietDays counts to today", () => {
  let r = d({ last_touch: "2026-10-10", last_email: "2026-10-12", act_at: "2026-10-11", updated_at: "2026-10-09T12:00:00Z", updated_by: "Kamile" });
  assert.equal(r.lastActivity, "2026-10-12");
  assert.equal(r.quietDays, 10);
  r = d({ last_touch: "2026-10-10", act_at: "2026-10-14" });
  assert.equal(r.lastActivity, "2026-10-14");
  assert.equal(r.quietDays, 8);
  r = d({ last_touch: "2026-10-10", updated_at: "2026-10-15T12:00:00Z", updated_by: "Kamile" });
  assert.equal(r.lastActivity, "2026-10-15", "the date part of updated_at counts");
  r = d({ last_touch: "2026-10-22" });
  assert.equal(r.quietDays, 0);
  r = d({});
  assert.equal(r.lastActivity, null);
  assert.equal(r.quietDays, null);
});

test("replyDate and replySource", () => {
  let r = d({ stage: "Replied", replied_contact: 1, last_email: "2026-10-12", last_touch: "2026-10-18" });
  assert.equal(r.replyDate, "2026-10-12");
  assert.equal(r.replySource, "email", "a replied contact's last_email wins over last_touch");
  r = d({ stage: "Replied", replied_contact: 0, last_email: "2026-10-12", last_touch: "2026-10-18" });
  assert.equal(r.replyDate, "2026-10-18");
  assert.equal(r.replySource, "touch");
  r = d({ stage: "Replied", replied_contact: 1, last_email: null, last_touch: "2026-10-18" });
  assert.equal(r.replyDate, "2026-10-18");
  assert.equal(r.replySource, "touch");
  r = d({ stage: "Replied", replied_contact: null, last_email: null, last_touch: null });
  assert.equal(r.replyDate, null);
  assert.equal(r.replySource, null);
});

test("replyFresh uses meta.reply_window (email 30 days, touch 7 days)", () => {
  assert.equal(d({ replied_contact: 1, last_email: "2026-10-12" }).replyFresh, true, "email, 10 days");
  assert.equal(d({ replied_contact: 1, last_email: "2026-09-22" }).replyFresh, true, "email, 30 days");
  assert.equal(d({ replied_contact: 1, last_email: "2026-09-21" }).replyFresh, false, "email, 31 days");
  assert.equal(d({ last_touch: "2026-10-15" }).replyFresh, true, "touch, 7 days");
  assert.equal(d({ last_touch: "2026-10-14" }).replyFresh, false, "touch, 8 days");
  assert.equal(d({ last_touch: "2026-10-12" }).replyFresh, false, "touch, 10 days (D10)");
  assert.ok(!d({}).replyFresh, "no reply date");
});

test("handled: activity or a site edit on or after the reply", () => {
  const base = { stage: "Replied", last_touch: "2026-10-18" };
  assert.equal(d({ ...base, act_at: "2026-10-18" }).handled, true, "activity the same day");
  assert.equal(d({ ...base, act_at: "2026-10-20" }).handled, true, "activity after");
  assert.equal(d({ ...base, act_at: "2026-10-17" }).handled, false, "activity before");
  assert.equal(d({ ...base, updated_at: "2026-10-19T12:00:00Z", updated_by: "Kamile" }).handled, true, "a site edit after");
  assert.equal(d({ ...base, updated_at: "2026-10-19T12:00:00Z", updated_by: null }).handled, false, "updated_at without updated_by (a sheet import)");
  assert.equal(d({ ...base, updated_at: "2026-10-17T12:00:00Z", updated_by: "Kamile" }).handled, false, "a site edit before");
});

test("snoozed, due, closed and notContacted", () => {
  assert.equal(d({ next_due: "2026-10-23" }).snoozed, true);
  assert.equal(d({ next_due: TODAY }).snoozed, false);
  assert.equal(d({ next_due: "2026-10-20" }).snoozed, false);
  assert.equal(d({ next_due: null }).snoozed, false);
  assert.equal(d({ next_due: "2026-10-23" }).due, "2026-10-23");
  assert.equal(d({ next_due: null }).due, null);
  assert.equal(d({ next_due: "" }).due, null);
  const flags = (stage) => { const r = d({ stage }); return [r.notContacted, r.closed]; };
  assert.deepEqual(flags("New"), [true, false]);
  assert.deepEqual(flags("Researching"), [true, false]);
  assert.deepEqual(flags("Contacted"), [false, false]);
  assert.deepEqual(flags("Replied"), [false, false]);
  assert.deepEqual(flags("Negotiating"), [false, false]);
  assert.deepEqual(flags("Active"), [false, false]);
  assert.deepEqual(flags("Lost"), [false, true]);
  assert.deepEqual(flags("Do not contact"), [false, true]);
});

test("waitingOnClient and nextText", () => {
  let r = d({ stage: "Negotiating", next_step: "Waiting on client: decision on the offer" });
  assert.equal(r.waitingOnClient, true);
  assert.equal(r.nextText, parseNext(r.next_step).text);
  assert.equal(d({ next_step: "WAITING ON CLIENT: approve the fee" }).waitingOnClient, true, "case-insensitive");
  assert.equal(d({ next_step: "Agree terms" }).waitingOnClient, false);
  assert.equal(d({ next_step: "Agree terms" }).nextText, "Agree terms");
  assert.equal(d({ next_step: "Not waiting on client: x" }).waitingOnClient, false, "only a prefix counts");
  assert.equal(d({ next_step: null }).waitingOnClient, false);
});

test("isNew, isPlatform and the DR band", () => {
  assert.equal(d({ id: "NEW-0003" }).isNew, true);
  assert.equal(d({ id: "PG-00003" }).isNew, false);
  assert.equal(d({ domain: "medium.com", dr: 50 }).isPlatform, true, "root host in platform_domains");
  assert.equal(d({ domain: "big.example.test", dr: 92 }).isPlatform, true, "DR >= platform_dr");
  assert.equal(d({ domain: "big.example.test", dr: 90 }).isPlatform, true);
  assert.equal(d({ domain: "big.example.test", dr: 89 }).isPlatform, false);
  assert.equal(d({ domain: "youtube.com/@pgfixture-channel", dr: 99 }).isPlatform, false, "a channel path is a prospect (D7)");
  const band = (dr) => d({ dr }).drb.replace(/[–—]/g, "-");
  assert.equal(band(80), "80+");
  assert.equal(band(95), "80+");
  assert.equal(band(79), "60-79");
  assert.equal(band(60), "60-79");
  assert.equal(band(59), "40-59");
  assert.equal(band(40), "40-59");
  assert.equal(band(20), "20-39");
  assert.equal(band(19), "0-19");
  assert.equal(band(0), "0-19");
  assert.equal(d({ dr: null }).drb, "");
});

test("label falls back to 'Unnamed creator'", () => {
  assert.equal(d({ name: "Hub Daily" }).label, "Hub Daily");
  assert.equal(d({ name: null, label: null, domain: "hub.example.test" }).label, "hub.example.test");
  assert.equal(d({ name: null, domain: null, label: "Ottilie Vance" }).label, "Ottilie Vance", "the server's contact label");
  assert.equal(d({ name: null, domain: null, label: null }).label, "Unnamed creator");
});

test("cl and ck: canonical names and stored keys; stored tokens untouched", () => {
  const cc = (clients) => { const r = d({ clients }); return { cl: r.cl, ck: r.ck, clients: r.clients }; };
  assert.deepEqual(cc("Ultahost"), { cl: ["UltaHost"], ck: ["ultahost"], clients: "Ultahost" }, "D8: shown canonically, stored as typed");
  assert.deepEqual(cc("UltaHost"), { cl: ["UltaHost"], ck: ["ultahost"], clients: "UltaHost" });
  assert.deepEqual(cc("Weglot, Ultahost"), { cl: ["Weglot", "UltaHost"], ck: ["weglot", "ultahost"], clients: "Weglot, Ultahost" });
  assert.deepEqual(cc("MailerLite/MailerSend"), { cl: ["MailerLite", "MailerSend"], ck: ["mailerlite", "mailersend"], clients: "MailerLite/MailerSend" });
  assert.deepEqual(cc("Botanical Synthesis").ck, ["botanical synthesis"], "k keeps the space (6.3.1)");
  const mel = cc("Melograno - Trafft");
  assert.deepEqual(mel.ck, ["melograno"]);
  assert.equal(mel.cl.length, 1);
  assert.match(mel.cl[0], /^Melograno/);
  assert.deepEqual(cc("").ck, []);
  assert.deepEqual(cc(null).cl, []);
});

test("q is a lower-case search text with the id, domain and normalised name", () => {
  const r = d({ id: "PG-00321", domain: "mrmoney.example.test", name: "Mr. Money Matters", label: "Mr. Money Matters" });
  assert.equal(r.q, r.q.toLowerCase());
  assert.ok(r.q.includes("pg-00321"), r.q);
  assert.ok(r.q.includes("mrmoney.example.test"), r.q);
  assert.ok(r.q.includes("mr money matters"), r.q);
});

test("setWaitingOnClient adds or removes the prefix (D2)", () => {
  assert.equal(setWaitingOnClient("Agree terms", true), "Waiting on client: Agree terms");
  assert.equal(setWaitingOnClient("Waiting on client: Agree terms", false), "Agree terms");
  assert.equal(setWaitingOnClient("Agree terms", false), "Agree terms");
  assert.equal(setWaitingOnClient(null, false), "");
  const twice = setWaitingOnClient("Waiting on client: Agree terms", true);
  assert.deepEqual(parseNext(twice), { waitingOnClient: true, text: "Agree terms" });
  assert.equal(twice.match(/waiting on client:/gi).length, 1, "never a double prefix");
  const lower = setWaitingOnClient("waiting on client: x", true);
  assert.deepEqual(parseNext(lower), { waitingOnClient: true, text: "x" });
  assert.equal(parseNext(setWaitingOnClient("", true)).waitingOnClient, true);
});

test("parseNext", () => {
  assert.deepEqual(parseNext("Waiting on client: decision on the offer"), { waitingOnClient: true, text: "decision on the offer" });
  assert.deepEqual(parseNext("WAITING ON CLIENT:Approve"), { waitingOnClient: true, text: "Approve" });
  assert.deepEqual(parseNext("Follow up"), { waitingOnClient: false, text: "Follow up" });
  assert.deepEqual(parseNext(null), { waitingOnClient: false, text: "" });
  assert.deepEqual(parseNext(""), { waitingOnClient: false, text: "" });
  assert.equal(parseNext("Ask: waiting on client: no").waitingOnClient, false);
});

// The fixture through derive(): v2 rows built the way GET /api/partners?v=2 joins them (6.3.2).
test("derive over the whole fixture matches its counts", () => {
  const fx = buildFixture({ today: TODAY });
  const agg = new Map();
  for (const c of fx.contacts) {
    const a = agg.get(c.account_id) || { last_email: null, replied: null };
    if (c.last_email && (!a.last_email || c.last_email > a.last_email)) a.last_email = c.last_email;
    if (c.replied != null) a.replied = Math.max(a.replied || 0, Number(c.replied));
    agg.set(c.account_id, a);
  }
  const act = new Map();
  for (const a of fx.activity) if (!act.has(a.account_id) || a.date > act.get(a.account_id)) act.set(a.account_id, a.date);
  const recs = fx.partners.map((p) => derive({
    ...p, label: p.name || p.domain || null,
    last_email: agg.get(p.id)?.last_email ?? null, replied_contact: agg.get(p.id)?.replied ?? null,
    act_at: act.get(p.id) ?? null, sugg: null,
  }, { meta, today: TODAY }));
  const by = fx.counts.by_stage;
  const n = (f) => recs.filter(f).length;
  assert.equal(n((r) => r.notContacted), (by.New || 0) + (by.Researching || 0));
  assert.equal(n((r) => r.closed), (by.Lost || 0) + (by["Do not contact"] || 0));
  assert.equal(n((r) => r.isNew), fx.counts.new_ids);
  assert.deepEqual(recs.filter((r) => r.isPlatform).map((r) => r.id).sort(), fx.groups.platform.slice().sort(), "the 10 platform rows");
  assert.equal(n((r) => r.label === "Unnamed creator"), fx.counts.nameless, "nameless rows without the server's contact label");
  const byId = new Map(recs.map((r) => [r.id, r]));
  for (const id of fx.groups["jonas-replied-email"]) {
    const r = byId.get(id);
    assert.equal(r.replySource, "email", id);
    assert.equal(r.replyFresh, true, id);
  }
  for (const id of fx.groups["jonas-replied-old"]) assert.equal(byId.get(id).replyFresh, false, id + " is outside the 7-day window");
  for (const id of fx.groups["kamile-contacted-20d"]) assert.equal(byId.get(id).quietDays, 20, id);
  assert.deepEqual(recs.filter((r) => r.waitingOnClient).map((r) => r.id).sort(), fx.groups["waiting-on-client"].slice().sort());
  assert.equal(n((r) => r.waitingOnClient && r.stage === "Negotiating"), 4, "4 of the 12 Negotiating rows wait on the client (spec 8)");
});
