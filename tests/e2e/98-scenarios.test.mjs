// Spec 8 scenarios that no page file covers (CHECKPOINT-G2 6.5). Owner G3-1.
//   T18  warm start with /api/partners blocked: the cached list renders with "Couldn't refresh"; Retry clears it
//   T25  legacy record links #rec-<ID> and #rec/<ID> open the site on the person's landing page; an unknown id
//        shows the toast (00-smoke covers the other legacy hashes)
//   T35  GET /api/nope is a 404 JSON; api.request answers null for an HTML body; a 5xx (such as a D1 failure,
//        NEEDS "G2 checkpoint 1") shows the friendly server message, never the raw text; a meta build that
//        differs from window.BUILD shows "A new version is ready · Reload"
// Read-only: requests are blocked or answered by page.route; nothing reaches D1 except reads.
// Run: SHOTS_DIR=/tmp/shots-g31 bash tests/e2e/run.sh tests/e2e/98-scenarios.test.mjs
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { baseUrl, signedInPage, closeBrowser, fixture, pageFetch } from "./lib.mjs";

const BASE = baseUrl();
const fx = fixture();
const TODAY = fx.today || process.env.FIXTURE_TODAY;
const CLOCK = TODAY + "T09:00:00Z";
const UTC = { timezoneId: "UTC" };
const NOT_FOUND = "That site wasn't found (it may have been renamed after the morning copy)";
const SERVER = "The server couldn't save this. Try again in a moment.";
const PARTNERS = /\/api\/partners(\?|$)/;

after(async () => {
  await closeBrowser();
});

async function sitesCount(page) {
  await page.waitForFunction(() => {
    const n = document.querySelector('[data-si-tab="all"] [data-si-n]');
    return n && n.textContent.trim() !== "" && !document.querySelector(".si-list .ui-skeleton");
  }, null, { timeout: 20000 });
  let prev = null, same = 0;
  const end = Date.now() + 15000;
  while (Date.now() < end) {
    const t = await page.evaluate(() => {
      const el = document.querySelector('[data-page="sites"] [data-si-count]');
      return el ? el.textContent.trim() : null;
    });
    const m = t && /^([\d,]+) sites?$/.exec(t);
    const n = m ? Number(m[1].replace(/,/g, "")) : null;
    if (n != null && n === prev) {
      if (++same >= 2) return n;
    } else same = 0;
    prev = n;
    await new Promise((r) => setTimeout(r, 100));
  }
  return assert.fail("no Sites count (last: " + prev + ")");
}

const banner = (page, kind) => page.evaluate((k) => {
  const b = document.querySelector('[data-banners] [data-banner="' + k + '"]');
  return b ? b.textContent.replace(/\s+/g, " ").trim() : null;
}, kind);

// ---------- T18 ----------

test("T18: warm start with /api/partners blocked: the cached list renders, with Couldn't refresh and Retry", async () => {
  const { page, watch, close } = await signedInPage({ name: "Kamile", clock: CLOCK, contextOptions: UTC });
  try {
    // The first load (a full 200) writes the list to Cache Storage.
    await page.waitForFunction(async () => {
      try { return !!(await (await caches.open("pgcrm")).match("/api/partners?v=2")); } catch (e) { return false; }
    }, null, { timeout: 20000, polling: 200 });
    await page.evaluate(() => { location.hash = "#sites?tab=all&big=1"; });
    const n = await sitesCount(page);
    assert.ok(n > 100, "the fixture list (" + n + ")");
    assert.equal(await banner(page, "refresh"), null);
    // Warm start: the list request fails.
    await page.route(PARTNERS, (r) => r.abort("failed"));
    await page.reload();
    await page.waitForSelector('[data-banners] [data-banner="refresh"]', { timeout: 20000 });
    assert.match(await banner(page, "refresh"), /^Couldn't refresh\. Showing data from .+\. Retry$/);
    assert.equal(await sitesCount(page), n, "the cached list, all of it");
    assert.equal(await banner(page, "load"), null, "not the cold-start error");
    // The server answers again: Retry loads the list and the banner goes.
    await page.unroute(PARTNERS);
    await page.click('[data-banner="refresh"] [data-act="retry"]');
    await page.waitForFunction(() => !document.querySelector('[data-banners] [data-banner="refresh"]'), null, { timeout: 20000 });
    assert.equal(await sitesCount(page), n);
    assert.deepEqual(watch.pageErrors, []);
  } finally {
    await close();
  }
});

test("T18 (cold start): no cache and /api/partners blocked: Couldn't load the site list, with Retry", async () => {
  const { page, watch, close } = await signedInPage({ name: "Kamile", clock: CLOCK, contextOptions: UTC });
  try {
    // Wait for the first load's cache write to finish, so it can't land after the delete.
    await page.waitForFunction(async () => {
      try { return !!(await (await caches.open("pgcrm")).match("/api/partners?v=2")); } catch (e) { return false; }
    }, null, { timeout: 20000, polling: 200 });
    await page.evaluate(async () => {
      try { await caches.delete("pgcrm"); } catch (e) { /* none */ }
      try { localStorage.removeItem("pgcrm-cache-etag"); } catch (e) { /* none */ }
    });
    await page.route(PARTNERS, (r) => r.abort("failed"));
    await page.reload();
    await page.waitForSelector('[data-banners] [data-banner="load"]', { timeout: 20000 });
    assert.match(await banner(page, "load"), /^Couldn't load the site list\. Retry/);
    await page.unroute(PARTNERS);
    await page.click('[data-banner="load"] [data-act="retry"]');
    await page.waitForFunction(() => !document.querySelector('[data-banners] [data-banner="load"]'), null, { timeout: 20000 });
    assert.deepEqual(watch.pageErrors, []);
  } finally {
    await close();
  }
});

// ---------- T25 ----------

test("T25: #rec-<ID> and #rec/<ID> open the site on the landing page; an unknown id shows the toast", async () => {
  const id = "PG-00002";
  const { page, watch, close } = await signedInPage({ name: "Kamile", clock: CLOCK, contextOptions: UTC });
  try {
    // A new document (a link from an old bookmark or the digest).
    await page.goto(BASE + "/#rec-" + id);
    await page.waitForSelector('#layer-panel [data-panel="' + id + '"]', { timeout: 20000 });
    assert.equal(await page.evaluate(() => location.hash), "#today?rec=" + id);
    assert.ok(await page.$('[data-page="today"]'), "Kamile's landing page");
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => location.hash === "#today");
    // A hash change in an open page.
    await page.evaluate((i) => { location.hash = "#rec/" + i; }, id);
    await page.waitForSelector('#layer-panel [data-panel="' + id + '"]');
    assert.equal(await page.evaluate(() => location.hash), "#today?rec=" + id);
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => location.hash === "#today");
    // Unknown ids: the toast, and the rec param goes.
    for (const h of ["#rec-PG-99999", "#rec/PG-99998"]) {
      await page.evaluate((x) => { location.hash = x; }, h);
      await page.waitForFunction((t) => (document.getElementById("toasts") || {}).textContent.includes(t), NOT_FOUND, { timeout: 10000 });
      await page.waitForFunction(() => location.hash === "#today");
      assert.equal(await page.$("#layer-panel [data-panel]"), null, "no panel for " + h);
    }
    assert.deepEqual(watch.pageErrors, []);
  } finally {
    await close();
  }
  // Someone whose landing page is the Team overview lands there.
  const vik = await signedInPage({ name: "Vik", clock: CLOCK, contextOptions: UTC });
  try {
    await vik.page.goto(BASE + "/#rec-" + id);
    await vik.page.waitForSelector('#layer-panel [data-panel="' + id + '"]', { timeout: 20000 });
    assert.equal(await vik.page.evaluate(() => location.hash), "#team?rec=" + id);
    assert.deepEqual(vik.watch.pageErrors, []);
  } finally {
    await vik.close();
  }
});

// ---------- T35 ----------

test("T35: /api/nope is a 404 JSON; api.request is null for an HTML body; a 5xx shows the friendly message", async () => {
  const { page, watch, close } = await signedInPage({ name: "Kamile", clock: CLOCK, contextOptions: UTC });
  try {
    const nope = await pageFetch(page, "GET", "/api/nope");
    assert.equal(nope.status, 404);
    assert.match(nope.type, /json/);
    assert.equal(nope.json.unavailable, true);
    // An HTML answer (the page itself, or a missing file) is null, not an error.
    const html = await page.evaluate(async () => {
      const api = await import("/js/core/api.js");
      const out = [];
      for (const u of ["/", "/no-such-file-g31.html"]) out.push(await api.request("GET", u));
      return out;
    });
    assert.deepEqual(html, [null, null]);
    // A D1 failure on a save reaches the page as a 500 (functions/api/partner/[id].js rethrows it; see
    // tests/unit/api-errors.test.mjs): the page says the friendly sentence, never the raw text. The 500 is
    // answered here, so nothing reaches the server.
    const id = "PG-00221";
    const route = new RegExp("/api/partner/" + id + "$");
    await page.route(route, (r) => r.request().method() === "PATCH"
      ? r.fulfill({ status: 500, contentType: "text/plain", body: "Error: D1_ERROR: internal error; reference = 0123abcd" })
      : r.continue());
    const err = await page.evaluate(async (i) => {
      const api = await import("/js/core/api.js");
      try {
        await api.request("PATCH", "/api/partner/" + i, { fields: { next_step: "Never saved" } });
        return null;
      } catch (e) {
        return { name: e.name, status: e.status, message: e.message };
      }
    }, id);
    assert.deepEqual(err, { name: "ApiError", status: 500, message: SERVER });
    // The same through the page: Next step on a Deals row, Save, and the toast says the friendly sentence.
    await page.evaluate(() => { location.hash = "#deals"; });
    const pill = '[data-dl-list] tr[data-key="' + id + '"] button[data-edit="next"]';
    await page.waitForSelector(pill, { timeout: 20000 });
    await page.click(pill);
    await page.waitForSelector('.ui-pop-form input[name="text"]');
    await page.fill('.ui-pop-form input[name="text"]', "Never saved");
    await page.click('.ui-pop-form button[type="submit"]');
    await page.waitForFunction((t) => (document.getElementById("toasts") || {}).textContent.includes(t), SERVER, { timeout: 10000 });
    assert.ok(!/D1_ERROR/.test(await page.evaluate(() => document.body.textContent)), "the raw text is never shown");
    await page.unroute(route);
    assert.deepEqual(watch.pageErrors, []);
  } finally {
    await close();
  }
});

test("T35: a meta build that differs from window.BUILD shows A new version is ready · Reload", async () => {
  const { page, watch, close } = await signedInPage({ name: "Kamile", clock: CLOCK, contextOptions: UTC });
  try {
    await page.waitForSelector('[data-page="today"]');
    const meta = await pageFetch(page, "GET", "/api/meta");
    assert.equal(await page.evaluate(() => window.BUILD), meta.json.build, "this page and the server are one build");
    assert.equal(await banner(page, "build"), null);
    // A new version is deployed: /api/meta answers another build.
    await page.route(/\/api\/meta$/, async (r) => {
      const res = await r.fetch();
      const j = await res.json();
      await r.fulfill({ response: res, json: Object.assign(j, { build: String(j.build) + "-next" }) });
    });
    await page.reload();
    await page.waitForSelector('[data-banners] [data-banner="build"]', { timeout: 20000 });
    assert.equal(await banner(page, "build"), "A new version is ready · Reload");
    // Reload loads the new version (here the server's build again): the banner goes.
    await page.unroute(/\/api\/meta$/);
    await Promise.all([page.waitForNavigation(), page.click('[data-banner="build"] [data-act="reload"]')]);
    await page.waitForSelector('[data-page="today"]');
    await page.waitForTimeout(500);
    assert.equal(await banner(page, "build"), null);
    assert.deepEqual(watch.pageErrors, []);
  } finally {
    await close();
  }
});
