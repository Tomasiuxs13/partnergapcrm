// Smoke (spec 7.1 G1-D (3)): sign in, every route renders its title, no uncaught page errors,
// no unexpected failed requests, and GET /api/nope is a 404 JSON. Owner G1-D.
// Run: bash tests/e2e/run.sh tests/e2e/00-smoke.test.mjs
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { baseUrl, signedInPage, closeBrowser, browser, pageFetch, api } from "./lib.mjs";

// Requests that may fail with 404 for now: endpoints that are not built yet (they answer the catch-all's
// {"error":"Not available yet","unavailable":true}). Emptied at the G1 checkpoint: /api/meta and the
// v2 list exist. Add a path here only for an endpoint a page calls before its owner ships it.
const ALLOWED_404 = [];
// Requests this file makes on purpose to check the catch-all.
const DELIBERATE_404 = ["/api/nope"];

// Every route of spec 2.4 and the h1 (and document.title) it must show.
const ROUTES = [
  ["", /^Today$/],
  ["#today", /^Today$/],
  ["#sites", /^Sites$/],
  ["#sites?tab=mine", /^Sites$/],
  ["#sites?tab=unowned", /^Sites$/],
  ["#sites?tab=waiting", /^Sites$/],
  ["#sites?tab=all&owner=me&stage=Contacted", /^Sites$/],
  ["#deals", /^Deals$/],
  ["#deals?client=soro", /^Deals$/],
  ["#clients", /^Clients$/],
  ["#clients/soro", /soro/i],
  ["#clients/botanical-synthesis", /botanical[ -]synthesis/i],
  ["#team", /^Team overview$/],
  ["#history", /^Edit history$/],
  ["#history?by=Kamile&state=not_copied", /^Edit history$/],
  ["#help", /^Help$/],
  ["#no-such-page", /^Today$/],
];

// Legacy redirects (spec 2.4), built by G1-A (js/core/router.js).
const LEGACY = [
  ["#home", /^Today$/],
  ["#prospecting", /^Sites$/],
  ["#tasks", /^Today$/],
  ["#partners", /^Deals$/],
  ["#reports", /^Team overview$/],
  ["#campaigns", /^Clients$/],
  ["#changes", /^Edit history$/],
  ["#client-botanical-synthesis", /botanical[ -]synthesis/i],
];

const NAV_LABELS = ["Today", "Sites", "Deals", "Clients", "Team overview", "Help"];

const BASE = baseUrl();
const SHOTS = process.env.SHOTS_DIR || "/tmp/shots-g1-d";
let session;

function allowed(url, status) {
  const u = new URL(url);
  return status === 404 && u.origin === BASE &&
    ALLOWED_404.concat(DELIBERATE_404).some((p) => u.pathname === p || u.pathname.startsWith(p + "/"));
}

async function waitTitle(page, re) {
  await page.waitForFunction((src) => {
    const h = document.querySelector("main h1");
    return !!h && new RegExp(src, "i").test(h.textContent.trim());
  }, re.source, { timeout: 10000 });
  const h1 = (await page.textContent("main h1")).trim();
  assert.match(h1, re, "h1");
  const title = await page.title();
  const name = new RegExp(re.source.replace(/^\^|\$$/g, ""), "i");
  assert.ok(name.test(title), "document.title " + JSON.stringify(title) + " names the page");
}

before(async () => {
  assert.ok(BASE, "BASE_URL is set (run through tests/e2e/run.sh)");
  assert.ok(!/:8788\b/.test(BASE), "never the main dev server");
  fs.mkdirSync(SHOTS, { recursive: true });
});

after(async () => {
  if (session) await session.close();
  await closeBrowser();
});

test("signed out, the app redirects to the sign-in page", async () => {
  const context = await (await browser()).newContext();
  try {
    const page = await context.newPage();
    await page.goto(BASE + "/#sites");
    assert.match(new URL(page.url()).pathname, /^\/login$/);
    assert.ok(await page.$('input[name="password"]'), "password field");
    const r = await page.request.get(BASE + "/api/partners");
    assert.equal(r.status(), 401, "the API needs sign-in");
  } finally {
    await context.close();
  }
});

test("sign in lands on the app with the main nav", async () => {
  session = await signedInPage({ name: "Kamile" });
  const { page } = session;
  assert.equal(new URL(page.url()).pathname, "/");
  await waitTitle(page, /^Today$/);
  const navText = await page.$$eval("nav a", (as) => as.map((a) => a.textContent.replace(/\s+/g, " ").trim()));
  for (const label of NAV_LABELS) assert.ok(navText.some((t) => t.includes(label)), "nav link " + label + " in " + JSON.stringify(navText));
  await page.screenshot({ path: path.join(SHOTS, "smoke-today.png") });
});

test("every route renders its page on a fresh load", async () => {
  const { page, watch } = session;
  for (const [hash, re] of ROUTES) {
    const errs = watch.pageErrors.length;
    await page.goto(BASE + "/" + hash);
    await page.reload();
    await waitTitle(page, re);
    assert.equal(watch.pageErrors.length, errs, "page error on " + (hash || "(empty hash)") + ":\n" + watch.pageErrors.slice(errs).join("\n"));
  }
});

test("routes also switch in place (hash change and nav links)", async () => {
  const { page } = session;
  await page.goto(BASE + "/#today");
  await waitTitle(page, /^Today$/);
  for (const [hash, re] of ROUTES.filter(([h]) => h)) {
    await page.evaluate((h) => { location.hash = h; }, hash);
    await waitTitle(page, re);
  }
  for (const label of NAV_LABELS) {
    await page.locator("nav a", { hasText: label }).first().click();
    await waitTitle(page, new RegExp("^" + label + "$"));
  }
});

test("legacy hashes redirect to their new pages", async () => {
  const { page } = session;
  for (const [hash, re] of LEGACY) {
    await page.goto(BASE + "/" + hash);
    await page.reload();
    await waitTitle(page, re);
  }
});

test("GET /api/nope is a 404 JSON (catch-all)", async () => {
  const fromPage = await pageFetch(session.page, "GET", "/api/nope");
  assert.equal(fromPage.status, 404);
  assert.match(fromPage.type, /^application\/json/);
  assert.equal(fromPage.json && fromPage.json.unavailable, true, fromPage.text);
  const fromNode = await api("GET", "/api/nope/deeper");
  assert.equal(fromNode.status, 404);
  assert.match(fromNode.type, /^application\/json/);
  assert.deepEqual(fromNode.json, { error: "Not available yet", unavailable: true });
});

test("no uncaught page errors and no unexpected failed requests", () => {
  const { watch } = session;
  assert.deepEqual(watch.pageErrors, [], "uncaught page errors");
  const failed = watch.failed.filter((f) => !allowed(f.url, f.status));
  assert.deepEqual(failed, [], "failed requests that are not on the allowed-for-now 404 list");
  // A failed resource load also logs a console error; the check above covers those.
  const consoleErrors = watch.consoleErrors.filter((c) => !/Failed to load resource/.test(c.text));
  assert.deepEqual(consoleErrors, [], "console errors");
});
