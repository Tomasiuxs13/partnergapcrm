// Sites and bulk (spec 2.2.2, 4.7, 4.8, Appendix B.4; tests T5, T11, T12, T26). Owner F3.
// Run: bash tests/e2e/run.sh tests/e2e/30-sites.test.mjs   (screenshots: SHOTS_DIR, default /tmp/shots-f3)
//
// Read-only tests first, on the untouched fixture: the four tabs and their counts, every filter (Melograno
// all and a product, Has suggestion, big sites), the presets, quiet=14 with Start (queue mode), CSV (T26),
// read-only mode, phone layout, axe, and the 7,500-site timing (a synthetic list served in place of
// GET /api/partners). Then the writes, each on rows put back in after(): Claim and Assign to client manager,
// T5 (stage pill), T11 (bulk follow-up on a page of 100 with Undo), T12 (Soro next to existing tokens), bulk
// Lost with one reason, Set next step only where empty, the confirm over 20 and the 100 cap.
// Expected numbers come from the fixture (tests/fixtures/make-seed.mjs): raw counts and groups, plus the
// fixture's v2 rows run through model.derive for the derived columns (reply date, last activity, clients).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { baseUrl, signedInPage, closeBrowser, d1, applyBefore, fixture, tools } from "./lib.mjs";
import { fixtureMeta } from "../fixtures/make-seed.mjs";
import { derive } from "../../crm/dashboard/js/core/model.js";
import { chipDate } from "../../crm/dashboard/js/core/outcomes.js";

const BASE = baseUrl();
const SHOTS = process.env.SHOTS_DIR || "/tmp/shots-f3";
const fx = fixture();
const TODAY = fx.today || process.env.FIXTURE_TODAY;
const HAS_SUGG = String(process.env.D1_TABLES || "").split(",").includes("suggestions");
const meta = fixtureMeta();
const COLS = ["name", "stage", "owner", "clients", "type", "next_step", "next_due", "updated_at", "updated_by"];
const DESKTOP = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };
const PHONE_OPTS = { hasTouch: true, isMobile: true };
const TABS = ["mine", "unowned", "waiting", "all"];
const SHEET = "This also updates the Google Sheet on the next weekday morning.";

const one = (tag) => {
  const ids = fx.groups[tag];
  assert.ok(ids && ids.length, "fixture group " + tag);
  return ids[0];
};
const ID = {
  note: one("c-note"), // Contacted, MailerLite/MailerSend
  lost: one("c-lost"), // Contacted, Ultahost
  nochange: one("c-nochange"), // Contacted, next step "Follow up if no reply"
  bulkE: one("c-bulk-e"),
  bulkF: one("c-bulk-f"),
  spare1: one("c-spare-1"),
  spare2: one("c-spare-2"),
  spare3: one("c-spare-3"),
  spare4: one("c-spare-4"),
};

// ---------- expected values ----------

// v2 rows of the fixture (spec 6.3.2): the partners columns plus the joined lookups (as lib/crm.js#v2Sql).
function v2Rows() {
  const by = (list, key) => {
    const m = new Map();
    for (const x of list) (m.get(x[key]) || m.set(x[key], []).get(x[key])).push(x);
    return m;
  };
  const contacts = by(fx.contacts, "account_id");
  const acts = by(fx.activity, "account_id");
  const sugg = by(HAS_SUGG ? fx.suggestions.filter((s) => s.status === "open" && (s.kind === "candidate" || s.kind === "email")) : [], "account_id");
  const max = (list, k) => list.reduce((m, x) => (x[k] != null && (m == null || x[k] > m) ? x[k] : m), null);
  return fx.partners.map((p) => {
    const cs = contacts.get(p.id) || [];
    const contactLabel = cs.map((c) => [c.first_name, c.last_name].filter(Boolean).join(" ") || (c.email || "").split("@")[0]).find(Boolean);
    return Object.assign({}, p, {
      label: p.name || p.domain || contactLabel || "Unnamed creator",
      last_email: max(cs, "last_email"),
      replied_contact: cs.length ? Math.max(...cs.map((c) => Number(c.replied) || 0)) : null,
      act_at: max(acts.get(p.id) || [], "date"),
      sugg: (sugg.get(p.id) || []).length || null,
    });
  });
}
const recs = v2Rows().map((r) => derive(r, { meta, today: TODAY }));
const byId = new Map(recs.map((r) => [r.id, r]));
const has = (v) => v != null && String(v).trim() !== "";
const isNew = (r) => r.stage === "New" || r.stage === "Researching";
const visible = recs.filter((r) => !r.isPlatform);
const kamileWaiting = recs.filter((r) => r.stage === "Contacted" && r.owner === "Kamile");
const EXPECT = {
  mine: fx.groups["kamile-new"].slice().sort(),
  unowned: visible.filter((r) => isNew(r) && !has(r.owner)).map((r) => r.id).sort(),
  unownedBig: recs.filter((r) => isNew(r) && !has(r.owner)).map((r) => r.id).sort(),
  waiting: kamileWaiting.length,
  waitingAll: fx.counts.by_stage.Contacted,
  all: fx.partners.length - fx.groups.platform.length,
};

// B.1 rule 6 without the cap, from the raw columns: Contacted, not snoozed, quiet > 14 days or no date.
function rawNoReply(p) {
  if (p.stage !== "Contacted") return false;
  if (p.next_due && p.next_due > TODAY) return false;
  const days = [p.last_touch, p.last_email, p.act_at, p.updated_at].filter(Boolean).map((v) => String(v).slice(0, 10)).sort();
  if (!days.length) return true;
  const ms = Date.parse(TODAY + "T00:00:00Z") - Date.parse(days[days.length - 1] + "T00:00:00Z");
  return ms / 86400000 > 14;
}
const QUIET_K = v2Rows().filter((p) => p.owner === "Kamile" && rawNoReply(p)).map((p) => p.id);

function addDays(iso, n) {
  const d = new Date(iso + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function addWorkingDays(iso, n) {
  let d = iso;
  let left = n;
  while (left > 0) {
    d = addDays(d, 1);
    const wd = new Date(d + "T12:00:00Z").getUTCDay();
    if (wd !== 0 && wd !== 6) left--;
  }
  return d;
}

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
const inList = (ids) => "(" + ids.map(q).join(",") + ")";

async function readRows(ids) {
  const out = {};
  for (let i = 0; i < ids.length; i += 200) {
    const part = ids.slice(i, i + 200);
    const obj = "json_object('id', id, " + COLS.map((c) => "'" + c + "', " + c).join(", ") + ")";
    const rows = await retry(() => d1("SELECT " + obj + " AS j FROM partners WHERE id IN " + inList(part), { rawNulls: true }));
    for (const r of rows) {
      const o = JSON.parse(r.j);
      out[o.id] = {};
      for (const c of COLS) out[o.id][c] = o[c];
    }
  }
  return out;
}
const readRow = async (id) => (await readRows([id]))[id];

let original = {};
let activity0 = 0;
const touched = new Set();

async function remember(ids) {
  const fresh = ids.filter((id) => !original[id]);
  if (fresh.length) Object.assign(original, await readRows(fresh));
  for (const id of ids) touched.add(id);
}

async function restore(ids) {
  const list = ids.filter((id) => original[id]);
  if (!list.length) return;
  await retry(() => d1("DELETE FROM activity WHERE n > " + activity0 + " AND account_id IN " + inList(list)));
  const back = {};
  for (const id of list) back[id] = original[id];
  for (let i = 0; i < list.length; i += 100) {
    const part = {};
    for (const id of list.slice(i, i + 100)) part[id] = back[id];
    await retry(() => applyBefore(part));
  }
}

async function waitFor(fn, what, ms = 15000) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    last = await fn();
    if (last) return last;
    await new Promise((r) => setTimeout(r, 300));
  }
  assert.fail("timed out waiting for " + what + (last !== undefined ? " (last: " + JSON.stringify(last) + ")" : ""));
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

async function toastWith(page, text) {
  const t = page.locator("#toasts .ui-toast", { hasText: text }).last();
  await t.waitFor({ state: "visible", timeout: 15000 });
  return t;
}

// Waits until the page shows the store's rows (tab counts filled in).
async function ready(page) {
  await page.waitForSelector(".si-page");
  await page.waitForFunction(() => {
    const n = document.querySelector('[data-si-tab="all"] [data-si-n]');
    return n && n.textContent.trim() !== "" && !document.querySelector(".si-list .ui-skeleton");
  }, null, { timeout: 20000 });
}

async function open({ name = "Kamile", hash = "#sites?tab=mine", viewport = DESKTOP, contextOptions = {}, colorScheme, setup } = {}) {
  const s = await signedInPage({ name, viewport, contextOptions, colorScheme });
  if (setup) {
    // Sign-in already loaded the app: load it again (a new document, not a hash change) with the routes on.
    await setup(s.page);
    await s.page.goto("about:blank");
  }
  await s.page.goto(BASE + "/" + hash);
  await ready(s.page);
  return s;
}

// Same-page navigation (the router answers hashchange).
async function go(page, hash) {
  await page.evaluate((h) => { location.hash = h; }, hash);
  await page.waitForFunction((h) => location.hash === h, hash);
  await ready(page);
}

const numOf = (s) => Number(String(s || "").replace(/[^\d]/g, "")) || 0;

async function tabCounts(page) {
  return page.evaluate(() => {
    const out = {};
    for (const a of document.querySelectorAll("[data-si-tab]")) out[a.getAttribute("data-si-tab")] = Number((a.querySelector("[data-si-n]").textContent || "").replace(/[^\d]/g, ""));
    return out;
  });
}

async function current(page) {
  return page.getAttribute('[data-si-tab][aria-current="page"]', "data-si-tab");
}

async function count(page) {
  return numOf(await page.textContent(".si-count"));
}

async function waitCount(page, n, what) {
  await page.waitForFunction((n) => {
    const el = document.querySelector(".si-count");
    return el && Number(el.textContent.replace(/[^\d]/g, "")) === n;
  }, n, { timeout: 15000 }).catch(async () => assert.fail((what || "count") + ": expected " + n + ", page shows " + await count(page)));
}

async function params(page) {
  return page.evaluate(() => {
    const h = location.hash;
    const i = h.indexOf("?");
    return Object.fromEntries(new URLSearchParams(i < 0 ? "" : h.slice(i + 1)));
  });
}

async function keys(page) {
  return page.$$eval(".si-list tbody tr[data-key]", (trs) => trs.map((t) => t.getAttribute("data-key")));
}

// Every row key of the list (100 per page, through the pager).
async function allKeys(page) {
  const per = page.locator(".si-list [data-per]");
  if (await per.count() && await per.isVisible() && (await per.inputValue()) !== "100") await per.selectOption("100");
  const out = [];
  for (let i = 0; i < 200; i++) {
    out.push(...await keys(page));
    const next = page.locator('.si-list [data-page="next"]');
    if (!(await next.count()) || !(await next.isVisible()) || await next.isDisabled()) break;
    const first = (await keys(page))[0];
    await next.click();
    await page.waitForFunction((k) => {
      const tr = document.querySelector(".si-list tbody tr[data-key]");
      return tr && tr.getAttribute("data-key") !== k;
    }, first);
  }
  return out;
}

async function noHorizontalScroll(page, where) {
  const r = await page.evaluate(() => {
    const w = document.querySelector(".si-list .ui-table-wrap");
    return { doc: document.documentElement.scrollWidth - document.documentElement.clientWidth, wrap: w ? w.scrollWidth - w.clientWidth : 0 };
  });
  assert.ok(r.doc <= 0, where + ": the page scrolls sideways by " + r.doc + " px");
  assert.ok(r.wrap <= 1, where + ": the table scrolls sideways by " + r.wrap + " px");
}

async function pickFilter(page, field, label) {
  await page.click('.si-filters [data-ffield="' + field + '"]');
  await page.click('.ui-menu .ui-mi-label:text-is("' + label + '")');
}

async function fieldButtons(page) {
  return page.$$eval(".si-filters .ui-fbtns [data-ffield]", (bs) => bs.map((b) => b.getAttribute("data-ffield")));
}

// CSV text -> rows of cells (quotes, doubled quotes, CRLF).
function parseCsv(text) {
  const rows = [];
  let row = [], cell = "", inQ = false;
  const s = text.replace(/^﻿/, "");
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inQ) {
      if (ch === '"' && s[i + 1] === '"') { cell += '"'; i++; } else if (ch === '"') inQ = false; else cell += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ",") { row.push(cell); cell = ""; } else if (ch === "\r") continue;
    else if (ch === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; } else cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

async function exportCsv(page, selector = ".si-tools [data-si-csv]") {
  const [dl] = await Promise.all([page.waitForEvent("download"), page.click(selector)]);
  const file = await dl.path();
  const text = fs.readFileSync(file, "utf8");
  return { name: dl.suggestedFilename(), text, rows: parseCsv(text) };
}

async function selectKeys(page, ids) {
  for (const id of ids) await page.check('.si-list tr[data-key="' + id + '"] [data-sel]');
  await page.waitForFunction((n) => {
    const c = document.querySelector(".si-bulk-count b");
    return c && Number(c.textContent.replace(/[^\d]/g, "")) === n;
  }, ids.length);
}

function bulkWatch(page) {
  const out = { bulk: [], partners: 0 };
  page.on("request", (r) => {
    const u = r.url();
    if (r.method() === "POST" && /\/api\/bulk$/.test(new URL(u).pathname)) {
      try { out.bulk.push(JSON.parse(r.postData() || "{}")); } catch (e) { out.bulk.push({}); }
    }
    if (r.method() === "GET" && /\/api\/partners$/.test(new URL(u).pathname)) out.partners++;
  });
  return out;
}

// ---------- setup ----------

before(async () => {
  assert.ok(BASE, "BASE_URL is set (run through tests/e2e/run.sh)");
  assert.ok(!/:8788\b/.test(BASE), "never the main dev server");
  fs.mkdirSync(SHOTS, { recursive: true });
  activity0 = Number((await retry(() => d1("SELECT COALESCE(MAX(n), 0) AS n FROM activity")))[0].n);
});

after(async () => {
  try {
    await restore(Array.from(touched));
  } finally {
    await closeBrowser();
  }
});

// ---------- read-only tests ----------

test("tabs: B.4 counts and rows for Kamile; the nav link opens Mine to contact; #sites is All", async () => {
  assert.equal(EXPECT.mine.length, 30);
  assert.equal(EXPECT.waiting, fx.counts.owner_stage.Kamile.Contacted);
  const { page, watch, close } = await open({ hash: "#sites" });
  try {
    assert.equal((await page.textContent("main h1")).trim(), "Sites");
    assert.equal(await current(page), "all", "no tab = All");
    assert.deepEqual(await tabCounts(page), { mine: EXPECT.mine.length, unowned: EXPECT.unowned.length, waiting: EXPECT.waiting, all: EXPECT.all });
    assert.equal(await count(page), EXPECT.all);
    assert.match(await page.textContent(".si-sub"), /every stage/);

    // The sidebar link lands on Mine to contact (2.4).
    assert.equal(await page.getAttribute('.sh-side a[data-nav="sites"]', "href"), "#sites?tab=mine");
    await page.click('.sh-side a[data-nav="sites"]');
    await page.waitForFunction(() => location.hash === "#sites?tab=mine");
    await ready(page);
    assert.equal(await current(page), "mine");
    assert.deepEqual((await allKeys(page)).sort(), EXPECT.mine, "Mine to contact = Kamile's New and Researching sites");
    assert.deepEqual(await fieldButtons(page), ["client", "type", "country", "drb", "source", "has_contact", "sugg", "big"]);
    await noHorizontalScroll(page, "Mine 1440");
    await shot(page, "sites-mine-kamile-1440");

    // Unowned: no owner, big sites hidden until "Show big sites".
    await page.click('[data-si-tab="unowned"]');
    await page.waitForFunction(() => /tab=unowned/.test(location.hash));
    await ready(page);
    assert.equal(await current(page), "unowned");
    assert.deepEqual((await allKeys(page)).sort(), EXPECT.unowned);
    assert.ok(await page.locator(".si-list [data-row-act=claim]").count() > 0, "Claim on Unowned rows");
    await noHorizontalScroll(page, "Unowned 1440");
    await shot(page, "sites-unowned-kamile-1440");
    await page.click('.si-filters [data-ffield="big"]');
    await waitCount(page, EXPECT.unownedBig.length, "Unowned with big sites");
    assert.equal((await params(page)).big, "1");
    assert.deepEqual((await allKeys(page)).sort(), EXPECT.unownedBig);
    assert.equal((await tabCounts(page)).all, fx.partners.length, "All counts big sites too now");
    await page.click('.si-filters [data-ffield="big"]');
    await waitCount(page, EXPECT.unowned.length);

    // Waiting for reply: owner defaults to Me (a chip), owner=all shows everyone's.
    await page.click('[data-si-tab="waiting"]');
    await page.waitForFunction(() => /tab=waiting/.test(location.hash));
    await ready(page);
    assert.equal(await count(page), EXPECT.waiting);
    assert.equal((await params(page)).owner, undefined, "no owner in the URL");
    assert.match(await page.textContent(".si-filters .ui-chiprow"), /Owner: Me/);
    assert.deepEqual(await fieldButtons(page), ["client", "owner", "type", "country", "drb", "source", "has_contact", "sugg"]);
    await noHorizontalScroll(page, "Waiting 1440");
    await shot(page, "sites-waiting-kamile-1440");
    await page.click('.si-filters [data-fremove="owner"]');
    await waitCount(page, EXPECT.waitingAll, "everyone's waiting");
    assert.equal((await params(page)).owner, "all");
    assert.ok(!/Owner:/.test(await page.textContent(".si-filters")), "no owner chip for everyone");
    await noHorizontalScroll(page, "Waiting, everyone 1440");

    await page.click('[data-si-tab="all"]');
    await page.waitForFunction(() => /tab=all/.test(location.hash));
    await ready(page);
    // "Has a suggestion" is a quick preset on All, so the bar doesn't repeat it; the bar fits on one line.
    assert.deepEqual(await fieldButtons(page), ["client", "owner", "stage", "type", "country", "drb", "source", "has_contact", "big"]);
    const rowTops = await page.$$eval(".si-filters .ui-frow > *:not([hidden])", (els) => els.filter((e) => e.getClientRects().length).map((e) => Math.round(e.getBoundingClientRect().top)));
    assert.equal(new Set(rowTops).size, 1, "search and filter buttons on one line at 1440");
    await noHorizontalScroll(page, "All 1440");
    await shot(page, "sites-all-kamile-1440");
    assert.deepEqual(watch.pageErrors, []);
  } finally {
    await close();
  }
});

test("tabs as Jonas: his own Mine and Waiting counts; big sites stay on Waiting", async () => {
  const jonas = recs.filter((r) => r.owner === "Jonas");
  const { page, close } = await open({ name: "Jonas", hash: "#sites?tab=mine" });
  try {
    const counts = await tabCounts(page);
    assert.equal(counts.mine, jonas.filter((r) => isNew(r) && !r.isPlatform).length, "his 2 big New sites are hidden");
    assert.equal(counts.waiting, jonas.filter((r) => r.stage === "Contacted").length);
    await shot(page, "sites-mine-jonas-1440");
    await page.click('.si-filters [data-ffield="big"]');
    await waitCount(page, jonas.filter(isNew).length, "Jonas with big sites");
    await go(page, "#sites?tab=waiting");
    assert.equal(await count(page), jonas.filter((r) => r.stage === "Contacted").length);
    await shot(page, "sites-waiting-jonas-1440");
  } finally {
    await close();
  }
});

test("filters: Melograno (all) and its products, Has suggestion, search, Sort; URL-synced; tab links keep them", async () => {
  const melo = visible.filter((r) => (r.clientParts || []).some((p) => p.k === "melograno"));
  const trafft = melo.filter((r) => r.clientParts.some((p) => p.k === "melograno" && String(p.product || "").toLowerCase() === "trafft"));
  const amelia = melo.filter((r) => r.clientParts.some((p) => p.k === "melograno" && String(p.product || "").toLowerCase() === "amelia"));
  assert.ok(melo.length > trafft.length && trafft.length > 0, "fixture has Melograno rows of several products");
  const { page, close } = await open({ hash: "#sites?tab=all" });
  try {
    await pickFilter(page, "client", "Melograno (all)");
    await waitCount(page, melo.length, "Melograno (all)");
    assert.equal((await params(page)).client, "melograno");
    assert.match(await page.textContent(".si-filters .ui-chiprow"), /Client: Melograno \(all\)/);
    await pickFilter(page, "client", "Melograno - Trafft");
    await waitCount(page, trafft.length, "Melograno - Trafft");
    assert.equal((await params(page)).client, "melograno-trafft");
    assert.deepEqual((await allKeys(page)).sort(), trafft.map((r) => r.id).sort());

    // A product nobody has: the empty state offers Clear filters.
    await pickFilter(page, "client", "Melograno - Amelia");
    await waitCount(page, amelia.length, "Melograno - Amelia");
    if (!amelia.length) {
      await page.waitForSelector(".si-list .ui-empty");
      assert.match(await page.textContent(".si-list .ui-empty"), /No sites match\./);
      await shot(page, "sites-empty-filtered-1440");
      await page.click('.si-list [data-empty-act="clear"]');
      await waitCount(page, EXPECT.all, "after Clear filters");
      assert.equal((await params(page)).client, undefined);
      assert.equal(await current(page), "all", "Clear filters keeps the tab");
    }

    // Has suggestion: a filter button on Mine to contact; on All the "Has a suggestion" preset shows it.
    if (HAS_SUGG) {
      const sugg = visible.filter((r) => Number(r.sugg) > 0);
      const mineSugg = sugg.filter((r) => EXPECT.mine.includes(r.id));
      assert.ok(sugg.length > mineSugg.length && mineSugg.length > 0);
      await go(page, "#sites?tab=mine");
      await page.click('.si-filters [data-ffield="sugg"]');
      await waitCount(page, mineSugg.length, "Has suggestion on Mine to contact");
      assert.equal((await params(page)).sugg, "1");
      assert.match(await page.textContent(".si-filters .ui-chiprow"), /Has suggestion/);
      await page.click('[data-si-tab="all"]');
      await page.waitForFunction(() => /tab=all/.test(location.hash));
      await waitCount(page, sugg.length, "Has suggestion on All");
      assert.equal(await page.getAttribute('[data-si-preset="sugg"]', "aria-pressed"), "true", "the tab link keeps it; the preset shows it");
      await page.click('[data-si-preset="sugg"]');
      await waitCount(page, EXPECT.all);
      assert.equal((await params(page)).sugg, undefined);
    }

    // Search (debounced, replaces the history entry).
    const target = byId.get(EXPECT.mine[0]);
    await page.fill(".si-filters [data-fq]", target.domain);
    await page.waitForFunction((d) => new URLSearchParams(location.hash.split("?")[1]).get("q") === d, target.domain);
    await waitCount(page, visible.filter((r) => String(r.domain).includes(target.domain)).length, "search");
    assert.ok((await keys(page)).includes(target.id));
    await page.fill(".si-filters [data-fq]", "");
    await waitCount(page, EXPECT.all);

    // Sort menu and header buttons write sort/dir only when they differ from the default.
    await page.selectOption(".si-tools [data-si-sort]", "dr:desc");
    await page.waitForFunction(() => /sort=dr/.test(location.hash));
    const p1 = await params(page);
    assert.equal(p1.sort, "dr");
    assert.equal(p1.dir, undefined, "desc is DR's own direction");
    const maxDr = Math.max(...visible.map((r) => (r.dr == null ? -1 : Number(r.dr))));
    const firstDr = numOf(await page.textContent(".si-list tbody tr:first-child td.is-c-dr"));
    assert.equal(firstDr, maxDr, "highest DR first");
    await page.click('.si-list th button[data-sort="site"]');
    await page.waitForFunction(() => /sort=site/.test(location.hash));
    assert.equal(await page.inputValue(".si-tools [data-si-sort]"), "site:asc");
    await page.selectOption(".si-tools [data-si-sort]", "newest:desc");
    await page.waitForFunction(() => !/sort=/.test(location.hash));

    // A tab link keeps the filters (and drops sort and page).
    await pickFilter(page, "client", "Soro");
    await waitCount(page, visible.filter((r) => (r.ck || []).includes("soro")).length, "Soro on All");
    await page.click('[data-si-tab="waiting"]');
    await page.waitForFunction(() => /tab=waiting/.test(location.hash));
    await ready(page);
    assert.equal((await params(page)).client, "soro");
    await waitCount(page, kamileWaiting.filter((r) => (r.ck || []).includes("soro")).length, "Soro on Waiting");
    await shot(page, "sites-filters-1440");
  } finally {
    await close();
  }
});

test("presets on All: Recently active, Replied no date, Has a suggestion", async () => {
  const { page, close } = await open({ hash: "#sites?tab=all" });
  try {
    const chips = await page.$$eval(".si-tools [data-si-preset]", (bs) => bs.map((b) => b.textContent.trim()));
    assert.deepEqual(chips, ["Recently active", "Replied, no date", "Has a suggestion"]);

    await page.click('[data-si-preset="activity"]');
    await page.waitForFunction(() => /preset=activity/.test(location.hash));
    assert.equal(await page.getAttribute('[data-si-preset="activity"]', "aria-pressed"), "true");
    assert.equal(await page.inputValue(".si-tools [data-si-sort]"), "last_activity:desc");
    // Checked against the page's own store: an earlier test file on the same server may have edited sites.
    const order = await page.evaluate(async () => {
      const store = await import("/js/core/store.js");
      const all = store.all().filter((r) => !r.isPlatform);
      const days = all.map((r) => r.lastActivity).filter(Boolean).sort().reverse().slice(0, 5);
      const shown = Array.from(document.querySelectorAll(".si-list tbody tr")).slice(0, 5).map((t) => store.get(t.getAttribute("data-key")).lastActivity);
      return { days, shown };
    });
    assert.deepEqual(order.shown, order.days, "newest activity first");
    await shot(page, "sites-preset-activity-1440");

    await page.click('[data-si-preset="replied_nodate"]');
    await page.waitForFunction(() => /preset=replied_nodate/.test(location.hash));
    const nodate = visible.filter((r) => r.stage === "Replied" && !r.replyDate);
    assert.ok(fx.groups["replied-nodate"].every((id) => nodate.some((r) => r.id === id)));
    await waitCount(page, nodate.length, "Replied, no date");
    assert.equal(await page.getAttribute('[data-si-preset="activity"]', "aria-pressed"), "false", "one preset at a time");
    assert.equal(await page.inputValue(".si-tools [data-si-sort]"), "newest:desc");
    await page.click('[data-si-preset="replied_nodate"]');
    await waitCount(page, EXPECT.all);

    await page.click('[data-si-preset="sugg"]');
    await page.waitForFunction(() => /sugg=1/.test(location.hash));
    await waitCount(page, visible.filter((r) => Number(r.sugg) > 0).length, "Has a suggestion");
    assert.equal(await page.locator('.si-filters [data-ffield="sugg"]').count(), 0, "no second Has suggestion control on All");
    await page.click('[data-si-tab="unowned"]');
    await page.waitForFunction(() => /tab=unowned/.test(location.hash));
    await ready(page);
    assert.equal(await page.getAttribute('.si-filters [data-ffield="sugg"]', "aria-pressed"), "true", "the filter on another tab");
  } finally {
    await close();
  }
});

test("flag= (a Team overview number): a removable chip with the list's name, All only, the same count", async () => {
  const overdue = recs.filter((r) => !r.closed && r.due && r.due < TODAY);
  const kOverdue = overdue.filter((r) => r.owner === "Kamile");
  const noOwner = recs.filter((r) => !has(r.owner) && !r.closed);
  assert.ok(kOverdue.length > 0 && overdue.length > kOverdue.length, "the fixture has overdue sites of several owners");
  const { page, close } = await open({ hash: "#sites?tab=all&flag=overdue&big=1&sort=next" });
  try {
    await waitCount(page, overdue.length, "Overdue follow-ups");
    const chip = page.locator(".si-filters .ui-chiprow .ui-fchip", { hasText: "Overdue follow-ups" });
    assert.equal(await chip.count(), 1, "the chip names the list");
    assert.equal(await chip.getAttribute("title"), "The follow-up date has passed.");
    assert.equal((await page.textContent("[data-si-sub]")).trim(), "The follow-up date has passed.", "the line under the h1 says what the list is");
    assert.equal(await page.inputValue(".si-tools [data-si-sort]"), "next:asc", "the oldest follow-up date first");
    const tabs = await tabCounts(page);
    assert.equal(tabs.all, overdue.length);
    assert.equal(tabs.mine, EXPECT.mine.length, "the other tabs don't use it");
    assert.deepEqual((await allKeys(page)).sort(), overdue.map((r) => r.id).sort());
    // Opened rows step through the list as a queue named after it.
    const first = (await keys(page))[0];
    await page.click('.si-list tr[data-key="' + first + '"] a.ui-row-link');
    await page.waitForSelector("#layer-panel .ui-queue-text");
    assert.equal((await page.textContent("#layer-panel .ui-queue-text")).trim(), "1 of " + overdue.length + " · Overdue follow-ups");
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => !/[?&]rec=/.test(location.hash));
    // With an owner as well (Kamile is signed in: "Me").
    await pickFilter(page, "owner", "Me");
    await waitCount(page, kOverdue.length, "Kamile's overdue");
    const chips = await page.$$eval(".si-filters .ui-chiprow .ui-fchip", (cs) => cs.map((c) => c.firstChild.textContent.trim()));
    assert.deepEqual(chips.sort(), ["Overdue follow-ups", "Owner: Me"]);
    await shot(page, "sites-flag-1440");
    // × removes it; the owner stays.
    await page.click('.si-filters [data-fremove="flag"]');
    await page.waitForFunction(() => !/flag=/.test(location.hash));
    await waitCount(page, recs.filter((r) => r.owner === "Kamile").length, "every site of Kamile's");
    assert.equal((await params(page)).owner, "me");
    // Clear all removes it too; a tab link drops it (like the presets).
    await go(page, "#sites?tab=all&flag=no_owner&big=1");
    await waitCount(page, noOwner.length, "No owner (open sites only)");
    assert.notEqual(noOwner.length, recs.filter((r) => !has(r.owner)).length, "unlike owner=none, closed sites are left out");
    await page.click('[data-si-tab="waiting"]');
    await page.waitForFunction(() => /tab=waiting/.test(location.hash) && !/flag=/.test(location.hash));
    await go(page, "#sites?tab=all&flag=no_type&big=1");
    await page.waitForSelector('.si-filters [data-fremove="flag"]');
    await page.click(".si-filters [data-fclear]");
    await page.waitForFunction(() => !/flag=/.test(location.hash));
    // An unknown list is left out (no chip, nothing filtered).
    await go(page, "#sites?tab=all&flag=nope");
    await waitCount(page, EXPECT.all, "flag=nope");
    assert.equal(await page.locator('.si-filters [data-fremove="flag"]').count(), 0);
    assert.equal((await page.textContent("[data-si-sub]")).trim(), "Every site in the CRM, in every stage.");
    // On phones the chip sits under the Filters button and the bar's count includes it.
    await go(page, "#sites?tab=all&flag=overdue&big=1");
    await waitCount(page, overdue.length, "back to the flag");
  } finally {
    await close();
  }
});

test("search text matches what Search matches: words in any order, an ID, a site's address", async () => {
  // The router writes params as URLSearchParams does (a space is "+").
  const at = (text) => "#sites?" + new URLSearchParams({ tab: "all", big: "1", q: text }).toString();
  const { page, close } = await open({ hash: at("mr money") });
  try {
    await waitCount(page, 1, "mr money");
    const id = (await keys(page))[0];
    await go(page, at("money mr"));
    await waitCount(page, 1, "money mr");
    assert.deepEqual(await keys(page), [id], "the same site, words in another order");
    await go(page, at(EXPECT.mine[0].toLowerCase()));
    assert.ok((await keys(page)).includes(EXPECT.mine[0]), "an ID");
    const r = byId.get(EXPECT.mine[0]);
    await go(page, at("https://www." + r.domain + "/some/page?x=1"));
    await waitCount(page, 1, "a full address");
    assert.deepEqual(await keys(page), [r.id]);
    // One letter is too short for Search: the list filters by plain text then.
    await go(page, at("a"));
    assert.ok(await count(page) > 100, "one letter still filters");
  } finally {
    await close();
  }
});

test("Waiting for reply: No reply in 14+ days (N), oldest first, Start opens queue mode", async () => {
  const dated = fx.groups["kamile-contacted-20d"];
  assert.ok(QUIET_K.length >= 100, "enough quiet sites for a page of 100");
  const { page, close } = await open({ hash: "#sites?tab=waiting" });
  try {
    assert.equal(await page.textContent("[data-si-quiet]"), "No reply in 14+ days (" + QUIET_K.length + ")");
    assert.equal(await page.getAttribute("[data-si-quiet]", "aria-pressed"), "false");
    assert.equal(await page.locator("[data-si-start]").count(), 0, "Start only with the chip on");
    await page.click("[data-si-quiet]");
    await page.waitForFunction(() => /quiet=14/.test(location.hash));
    await waitCount(page, QUIET_K.length, "quiet");
    assert.equal((await tabCounts(page)).waiting, QUIET_K.length, "the tab count follows the chip");
    assert.equal(await page.inputValue(".si-tools [data-si-sort]"), "last_activity:asc", "longest without activity first");
    const first = await keys(page);
    assert.ok(dated.includes(first[0]), "a dated site first; undated ones come last");
    assert.deepEqual((await allKeys(page)).sort(), QUIET_K.slice().sort());
    await page.selectOption(".si-list [data-per]", "50");
    await page.waitForSelector(".si-list tbody tr:nth-child(50)");
    await shot(page, "sites-waiting-quiet-1440");

    await page.click("[data-si-start]");
    await page.waitForSelector("#layer-panel .ui-queue-text");
    assert.equal((await page.textContent("#layer-panel .ui-queue-text")).trim(), "1 of " + QUIET_K.length + " · No reply in 14+ days");
    assert.equal((await params(page)).rec, first[0]);
    // Spec 2.2.2: in this queue the primary outcome is "Sent a follow-up" (queue.primary, NEEDS F3 2).
    const pri = page.locator("#layer-panel [data-pouts] .ui-btn.is-primary");
    await pri.waitFor();
    assert.equal(await pri.count(), 1, "one primary outcome");
    assert.equal(await pri.getAttribute("data-outcome"), "followed_up");
    assert.equal(await page.getAttribute("#layer-panel [data-pouts] [data-outcome]", "data-outcome"), "followed_up", "first in the row");
    await shot(page, "sites-waiting-queue-1440");
  } finally {
    await close();
  }
});

test("T26: CSV is formula-safe and has the filtered rows, on every tab", async () => {
  await remember([ID.spare1]);
  const evil = '=HYPERLINK("https://evil.example.test","x")';
  await retry(() => applyBefore({ [ID.spare1]: { name: evil } }));
  try {
    const { page, close } = await open({ hash: "#sites?tab=all&q=c-spare" });
    try {
      await waitCount(page, 4, "c-spare rows");
      const csv = await exportCsv(page);
      assert.match(csv.name, /^partnergap-sites-all-\d{4}-\d{2}-\d{2}\.csv$/);
      assert.ok(csv.text.startsWith("﻿"), "BOM");
      assert.deepEqual(csv.rows[0].slice(0, 4), ["ID", "Site", "Domain", "Stage"]);
      assert.equal(csv.rows.length - 1, 4, "row count = filtered count");
      const row = csv.rows.find((r) => r[0] === ID.spare1);
      assert.equal(row[1], "'" + evil, "a cell starting with = gets an apostrophe");
      for (const r of csv.rows) for (const c of r) assert.ok(!/^[=+\-@]/.test(c), "no cell starts with a formula character: " + c);

      for (const tab of TABS) {
        await go(page, "#sites?tab=" + tab);
        const n = await count(page);
        const t = await exportCsv(page);
        assert.equal(t.rows.length - 1, n, tab + ": CSV rows = the tab's count");
        assert.match(t.name, new RegExp("^partnergap-sites-" + tab + "-"));
      }
    } finally {
      await close();
    }
  } finally {
    await restore([ID.spare1]);
  }
});

test("read-only (preview host): no checkboxes, bulk bar, Claim or row buttons; Export still works", async () => {
  const setup = (page) => page.route("**/api/meta*", async (route) => {
    const r = await route.fetch();
    const j = await r.json();
    j.read_only = true;
    await route.fulfill({ response: r, json: j });
  });
  const { page, close } = await open({ hash: "#sites?tab=unowned", setup });
  try {
    assert.equal(await page.locator(".si-list [data-sel]").count(), 0);
    assert.equal(await page.locator(".si-list [data-selall]").count(), 0);
    assert.equal(await page.locator(".si-list [data-row-act]").count(), 0);
    assert.ok(await page.locator(".si-list [data-bulk]").isHidden());
    await go(page, "#sites?tab=waiting");
    assert.equal(await page.locator(".si-list [data-row-act]").count(), 0);
    const csv = await exportCsv(page);
    assert.equal(csv.rows.length - 1, EXPECT.waiting);
    await shot(page, "sites-readonly-1440");
  } finally {
    await close();
  }
});

test("phone 390: 2 x 2 tabs, Filters sheet, one Actions menu for bulk, Claim on its own line, no sideways scroll", async () => {
  const { page, close } = await open({ hash: "#sites?tab=mine", viewport: PHONE, contextOptions: PHONE_OPTS });
  try {
    const boxes = await page.$$eval("[data-si-tab]", (as) => as.map((a) => { const b = a.getBoundingClientRect(); return [Math.round(b.left), Math.round(b.top)]; }));
    assert.equal(boxes[0][1], boxes[1][1], "Mine and Unowned on the first row");
    assert.equal(boxes[2][1], boxes[3][1], "Waiting and All on the second row");
    assert.ok(boxes[2][1] > boxes[0][1]);
    assert.equal(boxes[0][0], boxes[2][0], "two columns");
    for (const tab of TABS) {
      await go(page, "#sites?tab=" + tab);
      await noHorizontalScroll(page, tab + " 390");
      await shot(page, "sites-" + tab + "-kamile-390");
    }
    // Export CSV sits in the header on phones, so Sort gets the whole row.
    assert.ok(await page.locator(".si-tools [data-si-csv]").isHidden());
    const csv = await exportCsv(page, ".si-head [data-si-csv]");
    assert.equal(csv.rows.length - 1, await count(page), "phone Export CSV has the tab's rows");
    const sortBox = await page.locator(".si-tools [data-si-sort]").boundingBox();
    assert.ok(sortBox.width > 250, "Sort has room for its longest label");
    // Filters in a bottom sheet.
    assert.ok(await page.locator(".si-filters .ui-fsheet-btn").isVisible());
    await page.click(".si-filters .ui-fsheet-btn");
    await page.waitForSelector("dialog[open] [data-fbtns-sheet] [data-ffield]");
    await shot(page, "sites-filters-sheet-390");
    await page.click('dialog[open] button:has-text("Done")');

    await go(page, "#sites?tab=unowned");
    const ids = (await keys(page)).slice(0, 2);
    await selectKeys(page, ids);
    assert.ok(await page.locator(".si-bulk-menu").isVisible(), "Actions menu on phones");
    assert.ok(await page.locator(".si-bulk-acts").isHidden());
    await page.click(".si-bulk-menu");
    const items = await page.$$eval(".ui-menu .ui-mi-label", (ls) => ls.map((l) => l.textContent.trim()));
    assert.deepEqual(items, ["Assign owner", "Set stage", "Add client", "Set type", "Follow up", "Set next step", "Export selected"]);
    await shot(page, "sites-bulk-actions-390");
    await page.keyboard.press("Escape");
    const claim = page.locator('.si-list tr[data-key="' + ids[0] + '"] [data-row-act="claim"]');
    assert.ok(await claim.isVisible());
    const box = await claim.boundingBox();
    assert.ok(box.height >= 44, "Claim is a 44 px target on touch screens");
    await noHorizontalScroll(page, "Unowned with the bulk bar 390");
    await shot(page, "sites-unowned-bulk-390");
  } finally {
    await close();
  }
});

test("narrower desktops (1024, 1280, 1366): no sideways scroll on any tab; one owner's list drops the Owner column", async () => {
  for (const viewport of [{ width: 1024, height: 768 }, { width: 1280, height: 800 }, { width: 1366, height: 768 }]) {
    const { page, close } = await open({ hash: "#sites?tab=mine", viewport });
    try {
      for (const hash of ["#sites?tab=mine", "#sites?tab=unowned", "#sites?tab=waiting", "#sites?tab=waiting&owner=all", "#sites?tab=all"]) {
        await go(page, hash);
        await noHorizontalScroll(page, hash + " " + viewport.width);
        const ownerCol = await page.locator(".si-list thead th.si-c-owner").count() ? await page.isVisible(".si-list thead th.si-c-owner") : false;
        if (/tab=waiting$/.test(hash)) assert.equal(ownerCol, false, "Waiting for reply shows my sites: no Owner column");
        if (/owner=all|tab=all/.test(hash)) assert.equal(ownerCol, true, hash + ": everyone's sites show the Owner column");
        // Every row can still log and follow up (⋯ when the buttons don't fit).
        const acts = await page.$eval(".si-list tbody tr", (tr) => Array.from(tr.querySelectorAll("[data-row-act]"))
          .filter((b) => b.getClientRects().length).map((b) => b.getAttribute("data-row-act")));
        assert.ok(acts.some((a) => ["log", "more", "claim"].includes(a)), hash + " " + viewport.width + ": a row action is visible (" + acts + ")");
      }
      if (viewport.width === 1024) await shot(page, "sites-all-kamile-1024");
    } finally {
      await close();
    }
  }
});

test("axe: no serious or critical issues on each tab (light and dark), with the bulk bar open", async () => {
  const axeSrc = fs.readFileSync(tools().axe, "utf8");
  for (const colorScheme of ["light", "dark"]) {
    const { page, close } = await open({ hash: "#sites?tab=mine", colorScheme });
    try {
      await page.evaluate(axeSrc);
      for (const hash of ["#sites?tab=mine", "#sites?tab=unowned", "#sites?tab=waiting&quiet=14", "#sites?tab=all&preset=activity"]) {
        await go(page, hash);
        const first = (await keys(page)).slice(0, 2);
        if (first.length) await selectKeys(page, first);
        await settled(page);
        const res = await page.evaluate(async () => {
          const r = await window.axe.run({ include: [["main"]] }, { resultTypes: ["violations"] });
          return r.violations.filter((v) => v.impact === "serious" || v.impact === "critical")
            .map((v) => v.id + ": " + v.help + " -> " + v.nodes.slice(0, 3).map((n) => n.target.join(" ")).join(" | "));
        });
        assert.deepEqual(res, [], colorScheme + " " + hash);
      }
      if (colorScheme === "dark") await shot(page, "sites-all-dark-1440");
    } finally {
      await close();
    }
  }
});

test("7,500 sites: tab switch, filters, search and sort redraw in well under 100 ms", async () => {
  const N = 7500;
  const setup = (page) => page.route(/\/api\/partners(\?|$)/, async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    const r = await route.fetch({ headers: Object.assign({}, route.request().headers(), { "if-none-match": "" }) });
    const data = await r.json();
    const ci = data.cols.indexOf("id");
    const di = data.cols.indexOf("domain");
    const ni = data.cols.indexOf("name");
    const base = data.rows.slice();
    for (let i = base.length; i < N; i++) {
      const row = base[i % base.length].slice();
      row[ci] = "PG-" + String(20000 + i).padStart(5, "0");
      if (di >= 0) row[di] = "synthetic-" + i + ".example.test";
      if (ni >= 0) row[ni] = "Synthetic " + i;
      data.rows.push(row);
    }
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(data) });
  });
  const { page, close } = await open({ hash: "#sites?tab=mine", setup });
  try {
    await page.waitForFunction(() => Number(document.querySelector('[data-si-tab="all"] [data-si-n]').textContent.replace(/[^\d]/g, "")) > 7000,
      null, { timeout: 30000 });
    // Four passes over the same steps: the first warms the engine up; each step's time is the median of
    // the other three, so one garbage collection pause doesn't decide the result.
    const times = await page.evaluate(async () => {
      const router = await import("/js/core/router.js");
      const steps = [
        { tab: "all" }, { tab: "waiting" }, { quiet: "14" }, { quiet: null }, { tab: "unowned" }, { tab: "all" },
        { client: "soro" }, { q: "tips" }, { q: "tip" }, { q: null }, { client: null }, { owner: "Kamile" }, { owner: null },
        { stage: "Contacted" }, { stage: null }, { sort: "dr" }, { sort: "site" }, { sort: null }, { preset: "activity" },
        { preset: null }, { big: "1" }, { big: null }, { tab: "mine" },
      ];
      const runs = steps.map(() => []);
      for (let pass = 0; pass < 4; pass++) {
        for (let i = 0; i < steps.length; i++) {
          const t0 = performance.now();
          router.setParams(steps[i]);
          document.body.getBoundingClientRect(); // style and layout of the new rows
          if (pass > 0) runs[i].push(performance.now() - t0);
          await new Promise((r) => setTimeout(r, 20));
        }
      }
      return steps.map((s, i) => {
        const ms = runs[i].sort((a, b) => a - b)[1];
        return { step: JSON.stringify(s), ms: Math.round(ms * 10) / 10, max: Math.round(runs[i][2] * 10) / 10 };
      });
    });
    const worst = times.reduce((m, t) => (t.ms > m.ms ? t : m), times[0]);
    console.log("# 7,500 sites, ms per step (median of 3, max): " + times.map((t) => t.step + " " + t.ms + " (" + t.max + ")").join(", "));
    assert.ok(worst.ms < 100, "slowest step " + worst.step + " took " + worst.ms + " ms");
    const sorted = times.map((t) => t.ms).sort((a, b) => a - b);
    assert.ok(sorted[Math.floor(sorted.length / 2)] < 50, "median under 50 ms");
  } finally {
    await close();
  }
});

// ---------- writes ----------

test("Unowned: Claim sets me and a follow-up in 2 working days; Assign to client manager sets the manager", async () => {
  const claimId = EXPECT.unowned.find((id) => !has(byId.get(id).next_step) && !(byId.get(id).ck || []).length);
  const managers = new Map((meta.clients || []).map((c) => [c.k, (c.managers || [])[0]]));
  const managerOf = (r) => (r.clientParts && r.clientParts.length ? managers.get(r.clientParts[0].k) : null);
  const assignRec = EXPECT.unowned.map((id) => byId.get(id)).find((r) => managerOf(r) && managerOf(r) !== "Kamile");
  const mineToManage = EXPECT.unowned.map((id) => byId.get(id)).find((r) => managerOf(r) === "Kamile");
  assert.ok(claimId && assignRec, "fixture rows for Claim and Assign");
  const manager = managers.get(assignRec.clientParts[0].k);
  await remember([claimId, assignRec.id]);
  const { page, close } = await open({ hash: "#sites?tab=unowned" });
  try {
    const before = await tabCounts(page);
    if (mineToManage) {
      // Kamile manages this site's client: Claim already makes her the owner, so there is no "Assign to Kamile".
      const row = page.locator('.si-list tr[data-key="' + mineToManage.id + '"]');
      assert.equal(await row.locator('[data-row-act="claim"]').count(), 1);
      assert.equal(await row.locator('[data-row-act="assign"]').count(), 0);
    }
    await page.click('.si-list tr[data-key="' + claimId + '"] [data-row-act="claim"]');
    await toastWith(page, "Claimed");
    const row = await waitFor(async () => { const r = await readRow(claimId); return r.owner === "Kamile" ? r : null; }, "claim saved");
    assert.equal(row.stage, original[claimId].stage, "no stage change");
    assert.equal(row.next_due, addWorkingDays(TODAY, 2));
    assert.equal(row.next_step, "Find the right contact and email");
    await page.waitForSelector('.si-list tr[data-key="' + claimId + '"]', { state: "detached" });
    const after1 = await tabCounts(page);
    assert.equal(after1.unowned, before.unowned - 1);
    assert.equal(after1.mine, before.mine + 1);

    const btn = page.locator('.si-list tr[data-key="' + assignRec.id + '"] [data-row-act="assign"]');
    assert.equal((await btn.textContent()).trim(), "Assign to " + manager);
    await btn.click();
    await waitFor(async () => (await readRow(assignRec.id)).owner === manager, "assigned to " + manager);
    await page.waitForSelector('.si-list tr[data-key="' + assignRec.id + '"]', { state: "detached" });
    assert.equal((await tabCounts(page)).unowned, before.unowned - 2);
  } finally {
    await close();
    await restore([claimId, assignRec.id]);
  }
});

test("T5: the stage pill moves a site to Contacted in 2 clicks, without navigating; Undo puts it back", async () => {
  const id = EXPECT.mine[EXPECT.mine.length - 1];
  await remember([id]);
  const { page, close } = await open({ hash: "#sites?tab=mine" });
  try {
    const hash0 = await page.evaluate(() => location.hash);
    const nav0 = await page.evaluate(() => performance.getEntriesByType("navigation").length);
    await page.click('.si-list tr[data-key="' + id + '"] [data-edit="stage"]'); // click 1
    await page.click('.ui-menu .ui-mi-label:text-is("Contacted")'); // click 2
    const t = await toastWith(page, "Contacted");
    assert.equal(await t.locator('[data-t="undo"]').count(), 1, "toast with Undo");
    await waitFor(async () => (await readRow(id)).stage === "Contacted", "stage saved");
    assert.equal(await page.evaluate(() => location.hash), hash0, "no navigation");
    assert.equal(await page.evaluate(() => performance.getEntriesByType("navigation").length), nav0);
    await page.waitForSelector('.si-list tr[data-key="' + id + '"]', { state: "detached" });
    await waitCount(page, EXPECT.mine.length - 1, "Mine after the move");
    await t.locator('[data-t="undo"]').click();
    await waitFor(async () => (await readRow(id)).stage === original[id].stage, "stage restored");
    await waitCount(page, EXPECT.mine.length, "Mine after Undo");
  } finally {
    await close();
    await restore([id]);
  }
});

test("T11: bulk Follow up on a page of 100 quiet sites: confirm, ≤ 90 ids per request, only_if_empty, no re-download, Undo in rows of 20", async () => {
  const keep = fx.groups["kamile-contacted-20d"].slice(3, 6);
  await remember(QUIET_K);
  await retry(() => applyBefore(Object.fromEntries(keep.map((id) => [id, { next_step: "Call them on Friday" }]))));
  const monday = chipDate("monday", TODAY);
  const { page, close } = await open({ hash: "#sites?tab=waiting&quiet=14" });
  try {
    const w = bulkWatch(page);
    await page.selectOption(".si-list [data-per]", "100");
    await page.waitForSelector(".si-list tbody tr:nth-child(100)");
    const ids = await keys(page);
    assert.equal(ids.length, 100);
    for (const id of keep) assert.ok(ids.includes(id), "the sites with a next step are on the page");
    await page.check(".si-list [data-selall]");
    await page.waitForFunction(() => (document.querySelector(".si-bulk-count") || {}).textContent === "100 selected");
    await shot(page, "sites-t11-selected-1440");
    await page.click('.si-bulk [data-bulk="follow"]');
    await page.click('.ui-menu .ui-mi-label:text-is("Next Monday")');
    await page.waitForSelector("dialog[open] .ui-modal-title");
    assert.match(await page.textContent("dialog[open] .ui-modal-title"), /for 100 sites\?$/);
    assert.match(await page.textContent("dialog[open] .ui-modal-body"), new RegExp(SHEET.replace(/\./g, "\\.")));
    await shot(page, "sites-t11-confirm-1440");
    await page.click('dialog[open] .ui-modal-foot button:has-text("Change 100 sites")');
    const t = await toastWith(page, "Updated 100");
    const idsMode = w.bulk.filter((b) => Array.isArray(b.ids));
    assert.ok(idsMode.length >= 2, "100 ids in more than one request");
    for (const b of idsMode) {
      assert.ok(b.ids.length <= 90, "≤ 90 ids per request, got " + b.ids.length);
      assert.deepEqual(b.only_if_empty, ["next_step"]);
      assert.deepEqual(b.fields, { next_step: "Follow up", next_due: monday });
    }
    assert.deepEqual(idsMode.flatMap((b) => b.ids).sort(), ids.slice().sort());
    const saved = await readRows(ids);
    for (const id of ids) {
      assert.equal(saved[id].next_due, monday, id);
      const was = keep.includes(id) ? "Call them on Friday" : original[id].next_step;
      assert.equal(saved[id].next_step, has(was) ? was : "Follow up", id + ": only_if_empty keeps a next step");
    }
    await waitCount(page, QUIET_K.length - 100, "the snoozed sites leave the quiet list");
    await shot(page, "sites-t11-done-1440");

    await t.locator('[data-t="undo"]').click();
    await toastWith(page, "Restored 100 sites.");
    const rowsMode = w.bulk.filter((b) => Array.isArray(b.rows));
    assert.equal(rowsMode.length, 5, "rows mode in chunks of 20");
    for (const b of rowsMode) assert.ok(b.rows.length <= 20);
    const back = await readRows(ids);
    for (const id of ids) {
      assert.equal(back[id].next_due, original[id].next_due, id + " next_due");
      assert.equal(back[id].next_step, keep.includes(id) ? "Call them on Friday" : original[id].next_step, id + " next_step");
    }
    // The restored sites were edited today, which counts as activity (model.js lastActivity includes
    // updated_at), so they stay out of "No reply in 14+ days"; they are all still waiting for a reply.
    await page.click("[data-si-quiet]");
    await waitCount(page, EXPECT.waiting, "Waiting for reply after Undo");
    assert.equal(w.partners, 0, "the list was never downloaded again");
  } finally {
    await close();
    await restore(QUIET_K);
  }
});

test("T12: bulk Add client puts Soro after MailerLite/MailerSend; inline add puts it after Ultahost", async () => {
  await remember([ID.note, ID.lost]);
  assert.equal(original[ID.note].clients, "MailerLite/MailerSend");
  assert.equal(original[ID.lost].clients, "Ultahost");
  const { page, close } = await open({ name: "Tomas", hash: "#sites?tab=all&q=contract.example.test" });
  try {
    await selectKeys(page, [ID.note]);
    await page.click('.si-bulk [data-bulk="client"]');
    await page.click('.ui-menu .ui-mi-label:text-is("Soro")');
    await toastWith(page, "Added Soro");
    await waitFor(async () => (await readRow(ID.note)).clients === "MailerLite/MailerSend, Soro", "bulk add_client");

    await page.click('.si-list tr[data-key="' + ID.lost + '"] [data-edit="clients"]');
    await page.waitForSelector(".ui-clients-form");
    await page.click('.ui-clients-form [data-key="soro|"]');
    await page.click('.ui-clients-form button[type="submit"]');
    await waitFor(async () => (await readRow(ID.lost)).clients === "Ultahost, Soro", "inline add");
  } finally {
    await close();
    await restore([ID.note, ID.lost]);
  }
});

test("bulk: Set stage › Lost asks one reason for all, clears next step and date, Undo restores", async () => {
  const ids = [ID.spare1, ID.spare2, ID.spare3];
  await remember(ids);
  const { page, close } = await open({ name: "Tomas", hash: "#sites?tab=all&q=c-spare" });
  try {
    const w = bulkWatch(page);
    await selectKeys(page, ids);
    await page.click('.si-bulk [data-bulk="stage"]');
    await page.click('.ui-menu .ui-mi-label:text-is("Lost")');
    await page.waitForSelector("dialog[open].si-bulk-dialog, dialog[open] .si-bulk-form");
    assert.equal((await page.textContent("dialog[open] .ui-modal-title")).trim(), "Change stage to Lost for 3 sites?");
    assert.match(await page.textContent("dialog[open] .si-bulk-note"), /next weekday morning\. Their next step and follow-up date are cleared\./);
    await page.click('dialog[open] button:has-text("Move 3 sites to Lost")');
    await page.waitForSelector("dialog[open] #si-bulk-err:not([hidden])");
    assert.equal((await page.textContent("dialog[open] #si-bulk-err")).trim(), "Pick a reason.");
    assert.equal(w.bulk.length, 0, "nothing sent without a reason");
    await shot(page, "sites-bulk-lost-reason-1440");
    await page.check('dialog[open] input[name="reason"][value="Not a fit"]');
    await page.click('dialog[open] button:has-text("Move 3 sites to Lost")');
    const t = await toastWith(page, "Moved to Lost (Not a fit) · Updated 3");
    assert.deepEqual(w.bulk[0].fields, { stage: "Lost", next_step: "", next_due: "" });
    const rows = await readRows(ids);
    for (const id of ids) {
      assert.equal(rows[id].stage, "Lost");
      assert.ok(!has(rows[id].next_step) && !has(rows[id].next_due));
    }
    await t.locator('[data-t="undo"]').click();
    await toastWith(page, "Restored 3 sites.");
    assert.ok(Array.isArray(w.bulk[w.bulk.length - 1].rows), "Undo in rows mode");
    const back = await readRows(ids);
    for (const id of ids) assert.equal(back[id].stage, original[id].stage);
  } finally {
    await close();
    await restore(ids);
  }
});

test("bulk: Set next step only where empty; over 20 asks first; over 100 the changes are off; Export selected", async () => {
  const ids = [ID.bulkE, ID.bulkF, ID.nochange];
  await remember(ids);
  assert.ok(has(original[ID.nochange].next_step));
  const { page, close } = await open({ name: "Tomas", hash: "#sites?tab=all&q=contract.example.test" });
  try {
    const w = bulkWatch(page);
    await selectKeys(page, ids);
    await page.click('.si-bulk [data-bulk="next"]');
    await page.waitForSelector("dialog[open] .si-bulk-form");
    assert.ok(await page.isChecked('dialog[open] input[name="empty"]'), "only where empty, by default");
    await page.fill('dialog[open] input[name="next"]', "Send the media kit");
    await page.click('dialog[open] button:has-text("Set next step")');
    await toastWith(page, "Next step saved");
    assert.deepEqual(w.bulk[0].only_if_empty, ["next_step"]);
    const rows = await readRows(ids);
    assert.equal(rows[ID.bulkE].next_step, "Send the media kit");
    assert.equal(rows[ID.bulkF].next_step, "Send the media kit");
    assert.equal(rows[ID.nochange].next_step, original[ID.nochange].next_step, "an existing next step stays");
    await page.click(".si-bulk [data-bulk=clear]");
    await page.waitForSelector(".si-list .ui-bulkbar", { state: "hidden" });

    // Over 20: the confirm names the change and the sheet; Cancel sends nothing.
    await go(page, "#sites?tab=all");
    const sent = w.bulk.length;
    await page.check(".si-list [data-selall]");
    await page.click('.si-bulk [data-bulk="owner"]');
    await page.click('.ui-menu .ui-mi-label:text-is("Gaby")');
    await page.waitForSelector("dialog[open] .ui-modal-title");
    assert.equal((await page.textContent("dialog[open] .ui-modal-title")).trim(), "Assign 50 sites to Gaby?");
    assert.match(await page.textContent("dialog[open] .ui-modal-body"), /next weekday morning/);
    await page.click('dialog[open] .ui-modal-foot button:has-text("Cancel")');
    await page.waitForSelector("dialog[open]", { state: "detached" }).catch(() => {});
    assert.equal(w.bulk.length, sent, "nothing sent after Cancel");

    // Over 100 (page selection keeps across pages): the change buttons are off; Export selected still works.
    await page.click(".si-bulk [data-bulk=clear]");
    await page.selectOption(".si-list [data-per]", "100");
    await page.waitForSelector(".si-list tbody tr:nth-child(100)");
    await page.check(".si-list [data-selall]");
    const firstKey = (await keys(page))[0];
    await page.click('.si-list [data-page="next"]');
    await page.waitForFunction((k) => document.querySelector(".si-list tbody tr[data-key]").getAttribute("data-key") !== k, firstKey);
    await page.check(".si-list tbody tr:first-child [data-sel]");
    await page.waitForFunction(() => (document.querySelector(".si-bulk-count") || {}).textContent === "101 selected");
    assert.ok(await page.isDisabled('.si-bulk [data-bulk="owner"]'));
    assert.ok(await page.isDisabled('.si-bulk [data-bulk="stage"]'));
    assert.ok(await page.isEnabled('.si-bulk [data-bulk="export"]'));
    assert.match(await page.textContent(".si-bulk-over"), /up to 100 sites at a time/);
    await shot(page, "sites-bulk-over-100-1440");
    const csv = await exportCsv(page, '.si-bulk [data-bulk="export"]');
    assert.equal(csv.rows.length - 1, 101, "Export selected has the 101 rows");
  } finally {
    await close();
    await restore(ids);
  }
});
