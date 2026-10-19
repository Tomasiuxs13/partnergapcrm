// Today (spec 2.2.1, Appendix B.1-B.3; tests T2, T2b and the queue part of T3). Owner F2.
// Run: bash tests/e2e/run.sh tests/e2e/10-today.test.mjs   (screenshots: SHOTS_DIR, default /tmp/shots-f2)
//
// Read-only tests first (counts, order, chips, blocks, phone layout, axe), on the untouched fixture. Then the
// writes, each in its own signed-in context: Interested from the Do now queue (golden rows, auto-advance),
// "Mark N as handled" (one bulk request), Add contact / Copy email / Sent first email in New prospects, and
// Add as contact from a suggestion (only when the suggestions table exists). Every row a test changes is put
// back in after(); the contacts and activity rows the tests add are deleted.
// One mock: the duplicate check answers 409 for dupe@today.example.test (the real check is covered by 90).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  baseUrl, signedInPage, closeBrowser, d1, applyBefore, maxEditN, editsAfter, stripEdit, goldenCase, assertGolden,
  fixture, tools,
} from "./lib.mjs";

const BASE = baseUrl();
const SHOTS = process.env.SHOTS_DIR || "/tmp/shots-f2";
const fx = fixture();
const TODAY = fx.today || process.env.FIXTURE_TODAY;
const HAS_SUGG = String(process.env.D1_TABLES || "").split(",").includes("suggestions");
const K = fx.intended.Kamile;
const J = fx.intended.Jonas;
// updated_at/updated_by too: a save after the reply date marks a reply handled (model.derive).
const COLS = ["stage", "owner", "clients", "type", "next_step", "next_due", "last_touch", "contacts", "updated_at", "updated_by"];
const NOW = '[data-block="now"]';
const PROS = '[data-block="prospects"]';
const COMING = '[data-block="coming"]';
const P = "#layer-panel ";
const DESKTOP = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };
const PHONE_OPTS = { hasTouch: true, isMobile: true };

const one = (tag) => {
  const ids = fx.groups[tag];
  assert.ok(ids && ids.length, "fixture group " + tag);
  return ids[0];
};
const ID = {
  interested: one("c-interested"),
  newOne: "NEW-0001",
  sugg: K.newProspects.withSuggestions[0], // Lina Brooks, a candidate suggestion
};

// Kamile's Do now in B.1 order: no-reply rows all share one date, so id order, capped at 10.
const kNoreply = K.doNow.noreply.dated.slice().sort().slice(0, K.doNow.noreply.count);
const K_ORDER = [...K.doNow.overdue, ...K.doNow.reply, ...K.doNow.decision, ...K.doNow.due, ...K.doNow.quiet, ...kNoreply];
const K_REASONS = [
  ...K.doNow.overdue.map(() => "overdue"), ...K.doNow.reply.map(() => "reply"), ...K.doNow.decision.map(() => "decision"),
  ...K.doNow.due.map(() => "due"), ...K.doNow.quiet.map(() => "quiet"), ...kNoreply.map(() => "noreply"),
];
const K_GROUPS = {
  replies: K.doNow.reply.length,
  followups: K.doNow.overdue.length + K.doNow.due.length + K.doNow.noreply.count,
  deals: K.doNow.decision.length + K.doNow.quiet.length,
};

let original = {};
let contacts0 = [];
let activity0 = 0;
let suggOpen = [];

// ---------- helpers ----------

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

// D1 reads go through the wrangler CLI and can meet SQLITE_BUSY while the server writes: retry.
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
  const obj = "json_object('id', id, " + COLS.map((c) => "'" + c + "', " + c).join(", ") + ")";
  const rows = await retry(() => d1("SELECT " + obj + " AS j FROM partners WHERE id IN " + inList(ids), { rawNulls: true }));
  const out = {};
  for (const r of rows) {
    const o = JSON.parse(r.j);
    out[o.id] = {};
    for (const c of COLS) out[o.id][c] = o[c];
  }
  return out;
}
const readRow = async (id) => (await readRows([id]))[id];

async function waitEdits(n0, count, { ms = 15000 } = {}) {
  const end = Date.now() + ms;
  let rows = [];
  while (Date.now() < end) {
    rows = await retry(() => editsAfter(n0));
    if (rows.length >= count) return rows.map(stripEdit);
    await new Promise((r) => setTimeout(r, 300));
  }
  assert.fail("expected " + count + " new edits rows after n=" + n0 + ", got " + rows.length);
}

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

// Non-GET API requests the page sends while fn runs.
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

async function openToday(o = {}) {
  const s = await signedInPage({ viewport: DESKTOP, ...o });
  await s.page.goto(BASE + "/#today");
  await s.page.waitForSelector(".td-body .td-block, .td-clear", { timeout: 20000 });
  return s;
}

const keys = (page, block) => page.$$eval(block + " .td-rows > li", (ls) => ls.map((l) => l.getAttribute("data-key")));
const heading = (page, block) => page.textContent(block + " .td-h").then((t) => t.replace(/\s+/g, " ").trim());

async function noHorizontalScroll(page, where) {
  const { sw, cw } = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
  assert.ok(sw <= cw, where + ": no horizontal scroll (" + sw + " > " + cw + ")");
}

// The first Do now row (its link and its first visible action) is inside the viewport, above the bottom tabs
// on a phone.
async function firstRowAboveFold(page, where) {
  const r = await page.evaluate((sel) => {
    const row = document.querySelector(sel + " .td-row");
    if (!row) return null;
    const tabs = document.querySelector(".sh-tabs");
    const limit = tabs && getComputedStyle(tabs).display !== "none" ? tabs.getBoundingClientRect().top : innerHeight;
    const act = Array.from(row.querySelectorAll(".td-acts button")).find((b) => b.offsetParent !== null);
    return { link: row.querySelector(".td-link").getBoundingClientRect().bottom, act: act ? act.getBoundingClientRect().bottom : Infinity, limit };
  }, NOW);
  assert.ok(r, where + ": a Do now row");
  assert.ok(r.link <= r.limit && r.act <= r.limit, where + ": the first Do now row is above the fold (" + JSON.stringify(r) + ")");
}

async function panelQueue(page) {
  await page.waitForSelector(P + ".ui-queue-text");
  return (await page.textContent(P + ".ui-queue-text")).replace(/\s+/g, " ").trim();
}

function profileLoaded(page) {
  return page.waitForFunction(() => !document.querySelector("#layer-panel .ui-skeleton"), null, { timeout: 15000 });
}

// ---------- setup / teardown ----------

before(async () => {
  assert.ok(BASE, "BASE_URL is set (run through tests/e2e/run.sh)");
  assert.ok(!/:8788\b/.test(BASE), "never the main dev server");
  fs.mkdirSync(SHOTS, { recursive: true });
  const touched = [ID.interested, ID.newOne, ID.sugg, ...K.doNow.reply];
  original = await readRows(touched);
  contacts0 = (await retry(() => d1("SELECT id FROM contacts WHERE account_id IN " + inList(touched)))).map((r) => r.id);
  activity0 = Number((await retry(() => d1("SELECT COALESCE(MAX(n), 0) AS n FROM activity")))[0].n);
  if (HAS_SUGG) suggOpen = (await retry(() => d1("SELECT id FROM suggestions WHERE account_id = " + q(ID.sugg) + " AND status = 'open'"))).map((r) => r.id);
});

// Puts sites back: their columns, without the contacts and activity rows the tests added.
async function restore(ids) {
  const list = ids.filter((id) => original[id]);
  if (!list.length) return;
  await retry(() => d1("DELETE FROM contacts WHERE account_id IN " + inList(list) +
    (contacts0.length ? " AND id NOT IN " + inList(contacts0) : "")));
  await retry(() => d1("DELETE FROM activity WHERE n > " + activity0 + " AND account_id IN " + inList(list)));
  const back = {};
  for (const id of list) back[id] = original[id];
  await applyBefore(back);
}

after(async () => {
  try {
    await restore(Object.keys(original));
    if (suggOpen.length) await retry(() => d1("UPDATE suggestions SET status = 'open' WHERE id IN " + inList(suggOpen)));
  } finally {
    await closeBrowser();
  }
});

// ---------- T2: read-only ----------

test("T2: Kamile's Do now is B.1 in order with its chips; the nav badge is doNowCount", async () => {
  const { page, watch, close } = await openToday({ name: "Kamile" });
  try {
    assert.equal((await page.textContent("main h1")).trim(), "Today");
    assert.match(await page.textContent(".td-sub"), /^[A-Z][a-z]+day \d{1,2} [A-Z][a-z]+ · Kamile$/);
    assert.equal(await heading(page, NOW), "Do now (" + K.doNowCount + ")");
    assert.equal(K.doNowCount, 20);
    assert.equal((await page.textContent('.sh-side [data-badge="today"]')).trim(), String(K.doNowCount), "badge = doNowCount");
    assert.equal((await keys(page, NOW)).length, 7, "7 rows before Show all");
    assert.deepEqual(await keys(page, NOW), K_ORDER.slice(0, 7));
    await firstRowAboveFold(page, "Kamile 1440");
    await noHorizontalScroll(page, "Kamile 1440");
    await shot(page, "today-kamile-1440");

    // Header chips with their counts; All is picked.
    const chips = await page.$$eval("[data-td-filter]", (bs) => bs.map((b) => [b.getAttribute("data-td-filter"), b.textContent.replace(/\s+/g, " ").trim(), b.getAttribute("aria-pressed")]));
    assert.deepEqual(chips, [
      ["all", "All", "true"],
      ["replies", "Replies (" + K_GROUPS.replies + ")", "false"],
      ["followups", "Follow-ups (" + K_GROUPS.followups + ")", "false"],
      ["deals", "Deals (" + K_GROUPS.deals + ")", "false"],
    ]);
    // The no-reply cap and its note.
    assert.match(await page.textContent(NOW + " .td-note"), new RegExp("^Showing 10 of " + K.doNow.noreply.candidates + " sites with no reply"));
    assert.match(await page.getAttribute(NOW + " [data-td-noreply]", "href"), /^#sites\?.*tab=waiting/);

    // Show all expands in place: the whole list, in order, with a reason chip per row.
    await page.click('[data-td-more="now"]');
    assert.deepEqual(await keys(page, NOW), K_ORDER);
    assert.equal(await page.textContent('[data-td-more="now"]'), "Show fewer");
    const rows = await page.$$eval(NOW + " .td-rows > li", (ls) => ls.map((l) => ({
      id: l.getAttribute("data-key"),
      reason: l.querySelector("[data-reason]").getAttribute("data-reason"),
      chip: l.querySelector("[data-reason]").textContent.trim(),
      noDate: !!l.querySelector(".ui-chip.is-nodate"),
      acts: Array.from(l.querySelectorAll(".td-acts .ui-btn")).filter((b) => b.offsetParent !== null).map((b) => b.textContent.replace(/\s+/g, " ").trim()),
    })));
    assert.deepEqual(rows.map((r) => r.reason), K_REASONS);
    const chipRe = { overdue: /^Overdue \d+d$/, reply: /^Replied (today|\d+d ago)$/, decision: /^Your decision$/, due: /^Due today$/,
      quiet: /^Quiet \d+d$/, noreply: /^No reply (\d+d|· no date)$/ };
    for (const r of rows) assert.match(r.chip, chipRe[r.reason], r.id);
    assert.equal(rows[0].chip, "Overdue 6d", "K-od3 is 6 days overdue");
    assert.deepEqual(rows.filter((r) => r.noDate).map((r) => r.id).sort(), K.noDateChip.slice().sort(), "No date chips");
    for (const r of rows) assert.deepEqual(r.acts, ["Log what happened ▾", "Follow up ▾"], r.id + " actions");
    for (const id of K.notInDoNow) assert.ok(!rows.some((r) => r.id === id), id + " is not in Do now");
    assert.deepEqual(watch.pageErrors, []);
  } finally {
    await close();
  }
});

test("T2: the header chips filter Do now in place; Replies offers Mark N as handled", async () => {
  const { page, close } = await openToday({ name: "Kamile" });
  try {
    assert.equal(await page.$("[data-td-handled]"), null, "no Mark as handled under All");
    await page.click('[data-td-filter="replies"]');
    assert.equal(await page.getAttribute('[data-td-filter="replies"]', "aria-pressed"), "true");
    assert.deepEqual(await keys(page, NOW), K.doNow.reply);
    assert.equal((await page.textContent("[data-td-handled]")).trim(), "Mark " + K.doNow.reply.length + " as handled…");
    assert.equal(await heading(page, NOW), "Do now (" + K.doNowCount + ")", "the heading keeps the whole count");
    await page.click('[data-td-filter="deals"]');
    assert.deepEqual(await keys(page, NOW), [...K.doNow.decision, ...K.doNow.quiet]);
    assert.equal(await page.$("[data-td-handled]"), null);
    await page.click('[data-td-filter="followups"]');
    await page.click('[data-td-more="now"]');
    assert.deepEqual(await keys(page, NOW), [...K.doNow.overdue, ...K.doNow.due, ...kNoreply]);
    await page.click('[data-td-filter="all"]');
    assert.equal((await keys(page, NOW)).length, 7, "a new chip collapses the list again");
  } finally {
    await close();
  }
});

test("T2: New prospects (B.2) and Coming up (B.3) for Kamile", async () => {
  const { page, close } = await openToday({ name: "Kamile" });
  try {
    const shown = K.newProspects.shows;
    assert.equal(await heading(page, PROS), "New prospects: find a contact (" + shown + " of " + K.newProspects.count + ")");
    const ks = await keys(page, PROS);
    assert.equal(ks.length, shown);
    if (HAS_SUGG) {
      const n = K.newProspects.withSuggestions.length;
      assert.deepEqual(ks.slice(0, n).sort(), K.newProspects.withSuggestions.slice().sort(), "suggested rows first");
      assert.deepEqual(ks.slice(n, n + 2), K.newProspects.newIds, "then the NEW- sites, newest first");
      assert.match(await page.textContent(PROS + " .td-hint"), new RegExp("· " + n + " with a suggested contact"));
      await page.waitForSelector(PROS + ' [data-key="' + ID.sugg + '"] .td-sugg');
      assert.match(await page.textContent(PROS + ' [data-key="' + ID.sugg + '"] .td-sugg'), /^Suggested: Lina Brooks, Partnerships lead \(Apollo\) · Add as contact/);
    } else {
      assert.deepEqual(ks.slice(0, 2), K.newProspects.newIds, "the NEW- sites first, newest first");
    }
    assert.equal(await page.getAttribute(PROS + " .td-bfoot a", "href"), "#sites?tab=mine");
    assert.equal((await page.textContent(PROS + " .td-bfoot a")).trim(), "See all " + K.newProspects.count + " in Sites");
    const acts = await page.$$eval(PROS + " .td-rows > li:first-child .td-acts > *", (as) => as.filter((a) => a.offsetParent !== null).map((a) => a.textContent.replace(/\s+/g, " ").trim()));
    assert.deepEqual(acts, ["Visit site ↗", "Add contact", "Not a fit"]);
    const visit = await page.getAttribute(PROS + " .td-rows > li:first-child [data-td-act=visit]", "href");
    assert.match(visit, /^https:\/\/[a-z0-9.-]+\.example\.test\/?$/);

    // Coming up: collapsed, soonest first.
    assert.equal(await page.getAttribute(COMING, "open"), null, "collapsed");
    assert.equal(await heading(page, COMING), "Coming up (" + K.comingUp.length + ")");
    await page.click(COMING + " summary");
    await page.waitForSelector(COMING + "[open]");
    assert.deepEqual(await keys(page, COMING), K.comingUp);
    assert.equal((await page.textContent(".td-sum-hint")).trim(), "Hide");
    await shot(page, "today-kamile-1440-full", { fullPage: true });
  } finally {
    await close();
  }
});

test("T2: Jonas sees his own Do now (17) and New prospects (5, no big sites); no Coming up block when empty", async () => {
  const { page, close } = await openToday({ name: "Jonas" });
  try {
    assert.equal(await heading(page, NOW), "Do now (" + J.doNowCount + ")");
    assert.equal(J.doNowCount, 17);
    assert.equal((await page.textContent('.sh-side [data-badge="today"]')).trim(), "17");
    await page.click('[data-td-more="now"]');
    const ks = await keys(page, NOW);
    const d = J.doNow;
    assert.equal(ks.length, 17);
    assert.deepEqual(ks.slice(0, 1), d.overdue);
    assert.deepEqual(ks.slice(1, 7).sort(), d.reply.slice().sort(), "6 email replies inside the 30-day window");
    assert.deepEqual(ks.slice(7, 11), d.decision);
    assert.deepEqual(ks.slice(11, 12), d.quiet);
    assert.deepEqual(ks.slice(12).sort(), d.noreply.dated.slice().sort());
    for (const id of J.notInDoNow) assert.ok(!ks.includes(id), id + " (replied 40 days ago) is not in Do now");
    assert.equal(await page.$(NOW + " .td-note"), null, "5 no-reply sites: under the cap, no note");
    assert.equal(await heading(page, PROS), "New prospects: find a contact (" + J.newProspects.count + ")");
    const ps = await keys(page, PROS);
    assert.ok(ps.includes("NEW-0004"));
    for (const id of J.newProspects.platformsHidden) assert.ok(!ps.includes(id), id + " is a big site");
    assert.equal(await page.$(PROS + " .td-bfoot"), null, "5 of 5: no See all link");
    assert.equal(J.comingUp, undefined, "the fixture gives Jonas no future follow-ups");
    assert.equal(await page.$(COMING), null, "an empty block is hidden");
    await firstRowAboveFold(page, "Jonas 1440");
    await noHorizontalScroll(page, "Jonas 1440");
    await shot(page, "today-jonas-1440");
  } finally {
    await close();
  }
});

test("T2 phone: 390x844, one column, row actions behind ⋯, first row above the tabs, no sideways scroll", async () => {
  for (const name of ["Kamile", "Jonas"]) {
    const { page, close } = await openToday({ name, viewport: PHONE, contextOptions: PHONE_OPTS });
    try {
      await firstRowAboveFold(page, name + " 390");
      await noHorizontalScroll(page, name + " 390");
      const vis = await page.$$eval(NOW + " .td-row:first-child .td-acts button", (bs) => bs.filter((b) => b.offsetParent !== null).map((b) => b.getAttribute("aria-label") || b.textContent.trim()));
      assert.equal(vis.length, 1, "only ⋯ on a phone: " + JSON.stringify(vis));
      const pvis = await page.$$eval(PROS + " .td-row:first-child .td-acts > *", (bs) => bs.filter((b) => b.offsetParent !== null).map((b) => b.className));
      assert.deepEqual(pvis.length, 1, "New prospects: only ⋯");
      const chipsOneLine = await page.$eval(".td-chips", (c) => c.scrollHeight <= c.firstElementChild.offsetHeight + 4);
      assert.ok(chipsOneLine, "the header chips stay on one line");
      await shot(page, "today-" + name.toLowerCase() + "-390");
      await shot(page, "today-" + name.toLowerCase() + "-390-full", { fullPage: true });
      if (name === "Kamile") {
        await page.tap(PROS + " .td-row:first-child .td-dots");
        await page.waitForSelector(".ui-menu");
        const items = await page.$$eval(".ui-menu [role=menuitem]", (is) => is.map((i) => i.textContent.replace(/\s+/g, " ").trim()));
        assert.deepEqual(items, ["Visit site ↗", "Add contact", "Not a fit…", "Open details"]);
        await shot(page, "today-kamile-390-menu");
        await page.keyboard.press("Escape");
        await page.waitForSelector(".ui-menu", { state: "detached" });
      }
    } finally {
      await close();
    }
  }
});

test("T2b: someone with nothing due and no prospects gets one All clear line and no empty cards", async () => {
  const { page, close } = await openToday({ name: "Rita" });
  try {
    await page.waitForSelector(".td-clear");
    assert.equal(await page.$$eval(".td-block", (b) => b.length), 0, "no blocks");
    assert.equal(await page.$$eval(".td-clear", (b) => b.length), 1);
    assert.equal((await page.textContent(".td-clear")).replace(/\s+/g, " ").trim(),
      "All clear. New replies arrive each weekday morning after 08:47. Open Sites › Mine to contact");
    assert.equal(await page.getAttribute(".td-clear a", "href"), "#sites?tab=mine");
    assert.equal(await page.$("[data-td-start]"), null, "no Start");
    assert.equal(await page.getAttribute('.sh-side [data-badge="today"]', "hidden"), "", "no badge");
    await shot(page, "today-allclear-1440");
  } finally {
    await close();
  }
});

test("Start opens the whole Do now list in queue mode; a row click opens its own block's queue", async () => {
  const { page, close } = await openToday({ name: "Kamile" });
  try {
    await page.click("[data-td-start]");
    await page.waitForSelector(P + '.ui-panel[data-panel="' + K_ORDER[0] + '"]');
    assert.equal(await panelQueue(page), "1 of " + K.doNowCount + " · Do now");
    await page.keyboard.press("Escape");
    await page.waitForSelector(P + ".ui-panel", { state: "detached" });

    // A click on the row outside its buttons, in New prospects.
    const second = (await keys(page, PROS))[1];
    await page.click(PROS + ' [data-key="' + second + '"] .td-av');
    await page.waitForSelector(P + '.ui-panel[data-panel="' + second + '"]');
    assert.equal(await panelQueue(page), "2 of " + K.newProspects.count + " · New prospects");
    await page.keyboard.press("Escape");
    await page.waitForSelector(P + ".ui-panel", { state: "detached" });

    // Coming up, through the site link.
    await page.click(COMING + " summary");
    await page.click(COMING + ' [data-key="' + K.comingUp[2] + '"] a[data-open]');
    await page.waitForSelector(P + '.ui-panel[data-panel="' + K.comingUp[2] + '"]');
    assert.equal(await panelQueue(page), "3 of " + K.comingUp.length + " · Coming up");
  } finally {
    await close();
  }
});

test("axe: no serious or critical issues on Today (light and dark)", async () => {
  const axeSrc = fs.readFileSync(tools().axe, "utf8");
  for (const colorScheme of ["light", "dark"]) {
    const { page, close } = await openToday({ name: "Kamile", colorScheme });
    try {
      await page.click(COMING + " summary");
      if (HAS_SUGG) await page.waitForSelector(PROS + " .td-sugg");
      await settled(page);
      await page.evaluate(axeSrc);
      const res = await page.evaluate(async () => {
        const r = await window.axe.run({ include: [["main"]] }, { resultTypes: ["violations"] });
        return r.violations.filter((v) => v.impact === "serious" || v.impact === "critical")
          .map((v) => v.id + ": " + v.help + " -> " + v.nodes.slice(0, 3).map((n) => n.target.join(" ")).join(" | "));
      });
      assert.deepEqual(res, [], colorScheme);
      if (colorScheme === "dark") await shot(page, "today-kamile-1440-dark");
    } finally {
      await close();
    }
  }
});

// ---------- writes ----------

test("T3 (queue part): Interested on a Do now row is one request with the golden rows, then the next Do now site opens", async () => {
  const patch = goldenCase("patch-partner", "interested");
  const act = goldenCase("activity-log", "interested");
  // The golden starting row, owned by Kamile and replied yesterday, so it is in her Do now.
  await applyBefore({ [ID.interested]: Object.assign({}, patch.before[ID.interested], { owner: "Kamile", last_touch: addDays(TODAY, -1) }) });
  const { page, close } = await openToday({ name: "Kamile" });
  try {
    assert.equal(await heading(page, NOW), "Do now (" + (K.doNowCount + 1) + ")");
    await page.click('[data-td-more="now"]');
    const ks = await keys(page, NOW);
    const at = ks.indexOf(ID.interested);
    assert.ok(at >= 0, "the replied site is in Do now");
    assert.equal(await page.getAttribute(NOW + ' [data-key="' + ID.interested + '"] [data-reason]', "data-reason"), "reply");
    const next = ks[at + 1];
    await page.click(NOW + ' [data-key="' + ID.interested + '"] a[data-open]');
    await page.waitForSelector(P + '.ui-panel[data-panel="' + ID.interested + '"]');
    await profileLoaded(page);
    assert.equal(await panelQueue(page), (at + 1) + " of " + ks.length + " · Do now");
    await page.fill(P + "[data-pnote]", "Wants the media kit.");
    const n0 = await retry(() => maxEditN());
    const writes = await writesDuring(page, async () => {
      await page.click(P + '[data-outcome="interested"]');
      await toastWith(page, "Moved to Negotiating");
      await waitEdits(n0, 4);
    });
    assert.deepEqual(writes, ["POST /api/partner/" + ID.interested + "/outcome"], "one request");
    const due = addWorkingDays(TODAY, 3);
    const expected = patch.edits.map((e) => (e.field === "next_due" ? Object.assign({}, e, { new: due }) : e)).concat(act.edits);
    assertGolden(expected, await waitEdits(n0, 4), { message: "golden PATCH rows (next_due +3 working days), then the activity row" });
    await page.waitForSelector(P + '.ui-panel[data-panel="' + next + '"]');
    assert.equal(await panelQueue(page), (at + 2) + " of " + ks.length + " · Do now", "auto-advance to the next Do now site");
    await page.keyboard.press("Escape");
    await page.waitForSelector(P + ".ui-panel", { state: "detached" });
    await page.waitForFunction(([sel, id]) => !document.querySelector(sel + ' [data-key="' + id + '"]'), [NOW, ID.interested]);
    assert.equal(await heading(page, NOW), "Do now (" + K.doNowCount + ")", "the site left Do now");
    assert.equal((await page.textContent('.sh-side [data-badge="today"]')).trim(), String(K.doNowCount));
  } finally {
    await close();
    await restore([ID.interested]);
  }
});

test("Mark N as handled: a confirm with a date, then one bulk request; the replies leave Do now", async () => {
  const { page, close } = await openToday({ name: "Kamile" });
  const ids = K.doNow.reply;
  try {
    await page.click('[data-td-filter="replies"]');
    await page.click("[data-td-handled]");
    await page.waitForSelector("dialog.ui-modal[open]");
    assert.equal((await page.textContent("dialog.ui-modal[open] .ui-modal-title")).trim(), "Mark " + ids.length + " replies as handled?");
    const input = 'dialog.ui-modal[open] input[name="due"]';
    assert.equal(await page.inputValue(input), addDays(TODAY, 14), "default: in 2 weeks");
    await shot(page, "today-handled-confirm");
    await page.fill(input, TODAY);
    await page.click('dialog.ui-modal[open] button:has-text("Mark ' + ids.length + ' as handled")');
    assert.equal((await page.textContent("#td-mh-err")).trim(), "Pick a date after today.");
    const pick = addDays(TODAY, 10);
    await page.fill(input, pick);
    const writes = await writesDuring(page, async () => {
      await page.click('dialog.ui-modal[open] button:has-text("Mark ' + ids.length + ' as handled")');
      await toastWith(page, "Updated " + ids.length);
    });
    assert.deepEqual(writes, ["POST /api/bulk"], "one bulk request");
    const rows = await waitFor(async () => {
      const r = await readRows(ids);
      return ids.every((id) => r[id].next_due === pick) ? r : null;
    }, "next_due on the replies");
    for (const id of ids) {
      const was = original[id] && original[id].next_step;
      assert.equal(rows[id].next_step, was ? was : "Check in", id + ": next step only where empty");
    }
    // The chip empties, so the list falls back to All, without the replies.
    await page.waitForFunction(() => !document.querySelector('[data-td-filter="replies"]'));
    assert.equal(await heading(page, NOW), "Do now (" + (K.doNowCount - ids.length) + ")");
    for (const id of ids) assert.equal(await page.$(NOW + ' [data-key="' + id + '"]'), null);
  } finally {
    await close();
    await restore(ids);
  }
});

test("New prospects: Add contact in the row, the duplicate answer, Copy email, Sent first email", async () => {
  const { page, close } = await openToday({ name: "Kamile", contextOptions: { permissions: ["clipboard-read", "clipboard-write"] } });
  const id = ID.newOne;
  const row = PROS + ' [data-key="' + id + '"]';
  try {
    await page.route("**/api/partner/" + id + "/contacts", async (route) => {
      const body = route.request().postDataJSON() || {};
      if (body.email === "dupe@today.example.test" && !body.force) {
        return route.fulfill({ status: 409, contentType: "application/json",
          body: JSON.stringify({ error: "This email is already in the CRM", duplicate: { id: "NEWC-9999", account_id: K.doNow.overdue[0], owner: "Kamile", name: null, domain: null } }) });
      }
      return route.continue();
    });
    console.log("# mocked: POST /api/partner/" + id + "/contacts answers 409 for dupe@today.example.test");
    await page.click(row + ' [data-td-act="add"]');
    await page.waitForSelector(row + " form.td-add");
    assert.equal(await page.evaluate(() => document.activeElement && document.activeElement.name), "email", "focus in Email");
    // Bad email: an inline error, nothing sent.
    await page.fill(row + ' input[name="email"]', "not-an-email");
    const none = await writesDuring(page, async () => {
      await page.press(row + ' input[name="email"]', "Enter");
      await page.waitForSelector(row + " .ui-error:not([hidden])");
    });
    assert.deepEqual(none, []);
    assert.equal((await page.textContent(row + " .ui-error")).trim(), "That email address doesn't look right.");
    // The duplicate answer: where it is, with Open that site and Add anyway.
    await page.fill(row + ' input[name="email"]', "dupe@today.example.test");
    await page.click(row + ' button[type="submit"]');
    await page.waitForSelector(row + " .td-dupe");
    assert.match(await page.textContent(row + " .td-dupe"), /Already a contact at .+ \(Kamile, Active\)\./);
    await shot(page, "today-add-contact-dupe");
    await page.click(row + ' [data-td-act="cancel"]');
    await page.waitForSelector(row + " form.td-add", { state: "detached" });

    // Add for real.
    const email = "pat.lee@new-0001.example.test";
    await page.click(row + ' [data-td-act="add"]');
    await page.fill(row + ' input[name="email"]', email);
    await page.fill(row + ' input[name="name"]', "Pat Lee");
    const writes = await writesDuring(page, async () => {
      await page.click(row + ' button[type="submit"]');
      await toastWith(page, "Contact added.");
    });
    assert.deepEqual(writes, ["POST /api/partner/" + id + "/contacts"]);
    const c = await retry(() => d1("SELECT first_name, last_name, email, client FROM contacts WHERE account_id = " + q(id) + " AND email = " + q(email)));
    assert.equal(c.length, 1);
    assert.deepEqual([c[0].first_name, c[0].last_name, c[0].email], ["Pat", "Lee", email]);
    assert.ok(c[0].client, "the contact gets the site's first client");
    await page.waitForSelector(row + ' [data-td-act="copy"]');
    assert.match(await page.textContent(row + " .td-l2"), /1 contact/);
    // Copy email, then Sent first email (the site leaves New prospects).
    await page.click(row + ' [data-td-act="copy"]');
    await toastWith(page, "Copied " + email);
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), email);
    const w2 = await writesDuring(page, async () => {
      await page.click(row + ' [data-td-act="emailed"]');
      await toastWith(page, "Moved to Contacted");
    });
    assert.deepEqual(w2, ["POST /api/partner/" + id + "/outcome"]);
    await page.waitForSelector(row, { state: "detached" });
    assert.equal((await readRow(id)).stage, "Contacted");
  } finally {
    await close();
    await restore([id]);
  }
});

test("New prospects: Add as contact from a suggestion fills the form; saving marks the suggestion used", { skip: !HAS_SUGG && "no suggestions table (migration 004 not applied)" }, async () => {
  const { page, close } = await openToday({ name: "Kamile" });
  const id = ID.sugg;
  const row = PROS + ' [data-key="' + id + '"]';
  try {
    await page.waitForSelector(row + ' [data-td-act="sugg-add"]');
    await page.click(row + ' [data-td-act="sugg-add"]');
    await page.waitForSelector(row + " form.td-add");
    assert.equal(await page.inputValue(row + ' input[name="name"]'), "Lina Brooks");
    assert.equal(await page.inputValue(row + ' input[name="email"]'), "");
    assert.match(await page.textContent(row + " .td-add-note"), /From the suggestion/);
    await shot(page, "today-suggestion-form");
    const writes = await writesDuring(page, async () => {
      await page.click(row + ' button[type="submit"]');
      await toastWith(page, "Contact added.");
    });
    assert.deepEqual(writes, ["POST /api/partner/" + id + "/contacts", "POST /api/suggestions/" + encodeURIComponent(suggOpen[0])]);
    const c = await retry(() => d1("SELECT first_name, last_name, title, linkedin FROM contacts WHERE account_id = " + q(id) + " AND first_name = 'Lina'"));
    assert.deepEqual({ ...c[0] }, { first_name: "Lina", last_name: "Brooks", title: "Partnerships lead", linkedin: "https://linkedin.example.test/in/lina-brooks" });
    const s = await retry(() => d1("SELECT status FROM suggestions WHERE id = " + q(suggOpen[0])));
    assert.equal(s[0].status, "used");
    // The row now counts the contact and drops the used suggestion.
    await page.waitForFunction((sel) => !document.querySelector(sel + " .td-sugg"), row);
    assert.match(await page.textContent(row + " .td-l2"), /1 contact/);
  } finally {
    await close();
    await restore([id]);
    await retry(() => d1("UPDATE suggestions SET status = 'open' WHERE id IN " + inList(suggOpen)));
  }
});
