// Unit tests for js/rules/sites.js (spec 2.2.2, Appendix B.4). Owner F3.
// The records are the synthetic fixture (tests/fixtures/make-seed.mjs) turned into v2 rows the way
// lib/crm.js#v2Sql builds them (contacts, activity and open suggestions joined), then model.derive.
// Expected numbers are computed here from the raw fixture rows or read from fx.groups / fx.intended,
// so they are never written down twice.
import { test } from "node:test";
import assert from "node:assert/strict";
import { derive } from "../../crm/dashboard/js/core/model.js";
import {
  tabs, noReply, presets, cleanupCounts, siteView, isNoReply, inTab, ownerFilter, sortFor, baseSort, tabOf, hidesBig,
  TABS, TAB_IDS, SORT_CHOICES, defaultDir, sortLabel,
} from "../../crm/dashboard/js/rules/sites.js";
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

const fx = buildFixture({ today: TODAY });
const raws = v2Rows(fx);
const recs = raws.map((r) => derive(r, { meta, today: TODAY }));
const ids = (rows) => rows.map((r) => r.id);
const sorted = (a) => a.slice().sort();
const has = (v) => v != null && String(v).trim() !== "";
const platforms = new Set(fx.groups.platform);

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

// Independent reading of B.1 rule 6 from the raw columns (no model.js).
function rawNoReply(p) {
  if (p.stage !== "Contacted") return false;
  if (p.next_due && p.next_due > TODAY) return false;
  const days = [p.last_touch, p.last_email, p.act_at, p.updated_at].filter(Boolean).map((v) => String(v).slice(0, 10)).sort();
  if (!days.length) return true;
  const last = days[days.length - 1];
  const ms = Date.parse(TODAY + "T00:00:00Z") - Date.parse(last + "T00:00:00Z");
  return ms / 86400000 > 14;
}

// ---------- tabs ----------

test("tabs: B.4 predicates on the fixture, big sites hidden except on Waiting for reply", () => {
  const t = tabs(recs, { meta, me: "Kamile" });
  assert.deepEqual(sorted(ids(t.mine)), sorted(fx.groups["kamile-new"]), "Mine to contact = Kamile's 30 New rows");
  assert.equal(t.mine.length, fx.counts.owner_stage.Kamile.New);
  const unowned = raws.filter((p) => ["New", "Researching"].includes(p.stage) && !has(p.owner));
  assert.equal(unowned.length, fx.counts.owner_stage["(none)"].New + fx.counts.owner_stage["(none)"].Researching);
  assert.deepEqual(sorted(ids(t.unowned)), sorted(unowned.filter((p) => !platforms.has(p.id)).map((p) => p.id)), "Unowned leaves out the platform rows");
  assert.equal(t.waiting.length, fx.counts.by_stage.Contacted, "Waiting for reply = every Contacted row");
  assert.equal(t.all.length, fx.counts.partners - platforms.size, "All leaves out the 10 platform rows");
  assert.ok(t.all.some((r) => r.id === fx.groups.channel[0]), "a creator channel path is never a big site (D7)");

  const big = tabs(recs, { meta, me: "Kamile", big: true });
  assert.equal(big.all.length, fx.counts.partners, "with big=1 All has every site");
  assert.deepEqual(sorted(ids(big.unowned)), sorted(unowned.map((p) => p.id)));

  const jonas = tabs(recs, { meta, me: "Jonas" });
  const jonasNew = raws.filter((p) => p.owner === "Jonas" && ["New", "Researching"].includes(p.stage));
  assert.equal(jonas.mine.length, jonasNew.length - jonasNew.filter((p) => platforms.has(p.id)).length, "Jonas's 2 platform rows are hidden");
  assert.ok(jonasNew.some((p) => platforms.has(p.id)), "the fixture gives Jonas platform rows");

  const nobody = tabs(recs, { meta, me: null });
  assert.equal(nobody.mine.length, 0, "without a name, Mine to contact is empty");
  assert.equal(tabs(null, { meta }).all.length, 0);
});

test("inTab, tabOf, hidesBig and the tab list", () => {
  assert.deepEqual(TABS.map((t) => t.id), TAB_IDS);
  assert.deepEqual(TABS.map((t) => t.label), ["Mine to contact", "Unowned", "Waiting for reply", "All"]);
  assert.equal(tabOf(undefined), "all", "#sites with no tab shows All (2.4)");
  assert.equal(tabOf("nope"), "all");
  assert.equal(tabOf("waiting"), "waiting");
  assert.equal(hidesBig("waiting"), false);
  assert.equal(hidesBig("mine"), true);
  assert.equal(hidesBig("all"), true);
  const r = rec({ stage: "Researching", owner: "kamile" });
  assert.equal(inTab(r, "mine", { me: "Kamile" }), true, "owner match ignores case");
  assert.equal(inTab(r, "unowned", { me: "Kamile" }), false);
  assert.equal(inTab(rec({ stage: "New", owner: null }), "unowned", {}), true);
  assert.equal(inTab(rec({ stage: "Contacted" }), "waiting", {}), true);
  assert.equal(inTab(rec({ stage: "Lost" }), "all", {}), true);
});

// ---------- quiet=14 ----------

test("noReply (quiet=14) = B.1 rule 6 without the cap, oldest first, undated last", () => {
  const all = noReply(recs, { meta, today: TODAY });
  assert.deepEqual(sorted(ids(all)), sorted(raws.filter(rawNoReply).map((p) => p.id)), "same set as the raw reading of rule 6");
  const kamile = noReply(recs.filter((r) => r.owner === "Kamile"), { meta, today: TODAY });
  const want = fx.intended.Kamile.doNow.noreply;
  assert.equal(kamile.length, want.candidates, "no cap: every candidate, not " + want.count);
  assert.ok(kamile.length > (meta.noreply_cap || 10));
  assert.deepEqual(ids(kamile), want.dated.concat(want.undated), "dated (oldest first), then undated");
  for (let i = 1; i < all.length; i++) {
    const a = all[i - 1].lastActivity, b = all[i].lastActivity;
    if (a && b) assert.ok(a <= b, "oldest first");
    if (!a) assert.ok(!b, "undated last");
  }
});

test("isNoReply edge cases: the SLA boundary, snoozed, undated, other stages, activity sources", () => {
  const o = { meta, today: TODAY };
  assert.equal(isNoReply(rec({ last_touch: addDays(TODAY, -14) }), o), false, "14 days quiet is not over the SLA");
  assert.equal(isNoReply(rec({ last_touch: addDays(TODAY, -15) }), o), true, "15 days is");
  assert.equal(isNoReply(rec({}), o), true, "no activity date at all counts");
  assert.equal(isNoReply(rec({ next_due: addDays(TODAY, 1) }), o), false, "a future follow-up date (snoozed) is left out");
  assert.equal(isNoReply(rec({ next_due: TODAY }), o), true, "due today is not snoozed");
  assert.equal(isNoReply(rec({ next_due: addDays(TODAY, -3), last_touch: addDays(TODAY, -40) }), o), true, "overdue still counts");
  assert.equal(isNoReply(rec({ stage: "Replied" }), o), false, "only Contacted");
  assert.equal(isNoReply(rec({ last_touch: addDays(TODAY, -40), act_at: addDays(TODAY, -2) }), o), false, "a recent activity row resets it");
  assert.equal(isNoReply(rec({ last_touch: addDays(TODAY, -40), updated_at: addDays(TODAY, -1) + "T10:00:00Z" }), o), false, "a site edit counts as activity");
  const m2 = Object.assign({}, meta, { sla: Object.assign({}, meta.sla, { Contacted: 7 }) });
  assert.equal(isNoReply(rec({ last_touch: addDays(TODAY, -8) }), { meta: m2, today: TODAY }), true, "the threshold is meta.sla.Contacted");
  // The rule reads `today` itself (a record derived yesterday is judged against the day passed in).
  const old = rec({ last_touch: addDays(TODAY, -14) }, addDays(TODAY, -1));
  assert.equal(isNoReply(old, { meta, today: TODAY }), false);
  assert.equal(isNoReply(old, { meta, today: addDays(TODAY, 1) }), true);
});

// ---------- owner, presets, sort ----------

test("ownerFilter: Waiting for reply defaults to me, owner=all shows everyone, Mine and Unowned ignore it", () => {
  assert.equal(ownerFilter("waiting", undefined), "me");
  assert.equal(ownerFilter("waiting", ""), "me");
  assert.equal(ownerFilter("waiting", "all"), null);
  assert.equal(ownerFilter("waiting", "Gaby"), "Gaby");
  assert.equal(ownerFilter("waiting", "none"), "none");
  assert.equal(ownerFilter("all", undefined), null);
  assert.equal(ownerFilter("all", "all"), null);
  assert.equal(ownerFilter("all", "me"), "me");
  assert.equal(ownerFilter("mine", "Gaby"), null);
  assert.equal(ownerFilter("unowned", "Gaby"), null);
});

test("presets: Recently active sorts, Replied no date and Has a suggestion filter", () => {
  assert.deepEqual(Object.keys(presets).sort(), ["activity", "replied_nodate", "sugg"]);
  assert.equal(presets.activity.label, "Recently active");
  assert.equal(presets.replied_nodate.label, "Replied, no date");
  assert.equal(presets.sugg.label, "Has a suggestion");
  assert.deepEqual(sortFor({ preset: "activity" }), { key: "last_activity", dir: "desc" });
  const nodate = recs.filter(presets.replied_nodate.test);
  const rawNodate = raws.filter((p) => p.stage === "Replied" && !p.last_touch && !(Number(p.replied_contact) > 0 && p.last_email));
  assert.deepEqual(sorted(ids(nodate)), sorted(rawNodate.map((p) => p.id)));
  assert.ok(fx.groups["replied-nodate"].every((id) => nodate.some((r) => r.id === id)), "the 120 fixture rows with no date are in it");
  const sugg = recs.filter(presets.sugg.test);
  const open = new Set(fx.suggestions.filter((s) => s.status === "open" && (s.kind === "candidate" || s.kind === "email")).map((s) => s.account_id));
  assert.deepEqual(sorted(ids(sugg)), sorted(Array.from(open)));
});

test("sortFor: the URL's sort wins, then the preset, then quiet, then newest first", () => {
  assert.deepEqual(sortFor({}), { key: "newest", dir: "desc" }, "default: newest first (2.2.2)");
  assert.deepEqual(sortFor({ quiet: "14" }), { key: "last_activity", dir: "asc" }, "quiet: oldest activity first");
  assert.deepEqual(sortFor({ sort: "dr" }), { key: "dr", dir: "desc" }, "numbers start high");
  assert.deepEqual(sortFor({ sort: "site" }), { key: "site", dir: "asc" });
  assert.deepEqual(sortFor({ sort: "dr", dir: "asc", preset: "activity" }), { key: "dr", dir: "asc" });
  assert.deepEqual(sortFor({ sort: "next", dir: "bogus" }), { key: "next", dir: "asc" });
  assert.deepEqual(baseSort({ preset: "activity", quiet: "14" }), { key: "last_activity", dir: "desc" });
  assert.equal(defaultDir("traffic"), "desc");
  assert.ok(SORT_CHOICES.some((c) => c.key === "newest" && c.dir === "desc"));
  for (const k of ["site", "dr", "traffic", "last_activity", "next"]) assert.ok(SORT_CHOICES.some((c) => c.key === k), "sort by " + k);
});

test("sortLabel: every sort says what comes first, short enough for the phone Sort menu", () => {
  assert.equal(sortLabel("newest", "desc"), "Newest first");
  assert.equal(sortLabel("last_activity", "asc"), "Quietest first", "the No reply in 14+ days order");
  assert.equal(sortLabel("last_activity", "desc"), "Recently active first", "the Recently active preset");
  assert.equal(sortLabel("dr", "desc"), "Highest DR first");
  assert.equal(sortLabel("owner", "desc"), "Owner (Z–A)", "a header sort that isn't in the menu");
  assert.equal(sortLabel("country", "asc"), "Country (A–Z)", "an unknown key still gets words");
  for (const key of ["newest", "site", "stage", "owner", "clients", "dr", "traffic", "last_activity", "next"]) {
    for (const dir of ["asc", "desc"]) {
      const l = sortLabel(key, dir);
      assert.ok(l.length <= 22, key + " " + dir + ": " + l);
      assert.ok(!/record|sync|outcome/i.test(l), l);
    }
  }
  assert.equal(new Set(SORT_CHOICES.map((c) => c.label)).size, SORT_CHOICES.length, "menu labels are distinct");
});

// ---------- siteView ----------

test("siteView: rows and tab counts in one pass, equal to tabs() without filters", () => {
  const o = { meta, today: TODAY, me: "Kamile" };
  const t = tabs(recs, { meta, me: "Kamile" });
  for (const tab of TAB_IDS) {
    const v = siteView(recs, Object.assign({ tab, owner: tab === "waiting" ? "all" : undefined }, o));
    assert.deepEqual(ids(v.rows), ids(t[tab]), tab + " rows");
  }
  const v = siteView(recs, Object.assign({ tab: "all" }, o));
  assert.equal(v.counts.mine, t.mine.length);
  assert.equal(v.counts.unowned, t.unowned.length);
  assert.equal(v.counts.all, t.all.length);
  const kamileWaiting = recs.filter((r) => r.stage === "Contacted" && r.owner === "Kamile").length;
  assert.equal(v.counts.waiting, kamileWaiting, "Waiting for reply counts Kamile's by default");
  assert.equal(v.quiet, fx.intended.Kamile.doNow.noreply.candidates, "No reply in 14+ days (N) for Kamile");
});

test("siteView: owner, stage, preset, quiet and big apply to the tabs they belong to", () => {
  const o = { meta, today: TODAY, me: "Kamile" };
  const waitAll = siteView(recs, Object.assign({ tab: "waiting", owner: "all" }, o));
  assert.equal(waitAll.rows.length, fx.counts.by_stage.Contacted);
  assert.equal(waitAll.quiet, noReply(recs, o).length);
  const quiet = siteView(recs, Object.assign({ tab: "waiting", owner: "all", quiet: "14" }, o));
  assert.equal(quiet.rows.length, waitAll.quiet, "quiet on: the tab shows the no-reply rows");
  assert.equal(quiet.counts.waiting, waitAll.quiet, "and its count follows");
  assert.equal(quiet.counts.all, waitAll.counts.all, "quiet doesn't change the other tabs");
  const gaby = siteView(recs, Object.assign({ tab: "all", owner: "Gaby" }, o));
  assert.equal(gaby.rows.length, fx.counts.by_owner.Gaby);
  assert.equal(gaby.counts.mine, waitAll.counts.mine, "Mine ignores the owner filter");
  assert.equal(gaby.counts.unowned, waitAll.counts.unowned, "Unowned ignores the owner filter");
  assert.equal(gaby.counts.waiting, fx.counts.owner_stage.Gaby.Contacted, "Waiting for reply uses a named owner");
  const none = siteView(recs, Object.assign({ tab: "all", owner: "none" }, o));
  assert.equal(none.rows.length, fx.counts.by_owner["(none)"] - fx.groups.platform.filter((id) => !raws.find((p) => p.id === id).owner).length);
  const lost = siteView(recs, Object.assign({ tab: "all", stage: "Lost" }, o));
  assert.equal(lost.rows.length, fx.counts.by_stage.Lost);
  const plain = siteView(recs, Object.assign({ tab: "all" }, o));
  assert.equal(lost.counts.waiting, plain.counts.waiting, "stage applies to All only");
  assert.equal(lost.counts.mine, plain.counts.mine);
  assert.equal(siteView(recs, Object.assign({ tab: "mine", stage: "Lost" }, o)).rows.length, fx.counts.owner_stage.Kamile.New);
  const pre = siteView(recs, Object.assign({ tab: "all", preset: "replied_nodate" }, o));
  assert.equal(pre.rows.length, recs.filter((r) => presets.replied_nodate.test(r) && !r.isPlatform).length);
  assert.equal(pre.counts.mine, waitAll.counts.mine, "presets apply to All only");
  const big = siteView(recs, Object.assign({ tab: "all", big: true }, o));
  assert.equal(big.rows.length, fx.counts.partners);
  const noMe = siteView(recs, { meta, today: TODAY, me: null, tab: "waiting" });
  assert.equal(noMe.rows.length, 0, "without a name the default owner (me) matches nothing");
});

// ---------- clean-up counts ----------

test("cleanupCounts: replied with no date, old touch, no owner, odd client tokens, type not set", () => {
  const c = cleanupCounts(recs, { meta, today: TODAY });
  const rawReplied = raws.filter((p) => p.stage === "Replied");
  assert.equal(c.repliedNoDate, rawReplied.filter((p) => !p.last_touch && !(Number(p.replied_contact) > 0 && p.last_email)).length);
  assert.ok(c.repliedNoDate >= fx.groups["replied-nodate"].length);
  const over30 = (d) => d && (Date.parse(TODAY) - Date.parse(String(d).slice(0, 10))) / 86400000 > 30;
  assert.equal(c.repliedOldTouch, rawReplied.filter((p) => over30(p.last_touch)).length);
  assert.equal(c.noOwner, raws.filter((p) => !has(p.owner) && !["Lost", "Do not contact"].includes(p.stage)).length);
  assert.equal(c.noType, raws.filter((p) => !has(p.type) || /^uncategori[sz]ed$/i.test(p.type)).length);
  const tok = Object.fromEntries(c.clientTokens.map((t) => [t.raw, t]));
  assert.equal(tok.Ultahost.name, "UltaHost", "Ultahost is not the canonical spelling");
  assert.equal(tok.soro.name, "Soro");
  assert.ok(!tok.UltaHost, "the canonical spelling is fine");
  assert.ok(!tok["Melograno - Trafft"], "a Melograno product token is canonical");
  assert.ok(!tok.Weglot, "a past client's name is canonical");
  const odd = raws.filter((p) => String(p.clients || "").split(/\s*[,/]\s*/).some((t) => t === "Ultahost" || t === "soro"));
  assert.ok(c.oddClients >= odd.length && odd.length > 0);
  for (let i = 1; i < c.clientTokens.length; i++) assert.ok(c.clientTokens[i - 1].n >= c.clientTokens[i].n, "most frequent first");
  const unknown = cleanupCounts([rec({ clients: "Acme Corp" })], { meta, today: TODAY });
  assert.deepEqual(unknown.clientTokens, [{ raw: "Acme Corp", name: "", n: 1 }], "an unknown client token is listed with no name");
  const empty = cleanupCounts([], { meta, today: TODAY });
  assert.deepEqual(empty, { repliedNoDate: 0, repliedOldTouch: 0, noOwner: 0, oddClients: 0, noType: 0, clientTokens: [] });
});

test("the rules are pure: same input, same output, records untouched", () => {
  const before = JSON.stringify(recs.slice(0, 50));
  const a = siteView(recs, { meta, today: TODAY, me: "Kamile", tab: "waiting", quiet: "14" });
  const b = siteView(recs, { meta, today: TODAY, me: "Kamile", tab: "waiting", quiet: "14" });
  assert.deepEqual(ids(a.rows), ids(b.rows));
  noReply(recs, { meta, today: TODAY });
  cleanupCounts(recs, { meta, today: TODAY });
  assert.equal(JSON.stringify(recs.slice(0, 50)), before);
});

test("siteView stays fast on 7,500 sites", () => {
  const many = [];
  for (let i = 0; i < 7500; i++) {
    const r = recs[i % recs.length];
    many.push(Object.assign({}, r, { id: "PG-" + String(10000 + i) }));
  }
  const o = { meta, today: TODAY, me: "Kamile" };
  siteView(many, Object.assign({ tab: "all" }, o)); // warm up
  const t0 = performance.now();
  for (const tab of TAB_IDS) siteView(many, Object.assign({ tab, quiet: tab === "waiting" ? "14" : undefined }, o));
  const ms = (performance.now() - t0) / TAB_IDS.length;
  assert.ok(ms < 25, "one siteView pass over 7,500 sites took " + ms.toFixed(1) + " ms");
});
