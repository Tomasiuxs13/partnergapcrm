// Unit tests for js/core/outcomes.js (Appendix A; spec 4.5, 5.4, 6.3.3). Owner G1-D.
// Written before the module (G1-C builds it), so they fail against the G0 stub.
//
// Readings of Appendix A that these tests fix (the simplest ones that keep the edits contract):
// - Auto follow-up: +N working days when N <= 3, else +N calendar days. "stage default" (Had a call)
//   is meta.follow_up_days[stage] under the same rule.
// - `fields` keys come in EDITABLE order (lib/crm.js). The old PATCH writes one `update` row per key
//   in request order, so this order keeps the rows equal to tests/e2e/golden (T3).
// - Clearing a field sends "" (as the golden lost-clears-next case does).
// - `terms` uses the column names: {deal_model, deal_flat, deal_pct, deal_value}. In summaries the
//   terms read "$350 + 30%" (spec F7), "$350" or "30%".
// - With an empty note, "Sent first email. {note}" may end with or without the final ". ".
// - The activity `client` is the display name of the first client token ("Ultahost" -> "UltaHost").
// - Outcomes that cannot be built (Placement is live without an http(s) link, Had a call without a
//   note) throw or return nothing.
// - Do not contact is offered only when meta.features.dnc is on (D3).
import { test } from "node:test";
import assert from "node:assert/strict";
import { OUTCOMES, outcomesFor, buildOutcomeRequest } from "../../crm/dashboard/js/core/outcomes.js";
import { derive } from "../../crm/dashboard/js/core/model.js";
import { EDITABLE, ACTIVITY_TYPES } from "../../lib/crm.js";
import { fixtureMeta } from "../fixtures/make-seed.mjs";
import fs from "node:fs";

const golden = (file, name) => JSON.parse(fs.readFileSync(new URL("../e2e/golden/" + file + ".json", import.meta.url), "utf8"))
  .cases.find((c) => c.name === name);

const TODAY = "2026-10-30"; // a Friday: +1 working day = Mon 2 Nov, +2 = Tue 3 Nov, +3 = Wed 4 Nov
const DATES = { w1: "2026-11-02", w2: "2026-11-03", w3: "2026-11-04", d7: "2026-11-06", d14: "2026-11-13", d30: "2026-11-29" };
const NOTE = "Wants the media kit.";
const ME = "Kamile";
const meta = fixtureMeta();
const metaDnc = fixtureMeta({ dnc: true });

function rec(over = {}) {
  return derive({
    id: "PG-00577", domain: "hub.example.test", name: "Hub Daily", label: "Hub Daily", type: "Review", dr: 45, traffic: 1200,
    owner: "Tomas", stage: "Replied", last_touch: "2026-10-14", clients: "Soro", country: "US", contacts: 1,
    next_step: "Answer their reply", next_due: null, deal_model: null, deal_flat: null, deal_pct: null, deal_value: null,
    live_date: null, content_url: null, tracking_id: null, source: null, updated_at: null, updated_by: null,
    last_email: null, replied_contact: null, act_at: null, sugg: null, ...over,
  }, { meta, today: TODAY });
}

const build = (r, id, opts = {}) => buildOutcomeRequest(r, id, { me: ME, meta, today: TODAY, ...opts });
const ids = (list) => (list || []).map((o) => (typeof o === "string" ? o : o.id));
const all = () => (Array.isArray(OUTCOMES) ? OUTCOMES : Object.values(OUTCOMES || {}));
const trimEnd = (s) => String(s == null ? "" : s).replace(/[\s.]+$/, "");

function assertEditableOrder(fields, what) {
  const keys = Object.keys(fields || {});
  for (const k of keys) assert.ok(EDITABLE.includes(k), what + ": " + k + " is not an EDITABLE field");
  const sorted = keys.slice().sort((a, b) => EDITABLE.indexOf(a) - EDITABLE.indexOf(b));
  assert.deepEqual(keys, sorted, what + ": fields in EDITABLE order");
}

function check(req, { fields, activity }, what) {
  assert.ok(req && typeof req === "object", what + ": a request");
  assertEditableOrder(req.fields, what);
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined) assert.ok(!(k in (req.fields || {})), what + ": no " + k);
    else assert.equal(req.fields[k] == null ? req.fields[k] : String(req.fields[k]), v, what + ": " + k);
  }
  if (activity === null) {
    assert.ok(!req.activity, what + ": no activity");
    return;
  }
  assert.ok(req.activity, what + ": an activity");
  assert.ok(ACTIVITY_TYPES.includes(req.activity.type), what + ": activity type " + req.activity.type);
  assert.equal(req.activity.type, activity.type, what + ": activity type");
  if (activity.summary !== undefined) assert.equal(req.activity.summary, activity.summary, what + ": summary");
  if (activity.summaryStart !== undefined) assert.equal(trimEnd(req.activity.summary), activity.summaryStart, what + ": summary");
  if (activity.client !== undefined) assert.equal(req.activity.client || null, activity.client, what + ": client");
}

function rejects(fn, what) {
  let out;
  try { out = fn(); } catch (e) { return; }
  assert.ok(!out || out.error, what + ": should not build a request, got " + JSON.stringify(out));
}

const LABELS = {
  emailed: "Sent first email", followed_up: "Sent a follow-up", replied: "They replied", interested: "Interested",
  not_interested: "Not interested", approve: "Approve offer", counter: "Counter-offer", ask_client: "Ask the client",
  signed: "Signed", live: "Placement is live", bounced: "Bounced / wrong person", called: "Had a call",
  dnc: "Do not contact (flag)", claim: "Claim", assign_manager: "Assign to client manager", not_fit: "Not a fit", reopen: "Reopen",
};

test("OUTCOMES: the 17 outcomes of Appendix A with their labels", () => {
  const list = all();
  assert.deepEqual(ids(list).slice().sort(), Object.keys(LABELS).sort());
  for (const o of list) assert.equal(o.label, LABELS[o.id], o.id);
});

test("outcomesFor: the buttons of each stage, in order", () => {
  const of = (over, m = meta) => { const r = outcomesFor(rec(over), { meta: m }); return { primary: ids(r.primary), more: ids(r.more) }; };
  assert.deepEqual(of({ stage: "New", owner: "Kamile" }), { primary: ["emailed", "not_fit"], more: [] });
  assert.deepEqual(of({ stage: "New", owner: null }), { primary: ["emailed", "not_fit", "claim"], more: [] }, "Claim only when unowned");
  assert.deepEqual(of({ stage: "Researching", owner: "" }), { primary: ["emailed", "not_fit", "claim"], more: [] });
  assert.deepEqual(of({ stage: "Contacted" }), { primary: ["replied", "followed_up", "not_interested"], more: ["interested", "bounced"] });
  assert.deepEqual(of({ stage: "Replied" }), { primary: ["interested", "followed_up", "not_interested"],
    more: ["ask_client", "signed", "called", "bounced"] });
  assert.deepEqual(of({ stage: "Negotiating" }), { primary: ["approve", "counter", "ask_client", "not_interested"], more: ["signed", "called"] });
  assert.deepEqual(of({ stage: "Active" }), { primary: ["live", "called"], more: ["not_interested"] });
  assert.deepEqual(of({ stage: "Lost" }), { primary: ["reopen"], more: [] });
  assert.deepEqual(of({ stage: "Do not contact" }), { primary: ["reopen"], more: [] });
});

test("outcomesFor: Do not contact only when features.dnc is on (D3)", () => {
  const of = (over) => { const r = outcomesFor(rec(over), { meta: metaDnc }); return { primary: ids(r.primary), more: ids(r.more) }; };
  assert.deepEqual(of({ stage: "New", owner: "Kamile" }), { primary: ["emailed", "not_fit"], more: ["dnc"] });
  assert.deepEqual(of({ stage: "Contacted" }), { primary: ["replied", "followed_up", "not_interested"], more: ["interested", "bounced", "dnc"] });
  assert.deepEqual(of({ stage: "Replied" }).more, ["ask_client", "signed", "called", "bounced"]);
});

test("interested equals the golden PATCH and activity rows (T3)", () => {
  const patch = golden("patch-partner", "interested");
  const act = golden("activity-log", "interested");
  const before = patch.before["PG-00577"];
  const req = build(rec({ id: "PG-00577", ...before }), "interested", { note: NOTE });
  assert.deepEqual(Object.keys(req.fields), Object.keys(patch.request.body.fields), "key order");
  assert.deepEqual(req.fields, patch.request.body.fields);
  const { by, ...want } = act.request.body;
  assert.deepEqual({ type: req.activity.type, summary: req.activity.summary, client: req.activity.client }, want);
  for (const k of Object.keys(req.activity)) assert.ok(["type", "summary", "client", "contact_id"].includes(k), "activity key " + k);
});

test("first email, follow-ups, replies", () => {
  check(build(rec({ stage: "New", owner: ME, next_step: "" }), "emailed", { note: NOTE }), {
    fields: { stage: "Contacted", next_step: "Follow up if no reply", next_due: DATES.d7 },
    activity: { type: "Email", summary: "Sent first email. " + NOTE, client: "Soro" },
  }, "emailed");
  check(build(rec({ stage: "New", owner: ME }), "emailed", {}), {
    fields: { stage: "Contacted" }, activity: { type: "Email", summaryStart: "Sent first email" },
  }, "emailed without a note");
  check(build(rec({ stage: "Contacted" }), "followed_up", { note: NOTE }), {
    fields: { stage: undefined, next_step: "Follow up if no reply", next_due: DATES.d7 },
    activity: { type: "Email", summary: "Sent a follow-up. " + NOTE },
  }, "followed_up on Contacted (+7 days)");
  check(build(rec({ stage: "Replied" }), "followed_up", { note: NOTE }), {
    fields: { stage: undefined, next_step: "Follow up if no reply", next_due: DATES.w2 },
    activity: { type: "Email", summary: "Sent a follow-up. " + NOTE },
  }, "followed_up on Replied (+2 working days)");
  check(build(rec({ stage: "Contacted" }), "replied", { note: "Asked for prices." }), {
    fields: { stage: "Replied", next_step: "Answer their reply", next_due: DATES.w2 },
    activity: { type: "Email", summary: "They replied: Asked for prices." },
  }, "replied");
  check(build(rec({ stage: "Contacted" }), "bounced", { note: NOTE }), {
    fields: { stage: undefined, next_step: "Find a new contact", next_due: DATES.w2 },
    activity: { type: "Note", summary: "Bounced or wrong person. " + NOTE },
  }, "bounced");
});

test("Not interested, Not a fit and Do not contact close the site and clear the follow-up", () => {
  for (const stage of ["Contacted", "Replied"]) {
    check(build(rec({ stage, next_due: "2026-11-02" }), "not_interested", { reason: "No budget", note: "Maybe next year." }), {
      fields: { stage: "Lost", next_step: "", next_due: "" },
      activity: { type: "Email", summary: "Not interested: No budget. Maybe next year." },
    }, "not_interested on " + stage);
  }
  for (const stage of ["Negotiating", "Active"]) {
    check(build(rec({ stage }), "not_interested", { reason: "Price too high" }), {
      fields: { stage: "Lost", next_step: "", next_due: "" },
      activity: { type: "Deal update", summaryStart: "Not interested: Price too high" },
    }, "not_interested on " + stage);
  }
  check(build(rec({ stage: "New", owner: ME }), "not_fit", { reason: "Off topic" }), {
    fields: { stage: "Lost", next_step: "", next_due: "" },
    activity: { type: "Note", summary: "Not a fit: Off topic" },
  }, "not_fit");
  check(buildOutcomeRequest(rec({ stage: "Contacted" }), "dnc", { reason: "Asked us to stop", me: ME, meta: metaDnc, today: TODAY }), {
    fields: { stage: "Do not contact", next_step: "", next_due: "" },
    activity: { type: "Note", summary: "Do not contact: Asked us to stop" },
  }, "dnc");
});

test("deal outcomes: approve, counter-offer, ask the client, signed", () => {
  const neg = { stage: "Negotiating", next_step: "Agree terms", deal_model: "Flat fee + commission", deal_flat: 350, deal_pct: 30 };
  check(build(rec(neg), "approve", { note: "Sending the agreement." }), {
    fields: { stage: undefined, next_step: "Send agreement and brief", next_due: DATES.w1 },
    activity: { type: "Deal update", summary: "Approved $350 + 30%. Sending the agreement." },
  }, "approve");
  check(build(rec(neg), "approve", {}), {
    fields: {}, activity: { type: "Deal update", summaryStart: "Approved $350 + 30%" },
  }, "approve without a note (F7)");
  check(build(rec({ stage: "Negotiating" }), "counter", { terms: { deal_model: "Flat fee", deal_flat: 400 }, note: "Their ask was $600." }), {
    fields: { stage: undefined, next_step: "Wait for their answer to the counter-offer", next_due: DATES.w3, deal_model: "Flat fee", deal_flat: "400" },
    activity: { type: "Deal update", summary: "Countered: $400. Their ask was $600." },
  }, "counter");
  check(build(rec({ stage: "Negotiating" }), "ask_client", { note: "Is $400 OK?" }), {
    fields: { next_step: "Waiting on client: Is $400 OK?", next_due: DATES.w3 },
    activity: { type: "Note", summary: "Asked client: Is $400 OK?" },
  }, "ask_client");
  check(build(rec({ stage: "Negotiating" }), "ask_client", {}), {
    fields: { next_step: "Waiting on client: decision on the offer", next_due: DATES.w3 },
    activity: { type: "Note", summaryStart: "Asked client:" },
  }, "ask_client without a note");
  check(build(rec({ stage: "Negotiating" }), "signed", { terms: { deal_model: "Flat fee + commission", deal_flat: 350, deal_pct: 30 }, note: NOTE }), {
    fields: { stage: "Active", next_step: "Check the placement is live", next_due: DATES.d14,
      deal_model: "Flat fee + commission", deal_flat: "350", deal_pct: "30" },
    activity: { type: "Deal update", summary: "Signed: $350 + 30%. " + NOTE },
  }, "signed with terms");
  check(build(rec({ stage: "Replied" }), "signed", {}), {
    fields: { stage: "Active", next_due: DATES.d14, deal_model: undefined, deal_flat: undefined, deal_pct: undefined },
    activity: { type: "Deal update" },
  }, "signed without terms");
});

test("Placement is live needs an http(s) link", () => {
  const link = "https://hub.example.test/best-hosting";
  check(build(rec({ stage: "Active", clients: "Ultahost, Soro" }), "live", { link }), {
    fields: { next_step: "Check results", next_due: DATES.d30, content_url: link, live_date: TODAY },
    activity: { type: "Content live", summary: link, client: "UltaHost" },
  }, "live");
  rejects(() => build(rec({ stage: "Active" }), "live", { link: "" }), "live without a link");
  rejects(() => build(rec({ stage: "Active" }), "live", { link: "ftp://hub.example.test/x" }), "live with an ftp link");
  rejects(() => build(rec({ stage: "Active" }), "live", { link: "hub.example.test/x y" }), "live with no scheme");
});

test("Had a call needs the note and uses the stage's default follow-up", () => {
  check(build(rec({ stage: "Replied" }), "called", { note: "Talked about the fee." }), {
    fields: { stage: undefined, next_due: DATES.w2 },
    activity: { type: "Call", summary: "Talked about the fee." },
  }, "called on Replied (follow_up_days 2: working days)");
  check(build(rec({ stage: "Active" }), "called", { note: "Checked the draft." }), {
    fields: { next_due: DATES.d14 }, activity: { type: "Call", summary: "Checked the draft." },
  }, "called on Active (follow_up_days 14)");
  rejects(() => build(rec({ stage: "Replied" }), "called", { note: "" }), "called without a note");
  rejects(() => build(rec({ stage: "Replied" }), "called", { note: "   " }), "called with a blank note");
});

test("Claim, Assign to client manager and Reopen", () => {
  check(build(rec({ stage: "New", owner: null, next_step: "" }), "claim", {}), {
    fields: { owner: ME, next_step: "Find the right contact and email", next_due: DATES.w2, stage: undefined },
    activity: null,
  }, "claim");
  check(build(rec({ stage: "New", owner: "", next_step: "Check the media kit" }), "claim", {}), {
    fields: { owner: ME, next_step: undefined, next_due: DATES.w2 }, activity: null,
  }, "claim keeps an existing next step");
  check(build(rec({ stage: "New", owner: null, clients: "Ultahost" }), "assign_manager", {}), {
    fields: { owner: "Kamile", stage: undefined }, activity: null,
  }, "assign_manager (UltaHost -> Kamile)");
  check(build(rec({ stage: "New", owner: null, clients: "Botanical Synthesis, Soro" }), "assign_manager", {}), {
    fields: { owner: "Eivyda" }, activity: null,
  }, "assign_manager uses the first client");
  check(build(rec({ stage: "Lost", next_step: "", next_due: null }), "reopen", { note: "They wrote again." }), {
    fields: { stage: "Contacted", next_step: "Follow up", next_due: DATES.d7 },
    activity: { type: "Note", summary: "Reopened. They wrote again." },
  }, "reopen");
});

test("the follow-up chip overrides the automatic date", () => {
  check(build(rec({ stage: "Replied" }), "interested", { note: NOTE, followUp: "2026-11-20" }), {
    fields: { stage: "Negotiating", next_step: "Agree terms", next_due: "2026-11-20" },
    activity: { type: "Email", summary: "Interested. " + NOTE },
  }, "interested with Pick date");
});

test("the activity client is the first client's canonical name", () => {
  const client = (clients) => build(rec({ stage: "Contacted", clients }), "followed_up", { note: NOTE }).activity.client || null;
  assert.equal(client("Soro"), "Soro");
  assert.equal(client("Ultahost, Soro"), "UltaHost");
  assert.equal(client("Weglot ,Soro"), "Weglot");
  assert.equal(client("MailerLite/MailerSend"), "MailerLite");
  assert.equal(client(""), null);
  assert.equal(client(null), null);
});

test("outcomes never change their input", () => {
  const r = rec({ stage: "Negotiating", deal_flat: 350 });
  const copy = structuredClone(r);
  build(r, "signed", { terms: { deal_model: "Flat fee", deal_flat: 500 }, note: NOTE });
  build(r, "ask_client", { note: NOTE });
  assert.deepEqual(r, copy);
});
