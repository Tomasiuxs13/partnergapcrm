// Clients, client page and monthly report (spec 2.2.4, Appendix B.6; tests T8, T19, T23). Owner F5.
// Run: bash tests/e2e/run.sh tests/e2e/50-clients.test.mjs   (screenshots: SHOTS_DIR, default /tmp/shots-f5)
//
// Read-only tests first (the list and its totals, the client page and its links, Melograno's product chips,
// the report and its marker test, phone layout, axe), then the writes: T8 (Add site for Melograno → Amelia
// from the client page) and T23 (the Botanical Synthesis program edit). Expected numbers are counted here
// from the fixture rows with meta.splitClients, not with the page's own rules. after() deletes the site and
// edits rows the tests add, and puts the program row and the kv_meta keys back.
// One mock: GET /api/clients answers 404 for the "Not available yet" test.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  baseUrl, browser, signIn, signedInPage, closeBrowser, d1, maxEditN, editsAfter, pageFetch, fixture, tools,
} from "./lib.mjs";
import { fixtureMeta } from "../fixtures/make-seed.mjs";
import { splitClients } from "../../crm/dashboard/js/core/meta.js";

const BASE = baseUrl();
const SHOTS = process.env.SHOTS_DIR || "/tmp/shots-f5";
const fx = fixture();
const TODAY = fx.today || process.env.FIXTURE_TODAY;
const META = fixtureMeta();
const DESKTOP = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };
const PHONE_OPTS = { hasTouch: true, isMobile: true };
const CLIP = { permissions: ["clipboard-read", "clipboard-write"] };
const TEAM = ["Jonas", "Vik", "Kamile", "Eivyda", "Monica", "Mantvydas", "Gaby", "Sandra", "Tomas", "Denisse", "Egle", "Jay"];
const MARKER = "INTERNAL-MARKER-7";
const REPORT = ".rp-modal[open]";
const ADD = ".se-addmodal[open]";
const P = "#layer-panel ";
const PROGRAM = '[data-cl-card="program"]';
const BS = "botanical synthesis";
const KV_KEYS = ["new_site_n", "sheet_sig", "last_sheet_change"];
const PROG_COLS = ["k", "network", "commission", "cookie_days", "payout_terms", "signup_url", "brief", "updated_at", "updated_by"];

let n0 = 0;
let act0 = 0;
let newIds0 = [];
let kv0 = [];
let prog0 = null;
let hasKv = String(process.env.D1_TABLES || "").split(",").includes("kv_meta");

// ---------- expected numbers, from the fixture rows ----------

const byId = new Map(fx.partners.map((p) => [p.id, p]));
const keysOf = (p) => new Set(splitClients(META, p.clients).map((x) => x.k));
const productsOf = (p, k) => splitClients(META, p.clients).filter((x) => x.k === k).map((x) => String(x.product || "").toLowerCase());
const sitesOf = (k, product) => fx.partners.filter((p) => keysOf(p).has(k) && (!product || productsOf(p, k).includes(product.toLowerCase())));
const NOT_CONTACTED = ["New", "Researching"];
function expect(list) {
  const st = (s) => list.filter((p) => p.stage === s).length;
  return {
    sites: list.length,
    prospects: st("New") + st("Researching"),
    emailed: st("Contacted"),
    replied: st("Replied"),
    inTalks: st("Negotiating"),
    active: st("Active"),
    live: list.filter((p) => p.stage === "Active" && p.content_url).length,
    contacted: list.filter((p) => p.stage && !NOT_CONTACTED.includes(p.stage)).length,
    wroteBack: st("Replied") + st("Negotiating") + st("Active") + st("Lost"),
  };
}
const SORO = expect(sitesOf("soro"));
const ACTIVE_KEYS = new Set(META.clients.map((c) => c.k));
const TOTALS = expect(fx.partners.filter((p) => [...keysOf(p)].some((k) => ACTIVE_KEYS.has(k))));
const group = (tag) => {
  const ids = fx.groups[tag];
  assert.ok(ids && ids.length, "fixture group " + tag);
  return ids;
};
const nameOf = (id) => byId.get(id).name;

const LAST_MONTH = (() => {
  const d = new Date(TODAY.slice(0, 7) + "-15T12:00:00Z");
  d.setUTCMonth(d.getUTCMonth() - 1);
  return d.toISOString().slice(0, 7);
})();
const monthName = (ym) => new Date(ym + "-15T12:00:00Z").toLocaleDateString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" });

// ---------- helpers ----------

async function retry(fn, tries = 6) {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (e) {
      if (i >= tries || !/SQLITE_BUSY|database is locked/i.test(String(e && e.message))) throw e;
      await new Promise((r) => setTimeout(r, 500 * (i + 1)));
    }
  }
}

const q = (v) => (v == null ? "NULL" : typeof v === "number" ? String(v) : "'" + String(v).replace(/'/g, "''") + "'");
const inList = (xs) => "(" + xs.map(q).join(", ") + ")";

async function waitFor(fn, what, ms = 15000) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    last = await fn();
    if (last) return last;
    await new Promise((r) => setTimeout(r, 300));
  }
  assert.fail("timed out waiting for " + what);
}

function settled(page) {
  return page.waitForFunction(() => document.getAnimations().every((a) =>
    a.playState !== "running" || (a.effect && a.effect.getComputedTiming().iterations === Infinity)));
}

async function shot(page, name, opts = {}) {
  await settled(page);
  return page.screenshot({ path: path.join(SHOTS, name + ".png"), ...opts });
}

async function toastWith(page, text) {
  const t = page.locator("#toasts .ui-toast", { hasText: text }).last();
  await t.waitFor({ state: "visible", timeout: 10000 });
  return t;
}

async function noHorizontalScroll(page, where) {
  const { sw, cw } = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
  assert.ok(sw <= cw, where + ": no horizontal scroll (" + sw + " > " + cw + ")");
}

const clean = (s) => String(s || "").replace(/\s+/g, " ").trim();
const text = async (page, sel) => clean(await page.innerText(sel));

// The page's clock is the fixture day (noon, local time), so "last month" matches the fixture on any day.
async function open(hash, o = {}) {
  const s = await signedInPage({ viewport: DESKTOP, clock: TODAY + "T12:00:00", ...o });
  await s.page.goto(BASE + "/" + hash);
  return s;
}

async function openList(o = {}) {
  const s = await open("#clients", o);
  await s.page.waitForSelector(".cl-list .cl-table", { timeout: 20000 });
  return s;
}

async function openClient(slug, o = {}) {
  const s = await open("#clients/" + slug, o);
  await s.page.waitForSelector(".cl-client .cl-tiles", { timeout: 20000 });
  await programLoaded(s.page);
  return s;
}

const programLoaded = (page) => page.waitForFunction((sel) => {
  const box = document.querySelector(sel);
  return box && !box.querySelector(".ui-skeleton");
}, PROGRAM, { timeout: 15000 });

// The list row of a client: {label: value} of its number cells, plus name and manager.
async function listRow(page, slug) {
  return page.$eval('.cl-list .cl-table:not(.is-past) tr[data-cl-go="' + slug + '"]', (tr) => {
    const out = { name: tr.querySelector(".cl-name").textContent.trim(), manager: tr.querySelector(".cl-c-mgr").textContent.trim() };
    for (const td of tr.querySelectorAll(".cl-c-num")) out[td.getAttribute("data-label")] = Number(td.textContent.replace(/[^\d]/g, ""));
    return out;
  });
}

async function tile(page, k) {
  return page.$eval('[data-cl-tile="' + k + '"]', (t) => ({
    n: t.querySelector(".cl-tile-n").textContent.trim(),
    href: t.getAttribute("href"),
    sub: (t.querySelector(".cl-tile-s") || { textContent: "" }).textContent.trim(),
  }));
}

const rowIds = (page, sec) => page.$$eval('[data-cl-card="' + sec + '"] .cl-srow', (ls) => ls.map((l) => l.getAttribute("data-rec")));

// The Sites list count after following a link ("85 sites").
async function sitesCount(page) {
  await page.waitForSelector(".si-head, .ui-list-count", { state: "attached", timeout: 20000 });
  await page.waitForFunction(() => {
    const c = document.querySelector(".ui-list-count");
    return c && /\d/.test(c.textContent);
  }, null, { timeout: 15000 });
  return Number((await page.textContent(".ui-list-count")).replace(/[^\d]/g, ""));
}

// Client-safe check of a text: no marker, owner names, internal ids or email addresses.
function assertClientSafe(t, where) {
  assert.ok(!t.includes(MARKER), where + ": no " + MARKER);
  assert.ok(!/\b(PG|NEW)-\d+/.test(t), where + ": no internal ids");
  assert.ok(!/@/.test(t), where + ": no email addresses");
  for (const n of TEAM) assert.ok(!new RegExp("\\b" + n + "\\b").test(t), where + ": no owner name " + n);
}

async function axeCheck(page, include, where) {
  const axeSrc = fs.readFileSync(tools().axe, "utf8");
  await settled(page);
  await page.evaluate(axeSrc);
  const res = await page.evaluate(async (inc) => {
    const r = await window.axe.run({ include: inc }, { resultTypes: ["violations"] });
    return r.violations.filter((v) => v.impact === "serious" || v.impact === "critical")
      .map((v) => v.id + ": " + v.help + " -> " + v.nodes.slice(0, 3).map((n) => n.target.join(" ")).join(" | "));
  }, include);
  assert.deepEqual(res, [], where);
}

async function readProgram() {
  const obj = "json_object(" + PROG_COLS.map((c) => "'" + c + "', " + c).join(", ") + ")";
  const rows = await retry(() => d1("SELECT " + obj + " AS j FROM client_programs WHERE k = " + q(BS), { rawNulls: true }));
  return rows.length ? JSON.parse(rows[0].j) : null;
}

// ---------- setup / teardown ----------

before(async () => {
  assert.ok(BASE, "BASE_URL is set (run through tests/e2e/run.sh)");
  assert.ok(!/:8788\b/.test(BASE), "never the main dev server");
  fs.mkdirSync(SHOTS, { recursive: true });
  n0 = Number(await retry(() => maxEditN()));
  act0 = Number((await retry(() => d1("SELECT COALESCE(MAX(n), 0) AS n FROM activity")))[0].n);
  newIds0 = (await retry(() => d1("SELECT id FROM partners WHERE id LIKE 'NEW-%'"))).map((r) => r.id);
  if (!hasKv) hasKv = (await retry(() => d1("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'kv_meta'"))).length > 0;
  if (hasKv) kv0 = await retry(() => d1("SELECT k, v, at, by_whom FROM kv_meta WHERE k IN " + inList(KV_KEYS), { rawNulls: true }));
  prog0 = await readProgram();
});

after(async () => {
  try {
    const added = (await retry(() => d1("SELECT id FROM partners WHERE id LIKE 'NEW-%'" +
      (newIds0.length ? " AND id NOT IN " + inList(newIds0) : "")))).map((r) => r.id);
    if (added.length) {
      await retry(() => d1("DELETE FROM contacts WHERE account_id IN " + inList(added)));
      await retry(() => d1("DELETE FROM partners WHERE id IN " + inList(added)));
    }
    await retry(() => d1("DELETE FROM activity WHERE n > " + act0));
    await retry(() => d1("DELETE FROM edits WHERE n > " + n0));
    await retry(() => d1("DELETE FROM client_programs WHERE k = " + q(BS)));
    if (prog0) {
      await retry(() => d1("INSERT INTO client_programs (" + PROG_COLS.join(", ") + ") VALUES (" + PROG_COLS.map((c) => q(prog0[c])).join(", ") + ")"));
    }
    if (hasKv) {
      await retry(() => d1("DELETE FROM kv_meta WHERE k IN " + inList(KV_KEYS)));
      for (const r of kv0) {
        await retry(() => d1("INSERT INTO kv_meta (k, v, at, by_whom) VALUES (" + [r.k, r.v, r.at, r.by_whom].map(q).join(", ") + ")"));
      }
    }
  } finally {
    await closeBrowser();
  }
});

// ---------- Clients list ----------

test("Clients list: six columns, one row per active client, the totals row and the past clients", async () => {
  const { page, watch, close } = await openList({ name: "Kamile" });
  try {
    const heads = await page.$$eval(".cl-list .cl-table:not(.is-past) thead th .cl-th, .cl-list .cl-table:not(.is-past) thead th.cl-c-name, .cl-list .cl-table:not(.is-past) thead th.cl-c-mgr",
      (ths) => ths.map((t) => t.textContent.trim()));
    assert.deepEqual(heads, ["Client", "Manager", "Prospects", "Emailed", "Deals in talks", "Live partners"]);
    const slugs = await page.$$eval(".cl-list .cl-table:not(.is-past) tbody tr", (trs) => trs.map((t) => t.getAttribute("data-cl-go")));
    assert.equal(slugs.length, META.clients.length);
    assert.equal(slugs[0], "soro");
    assert.ok(slugs.includes("botanical-synthesis"), "the slug has '-' for the space");

    const soro = await listRow(page, "soro");
    assert.equal(soro.name, "Soro");
    assert.equal(soro.manager, "Jonas and Vik");
    assert.deepEqual([soro.Prospects, soro.Emailed, soro["Deals in talks"], soro["Live partners"]],
      [SORO.prospects, SORO.emailed, SORO.inTalks, SORO.live]);
    const u = await listRow(page, "ultahost");
    const ul = expect(sitesOf("ultahost"));
    assert.deepEqual([u.Prospects, u.Emailed, u["Deals in talks"]], [ul.prospects, ul.emailed, ul.inTalks], "both UltaHost spellings count");

    const total = await page.$eval(".cl-list tfoot tr", (tr) => {
      const out = { label: tr.querySelector(".cl-c-name").textContent.replace(/\s+/g, " ").trim() };
      for (const td of tr.querySelectorAll(".cl-c-num")) out[td.getAttribute("data-label")] = Number(td.textContent.replace(/[^\d]/g, ""));
      return out;
    });
    assert.match(total.label, /^All clients/);
    assert.match(total.label, /each site counted once/);
    assert.deepEqual([total.Prospects, total.Emailed, total["Deals in talks"], total["Live partners"]],
      [TOTALS.prospects, TOTALS.emailed, TOTALS.inTalks, TOTALS.live]);
    assert.equal(await page.$$eval(".cl-list .cl-table:not(.is-past) [data-cl-report]", (bs) => bs.length), META.clients.length, "a Report button per active client");

    // Past clients: collapsed, then two rows without a Report button.
    assert.equal(await page.$eval("details[data-cl-past]", (d) => d.open), false);
    assert.match(await text(page, ".cl-past-sum"), /Past clients \(2\)/);
    await page.click(".cl-past-sum");
    const past = await page.$$eval(".cl-table.is-past tbody tr", (trs) => trs.map((t) => t.querySelector(".cl-name").textContent.trim()));
    assert.deepEqual(past, ["Weglot", "Termly"]);
    assert.equal(await page.$$eval(".cl-table.is-past [data-cl-report]", (bs) => bs.length), 0);
    await shot(page, "clients-kamile-1440", { fullPage: true });

    // A click anywhere on the row opens the client page.
    await page.click('tr[data-cl-go="soro"] .cl-c-mgr');
    await page.waitForSelector(".cl-client h1");
    assert.equal(await page.evaluate(() => location.hash), "#clients/soro");
    assert.equal(await text(page, ".cl-client h1"), "Soro");
    assert.deepEqual(watch.pageErrors, []);
  } finally {
    await close();
  }
});

test("Report from the Clients list opens that client's report", async () => {
  const { page, close } = await openList({ name: "Jonas" });
  try {
    await page.click('.cl-list [data-cl-report="transfergo"]');
    await page.waitForSelector(REPORT + " .rp-title");
    assert.equal(await text(page, REPORT + " .ui-modal-title"), "Monthly report · TransferGO");
    assert.match(await text(page, REPORT + " .rp-title"), /^TransferGO affiliate report, /);
    await page.keyboard.press("Escape");
    await page.waitForSelector(REPORT, { state: "detached" });
  } finally {
    await close();
  }
});

// ---------- Client page ----------

test("Client page: header, numbers strip, sections and links (Soro)", async () => {
  const { page, watch, close } = await openClient("soro", { name: "Jonas" });
  try {
    assert.equal(await text(page, ".cl-client h1"), "Soro");
    assert.match(await text(page, ".cl-client .cl-sub"), /Managed by Jonas and Vik/);
    const acts = await page.$$eval(".cl-head-acts > *", (els) => els.map((e) => e.textContent.trim()));
    assert.deepEqual(acts, ["Report", "+ Add site for Soro", "See all " + SORO.sites + " sites"]);

    // Numbers strip.
    assert.equal((await tile(page, "prospects")).n, String(SORO.prospects));
    assert.equal((await tile(page, "emailed")).n, String(SORO.emailed));
    assert.equal((await tile(page, "replied")).n, String(SORO.replied));
    assert.equal((await tile(page, "talks")).n, String(SORO.inTalks));
    assert.equal((await tile(page, "active")).n, String(SORO.active));
    assert.equal((await tile(page, "live")).n, String(SORO.live));
    const rate = await tile(page, "rate");
    assert.equal(rate.n, Math.round((SORO.wroteBack / SORO.contacted) * 100) + "%");
    assert.equal(rate.sub, SORO.wroteBack + " of " + SORO.contacted);
    assert.match(await text(page, ".cl-note"), /Outreach is in test mode\./);
    const emailed = (await tile(page, "emailed")).href;
    assert.match(emailed, /^#sites\?/);
    const ep = new URLSearchParams(emailed.split("?")[1]);
    assert.deepEqual([ep.get("tab"), ep.get("client"), ep.get("stage"), ep.get("big")], ["all", "soro", "Contacted", "1"]);

    // Waiting on Soro, Deals, Live placements, Best new prospects, Pipeline.
    const waitIds = group("waiting-on-client").filter((id) => keysOf(byId.get(id)).has("soro"));
    assert.deepEqual((await rowIds(page, "waiting")).sort(), waitIds.sort());
    assert.match(await text(page, '[data-cl-card="waiting"] .cl-h'), /^Waiting on Soro \(1\)$/);
    assert.match(await text(page, '[data-cl-card="waiting"] .cl-l2'), /Soro to approve the fee/);
    assert.equal((await rowIds(page, "deals")).length, SORO.inTalks + SORO.active);
    const marker = group("internal-marker")[0];
    assert.match(await text(page, '[data-cl-card="deals"] [data-rec="' + marker + '"] .cl-l2'), /No terms yet/);
    const live = await rowIds(page, "live");
    assert.equal(live.length, SORO.live);
    for (const id of group("soro-live-last-month")) assert.ok(live.includes(id), "live " + id);
    assert.match(await text(page, '[data-cl-card="live"] [data-rec="' + group("active-future-live")[0] + '"]'), /Goes live/);
    const best = await rowIds(page, "prospects");
    assert.ok(best.length > 0 && best.length <= 10);
    const platform = new Set(fx.groups.platform || []);
    assert.ok(best.every((id) => !platform.has(id) && NOT_CONTACTED.includes(byId.get(id).stage)), "new, not a big site");
    const bars = await page.getAttribute('[data-cl-card="pipeline"] figure', "aria-label");
    assert.match(bars, new RegExp("Contacted " + SORO.emailed + "\\b"));
    assert.match(bars, new RegExp("Negotiating " + SORO.inTalks + "\\b"));
    await shot(page, "client-soro-jonas-1440", { fullPage: true });

    // A row opens the record panel in queue mode over its section.
    const first = (await rowIds(page, "deals"))[0];
    await page.click('[data-cl-card="deals"] [data-rec="' + first + '"] a[data-open]');
    await page.waitForSelector(P + ".ui-queue-text");
    assert.match(await text(page, P + ".ui-queue-text"), new RegExp("1 of " + (SORO.inTalks + SORO.active) + " · Soro · Deals"));
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => !/[?&]rec=/.test(location.hash));

    // "See all N sites" opens Sites › All for Soro with the same count.
    await page.click('[data-cl-key="act:all"]');
    await page.waitForFunction(() => location.hash.startsWith("#sites"));
    assert.equal(await sitesCount(page), SORO.sites);
    assert.deepEqual(watch.pageErrors, []);
  } finally {
    await close();
  }
});

test("Copy list for client puts a client-safe list on the clipboard", async () => {
  const { page, close } = await openClient("soro", { name: "Jonas", contextOptions: CLIP });
  try {
    await page.click('[data-cl-act="copy-waiting"]');
    await toastWith(page, "List copied. Paste it into your message to Soro.");
    const clip = await page.evaluate(() => navigator.clipboard.readText());
    const id = group("waiting-on-client").find((x) => keysOf(byId.get(x)).has("soro"));
    assert.match(clip, /^Waiting on Soro \(/);
    assert.ok(clip.includes("- " + nameOf(id) + " (Flat fee · $500): Soro to approve the fee"), clip);
    assert.ok(!/Waiting on client:/i.test(clip));
    assertClientSafe(clip, "copy list");
  } finally {
    await close();
  }
});

test("Melograno: product chips filter every section in place", async () => {
  const { page, close } = await openClient("melograno", { name: "Eivyda" });
  try {
    const chips = await page.$$eval("[data-cl-product]", (bs) => bs.map((b) => [b.textContent.trim(), b.getAttribute("aria-pressed")]));
    assert.deepEqual(chips.map((c) => c[0]), ["All", "Trafft", "Amelia", "wpDataTables", "IvyForms"]);
    assert.equal(chips[0][1], "true");
    await page.evaluate(() => { document.querySelector(".cl-page").dataset.mark = "same"; });
    const all = expect(sitesOf("melograno"));
    assert.match(await text(page, '[data-cl-key="act:all"]'), new RegExp("See all " + all.sites + " sites"));

    await page.click('[data-cl-product="Trafft"]');
    await page.waitForFunction(() => /[?&]product=Trafft\b/.test(location.hash));
    await page.waitForSelector('[data-cl-product="Trafft"][aria-pressed="true"]');
    const trafft = expect(sitesOf("melograno", "Trafft"));
    await page.waitForFunction((n) => (document.querySelector('[data-cl-key="act:all"]') || {}).textContent === "See all " + n + " sites", trafft.sites);
    assert.match(await text(page, '[data-cl-card="waiting"] .cl-h'), /^Waiting on Melograno - Trafft/);
    assert.equal(await text(page, '[data-cl-act="add"]'), "+ Add site for Melograno - Trafft");
    const href = await page.getAttribute('[data-cl-key="act:all"]', "href");
    assert.equal(new URLSearchParams(href.split("?")[1]).get("client"), "melograno-trafft");
    assert.equal((await tile(page, "talks")).n, String(trafft.inTalks));
    await shot(page, "client-melograno-trafft-1440", { fullPage: true });

    await page.click('[data-cl-product="Amelia"]');
    await page.waitForFunction(() => /[?&]product=Amelia\b/.test(location.hash));
    await page.waitForFunction(() => (document.querySelector('[data-cl-key="act:all"]') || {}).textContent === "See all 0 sites");
    assert.equal(await page.$('[data-cl-card="waiting"]'), null, "Waiting on client hides when empty");

    await page.click('[data-cl-product=""]');
    await page.waitForFunction(() => !/product=/.test(location.hash));
    assert.equal(await page.evaluate(() => document.querySelector(".cl-page").dataset.mark), "same", "the page patched in place");
  } finally {
    await close();
  }
});

test("Affiliate program: the card shows the stored program; Not available yet when /api/clients is missing", async () => {
  const s1 = await openClient("botanical-synthesis", { name: "Eivyda" });
  try {
    const dl = await text(s1.page, PROGRAM + " .cl-dl");
    assert.ok(prog0, "the fixture has a program row for 'botanical synthesis'");
    assert.ok(dl.includes(prog0.commission) && dl.includes(prog0.network), dl);
  } finally {
    await s1.close();
  }
  const context = await (await browser()).newContext({ viewport: DESKTOP });
  try {
    const page = await context.newPage();
    await signIn(page, { name: "Eivyda" });
    await page.route(/\/api\/clients$/, (route) => (route.request().method() === "GET"
      ? route.fulfill({ status: 404, contentType: "text/plain", body: "Not found" }) : route.continue()));
    await page.goto(BASE + "/#clients/botanical-synthesis");
    await page.waitForSelector(".cl-tiles");
    await programLoaded(page);
    assert.equal(await text(page, PROGRAM + " .cl-none"), "Not available yet.");
    assert.equal(await page.$(PROGRAM + ' [data-cl-act="prog-edit"]'), null);
  } finally {
    await context.close();
  }
});

test("An unknown client address says so", async () => {
  const { page, close } = await open("#clients/no-such-client", { name: "Kamile" });
  try {
    await page.waitForSelector(".cl-page h1");
    assert.equal(await text(page, ".cl-page h1"), "Client not found");
    await page.click('.cl-page a.ui-btn');
    await page.waitForSelector(".cl-list .cl-table");
  } finally {
    await close();
  }
});

// ---------- Report (T19) ----------

test("T19: Soro's report for last month is client-safe; Copy, Print and print CSS work", async () => {
  const { page, watch, close } = await openClient("soro", { name: "Jonas", contextOptions: CLIP });
  try {
    await page.click('[data-cl-act="report"]');
    await page.waitForSelector(REPORT + " .rp-title");
    assert.equal(await page.$eval(REPORT + " [data-rp-month]", (s) => s.value), LAST_MONTH, "defaults to last month");
    assert.equal(await page.$$eval(REPORT + " [data-rp-month] option", (os) => os.length), 6, "this month and the 5 before");
    const label = monthName(LAST_MONTH);
    assert.equal(await text(page, REPORT + " .rp-title"), "Soro affiliate report, " + label);

    const doc = await text(page, REPORT + " [data-rp-doc]");
    for (const id of group("soro-live-last-month")) assert.ok(doc.includes(nameOf(id)), "placement " + nameOf(id));
    const future = group("active-future-live")[0];
    assert.ok(!doc.includes(nameOf(future)), "the future live date is left out");
    assert.ok(doc.includes(nameOf(group("internal-marker")[0]) + ": terms not agreed yet"));
    const warn = await text(page, REPORT + " [data-rp-warn]");
    assert.match(warn, /Check before you send/);
    assert.match(warn, /live date after today/);
    assert.match(warn, /no terms yet/);
    assertClientSafe(await text(page, REPORT), "report modal");

    // Copy as email.
    await page.click(REPORT + " [data-rp-copy]");
    await toastWith(page, "Report copied.");
    const clip = await page.evaluate(() => navigator.clipboard.readText());
    assert.match(clip, new RegExp("^Soro affiliate report, " + label));
    for (const id of group("soro-live-last-month")) assert.ok(clip.includes(nameOf(id)));
    assertClientSafe(clip, "copied report");

    // Print / Save as PDF calls window.print (stubbed), and the print CSS prints the report alone.
    await page.evaluate(() => { window.__printed = 0; window.print = () => { window.__printed++; }; });
    await page.click(REPORT + " [data-rp-print]");
    assert.equal(await page.evaluate(() => window.__printed), 1);
    await page.emulateMedia({ media: "print" });
    const printed = await page.evaluate((sel) => {
      const vis = (el) => !!el && getComputedStyle(el).display !== "none" && el.getClientRects().length > 0;
      const m = document.querySelector(sel);
      return {
        app: vis(document.querySelector(".app")),
        doc: vis(m.querySelector("[data-rp-doc]")),
        month: vis(m.querySelector("[data-rp-month]")),
        warn: vis(m.querySelector("[data-rp-warn]")),
        copy: vis(m.querySelector("[data-rp-copy]")),
      };
    }, REPORT);
    assert.deepEqual(printed, { app: false, doc: true, month: false, warn: false, copy: false });
    await shot(page, "report-soro-print", { fullPage: true });
    await page.emulateMedia({ media: null });

    // Another month: a month without placements says so.
    const soroLive = sitesOf("soro").map((p) => String(p.live_date || "").slice(0, 7));
    const months = await page.$$eval(REPORT + " [data-rp-month] option", (os) => os.map((o) => o.value));
    const empty = months.find((m) => m <= TODAY.slice(0, 7) && !soroLive.includes(m));
    assert.ok(empty, "a month without Soro placements");
    await page.selectOption(REPORT + " [data-rp-month]", empty);
    await page.waitForFunction(([sel, t]) => document.querySelector(sel).textContent.includes(t),
      [REPORT + " [data-rp-doc]", "None went live in " + monthName(empty) + "."]);
    assertClientSafe(await text(page, REPORT), "report " + empty);
    await shot(page, "report-soro-jonas-1440");
    assert.deepEqual(watch.pageErrors, []);
  } finally {
    await close();
  }
});

// ---------- Phone ----------

test("Phone (390 px): list rows are cards; client page and report fit without sideways scroll", async () => {
  const { page, close } = await openList({ name: "Kamile", viewport: PHONE, contextOptions: PHONE_OPTS });
  try {
    assert.equal(await page.$eval(".cl-list thead", (t) => getComputedStyle(t).display), "none");
    const card = await page.$eval('.cl-list tr[data-cl-go="soro"]', (tr) => {
      const r = tr.getBoundingClientRect();
      const b = tr.querySelector("[data-cl-report]").getBoundingClientRect();
      const nums = Array.from(tr.querySelectorAll(".cl-c-num")).map((td) => td.getBoundingClientRect());
      return { w: r.width, btnIn: b.right <= r.right + 1 && b.height >= 44, numsOneRow: nums.every((n) => Math.abs(n.top - nums[0].top) < 2),
        labels: Array.from(tr.querySelectorAll(".cl-c-num")).map((td) => getComputedStyle(td, "::before").content) };
    });
    assert.ok(card.btnIn, "Report fits in the card with a 44 px target");
    assert.ok(card.numsOneRow, "the four numbers sit in one row");
    assert.deepEqual(card.labels, ['"Prospects"', '"Emailed"', '"Deals in talks"', '"Live partners"']);
    await noHorizontalScroll(page, "Clients list");
    await shot(page, "clients-kamile-390", { fullPage: true });

    await page.goto(BASE + "/#clients/soro");
    await page.waitForSelector(".cl-client .cl-tiles");
    await programLoaded(page);
    await noHorizontalScroll(page, "client page");
    await shot(page, "client-soro-kamile-390", { fullPage: true });
    await page.click('[data-cl-act="report"]');
    await page.waitForSelector(REPORT + " .rp-title");
    await noHorizontalScroll(page, "report");
    const foot = await page.$eval(REPORT + " .ui-modal-foot", (f) => f.getBoundingClientRect().bottom);
    assert.ok(foot <= PHONE.height + 1, "the report's actions are on screen");
    await shot(page, "report-soro-kamile-390");
  } finally {
    await close();
  }
});

test("axe: no serious or critical issues on Clients, a client page and the report (light and dark)", async () => {
  for (const colorScheme of ["light", "dark"]) {
    const { page, close } = await openList({ name: "Jonas", colorScheme });
    try {
      await page.click(".cl-past-sum");
      await axeCheck(page, [["main"]], "Clients " + colorScheme);
      await page.goto(BASE + "/#clients/melograno?product=Trafft");
      await page.waitForSelector(".cl-client .cl-tiles");
      await programLoaded(page);
      await axeCheck(page, [["main"]], "Melograno " + colorScheme);
      await page.goto(BASE + "/#clients/soro");
      await page.waitForSelector(".cl-client .cl-tiles");
      await programLoaded(page);
      await axeCheck(page, [["main"]], "Soro " + colorScheme);
      if (colorScheme === "dark") await shot(page, "client-soro-jonas-1440-dark", { fullPage: true });
      await page.click('[data-cl-act="report"]');
      await page.waitForSelector(REPORT + " .rp-title");
      await axeCheck(page, [[REPORT]], "report " + colorScheme);
      if (colorScheme === "dark") await shot(page, "report-soro-jonas-1440-dark");
    } finally {
      await close();
    }
  }
});

// ---------- writes ----------

test("T8: Add site from the Melograno page asks for the product and stores \"Melograno - Amelia\"", async () => {
  const { page, close } = await openClient("melograno", { name: "Eivyda" });
  try {
    const before = expect(sitesOf("melograno")).sites;
    assert.equal(await text(page, '[data-cl-act="add"]'), "+ Add site for Melograno…");
    await page.click('[data-cl-act="add"]');
    await page.waitForSelector(".ui-menu .ui-mi");
    const items = await page.$$eval(".ui-menu .ui-mi .ui-mi-label", (ls) => ls.map((l) => l.textContent.trim()));
    assert.deepEqual(items, ["Melograno - Trafft", "Melograno - Amelia", "Melograno - wpDataTables", "Melograno - IvyForms"]);
    await page.click('.ui-menu .ui-mi:has-text("Melograno - Amelia")');
    await page.waitForSelector(ADD);
    await page.waitForSelector('[data-chip="melograno|amelia"][aria-pressed="true"]');
    await page.fill("#se-add-domain", "amelia-f5.example.test");
    await page.click(ADD + " [data-add-submit]");
    await page.waitForSelector(".se-addmodal", { state: "detached" });
    const row = await waitFor(async () => (await retry(() => d1("SELECT id, clients FROM partners WHERE domain = 'amelia-f5.example.test'")))[0],
      "the new row");
    assert.equal(row.clients, "Melograno - Amelia");
    if (/[?&]rec=/.test(await page.evaluate(() => location.hash))) {
      await page.keyboard.press("Escape");
      await page.waitForFunction(() => !/[?&]rec=/.test(location.hash));
    }
    // The page counts it under All and Amelia, not under Trafft.
    await page.waitForFunction((n) => (document.querySelector('[data-cl-key="act:all"]') || {}).textContent === "See all " + n + " sites", before + 1);
    await page.click('[data-cl-product="Amelia"]');
    await page.waitForFunction(() => (document.querySelector('[data-cl-key="act:all"]') || {}).textContent === "See all 1 site");
    assert.deepEqual(await rowIds(page, "prospects"), [row.id]);
    await page.click('[data-cl-product="Trafft"]');
    await page.waitForSelector('[data-cl-product="Trafft"][aria-pressed="true"]');
    assert.ok(!(await rowIds(page, "prospects")).includes(row.id));
    // Sites › Client "Melograno - Amelia" and "Melograno (all)" both find it.
    await page.goto(BASE + "/#sites?tab=all&client=melograno-amelia&big=1");
    assert.equal(await sitesCount(page), 1);
    await page.goto(BASE + "/#sites?tab=all&client=melograno&big=1");
    assert.equal(await sitesCount(page), before + 1);
  } finally {
    await close();
  }
});

test("T23: the Botanical Synthesis program edit writes one client_program row keyed 'botanical synthesis'", async () => {
  const { page, close } = await openClient("botanical-synthesis", { name: "Eivyda" });
  try {
    // GET finds the existing row by its stored key.
    const got = await pageFetch(page, "GET", "/api/clients");
    assert.equal(got.status, 200);
    assert.equal(got.json.filter((r) => r.k === BS).length, 1);
    const n1 = Number(await retry(() => maxEditN()));

    await page.click(PROGRAM + ' [data-cl-act="prog-edit"]');
    await page.waitForSelector("[data-cl-prog-form]");
    assert.equal(await page.inputValue('[data-cl-prog-form] [name="commission"]'), prog0.commission);
    // Client-side check first: a bad link sends nothing.
    const puts = [];
    page.on("request", (r) => { if (r.method() === "PUT") puts.push(new URL(r.url()).pathname); });
    await page.fill('[data-cl-prog-form] [name="signup_url"]', "partners.example.test");
    await page.click('[data-cl-prog-form] button[type="submit"]');
    await page.waitForSelector("#cl-prog-err:not([hidden])");
    assert.equal(await text(page, "#cl-prog-err"), "The sign-up link must start with http:// or https://.");
    assert.deepEqual(puts, []);

    // Esc with changes asks first; Keep editing keeps the form.
    await page.press('[data-cl-prog-form] [name="commission"]', "Escape");
    await page.waitForSelector('dialog[open] >> text="Discard your changes?"');
    await page.click('dialog[open] button:has-text("Keep editing")');
    await page.waitForSelector("[data-cl-prog-form]");

    await page.fill('[data-cl-prog-form] [name="signup_url"]', "https://botanical-synthesis.example.test/partners-f5");
    await page.fill('[data-cl-prog-form] [name="commission"]', "25% per sale");
    await page.fill('[data-cl-prog-form] [name="cookie_days"]', "45");
    await page.click('[data-cl-prog-form] button[type="submit"]');
    await toastWith(page, "Program saved for Botanical Synthesis.");
    await page.waitForSelector(PROGRAM + " .cl-dl");
    assert.match(await text(page, PROGRAM + " .cl-dl"), /25% per sale.*45 days/);
    assert.deepEqual(puts, ["/api/clients/botanical%20synthesis"]);

    const rows = await waitFor(async () => {
      const r = await retry(() => editsAfter(n1));
      return r.length ? r : null;
    }, "the edits row");
    assert.equal(rows.length, 1);
    const e = rows[0];
    assert.equal(e.kind, "client_program");
    assert.equal(e.field, BS);
    assert.equal(e.by_whom, "Eivyda");
    assert.equal(e.account_id, null);
    const v = JSON.parse(e.new);
    assert.deepEqual(Object.keys(v), ["network", "commission", "payout_terms", "signup_url", "brief", "cookie_days"]);
    assert.deepEqual(v, {
      network: prog0.network, commission: "25% per sale", payout_terms: prog0.payout_terms,
      signup_url: "https://botanical-synthesis.example.test/partners-f5", brief: prog0.brief, cookie_days: 45,
    });
    const after1 = await pageFetch(page, "GET", "/api/clients");
    const mine = after1.json.filter((r) => r.k === BS);
    assert.equal(mine.length, 1, "the same row, updated");
    assert.equal(mine[0].commission, "25% per sale");
    assert.equal(mine[0].cookie_days, 45);
  } finally {
    await close();
  }
});
