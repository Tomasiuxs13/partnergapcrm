// Deals (spec 2.2.3, Appendix B.5; test T13). Owner F4.
// Run: bash tests/e2e/run.sh tests/e2e/40-deals.test.mjs   (screenshots: SHOTS_DIR, default /tmp/shots-f4)
//
// Every page runs with the clock fixed at FIXTURE_TODAY 13:00 UTC in a UTC browser: the hour the old page
// dropped a site moved to Lost that day (it counted days from noon UTC, and 0 days read as "no date").
// What each group should hold is worked out here from local D1 with plain JS (B.5 by hand: last activity is
// the latest of last_touch, the contacts' last_email, the activity dates and updated_at), not with
// rules/deals.js. Read-only tests first, then the writes: Not interested on a Negotiating deal (T13), the
// 30/31-day edge and a formula in the CSV. Every row a test changes is put back in after(), and the activity
// rows the tests add are deleted.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { baseUrl, signedInPage, signIn, browser, closeBrowser, d1, applyBefore, fixture, tools } from "./lib.mjs";

const BASE = baseUrl();
const SHOTS = process.env.SHOTS_DIR || "/tmp/shots-f4";
const fx = fixture();
const TODAY = fx.today || process.env.FIXTURE_TODAY;
const CLOCK = TODAY + "T13:00:00Z";
const DESKTOP = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };
const UTC = { timezoneId: "UTC" };
const PHONE_OPTS = { ...UTC, hasTouch: true, isMobile: true };
const GROUPS = [
  { id: "negotiating", label: "Negotiating", total: true },
  { id: "signed", label: "Signed, not live", total: true },
  { id: "live", label: "Live", total: false },
  { id: "lost", label: "Lost in the last 30 days", total: false },
];
const SLA = { Negotiating: 7, ActiveNotLive: 14 };
// Columns a test may change, put back in after().
const COLS = ["stage", "owner", "next_step", "next_due", "last_touch", "tracking_id", "updated_at", "updated_by"];
const DEAL_CSV = ["Deal type", "Flat fee", "Commission %", "Deal value", "Placement", "Went live", "Tracking ID"];
const T13_ID = (fx.groups["vik-neg"] || [])[0] || "PG-00400"; // Vik's Negotiating deal: Flat fee + commission, $250 + 10%, value 1,000

let original = {};
let activity0 = 0;

// ---------- plain-JS B.5 ----------

const has = (v) => v != null && String(v).trim() !== "";
const DAY_MS = 86400000;
// The calendar day of a date or a timestamp, in UTC (the browser runs in UTC too).
function dayOf(v) {
  if (!has(v)) return null;
  const s = String(v).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  if (!/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(s)) return null;
  const iso = s.replace(" ", "T");
  const t = new Date(/(Z|[+-]\d{2}:?\d{2})$/i.test(iso) ? iso : iso + "Z");
  return isNaN(t.getTime()) ? null : t.toISOString().slice(0, 10);
}
const daysBetween = (a, b) => Math.round((Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / DAY_MS);
function addDays(iso, n) {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function lastActivity(r) {
  let best = null;
  for (const v of [r.last_touch, r.last_email, r.act_at, r.updated_at]) {
    const d = dayOf(v);
    if (d && (!best || d > best)) best = d;
  }
  return best;
}
const valueOf = (r) => (r.deal_value != null ? Number(r.deal_value) : r.deal_flat != null ? Number(r.deal_flat) : null);
function money(x) {
  const r = Math.round(Math.abs(x) * 100) / 100;
  const [i, f] = String(r).split(".");
  return "$" + i.replace(/\B(?=(\d{3})+(?!\d))/g, ",") + (f ? "." + f.padEnd(2, "0") : "");
}
const waiting = (r) => /^\s*waiting on client:/i.test(r.next_step || "");
function quiet(r) {
  const la = lastActivity(r);
  if (!la) return false;
  const due = dayOf(r.next_due);
  if (due && due > TODAY) return false; // snoozed
  const q = daysBetween(la, TODAY);
  if (r.stage === "Negotiating") return q > SLA.Negotiating;
  if (r.stage === "Active" && !has(r.content_url)) return q > SLA.ActiveNotLive;
  return false;
}
function groupOf(r) {
  if (r.stage === "Negotiating") return "negotiating";
  if (r.stage === "Active") return has(r.content_url) ? "live" : "signed";
  if (r.stage === "Lost") {
    const la = lastActivity(r);
    return la && daysBetween(la, TODAY) <= 30 ? "lost" : null;
  }
  return null;
}
const clientKeys = (r) => String(r.clients || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);

// {negotiating: [rows], ..., all: [rows]} for the rows a filter keeps.
function expectGroups(rows, keep = () => true) {
  const out = { negotiating: [], signed: [], live: [], lost: [], all: [] };
  for (const r of rows) {
    const g = groupOf(r);
    if (!g || !keep(r)) continue;
    out[g].push(r);
    out.all.push(r);
  }
  return out;
}
function headingText(g, list) {
  const n = list.length;
  const vals = list.map(valueOf).filter((v) => v != null);
  if (!g.total || !vals.length) return g.label + " (" + n + ")";
  return g.label + " (" + n + " · " + money(vals.reduce((a, b) => a + Math.round(b * 100), 0) / 100) + ")";
}
const ids = (list) => list.map((r) => r.id).sort();

// ---------- D1 ----------

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
const q = (v) => "'" + String(v).replace(/'/g, "''") + "'";
const inList = (list) => "(" + list.map(q).join(",") + ")";

const DEAL_FIELDS = ["stage", "owner", "clients", "next_step", "next_due", "last_touch", "updated_at", "deal_model", "deal_flat",
  "deal_pct", "deal_value", "content_url", "live_date", "tracking_id"];
async function dealRows() {
  const obj = "json_object('id', p.id, " + DEAL_FIELDS.map((c) => "'" + c + "', p." + c).join(", ") +
    ", 'last_email', (SELECT MAX(last_email) FROM contacts c WHERE c.account_id = p.id)" +
    ", 'act_at', (SELECT MAX(date) FROM activity a WHERE a.account_id = p.id))";
  const rows = await retry(() => d1("SELECT " + obj + " AS j FROM partners p WHERE p.stage IN ('Negotiating', 'Active', 'Lost')", { rawNulls: true }));
  return rows.map((r) => JSON.parse(r.j));
}
async function readRows(list) {
  const obj = "json_object('id', id, " + COLS.map((c) => "'" + c + "', " + c).join(", ") + ")";
  const rows = await retry(() => d1("SELECT " + obj + " AS j FROM partners WHERE id IN " + inList(list), { rawNulls: true }));
  const out = {};
  for (const r of rows) {
    const o = JSON.parse(r.j);
    out[o.id] = {};
    for (const c of COLS) out[o.id][c] = o[c];
  }
  return out;
}
async function remember(list) {
  const fresh = list.filter((id) => !original[id]);
  if (fresh.length) Object.assign(original, await readRows(fresh));
}
async function restore(list) {
  const back = {};
  for (const id of list) if (original[id]) back[id] = original[id];
  if (!Object.keys(back).length) return;
  await retry(() => d1("DELETE FROM activity WHERE n > " + activity0 + " AND account_id IN " + inList(Object.keys(back))));
  await applyBefore(back);
}

// ---------- page helpers ----------

function settled(page) {
  return page.waitForFunction(() => document.getAnimations().every((a) =>
    a.playState !== "running" || (a.effect && a.effect.getComputedTiming().iterations === Infinity)));
}
async function shot(page, name, opts = {}) {
  await settled(page);
  return page.screenshot({ path: path.join(SHOTS, name + ".png"), ...opts });
}

async function openDeals({ name = "Kamile", hash = "", viewport = DESKTOP, contextOptions = UTC, colorScheme } = {}) {
  const s = await signedInPage({ name, viewport, clock: CLOCK, colorScheme, contextOptions });
  await s.page.goto(BASE + "/#deals" + hash);
  await ready(s.page);
  return s;
}
function ready(page) {
  return page.waitForSelector(".dl-group:not([hidden]), .dl-empty:not([hidden])", { timeout: 20000 });
}

// What the page shows: per group, its heading text and its row ids (in order), for the groups not hidden.
function shown(page) {
  return page.evaluate(() => {
    const out = {};
    for (const sec of document.querySelectorAll("[data-dl-group]")) {
      if (sec.hidden) continue;
      out[sec.getAttribute("data-dl-group")] = {
        heading: sec.querySelector(".dl-h").textContent.replace(/\s+/g, " ").trim(),
        ids: Array.from(sec.querySelectorAll("tbody tr[data-key]")).map((tr) => tr.getAttribute("data-key")),
      };
    }
    return out;
  });
}
async function assertShows(page, exp, where) {
  const got = await shown(page);
  const want = {};
  for (const g of GROUPS) if (exp[g.id].length) want[g.id] = { heading: headingText(g, exp[g.id]), ids: ids(exp[g.id]) };
  const gotSorted = {};
  for (const [k, v] of Object.entries(got)) gotSorted[k] = { heading: v.heading, ids: v.ids.slice().sort() };
  assert.deepEqual(gotSorted, want, where);
  return got;
}

async function noHorizontalScroll(page, where) {
  const { sw, cw } = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
  assert.ok(sw <= cw, where + ": no horizontal scroll (" + sw + " > " + cw + ")");
}

async function writesDuring(page, fn) {
  const seen = [];
  const onReq = (r) => {
    if (r.method() !== "GET" && /\/api\//.test(r.url())) seen.push(r.method() + " " + new URL(r.url()).pathname);
  };
  page.on("request", onReq);
  try {
    await fn();
  } finally {
    page.off("request", onReq);
  }
  return seen;
}

async function waitFor(fn, what, ms = 15000) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    last = await fn();
    if (last) return last;
    await new Promise((r) => setTimeout(r, 200));
  }
  assert.fail("timed out waiting for " + what);
}

const row = (id) => 'tbody tr[data-key="' + id + '"]';
const inGroup = (g, id) => '[data-dl-group="' + g + '"] ' + row(id);
const menuLabels = (page) => page.$$eval(".ui-menu .ui-mi-label", (els) => els.filter((e) => e.offsetParent !== null).map((e) => e.textContent.trim()));

// A small RFC 4180 reader: rows of cells, without the BOM.
function parseCsv(text) {
  const s = text.replace(/^﻿/, "");
  const rows = [];
  let cell = "", cur = [], quoted = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quoted) {
      if (ch === '"' && s[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") { cur.push(cell); cell = ""; }
    else if (ch === "\r" && s[i + 1] === "\n") { cur.push(cell); rows.push(cur); cur = []; cell = ""; i++; }
    else if (ch === "\n") { cur.push(cell); rows.push(cur); cur = []; cell = ""; }
    else cell += ch;
  }
  if (cell !== "" || cur.length) { cur.push(cell); rows.push(cur); }
  return rows;
}
async function downloadCsv(page) {
  const [dl] = await Promise.all([page.waitForEvent("download"), page.click("[data-dl-csv]")]);
  const file = await dl.path();
  return { name: dl.suggestedFilename(), rows: parseCsv(fs.readFileSync(file, "utf8")) };
}

// ---------- setup / teardown ----------

before(async () => {
  assert.ok(BASE, "BASE_URL is set (run through tests/e2e/run.sh)");
  assert.ok(!/:8788\b/.test(BASE), "never the main dev server");
  assert.ok(TODAY, "FIXTURE_TODAY");
  fs.mkdirSync(SHOTS, { recursive: true });
  activity0 = Number((await retry(() => d1("SELECT COALESCE(MAX(n), 0) AS n FROM activity")))[0].n);
  await remember([T13_ID]);
});

after(async () => {
  try {
    await restore(Object.keys(original));
  } finally {
    await closeBrowser();
  }
});

// ---------- read-only ----------

test("T13: the groups, counts and totals at 13:00 UTC are B.5 worked out by hand; terms, badges and actions on every row", async () => {
  const rows = await dealRows();
  const exp = expectGroups(rows);
  // The fixture's shape (so this test keeps meaning something): every group has rows, Negotiating has
  // waiting and quiet deals, and Lost leaves out the older sites.
  for (const g of GROUPS) assert.ok(exp[g.id].length > 0, g.id + " has rows in the fixture");
  assert.ok(rows.filter((r) => r.stage === "Lost").length > exp.lost.length, "some Lost sites are older than 30 days");
  const { page, watch, close } = await openDeals({ name: "Kamile" });
  try {
    assert.equal((await page.textContent("main h1")).trim(), "Deals");
    assert.match(await page.textContent(".dl-sub"), /lost in the last 30 days/);
    const got = await assertShows(page, exp, "Kamile, no filters");
    assert.deepEqual(Object.keys(got), GROUPS.map((g) => g.id), "groups in B.5 order");
    // Lost: most recent first.
    const lostDays = got.lost.ids.map((id) => lastActivity(rows.find((r) => r.id === id)));
    assert.deepEqual(lostDays, lostDays.slice().sort().reverse(), "Lost is most recent first");

    // No board, no drag, no Replied column.
    assert.equal(await page.$$eval("main [draggable='true']", (els) => els.length), 0, "nothing to drag");
    const heads = await page.$$eval("[data-dl-group]:not([hidden]) thead th", (ths) => ths.map((t) => t.textContent.trim()));
    assert.ok(!heads.includes("Replied") && !heads.includes("Stage"), "no Replied or Stage column: " + heads.join("|"));

    // Terms inline: amounts over the model; the deal value in its own column.
    const t13 = await page.evaluate((sel) => {
      const tr = document.querySelector(sel);
      return { amt: tr.querySelector(".dl-amt").textContent.trim(), model: tr.querySelector(".dl-model").textContent.trim(), value: tr.querySelector(".is-c-value").textContent.trim() };
    }, inGroup("negotiating", T13_ID));
    assert.deepEqual(t13, { amt: "$250 + 10%", model: "Flat fee + commission", value: "$1,000" });

    // Waiting on client badges and Quiet chips are on the right rows.
    const marks = await page.evaluate(() => {
      const out = { waiting: [], quiet: [] };
      for (const tr of document.querySelectorAll("[data-dl-group]:not([hidden]) tbody tr")) {
        const k = tr.getAttribute("data-key");
        if (tr.querySelector(".ui-chip.is-wait")) out.waiting.push(k);
        const qc = tr.querySelector(".dl-quiet");
        if (qc) out.quiet.push(k + ":" + qc.textContent.trim());
      }
      return out;
    });
    const expWaiting = exp.all.filter(waiting);
    assert.ok(expWaiting.length >= 1, "the fixture has deals waiting on the client");
    assert.deepEqual(marks.waiting.sort(), ids(expWaiting), "Waiting on client badges");
    const expQuiet = exp.all.filter(quiet).map((r) => r.id + ":Quiet " + daysBetween(lastActivity(r), TODAY) + "d").sort();
    assert.ok(expQuiet.length >= 1, "the fixture has quiet deals");
    assert.deepEqual(marks.quiet.sort(), expQuiet, "Quiet chips");

    // Log what happened on every row (and no Follow up button: Log what happened is the one action).
    const acts = await page.$$eval("[data-dl-group]:not([hidden]) tbody tr", (trs) => trs.map((tr) => {
      const b = tr.querySelector('[data-row-act="log"]');
      return !!b && b.offsetParent !== null && !tr.querySelector('[data-row-act="follow"]');
    }));
    assert.equal(acts.length, exp.all.length);
    assert.ok(acts.every(Boolean), "a visible Log what happened on every row");

    // Live: the placement link opens in a new tab.
    const live = exp.live[0];
    const link = await page.$eval(inGroup("live", live.id) + " .dl-plink", (a) => ({ href: a.getAttribute("href"), target: a.target, rel: a.rel }));
    assert.deepEqual(link, { href: live.content_url, target: "_blank", rel: "noopener noreferrer" });

    await noHorizontalScroll(page, "Kamile 1440");
    await shot(page, "deals-kamile-1440", { fullPage: true });
    assert.deepEqual(watch.pageErrors, []);
  } finally {
    await close();
  }
});

test("Filters: Waiting on client, Owner (menu and me), Client; the empty filtered state clears them", async () => {
  const rows = await dealRows();
  const { page, close } = await openDeals({ name: "Jonas" });
  try {
    // Waiting on client: a toggle in the bar, kept in the URL.
    await page.click('[data-ffield="waiting"]');
    await page.waitForFunction(() => /[?&]waiting=1\b/.test(location.hash));
    assert.equal(await page.getAttribute('[data-ffield="waiting"]', "aria-pressed"), "true");
    const w = expectGroups(rows, waiting);
    assert.ok(w.all.length >= 2, "waiting deals in the fixture");
    await assertShows(page, w, "waiting=1");
    await page.click('[data-ffield="waiting"]');
    await page.waitForFunction(() => !/waiting=/.test(location.hash));
    await assertShows(page, expectGroups(rows), "waiting off");

    // Owner from the menu (default: everyone).
    await page.click('[data-ffield="owner"]');
    await page.click('.ui-menu .ui-mi-label:text-is("Vik")');
    await page.waitForFunction(() => /[?&]owner=Vik\b/.test(location.hash));
    await assertShows(page, expectGroups(rows, (r) => r.owner === "Vik"), "owner=Vik");

    // Owner = me (Jonas), through the URL.
    await page.goto(BASE + "/#deals?owner=me");
    await ready(page);
    const mine = expectGroups(rows, (r) => r.owner === "Jonas");
    assert.ok(mine.all.length >= 3, "Jonas has deals");
    await assertShows(page, mine, "owner=me as Jonas");
    await shot(page, "deals-jonas-mine-1440");

    // Client, through the URL.
    await page.goto(BASE + "/#deals?client=soro");
    await ready(page);
    await assertShows(page, expectGroups(rows, (r) => clientKeys(r).includes("soro")), "client=soro");

    // Nothing matches: the filtered empty state, and Clear filters brings everything back.
    await page.goto(BASE + "/#deals?owner=none&waiting=1");
    await ready(page);
    assert.equal(expectGroups(rows, (r) => !has(r.owner) && waiting(r)).all.length, 0);
    await page.waitForSelector(".dl-empty:not([hidden])");
    assert.match((await page.textContent(".dl-empty")).replace(/\s+/g, " "), /No deals match\./);
    assert.equal(await page.isDisabled("[data-dl-csv]"), true, "nothing to export");
    await page.click('.dl-empty [data-empty-act="clear"]');
    await page.waitForFunction(() => !/owner=|waiting=/.test(location.hash));
    await ready(page);
    await assertShows(page, expectGroups(rows), "after Clear filters");
  } finally {
    await close();
  }
});

test("No deals at all: the empty state from Appendix C", async () => {
  const b = await browser();
  const context = await b.newContext({ viewport: DESKTOP, ...UTC });
  const page = await context.newPage();
  try {
    await page.clock.setFixedTime(new Date(CLOCK));
    // The real list without its deals.
    await page.route(/\/api\/partners\?v=2$/, async (route) => {
      const res = await route.fetch();
      const body = await res.json();
      const si = Array.isArray(body.cols) ? body.cols.indexOf("stage") : -1;
      body.rows = (body.rows || []).filter((r) => !["Negotiating", "Active", "Lost"].includes(Array.isArray(r) ? r[si] : r.stage));
      await route.fulfill({ response: res, json: body });
    });
    await signIn(page, { name: "Kamile" });
    await page.goto(BASE + "/#deals");
    await page.waitForSelector(".dl-empty:not([hidden])", { timeout: 20000 });
    const text = (await page.textContent(".dl-empty")).replace(/\s+/g, " ").trim();
    assert.match(text, /No deals yet\. ?Sites move here when they reach Negotiating\./);
    assert.equal(await page.$$eval("[data-dl-group]:not([hidden])", (s) => s.length), 0, "no group shows");
    assert.equal(await page.isDisabled("[data-dl-csv]"), true);
  } finally {
    await context.close();
  }
});

test("Opening a deal opens it over its group (queue), and Esc comes back to the list", async () => {
  const { page, close } = await openDeals({ name: "Kamile" });
  try {
    const order = (await shown(page)).negotiating.ids;
    await page.click(row(order[2]) + " a[data-open]");
    await page.waitForSelector('#layer-panel .ui-panel[data-panel="' + order[2] + '"]');
    await page.waitForSelector("#layer-panel .ui-queue-text");
    assert.equal((await page.textContent("#layer-panel .ui-queue-text")).replace(/\s+/g, " ").trim(), "3 of " + order.length + " · Negotiating");
    await page.keyboard.press("Escape");
    await page.waitForSelector("#layer-panel .ui-panel", { state: "detached" });
    assert.ok(await page.isVisible('[data-dl-group="negotiating"]'));
  } finally {
    await close();
  }
});

test("Export CSV: every deal shown, group by group, with the deal columns", async () => {
  const rows = await dealRows();
  const exp = expectGroups(rows);
  const { page, close } = await openDeals({ name: "Kamile" });
  try {
    const csv = await downloadCsv(page);
    assert.equal(csv.name, "partnergap-deals-" + TODAY + ".csv");
    const [head, ...body] = csv.rows;
    assert.equal(head[0], "Group");
    for (const c of ["ID", "Site", "Stage", "Owner", "Clients", "Next step", ...DEAL_CSV]) assert.ok(head.includes(c), "CSV has " + c);
    assert.equal(body.length, exp.all.length, "one line per deal");
    const col = (name) => head.indexOf(name);
    const got = {};
    for (const line of body) (got[line[col("Group")]] ||= []).push(line[col("ID")]);
    const want = {};
    for (const g of GROUPS) want[g.label] = ids(exp[g.id]);
    for (const k of Object.keys(got)) got[k].sort();
    assert.deepEqual(got, want, "groups and ids");
    assert.deepEqual(body.map((l) => l[col("Group")]).filter((v, i, a) => a.indexOf(v) === i), GROUPS.map((g) => g.label), "in the order shown");
    const t = body.find((l) => l[col("ID")] === T13_ID);
    assert.deepEqual([t[col("Deal type")], t[col("Flat fee")], t[col("Commission %")], t[col("Deal value")]], ["Flat fee + commission", "250", "10", "1000"]);
    const lv = exp.live.find((r) => has(r.live_date));
    const l = body.find((x) => x[col("ID")] === lv.id);
    assert.deepEqual([l[col("Placement")], l[col("Went live")]], [lv.content_url, lv.live_date]);

    // With a filter, the CSV has what the page shows.
    await page.click('[data-ffield="waiting"]');
    await page.waitForFunction(() => /[?&]waiting=1\b/.test(location.hash));
    const w = await downloadCsv(page);
    assert.deepEqual(w.rows.slice(1).map((x) => x[col("ID")]).sort(), ids(expectGroups(rows, waiting).all));
  } finally {
    await close();
  }
});

test("Phone 390: cards with terms and next step, no sideways scroll, Log what happened behind ⋯", async () => {
  const { page, watch, close } = await openDeals({ name: "Kamile", viewport: PHONE, contextOptions: PHONE_OPTS });
  try {
    await noHorizontalScroll(page, "Kamile 390");
    assert.equal(await page.isVisible("[data-dl-group] thead"), false, "cards, not a table head");
    const card = inGroup("negotiating", T13_ID);
    assert.equal(await page.isVisible(card + " .dl-amt"), true, "terms on the card");
    assert.equal(await page.isVisible(card + ' [data-row-act="log"]'), false);
    await page.click(card + ' [data-row-act="more"]');
    await page.waitForSelector(".ui-menu .ui-mi-label");
    assert.deepEqual(await menuLabels(page), ["Log what happened…", "Follow up…"]);
    await page.keyboard.press("Escape");
    await page.waitForSelector(".ui-menu", { state: "hidden" });
    // Each card fits the screen.
    const wide = await page.$$eval("[data-dl-group]:not([hidden]) tbody tr", (trs) => trs.filter((tr) => tr.getBoundingClientRect().right > innerWidth + 0.5).length);
    assert.equal(wide, 0);
    await shot(page, "deals-kamile-390");
    assert.deepEqual(watch.pageErrors, []);
  } finally {
    await close();
  }
  // A tablet-sized desktop: Log what happened moves into ⋯ as well.
  const s = await openDeals({ name: "Jonas", viewport: { width: 1024, height: 768 } });
  try {
    await noHorizontalScroll(s.page, "Jonas 1024");
    assert.equal(await s.page.isVisible(inGroup("negotiating", T13_ID) + ' [data-row-act="more"]'), true);
    await shot(s.page, "deals-jonas-1024");
  } finally {
    await s.close();
  }
});

test("Re-rendering 20 times leaves the same listeners, and one click opens one menu", async () => {
  const { page, watch, close } = await openDeals({ name: "Kamile" });
  try {
    const cdp = await page.context().newCDPSession(page);
    const count = async () => {
      const out = {};
      for (const expr of ["document", "window"]) {
        const { result } = await cdp.send("Runtime.evaluate", { expression: expr });
        const { listeners } = await cdp.send("DOMDebugger.getEventListeners", { objectId: result.objectId, depth: -1, pierce: true });
        for (const l of listeners) out[l.type] = (out[l.type] || 0) + 1;
        await cdp.send("Runtime.releaseObject", { objectId: result.objectId });
      }
      return out;
    };
    const before = await count();
    assert.ok(before.click >= 1, "click listeners found");
    const frame = () => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0))));
    // 20 route changes (the Waiting on client filter on and off) and 20 store changes.
    for (let i = 0; i < 20; i++) {
      await page.evaluate((on) => import("/js/core/router.js").then((m) => m.setParams({ waiting: on ? "1" : null }, { replace: true })), i % 2 === 0);
      await page.waitForFunction((on) => /[?&]waiting=1\b/.test(location.hash) === on, i % 2 === 0);
      await frame();
    }
    for (let i = 0; i < 20; i++) {
      await page.evaluate(([id, n]) => import("/js/core/store.js").then((s) => s.patchLocal(id, { next_step: "Agree terms (" + n + ")" })), [T13_ID, i]);
      await frame();
    }
    await page.waitForFunction((sel) => /Agree terms \(19\)/.test(document.querySelector(sel).textContent), inGroup("negotiating", T13_ID));
    // Leaving the page and coming back.
    for (let i = 0; i < 3; i++) {
      await page.evaluate(() => { location.hash = "#sites"; });
      await page.waitForSelector("[data-dl-group]", { state: "detached" });
      await page.evaluate(() => { location.hash = "#deals"; });
      await ready(page);
    }
    await frame();
    const afterCount = await count();
    assert.deepEqual(afterCount, before, "the same listeners by type");

    // One click: one menu.
    await page.click(inGroup("negotiating", T13_ID) + ' [data-row-act="log"]');
    await page.waitForSelector(".ui-menu .ui-mi-label");
    await page.waitForTimeout(150);
    assert.equal(await page.$$eval(".ui-menu", (ms) => ms.filter((m) => m.getClientRects().length > 0).length), 1, "one menu open");
    await page.keyboard.press("Escape");
    assert.deepEqual(watch.pageErrors, []);
  } finally {
    await close();
  }
});

test("axe: no serious or critical issues on Deals (light and dark, desktop and phone)", async () => {
  const axeSrc = fs.readFileSync(tools().axe, "utf8");
  const runs = [
    { colorScheme: "light", viewport: DESKTOP, contextOptions: UTC },
    { colorScheme: "dark", viewport: DESKTOP, contextOptions: UTC },
    { colorScheme: "dark", viewport: PHONE, contextOptions: PHONE_OPTS },
  ];
  for (const o of runs) {
    const { page, close } = await openDeals({ name: "Kamile", ...o });
    try {
      await settled(page);
      await page.evaluate(axeSrc);
      const res = await page.evaluate(async () => {
        const r = await window.axe.run({ include: [["main"]] }, { resultTypes: ["violations"] });
        return r.violations.filter((v) => v.impact === "serious" || v.impact === "critical")
          .map((v) => v.id + ": " + v.help + " -> " + v.nodes.slice(0, 3).map((n) => n.target.join(" ")).join(" | "));
      });
      assert.deepEqual(res, [], o.colorScheme + " " + o.viewport.width);
      if (o.colorScheme === "dark") await shot(page, "deals-kamile-" + o.viewport.width + "-dark");
    } finally {
      await close();
    }
  }
});

// ---------- writes ----------

test("T13: Not interested on a Negotiating deal at 13:00 UTC: one request, the site shows in Lost in the last 30 days, the totals follow", async () => {
  const rows = await dealRows();
  const exp = expectGroups(rows);
  const target = exp.negotiating.find((r) => r.id === T13_ID);
  assert.ok(target, T13_ID + " is Negotiating");
  await remember([T13_ID]);
  const { page, watch, close } = await openDeals({ name: "Jonas" });
  try {
    const n0 = exp.negotiating.length;
    // The menu has what fits Negotiating.
    await page.click(inGroup("negotiating", T13_ID) + ' [data-row-act="log"]');
    await page.waitForSelector(".ui-menu .ui-mi-label");
    assert.deepEqual(await menuLabels(page), ["Approve offer", "Counter-offer", "Ask the client", "Not interested", "More"]);
    await page.click('.ui-menu .ui-mi-label:text-is("Not interested")');
    await page.waitForSelector(".ui-pop form");
    const writes = await writesDuring(page, async () => {
      await page.locator('.ui-pop input[name="reason"]').first().check();
      await page.click('.ui-pop button[type="submit"]');
      await page.waitForSelector(inGroup("lost", T13_ID), { timeout: 15000 });
      await waitFor(async () => (await readRows([T13_ID]))[T13_ID].stage === "Lost", "the row is Lost in D1");
    });
    assert.deepEqual(writes, ["POST /api/partner/" + T13_ID + "/outcome"], "one request");
    assert.equal(await page.$(inGroup("negotiating", T13_ID)), null, "gone from Negotiating");

    // The groups, counts and totals follow: worked out again from D1.
    const now = await dealRows();
    const moved = now.find((r) => r.id === T13_ID);
    assert.equal(lastActivity(moved), TODAY, "last activity is today");
    const exp2 = expectGroups(now);
    assert.equal(exp2.negotiating.length, n0 - 1);
    assert.ok(exp2.lost.some((r) => r.id === T13_ID), "B.5 by hand puts it in Lost");
    await waitFor(async () => (await shown(page)).negotiating.heading === headingText(GROUPS[0], exp2.negotiating), "the Negotiating heading");
    await assertShows(page, exp2, "after Not interested");
    // Focus stays on the page (not lost to the body).
    assert.ok(await page.evaluate(() => document.activeElement && document.activeElement !== document.body), "focus kept");
    await shot(page, "deals-jonas-moved-to-lost", { fullPage: true });

    // A fresh load (server data, the same 13:00 UTC clock) shows it in Lost too.
    await page.reload();
    await ready(page);
    await page.waitForSelector(inGroup("lost", T13_ID));
    await assertShows(page, exp2, "after a reload");
    const lostRow = (await shown(page)).lost.ids;
    assert.equal(lostRow[0], T13_ID, "the most recent Lost site comes first");
    assert.deepEqual(watch.pageErrors, []);
  } finally {
    await close();
    await restore([T13_ID]);
  }
});

test("Lost in the last 30 days: 30 days ago is in, 31 days ago is out", async () => {
  const rows = await dealRows();
  // A Lost site older than 30 days whose other dates are older than 31 days, so last_touch decides.
  const pick = rows.find((r) => r.stage === "Lost" && groupOf(r) == null &&
    [r.last_email, r.act_at, r.updated_at].every((v) => !dayOf(v) || daysBetween(dayOf(v), TODAY) > 31));
  assert.ok(pick, "a Lost site to move");
  await remember([pick.id]);
  try {
    for (const [days, inside] of [[30, true], [31, false]]) {
      await retry(() => d1("UPDATE partners SET last_touch = " + q(addDays(TODAY, -days)) + " WHERE id = " + q(pick.id)));
      const { page, close } = await openDeals({ name: "Kamile" });
      try {
        const got = await shown(page);
        assert.equal(((got.lost && got.lost.ids) || []).includes(pick.id), inside, days + " days ago");
        await assertShows(page, expectGroups(await dealRows()), days + " days ago");
      } finally {
        await close();
      }
    }
  } finally {
    await restore([pick.id]);
  }
});

test("CSV: a cell that starts with = is written as text", async () => {
  const rows = await dealRows();
  const live = expectGroups(rows).live[0];
  await remember([live.id]);
  try {
    await retry(() => d1("UPDATE partners SET tracking_id = '=HYPERLINK(\"https://evil.example.test\",\"x\")' WHERE id = " + q(live.id)));
    const { page, close } = await openDeals({ name: "Kamile" });
    try {
      const csv = await downloadCsv(page);
      const head = csv.rows[0];
      const line = csv.rows.find((l) => l[head.indexOf("ID")] === live.id);
      assert.equal(line[head.indexOf("Tracking ID")], "'=HYPERLINK(\"https://evil.example.test\",\"x\")");
    } finally {
      await close();
    }
  } finally {
    await restore([live.id]);
  }
});
