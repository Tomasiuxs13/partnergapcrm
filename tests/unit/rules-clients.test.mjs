// Unit tests for js/rules/clients.js (spec 2.2.4, Appendix B.6). Owner F5.
// The records are the synthetic fixture (tests/fixtures/make-seed.mjs) turned into v2 rows the way
// lib/crm.js#v2Sql builds them, then model.derive. Expected numbers are counted from the records with a
// plain filter, so they are never written down twice.
import { test } from "node:test";
import assert from "node:assert/strict";
import { derive } from "../../crm/dashboard/js/core/model.js";
import {
  clientOf, productOf, clientToken, clientParam, sitesFor, clientMetrics, rateText, clientRows, pastClientRows, clientTotals,
  waitingList, dealList, liveList, bestProspects, pipelineRows, safeName, clientTerms, waitingCopyText, reportMonths,
  defaultMonth, monthLabel, buildReport, reportText, TERMS_NONE,
} from "../../crm/dashboard/js/rules/clients.js";
import { buildFixture, fixtureMeta } from "../fixtures/make-seed.mjs";

const TODAY = "2026-10-20";
const meta = fixtureMeta();
const TEAM = ["Jonas", "Vik", "Kamile", "Eivyda", "Monica", "Mantvydas", "Gaby", "Sandra", "Tomas", "Denisse", "Egle", "Jay"];

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
    const contactLabel = cs.map((c) => [c.first_name, c.last_name].filter(Boolean).join(" ") || (c.email || "").split("@")[0]).find(Boolean);
    return Object.assign({}, p, {
      label: p.name || p.domain || contactLabel || "Unnamed creator",
      last_email: max(cs, "last_email"),
      replied_contact: cs.length ? Math.max(...cs.map((c) => Number(c.replied) || 0)) : null,
      act_at: max(acts.get(p.id) || [], "date"),
      sugg: null,
    });
  });
}

function records(today = TODAY) {
  const fx = buildFixture({ today });
  return { fx, recs: v2Rows(fx).map((r) => derive(r, { meta, today })) };
}

const { fx, recs } = records();
const byId = new Map(recs.map((r) => [r.id, r]));
const one = (tag) => byId.get(fx.groups[tag][0]);
const ids = (rows) => rows.map((r) => r.id).sort();
const ofClient = (k) => recs.filter((r) => (r.ck || []).includes(k));

function rec(over = {}) {
  return derive(Object.assign({
    id: "PG-09001", domain: "edge.example.test", name: "Edge Case", label: "Edge Case", type: null, dr: 30, traffic: null,
    owner: "Kamile", stage: "Negotiating", last_touch: "2026-10-01", clients: "Soro", country: null, contacts: 1, next_step: null,
    next_due: null, deal_model: null, deal_flat: null, deal_pct: null, deal_value: null, live_date: null, content_url: null,
    tracking_id: null, source: null, updated_at: null, updated_by: null, last_email: null, replied_contact: null, act_at: null,
    sugg: null, notes: null,
  }, over), { meta, today: TODAY });
}

test("clientOf finds a client by stored key, slug, name or alias; past clients are marked", () => {
  assert.equal(clientOf(meta, "soro").name, "Soro");
  assert.equal(clientOf(meta, "Soro").k, "soro");
  const bs = clientOf(meta, "botanical-synthesis");
  assert.equal(bs.k, "botanical synthesis", "the stored key keeps its space");
  assert.equal(bs.slug, "botanical-synthesis");
  assert.equal(clientOf(meta, "Botanical Synthesis").k, "botanical synthesis");
  assert.equal(clientOf(meta, "Ultahost").k, clientOf(meta, "UltaHost").k);
  assert.equal(clientOf(meta, "Melograno - Amelia").k, "melograno");
  assert.equal(clientOf(meta, "weglot").past, true);
  assert.equal(clientOf(meta, "soro").past, false);
  assert.equal(clientOf(meta, "nobody-here"), null);
  assert.equal(clientOf(meta, ""), null);
  assert.equal(clientOf(meta, { k: "soro" }).name, "Soro");
});

test("products, tokens and the Sites filter value", () => {
  const mel = clientOf(meta, "melograno");
  assert.ok(mel.products.length >= 4, "Melograno lists its products");
  assert.equal(productOf(mel, "amelia"), "Amelia");
  assert.equal(productOf(mel, "nope"), null);
  assert.equal(productOf(clientOf(meta, "soro"), "Amelia"), null);
  assert.equal(clientToken(mel, "Amelia"), "Melograno - Amelia");
  assert.equal(clientToken(mel, null), "Melograno");
  assert.equal(clientParam(mel, "wpDataTables"), "melograno-wpdatatables");
  assert.equal(clientParam(clientOf(meta, "botanical synthesis")), "botanical-synthesis");
});

test("client metrics follow B.6 and count both spellings of a client (D8)", () => {
  for (const k of ["soro", "ultahost", "transfergo", "melograno"]) {
    const c = clientOf(meta, k);
    if (!c) continue;
    const mine = ofClient(c.k);
    const st = (s) => mine.filter((r) => r.stage === s).length;
    const m = clientMetrics(recs, { meta, client: k });
    assert.equal(m.sites, mine.length, k + " sites");
    assert.equal(m.prospects, st("New") + st("Researching"), k + " prospects");
    assert.equal(m.emailed, st("Contacted"), k + " emailed");
    assert.equal(m.replied, st("Replied"), k + " replied");
    assert.equal(m.inTalks, st("Negotiating"), k + " in talks");
    assert.equal(m.active, st("Active"), k + " active");
    assert.equal(m.live, mine.filter((r) => r.stage === "Active" && r.content_url).length, k + " live");
    const contacted = mine.filter((r) => r.stage && !["New", "Researching"].includes(r.stage)).length;
    const wrote = st("Replied") + st("Negotiating") + st("Active") + st("Lost");
    assert.equal(m.contacted, contacted);
    assert.equal(m.wroteBack, wrote);
    assert.equal(m.replyRate, contacted ? wrote / contacted : null);
  }
  const u = sitesFor(recs, { meta, client: "Ultahost" });
  assert.ok(u.some((r) => r.clients === "UltaHost"), "UltaHost spelling counts");
  assert.ok(u.some((r) => r.clients === "Ultahost"), "Ultahost spelling counts");
  assert.ok(clientMetrics(recs, { meta, client: "soro" }).inTalks >= 4);
});

test("Melograno counts every product, or only the picked one", () => {
  const all = sitesFor(recs, { meta, client: "melograno" });
  const trafft = sitesFor(recs, { meta, client: "melograno", product: "Trafft" });
  const wpdt = sitesFor(recs, { meta, client: "melograno", product: "wpdatatables" });
  const amelia = sitesFor(recs, { meta, client: "melograno", product: "Amelia" });
  assert.ok(trafft.length > 0 && wpdt.length > 0);
  assert.equal(amelia.length, 0);
  assert.ok(trafft.every((r) => /trafft/i.test(r.clients)));
  assert.equal(all.length, new Set([...trafft, ...wpdt].map((r) => r.id)).size);
  const p = pipelineRows(recs, { meta, client: "melograno", product: "Trafft" });
  assert.equal(p.reduce((s, x) => s + x.n, 0), trafft.length);
});

test("Clients list rows, past clients and the totals row (each site once)", () => {
  const rows = clientRows(recs, { meta });
  assert.deepEqual(rows.map((r) => r.client.k), meta.clients.map((c) => c.k));
  const past = pastClientRows(recs, { meta });
  assert.deepEqual(past.map((r) => r.client.name), ["Weglot", "Termly"]);
  assert.ok(past.every((r) => r.client.past && r.metrics.sites > 0));
  const keys = new Set(meta.clients.map((c) => c.k));
  const any = recs.filter((r) => (r.ck || []).some((k) => keys.has(k)));
  const tot = clientTotals(recs, { meta });
  assert.equal(tot.clients, meta.clients.length);
  assert.equal(tot.metrics.sites, any.length);
  assert.ok(tot.metrics.sites <= rows.reduce((s, r) => s + r.metrics.sites, 0));
  assert.equal(tot.metrics.inTalks, any.filter((r) => r.stage === "Negotiating").length);
});

test("client page sections: waiting, deals, live, best prospects", () => {
  const o = { meta, client: "soro" };
  const wait = waitingList(recs, o);
  assert.ok(wait.length >= 1);
  assert.ok(wait.every((r) => r.waitingOnClient && !["Lost", "Do not contact"].includes(r.stage)));
  const want = fx.groups["waiting-on-client"].map((id) => byId.get(id)).filter((r) => r.ck.includes("soro")).map((r) => r.id).sort();
  assert.deepEqual(ids(wait), want);

  const deals = dealList(recs, o);
  const firstActive = deals.findIndex((r) => r.stage === "Active");
  assert.ok(firstActive > 0, "Negotiating first, then Active");
  assert.ok(deals.slice(firstActive).every((r) => r.stage === "Active"));
  assert.ok(deals.some((r) => r.id === one("internal-marker").id));

  const live = liveList(recs, o);
  assert.ok(live.every((r) => r.stage === "Active" && r.content_url));
  for (const id of fx.groups["soro-live-last-month"]) assert.ok(live.some((r) => r.id === id));
  const dated = live.filter((r) => r.live_date).map((r) => r.live_date);
  assert.deepEqual(dated, dated.slice().sort().reverse(), "newest live date first");

  const best = bestProspects(recs, o);
  assert.ok(best.rows.length <= 10);
  assert.ok(best.rows.every((r) => r.notContacted && !r.isPlatform));
  assert.ok(!best.rows.some((r) => fx.groups.platform.includes(r.id)), "big sites are left out");
  const good = (r) => r.dr != null && r.dr >= 20 && r.dr <= 80;
  const firstBad = best.rows.findIndex((r) => !good(r));
  if (firstBad >= 0) assert.ok(best.rows.slice(firstBad).every((r) => !good(r)), "DR 20–80 first");
  assert.equal(best.total, sitesFor(recs, o).filter((r) => r.notContacted && !r.isPlatform).length);
});

test("pipeline rows follow the stage order and add up to the client's sites", () => {
  const rows = pipelineRows(recs, { meta, client: "soro" });
  assert.deepEqual(rows.map((r) => r.stage).slice(0, 7), ["New", "Researching", "Contacted", "Replied", "Negotiating", "Active", "Lost"]);
  assert.equal(rows.reduce((s, r) => s + r.n, 0), clientMetrics(recs, { meta, client: "soro" }).sites);
  assert.ok(rows.every((r) => r.color));
});

test("client-safe names and terms", () => {
  assert.equal(safeName(rec({ name: "Nice Blog" })), "Nice Blog");
  assert.equal(safeName(rec({ name: null })), "edge.example.test");
  assert.equal(safeName(rec({ name: null, domain: null, label: "Ana Petrova" })), "Unnamed creator", "never a contact name");
  assert.equal(safeName(rec({ name: "Ask ana@edge.example.test" })), "Ask (email hidden)");
  assert.equal(clientTerms(rec({ deal_model: "Flat fee + commission", deal_flat: 350, deal_pct: 30 })), "Flat fee + commission · $350 + 30%");
  assert.equal(clientTerms(rec({ deal_value: 800 })), "", "a deal value alone is not terms");
});

test("Copy list for client is client-safe", () => {
  const c = clientOf(meta, "soro");
  const list = waitingList(recs, { meta, client: "soro" });
  const text = waitingCopyText(list, { client: c, today: TODAY });
  assert.match(text, /^Waiting on Soro \(20 Oct 2026\)/);
  for (const r of list) {
    assert.ok(text.includes(safeName(r)));
    assert.ok(text.includes(r.nextText), "the text after “Waiting on client:”");
    assert.ok(!text.includes(r.id));
  }
  assert.ok(!/Waiting on client:/i.test(text));
  for (const n of TEAM) assert.ok(!new RegExp("\\b" + n + "\\b").test(text), "no owner " + n);
  assert.ok(!/@/.test(text));
  const leaky = rec({ next_step: "Waiting on client: mail bob@soro.example.test", deal_model: "Flat fee", deal_flat: 100 });
  const t2 = waitingCopyText([leaky], { client: c, today: TODAY });
  assert.ok(!/@/.test(t2) && /email hidden/.test(t2));
});

test("report months: this month and the 5 before, last month by default", () => {
  assert.deepEqual(reportMonths(TODAY), ["2026-10", "2026-09", "2026-08", "2026-07", "2026-06", "2026-05"]);
  assert.equal(defaultMonth(TODAY), "2026-09");
  assert.equal(defaultMonth("2027-01-05"), "2026-12");
  assert.deepEqual(reportMonths("2027-02-01").slice(0, 3), ["2027-02", "2027-01", "2026-12"]);
  assert.equal(monthLabel("2026-09"), "September 2026");
  assert.equal(monthLabel("bad"), "");
  assert.equal(rateText(null), "–");
  assert.equal(rateText(59 / 77), "77%");
});

test("Soro's report for last month: placements, deals, warnings (T19)", () => {
  const r = buildReport(recs, { meta, client: "soro", today: TODAY });
  assert.equal(r.month, "2026-09");
  assert.equal(r.monthLabel, "September 2026");
  assert.equal(r.title, "Soro affiliate report, September 2026");
  const lastMonth = fx.groups["soro-live-last-month"].map((id) => byId.get(id));
  assert.deepEqual(r.live.map((x) => x.name).sort(), lastMonth.map((x) => x.name).sort());
  assert.ok(r.live.every((x) => /^https?:\/\//.test(x.url) && x.date.startsWith("2026-09")));
  const future = one("active-future-live");
  assert.ok(!r.live.some((x) => x.name === future.name), "a live date after today is left out");
  assert.ok(r.warnings.some((w) => /live date after today/.test(w)), "future live date warning");
  const soro = sitesFor(recs, { meta, client: "soro" });
  assert.equal(r.inTalks.length, soro.filter((x) => x.stage === "Negotiating").length);
  const marker = one("internal-marker");
  const mrow = r.inTalks.find((x) => x.name === marker.name);
  assert.ok(mrow, "the marker deal is listed by name");
  assert.equal(mrow.terms, "");
  assert.ok(r.text.includes(marker.name + ": " + TERMS_NONE));
  assert.ok(r.warnings.some((w) => /no terms yet/.test(w)));
  assert.equal(r.activeCount, soro.filter((x) => x.stage === "Active").length);
  assert.equal(r.contacted, soro.filter((x) => x.stage && !["New", "Researching"].includes(x.stage) && String(x.last_touch || "").startsWith("2026-09")).length);
  assert.ok(r.replies >= 0);
  assert.equal(reportText(r), r.text);
});

test("the report never holds next steps, notes, emails, ids or owner names (marker test)", () => {
  const extra = [
    rec({ id: "PG-09002", name: null, domain: null, label: "Contact Person", stage: "Negotiating", notes: "secret INTERNAL-MARKER-7" }),
    rec({ id: "NEW-00009", name: "Mail me at owner@soro.example.test", stage: "Active", live_date: "2026-09-12",
      content_url: "mailto:owner@soro.example.test", next_step: "INTERNAL-MARKER-7 call Jonas" }),
  ];
  const all = recs.concat(extra);
  for (const month of reportMonths(TODAY)) {
    for (const product of [null, "Trafft"]) {
      const client = product ? "melograno" : "soro";
      const r = buildReport(all, { meta, client, product, month, today: TODAY });
      const blob = JSON.stringify(r);
      assert.ok(!blob.includes("INTERNAL-MARKER-7"), month + " marker");
      assert.ok(!/\b(PG|NEW)-\d+/.test(blob), month + " ids");
      assert.ok(!/@/.test(blob), month + " emails");
      for (const n of TEAM) assert.ok(!new RegExp("\\b" + n + "\\b").test(blob), month + " owner " + n);
    }
  }
  const sep = buildReport(all, { meta, client: "soro", month: "2026-09", today: TODAY });
  assert.ok(sep.inTalks.some((x) => x.name === "Unnamed creator"));
  assert.ok(sep.warnings.some((w) => /Unnamed creator/.test(w)));
  const odd = sep.live.find((x) => /email hidden/.test(x.name));
  assert.ok(odd && odd.url === "", "a mailto link is not shown");
  assert.ok(sep.warnings.some((w) => /no web link/.test(w)));
});

test("a month with nothing live says so; an unknown client gives null", () => {
  const r = buildReport(recs, { meta, client: "soro", month: "2026-05", today: TODAY });
  assert.equal(r.live.length, 0);
  assert.match(r.text, /None went live in May 2026\./);
  assert.equal(buildReport(recs, { meta, client: "nobody", today: TODAY }), null);
});

test("client rows for the whole fixture are fast", () => {
  const t0 = performance.now();
  for (let i = 0; i < 5; i++) clientRows(recs, { meta });
  assert.ok((performance.now() - t0) / 5 < 50);
});
