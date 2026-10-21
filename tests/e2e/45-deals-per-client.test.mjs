// Deals per client and file links (migration 006; Tomas asked on 2026-10-21).
// Run: bash tests/e2e/run.sh tests/e2e/45-deals-per-client.test.mjs
//
// The fixture is seeded after 006 ran, so `deals` starts empty and the other tests see the older site rows.
// Here a Negotiating site with one client gets a second deal for another client: the API writes the new
// edit kinds (create_deal, deal_update, create_file) and moves the site with its deals (its clients gain
// the client, its stage follows the best deal stage) as ordinary update rows. Then the pages: the Deals
// page shows one row per deal with the deal's Stage ▾, and the record page shows the Deals and Files cards.
// Everything the tests add is deleted in after(), and the site is put back.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { baseUrl, apiClient, signedInPage, closeBrowser, d1, sqlLit, maxEditN, editsAfter } from "./lib.mjs";

const BASE = baseUrl();
const COLS = ["stage", "clients", "updated_at", "updated_by"];
let site = null;
let other = "";
let edits0 = 0;
let client = null;
const made = { deals: [], files: [] };

before(async () => {
  [site] = await d1("SELECT id, name, domain, stage, clients, owner, updated_at, updated_by FROM partners WHERE stage = 'Negotiating' AND COALESCE(clients, '') <> '' AND instr(clients, ',') = 0 ORDER BY id LIMIT 1");
  assert.ok(site, "the fixture has a Negotiating site with one client");
  other = /fiverr/i.test(site.clients) ? "Soro" : "Fiverr";
  edits0 = await maxEditN();
  const c = await apiClient(BASE, { name: "Jonas" });
  // The site sends the editor's name as `by` with every write (core/api.js).
  client = { call: (m, url, b) => c.call(m, url, b === undefined ? b : { by: "Jonas", ...b }) };
});

after(async () => {
  if (!site) return closeBrowser();
  const set = COLS.map((c) => c + " = " + sqlLit(site[c])).join(", ");
  await d1("UPDATE partners SET " + set + " WHERE id = " + sqlLit(site.id) + "; DELETE FROM files; DELETE FROM deals; DELETE FROM edits WHERE n > " + Number(edits0) + "; DELETE FROM kv_meta WHERE k = 'new_deal_n'");
  await closeBrowser();
});

test("GET /api/deals answers an empty list once 006 is in", async () => {
  const r = await client.call("GET", "/api/deals");
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { deals: [] });
});

test("two deals for two clients: create_deal rows, and the site gains the second client", async () => {
  const first = await client.call("POST", "/api/partner/" + site.id + "/deals", { client: site.clients, deal_model: "Flat fee", deal_flat: "$350", next_step: "Agree terms" });
  assert.equal(first.status, 201, first.text);
  const second = await client.call("POST", "/api/partner/" + site.id + "/deals", { client: other, stage: "Negotiating", deal_pct: "30%" });
  assert.equal(second.status, 201, second.text);
  made.deals.push(first.json.deal.id, second.json.deal.id);
  assert.match(first.json.deal.id, /^NEWD-\d{4}$/);
  assert.notEqual(first.json.deal.id, second.json.deal.id);
  assert.equal(first.json.deal.owner, site.owner, "owner defaults to the site's");
  assert.equal(first.json.deal.deal_flat, 350);
  assert.equal(second.json.partner.clients, site.clients + ", " + other);
  const rows = await editsAfter(edits0);
  assert.deepEqual(rows.map((r) => [r.kind, r.field]), [
    ["create_deal", first.json.deal.id],
    ["create_deal", second.json.deal.id],
    ["update", "clients"],
  ]);
  const json = JSON.parse(rows[0].new);
  assert.deepEqual(Object.keys(json), ["client", "stage", "owner", "deal_model", "deal_flat", "deal_pct", "deal_value", "next_step", "next_due", "notes", "added"]);
  assert.equal(json.deal_flat, 350);
  assert.equal(rows[0].by_whom, "Jonas");
  assert.equal(rows[2].old, site.clients);
  assert.equal(rows[2].new, site.clients + ", " + other);
});

test("a deal's stage moves the site: Signed makes it Active, Lost on that deal brings it back to Negotiating", async () => {
  const [a, b] = made.deals;
  const n0 = await maxEditN();
  const signed = await client.call("PATCH", "/api/deal/" + b, { fields: { stage: "Active" } });
  assert.equal(signed.status, 200, signed.text);
  assert.equal(signed.json.partner.stage, "Active");
  const lost = await client.call("PATCH", "/api/deal/" + b, { fields: { stage: "Lost" } });
  assert.equal(lost.json.partner.stage, "Negotiating", "deal " + a + " is still Negotiating");
  const rows = await editsAfter(n0);
  assert.deepEqual(rows.map((r) => [r.kind, r.field, r.old, r.new]), [
    ["deal_update", b + ".stage", "Negotiating", "Active"],
    ["update", "stage", "Negotiating", "Active"],
    ["deal_update", b + ".stage", "Active", "Lost"],
    ["update", "stage", "Active", "Negotiating"],
  ]);
  const same = await client.call("PATCH", "/api/deal/" + b, { fields: { stage: "Lost" } });
  assert.deepEqual(same.json.changed, {}, "no change writes nothing");
  const bad = await client.call("PATCH", "/api/deal/" + b, { fields: { stage: "Replied" } });
  assert.equal(bad.status, 400);
  assert.match(bad.json.error, /deal stage/);
  const two = await client.call("PATCH", "/api/deal/" + b, { fields: { client: "Soro, Fiverr" } });
  assert.equal(two.status, 400);
  assert.equal(await maxEditN(), rows[rows.length - 1].n, "refused changes write nothing");
});

test("file links: https only, on the site or one of its deals", async () => {
  const [a] = made.deals;
  const ok = await client.call("POST", "/api/partner/" + site.id + "/files", { url: "https://drive.google.com/file/d/contract-test", kind: "Contract", label: "Signed contract", deal_id: a });
  assert.equal(ok.status, 201, ok.text);
  made.files.push(ok.json.file.n);
  const [row] = await editsAfter((await maxEditN()) - 1);
  assert.equal(row.kind, "create_file");
  assert.equal(row.field, String(ok.json.file.n));
  assert.deepEqual(Object.keys(JSON.parse(row.new)), ["label", "kind", "url", "deal_id", "added"]);
  const http = await client.call("POST", "/api/partner/" + site.id + "/files", { url: "http://x.example.test/p.pdf" });
  assert.equal(http.status, 400);
  const elsewhere = await client.call("POST", "/api/partner/PG-00001/files", { url: "https://x.example.test/p.pdf", deal_id: a });
  assert.equal(elsewhere.status, 400, "a deal of another site");
  const profile = await client.call("GET", "/api/partner/" + site.id);
  assert.deepEqual(profile.json.deals.map((d) => d.id), made.deals);
  assert.deepEqual(profile.json.files.map((f) => f.label), ["Signed contract"]);
});

test("Deals page: one row per deal with its own client and Stage ▾; the record shows Deals and Files", async () => {
  const [a, b] = made.deals;
  const { page, watch, close } = await signedInPage({ name: "Jonas" });
  await page.goto(BASE + "/#deals");
  const rowA = page.locator('[data-dl-group="negotiating"] [data-key="' + a + '"]');
  await rowA.waitFor();
  assert.equal(await rowA.getAttribute("data-rec"), site.id);
  assert.equal(await page.locator('[data-dl-group="lost"] [data-key="' + b + '"]').count(), 1, "the Lost deal is in Lost");
  assert.equal(await page.locator('[data-key="' + site.id + '"]').count(), 0, "the site has no row of its own");
  await rowA.locator("[data-dl-stage]").click();
  await page.getByRole("menuitemradio", { name: /Signed/ }).click();
  await page.locator('[data-dl-group="signed"] [data-key="' + a + '"]').waitFor();
  const [d] = await d1("SELECT stage FROM deals WHERE id = " + sqlLit(a));
  assert.equal(d.stage, "Active");
  await page.locator('[data-key="' + a + '"] a[data-open]').click();
  const cards = page.locator(".rc-dealitem");
  await cards.first().waitFor();
  assert.equal(await cards.count(), 2);
  assert.match(await page.locator(".rc-dealitem[data-dealid=\"" + a + "\"]").innerText(), /Signed/);
  assert.match(await page.locator(".rc-file").first().innerText(), /Signed contract/);
  assert.deepEqual(watch.pageErrors, []);
  assert.deepEqual(watch.consoleErrors, []);
  await close();
});
