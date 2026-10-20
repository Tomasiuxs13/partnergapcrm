// Edit history, Help, Settings and What's new (spec 2.2.6, 2.2.7, 2.2.9, 4.11; tests T21, T31). Owner F8.
// Run: bash tests/e2e/run.sh tests/e2e/80-history-help.test.mjs   (screenshots: SHOTS_DIR, default /tmp/shots-f8)
//
// Read-only tests first (Edit history's header, rows, three states, filters and entry points; Help's content;
// What's new from Help and the one-time Today banner; "Not available yet"; phone; axe), then the writes:
// Load more (100 synthetic edits rows, deleted again), T31 (a simulated morning copy, undone again) and
// Settings as Jonas (team, landing page, clients, the "Do not contact" switch; kv_meta only, never an edits
// row). after() deletes every row the tests add and puts the kv_meta keys and the applied flags back.
// Mocks: GET /api/edits and GET /api/settings answer 404 {unavailable} for the "Not available yet" test.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { baseUrl, signedInPage, closeBrowser, d1, maxEditN, pageFetch, fixture, tools } from "./lib.mjs";

const BASE = baseUrl();
const SHOTS = process.env.SHOTS_DIR || "/tmp/shots-f8";
const fx = fixture();
const TODAY = fx.today || process.env.FIXTURE_TODAY;
const DESKTOP = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };
const PHONE_OPTS = { hasTouch: true, isMobile: true };
const TZ = { timezoneId: "Europe/Vilnius" };
const CLIP = { permissions: ["clipboard-read", "clipboard-write"] };
const KV_KEYS = ["team", "clients", "allow_dnc", "settings_log", "sheet_sig", "last_sheet_change"];
const ROWS = ".hi-list .ui-table tbody tr";
const MODAL = ".ui-modal[open]";

let n0 = 0;
let act0 = 0;
let runs0 = 0;
let kv0 = [];
let applied0 = [];

// ---------- expected numbers, from the edits table when this file starts ----------
// (the fixture's 30 rows, plus any rows an earlier test file left behind)

const PER = 100;
let EDITS = [];
let COUNT = { all: 0, waiting: 0, copied: 0, not_copied: 0 };
let CONFLICTS = [];
let GABY = 0;
let GABY_WAITING = 0;
let NEW3 = 0;
let PG408 = 0;

function stateOfRows(list) {
  const maxApplied = Math.max(0, ...list.filter((e) => e.applied === 1).map((e) => e.n));
  return (e) => (e.applied === 1 ? "copied" : e.n > maxApplied ? "waiting" : "not_copied");
}

async function readEdits() {
  const list = (await retry(() => d1("SELECT n, by_whom, account_id, applied FROM edits ORDER BY n")))
    .map((r) => ({ n: Number(r.n), by_whom: r.by_whom, account_id: r.account_id, applied: Number(r.applied) }));
  const stateOf = stateOfRows(list);
  const count = { all: list.length, waiting: 0, copied: 0, not_copied: 0 };
  for (const e of list) count[stateOf(e)]++;
  return { list, stateOf, count, waitingNs: list.filter((e) => stateOf(e) === "waiting").map((e) => e.n) };
}
const firstPage = (n) => Math.min(n, PER);
const plural = (n, w) => n + " " + w + (n === 1 ? "" : "s");
const waitingSentence = (n) => n === 0
  ? "Nothing is waiting for the Google Sheet."
  : plural(n, "change") + " " + (n === 1 ? "copies" : "copy") + " to the Google Sheet on the next weekday morning (08:47).";
const SHEET_SHOWS = "Changes made directly in the Google Sheet show here the next weekday morning.";
const NOT_COPIED = "Not copied – a sheet edit won; check the sheet";

function nextWeekday(day) {
  const d = new Date(day + "T12:00:00Z");
  do d.setUTCDate(d.getUTCDate() + 1); while (d.getUTCDay() === 0 || d.getUTCDay() === 6);
  return d.toISOString().slice(0, 10);
}

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
    await new Promise((r) => setTimeout(r, 250));
  }
  assert.fail("timed out waiting for " + what + (last !== undefined ? " (last: " + JSON.stringify(last) + ")" : ""));
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

const clean = (s) => String(s || "").replace(/\s+/g, " ").trim();
const text = async (page, sel) => clean(await page.locator(sel).first().innerText());

async function open(hash, o = {}) {
  const { contextOptions = {}, ...rest } = o;
  const s = await signedInPage({ viewport: DESKTOP, name: "Kamile", clock: TODAY + "T12:00:00", contextOptions: { ...TZ, ...contextOptions }, ...rest });
  if (hash != null) await s.page.goto(BASE + "/" + hash);
  return s;
}

// The rows on screen: [{what, who, site, sheet}].
function rows(page) {
  return page.$$eval(ROWS, (trs) => trs.map((tr) => {
    // The visible words only: no avatar letters, no screen-reader-only text.
    const t = (sel) => {
      const el = tr.querySelector(sel);
      if (!el) return "";
      const c = el.cloneNode(true);
      for (const x of c.querySelectorAll(".sr-only, .ui-avatar")) x.remove();
      for (const x of c.querySelectorAll(".hi-what-sub, .hi-id")) x.prepend(" ");
      return c.textContent.replace(/\s+/g, " ").trim();
    };
    return { what: t("td.hi-c-what"), who: t("td.hi-c-who"), site: t("td.hi-c-site"), sheet: t("td.hi-c-sheet"), when: t("td.hi-c-when") };
  }));
}

// Waits until n rows show and stay (a refresh after the site list loads may redraw them once).
async function rowsSettled(page, n, what) {
  const ready = async () => (await page.locator(ROWS).count()) === n && (await page.locator(".hi-list [aria-busy=true]").count()) === 0;
  await waitFor(async () => (await ready()) && (await new Promise((r) => setTimeout(r, 400))) === undefined && ready(), what + " (" + n + " rows)");
  return rows(page);
}

// Every row of the list: Load more until n rows show.
async function rowsAll(page, n, what) {
  for (let shown = firstPage(n); ; shown = Math.min(n, shown + PER)) {
    await rowsSettled(page, shown, what);
    if (shown >= n) return rows(page);
    await page.locator(".hi-list [data-load]").click();
  }
}

const hashParams = (page) => page.evaluate(() => Object.fromEntries(new URLSearchParams(location.hash.split("?")[1] || "")));

async function meta(page) {
  const r = await pageFetch(page, "GET", "/api/meta");
  assert.equal(r.status, 200, "GET /api/meta");
  return r.json;
}

// The names on the sign-in page's "Your name" list (the middleware reads the team from kv_meta).
async function signInNames() {
  const res = await fetch(BASE + "/login");
  const body = await res.text();
  const sel = body.slice(body.indexOf('name="who"'), body.indexOf("</select>", body.indexOf('name="who"')));
  return [...sel.matchAll(/<option([^>]*)>([^<]*)<\/option>/g)]
    .filter((m) => !/\bdisabled\b|value="__other"/.test(m[1]) && !/someone else/i.test(m[2])).map((m) => m[2].trim());
}

async function menuPick(page, label) {
  const item = page.locator(".ui-menu .ui-mi", { hasText: label }).first();
  await item.waitFor({ state: "visible", timeout: 5000 });
  await item.click();
}

// ---------- setup / teardown ----------

before(async () => {
  assert.ok(BASE, "BASE_URL is set (run through tests/e2e/run.sh)");
  assert.ok(!/:8788\b/.test(BASE), "never the main dev server");
  fs.mkdirSync(SHOTS, { recursive: true });
  n0 = Number(await retry(() => maxEditN()));
  act0 = Number((await retry(() => d1("SELECT COALESCE(MAX(n), 0) AS n FROM activity")))[0].n);
  runs0 = Number((await retry(() => d1("SELECT COALESCE(MAX(n), 0) AS n FROM runs")))[0].n);
  kv0 = await retry(() => d1("SELECT k, v, at, by_whom FROM kv_meta WHERE k IN " + inList(KV_KEYS), { rawNulls: true }));
  applied0 = await retry(() => d1("SELECT n, applied FROM edits ORDER BY n"));
  const e = await readEdits();
  EDITS = e.list;
  COUNT = e.count;
  CONFLICTS = EDITS.filter((x) => e.stateOf(x) === "not_copied").map((x) => x.n);
  GABY = EDITS.filter((x) => x.by_whom === "Gaby").length;
  GABY_WAITING = EDITS.filter((x) => x.by_whom === "Gaby" && e.stateOf(x) === "waiting").length;
  NEW3 = EDITS.filter((x) => x.account_id === "NEW-0003").length;
  PG408 = EDITS.filter((x) => x.account_id === "PG-00408").length;
});

after(async () => {
  try {
    await retry(() => d1("DELETE FROM edits WHERE n > " + n0));
    const was1 = applied0.filter((r) => Number(r.applied) === 1).map((r) => r.n);
    const was0 = applied0.filter((r) => Number(r.applied) !== 1).map((r) => r.n);
    if (was1.length) await retry(() => d1("UPDATE edits SET applied = 1 WHERE n IN " + inList(was1)));
    if (was0.length) await retry(() => d1("UPDATE edits SET applied = 0 WHERE n IN " + inList(was0)));
    await retry(() => d1("DELETE FROM activity WHERE n > " + act0));
    await retry(() => d1("DELETE FROM runs WHERE n > " + runs0));
    await retry(() => d1("DELETE FROM kv_meta WHERE k IN " + inList(KV_KEYS)));
    for (const r of kv0) {
      await retry(() => d1("INSERT INTO kv_meta (k, v, at, by_whom) VALUES (" + [r.k, r.v, r.at, r.by_whom].map(q).join(", ") + ")"));
    }
  } finally {
    await closeBrowser();
  }
});

// ---------- Edit history (T21) ----------

test("T21: Edit history shows the header sentences, every change and the three sheet states", async () => {
  assert.ok(CONFLICTS.includes(7), "the fixture's not-copied edit (n 7)");
  const s = await open("#history");
  const { page, watch } = s;
  try {
    await rowsSettled(page, firstPage(COUNT.all), "the first page");
    assert.equal(await text(page, "main h1"), "Edit history");
    // The waiting count is freshness.pending (12), not /api/edits' bare `pending` (13, with the conflict).
    await waitFor(async () => (await text(page, ".hi-sub")).includes(waitingSentence(COUNT.waiting)), "the waiting sentence");
    assert.equal(await text(page, ".hi-sub"), waitingSentence(COUNT.waiting) + " " + SHEET_SHOWS);
    assert.equal(await text(page, "[data-hi-count]"), COUNT.all > PER ? "Showing the newest " + PER + " changes" : plural(COUNT.all, "change"));
    assert.equal((await page.locator(".hi-list .ui-list-count").count()) ? await page.locator(".hi-list .ui-list-head").isVisible() : false, false, "one count line, in the bar");
    const list = await rowsAll(page, COUNT.all, "all edits");
    assert.equal(await text(page, "[data-hi-count]"), plural(COUNT.all, "change"));

    // Newest first, with the words of 2.2.6.
    assert.equal(list[0].who, EDITS[EDITS.length - 1].by_whom, "newest first");
    const mv = list.find((r) => r.what === "Next step: “Find the right contact”");
    assert.deepEqual(mv, { what: "Next step: “Find the right contact”", who: "Mantvydas", site: "Fitness Tips 452 PG-00452", sheet: "Waiting", when: mv.when });
    assert.match(mv.when, /^Today \d\d:\d\d$/);
    const whats = list.map((r) => r.what);
    for (const w of ["Added site", "Added contact Jonah Reed", "Logged Email Sent the Raibu pitch.", "Changed Botanical Synthesis program", "Stage: Contacted → Replied", "Owner: Sandra"]) {
      assert.ok(whats.includes(w), "a row says " + w + " (got " + whats.join(" | ") + ")");
    }
    const prog = list.find((r) => r.what === "Changed Botanical Synthesis program");
    assert.equal(prog.site, "Botanical Synthesis Client program");
    assert.equal(await page.locator(ROWS + " td.hi-c-site a[href*='#clients/']").count(), 1, "the program row links to its client page");

    // The three states.
    const by = (t) => list.filter((r) => r.sheet === t).length;
    assert.equal(by("Waiting"), COUNT.waiting);
    assert.equal(by("Copied to the sheet"), COUNT.copied);
    assert.equal(by(NOT_COPIED), COUNT.not_copied);
    const conflict = list.find((r) => r.sheet === NOT_COPIED && r.who === "Gaby");
    assert.equal(conflict && conflict.what, "Stage: Contacted → Replied");
    const sheetUrl = (await meta(page)).sheet_url;
    if (sheetUrl) {
      const a = page.locator(ROWS + " td.hi-c-sheet a", { hasText: "check the sheet" });
      assert.equal(await a.getAttribute("href"), sheetUrl);
      assert.equal(await a.getAttribute("target"), "_blank");
    }

    // The note about the conflict leads to the Not copied filter.
    const one = COUNT.not_copied === 1;
    assert.equal(await text(page, ".hi-note"), plural(COUNT.not_copied, "change") + " " + (one ? "wasn't" : "weren't") + " copied: someone changed the same cell in the Google Sheet later. Show " + (one ? "it" : "them"));
    await page.click(".hi-note [data-hi-state=not_copied]");
    await rowsAll(page, COUNT.not_copied, "the not-copied edits");
    assert.equal((await hashParams(page)).state, "not_copied");
    assert.equal(await page.locator(".hi-note").count(), 0, "no note while the filter shows them");
    await shot(page, "history-not-copied-1440");

    // Opening a site from a row opens its panel.
    await page.click("[data-hi-state='']");
    await rowsSettled(page, firstPage(COUNT.all), "all edits again");
    await shot(page, "history-1440");
    const link = page.locator(ROWS + " td.hi-c-site a[data-open]").first();
    const id = await link.getAttribute("data-open");
    const label = clean(await link.innerText());
    await link.click();
    await waitFor(async () => (await hashParams(page)).rec === id, "the panel's address");
    await page.locator("#layer-panel").getByText(label).first().waitFor({ state: "visible", timeout: 10000 });
    assert.equal(Number(await retry(() => maxEditN())), n0, "Edit history writes nothing");
    assert.deepEqual(watch.pageErrors, [], "no page errors");
  } finally {
    await s.close();
  }
});

test("T21: filters (Sheet, Person, Site) follow the URL, with chips, Clear all and a no-match state", async () => {
  const s = await open("#history");
  const { page, watch } = s;
  try {
    await rowsSettled(page, firstPage(COUNT.all), "all edits");
    for (const [id, n] of [["waiting", COUNT.waiting], ["copied", COUNT.copied], ["not_copied", COUNT.not_copied]]) {
      await page.click(`[data-hi-state="${id}"]`);
      const list = await rowsAll(page, n, id);
      assert.equal((await hashParams(page)).state, id);
      assert.equal(await page.getAttribute(`[data-hi-state="${id}"]`, "aria-pressed"), "true");
      assert.equal(await text(page, "[data-hi-count]"), plural(n, "change"));
      assert.ok(list.every((r) => r.sheet === { waiting: "Waiting", copied: "Copied to the sheet", not_copied: NOT_COPIED }[id]), id + " rows only");
    }
    await page.click("[data-hi-state='']");
    await rowsSettled(page, firstPage(COUNT.all), "all edits");
    assert.equal((await hashParams(page)).state, undefined);

    // Person: me first, then the team.
    await page.click("[data-hi-person]");
    const items = await page.$$eval(".ui-menu .ui-mi .ui-mi-label", (els) => els.map((e) => e.textContent.trim()));
    assert.equal(items[0], "Kamile", "me first");
    assert.ok(items.includes("Gaby") && items.includes("Vik"));
    await menuPick(page, "Gaby");
    let list = await rowsAll(page, GABY, "Gaby's edits");
    assert.ok(list.every((r) => r.who === "Gaby"));
    assert.equal((await hashParams(page)).by, "Gaby");
    assert.deepEqual(await page.$$eval(".hi-chips .ui-fchip", (els) => els.map((e) => e.textContent.trim())), ["Person: Gaby"]);

    // Person + state, then remove the person chip.
    await page.click('[data-hi-state="waiting"]');
    await rowsAll(page, GABY_WAITING, "Gaby's waiting edits");
    await page.click('[data-hi-remove="by"]');
    await rowsAll(page, COUNT.waiting, "waiting edits");
    assert.deepEqual(await hashParams(page), { state: "waiting" });

    // Site (from the account param), then Clear all.
    await page.goto(BASE + "/#history?account=NEW-0003");
    list = await rowsAll(page, NEW3, "Fresh Find 3's edits");
    assert.ok(list.every((r) => r.site.startsWith("Fresh Find 3")));
    assert.deepEqual(await page.$$eval(".hi-chips .ui-fchip", (els) => els.map((e) => e.textContent.trim())), ["Site: Fresh Find 3"]);
    await shot(page, "history-site-filter-1440");
    await page.click("[data-hi-clear]");
    await rowsSettled(page, firstPage(COUNT.all), "all edits");
    assert.deepEqual(await hashParams(page), {});

    // Nobody: the filtered empty state clears the filters.
    await page.goto(BASE + "/#history?by=Zed");
    await waitFor(async () => (await page.locator(".hi-list .ui-empty").count()) > 0, "the empty state");
    assert.match(await text(page, ".hi-list .ui-empty"), /No changes match\./);
    await page.click(".hi-list [data-empty-act=clear]");
    await rowsSettled(page, firstPage(COUNT.all), "all edits");
    assert.deepEqual(watch.pageErrors, [], "no page errors");
  } finally {
    await s.close();
  }
});

test("T21: the footer sync line and a site's ⋯ › See all changes open Edit history", async () => {
  const s = await open("#today");
  const { page, watch } = s;
  try {
    const sync = page.locator("a[data-sync]:visible").first();
    await sync.waitFor({ state: "visible" });
    await sync.click();
    await page.waitForFunction(() => location.hash.startsWith("#history"));
    assert.equal(await text(page, "main h1"), "Edit history");
    await rowsSettled(page, firstPage(COUNT.all), "all edits");

    await page.goto(BASE + "/#sites?rec=PG-00408");
    const more = page.locator('#layer-panel [data-pact="more"]').first();
    await more.waitFor({ state: "visible", timeout: 15000 });
    await more.click();
    await menuPick(page, "See all changes");
    await page.waitForFunction(() => location.hash.startsWith("#history"));
    assert.equal((await hashParams(page)).account, "PG-00408");
    const list = await rowsAll(page, PG408, "PG-00408's edits");
    assert.ok(list.every((r) => r.site.includes("PG-00408")));
    assert.equal(await page.locator(".hi-chips .ui-fchip").count(), 1, "a Site chip");
    assert.deepEqual(watch.pageErrors, [], "no page errors");
  } finally {
    await s.close();
  }
});

test("Edit history and Settings say \"Not available yet\" when their endpoints are missing", async () => {
  const unavailable = { status: 404, contentType: "application/json", body: JSON.stringify({ error: "Not available yet", unavailable: true }) };
  const s = await open(null);
  const { page, watch } = s;
  try {
    await page.route(/\/api\/edits(\?|$)/, (r) => r.fulfill(unavailable));
    await page.goto(BASE + "/#history");
    await waitFor(async () => (await page.locator(".hi-list .ui-empty").count()) > 0, "the list's error state");
    assert.match(await text(page, ".hi-list .ui-empty"), /^Not available yet Try again$/);
    assert.equal(await page.locator("[data-hi-csv]").isDisabled(), true, "nothing to export");
    assert.deepEqual(watch.pageErrors, []);
  } finally {
    await s.close();
  }
  const j = await open(null, { name: "Jonas" });
  try {
    await j.page.route(/\/api\/settings(\?|$)/, (r) => r.fulfill(unavailable));
    await j.page.goto(BASE + "/#help");
    await waitFor(async () => /Not available yet\./.test(await text(j.page, "[data-hp-settings]")), "Settings: Not available yet");
    assert.equal(await j.page.locator("[data-hp-settings] [data-hp-addperson]").count(), 0, "no controls");
    assert.deepEqual(j.watch.pageErrors, []);
  } finally {
    await j.close();
  }
});

// ---------- Help ----------

test("Help: how it works, the name, stages, Today's labels, shortcuts, clients, jobs and the sheet link", async () => {
  const s = await open("#help", { contextOptions: CLIP });
  const { page, watch } = s;
  try {
    await page.locator(".hp-page").waitFor();
    const m = await meta(page);
    assert.equal(await text(page, "main h1"), "Help");
    assert.equal(await page.locator(".hp-how li").count(), 3, "three sentences");
    assert.match(await text(page, ".hp-how"), /every change saves at once.*updates itself each weekday morning \(08:47\).*show here the next weekday morning.*nothing is sent/);
    assert.equal(clean(await page.locator(".hp-signed").evaluate((el) => el.textContent)), "Edits are signed with the name you picked: KKamile. Change name");
    assert.equal(await text(page, ".hp-me b"), "Kamile");
    if (m.sheet_url) {
      const a = page.locator(".hp-links a", { hasText: "Open the Google Sheet" });
      assert.equal(await a.getAttribute("href"), m.sheet_url);
      assert.equal(await a.getAttribute("target"), "_blank");
    }
    assert.equal(await page.locator(".hp-links a", { hasText: "See Edit history" }).getAttribute("href"), "#history");

    // Stages: the stage list, without "Do not contact" while it is off.
    const stages = await page.$$eval(".hp-stages dt", (els) => els.map((e) => e.textContent.trim()));
    assert.deepEqual(stages, m.stages.map((x) => x.name).filter((n) => n !== "Do not contact"));
    assert.ok(!m.features || !m.features.dnc);

    // Today: the three blocks and the labels.
    const blocks = await page.$$eval("[aria-labelledby=hp-today-h] .is-block dt", (els) => els.map((e) => e.textContent.trim()));
    assert.deepEqual(blocks, ["Do now", "New prospects: find a contact", "Coming up"]);
    assert.ok((await page.locator(".hp-chips .hp-dl-row").count()) >= 7, "reason chips explained");

    // The five shortcuts.
    assert.equal(await page.locator(".hp-keys .hp-dl-row").count(), 5);
    assert.match(await text(page, ".hp-keys"), /Ctrl\s*\+\s*K\s*or\s*\/\s*Search.*n\s*Add site.*Enter\s*Open the site.*Esc\s*Close.*j\s*or\s*k\s*Next or previous site/);

    // Who manages which client: one row per current client, managers listed; past clients named.
    const clientRows = await page.$$eval("[aria-labelledby=hp-cl-h] tbody tr", (trs) => trs.map((tr) => tr.querySelector("th a").textContent.trim()));
    assert.deepEqual(clientRows, m.clients.map((c) => c.name));
    const soro = m.clients.find((c) => c.k === "soro");
    assert.match(await text(page, "[aria-labelledby=hp-cl-h] tbody tr:first-child"), new RegExp((soro.managers || []).join(", ")));
    if ((m.past_clients || []).length) assert.match(await text(page, "[aria-labelledby=hp-cl-h]"), /Past clients: /);
    assert.match(await text(page, "[aria-labelledby=hp-cl-h]"), /Jonas or Vik can change the team and client lists\./);

    // Automatic jobs, in Vilnius time and the site's words.
    const jobs = await text(page, "[aria-labelledby=hp-sched-h]");
    assert.match(jobs, /Automatic jobs Vilnius time/);
    assert.match(jobs, /Morning copy to the Google Sheet .*08:47/);
    assert.doesNotMatch(jobs, /daily run|sync/i);

    // No Settings for Kamile.
    assert.equal(await page.locator("[data-hp-settings]").count(), 0, "Settings are only for Jonas and Vik");
    assert.equal(await page.locator('[data-hp-act="settings"]').count(), 0);
    await shot(page, "help-kamile-1440", { fullPage: true });

    // Report a problem copies the details (never site data).
    await page.click('[data-hp-act="report"]');
    await toastWith(page, "Copied. Paste it into a message to Jonas.");
    const clip = await page.evaluate(() => navigator.clipboard.readText());
    assert.match(clip, /^PartnerGap CRM\nBuild: .*\nServer build: .*\nPage: #help\nBrowser: .+\nWhen: .+\nError: /);
    assert.doesNotMatch(clip, /example\.test|PG-\d{5}/, "no site data");
    assert.deepEqual(watch.pageErrors, [], "no page errors");
  } finally {
    await s.close();
  }
});

test("What's new: Help opens the table; the Today banner shows once, and opening or dismissing it is remembered", async () => {
  const s = await open("#help");
  const { page, watch } = s;
  try {
    await page.click('[data-hp-act="whatsnew"]');
    const modal = page.locator(MODAL + ".hp-wn-modal");
    await modal.waitFor({ state: "visible" });
    assert.equal(await modal.locator(".hp-wn-table tbody tr").count(), 10);
    assert.match(clean(await modal.innerText()), /^What's new The CRM has a new layout\. Here is where everything moved\..*Change log Footer sync line → Edit history.*Old bookmarks still work\. Got it$/);
    await shot(page, "whats-new-1440");
    await modal.locator("a[data-wn-go]", { hasText: "Edit history" }).click();
    await page.waitForFunction(() => location.hash.startsWith("#history"));
    await modal.waitFor({ state: "detached" });
    // Opening What's new counts as seen: Today shows no banner.
    await page.goto(BASE + "/#today");
    await page.locator(".td-head").waitFor();
    await page.waitForTimeout(500);
    assert.equal(await page.locator("[data-td-banner] .hp-wn-banner").count(), 0, "no banner once seen");
    assert.deepEqual(watch.pageErrors, []);
  } finally {
    await s.close();
  }

  // A new browser: the banner shows on Today; × hides it for good.
  const a = await open("#today");
  try {
    const banner = a.page.locator("[data-td-banner] .hp-wn-banner");
    await banner.waitFor({ state: "visible", timeout: 15000 });
    assert.equal(clean(await banner.innerText()), "The CRM has a new layout. See what moved");
    await shot(a.page, "today-whats-new-banner-1440");
    await a.page.click("[data-wn-dismiss]");
    await banner.waitFor({ state: "detached" });
    assert.equal(await a.page.evaluate(() => document.activeElement && document.activeElement.matches("main h1")), true, "focus moves to the heading");
    await a.page.reload();
    await a.page.locator(".td-head").waitFor();
    await a.page.waitForTimeout(500);
    assert.equal(await a.page.locator("[data-td-banner] .hp-wn-banner").count(), 0, "dismissed for good");
    assert.deepEqual(a.watch.pageErrors, []);
  } finally {
    await a.close();
  }

  // Another new browser: See what moved opens the modal and hides the banner.
  const b = await open("#today");
  try {
    await b.page.locator("[data-wn-open]").click();
    await b.page.locator(MODAL + ".hp-wn-modal").waitFor({ state: "visible" });
    assert.equal(await b.page.locator("[data-td-banner] .hp-wn-banner").count(), 0);
    await b.page.locator(MODAL + " .ui-modal-foot button", { hasText: "Got it" }).click();
    await b.page.reload();
    await b.page.locator(".td-head").waitFor();
    await b.page.waitForTimeout(500);
    assert.equal(await b.page.locator("[data-td-banner] .hp-wn-banner").count(), 0, "seen once is enough");
  } finally {
    await b.close();
  }
});

// ---------- phone and axe ----------

test("Phone (390 px): Edit history rows are cards; Help and Settings fit without sideways scroll", async () => {
  const s = await open("#history", { viewport: PHONE, contextOptions: PHONE_OPTS });
  try {
    await rowsSettled(s.page, firstPage(COUNT.all), "all edits");
    assert.equal(await s.page.locator(".hi-list thead").isVisible(), false, "no table header on a phone");
    await noHorizontalScroll(s.page, "#history 390");
    const small = await s.page.$$eval(".hi-bar button, .hi-list [data-load]", (els) => els
      .filter((e) => e.offsetParent).map((e) => [e.textContent.trim(), Math.round(e.getBoundingClientRect().height)]).filter(([, h]) => h < 44));
    assert.deepEqual(small, [], "44 px targets");
    await shot(s.page, "history-390");
    await s.page.goto(BASE + "/#history?state=not_copied");
    await rowsAll(s.page, COUNT.not_copied, "the not-copied edits");
    await noHorizontalScroll(s.page, "#history not copied 390");
    await shot(s.page, "history-not-copied-390");
  } finally {
    await s.close();
  }
  const j = await open("#help", { name: "Jonas", viewport: PHONE, contextOptions: PHONE_OPTS });
  try {
    await j.page.locator("[data-hp-addperson]").waitFor({ state: "visible", timeout: 15000 });
    await noHorizontalScroll(j.page, "#help 390");
    await shot(j.page, "help-jonas-390", { fullPage: true });
    assert.deepEqual(j.watch.pageErrors, []);
  } finally {
    await j.close();
  }
});

test("axe: no serious or critical issues on Edit history, Help, Settings and What's new (light and dark)", async () => {
  for (const colorScheme of ["light", "dark"]) {
    const s = await open("#history", { colorScheme });
    try {
      await rowsSettled(s.page, firstPage(COUNT.all), "all edits");
      await axeCheck(s.page, [["main"]], "Edit history " + colorScheme);
    } finally {
      await s.close();
    }
    const j = await open("#help", { name: "Jonas", colorScheme });
    try {
      await j.page.locator("[data-hp-addperson]").waitFor({ state: "visible", timeout: 15000 });
      await axeCheck(j.page, [["main"]], "Help with Settings " + colorScheme);
      await j.page.click('[data-hp-act="whatsnew"]');
      await j.page.locator(MODAL + ".hp-wn-modal").waitFor({ state: "visible" });
      await axeCheck(j.page, [[".hp-wn-modal"]], "What's new " + colorScheme);
      await j.page.keyboard.press("Escape");
    } finally {
      await j.close();
    }
    const t = await open("#today", { colorScheme });
    try {
      await t.page.locator("[data-td-banner] .hp-wn-banner").waitFor({ state: "visible", timeout: 15000 });
      await axeCheck(t.page, [["[data-td-banner]"]], "Today's What's new banner " + colorScheme);
    } finally {
      await t.close();
    }
  }
});

// ---------- writes ----------

test("T21: Load more shows 100 changes, then the rest; the header count follows freshness", async () => {
  const before = Number(await retry(() => maxEditN()));
  await retry(() => d1("INSERT INTO edits (at, by_whom, kind, account_id, contact_id, field, old, new, applied) " +
    "WITH RECURSIVE c(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM c WHERE i < 100) " +
    "SELECT " + q(TODAY + "T09:00:00Z") + ", 'Tomas', 'update', 'PG-00001', NULL, 'next_step', NULL, 'Load more check ' || i, 0 FROM c"));
  const s = await open("#history");
  const { page, watch } = s;
  try {
    const all = COUNT.all + 100;
    const first = await rowsSettled(page, PER, "the first page");
    assert.equal(first[0].what, "Next step: “Load more check 100”");
    assert.equal(await text(page, "[data-hi-count]"), "Showing the newest 100 changes");
    await waitFor(async () => (await text(page, ".hi-sub")).startsWith(waitingSentence(COUNT.waiting + 100)), (COUNT.waiting + 100) + " waiting");
    const more = page.locator(".hi-list [data-load]");
    assert.equal(clean(await more.innerText()), "Load more");
    const list = await rowsAll(page, all, "every edit");
    assert.equal(await page.locator(".hi-list [data-load]").count(), 0, "no more to load");
    assert.equal(await text(page, "[data-hi-count]"), plural(all, "change"));
    assert.equal(list[all - 1].what, "Owner: Vik", "the oldest edit (n 1) last");
    // The waiting filter also pages: 100, then the rest.
    await page.click('[data-hi-state="waiting"]');
    await rowsSettled(page, PER, "the first waiting page");
    await rowsAll(page, COUNT.waiting + 100, "every waiting edit");
    assert.deepEqual(watch.pageErrors, []);
  } finally {
    await s.close();
    await retry(() => d1("DELETE FROM edits WHERE n > " + before));
  }
});

test("A save made from Edit history's site panel shows up as a new Waiting row, and the count follows", async () => {
  const id = "PG-00452";
  // Without rawNulls: a NULL next_due must go back as NULL, not as the string "null".
  const [rec0] = await retry(() => d1("SELECT next_step, next_due FROM partners WHERE id = " + q(id)));
  const before = Number(await retry(() => maxEditN()));
  const e0 = await readEdits();
  // The site's own changes (account=): earlier test files on the same server can leave 100+ newer edits,
  // which would push this site's fixture edit off the unfiltered first page.
  const mine = e0.list.filter((e) => e.account_id === id).length;
  assert.ok(mine > 0, "the fixture has an edit for " + id);
  // On a phone the panel's footer has Follow up ▾.
  const s = await open("#history?account=" + id, { viewport: PHONE, contextOptions: PHONE_OPTS });
  const { page, watch } = s;
  try {
    await rowsSettled(page, firstPage(mine), "the site's edits");
    await page.locator(ROWS + ` td.hi-c-site a[data-open="${id}"]`).first().click();
    const follow = page.locator('#layer-panel [data-pfoot="follow"]');
    await follow.waitFor({ state: "visible", timeout: 15000 });
    await follow.click();
    await menuPick(page, "In 2 weeks");
    await toastWith(page, "Follow-up");
    await page.keyboard.press("Escape");
    const added = await waitFor(async () => {
      const n = Number(await retry(() => maxEditN()));
      return n > before ? n - before : 0;
    }, "the new edits rows");
    await rowsSettled(page, firstPage(mine + added), "the list with the new edits");
    const top = (await rows(page))[0];
    assert.equal(top.who, "Kamile");
    assert.equal(top.sheet, "Waiting");
    assert.match(top.site, /PG-00452/);
    await waitFor(async () => (await text(page, ".hi-sub")).startsWith(waitingSentence(e0.waitingNs.length + added)), "the waiting count");
    assert.deepEqual(watch.pageErrors, []);
  } finally {
    await s.close();
    await retry(() => d1("DELETE FROM edits WHERE n > " + before));
    await retry(() => d1("UPDATE partners SET next_step = " + q(rec0.next_step) + ", next_due = " + q(rec0.next_due) + " WHERE id = " + q(id)));
  }
});

test("T31: after a morning copy, the banner goes, the footer shows the new sheet data and Edit history says Copied", async () => {
  const day = nextWeekday(TODAY);
  const e0 = await readEdits();
  const WAITING_NS = e0.waitingNs;
  assert.ok(WAITING_NS.length > 0, "waiting edits to copy");
  const lastRun = (await retry(() => d1("SELECT status FROM runs WHERE name = 'daily' ORDER BY n DESC LIMIT 1")))[0];
  const s = await open("#history", { clock: day + "T09:00:00Z" });
  const { page, watch } = s;
  try {
    await rowsSettled(page, firstPage(e0.count.all), "all edits");
    const banner = page.locator('[data-banner="fresh"]');
    await banner.waitFor({ state: "visible", timeout: 15000 });
    assert.equal(clean(await banner.innerText()), lastRun && lastRun.status === "error"
      ? "This morning's copy to the Google Sheet stopped with an error. Your changes are saved here. If this is still showing tomorrow, tell Jonas."
      : "This morning's copy to the Google Sheet didn't pick up " + plural(WAITING_NS.length, "change") + ". They're saved here. If this is still showing tomorrow, tell Jonas.");
    assert.match(await text(page, "[data-fresh]"), /^No sheet update seen yet today$/);
    await shot(page, "t31-before-1440");

    // The simulated run: every waiting edit copied, one activity row from the sheet, the run's own row.
    await retry(() => d1("UPDATE edits SET applied = 1 WHERE n IN " + inList(WAITING_NS)));
    await retry(() => d1("INSERT INTO activity (date, account_id, type, by_whom, summary) VALUES (" + [day, "PG-00001", "Email", "Kamile", "Logged in the sheet"].map(q).join(", ") + ")"));
    await retry(() => d1("INSERT INTO runs (name, started_at, finished_at, status, summary) VALUES (" +
      ["daily", day + "T05:47:00Z", day + "T06:05:00Z", "ok", JSON.stringify({ edits_applied: WAITING_NS.length, conflicts: 0 })].map(q).join(", ") + ")"));

    await page.locator('[data-act="refresh"]:visible').first().click();
    await banner.waitFor({ state: "detached", timeout: 15000 });
    await waitFor(async () => /^Sheet data from /.test(await text(page, "[data-fresh]")), "Sheet data from …");
    await waitFor(async () => (await text(page, ".hi-sub")).startsWith(waitingSentence(0)), "Nothing is waiting");
    await waitFor(async () => (await rows(page)).filter((x) => x.sheet === "Waiting").length === 0, "no Waiting row on screen");
    assert.match(await text(page, "a[data-sync]:visible"), /nothing waiting for the Google Sheet/);
    await shot(page, "t31-after-1440");
    await page.click('[data-hi-state="copied"]');
    await rowsAll(page, e0.count.copied + WAITING_NS.length, "every copied edit");
    await page.click('[data-hi-state="not_copied"]');
    const list = await rowsAll(page, e0.count.not_copied, "the not-copied edits");
    assert.ok(list.length >= 1 && list.every((r) => r.sheet === NOT_COPIED), "the conflict stays Not copied");
    await page.click('[data-hi-state="waiting"]');
    await waitFor(async () => /No changes match\./.test(await text(page, ".hi-list").catch(() => "")), "no waiting edits");
    assert.deepEqual(watch.pageErrors, []);
  } finally {
    await s.close();
    await retry(() => d1("UPDATE edits SET applied = 0 WHERE n IN " + inList(WAITING_NS)));
    await retry(() => d1("DELETE FROM activity WHERE n > " + act0));
    await retry(() => d1("DELETE FROM runs WHERE n > " + runs0));
  }
});

test("Settings (Jonas): team add, landing page and remove reach meta and the sign-in list; no edits row", async () => {
  const names0 = await signInNames();
  assert.ok(names0.includes("Kamile") && !names0.includes("Rita"), "the sign-in list before");
  const s = await open("#help", { name: "Jonas" });
  const { page, watch } = s;
  try {
    const form = page.locator("[data-hp-addperson]");
    await form.waitFor({ state: "visible", timeout: 15000 });
    assert.match(await text(page, "[data-hp-settings] > .hp-muted"), /^Only Jonas or Vik see this\./);
    await shot(page, "help-jonas-1440", { fullPage: true });

    // A name already on the team.
    await form.locator("input").fill("kamile");
    await form.locator("button[type=submit]").click();
    await waitFor(async () => /Kamile is already on the team\./.test(await text(page, '[data-hp-err="team"]')), "the duplicate error");
    assert.equal(await form.locator("input").getAttribute("aria-invalid"), "true");

    // Add Rita.
    await form.locator("input").fill("Rita");
    await form.locator("button[type=submit]").click();
    await toastWith(page, "Rita was added to the team. Everyone sees it on their next page load.");
    let m = await meta(page);
    assert.ok(m.team.some((x) => x.name === "Rita" && x.active !== false), "meta.team has Rita");
    assert.ok((await signInNames()).includes("Rita"), "the sign-in list has Rita");
    await page.locator('[data-hp-home="Rita"]').waitFor();

    // Her landing page.
    await page.selectOption('[data-hp-home="Rita"]', "team");
    await toastWith(page, "Saved. Everyone sees it on their next page load.");
    const kvTeam = JSON.parse((await retry(() => d1("SELECT v FROM kv_meta WHERE k = 'team'")))[0].v);
    assert.deepEqual(kvTeam.find((x) => x.name === "Rita"), { name: "Rita", home: "team", active: true });

    // Remove her (Undo puts her back), then remove her again: she stays a past owner.
    await page.click('[data-hp-remove="Rita"]');
    const t = await toastWith(page, "Rita was removed from the team.");
    assert.ok(!(await signInNames()).includes("Rita"), "not on the sign-in list");
    await t.locator('[data-t="undo"]').click();
    await waitFor(async () => (await signInNames()).includes("Rita"), "Rita back on the sign-in list");
    await page.locator('[data-hp-remove="Rita"]').waitFor();
    await page.click('[data-hp-remove="Rita"]');
    await toastWith(page, "Rita was removed from the team.");
    await page.locator('[data-hp-addback="Rita"]').waitFor();
    m = await meta(page);
    assert.ok(m.team.some((x) => x.name === "Rita" && x.active === false), "a past team member");
    assert.ok(!(await signInNames()).includes("Rita"));

    // Menus follow: the Edit history Person menu lists her as a past team member.
    await page.goto(BASE + "/#history");
    await rowsSettled(page, firstPage(COUNT.all), "all edits");
    await page.click("[data-hi-person]");
    const rita = page.locator(".ui-menu .ui-mi", { hasText: "Rita" });
    await rita.waitFor();
    assert.match(clean(await rita.innerText()), /past team member/);
    await page.keyboard.press("Escape");

    assert.equal(Number(await retry(() => maxEditN())), n0, "settings never write an edits row");
    assert.equal((await retry(() => d1("SELECT COUNT(*) AS c FROM kv_meta WHERE k = 'settings_log'")))[0].c, 1, "settings_log written");
    assert.deepEqual(watch.pageErrors, []);
  } finally {
    await s.close();
  }
});

test("Settings (Jonas): add a client, mark it as past and current again; the Do not contact switch", async () => {
  const s = await open("#help", { name: "Jonas" });
  const { page, watch } = s;
  try {
    await page.locator("[data-hp-addclient]").waitFor({ state: "visible", timeout: 15000 });

    // Add client: a duplicate first, then Testco Widgets.
    await page.click("[data-hp-addclient]");
    const modal = page.locator(MODAL + ".hp-cf-modal");
    await modal.waitFor({ state: "visible" });
    await modal.locator('[name="name"]').fill("Soro");
    await modal.locator(".ui-modal-foot button", { hasText: "Add client" }).click();
    await waitFor(async () => /Soro is already a client\./.test(clean(await modal.locator("#hp-cf-err").innerText())), "the duplicate error");
    await modal.locator('[name="name"]').fill("Testco Widgets");
    assert.equal(await modal.locator("#hp-cf-err").isHidden(), true, "typing clears the error");
    await modal.locator('[name="what"]').fill("Test widgets");
    await modal.locator('[name="markets"]').fill("US");
    assert.equal(await modal.locator('[name="managers"][value="Jonas"]').isChecked(), true, "me as manager by default");
    await shot(page, "settings-add-client-1440");
    await modal.locator(".ui-modal-foot button", { hasText: "Add client" }).click();
    await toastWith(page, "Testco Widgets was added. Everyone sees it on their next page load.");
    await modal.waitFor({ state: "detached" });
    let m = await meta(page);
    const added = m.clients.find((c) => c.name === "Testco Widgets");
    assert.ok(added, "meta.clients has the new client");
    assert.deepEqual([added.k, added.what, added.managers, added.markets], ["testco widgets", "Test widgets", ["Jonas"], "US"]);
    await waitFor(async () => /Testco Widgets/.test(await text(page, "[aria-labelledby=hp-cl-h]")), "the clients card lists it");

    // Mark as past, then current again.
    await page.click('[data-hp-past="testco widgets"]');
    await toastWith(page, "Testco Widgets is now a past client.");
    m = await meta(page);
    assert.ok(m.past_clients.some((c) => c.k === "testco widgets") && !m.clients.some((c) => c.k === "testco widgets"));
    await page.click('[data-hp-current="testco widgets"]');
    await toastWith(page, "Testco Widgets is a current client again.");
    m = await meta(page);
    assert.ok(m.clients.some((c) => c.k === "testco widgets"));

    // Allow "Do not contact": a confirm to turn it on; the stage list follows.
    assert.equal(await page.locator("[data-hp-dnc]").isChecked(), false, "off by default");
    assert.match(await text(page, '[data-hp-block="dnc"]'), /Turn on only after the morning copy knows this stage\./);
    await page.click(".hp-switch");
    const confirmBox = page.locator(MODAL, { hasText: "Allow “Do not contact”?" });
    await confirmBox.waitFor({ state: "visible" });
    await confirmBox.locator(".ui-modal-foot button", { hasText: "Turn on" }).click();
    await toastWith(page, "“Do not contact” is on.");
    m = await meta(page);
    assert.equal(m.features && m.features.dnc, true, "features.dnc on");
    await waitFor(async () => (await page.$$eval(".hp-stages dt", (els) => els.map((e) => e.textContent.trim()))).includes("Do not contact"), "the stage list shows Do not contact");
    assert.equal(await page.locator("[data-hp-dnc]").isChecked(), true);
    await page.click(".hp-switch");
    await toastWith(page, "“Do not contact” is off.");
    m = await meta(page);
    assert.ok(!(m.features && m.features.dnc), "features.dnc off again");

    assert.equal(Number(await retry(() => maxEditN())), n0, "settings never write an edits row");
    assert.deepEqual(watch.pageErrors, []);
  } finally {
    await s.close();
  }
});
