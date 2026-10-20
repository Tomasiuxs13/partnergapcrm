// Search and Add site (spec 4.3, 3 F4, 7.2 F7; tests T7, T8, T10 and the search side of T9). Owner F7.
// Run: bash tests/e2e/run.sh tests/e2e/70-search-add.test.mjs   (screenshots: SHOTS_DIR, default /tmp/shots-f7)
//
// Search first (read-only apart from one Claim): every T10 query kind puts the right site first with its owner,
// Enter opens it, contacts come from the in-memory index (one request per page session), Go to, recently opened
// sites, "Not in the CRM: Add …". Then Add site: the exact duplicate check with Ask owner and Add anyway (golden
// create_account), Melograno products (T8), every field, the discard guard, the server's 409, the P1 name
// prefill and similar-name hint. Then speed (7,500 sites and 6,000 contacts served by page.route), the phone
// layout and axe. after() deletes the sites, edits rows and kv mark the tests added and puts the claimed site back.
// Mocks: /api/about?domain= in the P1 test (the fixture hosts don't resolve), and the big list in the speed test.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  baseUrl, signedInPage, closeBrowser, d1, maxEditN, editsAfter, stripEdit, goldenCase, assertGolden, fixture, tools,
  apiClient,
} from "./lib.mjs";

const BASE = baseUrl();
const SHOTS = process.env.SHOTS_DIR || "/tmp/shots-f7";
const fx = fixture();
// Set in before(): from D1_TABLES, or from the database itself when the file runs against a --serve server.
let HAS_KV = String(process.env.D1_TABLES || "").split(",").includes("kv_meta");
const DESKTOP = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };
const PHONE_OPTS = { hasTouch: true, isMobile: true };
const CLIP = { permissions: ["clipboard-read", "clipboard-write"] };
const DIALOG = ".se-dialog[open]";
const INPUT = ".se-input";
const ADD = ".se-addmodal[open]";
const P = "#layer-panel ";
const ADDED = "Added. It reaches the Google Sheet on the next weekday morning.";

const one = (tag) => {
  const ids = fx.groups[tag];
  assert.ok(ids && ids.length, "fixture group " + tag);
  return ids[0];
};
const site = (id) => {
  const p = fx.partners.find((x) => x.id === id);
  assert.ok(p, "fixture site " + id);
  return p;
};
const contactId = (email) => {
  const c = fx.contacts.find((x) => x.email === email);
  assert.ok(c, "fixture contact " + email);
  return c.id;
};
const platforms = new Set(fx.groups.platform || []);
const ID = {
  dupe: one("dupe-site"),
  money: one("mr-money"),
  channel: one("channel"),
  siteX: one("site-x"),
  siteY: one("site-y"),
  siteAnn: one("site-ann"),
  garden: one("contact-name-site"),
  new3: "NEW-0003",
  pg8: "PG-00008",
  // An unowned New site that isn't a big platform (the last one, away from other tests' picks).
  claim: fx.groups["unowned-new"].filter((id) => !platforms.has(id)).slice(-1)[0],
};
const LATE = { id: "PG-09901", domain: "late-f7.example.test", name: "Late F7 Site", owner: "Monica", stage: "Contacted", clients: "Raibu" };
const CLAIM_COLS = ["owner", "stage", "next_step", "next_due", "updated_at", "updated_by"];

let n0 = 0;
let newIds0 = [];
let claim0 = null;
let kv0 = []; // the kv_meta rows the tests may change, as they were before
const KV_KEYS = ["new_site_n", "sheet_sig", "last_sheet_change"];

// ---------- helpers ----------

async function retry(fn, tries = 6) {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (e) {
      if (i >= tries || !/SQLITE_BUSY|database is locked/i.test(String(e && e.message))) throw e;
      await new Promise((r) => setTimeout(r, 400 * (i + 1)));
    }
  }
}
const q = (v) => (v == null ? "NULL" : "'" + String(v).replace(/'/g, "''") + "'");
const inList = (ids) => "(" + ids.map(q).join(",") + ")";

async function waitFor(fn, what, ms = 15000) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    last = await fn();
    if (last) return last;
    await new Promise((r) => setTimeout(r, 250));
  }
  assert.fail("timed out waiting for " + what);
}

// The edits rows of one site written after the tests started (at least `count`).
async function editsOf(id, count = 1) {
  let rows = [];
  await waitFor(async () => {
    rows = (await retry(() => editsAfter(n0))).filter((r) => r.account_id === id);
    return rows.length >= count;
  }, count + " new edits rows for " + id);
  return rows;
}

function settled(page) {
  return page.waitForFunction(() => document.getAnimations().every((a) =>
    a.playState !== "running" || (a.effect && a.effect.getComputedTiming().iterations === Infinity)));
}

async function shot(page, name, opts = {}) {
  await settled(page);
  return page.screenshot({ path: path.join(SHOTS, name + ".png"), ...opts });
}

async function openPage({ name = "Kamile", viewport = DESKTOP, contextOptions = {}, colorScheme } = {}) {
  const s = await signedInPage({ name, viewport, contextOptions, colorScheme });
  await s.page.waitForSelector(".sh-search, .sh-tab");
  await s.page.waitForFunction(() => document.querySelector("main") && document.querySelector("main").getAttribute("aria-busy") !== "true");
  return s;
}

async function openSearch(page) {
  await page.keyboard.press("Control+k");
  await page.waitForSelector(DIALOG);
  await page.waitForFunction(() => document.activeElement && document.activeElement.classList.contains("se-input"));
}

// Types a query (one input event, like a paste) and returns the active row.
async function search(page, text) {
  await page.fill(INPUT, text);
  return activeRow(page);
}

function activeRow(page) {
  return page.evaluate(() => {
    const row = document.querySelector(".se-dialog .se-row.is-active");
    if (!row) return null;
    const input = document.querySelector(".se-input");
    const cell = row.querySelector(".se-cell");
    const o = row.querySelector(".se-owner");
    const owner = o ? o.querySelector("span:last-child") || o : null; // the name, without the avatar's letters
    return {
      kind: row.getAttribute("data-kind"),
      id: row.getAttribute("data-id"),
      contact: row.getAttribute("data-contact"),
      text: row.innerText.replace(/\s+/g, " ").trim(),
      owner: owner ? owner.innerText.replace(/\s+/g, " ").trim() : null,
      described: input.getAttribute("aria-activedescendant") === cell.id && cell.getAttribute("aria-selected") === "true",
    };
  });
}

function rowsOf(page, kind) {
  return page.$$eval(".se-dialog .se-row" + (kind ? '[data-kind="' + kind + '"]' : ""), (rs) => rs.map((r) => ({
    kind: r.getAttribute("data-kind"), id: r.getAttribute("data-id"), contact: r.getAttribute("data-contact"),
    text: r.innerText.replace(/\s+/g, " ").trim(),
  })));
}

async function toastText(page, re) {
  return waitFor(() => page.evaluate((src) => {
    const r = new RegExp(src);
    return Array.from(document.querySelectorAll(".ui-toast")).map((t) => t.innerText.replace(/\s+/g, " ").trim()).find((t) => r.test(t)) || null;
  }, re.source), "toast " + re);
}

async function openAdd(page) {
  await page.keyboard.press("n");
  await page.waitForSelector(ADD);
}

const dupeBox = (page) => page.$eval(ADD + " [data-dupe-box]", (b) => b.innerText.replace(/\s+/g, " ").trim()).catch(() => null);

async function closedAdd(page) {
  await page.waitForSelector(".se-addmodal", { state: "detached" });
}

async function discard(page) {
  await page.waitForSelector('dialog[open] >> text="Discard this site?"');
  await page.click("dialog[open] .ui-btn.is-danger");
  await closedAdd(page);
}

async function panelOpen(page, id) {
  await page.waitForSelector(P + '.ui-panel[data-panel="' + id + '"]');
  return page.evaluate(() => location.hash);
}

async function closePanel(page) {
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => !/[?&]rec=/.test(location.hash));
}

const recFromHash = async (page) => (/rec=(NEW-\d{4})/.exec(await page.evaluate(() => location.hash)) || [])[1];

async function partner(id) {
  const rows = await retry(() => d1("SELECT json_object('id', id, 'domain', domain, 'name', name, 'owner', owner, 'stage', stage, " +
    "'clients', clients, 'type', type, 'next_step', next_step, 'next_due', next_due, 'notes', notes) AS j FROM partners WHERE id = " + q(id), { rawNulls: true }));
  return rows.length ? JSON.parse(rows[0].j) : null;
}

// ---------- setup / teardown ----------

before(async () => {
  assert.ok(BASE, "BASE_URL is set (run through tests/e2e/run.sh)");
  assert.ok(!/:8788\b/.test(BASE), "never the main dev server");
  fs.mkdirSync(SHOTS, { recursive: true });
  n0 = Number(await retry(() => maxEditN()));
  newIds0 = (await retry(() => d1("SELECT id FROM partners WHERE id LIKE 'NEW-%'"))).map((r) => r.id);
  const obj = "json_object(" + CLAIM_COLS.map((c) => "'" + c + "', " + c).join(", ") + ")";
  claim0 = JSON.parse((await retry(() => d1("SELECT " + obj + " AS j FROM partners WHERE id = " + q(ID.claim), { rawNulls: true })))[0].j);
  assert.equal(claim0.owner, null, "the Claim site starts unowned");
  if (!HAS_KV) HAS_KV = (await retry(() => d1("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'kv_meta'"))).length > 0;
  if (HAS_KV) kv0 = await retry(() => d1("SELECT k, v, at, by_whom FROM kv_meta WHERE k IN " + inList(KV_KEYS), { rawNulls: true }));
});

after(async () => {
  try {
    await retry(() => d1("DELETE FROM partners WHERE id LIKE 'NEW-%'" + (newIds0.length ? " AND id NOT IN " + inList(newIds0) : "")));
    await retry(() => d1("DELETE FROM partners WHERE id = " + q(LATE.id)));
    await retry(() => d1("DELETE FROM edits WHERE n > " + n0));
    const set = CLAIM_COLS.map((c) => c + " = " + q(claim0[c])).join(", ");
    await retry(() => d1("UPDATE partners SET " + set + " WHERE id = " + q(ID.claim)));
    if (HAS_KV) {
      // The new-site counter and the sheet freshness keys a GET wrote while the tests' rows existed.
      await retry(() => d1("DELETE FROM kv_meta WHERE k IN " + inList(KV_KEYS)));
      for (const r of kv0) {
        await retry(() => d1("INSERT INTO kv_meta (k, v, at, by_whom) VALUES (" + [r.k, r.v, r.at, r.by_whom].map(q).join(", ") + ")"));
      }
    }
  } finally {
    await closeBrowser();
  }
});

// ---------- Search ----------

test("Search opens from Ctrl+K, / and the top bar as a combobox; Esc and Close shut it and give focus back", async () => {
  const { page, watch, close } = await openPage();
  try {
    await openSearch(page);
    const a11y = await page.evaluate(() => {
      const i = document.querySelector(".se-input");
      const grid = document.getElementById(i.getAttribute("aria-controls"));
      return {
        role: i.getAttribute("role"), controls: i.getAttribute("aria-controls"), expanded: i.getAttribute("aria-expanded"),
        grid: grid ? grid.getAttribute("role") : null, placeholder: i.placeholder,
        hint: document.querySelector(".se-dialog [data-note]").innerText.trim(),
      };
    });
    assert.deepEqual(a11y, { role: "combobox", controls: "se-grid", expanded: "false", grid: "grid",
      placeholder: "Search or paste a link…", hint: "Type a site name, paste a link or an email, or type an ID such as PG-00123." });
    await shot(page, "search-empty-1440");
    await page.keyboard.press("Escape");
    await page.waitForSelector(DIALOG, { state: "detached" });

    await page.keyboard.press("/");
    await page.waitForSelector(DIALOG);
    await page.keyboard.press("Escape");
    await page.waitForSelector(DIALOG, { state: "detached" });

    await page.click(".sh-search");
    await page.waitForSelector(DIALOG);
    await search(page, "mr money");
    assert.equal(await page.getAttribute(INPUT, "aria-expanded"), "true");
    await page.click(".se-close");
    await page.waitForSelector(DIALOG, { state: "detached" });
    assert.equal(await page.evaluate(() => !!document.activeElement && document.activeElement.classList.contains("sh-search")), true,
      "focus goes back to the top bar search");
    assert.deepEqual(watch.pageErrors, []);
    assert.deepEqual(watch.consoleErrors, []);
  } finally {
    await close();
  }
});

test("T10: every kind of query puts the right site first with its owner, and Enter opens it", async () => {
  const { page, watch, close } = await openPage();
  try {
    await openSearch(page);
    const cases = [
      ["full URL", "https://www.dupe.example.test/a/b?x=1", ID.dupe],
      ["www. host", "www.dupe.example.test", ID.dupe],
      ["bare domain", "dupe.example.test", ID.dupe],
      ["YouTube channel URL", "https://www.youtube.com/@pgfixture-channel/videos?si=abc", ID.channel],
      ["PG id", "PG-00008", ID.pg8],
      ["NEW id, short form", "new-3", ID.new3],
      ["name words", "mr money", ID.money],
      ["punctuated name", "Mr. Money!", ID.money],
      ["contact email", "rob@x.example.test", ID.siteX],
    ];
    for (const [what, text, id] of cases) {
      const row = await search(page, text);
      assert.ok(row, what + ": a row is active");
      assert.equal(row.kind, "site", what);
      assert.equal(row.id, id, what + ": " + row.text);
      assert.ok(row.described, what + ": aria-activedescendant points at the active cell");
      const owner = site(id).owner;
      assert.ok(row.owner && row.owner.startsWith(owner), what + ": owner " + owner + " in the row (" + row.owner + ")");
    }
    // A contact's name: the contact's row comes first and opens its site with the contacts in view.
    const contact = await search(page, "Ottilie Vance");
    assert.equal(contact.kind, "contact");
    assert.equal(contact.id, ID.garden);
    assert.match(contact.text, /Ottilie Vance/);
    assert.match(contact.text, /at Garden Lab/);
    await shot(page, "search-contact-1440");
    await page.keyboard.press("Enter");
    await page.waitForSelector(DIALOG, { state: "detached" });
    assert.match(await panelOpen(page, ID.garden), new RegExp("rec=" + ID.garden));
    const inView = await page.evaluate(() => {
      const s = document.querySelector('#layer-panel [data-psec="contacts"]');
      if (!s) return null;
      const r = s.getBoundingClientRect();
      return r.top < window.innerHeight && r.bottom > 0;
    });
    assert.equal(inView, true, "the Contacts section is in view");
    await closePanel(page);

    // Arrow keys move the active row; Enter opens the chosen one.
    await openSearch(page);
    await search(page, "example");
    const first = (await rowsOf(page, "site"))[0];
    await page.keyboard.press("ArrowDown");
    assert.notEqual((await activeRow(page)).id, first.id, "ArrowDown moves to the second row");
    await page.keyboard.press("ArrowUp");
    assert.equal((await activeRow(page)).id, first.id, "ArrowUp moves back");
    await search(page, "mr money");
    await page.keyboard.press("Enter");
    await page.waitForSelector(DIALOG, { state: "detached" });
    assert.match(await panelOpen(page, ID.money), new RegExp("rec=" + ID.money));
    await closePanel(page);
    assert.deepEqual(watch.pageErrors, []);
  } finally {
    await close();
  }
});

test("Contacts come from the in-memory index, fetched once per page session; emails match exactly (T9, search side)", async () => {
  const { page, close } = await openPage();
  const requests = [];
  page.on("request", (r) => { if (/\/api\/contacts-index/.test(r.url())) requests.push(r.url()); });
  try {
    await openSearch(page);
    let row = await search(page, "ann@x.example.test");
    await page.waitForSelector('.se-row[data-kind="contact"]');
    row = await activeRow(page);
    assert.equal(row.id, ID.siteAnn, "the site of the exact address comes first, before x.example.test");
    let people = await rowsOf(page, "contact");
    assert.equal(people[0].contact, contactId("ann@x.example.test"), "Ann Hill first, not Jo Ann (joann@…)");
    assert.equal(people[0].id, ID.siteAnn);
    await search(page, "joann@x.example.test");
    people = await rowsOf(page, "contact");
    assert.deepEqual(people.map((p) => p.contact), [contactId("joann@x.example.test")]);
    row = await search(page, "b@y.example.test");
    assert.equal(row.id, ID.siteY, "a contact with two addresses is found by each of them");
    people = await rowsOf(page, "contact");
    assert.equal(people[0].contact, contactId("a@y.example.test; b@y.example.test"));
    assert.match(people[0].text, /Abe Brooks a@y\.example\.test, b@y\.example\.test · at Y Example Deals/);
    await search(page, "jane@nobody.example.test");
    const note = await page.$eval(".se-dialog .se-note-row", (n) => n.innerText.replace(/\s+/g, " ").trim());
    assert.equal(note, "No contacts match “jane@nobody.example.test”. New contacts from the sheet appear the next weekday morning.");
    await page.keyboard.press("Escape");
    for (let i = 0; i < 2; i++) {
      await openSearch(page);
      await search(page, "Ottilie");
      await page.waitForSelector('.se-row[data-kind="contact"]');
      await page.keyboard.press("Escape");
    }
    assert.equal(requests.length, 1, "one contacts-index request in the page session");
    const stored = await page.evaluate(async () => {
      const ls = [];
      for (let i = 0; i < localStorage.length; i++) ls.push(localStorage.getItem(localStorage.key(i)) || "");
      let cached = [];
      try { cached = (await (await caches.open("pgcrm")).keys()).map((r) => r.url); } catch (e) { cached = []; }
      return { emails: ls.filter((v) => /@[a-z0-9.-]*example\.test/.test(v)).length, cached: cached.filter((u) => /contacts-index/.test(u)) };
    });
    assert.deepEqual(stored, { emails: 0, cached: [] }, "the index is never stored");
  } finally {
    await close();
  }
});

test("Go to (at most 3): a client opens its page, a person opens Sites filtered by owner", async () => {
  const { page, close } = await openPage();
  try {
    await openSearch(page);
    const goto = async () => (await rowsOf(page, "client")).length + (await rowsOf(page, "person")).length;
    await search(page, "m");
    assert.equal(await goto(), 0, "one letter: no Go to");
    await search(page, "ma");
    const n = await goto();
    assert.ok(n >= 1 && n <= 3, "1 to 3 Go to rows (" + n + ")");
    await search(page, "soro");
    const clients = await rowsOf(page, "client");
    assert.equal(clients.length, 1);
    assert.match(clients[0].text, /^Soro Client page/);
    await page.click('.se-row[data-kind="client"]');
    await page.waitForSelector(DIALOG, { state: "detached" });
    assert.equal(await page.evaluate(() => location.hash), "#clients/soro");
    await openSearch(page);
    await search(page, "gaby");
    const people = await rowsOf(page, "person");
    assert.equal(people.length, 1);
    assert.match(people[0].text, /Gaby Sites owned by Gaby$/);
    await page.click('.se-row[data-kind="person"]');
    await page.waitForSelector(DIALOG, { state: "detached" });
    const hash = await page.evaluate(() => location.hash);
    assert.match(hash, /^#sites\?/);
    assert.match(hash, /owner=Gaby/);
    assert.match(hash, /tab=all/);
  } finally {
    await close();
  }
});

test("An empty search lists the sites opened most recently", async () => {
  const { page, close } = await openPage();
  try {
    for (const text of ["PG-00008", "mr money"]) {
      await openSearch(page);
      await search(page, text);
      await page.keyboard.press("Enter");
      await page.waitForSelector(DIALOG, { state: "detached" });
      await page.waitForSelector(P + ".ui-panel");
      await closePanel(page);
    }
    await openSearch(page);
    assert.match(await page.$eval(".se-ghead", (h) => h.innerText), /Recently opened/);
    const ids = (await rowsOf(page, "site")).map((r) => r.id);
    assert.deepEqual(ids.slice(0, 2), [ID.money, ID.pg8]);
    await page.keyboard.press("Enter");
    assert.match(await panelOpen(page, ID.money), new RegExp("rec=" + ID.money));
  } finally {
    await close();
  }
});

test("No site at a pasted address: \"Not in the CRM: Add …\" opens Add site with the address filled in", async () => {
  const { page, close } = await openPage();
  try {
    await openSearch(page);
    const pasted = "https://www.brand-new-f7.example.test/some/path?utm=1";
    const row = await search(page, pasted);
    assert.equal(row.kind, "add");
    assert.match(row.text, /^Not in the CRM: Add brand-new-f7\.example\.test/);
    await shot(page, "search-not-found-1440");
    await page.keyboard.press("Enter");
    await page.waitForSelector(ADD);
    assert.equal(await page.inputValue("#se-add-domain"), pasted);
    assert.equal(await page.$eval("[data-domain-hint]", (h) => h.innerText.trim()), "Not in the CRM yet. Saved as brand-new-f7.example.test.");
    await page.click(ADD + " .ui-modal-foot .ui-btn.is-ghost");
    await closedAdd(page);
  } finally {
    await close();
  }
});

test("An unowned site has an inline Claim button: owner me and a follow-up, without leaving Search", async () => {
  const { page, close } = await openPage();
  try {
    await openSearch(page);
    const row = await search(page, ID.claim);
    assert.equal(row.id, ID.claim);
    assert.equal(row.owner, "No owner");
    await shot(page, "search-claim-1440");
    await page.click('.se-row[data-id="' + ID.claim + '"] [data-claim]');
    await toastText(page, /^Claimed · follow-up /);
    await page.waitForFunction((id) => {
      const r = document.querySelector('.se-row[data-id="' + id + '"]');
      return r && !r.querySelector("[data-claim]") && /Kamile \(me\)/.test(r.innerText);
    }, ID.claim);
    assert.ok(await page.isVisible(DIALOG), "Search stays open");
    const p = await waitFor(async () => { const x = await partner(ID.claim); return x && x.owner === "Kamile" ? x : null; }, "owner Kamile in D1");
    assert.equal(p.stage, "New", "no stage change");
    assert.ok(p.next_due, "a follow-up date");
    const rows = await editsOf(ID.claim);
    assert.ok(rows.some((r) => r.kind === "update" && r.field === "owner" && r.new === "Kamile" && r.by_whom === "Kamile"), "an update row for owner");
  } finally {
    await close();
  }
});

// ---------- Add site ----------

test("T7: a pasted URL of a known site shows the duplicate with Ask owner; Add anyway saves the golden create_account row", async () => {
  const { page, watch, close } = await openPage({ contextOptions: CLIP });
  try {
    await openAdd(page);
    assert.equal(await page.evaluate(() => document.activeElement && document.activeElement.id), "se-add-domain", "desktop: the cursor waits in Website");
    await page.fill("#se-add-domain", "https://www.dupe.example.test/a/b?x=1");
    const box = await waitFor(() => dupeBox(page), "the duplicate warning");
    assert.match(box, /^Already in the CRM Dupe Example dupe\.example\.test Contacted · owned by Gaby · MailerLite, MailerSend Open site Ask Gaby \(copy message\)/);
    assert.equal(await page.isDisabled(ADD + " [data-add-submit]"), true, "Add site waits while a duplicate shows");
    await shot(page, "add-duplicate-1440");

    await page.click(ADD + ' [data-ask="' + ID.dupe + '"]');
    await toastText(page, /^Message for Gaby copied\. Paste it in Slack\. Nothing is sent from this site\./);
    const msg = await page.evaluate(() => navigator.clipboard.readText());
    assert.equal(msg, "Hi Gaby, dupe.example.test (Dupe Example) is yours in the CRM (" + ID.dupe + ", Contacted). I'd like to pitch it. " +
      "OK if I reach out, or would you rather do it? Kamile");

    await page.fill("#se-add-name", "Dupe Again");
    const posts = [];
    page.on("request", (r) => { if (r.method() === "POST" && /\/api\/partners$/.test(r.url())) posts.push(JSON.parse(r.postData() || "{}")); });
    await page.click(ADD + " [data-force]");
    await closedAdd(page);
    const id = await recFromHash(page);
    assert.ok(id, "the new site opens");
    await panelOpen(page, id);
    await toastText(page, new RegExp("^" + ADDED.replace(/\./g, "\\.")));
    assert.equal(posts.length, 1);
    assert.equal(posts[0].force, true);
    assertGolden(goldenCase("add-site", "duplicate-forced").edits, (await editsOf(id)).map(stripEdit), { message: "Add anyway = golden duplicate-forced" });
    const rec = await page.evaluate(async (x) => {
      const s = await import("/js/core/store.js");
      const r = s.get(x);
      return r ? { domain: r.domain, owner: r.owner, isNew: r.isNew } : null;
    }, id);
    assert.deepEqual(rec, { domain: "dupe.example.test", owner: "Kamile", isNew: true }, "the store has the new site");
    await closePanel(page);

    // Open site leaves without the discard question and opens the existing site.
    await openAdd(page);
    await page.fill("#se-add-domain", "dupe.example.test/blog");
    await waitFor(() => dupeBox(page), "the duplicate warning");
    await page.click(ADD + ' [data-open-dupe="' + ID.dupe + '"]');
    await closedAdd(page);
    await panelOpen(page, ID.dupe);
    assert.deepEqual(watch.pageErrors, []);
  } finally {
    await close();
  }
});

test("T8: the Melograno → Amelia chip stores \"Melograno - Amelia\"; both client filters find the site", async () => {
  const { page, close } = await openPage();
  try {
    await openAdd(page);
    await page.fill("#se-add-domain", "amelia-f7.example.test");
    await page.click('[data-group="melograno"]');
    await page.click('[data-chip="melograno|amelia"]');
    assert.equal(await page.getAttribute('[data-chip="melograno|amelia"]', "aria-pressed"), "true");
    assert.match(await page.innerText('[data-group="melograno"]'), /Melograno · 1/);
    await shot(page, "add-melograno-1440");
    await page.click(ADD + " [data-add-submit]");
    await closedAdd(page);
    const id = await recFromHash(page);
    assert.ok(id);
    const p = await waitFor(() => partner(id), "the new row");
    assert.equal(p.clients, "Melograno - Amelia");
    const found = await page.evaluate(async (x) => {
      const s = await import("/js/core/store.js");
      const f = await import("/js/ui/filters.js");
      const has = (params) => f.applyFilters(s.all(), params).some((r) => r.id === x);
      return { product: has({ client: "melograno-amelia" }), all: has({ client: "melograno" }), other: has({ client: "melograno-trafft" }) };
    }, id);
    assert.deepEqual(found, { product: true, all: true, other: false });
  } finally {
    await close();
  }
});

test("Add site with every field: Other… client, owner, type, stage, follow-up, next step and notes", async () => {
  const { page, close } = await openPage();
  try {
    await openAdd(page);
    await page.fill("#se-add-domain", "https://every-field-f7.example.test/");
    await page.fill("#se-add-name", "Every Field F7");
    await page.click('[data-chip="soro|"]');
    await page.click("[data-other-toggle]");
    await page.fill("#se-add-other", "Acme Tools");
    await page.keyboard.press("Enter");
    assert.equal(await page.getAttribute('[data-chip="acme tools|"]', "aria-pressed"), "true", "the typed client is a chip");
    assert.equal(await page.isHidden("#se-add-other"), true, "the Other box closes after Add");
    assert.equal(await page.inputValue("#se-add-owner"), "Kamile", "owner defaults to me");
    await page.selectOption("#se-add-owner", "Gaby");
    const types = await page.$$eval("#se-add-type option", (os) => os.map((o) => o.textContent));
    assert.equal(types[0], "Type not set");
    assert.ok(types.includes("Review"));
    await page.selectOption("#se-add-type", "Review");
    await page.click(".se-more > summary");
    await page.selectOption("#se-add-stage", "Contacted");
    await page.fill("#se-add-due", "2026-11-05");
    await page.fill("#se-add-next", "Send the pitch");
    await page.fill("#se-add-notes", "Met at a meetup.");
    await page.click(ADD + " [data-add-submit]");
    await closedAdd(page);
    const id = await recFromHash(page);
    assert.ok(id);
    const rows = await editsOf(id);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].kind, "create_account");
    assert.equal(rows[0].by_whom, "Kamile");
    const v = JSON.parse(rows[0].new);
    delete v.added;
    assert.deepEqual(v, { domain: "every-field-f7.example.test", name: "Every Field F7", stage: "Contacted", owner: "Gaby",
      clients: "Soro, Acme Tools", type: "Review", next_step: "Send the pitch", next_due: "2026-11-05", notes: "Met at a meetup." });
  } finally {
    await close();
  }
});

test("Discard guard: Esc and × ask before dropping typed text; Keep editing keeps it; an untouched form just closes", async () => {
  const { page, close } = await openPage();
  try {
    await openAdd(page);
    await page.click(ADD + " .ui-modal-foot .ui-btn.is-ghost");
    // `n` right after the close (the closing form clears its state a task later): a new form opens.
    await page.waitForSelector(ADD, { state: "detached" });
    await openAdd(page);
    await page.fill("#se-add-domain", "discard-me-f7.example.test");
    await page.keyboard.press("Escape");
    await page.waitForSelector('dialog[open] >> text="Discard this site?"');
    await page.click('dialog[open] >> text="Keep editing"');
    await page.waitForSelector('dialog[open] >> text="Discard this site?"', { state: "detached" });
    assert.equal(await page.inputValue("#se-add-domain"), "discard-me-f7.example.test");
    await page.click(ADD + " .ui-x");
    await discard(page);
  } finally {
    await close();
  }
});

test("A 409 from the server (a site this page hasn't loaded) shows the same duplicate warning", async () => {
  const { page, close } = await openPage();
  try {
    await retry(() => d1("INSERT INTO partners (id, domain, name, owner, stage, clients, contacts, source) VALUES (" +
      [LATE.id, LATE.domain, LATE.name, LATE.owner, LATE.stage, LATE.clients].map(q).join(", ") + ", 0, 'Test')"));
    await openAdd(page);
    await page.fill("#se-add-domain", "https://www." + LATE.domain + "/x");
    await page.waitForFunction(() => /Not in the CRM yet/.test(document.querySelector("[data-domain-hint]").innerText));
    await page.click(ADD + " [data-add-submit]");
    const box = await waitFor(() => dupeBox(page), "the server's duplicate warning");
    assert.match(box, new RegExp("Late F7 Site " + LATE.domain.replace(/\./g, "\\.") + " Contacted · owned by Monica · Raibu"));
    assert.equal(await page.isVisible(ADD + ' [data-ask="' + LATE.id + '"]'), true, "Ask Monica");
    assert.equal(await page.isDisabled(ADD + " [data-add-submit]"), true);
    assert.equal(Number((await retry(() => d1("SELECT COUNT(*) AS c FROM partners WHERE domain = " + q(LATE.domain))))[0].c), 1, "nothing added");
    await page.keyboard.press("Escape");
    await discard(page);
  } finally {
    await close();
  }
});

test("P1: the name comes from the site's title while untouched; a near-identical name shows a hint", async () => {
  const { page, close } = await openPage();
  try {
    await page.route(/\/api\/about\?domain=/, (route) => route.fulfill({ status: 200, contentType: "application/json",
      body: JSON.stringify({ domain: "bright-ideas-f7.example.test", title: "Bright Ideas | Home", description: "" }) }));
    await openAdd(page);
    await page.fill("#se-add-domain", "bright-ideas-f7.example.test");
    await page.waitForFunction(() => document.querySelector("#se-add-name").value === "Bright Ideas");
    assert.match(await page.innerText("[data-name-hint]"), /From the site's title\. Change it if it's wrong\./);
    await page.fill("#se-add-name", "Mr Money Mattres");
    await page.waitForFunction(() => /Similar name in the CRM/.test(document.querySelector("[data-name-hint]").innerText));
    assert.match(await page.innerText("[data-name-hint]"), /Similar name in the CRM: Mr\. Money Matters \(Gaby\)/);
    await shot(page, "add-similar-1440");
    await page.keyboard.press("Escape");
    await discard(page);
  } finally {
    await close();
  }
});

// ---------- speed ----------

test("Search takes under 30 ms per keystroke on 7,500 sites and 6,000 contacts", async () => {
  const client = await apiClient(BASE);
  const list = (await client.call("GET", "/api/partners?v=2")).json;
  const idx = (await client.call("GET", "/api/contacts-index")).json;
  assert.ok(list && list.cols && idx && idx.cols, "the real list and index");
  const c = (k) => list.cols.indexOf(k);
  const rows = list.rows.slice();
  for (let k = 0; rows.length < 7500; k++) {
    const r = list.rows[k % list.rows.length].slice();
    r[c("id")] = "PG-" + String(20000 + k);
    if (r[c("domain")]) r[c("domain")] = "c" + k + "-" + String(r[c("domain")]).replace(/^youtube\.com\/@/, "yt-");
    if (r[c("name")]) r[c("name")] = r[c("name")] + " " + k;
    if (r[c("label")]) r[c("label")] = r[c("label")] + " " + k;
    rows.push(r);
  }
  const people = idx.rows.slice();
  const e = idx.cols.indexOf("email_lc");
  for (let k = 0; people.length < 6000; k++) {
    const r = idx.rows[k % idx.rows.length].slice();
    r[idx.cols.indexOf("id")] = "C-9" + String(k).padStart(5, "0");
    if (r[e]) r[e] = "x" + k + "." + r[e];
    people.push(r);
  }
  const big = JSON.stringify({ v: 2, cols: list.cols, rows });
  const bigIdx = JSON.stringify({ cols: idx.cols, rows: people });
  const { page, close } = await openPage();
  try {
    await page.route(/\/api\/partners\?v=2$/, (route) => route.fulfill({ status: 200, contentType: "application/json", body: big }));
    await page.route(/\/api\/contacts-index$/, (route) => route.fulfill({ status: 200, contentType: "application/json", body: bigIdx }));
    await page.reload();
    await waitFor(() => page.evaluate(async () => (await import("/js/core/store.js")).size() === 7500), "7,500 sites in the store", 30000);
    await openSearch(page);
    await search(page, "ot");
    await page.waitForSelector('.se-row[data-kind="contact"]');
    const res = await page.evaluate(() => {
      const input = document.querySelector(".se-input");
      const words = ["dupe.example.test", "https://www.mashable.com/tech/article-123", "mr money", "PG-00008", "new-3",
        "ann@x.example.test", "ottilie vance", "hosting review", "soro", "zzzzqqq"];
      const times = [];
      for (const w of words) {
        input.value = "";
        input.dispatchEvent(new Event("input", { bubbles: true }));
        for (let i = 1; i <= w.length; i++) {
          input.value = w.slice(0, i);
          const t = performance.now();
          input.dispatchEvent(new Event("input", { bubbles: true }));
          void document.querySelector(".se-dialog").getBoundingClientRect().height; // style and layout too
          times.push({ q: w.slice(0, i), ms: performance.now() - t });
        }
      }
      const ms = times.map((x) => x.ms).sort((a, b) => a - b);
      return { keystrokes: ms.length, median: ms[ms.length >> 1], p95: ms[Math.floor(ms.length * 0.95)], max: ms[ms.length - 1],
        slowest: times.sort((a, b) => b.ms - a.ms)[0] };
    });
    console.log("# search speed on 7,500 sites and 6,000 contacts: " + JSON.stringify(res));
    assert.ok(res.max < 30, "every keystroke under 30 ms (slowest " + JSON.stringify(res.slowest) + ")");
  } finally {
    await close();
  }
});

// ---------- phone ----------

test("Phone 390×844: full-screen Search with Cancel; Add site without autofocus, a sticky footer, 16 px inputs and 44 px targets", async () => {
  const { page, watch, close } = await openPage({ name: "Jonas", viewport: PHONE, contextOptions: PHONE_OPTS });
  try {
    await page.click('.sh-tabs [data-act="search"]');
    await page.waitForSelector(DIALOG);
    await search(page, "example");
    const s = await page.evaluate(() => {
      const d = document.querySelector(".se-dialog").getBoundingClientRect();
      const vis = (sel) => { const el = document.querySelector(sel); return !!el && getComputedStyle(el).display !== "none"; };
      const rows = Array.from(document.querySelectorAll(".se-row")).map((r) => r.getBoundingClientRect().height);
      return { w: d.width, h: d.height, cancel: vis(".se-cancel"), esc: vis(".se-esc"), keys: vis(".se-keys"),
        font: parseFloat(getComputedStyle(document.querySelector(".se-input")).fontSize), minRow: Math.min(...rows),
        close: document.querySelector(".se-close").getBoundingClientRect().height, scroll: document.querySelector(".se-dialog").scrollWidth };
    });
    assert.deepEqual({ w: s.w, h: s.h, cancel: s.cancel, esc: s.esc, keys: s.keys }, { w: 390, h: 844, cancel: true, esc: false, keys: false });
    assert.ok(s.font >= 16, "search input 16 px");
    assert.ok(s.minRow >= 44 && s.close >= 44, "44 px targets");
    assert.ok(s.scroll <= 390, "no horizontal scroll");
    await shot(page, "search-jonas-390");
    await page.click(".se-close");
    await page.waitForSelector(DIALOG, { state: "detached" });

    await page.click('button[data-act="add"]:visible');
    await page.waitForSelector(ADD);
    assert.notEqual(await page.evaluate(() => document.activeElement && document.activeElement.tagName), "INPUT", "no autofocus on phones");
    await shot(page, "add-open-390");
    await page.fill("#se-add-domain", "https://www.dupe.example.test/a/b?x=1");
    await waitFor(() => dupeBox(page), "the duplicate warning");
    await shot(page, "add-duplicate-390");
    await page.click('[data-group="melograno"]');
    const m = await page.evaluate(() => {
      const foot = document.querySelector(".se-addmodal .ui-modal-foot").getBoundingClientRect();
      const inputs = Array.from(document.querySelectorAll(".se-addmodal input, .se-addmodal select, .se-addmodal textarea"))
        .filter((el) => el.getClientRects().length).map((el) => parseFloat(getComputedStyle(el).fontSize));
      const small = Array.from(document.querySelectorAll(".se-addmodal button, .se-addmodal summary"))
        .filter((el) => el.getClientRects().length && el.getBoundingClientRect().height < 44)
        .map((el) => el.textContent.trim().slice(0, 30));
      return { footTop: foot.top, footBottom: foot.bottom, minFont: Math.min(...inputs), small, scroll: document.scrollingElement.scrollWidth };
    });
    assert.ok(m.footBottom <= 844 && m.footTop > 600, "the footer stays at the bottom of the screen (" + m.footTop + "–" + m.footBottom + ")");
    assert.ok(m.minFont >= 16, "inputs are 16 px (" + m.minFont + ")");
    assert.deepEqual(m.small, [], "44 px targets");
    assert.ok(m.scroll <= 390, "no horizontal scroll");
    await page.click(ADD + " .ui-x");
    await discard(page);
    assert.deepEqual(watch.pageErrors, []);
  } finally {
    await close();
  }
});

// ---------- accessibility ----------

test("axe: no serious or critical issues in Search and Add site (light and dark)", async () => {
  const axeSrc = fs.readFileSync(tools().axe, "utf8");
  const check = (page, sel) => page.evaluate(async (s) => {
    const r = await window.axe.run({ include: [[s]] }, { resultTypes: ["violations"] });
    return r.violations.filter((v) => v.impact === "serious" || v.impact === "critical")
      .map((v) => v.id + ": " + v.help + " -> " + v.nodes.slice(0, 3).map((n) => n.target.join(" ")).join(" | "));
  }, sel);
  for (const colorScheme of ["light", "dark"]) {
    const { page, close } = await openPage({ colorScheme });
    try {
      await page.evaluate(axeSrc);
      await openSearch(page);
      await search(page, "ann@x.example.test");
      await page.waitForSelector('.se-row[data-kind="contact"]');
      await settled(page);
      assert.deepEqual(await check(page, ".se-dialog"), [], colorScheme + ": search");
      await search(page, ID.claim);
      await settled(page);
      assert.deepEqual(await check(page, ".se-dialog"), [], colorScheme + ": search with Claim");
      if (colorScheme === "dark") await shot(page, "search-dark-1440");
      await page.keyboard.press("Escape");
      await openAdd(page);
      await page.fill("#se-add-domain", "https://www.dupe.example.test/a/b?x=1");
      await waitFor(() => dupeBox(page), "the duplicate warning");
      await page.click('[data-group="melograno"]');
      await page.click(".se-more > summary");
      await settled(page);
      assert.deepEqual(await check(page, ".se-addmodal"), [], colorScheme + ": add site");
      if (colorScheme === "dark") await shot(page, "add-dark-1440");
    } finally {
      await close();
    }
  }
});
