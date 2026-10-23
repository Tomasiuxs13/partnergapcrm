// Partners, Contacts, the contact and deal pages, and suggested partners (Tomas asked on 2026-10-23).
// Run: bash tests/e2e/run.sh tests/e2e/47-records.test.mjs
//
// The API first: GET /api/contacts, /api/contact/:id and /api/deal/:id (with their 404s). Then the pages:
// the Records group in the side menu, Partners and Contacts lists, a contact's page and a deal's page, the
// side menu staying usable while a site's record is open, and a client page's Suggested partners card.
// The one deal and file link the tests add are deleted in after(), and the site is put back.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { baseUrl, apiClient, signedInPage, closeBrowser, d1, sqlLit, maxEditN } from "./lib.mjs";

const BASE = baseUrl();
const COLS = ["stage", "clients", "updated_at", "updated_by"];
let site = null;
let person = null;
let dealId = "";
let edits0 = 0;
let client = null;

before(async () => {
  [site] = await d1("SELECT p.id, p.name, p.domain, p.stage, p.clients, p.owner, p.updated_at, p.updated_by FROM partners p WHERE p.stage = 'Negotiating' AND COALESCE(p.clients, '') <> '' AND instr(p.clients, ',') = 0 AND EXISTS (SELECT 1 FROM contacts c WHERE c.account_id = p.id) ORDER BY p.id LIMIT 1");
  assert.ok(site, "the fixture has a Negotiating site with one client and a contact");
  [person] = await d1("SELECT id, first_name, last_name, email FROM contacts WHERE account_id = " + sqlLit(site.id) + " ORDER BY id LIMIT 1");
  edits0 = await maxEditN();
  const c = await apiClient(BASE, { name: "Jonas" });
  client = { call: (m, url, b) => c.call(m, url, b === undefined ? b : { by: "Jonas", ...b }) };
});

after(async () => {
  if (!site) return closeBrowser();
  const set = COLS.map((c) => c + " = " + sqlLit(site[c])).join(", ");
  await d1("UPDATE partners SET " + set + " WHERE id = " + sqlLit(site.id) + "; DELETE FROM files; DELETE FROM deals; DELETE FROM edits WHERE n > " + Number(edits0) + "; DELETE FROM kv_meta WHERE k = 'new_deal_n'");
  await closeBrowser();
});

test("GET /api/contacts: every contact as cols and rows, private", async () => {
  const r = await client.call("GET", "/api/contacts");
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.cols, ["id", "account_id", "first_name", "last_name", "title", "client", "email", "outreach_status", "last_email", "replied", "primary_contact"]);
  const [{ n }] = await d1("SELECT COUNT(*) AS n FROM contacts");
  assert.equal(r.json.rows.length, n);
  assert.ok(r.json.rows.some((row) => row[0] === person.id && row[1] === site.id));
  assert.match(r.headers.get("cache-control") || "", /no-store/);
});

test("signed out, the three endpoints answer 401 and no email", async () => {
  for (const u of ["/api/contacts", "/api/contact/" + person.id, "/api/deal/NEWD-0001"]) {
    const r = await fetch(BASE + u, { redirect: "manual" });
    assert.equal(r.status, 401, u);
    assert.doesNotMatch(await r.text(), /@/, u);
  }
});

test("GET /api/contact/:id: the person, their site, the other people and the site's activity; 404 when unknown", async () => {
  const r = await client.call("GET", "/api/contact/" + person.id);
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(Object.keys(r.json), ["contact", "partner", "contacts", "activity", "deals", "history"]);
  assert.equal(r.json.contact.id, person.id);
  assert.equal(r.json.partner.id, site.id);
  assert.ok(!r.json.contacts.some((c) => c.id === person.id), "the other people only");
  assert.deepEqual(r.json.deals, []);
  assert.ok(Array.isArray(r.json.history.edits));
  const missing = await client.call("GET", "/api/contact/C-NOPE-1");
  assert.equal(missing.status, 404);
});

test("GET /api/deal/:id: the deal, its site, people, files and its own changes; 404 when unknown", async () => {
  const made = await client.call("POST", "/api/partner/" + site.id + "/deals", { client: site.clients, deal_model: "Flat fee", deal_flat: "$350", next_step: "Send the brief" });
  assert.equal(made.status, 201, made.text);
  dealId = made.json.deal.id;
  const file = await client.call("POST", "/api/partner/" + site.id + "/files", { url: "https://drive.google.com/file/d/test-records", label: "Signed contract", kind: "Contract", deal_id: dealId });
  assert.ok(file.status === 200 || file.status === 201, file.text);
  const r = await client.call("GET", "/api/deal/" + dealId);
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(Object.keys(r.json), ["deal", "partner", "contacts", "activity", "files", "history"]);
  assert.equal(r.json.deal.id, dealId);
  assert.equal(r.json.partner.id, site.id);
  assert.ok(r.json.contacts.some((c) => c.id === person.id));
  assert.deepEqual(r.json.files.map((f) => [f.deal_id, f.label]), [[dealId, "Signed contract"]]);
  assert.deepEqual(r.json.history.edits.map((e) => [e.kind, e.field]), [["create_deal", dealId]]);
  const missing = await client.call("GET", "/api/deal/NEWD-9999");
  assert.equal(missing.status, 404);
});

test("the Records group holds Partners and Contacts, and opens on its own pages", async () => {
  const { page, watch } = await signedInPage({ name: "Jonas" });
  await page.goto(BASE + "/#partners");
  await page.waitForSelector("main h1");
  assert.equal(await page.locator("main h1").textContent(), "Partners");
  assert.equal(await page.locator("details[data-sh-group]").evaluate((d) => d.open), true);
  assert.equal(await page.locator('.sh-side a[data-nav="partners"]').getAttribute("aria-current"), "page");
  await page.waitForSelector(".pt-list tbody tr");
  await page.locator('.sh-side a[data-nav="contacts"]').click();
  await page.waitForFunction(() => document.querySelector("main h1") && document.querySelector("main h1").textContent === "Contacts");
  await page.waitForSelector(".pt-list tbody tr");
  assert.deepEqual(watch.pageErrors, []);
});

test("Partners: the deal's site is listed as a partner, and its tag opens the deal page", async () => {
  await client.call("PATCH", "/api/deal/" + dealId, { fields: { stage: "Active" } });
  const { page, watch } = await signedInPage({ name: "Jonas" });
  await page.goto(BASE + "/#partners?q=" + encodeURIComponent(site.domain));
  const tag = page.locator('.pt-list a[href="#deal/' + dealId + '"]');
  await tag.waitFor();
  await tag.click();
  await page.waitForSelector('[data-rv-page="deal"] .rv-cols');
  assert.match(await page.locator("main h1").textContent(), /deal$/);
  assert.match(await page.title(), / deal · /);
  assert.deepEqual(watch.pageErrors, []);
});

test("a contact's page: name, email, the site card, and Open site opens the record beside the menu", async () => {
  const { page, watch } = await signedInPage({ name: "Jonas" });
  await page.goto(BASE + "/#contact/" + person.id);
  await page.waitForSelector('[data-rv-page="contact"] .rv-cols');
  const name = [person.first_name, person.last_name].filter(Boolean).join(" ");
  assert.equal((await page.locator("main h1").textContent()).trim(), name);
  if (person.email) assert.ok((await page.locator('[data-rv-card="about"]').textContent()).includes(String(person.email).split(/[,;]/)[0].trim()));
  assert.ok((await page.locator('[data-rv-card="deals"]').textContent()).includes(site.clients));
  await page.locator('.rv-tools [data-rv-site]:not([data-rv-focus])').click();
  await page.waitForSelector("#layer-panel .ui-panel");
  assert.equal(await page.evaluate(() => document.querySelector(".sh-side").inert), false, "the side menu stays usable");
  assert.equal(await page.evaluate(() => document.querySelector(".sh-main").inert), true);
  await page.locator('.sh-side a[data-nav="deals"]').click();
  await page.waitForFunction(() => location.hash.startsWith("#deals"));
  await page.waitForSelector("#layer-panel .ui-panel", { state: "detached", timeout: 5000 }); // the menu link closes the record
  assert.deepEqual(watch.pageErrors, []);
});

test("a deal's page: facts, files, and unknown ids say so", async () => {
  const { page, watch } = await signedInPage({ name: "Jonas" });
  await page.goto(BASE + "/#deal/" + dealId);
  await page.waitForSelector('[data-rv-page="deal"] .rv-cols');
  assert.match(await page.locator('[data-rv-card="deal"]').textContent(), /Flat fee[\s\S]*Send the brief/);
  assert.ok((await page.locator('[data-rv-card="files"]').textContent()).includes("Signed contract"));
  await page.goto(BASE + "/#deal/NEWD-9999");
  await page.reload();
  await page.waitForFunction(() => /wasn't found/.test((document.querySelector("main h1") || {}).textContent || ""));
  assert.deepEqual(watch.pageErrors, []);
});

test("a client page suggests partners of other clients in its category", async () => {
  const { page, watch } = await signedInPage({ name: "Jonas" });
  await page.goto(BASE + "/#clients/soro");
  const card = page.locator('[data-cl-card="suggest"]');
  await card.waitFor();
  assert.match(await card.textContent(), /Software & SaaS/);
  assert.ok(await card.locator("[data-cl-suggest]").count() > 0, "at least one suggestion with an Add button");
  assert.deepEqual(watch.pageErrors, []);
});
