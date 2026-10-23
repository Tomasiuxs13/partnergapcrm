// Unit tests for js/rules/partners.js (Tomas, 2026-10-23): which sites work with which clients, the
// Partners page rows and a client page's suggested partners. Small hand-made sites, so each case says
// exactly what it checks; meta is the fixture's with categories added.
import { test } from "node:test";
import assert from "node:assert/strict";
import { derive } from "../../crm/dashboard/js/core/model.js";
import { siteLinks, partnerRows, partnerCounts, sameCategory, suggestedPartners, viaText, IMPORT_SOURCE } from "../../crm/dashboard/js/rules/partners.js";
import { fixtureMeta } from "../fixtures/make-seed.mjs";
import { CLIENT_CATEGORIES } from "../../lib/meta.js";

const TODAY = "2026-10-23";
const CAT = { soro: "Software & SaaS", mailerlite: "Software & SaaS", mailersend: "Software & SaaS", ultahost: "Software & SaaS", transfergo: "Finance & money" };
const base = fixtureMeta();
const meta = Object.assign({}, base, {
  clients: base.clients.map((c) => Object.assign({}, c, CAT[c.k] ? { category: CAT[c.k] } : {})),
  past_clients: base.past_clients.map((c) => Object.assign({}, c, c.k === "weglot" ? { category: "Software & SaaS" } : {})),
});

let n = 0;
function site(fields) {
  n += 1;
  const id = fields.id || "PG-" + String(90000 + n);
  return derive(Object.assign({ id, domain: id.toLowerCase() + ".test", name: "Site " + id, stage: "New", clients: "", source: "Ahrefs", dr: 30 }, fields, { id }), { meta, today: TODAY });
}

const deal = (id, account, client, stage, extra = {}) => Object.assign({ id, account_id: account, client, stage }, extra);

test("the categories in lib/meta.js are the ones Help › Settings offers", () => {
  assert.ok(CLIENT_CATEGORIES.includes("Software & SaaS"));
  assert.ok(CLIENT_CATEGORIES.includes("Other"));
  assert.equal(new Set(CLIENT_CATEGORIES).size, CLIENT_CATEGORIES.length);
});

test("siteLinks: a signed or live deal is a partner, Negotiating is in talks, Lost is nothing", () => {
  const r = site({ stage: "Active", clients: "Soro, MailerLite, Fiverr" });
  const links = siteLinks(r, [
    deal("D-1", r.id, "Soro", "Active", { content_url: "https://x.test/review" }),
    deal("D-2", r.id, "MailerLite", "Negotiating"),
    deal("D-3", r.id, "Fiverr", "Lost"),
  ], { meta });
  assert.deepEqual(links.map((l) => [l.k, l.kind, l.dealId, !!l.live]), [["soro", "partner", "D-1", true], ["mailerlite", "talks", "D-2", false]]);
});

test("siteLinks: without deals an Active site is a partner of every client on it; Do not contact has none", () => {
  const r = site({ stage: "Active", clients: "Soro, TransferGO", content_url: "https://x.test/p" });
  assert.deepEqual(siteLinks(r, [], { meta }).map((l) => [l.name, l.kind, l.live]), [["Soro", "partner", true], ["TransferGO", "partner", true]]);
  assert.deepEqual(siteLinks(site({ stage: "Do not contact", clients: "Soro" }), [], { meta }), []);
  assert.deepEqual(siteLinks(site({ stage: "Replied", clients: "Soro", source: "Gmail outreach" }), [], { meta }), [], "a reply alone isn't a partner");
});

test("siteLinks: an imported Replied site was in the client's program; a deal for that client wins", () => {
  const r = site({ stage: "Replied", clients: "UltaHost, Soro", source: IMPORT_SOURCE });
  const links = siteLinks(r, [deal("D-9", r.id, "Soro", "Active")], { meta });
  assert.deepEqual(links.map((l) => [l.k, l.kind]), [["soro", "partner"], ["ultahost", "program"]]);
});

test("partnerRows and partnerCounts: tabs, a client filter that follows deals, partners first", () => {
  const a = site({ stage: "Active", clients: "Soro", dr: 20 });
  const b = site({ stage: "Replied", clients: "MailerLite", source: IMPORT_SOURCE, dr: 70 });
  const c = site({ stage: "Negotiating", clients: "Soro", dr: 90 });
  const d = site({ stage: "Active", clients: "Fiverr", dr: 50 }); // the Soro deal isn't in its client tags
  const deals = [deal("D-1", d.id, "Soro", "Active")];
  const recs = [a, b, c, d];
  const all = partnerRows(recs, deals, { meta });
  assert.deepEqual(all.map((x) => x.r.id), [d.id, a.id, b.id], "partners by DR, then program partners; in talks is left out");
  assert.deepEqual(partnerRows(recs, deals, { meta, tab: "now" }).map((x) => x.r.id), [d.id, a.id]);
  assert.deepEqual(partnerRows(recs, deals, { meta, tab: "program" }).map((x) => x.r.id), [b.id]);
  assert.deepEqual(partnerRows(recs, deals, { meta, client: "soro" }).map((x) => x.r.id), [d.id, a.id]);
  assert.deepEqual(partnerCounts(recs, deals, { meta }), { all: 3, now: 2, program: 1 });
});

test("sameCategory: the other clients in the category, past ones too", () => {
  const soro = meta.clients.find((c) => c.k === "soro");
  assert.deepEqual(sameCategory(meta, soro).map((c) => c.k).sort(), ["mailerlite", "mailersend", "ultahost", "weglot"]);
  assert.deepEqual(sameCategory(meta, meta.clients.find((c) => c.k === "fiverr")), [], "no category, no peers");
});

test("suggestedPartners: partners of same-category clients that aren't with the client yet", () => {
  const live = site({ stage: "Active", clients: "MailerLite", dr: 40 });
  const prog = site({ stage: "Replied", clients: "UltaHost", source: IMPORT_SOURCE, dr: 80 });
  const talks = site({ stage: "Negotiating", clients: "MailerSend", dr: 60 });
  const mine = site({ stage: "Active", clients: "MailerLite, Soro" });
  const dealt = site({ stage: "Active", clients: "MailerLite", dr: 10 });
  const lost = site({ stage: "Lost", clients: "MailerLite", source: IMPORT_SOURCE });
  const other = site({ stage: "Active", clients: "TransferGO" });
  const deals = [deal("D-5", dealt.id, "Soro", "Lost")];
  const s = suggestedPartners([live, prog, talks, mine, dealt, lost, other], deals, { meta, client: "soro" });
  assert.equal(s.category, "Software & SaaS");
  assert.deepEqual(s.rows.map((x) => x.r.id), [live.id, prog.id, talks.id], "partners, then program partners, then in talks; not the client's own, a site with a deal for it, Lost or another category");
  assert.equal(s.total, 3);
  assert.equal(viaText(s.rows[0].via), "Partner of MailerLite");
  assert.equal(viaText(s.rows[1].via), "Past program partner of UltaHost");
  assert.equal(suggestedPartners([live, prog], [], { meta, client: "soro", limit: 1 }).rows.length, 1);
});

test("suggestedPartners: no category or no peers gives no rows, and says which", () => {
  const live = site({ stage: "Active", clients: "MailerLite" });
  const f = suggestedPartners([live], [], { meta, client: "fiverr" });
  assert.equal(f.category, null);
  assert.deepEqual(f.rows, []);
  const t = suggestedPartners([live], [], { meta, client: "transfergo" });
  assert.equal(t.category, "Finance & money");
  assert.deepEqual(t.others, []);
  assert.deepEqual(suggestedPartners([live], [], { meta, client: "nobody" }), { category: null, others: [], rows: [], total: 0 });
});

test("viaText joins kinds and shortens long lists", () => {
  const via = [
    { name: "A", kind: "partner" }, { name: "B", kind: "partner" }, { name: "C", kind: "partner" }, { name: "D", kind: "partner" },
    { name: "E", kind: "program" }, { name: "F", kind: "talks" },
  ];
  assert.equal(viaText(via), "Partner of A, B and 2 more · past program partner of E · in talks with F");
  assert.equal(viaText([]), "");
});
