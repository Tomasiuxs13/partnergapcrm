// Team overview (spec 2.2.5, Appendix B.7; test T20). Owner F6.
// Run: SHOTS_DIR=/tmp/shots-f6 bash tests/e2e/run.sh tests/e2e/60-team.test.mjs   (screenshots default to /tmp/shots-f6)
//
// Every page runs with the clock fixed at FIXTURE_TODAY 13:00 UTC in a UTC browser. What the page should show
// is worked out here from local D1 with plain JS (B.1 / B.7 by hand), not with rules/team.js. Changes this
// week count the D1 edits rows at or after the `since` the page's own GET /api/team-activity answered with.
// Every number in the Team table, every Stuck tile, every clean-up count, the suggestions link and a chart
// bar are then opened, and the Sites list they open must show the same count (a Sites tab or stage, or
// Sites › All with flag=<id> and its removable chip). Read-only tests first; the one write (the "Waiting on client?" tick box, then Undo) is last, and
// after() puts its row back and deletes the edits and activity rows the tests added.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { baseUrl, signedInPage, closeBrowser, d1, applyBefore, fixture, tools, pageFetch } from "./lib.mjs";

const BASE = baseUrl();
const SHOTS = process.env.SHOTS_DIR || "/tmp/shots-f6";
const fx = fixture();
const TODAY = fx.today || process.env.FIXTURE_TODAY;
const CLOCK = TODAY + "T13:00:00Z";
const DESKTOP = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };
const UTC = { timezoneId: "UTC" };
const PHONE_OPTS = { ...UTC, hasTouch: true, isMobile: true };
const SLA = { Contacted: 14, Replied: 3, Negotiating: 7, ActiveNotLive: 14 };
const COUNTS = ["owns", "prospects", "emailed", "negotiating", "active", "replies", "overdue", "quiet"];
const STUCK = ["overdue", "unanswered", "quiet", "noreply", "unowned"];
const HINT_ID = (fx.groups["J-neg-1"] || [])[0]; // Jonas's Negotiating deal "Agree terms" (Soro)
const HINT_TEXT = "Waiting for Soro to sign";
const COLS = ["next_step", "next_due", "updated_at", "updated_by"];

let original = {};
let edits0 = 0;
let activity0 = 0;
let meta = null;

// ---------- plain-JS B.1 / B.7 ----------

const has = (v) => v != null && String(v).trim() !== "";
const key = (v) => (has(v) ? String(v).trim().toLowerCase() : "");
const DAY_MS = 86400000;
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
function lastActivity(r) {
  let best = null;
  for (const v of [r.last_touch, r.last_email, r.act_at, r.updated_at]) {
    const d = dayOf(v);
    if (d && (!best || d > best)) best = d;
  }
  return best;
}
const closed = (r) => r.stage === "Lost" || r.stage === "Do not contact";
const snoozed = (r) => !!dayOf(r.next_due) && dayOf(r.next_due) > TODAY;
const waitingOnClient = (r) => /^\s*waiting on client:/i.test(r.next_step || "");
function replyOf(r) {
  if (Number(r.replied) > 0 && dayOf(r.last_email)) return { date: dayOf(r.last_email), win: 30 };
  if (dayOf(r.last_touch)) return { date: dayOf(r.last_touch), win: 7 };
  return null;
}
function handled(r) {
  const rp = replyOf(r);
  if (!rp) return false;
  const a = dayOf(r.act_at);
  const u = has(r.updated_by) ? dayOf(r.updated_at) : null;
  return (!!a && a >= rp.date) || (!!u && u >= rp.date);
}
const fresh = (r) => { const rp = replyOf(r); return !!rp && daysBetween(rp.date, TODAY) <= rp.win; };
function isPlatform(r) {
  const d = String(r.domain || "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/+$/, "");
  if (!d || d.includes("/")) return false;
  if ((meta.platform_domains || []).includes(d)) return true;
  return r.dr != null && r.dr !== "" && Number(r.dr) >= Number(meta.platform_dr != null ? meta.platform_dr : 90);
}
const RULE = {
  owns: () => true,
  prospects: (r) => r.stage === "New" || r.stage === "Researching",
  emailed: (r) => r.stage === "Contacted",
  negotiating: (r) => r.stage === "Negotiating",
  active: (r) => r.stage === "Active",
  replies: (r) => r.stage === "Replied" && fresh(r) && !handled(r) && !snoozed(r),
  overdue: (r) => !closed(r) && !!dayOf(r.next_due) && dayOf(r.next_due) < TODAY,
  quiet: (r) => {
    const la = lastActivity(r);
    if (!la || snoozed(r)) return false;
    if (r.stage === "Negotiating") return daysBetween(la, TODAY) > SLA.Negotiating;
    if (r.stage === "Active" && !has(r.content_url)) return daysBetween(la, TODAY) > SLA.ActiveNotLive;
    return false;
  },
  unanswered: (r) => r.stage === "Replied" && fresh(r) && !handled(r) && daysBetween(replyOf(r).date, TODAY) >= SLA.Replied,
  noreply: (r) => r.stage === "Contacted" && !snoozed(r) && (!lastActivity(r) || daysBetween(lastActivity(r), TODAY) > SLA.Contacted),
  unowned: (r) => (r.stage === "New" || r.stage === "Researching") && !has(r.owner) && !isPlatform(r),
  decision: (r) => r.stage === "Negotiating" && !waitingOnClient(r) && !snoozed(r),
  replied_nodate: (r) => r.stage === "Replied" && !replyOf(r),
  replied_old: (r) => r.stage === "Replied" && !!dayOf(r.last_touch) && daysBetween(dayOf(r.last_touch), TODAY) > 30,
  no_owner: (r) => !has(r.owner) && !closed(r),
  no_type: (r) => !has(r.type) || /^\s*uncategori[sz]ed\s*$/i.test(r.type),
};

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

const FIELDS = ["owner", "stage", "clients", "type", "domain", "dr", "next_step", "next_due", "last_touch", "updated_at", "updated_by", "content_url"];
async function siteRows() {
  const obj = "json_object('id', p.id, " + FIELDS.map((c) => "'" + c + "', p." + c).join(", ") +
    ", 'last_email', (SELECT MAX(last_email) FROM contacts c WHERE c.account_id = p.id)" +
    ", 'replied', (SELECT MAX(CAST(replied AS INTEGER)) FROM contacts c WHERE c.account_id = p.id)" +
    ", 'act_at', (SELECT MAX(date) FROM activity a WHERE a.account_id = p.id))";
  const rows = await retry(() => d1("SELECT " + obj + " AS j FROM partners p", { rawNulls: true }));
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

// ---------- what the Team table should show ----------

const WD = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
// The Last active text for a UTC timestamp (the browser runs in UTC).
function lastText(iso) {
  const d = dayOf(iso);
  const n = daysBetween(d, TODAY);
  if (n === 0) return "Today " + new Date(iso).toISOString().slice(11, 16);
  if (n === 1) return "Yesterday";
  const t = new Date(d + "T00:00:00Z");
  const base = WD[t.getUTCDay()] + " " + t.getUTCDate() + " " + MON[t.getUTCMonth()];
  return d.slice(0, 4) === TODAY.slice(0, 4) ? base : t.getUTCDate() + " " + MON[t.getUTCMonth()] + " " + d.slice(0, 4);
}

// [{name, none, past, owns…quiet, clients: [names], changes, last}] in the page's order.
async function expectedTable(rows, since) {
  const team = (meta.team || []).filter((t) => t && has(t.name) && t.active !== false).map((t) => String(t.name).trim());
  const people = new Map(team.map((n) => [key(n), { name: n, none: false, past: false }]));
  for (const r of rows) {
    const k = key(r.owner);
    if (!people.has(k)) people.set(k, k ? { name: String(r.owner).trim(), none: false, past: true } : { name: "No owner", none: true, past: false });
  }
  const win = await retry(() => d1("SELECT by_whom AS b, COUNT(*) AS c FROM edits WHERE at >= " + q(since) + " GROUP BY by_whom"));
  const last = await retry(() => d1("SELECT by_whom AS b, MAX(at) AS a FROM edits GROUP BY by_whom"));
  const out = [];
  for (const [k, p] of people) {
    const mine = rows.filter((r) => key(r.owner) === k);
    const e = Object.assign({}, p);
    for (const c of COUNTS) e[c] = mine.filter(RULE[c]).length;
    e.clients = p.none ? [] : (meta.clients || []).filter((c) => (c.managers || []).some((m) => key(m) === k)).map((c) => c.name);
    if (p.none) { e.changes = "—"; e.last = "—"; } else {
      e.changes = String(win.filter((w) => key(w.b) === k).reduce((s, w) => s + Number(w.c), 0));
      const at = last.filter((w) => key(w.b) === k).map((w) => w.a).sort().pop();
      e.last = at ? lastText(at) : "No edits yet";
    }
    out.push(e);
  }
  const rank = (p) => (p.none ? 2 : p.past ? 1 : 0);
  return out.sort((a, b) => rank(a) - rank(b) || b.owns - a.owns || a.name.localeCompare(b.name));
}

// What the page's Team table shows, row by row.
function shownTable(page) {
  return page.evaluate(() => Array.from(document.querySelectorAll(".tm-table tbody tr")).map((tr) => {
    const cell = (id) => tr.querySelector('[data-tm-cell="' + id + '"]');
    const o = { name: tr.getAttribute("data-tm-person"), past: tr.classList.contains("is-past"), links: {} };
    for (const id of ["owns", "prospects", "emailed", "negotiating", "active", "replies", "overdue", "quiet"]) {
      const c = cell(id);
      o[id] = Number(c.textContent.replace(/[^\d]/g, ""));
      const a = c.querySelector("a");
      if (a) o.links[id] = a.getAttribute("href");
    }
    const cl = cell("clients");
    const more = cl.querySelector(".tm-more");
    o.clients = Array.from(cl.querySelectorAll("a")).map((a) => a.textContent.trim())
      .concat(more ? more.getAttribute("title").split(", ") : []);
    o.clientLinks = Array.from(cl.querySelectorAll("a")).map((a) => a.getAttribute("href"));
    o.changes = cell("changes").textContent.trim();
    o.last = cell("last").textContent.trim();
    o.nameLink = (tr.querySelector("th a") || { getAttribute: () => null }).getAttribute("href");
    return o;
  }));
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
// A tall phone page in parts of 1500 px (one long PNG is hard to look at).
async function shotParts(page, name) {
  await settled(page);
  const { w, h } = await page.evaluate(() => ({ w: document.documentElement.clientWidth, h: document.documentElement.scrollHeight }));
  for (let i = 0, y = 0; y < h; i++, y += 1500) {
    await page.screenshot({ path: path.join(SHOTS, name + "-" + i + ".png"), fullPage: true, clip: { x: 0, y, width: w, height: Math.min(1500, h - y) } });
  }
}

function ready(page) {
  return page.waitForSelector("[data-tm-overview]:not([hidden]):not([aria-busy]) .tm-table tbody tr", { timeout: 20000 });
}
// Waits for the side requests too (team-activity, suggestions, runs), so the cells are final.
async function sideReady(page) {
  await page.waitForFunction(() => {
    const ov = document.querySelector("[data-tm-overview]");
    return ov && !ov.querySelector('[aria-label="Loading"]') && !ov.querySelector("[data-tm-runs] .ui-skeleton");
  }, null, { timeout: 15000 });
}

async function openTeam({ name = "Kamile", hash = "#team", viewport = DESKTOP, contextOptions = UTC, colorScheme, routes } = {}) {
  const s = await signedInPage({ name, viewport, clock: CLOCK, colorScheme, contextOptions });
  if (routes) await routes(s.page);
  const act = s.page.waitForResponse((r) => /\/api\/team-activity/.test(r.url()), { timeout: 20000 }).catch(() => null);
  await s.page.goto(BASE + "/" + hash);
  await ready(s.page);
  await sideReady(s.page);
  const res = await act;
  let since = null;
  try { since = res && res.ok() ? (await res.json()).since : null; } catch (e) { since = null; }
  return Object.assign(s, { since });
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
    await new Promise((r) => setTimeout(r, 150));
  }
  assert.fail("timed out waiting for " + what);
}

const announce = (page) => page.evaluate(() => (document.querySelector("[data-announce]") || {}).textContent || "");

// Opens a link's hash in the running app and returns the count its Sites list shows ("N sites" in the tool
// row). Waits until the count is there and stops changing.
async function countAt(page, hash) {
  assert.ok(hash.startsWith("#sites"), "a number opens Sites: " + hash);
  await page.evaluate((h) => { location.hash = h; }, hash);
  const sel = '[data-page="sites"] [data-si-count]';
  let prev = null, same = 0;
  const end = Date.now() + 15000;
  while (Date.now() < end) {
    const t = await page.evaluate(([s, h]) => {
      if (location.hash !== h) return null;
      const el = document.querySelector(s);
      return el ? el.textContent.trim() : null;
    }, [sel, hash]);
    const m = t && /^([\d,]+) sites?$/.exec(t);
    const n = m ? Number(m[1].replace(/,/g, "")) : null;
    if (n != null && n === prev) {
      if (++same >= 2) return n;
    } else same = 0;
    prev = n;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.fail("no count at " + hash + " (last: " + prev + ")");
}

// ---------- setup / teardown ----------

before(async () => {
  assert.ok(BASE, "BASE_URL is set (run through tests/e2e/run.sh)");
  assert.ok(!/:8788\b/.test(BASE), "never the main dev server");
  assert.ok(TODAY, "FIXTURE_TODAY");
  assert.ok(HINT_ID, "the fixture has J-neg-1");
  fs.mkdirSync(SHOTS, { recursive: true });
  edits0 = Number((await retry(() => d1("SELECT COALESCE(MAX(n), 0) AS n FROM edits")))[0].n);
  activity0 = Number((await retry(() => d1("SELECT COALESCE(MAX(n), 0) AS n FROM activity")))[0].n);
  original = await readRows([HINT_ID]);
  const s = await signedInPage({ name: "Kamile", clock: CLOCK, contextOptions: UTC });
  try {
    meta = (await pageFetch(s.page, "GET", "/api/meta")).json;
  } finally {
    await s.close();
  }
  assert.ok(meta && Array.isArray(meta.team), "GET /api/meta");
});

after(async () => {
  try {
    if (Object.keys(original).length) {
      await applyBefore(original);
      await retry(() => d1("DELETE FROM edits WHERE n > " + edits0 + " AND account_id IN " + inList(Object.keys(original))));
      await retry(() => d1("DELETE FROM activity WHERE n > " + activity0 + " AND account_id IN " + inList(Object.keys(original))));
    }
  } finally {
    await closeBrowser();
  }
});

// ---------- read-only ----------

test("T20: the Team table equals the fixture worked out by hand (Denisse from the kv override, Jay as a past owner)", async () => {
  const rows = await siteRows();
  const { page, watch, since, close } = await openTeam({ name: "Kamile" });
  try {
    assert.equal((await page.textContent("main h1")).trim(), "Team overview");
    assert.ok(since, "GET /api/team-activity answered with since");
    const exp = await expectedTable(rows, since);
    const got = await shownTable(page);
    assert.deepEqual(got.map((p) => p.name), exp.map((p) => (p.none ? "none" : p.name)), "one row per person, in order");
    for (let i = 0; i < exp.length; i++) {
      const e = exp[i], g = got[i];
      for (const c of COUNTS) assert.equal(g[c], e[c], e.name + " " + c);
      assert.deepEqual(g.clients, e.clients, e.name + " clients managed");
      assert.equal(g.changes, e.changes, e.name + " changes this week");
      assert.equal(g.last, e.last, e.name + " last active");
      assert.equal(g.past, e.past, e.name + " past owner");
      if (!e.none) assert.equal(g.nameLink, "#history?by=" + encodeURIComponent(e.name), e.name + "'s name opens Edit history");
      for (const c of COUNTS) assert.equal(!!g.links[c], e[c] > 0, e.name + " " + c + ": a nonzero number is a link, 0 isn't");
    }
    assert.ok(got.some((p) => p.name === "Denisse"), "Denisse appears (kv override)");
    assert.ok(got.some((p) => p.name === "Egle"));
    assert.ok(got.find((p) => p.name === "Jay").past, "Jay is a past owner");
    assert.equal(got[got.length - 1].name, "none", "No owner last");
    assert.ok(exp.find((p) => p.name === "Kamile").changes !== "0", "the fixture has changes this week");
    assert.deepEqual(got.find((p) => p.name === "Kamile").clientLinks.slice(0, 1), ["#clients/ultahost"]);
    assert.match(await page.textContent("[data-tm-team-note]"), /Changes made in the Google Sheet or brought in from Gmail aren't counted here\./);
    assert.equal(await announce(page), "Team overview, 7 deals need a decision");
    // Column headers in the order of spec 2.2.5.
    const heads = await page.$$eval(".tm-table thead th", (ths) => ths.map((t) => t.textContent.trim()));
    assert.deepEqual(heads, ["Person", "Owns", "Prospects", "Emailed", "Negotiating", "Active", "Replies waiting", "Clients managed",
      "Changes this week", "Overdue now", "Quiet deals now", "Last active"]);
    await shot(page, "team-kamile-1440", { fullPage: true });
    assert.deepEqual(watch.pageErrors, []);
  } finally {
    await close();
  }
});

test("T20: every nonzero Team table number opens Sites with the same count", async () => {
  const { page, watch, close } = await openTeam({ name: "Jonas" });
  try {
    const got = await shownTable(page);
    const checks = [];
    for (const p of got) for (const c of COUNTS) if (p.links[c]) checks.push({ what: p.name + " " + c, hash: p.links[c], n: p[c] });
    assert.ok(checks.length > 40, "many numbers to open (" + checks.length + ")");
    const sites = checks.filter((c) => c.hash.startsWith("#sites")).length;
    assert.equal(sites, checks.length, "every number opens Sites");
    for (const c of checks) assert.equal(await countAt(page, c.hash), c.n, c.what + " → " + c.hash);
    // A few links by hand, so the filters are the right ones and not only the count.
    const kamile = got.find((p) => p.name === "Kamile").links;
    assert.equal(kamile.owns, "#sites?tab=all&owner=Kamile&big=1");
    assert.equal(kamile.emailed, "#sites?tab=waiting&owner=Kamile");
    assert.equal(kamile.negotiating, "#sites?tab=all&owner=Kamile&stage=Negotiating&big=1");
    assert.equal(kamile.prospects, "#sites?tab=all&owner=Kamile&flag=prospects&big=1");
    assert.equal(kamile.overdue, "#sites?tab=all&owner=Kamile&flag=overdue&big=1&sort=next");
    assert.equal(kamile.replies, "#sites?tab=all&owner=Kamile&flag=replies&big=1&sort=last_activity&dir=asc");
    assert.equal(got.find((p) => p.name === "none").links.owns, "#sites?tab=all&owner=none&big=1");
    assert.deepEqual(watch.pageErrors, []);
  } finally {
    await close();
  }
});

test("Stuck: five tiles equal the fixture by hand, and each opens a list with the same count", async () => {
  const rows = await siteRows();
  const { page, watch, close } = await openTeam({ name: "Kamile" });
  try {
    const tiles = await page.$$eval("[data-tm-stuck]", (els) => els.map((e) => ({
      id: e.getAttribute("data-tm-stuck"),
      n: Number(e.querySelector(".tm-tile-n").textContent.replace(/[^\d]/g, "")),
      label: e.querySelector(".tm-tile-label").textContent.trim(),
      href: e.tagName === "A" ? e.getAttribute("href") : null,
    })));
    assert.deepEqual(tiles.map((t) => t.label), ["Overdue follow-ups", "Unanswered replies (3+ days)", "Deals going quiet",
      "No reply in 14+ days", "Unowned new prospects"]);
    for (const t of tiles) {
      assert.equal(t.n, rows.filter(RULE[t.id]).length, t.label);
      assert.ok(t.n > 0 && t.href, t.label + " has sites and opens them");
    }
    assert.equal(tiles.find((t) => t.id === "noreply").href, "#sites?tab=waiting&quiet=14&owner=all");
    assert.equal(tiles.find((t) => t.id === "unowned").href, "#sites?tab=unowned");
    assert.equal(tiles.find((t) => t.id === "overdue").href, "#sites?tab=all&flag=overdue&big=1&sort=next");
    assert.equal(tiles.find((t) => t.id === "quiet").href, "#sites?tab=all&flag=quiet&big=1&sort=last_activity&dir=asc");
    for (const t of tiles) assert.equal(await countAt(page, t.href), t.n, t.label + " → " + t.href);
    assert.deepEqual(watch.pageErrors, []);
  } finally {
    await close();
  }
});

test("Needs a decision: Negotiating deals not waiting on the client, every owner, grouped by owner", async () => {
  const rows = await siteRows();
  const { page, watch, close } = await openTeam({ name: "Kamile" });
  try {
    const exp = rows.filter(RULE.decision);
    assert.equal(exp.length, 7, "the fixture's decision rows");
    const groups = await page.$$eval("[data-tm-group]", (gs) => gs.map((g) => ({
      owner: g.getAttribute("data-tm-group"),
      head: Array.from(g.querySelector(".tm-dh").childNodes).filter((n) => !(n.classList && n.classList.contains("ui-avatar")))
        .map((n) => n.textContent).join("").replace(/\s+/g, " ").trim(),
      ids: Array.from(g.querySelectorAll(".tm-drow")).map((li) => li.getAttribute("data-key")),
      logs: g.querySelectorAll('[data-row-act="log"]').length,
    })));
    const byOwner = {};
    for (const r of exp) (byOwner[r.owner] = byOwner[r.owner] || []).push(r.id);
    assert.deepEqual(groups.map((g) => g.owner), ["Jonas", "Eivyda", "Kamile", "Vik"], "biggest group first, then by name");
    for (const g of groups) {
      assert.deepEqual(g.ids.slice().sort(), byOwner[g.owner].sort(), g.owner);
      assert.equal(g.head, g.owner + " (" + g.ids.length + ")");
      assert.equal(g.logs, g.ids.length, g.owner + ": Log what happened on every row");
    }
    assert.match(await page.textContent("#tm-h-decision"), /Needs a decision \(7\)/);
    // No next step in the fixture names its client or says waiting: no hint yet (the write test adds one).
    assert.equal(await page.$$eval("input[data-tm-wait]", (els) => els.length), 0);
    // A row opens the site in queue mode over the whole list.
    const first = groups[0].ids[0];
    await page.click('.tm-drow[data-key="' + first + '"] a[data-tm-open]');
    await page.waitForSelector('.ui-panel[data-panel="' + first + '"]');
    await page.waitForSelector(".ui-panel .ui-queue-text");
    const queue = await page.textContent(".ui-panel .ui-queue-text");
    assert.match(queue.replace(/\s+/g, " "), /1 of 7 · Needs a decision/);
    assert.deepEqual(watch.pageErrors, []);
  } finally {
    await close();
  }
});

test("Morning run and Data clean-up: counts by hand, links open lists with the same count", async () => {
  const rows = await siteRows();
  const open = await retry(() => d1("SELECT kind, COUNT(*) AS c FROM suggestions WHERE status = 'open' GROUP BY kind"));
  const suggSites = Number((await retry(() => d1("SELECT COUNT(DISTINCT account_id) AS n FROM suggestions WHERE status = 'open' AND kind IN ('candidate', 'email')")))[0].n);
  const { page, watch, close } = await openTeam({ name: "Jonas" });
  try {
    const card = await page.textContent("[data-tm-run-card]");
    const total = open.reduce((s, r) => s + Number(r.c), 0);
    assert.match(card, new RegExp(total + " open suggestions"));
    const kinds = await page.$$eval("[data-tm-runs] .tm-kv li", (lis) => lis.map((li) => Array.from(li.children).map((c) => c.textContent.trim()).join(" ")));
    const n = (k) => Number((open.find((r) => r.kind === k) || { c: 0 }).c);
    assert.deepEqual(kinds, ["Suggested contacts " + n("candidate"), "Suggested emails (test mode) " + n("email"), "Ownership checks " + n("slack_ask")]);
    assert.match(card, /By client: UltaHost 6/);
    // The latest runs: the daily one (n 3, ok) and the search for new sites (n 1).
    assert.match(await page.textContent('[data-tm-run="daily"]'), /Last copy to the Google Sheet.*Done · 14 changes copied/s);
    assert.match(await page.textContent('[data-tm-run="discovery"]'), /Last search for new sites.*Done · 24 new sites found/s);
    assert.doesNotMatch(card, /daily run/i, "vocabulary (2.5)");
    const sugg = await page.getAttribute("[data-tm-sugg]", "href");
    assert.equal(sugg, "#sites?tab=all&sugg=1&big=1");
    assert.match(await page.textContent("[data-tm-sugg]"), new RegExp("See the " + suggSites + " sites in Sites › Has a suggestion"));
    // Data clean-up.
    const clean = await page.$$eval("[data-tm-clean]", (els) => els.map((e) => ({ id: e.getAttribute("data-tm-clean"),
      n: Number(e.textContent.replace(/[^\d]/g, "")), href: e.tagName === "A" ? e.getAttribute("href") : null })));
    assert.deepEqual(clean.map((c) => c.id), ["replied_nodate", "replied_old", "no_owner", "odd_clients", "no_type"]);
    for (const c of clean) if (RULE[c.id]) assert.equal(c.n, rows.filter(RULE[c.id]).length, c.id);
    assert.match(await page.textContent("[data-tm-clean-card]"), /Bulk clean-ups run once, after Jonas decides\./);
    assert.match(await page.textContent("[data-tm-clean-card]"), /“Ultahost” → UltaHost/);
    assert.equal(await countAt(page, sugg), suggSites, "Has a suggestion");
    for (const c of clean) assert.ok(!c.n || c.href, c.id + ": a nonzero count is a link");
    for (const c of clean) if (c.href) assert.equal(await countAt(page, c.href), c.n, c.id + " → " + c.href);
    assert.deepEqual(watch.pageErrors, []);
  } finally {
    await close();
  }
});

test("Charts: collapsed by default; bars with labels and values as text; a bar opens Sites with the same count", async () => {
  const rows = await siteRows();
  const { page, watch, close } = await openTeam({ name: "Jonas" });
  try {
    assert.equal(await page.$eval("[data-tm-charts]", (d) => d.open), false, "collapsed");
    assert.equal(await page.$eval("[data-tm-charts-body]", (b) => b.children.length), 0, "drawn only when opened");
    await page.click(".tm-charts-sum");
    await page.waitForSelector("[data-tm-chart] .ui-bar");
    const charts = await page.$$eval("[data-tm-chart]", (cs) => cs.map((c) => ({
      id: c.getAttribute("data-tm-chart"),
      title: (c.querySelector(".ui-bars-title") || {}).textContent,
      bars: Array.from(c.querySelectorAll(".ui-bar")).map((b) => ({
        label: b.querySelector(".ui-bar-label").textContent.trim(),
        value: b.querySelector(".ui-bar-value").textContent.trim(),
        href: (b.querySelector(".ui-bar-label a") || { getAttribute: () => null }).getAttribute("href"),
      })),
    })));
    assert.deepEqual(charts.map((c) => c.title), ["Pipeline by stage", "Sites per client", "Affiliate type (top 10)",
      "Top countries (top 10)", "DR bands", "Reply rate by owner (%)"]);
    for (const c of charts) {
      assert.ok(c.bars.length > 0, c.id + " has bars");
      for (const b of c.bars) assert.ok(b.label && /^\d[\d,]*$/.test(b.value), c.id + ": label and value as text (" + b.label + " " + b.value + ")");
    }
    const pipe = charts[0].bars;
    for (const b of pipe) assert.equal(Number(b.value.replace(/,/g, "")), rows.filter((r) => r.stage === b.label).length, "pipeline " + b.label);
    const neg = pipe.find((b) => b.label === "Negotiating");
    assert.equal(neg.href, "#sites?tab=all&stage=Negotiating&big=1");
    await shot(page, "team-charts-1440", { fullPage: true });
    await page.click('[data-tm-chart="pipeline"] .ui-bar-label a:text-is("Negotiating")');
    assert.equal(await countAt(page, neg.href), Number(neg.value), "the bar's Sites list");
    const soro = charts[1].bars.find((b) => b.label === "Soro");
    assert.equal(await countAt(page, soro.href), Number(soro.value), "Sites per client: Soro");
    assert.deepEqual(watch.pageErrors, []);
  } finally {
    await close();
  }
});

test("A number opens Sites with a removable chip; Back returns to the same place with the focus on that number", async () => {
  const { page, watch, close } = await openTeam({ name: "Kamile" });
  try {
    // "Recently active" (spec 2.3: the old Home "Recently updated") is linked from the Team section.
    assert.equal(await page.getAttribute("[data-tm-recent]", "href"), "#sites?tab=all&preset=activity");
    assert.equal((await page.textContent("[data-tm-recent]")).trim(), "Recently active sites");
    const link = '[data-tm-person="Gaby"] [data-tm-cell="prospects"] a';
    await page.$eval(link, (a) => a.scrollIntoView({ block: "center" }));
    const y0 = await page.evaluate(() => window.scrollY);
    const shown = Number((await page.textContent(link)).replace(/[^\d]/g, ""));
    await page.click(link);
    await page.waitForFunction(() => location.hash.startsWith("#sites"));
    assert.equal(await page.evaluate(() => location.hash), "#sites?tab=all&owner=Gaby&flag=prospects&big=1");
    const exp = (await siteRows()).filter((r) => key(r.owner) === "gaby" && RULE.prospects(r));
    assert.equal(shown, exp.length);
    assert.equal(await countAt(page, "#sites?tab=all&owner=Gaby&flag=prospects&big=1"), exp.length);
    assert.ok(exp.some((r) => r.stage === "Researching"), "Researching is a prospect too");
    const chips = await page.$$eval(".si-filters .ui-chiprow .ui-fchip", (cs) => cs.map((c) => c.firstChild.textContent.trim()));
    assert.deepEqual(chips, ["Prospects", "Owner: Gaby", "Show big sites"], "the list's name as the first chip, then the owner and big sites (Team counts them)");
    assert.equal((await page.textContent("[data-si-sub]")).trim(), "Not contacted yet (New or Researching).");
    await shot(page, "team-number-to-sites-1440");
    // Back: the overview at the same place, the focus on the number.
    await page.goBack();
    await ready(page);
    await page.waitForFunction(() => document.activeElement && document.activeElement.getAttribute("data-tm-f") === "cell:gaby:prospects", null, { timeout: 5000 })
      .catch(() => assert.fail("the focus is back on the number"));
    const y1 = await page.evaluate(() => window.scrollY);
    assert.ok(Math.abs(y1 - y0) < 4, "the same scroll position (" + y0 + " → " + y1 + ")");
    // A nav click to the Team overview starts at the top (only Back returns to the number).
    await page.evaluate(() => { location.hash = "#sites?tab=mine"; });
    await page.waitForSelector('[data-page="sites"] .si-page');
    await page.evaluate(() => { location.hash = "#team"; });
    await ready(page);
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(await page.evaluate(() => window.scrollY), 0);
    assert.equal(await page.evaluate(() => document.activeElement && document.activeElement.tagName), "H1");
    // The chip's × removes the list: every site of Gaby's.
    await page.evaluate(() => { location.hash = "#sites?tab=all&owner=Gaby&flag=prospects&big=1"; });
    await page.waitForSelector('.si-filters [data-fremove="flag"]');
    await page.click('.si-filters [data-fremove="flag"]');
    await page.waitForFunction(() => !/flag=/.test(location.hash));
    assert.equal(await countAt(page, await page.evaluate(() => location.hash)), (await siteRows()).filter((r) => key(r.owner) === "gaby").length);
    // The Team overview's old list links (#team?show=…) open the same list on Sites, replacing the entry.
    await page.evaluate(() => { location.hash = "#team?show=overdue&owner=Kamile"; });
    await page.waitForFunction(() => location.hash === "#sites?tab=all&owner=Kamile&flag=overdue&big=1&sort=next");
    await page.evaluate(() => { location.hash = "#team?show=nope"; });
    await page.waitForFunction(() => location.hash === "#team");
    await ready(page);
    assert.deepEqual(watch.pageErrors, []);
  } finally {
    await close();
  }
});

test("Vik lands on the Team overview (team[].home), which is in the nav", async () => {
  const { page, watch, close } = await signedInPage({ name: "Vik", clock: CLOCK, contextOptions: UTC });
  try {
    await ready(page);
    assert.equal((await page.textContent("main h1")).trim(), "Team overview");
    assert.deepEqual(watch.pageErrors, []);
  } finally {
    await close();
  }
});

test("Without the 004 endpoints the sections say so and nothing breaks", async () => {
  const gone = async (page) => {
    for (const p of ["**/api/team-activity*", "**/api/suggestions*", "**/api/runs*"]) {
      await page.route(p, (r) => r.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: "Not available yet", unavailable: true }) }));
    }
  };
  const { page, watch, close } = await openTeam({ name: "Kamile", routes: gone });
  try {
    assert.match(await page.textContent("[data-tm-team-note]"), /Changes this week and Last active: Not available yet\./);
    const cells = await page.$$eval('[data-tm-cell="changes"], [data-tm-cell="last"]', (els) => Array.from(new Set(els.map((e) => e.textContent.trim()))));
    assert.deepEqual(cells, ["—"]);
    const card = await page.textContent("[data-tm-run-card]");
    assert.match(card, /Suggestions from the morning run \(contacts found, test emails\) appear here once it writes them to the site\. Until then they're in the daily review in the CRM project\./);
    assert.equal(await page.$$eval("[data-tm-run]", (els) => els.length), 0, "no runs");
    // The rest is still there.
    assert.ok(await page.$("[data-tm-stuck] .tm-tile-n"));
    assert.match(await page.textContent("#tm-h-decision"), /\(7\)/);
    await shot(page, "team-degraded-1440", { fullPage: true });
    assert.deepEqual(watch.pageErrors, []);
  } finally {
    await close();
  }
});

test("Phone (390 px): one column, no sideways scroll, team cards with a label on every number, actions behind ⋯", async () => {
  for (const name of ["Kamile", "Jonas"]) {
    const { page, watch, close } = await openTeam({ name, viewport: PHONE, contextOptions: PHONE_OPTS });
    try {
      await noHorizontalScroll(page, name + " overview");
      const tiles = await page.$$eval("[data-tm-stuck]", (els) => els.map((e) => e.getBoundingClientRect().top));
      assert.equal(tiles[0], tiles[1], "Stuck tiles two by two");
      assert.ok(tiles[2] > tiles[0]);
      const lab = await page.$eval('[data-tm-person="Kamile"] [data-tm-cell="owns"]', (td) => getComputedStyle(td, "::before").content);
      assert.equal(lab, '"Owns"', "each number has its label");
      assert.equal(await page.$eval(".tm-table thead", (t) => getComputedStyle(t).display), "none");
      const big = await page.$$eval(".tm-drow", (lis) => lis.every((li) => {
        const log = li.querySelector('[data-row-act="log"]');
        const more = li.querySelector('[data-row-act="more"]');
        return (!log || log.offsetParent === null) && more && more.getBoundingClientRect().height >= 44;
      }));
      assert.ok(big, "Log what happened behind ⋯ (44 px)");
      const tap = await page.$eval('[data-tm-person="Kamile"] [data-tm-cell="owns"]', (td) => td.getBoundingClientRect().height);
      assert.ok(tap >= 44, "a number's cell is a 44 px target (" + tap + ")");
      await page.click(".tm-charts-sum");
      await page.waitForSelector("[data-tm-chart] .ui-bar");
      await noHorizontalScroll(page, name + " with charts open");
      await page.click(".tm-charts-sum");
      await shotParts(page, "team-" + name.toLowerCase() + "-390");
      // A Stuck tile's list on the phone (Sites with the chip).
      await page.click('[data-tm-stuck="overdue"]');
      await page.waitForSelector('.si-filters [data-fremove="flag"]');
      await noHorizontalScroll(page, name + " list");
      if (name === "Kamile") await shot(page, "team-list-390");
      assert.deepEqual(watch.pageErrors, []);
    } finally {
      await close();
    }
  }
});

test("axe: no serious or critical issues on the Team overview (light and dark, charts open) and a flag list on Sites", async () => {
  const axeSrc = fs.readFileSync(tools().axe, "utf8");
  const check = async (page, where) => {
    await settled(page);
    await page.evaluate(axeSrc);
    const res = await page.evaluate(async () => {
      const r = await window.axe.run({ include: [["main"]] }, { resultTypes: ["violations"] });
      return r.violations.filter((v) => v.impact === "serious" || v.impact === "critical")
        .map((v) => v.id + ": " + v.help + " -> " + v.nodes.slice(0, 3).map((n) => n.target.join(" ")).join(" | "));
    });
    assert.deepEqual(res, [], where);
  };
  for (const colorScheme of ["light", "dark"]) {
    const { page, close } = await openTeam({ name: "Kamile", colorScheme });
    try {
      await page.click(".tm-charts-sum");
      await page.waitForSelector("[data-tm-chart] .ui-bar");
      await check(page, colorScheme);
      if (colorScheme === "dark") await shot(page, "team-kamile-1440-dark", { fullPage: true });
      await page.evaluate(() => { location.hash = "#sites?tab=all&flag=quiet&big=1&sort=last_activity&dir=asc"; });
      await page.waitForSelector('.si-filters [data-fremove="flag"]');
      await page.waitForSelector(".si-list tbody tr");
      await check(page, colorScheme + " list");
    } finally {
      await close();
    }
  }
  const { page, close } = await openTeam({ name: "Kamile", viewport: PHONE, contextOptions: PHONE_OPTS });
  try {
    await check(page, "phone");
  } finally {
    await close();
  }
});

// ---------- the write ----------

test("“Waiting on client?”: shown when the next step names the client; one click ticks it, Undo puts it back", async () => {
  await applyBefore({ [HINT_ID]: { next_step: HINT_TEXT } });
  const { page, watch, close } = await openTeam({ name: "Jonas" });
  try {
    const box = '.tm-drow[data-key="' + HINT_ID + '"] input[data-tm-wait]';
    assert.equal(await page.$$eval("input[data-tm-wait]", (els) => els.map((e) => e.getAttribute("data-tm-wait"))).then((a) => a.join()), HINT_ID,
      "only the row whose next step names its client");
    assert.match(await page.textContent('.tm-drow[data-key="' + HINT_ID + '"] .tm-hint'), /Waiting on client\?/);
    await shot(page, "team-hint-1440");
    const order = await page.$$eval(".tm-drow", (lis) => lis.map((li) => li.getAttribute("data-key")));
    const nextId = order[order.indexOf(HINT_ID) + 1];
    const writes = await writesDuring(page, async () => {
      await page.click(box);
      await page.waitForSelector('.tm-drow[data-key="' + HINT_ID + '"]', { state: "detached" });
    });
    assert.deepEqual(writes, ["PATCH /api/partner/" + HINT_ID], "one save");
    assert.match(await page.textContent("#tm-h-decision"), /Needs a decision \(6\)/);
    const stored = await waitFor(async () => {
      const r = await retry(() => d1("SELECT next_step FROM partners WHERE id = " + q(HINT_ID)));
      return r[0] && r[0].next_step === "Waiting on client: " + HINT_TEXT ? r[0] : null;
    }, "the next step to start with Waiting on client:");
    assert.equal(stored.next_step, "Waiting on client: " + HINT_TEXT);
    const e = await retry(() => d1("SELECT by_whom, field, new FROM edits WHERE n > " + edits0 + " AND account_id = " + q(HINT_ID) + " ORDER BY n DESC LIMIT 1"));
    assert.deepEqual({ ...e[0] }, { by_whom: "Jonas", field: "next_step", new: "Waiting on client: " + HINT_TEXT });
    const focus = await page.evaluate(() => document.activeElement && document.activeElement.getAttribute("data-tm-open"));
    assert.equal(focus, nextId, "the focus moves to the row that took its place");
    // Undo in the toast.
    await page.click('.ui-toast [data-t="undo"]');
    await page.waitForSelector(box);
    await waitFor(async () => {
      const r = await retry(() => d1("SELECT next_step FROM partners WHERE id = " + q(HINT_ID)));
      return r[0] && r[0].next_step === HINT_TEXT;
    }, "Undo to put the next step back");
    assert.match(await page.textContent("#tm-h-decision"), /Needs a decision \(7\)/);
    assert.deepEqual(watch.pageErrors, []);
  } finally {
    await close();
  }
});
