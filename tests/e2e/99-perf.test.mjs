// Performance budgets on a synthetic 7,500-site store (spec 1.3 G6, 7.3 G3-4). Owner G3-4.
// Run: bash tests/e2e/run.sh tests/e2e/99-perf.test.mjs
//
// Budgets (never loosened; each is checked on the median of RUNS runs):
//   data visible on a cold load < 800 ms and on a warm load < 400 ms, page switch < 50 ms, search < 30 ms per
//   keystroke, Today compute < 15 ms, no long task over 100 ms.
//
// The store: every fixture site once, then copies of the fixture's New, Contacted and Replied sites (ids
// PG-2xxxx, domains s<n>.example.test) up to 7,500, which is close to the production mix of stages; and the
// fixture's contacts copied up to 6,000. Both are served by page.route, as in 70-search-add: the list with an
// ETag, and 304 when the boot request sends it back (the warm load). The static files come from disk through
// page.route, as the edge serves them in production: `wrangler pages dev` takes about 5 ms per file, mostly one
// at a time, and the ~70 files alone take a warm load past 400 ms here (that number is in TASKLOG, not asserted).
//
// How each number is taken (Chromium at 1440 x 900, CPU not throttled):
//   load    navigation start -> the first Today row is in the DOM and the frame that shows it has run
//           (an animation frame, then a 0 ms timer). Cold: a new browser context (only the session cookies).
//           Warm: a reload of that page, with the list in Cache Storage and a 304 from the server.
//   switch  router.go() called at the start of a frame -> that frame has been laid out and painted (a 0 ms
//           timer queued in the same frame runs after it). Pages in turn, each from the page before.
//   search  one input event and the layout after it, per keystroke, as in 70-search-add (median of 3 rounds).
//   Today   the three Today rules on the whole store (what pages/today.js compute() runs).
//   long    PerformanceObserver('longtask') from the first byte until the network answer has been applied
//           and cached (loads), or over all the switches.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { baseUrl, browser, closeBrowser, apiClient, watchPage, PASSWORD, HARNESS_ROOT } from "./lib.mjs";

const BASE = baseUrl();
const ROOT = path.join(process.env.SERVE_ROOT || HARNESS_ROOT, "crm", "dashboard");
const RUNS = 3;
const SITES = 7500;
const PEOPLE = 6000;
const WHO = "Kamile";
const VIEW = { width: 1440, height: 900 };
const ETAG = 'W/"g34-perf-7500"';
const BUDGET = { cold: 800, warm: 400, switch: 50, keystroke: 30, today: 15, longTask: 100 };
const PAD_STAGES = new Set(["New", "Contacted", "Replied"]);
const TYPES = { ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2", ".svg": "image/svg+xml" };
// Each page from the one before it (a tab change inside Sites is not a page switch).
const PAGES = [
  ["today", "today", {}], ["sites:mine", "sites", { tab: "mine" }], ["deals", "deals", {}],
  ["sites:all", "sites", { tab: "all" }], ["clients", "clients", {}], ["team", "team", {}],
  ["history", "history", {}], ["help", "help", {}],
];

// Long tasks and the moment the first Today row is shown, from the first byte of each document.
const OBSERVE = `(() => {
  const P = window.__perf = { long: [], visible: null };
  try {
    new PerformanceObserver((l) => { for (const e of l.getEntries()) P.long.push({ at: Math.round(e.startTime), ms: Math.round(e.duration) }); })
      .observe({ type: "longtask", buffered: true });
  } catch (e) { P.noLongTasks = true; }
  const mo = new MutationObserver(() => {
    if (!document.querySelector(".td-row")) return;
    mo.disconnect();
    requestAnimationFrame(() => setTimeout(() => { P.visible = performance.now(); }, 0));
  });
  mo.observe(document, { subtree: true, childList: true });
})();`;

const median = (xs) => {
  const s = xs.slice().sort((a, b) => a - b);
  return s.length % 2 ? s[s.length >> 1] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};
const r1 = (x) => Math.round(x * 10) / 10;

let DATA = null;
let COOKIES = null;

// Every fixture site once, then copies of its prospects up to 7,500; the contacts index up to 6,000.
function bigStore(list, idx) {
  const c = (k) => list.cols.indexOf(k);
  const pads = list.rows.filter((r) => PAD_STAGES.has(r[c("stage")]));
  assert.ok(pads.length > 100, "the fixture has prospects to copy");
  const rows = list.rows.slice();
  for (let k = 0; rows.length < SITES; k++) {
    const r = pads[k % pads.length].slice();
    r[c("id")] = "PG-" + String(20000 + k);
    r[c("domain")] = "s" + k + ".example.test";
    if (c("name") >= 0 && r[c("name")]) r[c("name")] = r[c("name")] + " " + k;
    if (c("label") >= 0 && r[c("label")]) r[c("label")] = r[c("label")] + " " + k;
    rows.push(r);
  }
  const people = idx.rows.slice();
  const id = idx.cols.indexOf("id");
  const e = idx.cols.indexOf("email_lc");
  for (let k = 0; people.length < PEOPLE; k++) {
    const r = idx.rows[k % idx.rows.length].slice();
    r[id] = "C-9" + String(k).padStart(5, "0");
    if (e >= 0 && r[e]) r[e] = "x" + k + "." + r[e];
    people.push(r);
  }
  const stages = {};
  for (const r of rows) stages[r[c("stage")] || "-"] = (stages[r[c("stage")] || "-"] || 0) + 1;
  return { list: JSON.stringify({ v: 2, cols: list.cols, rows }), idx: JSON.stringify({ cols: idx.cols, rows: people }), stages };
}

async function sessionCookies() {
  const b = await browser();
  const context = await b.newContext();
  try {
    const r = await context.request.post(BASE + "/login", { form: { password: PASSWORD, next: "/", who: WHO }, maxRedirects: 0 });
    assert.equal(r.status(), 303, "signed in");
    await context.addCookies([{ name: "pg_me", value: encodeURIComponent(WHO), url: BASE }]);
    return (await context.storageState()).cookies;
  } finally {
    await context.close();
  }
}

function serveFromDisk(route) {
  const f = path.join(ROOT, decodeURIComponent(new URL(route.request().url()).pathname));
  if (!f.startsWith(ROOT + path.sep) || !fs.existsSync(f) || !fs.statSync(f).isFile()) return route.continue();
  return route.fulfill({
    status: 200,
    headers: { "Content-Type": TYPES[path.extname(f)] || "application/octet-stream", "Cache-Control": "private, no-cache" },
    body: fs.readFileSync(f),
  });
}

// A new context with the session cookies only (nothing cached): the big list, the contacts and the statics routed.
async function openPage() {
  const b = await browser();
  const context = await b.newContext({ viewport: VIEW, storageState: { cookies: COOKIES, origins: [] } });
  const hits = { full: 0, notModified: 0 };
  await context.route(/\/api\/partners\?v=2$/, (route) => {
    if (route.request().headers()["if-none-match"] === ETAG) {
      hits.notModified++;
      return route.fulfill({ status: 304, headers: { ETag: ETAG } });
    }
    hits.full++;
    return route.fulfill({ status: 200, contentType: "application/json", headers: { ETag: ETAG }, body: DATA.list });
  });
  await context.route(/\/api\/contacts-index$/, (route) => route.fulfill({ status: 200, contentType: "application/json", body: DATA.idx }));
  await context.route(/^[^?#]*\/(js|css|assets)\/[^?#]+$|\/favicon\.svg$/, serveFromDisk);
  await context.addInitScript(OBSERVE);
  const page = await context.newPage();
  const watch = watchPage(page);
  return { page, watch, hits, close: () => context.close() };
}

// One load: data visible (ms from navigation start) and the long tasks until the network answer has been
// applied and the list is in Cache Storage with its ETag (what the next, warm, load reads).
async function measureLoad(page, { reload = false } = {}) {
  if (reload) await page.reload();
  else await page.goto(BASE + "/#today");
  await page.waitForFunction(() => window.__perf && window.__perf.visible != null, null, { timeout: 30000 });
  await page.evaluate(async () => { await (await import("/js/core/store.js")).whenLoaded(); });
  await page.waitForFunction((etag) => localStorage.getItem("pgcrm-cache-etag") === etag, ETAG, { timeout: 15000 });
  await page.waitForTimeout(200);
  return page.evaluate(() => {
    const P = window.__perf;
    return { visible: Math.round(P.visible), maxLong: Math.max(0, ...P.long.map((x) => x.ms)), long: P.long.slice(), noLongTasks: !!P.noLongTasks };
  });
}

before(async () => {
  const client = await apiClient(BASE);
  const list = (await client.call("GET", "/api/partners?v=2")).json;
  const idx = (await client.call("GET", "/api/contacts-index")).json;
  assert.ok(list && Array.isArray(list.cols) && idx && Array.isArray(idx.cols), "the fixture list and contacts index");
  DATA = bigStore(list, idx);
  COOKIES = await sessionCookies();
  console.log("# perf store: " + SITES + " sites " + JSON.stringify(DATA.stages) + ", " + PEOPLE + " contacts, list " +
    Math.round(DATA.list.length / 1024) + " KB");
});

after(closeBrowser);

test("Cold load < 800 ms and warm load < 400 ms to data visible, no long task over 100 ms (7,500 sites)", async () => {
  const cold = [];
  const warm = [];
  for (let i = 0; i < RUNS; i++) {
    const { page, watch, hits, close } = await openPage();
    try {
      cold.push(await measureLoad(page));
      assert.equal(hits.full, 1, "the cold load asked for the whole list");
      warm.push(await measureLoad(page, { reload: true }));
      assert.equal(hits.notModified, 1, "the warm load got a 304 for the cached list");
      assert.deepEqual(watch.pageErrors, [], "no page errors");
    } finally {
      await close();
    }
  }
  assert.ok(!cold[0].noLongTasks, "this Chromium reports long tasks");
  const res = {
    cold: cold.map((x) => x.visible), warm: warm.map((x) => x.visible),
    longCold: cold.map((x) => x.maxLong), longWarm: warm.map((x) => x.maxLong),
  };
  console.log("# perf loads (ms): " + JSON.stringify(res));
  assert.ok(median(res.cold) < BUDGET.cold, "cold load: data visible in " + median(res.cold) + " ms (runs " + res.cold + ")");
  assert.ok(median(res.warm) < BUDGET.warm, "warm load: data visible in " + median(res.warm) + " ms (runs " + res.warm + ")");
  assert.ok(median(res.longCold) < BUDGET.longTask, "cold load: longest task " + median(res.longCold) + " ms " + JSON.stringify(cold.map((x) => x.long)));
  assert.ok(median(res.longWarm) < BUDGET.longTask, "warm load: longest task " + median(res.longWarm) + " ms " + JSON.stringify(warm.map((x) => x.long)));
});

test("Page switch < 50 ms on every page, no long task over 100 ms (7,500 sites)", async () => {
  const samples = Object.fromEntries(PAGES.map(([name]) => [name, []]));
  const longest = [];
  for (let i = 0; i < RUNS; i++) {
    const { page, watch, close } = await openPage();
    try {
      await measureLoad(page);
      const out = await page.evaluate(async (pages) => {
        const router = await import("/js/core/router.js");
        const settle = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 40))));
        const inFrame = (fn) => new Promise((r) => requestAnimationFrame(() => {
          const t = performance.now();
          fn();
          setTimeout(() => r(performance.now() - t), 0);
        }));
        window.__perf.long.length = 0;
        const ms = {};
        for (let pass = 0; pass < 4; pass++) {
          for (const [name, pg, params] of pages) {
            const t = await inFrame(() => router.go(pg, params));
            await settle();
            if (pass) (ms[name] = ms[name] || []).push(t); // the first pass warms up the code
          }
        }
        return { ms, long: window.__perf.long.slice() };
      }, PAGES);
      for (const [name, xs] of Object.entries(out.ms)) samples[name].push(...xs);
      longest.push(Math.max(0, ...out.long.map((x) => x.ms)));
      assert.deepEqual(watch.pageErrors, [], "no page errors");
    } finally {
      await close();
    }
  }
  const med = Object.fromEntries(Object.entries(samples).map(([k, xs]) => [k, r1(median(xs))]));
  const max = Object.fromEntries(Object.entries(samples).map(([k, xs]) => [k, r1(Math.max(...xs))]));
  console.log("# perf page switch (ms, median of " + samples.today.length + "): " + JSON.stringify(med) + " max " + JSON.stringify(max) +
    " longest task per run " + JSON.stringify(longest));
  for (const [name, ms] of Object.entries(med)) assert.ok(ms < BUDGET.switch, "switch to " + name + ": " + ms + " ms");
  assert.ok(median(longest) < BUDGET.longTask, "longest task while switching: " + JSON.stringify(longest));
});

test("Search < 30 ms per keystroke and Today compute < 15 ms (7,500 sites, 6,000 contacts)", async () => {
  const { page, watch, close } = await openPage();
  try {
    await measureLoad(page);
    const today = await page.evaluate(async () => {
      const store = await import("/js/core/store.js");
      const meta = await import("/js/core/meta.js");
      const me = await import("/js/core/me.js");
      const fmt = await import("/js/core/format.js");
      const rules = await import("/js/rules/today.js");
      const o = { meta: meta.get(), today: fmt.todayIso(), me: me.get() };
      const ms = [];
      for (let k = 0; k < 1 + 7; k++) {
        const t = performance.now();
        const records = store.all();
        rules.doNowInfo(records, o);
        rules.newProspects(records, o);
        rules.comingUp(records, o);
        if (k) ms.push(performance.now() - t); // the first call warms up the code
      }
      return { n: store.size(), ms };
    });
    assert.equal(today.n, SITES, "7,500 sites in the store");
    await page.keyboard.press("Control+k");
    await page.waitForSelector(".se-dialog[open] .se-input");
    await page.fill(".se-input", "ot");
    await page.waitForSelector('.se-row[data-kind="contact"]', { timeout: 15000 });
    // The typing loop runs in one task on purpose (each keystroke is timed on its own), so no long-task check here.
    const rounds = await page.evaluate(() => {
      const input = document.querySelector(".se-input");
      const words = ["dupe.example.test", "https://www.example.test/tech/article-123", "mr money", "PG-00008", "new-3",
        "ann@x.example.test", "ottilie vance", "hosting review", "soro", "s7001.example", "zzzzqqq"];
      const out = [];
      for (let round = 0; round < 3; round++) {
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
        out.push(times);
      }
      return out;
    });
    const per = rounds[0].map((x, i) => ({ q: x.q, ms: median(rounds.map((r) => r[i].ms)) }));
    const slowest = per.slice().sort((a, b) => b.ms - a.ms)[0];
    const all = per.map((x) => x.ms);
    console.log("# perf search (ms per keystroke, median of 3 rounds): " + JSON.stringify({ keystrokes: all.length,
      median: r1(median(all)), max: r1(slowest.ms), slowest: slowest.q }) + " | Today compute (ms): " +
      JSON.stringify({ median: r1(median(today.ms)), runs: today.ms.map(r1) }));
    assert.ok(slowest.ms < BUDGET.keystroke, "every keystroke under 30 ms (slowest " + JSON.stringify(slowest) + ")");
    assert.ok(median(today.ms) < BUDGET.today, "Today compute " + r1(median(today.ms)) + " ms");
    assert.deepEqual(watch.pageErrors, [], "no page errors");
  } finally {
    await close();
  }
});
