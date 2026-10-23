// Record panel (spec 4.2, 5.4; tests T3, T4, T6, T14, T15, T16, T17, T32, T33). Owner F1.
// Run: bash tests/e2e/run.sh tests/e2e/20-record.test.mjs   (screenshots: SHOTS_DIR, default /tmp/shots-f1)
//
// Mocks (each test logs what it mocked):
//   - GET /api/partner/PG-00592 (T33): the real profile plus three synthetic suggestions (ids 990001-990003),
//     and POST /api/suggestions/9900nn answered {ok: true}. The suggestion rows are synthetic, so these two
//     stay mocked after B1 ships the table and the endpoint.
//   - T16 delays one PATCH by 2.5 s and one profile GET by 2 s; T17 answers one save with a 401.
// Everything else is the real fixture server. The tests write to contract rows (PG-00577..PG-00596) and to
// the Lost site with terms (T32), and put them back at the end; the contacts they add are deleted.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  baseUrl, signedInPage, closeBrowser, d1, applyBefore, maxEditN, editsAfter, stripEdit, goldenCase, assertGolden,
  fixture, PASSWORD,
} from "./lib.mjs";

const BASE = baseUrl();
const SHOTS = process.env.SHOTS_DIR || "/tmp/shots-f1";
const fx = fixture();
const TODAY = fx.today || process.env.FIXTURE_TODAY;
const COLS = ["stage", "owner", "clients", "type", "next_step", "next_due", "deal_model", "deal_flat", "deal_pct", "deal_value",
  "content_url", "live_date", "tracking_id", "last_touch", "contacts"];
const P = "#layer-panel ";

const one = (tag) => {
  const ids = fx.groups[tag];
  assert.ok(ids && ids.length, "fixture group " + tag);
  return ids[0];
};
const ID = {
  interested: one("c-interested"),
  deal: one("c-deal"),
  lost: one("c-lost"),
  note: one("c-note"),
  contact: one("c-contact"),
  contact2: one("c-contact-2"),
  spare1: one("c-spare-1"),
  spare2: one("c-spare-2"),
  spare3: one("c-spare-3"),
  spare4: one("c-spare-4"),
  neg: one("K-neg-decision"),
  lostTerms: one("lost-with-terms"),
};
const TOUCHED = [ID.interested, ID.deal, ID.lost, ID.note, ID.contact, ID.contact2, ID.spare1, ID.spare2, ID.spare3, ID.spare4, ID.lostTerms];
const SUGG = { candidate: 990001, email: 990002, slack: 990003 };

let original = {};
let session = null;
let jonas = null;
const addedContacts = [];

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
const lastEdit = () => retry(() => maxEditN());

async function readRows(ids) {
  const obj = "json_object('id', id, " + COLS.map((c) => "'" + c + "', " + c).join(", ") + ")";
  const rows = await retry(() => d1("SELECT " + obj + " AS j FROM partners WHERE id IN (" + ids.map((i) => "'" + i + "'").join(",") + ")", { rawNulls: true }));
  const out = {};
  for (const r of rows) {
    const o = JSON.parse(r.j);
    out[o.id] = {};
    for (const c of COLS) out[o.id][c] = o[c];
  }
  return out;
}
const readRow = async (id) => (await readRows([id]))[id];

// Polls the edits table until `count` new rows exist after n0.
async function waitEdits(n0, count, { ms = 15000 } = {}) {
  const end = Date.now() + ms;
  let rows = [];
  while (Date.now() < end) {
    rows = await retry(() => editsAfter(n0));
    if (rows.length >= count) return rows.map(stripEdit);
    await new Promise((r) => setTimeout(r, 300));
  }
  assert.fail("expected " + count + " new edits rows after n=" + n0 + ", got " + rows.length + ": " + JSON.stringify(rows.map(stripEdit), null, 1));
}

const upd = (account_id, field, old, nw, by = "Kamile") => ({ by_whom: by, kind: "update", account_id, contact_id: null, field, old, new: nw, applied: 0 });

// Finite animations (panel slide-in, toast fade-in) have ended; endless ones (skeleton pulse) are ignored.
function settled(page) {
  return page.waitForFunction(() => document.getAnimations().every((a) =>
    a.playState !== "running" || (a.effect && a.effect.getComputedTiming().iterations === Infinity)));
}

async function shot(page, name) {
  await settled(page);
  return page.screenshot({ path: path.join(SHOTS, name + ".png") });
}

async function toastWith(page, text) {
  const t = page.locator("#toasts .ui-toast", { hasText: text }).last();
  await t.waitFor({ state: "visible", timeout: 10000 });
  return t;
}

async function waitStore(page, id, fn, ms = 10000) {
  await page.waitForFunction(([id, src]) => {
    const r = window.__rc.store.get(id);
    return !!r && new Function("r", "return (" + src + ")(r)")(r);
  }, [id, fn.toString()], { timeout: ms });
}

// The app's own module instances, for opening the panel the way pages do.
async function setup(page) {
  await page.waitForSelector("main h1");
  await page.evaluate(async () => {
    if (window.__rc) return;
    const [store, router, record, toast, menu, list] = await Promise.all([
      import("/js/core/store.js"), import("/js/core/router.js"), import("/js/features/record/index.js"),
      import("/js/ui/toast.js"), import("/js/ui/menu.js"), import("/js/ui/list.js"),
    ]);
    await store.whenLoaded();
    window.__rc = { store, router, record, toast, menu, list };
  });
}

async function openApp(page, hash = "#help") {
  await page.goto(BASE + "/" + hash);
  await setup(page);
}

function profileLoaded(page) {
  return page.waitForFunction(() => !document.querySelector("#layer-panel .ui-skeleton"), null, { timeout: 15000 });
}

// Opens a site through openRecord (queue: {ids, index, label}) and waits for its profile.
async function openSite(page, id, queue) {
  await page.evaluate(([id, queue]) => window.__rc.record.openRecord(id, queue ? { queue } : {}), [id, queue || null]);
  await page.waitForSelector(P + '.ui-panel[data-panel="' + id + '"]');
  await profileLoaded(page);
}

async function reset(page) {
  await page.evaluate(async () => {
    const rc = window.__rc;
    if (!rc) return;
    rc.menu.closeAll();
    for (const d of Array.from(document.querySelectorAll("dialog[open]"))) d.close();
    await rc.record.closeRecord({ force: true });
    rc.toast.clearToasts();
  });
  await page.waitForSelector("#layer-panel .ui-panel", { state: "detached" });
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

const rect = (page, sel) => page.evaluate((sel) => {
  const e = document.querySelector(sel);
  if (!e) return null;
  const r = e.getBoundingClientRect();
  return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, width: r.width, height: r.height };
}, sel);

const count = async (sql) => Number((await retry(() => d1(sql)))[0].c);

// ---------- setup / teardown ----------

before(async () => {
  assert.ok(BASE, "BASE_URL is set (run through tests/e2e/run.sh)");
  assert.ok(!/:8788\b/.test(BASE), "never the main dev server");
  fs.mkdirSync(SHOTS, { recursive: true });
  original = await readRows(TOUCHED);
  // Known starting states (the store reads them when the page loads).
  await applyBefore(goldenCase("patch-partner", "interested").before);
  await applyBefore(goldenCase("patch-partner", "lost-clears-next").before);
  await applyBefore(goldenCase("patch-partner", "deal-terms").before);
  await applyBefore({
    [ID.spare1]: { stage: "Contacted", owner: "Kamile", clients: "Soro", type: "Review", next_step: null, next_due: null },
    [ID.spare2]: { stage: "Replied", owner: "Kamile", clients: "Soro", type: "Review", next_step: "Answer their reply", next_due: null },
    [ID.spare3]: { stage: "Replied", owner: "Kamile", clients: "Soro", type: "Review", next_step: null, next_due: null },
    [ID.spare4]: { stage: "Contacted", owner: "Kamile", clients: "Soro", type: "Review", next_step: null, next_due: null },
  });
  session = await signedInPage({ name: "Kamile", contextOptions: { permissions: ["clipboard-read", "clipboard-write"] } });
  await openApp(session.page);
});

beforeEach(async () => {
  if (session && session.page) await reset(session.page);
});

after(async () => {
  try {
    if (addedContacts.length) {
      await retry(() => d1("DELETE FROM contacts WHERE id IN (" + addedContacts.map((c) => "'" + c + "'").join(",") + ")"));
    }
    if (Object.keys(original).length) await applyBefore(original);
  } finally {
    if (session) await session.close();
    if (jonas) await jonas.close();
    await closeBrowser();
  }
});

// ---------- the panel at 1440 x 900 ----------

test("the panel at 1440×900: header, display-only stage path, log box, next step, contacts and 5 timeline items without scrolling", async () => {
  const { page } = session;
  await page.goto(BASE + "/#help?rec=" + ID.neg);
  await setup(page);
  await page.waitForSelector(P + '.ui-panel[data-panel="' + ID.neg + '"]');
  await profileLoaded(page);
  const r = await page.evaluate((id) => window.__rc.store.get(id), ID.neg);
  assert.equal((await page.textContent(P + "#rp-title")).trim(), r.label || r.domain || r.id);
  assert.match(await page.textContent(P + "[data-psub]"), new RegExp(ID.neg));
  // Line 2: the path is display-only; the Stage ▾ pill edits.
  assert.equal(await page.textContent(P + '.ui-panel-meta .ui-path [aria-current="step"]'), r.stage);
  assert.equal(await page.locator(P + ".ui-panel-meta .ui-path button, " + P + ".ui-panel-meta .ui-path a").count(), 0, "the path has no controls");
  await page.waitForSelector(P + '.ui-panel-meta [data-edit="stage"]');
  await page.waitForSelector(P + '.ui-panel-meta [data-edit="owner"]');
  // Log what happened: the Negotiating outcomes, 7 follow-up chips, Save note / Save follow-up.
  assert.equal((await page.textContent(P + "#rc-log-h")).trim(), "Log what happened");
  for (const o of ["approve", "counter", "ask_client", "not_interested"]) await page.waitForSelector(P + '[data-outcome="' + o + '"]');
  assert.equal(await page.locator(P + "[data-pchip]").count(), 7);
  assert.equal(await page.getAttribute(P + '[data-pchip="auto"]', "aria-pressed"), "true");
  await page.waitForSelector(P + '[data-psave="note"][disabled]');
  await page.waitForSelector(P + '[data-psave="follow"][disabled]');
  assert.match(await page.textContent(P + ".rc-nextline"), /^Next:/);
  // Contacts and the timeline from the profile.
  assert.match(await page.textContent(P + "#rc-ct-h"), /Contacts\s*\(\d+\)/);
  assert.ok(await page.locator(P + ".rc-ct").count() >= 1, "contacts listed");
  assert.ok(await page.locator(P + ".rc-ti").count() >= 5, "at least 5 timeline items");
  // Deal terms show for Negotiating; Details start collapsed.
  assert.equal(await page.locator(P + '[data-psec="deal"]').isVisible(), true);
  assert.equal(await page.locator(P + ".rc-details").getAttribute("open"), null);
  // Above the fold.
  const vh = 900;
  for (const sel of [".rc-log", ".rc-nextcard"]) {
    const b = await rect(page, P + sel);
    assert.ok(b && b.bottom <= vh, sel + " ends above the fold (" + JSON.stringify(b) + ")");
  }
  const ct = await rect(page, P + ".rc-ct");
  assert.ok(ct && ct.bottom <= vh, "the first contact is above the fold");
  const items = await page.evaluate(() => Array.from(document.querySelectorAll("#layer-panel .rc-ti")).slice(0, 5).map((e) => e.getBoundingClientRect().bottom));
  assert.ok(items.every((b) => b <= vh), "the first 5 timeline items are above the fold: " + items.join(", "));
  assert.equal(await page.evaluate(() => document.querySelector("#layer-panel [data-pbody]").scrollTop), 0);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, "no horizontal scroll");
  assert.equal(await page.locator(P + ".rc-foot").isVisible(), false, "no phone footer on desktop");
  await shot(page, "panel-1440-kamile");
});

// ---------- T3, T4: an outcome from queue mode, then Undo ----------

test("T3/T4: Interested in queue mode is one request with the golden rows and moves on; Undo restores the fields and the note stays", async () => {
  const { page } = session;
  const patch = goldenCase("patch-partner", "interested");
  const act = goldenCase("activity-log", "interested");
  await openSite(page, ID.interested, { ids: [ID.interested, ID.note], index: 0, label: "Test queue" });
  assert.equal(await page.textContent(P + ".ui-queue-text"), "1 of 2 · Test queue");
  await page.fill(P + "[data-pnote]", "Wants the media kit.");
  const due = addWorkingDays(TODAY, 3);
  const acts0 = await count("SELECT COUNT(*) AS c FROM activity WHERE account_id = '" + ID.interested + "'");
  const n0 = await lastEdit();
  let t = null;
  const writes = await writesDuring(page, async () => {
    await page.click(P + '[data-outcome="interested"]');
    t = await toastWith(page, "Moved to Negotiating");
    await waitEdits(n0, 4);
  });
  assert.deepEqual(writes, ["POST /api/partner/" + ID.interested + "/outcome"], "one request");
  const rows = await waitEdits(n0, 4);
  const expected = patch.edits.map((e) => (e.field === "next_due" ? Object.assign({}, e, { new: due }) : e)).concat(act.edits);
  assertGolden(expected, rows, { message: "Interested = golden PATCH rows (next_due +3 working days), then the activity row" });
  assert.match(await t.textContent(), /follow-up/);
  // Always-advance: the next site of the queue.
  await page.waitForSelector(P + '.ui-panel[data-panel="' + ID.note + '"]');
  assert.equal(await page.textContent(P + ".ui-queue-text"), "2 of 2 · Test queue");
  assert.equal(await page.inputValue(P + "[data-pnote]"), "", "the next site starts with an empty note");
  const row = await readRow(ID.interested);
  assert.equal(row.stage, "Negotiating");
  assert.equal(row.next_due, due);
  await waitStore(page, ID.interested, (r) => r.stage === "Negotiating");
  await shot(page, "queue-advanced-1440");

  // T4: Undo writes `update` rows back; the activity row stays; the panel stays where it is.
  const n1 = await lastEdit();
  await t.locator('[data-t="undo"]').click();
  await toastWith(page, "Stage restored. The note stays in the history.");
  const back = await waitEdits(n1, 3);
  assert.deepEqual(back, [
    upd(ID.interested, "stage", "Negotiating", "Replied"),
    upd(ID.interested, "next_step", "Agree terms", "Answer their reply"),
    upd(ID.interested, "next_due", due, null),
  ]);
  assert.equal(await count("SELECT COUNT(*) AS c FROM activity WHERE account_id = '" + ID.interested + "'"), acts0 + 1, "the activity row remains");
  await waitStore(page, ID.interested, (r) => r.stage === "Replied");
  assert.equal(await page.getAttribute(P + ".ui-panel", "data-panel"), ID.note, "Undo does not move the panel");
});

// ---------- T6: Lost asks for a reason ----------

test("T6: Not interested asks for a reason, then one request sets Lost and clears the next step", async () => {
  const { page } = session;
  const golden = goldenCase("patch-partner", "lost-clears-next");
  await openSite(page, ID.lost);
  const n0 = await lastEdit();
  await page.click(P + '[data-outcome="not_interested"]');
  await page.waitForSelector(".ui-pop form");
  const none = await writesDuring(page, async () => {
    await page.click('.ui-pop button[type="submit"]');
    await page.waitForSelector(".ui-pop .ui-error:not([hidden])");
  });
  assert.deepEqual(none, [], "no request without a reason");
  assert.equal(await lastEdit(), n0);
  await shot(page, "lost-reason-1440");
  const writes = await writesDuring(page, async () => {
    await page.locator('.ui-pop input[name="reason"]').first().check();
    await page.click('.ui-pop button[type="submit"]');
    await waitEdits(n0, 4);
  });
  assert.deepEqual(writes, ["POST /api/partner/" + ID.lost + "/outcome"], "one request");
  const rows = await waitEdits(n0, 4);
  assertGolden(golden.edits, rows.slice(0, 3), { message: "Lost = golden lost-clears-next rows" });
  assert.equal(rows[3].kind, "activity");
  assert.match(JSON.parse(rows[3].new).summary, /^Not interested/);
  await page.waitForSelector(P + '.ui-panel-meta [data-edit="stage"]:has-text("Lost")');
  await page.waitForSelector(P + '.rc-nextline:has-text("Nothing planned")');
  const row = await readRow(ID.lost);
  assert.deepEqual([row.stage, row.next_step, row.next_due], ["Lost", null, null]);
});

// ---------- T14: keyboard, Back, reload ----------

test("T14: Enter on a row link opens and stays, Tab stays inside, Esc returns focus, Back closes, a reload reopens without the queue", async () => {
  const { page } = session;
  const ids = [ID.spare1, ID.spare2, ID.spare3];
  await page.evaluate((ids) => {
    const { list, store, record } = window.__rc;
    const old = document.getElementById("rc-list");
    if (old) old.remove();
    const host = document.createElement("section");
    host.id = "rc-list";
    host.setAttribute("aria-label", "Test rows");
    document.querySelector("main").appendChild(host);
    list.createList(host, {
      id: "rc-list", label: "Test rows", rows: () => store.all().filter((r) => ids.includes(r.id)),
      columns: ["site", "stage", "owner", "next"], openRecord: record.openRecord, sort: "site", queueLabel: "Test queue",
    });
  }, ids);
  const link = page.locator('#rc-list a[data-open="' + ID.spare1 + '"]');
  await link.focus();
  await page.keyboard.press("Enter");
  await page.waitForSelector(P + '.ui-panel[data-panel="' + ID.spare1 + '"]');
  await page.waitForTimeout(700);
  assert.equal(await page.locator(P + ".ui-panel").count(), 1, "the panel stays open");
  assert.equal(await page.evaluate(() => document.activeElement && document.activeElement.id), "rp-title");
  assert.equal(await page.evaluate(() => document.querySelector(".sh-main").inert), true);
  assert.equal(await page.textContent(P + ".ui-queue-text"), "1 of 3 · Test queue");
  await profileLoaded(page);
  // Tab cycles inside the panel.
  for (let i = 0; i < 45; i++) {
    await page.keyboard.press(i % 7 === 6 ? "Shift+Tab" : "Tab");
    const inside = await page.evaluate(() => !!document.activeElement && !!document.activeElement.closest("#layer-panel"));
    assert.equal(inside, true, "focus stays in the panel (Tab " + (i + 1) + ")");
  }
  // J / K move through the queue; Esc closes and focus returns to the row link.
  await page.focus(P + "#rp-title");
  await page.keyboard.press("j");
  await page.waitForSelector(P + '.ui-panel[data-panel="' + ID.spare2 + '"]');
  await page.keyboard.press("k");
  await page.waitForSelector(P + '.ui-panel[data-panel="' + ID.spare1 + '"]');
  await page.keyboard.press("Escape");
  await page.waitForSelector(P + ".ui-panel", { state: "detached" });
  assert.equal(await page.evaluate(() => document.activeElement && document.activeElement.getAttribute("data-open")), ID.spare1, "focus returns to the row link");
  // Back closes.
  await page.keyboard.press("Enter");
  await page.waitForSelector(P + '.ui-panel[data-panel="' + ID.spare1 + '"]');
  await page.goBack();
  await page.waitForSelector(P + ".ui-panel", { state: "detached" });
  assert.doesNotMatch(page.url(), /rec=/);
  // A reload with rec reopens the site, without the queue.
  await page.goForward();
  await page.waitForSelector(P + '.ui-panel[data-panel="' + ID.spare1 + '"]');
  await page.reload();
  await page.waitForSelector(P + '.ui-panel[data-panel="' + ID.spare1 + '"]');
  assert.equal(await page.locator(P + "[data-pqueue]").isVisible(), false, "no queue after a reload");
  await setup(page);
});

// ---------- T15: unsaved guard ----------

test("T15: with a typed note, Back, a link, queue › and Esc ask \"Discard your note?\"; Keep editing keeps the text and the URL", async () => {
  const { page } = session;
  await openSite(page, ID.spare1, { ids: [ID.spare1, ID.spare2], index: 0, label: "Test queue" });
  await page.fill(P + "[data-pnote]", "Half-written note");
  assert.equal(await page.evaluate(() => window.__rc.record.isDirty()), true);
  const keep = async (what) => {
    await page.waitForSelector('dialog.ui-modal[open] .ui-modal-title:text-is("Discard your note?")');
    await page.click('dialog.ui-modal[open] button:has-text("Keep editing")');
    await page.waitForSelector("dialog.ui-modal[open]", { state: "detached" });
    assert.equal(await page.getAttribute(P + ".ui-panel", "data-panel"), ID.spare1, what + ": still on the site");
    assert.equal(await page.inputValue(P + "[data-pnote]"), "Half-written note", what + ": the note is kept");
    await page.waitForFunction((id) => new RegExp("[?&]rec=" + id + "(&|$)").test(location.hash), ID.spare1);
  };
  // Back (the panel was opened with a new history entry).
  await page.goBack();
  await keep("Back");
  // A link elsewhere (the hash a nav link sets).
  await page.evaluate(() => { location.hash = "#today"; });
  await keep("link");
  // Queue ›.
  await page.click(P + '[data-pq="1"]');
  await keep("queue ›");
  // Esc, then Discard closes.
  await page.focus(P + "[data-pnote]");
  await page.keyboard.press("Escape");
  await page.waitForSelector('dialog.ui-modal[open] .ui-modal-title:text-is("Discard your note?")');
  await shot(page, "discard-note-1440");
  await page.click('dialog.ui-modal[open] button:has-text("Discard")');
  await page.waitForSelector(P + ".ui-panel", { state: "detached" });
  assert.doesNotMatch(page.url(), /rec=/);
});

// ---------- T16: a slow save, then another site ----------

test("T16: a save that lands after moving on updates the store, not the other site's panel, and shows no toast there", async () => {
  const { page } = session;
  const A = ID.spare3;
  const B = ID.spare4;
  let delayed = 0;
  const slow = async (route) => {
    if (route.request().method() !== "PATCH") return route.continue();
    delayed++;
    await new Promise((r) => setTimeout(r, 2500));
    return route.continue();
  };
  const panelText = () => page.evaluate(() => ({
    title: document.querySelector("#layer-panel #rp-title").textContent,
    next: document.querySelector("#layer-panel .rc-nextline").textContent,
    meta: document.querySelector("#layer-panel .ui-panel-meta").textContent,
  }));
  await page.route("**/api/partner/" + A, slow);
  try {
    await openSite(page, A, { ids: [A, B], index: 0, label: "Test queue" });
    await page.click(P + '[data-pchip="tomorrow"]');
    const n0 = await lastEdit();
    await page.click(P + '[data-psave="follow"]');
    await page.click(P + '[data-pq="1"]');
    await page.waitForSelector(P + '.ui-panel[data-panel="' + B + '"]');
    await profileLoaded(page);
    const bBefore = await panelText();
    const rows = await waitEdits(n0, 2);
    assert.deepEqual(rows, [upd(A, "next_step", null, "Follow up"), upd(A, "next_due", null, addWorkingDays(TODAY, 1))]);
    await waitStore(page, A, (r) => r.next_due != null);
    await page.waitForTimeout(400);
    assert.equal(delayed, 1, "the PATCH was delayed");
    console.log("# mocked: PATCH /api/partner/" + A + " delayed 2.5 s (T16)");
    assert.equal(await page.getAttribute(P + ".ui-panel", "data-panel"), B);
    assert.deepEqual(await panelText(), bBefore, "B's panel is unchanged");
    assert.equal(await page.locator(P + "[data-perr]").isVisible(), false);
    const toasts = await page.locator("#toasts .ui-toast").allTextContents();
    assert.equal(toasts.filter((t) => /follow-up/i.test(t)).length, 0, "no toast on B: " + JSON.stringify(toasts));
  } finally {
    await page.unroute("**/api/partner/" + A, slow);
  }

  // A late profile answer never fills another site's panel.
  const slowGet = async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    await new Promise((r) => setTimeout(r, 2000));
    return route.continue();
  };
  await page.route("**/api/partner/" + ID.neg, slowGet);
  try {
    await reset(page);
    await page.evaluate(([a, b]) => window.__rc.record.openRecord(a, { queue: { ids: [a, b], index: 0, label: "Test queue" } }), [ID.neg, ID.lostTerms]);
    await page.waitForSelector(P + '.ui-panel[data-panel="' + ID.neg + '"]');
    await page.click(P + '[data-pq="1"]');
    await page.waitForSelector(P + '.ui-panel[data-panel="' + ID.lostTerms + '"]');
    await profileLoaded(page);
    const before2 = await page.textContent(P + '[data-psec="contacts"]');
    await page.waitForTimeout(2600);
    assert.equal(await page.textContent(P + '[data-psec="contacts"]'), before2, "the late profile of the first site stays out");
    console.log("# mocked: GET /api/partner/" + ID.neg + " delayed 2 s (T16)");
  } finally {
    await page.unroute("**/api/partner/" + ID.neg, slowGet);
  }
});

// ---------- T17: 401 on save ----------

test("T17: a 401 on save goes to sign-in with the hash kept; the note is back after signing in", async () => {
  const { page } = session;
  await openSite(page, ID.spare2);
  await page.fill(P + "[data-pnote]", "Call notes to keep");
  let hits = 0;
  const deny = async (route) => {
    if (route.request().method() === "GET") return route.continue();
    hits++;
    return route.fulfill({ status: 401, json: { error: "Sign in again" } });
  };
  await page.route("**/api/partner/" + ID.spare2 + "/**", deny);
  try {
    await Promise.all([
      page.waitForURL((u) => new URL(u).pathname === "/login", { timeout: 15000 }),
      page.click(P + '[data-psave="note"]'),
    ]);
  } finally {
    await page.unroute("**/api/partner/" + ID.spare2 + "/**", deny);
  }
  assert.equal(hits, 1);
  console.log("# mocked: a 401 on the note save of " + ID.spare2 + " (T17)");
  const next = new URL(page.url()).searchParams.get("next") || "";
  assert.match(decodeURIComponent(next), new RegExp("rec=" + ID.spare2), "the hash rides along");
  await page.fill('input[name="password"]', PASSWORD);
  const who = await page.$('select[name="who"]');
  if (who) await who.selectOption({ label: "Kamile" }).catch(() => who.selectOption("Kamile"));
  await Promise.all([
    page.waitForURL((u) => new URL(u).pathname !== "/login", { timeout: 15000 }),
    page.click('button[type="submit"]'),
  ]);
  await page.waitForSelector(P + '.ui-panel[data-panel="' + ID.spare2 + '"]', { timeout: 20000 });
  assert.equal(await page.inputValue(P + "[data-pnote]"), "Call notes to keep");
  await toastWith(page, "Your unsaved note is back");
  await setup(page);
  await page.fill(P + "[data-pnote]", "");
});

// ---------- T32: deal terms and placement ----------

test("T32: a Lost site with terms shows and edits Deal terms and Placement; Show all fields opens everything", async () => {
  const { page } = session;
  const id = ID.lostTerms;
  const r0 = await readRow(id);
  assert.equal(r0.stage, "Lost");
  await openSite(page, id);
  assert.equal(await page.locator(P + '[data-psec="deal"]').isVisible(), true, "Deal terms show (a deal field has a value)");
  assert.equal(await page.locator(P + '[data-psec="place"]').isVisible(), true, "Placement shows (a link is set)");
  assert.match(await page.textContent(P + '[data-psec="deal"]'), new RegExp(String(r0.tracking_id)));
  await shot(page, "lost-terms-1440");
  // Edit the tracking ID: one PATCH, one row.
  let n0 = await lastEdit();
  await page.click(P + '[data-pdeal="edit"]');
  await page.fill('.ui-pop input[name="tracking_id"]', "EF-2002");
  await page.click('.ui-pop button[type="submit"]');
  assert.deepEqual(await waitEdits(n0, 1), [upd(id, "tracking_id", r0.tracking_id, "EF-2002")]);
  await page.waitForSelector(P + '[data-psec="deal"]:has-text("EF-2002")');
  // Edit the went-live date. The fixture's date is 60 days before the fixture day, so on 20 Oct it is already
  // 21 Aug and saving that would change nothing; pick the other day then.
  const live = r0.live_date === "2026-08-21" ? { iso: "2026-08-20", label: "Thu 20 Aug" } : { iso: "2026-08-21", label: "Fri 21 Aug" };
  n0 = await lastEdit();
  await page.click(P + '[data-pplace="edit"]');
  await page.fill('.ui-pop input[name="live_date"]', live.iso);
  await page.click('.ui-pop button[type="submit"]');
  assert.deepEqual(await waitEdits(n0, 1), [upd(id, "live_date", r0.live_date, live.iso)]);
  await page.waitForSelector(P + '[data-psec="place"]:has-text("' + live.label + '")');
  await reset(page);

  // A Replied site without terms: hidden until Show all fields; then Add terms writes the golden rows.
  const golden = goldenCase("patch-partner", "deal-terms");
  const f = golden.request.body.fields;
  await openSite(page, ID.deal);
  assert.equal(await page.locator(P + '[data-psec="deal"]').isVisible(), false);
  assert.equal(await page.locator(P + '[data-psec="place"]').isVisible(), false);
  await page.click(P + '.rc-tools [data-pact="more"]');
  await page.click('.ui-menu .ui-mi-label:text-is("Show all fields")');
  await page.waitForSelector(P + '[data-psec="deal"]:not([hidden])');
  await page.waitForSelector(P + '[data-psec="place"]:not([hidden])');
  assert.notEqual(await page.locator(P + ".rc-details").getAttribute("open"), null, "Details open");
  n0 = await lastEdit();
  const writes = await writesDuring(page, async () => {
    await page.click(P + '[data-pdeal="edit"]');
    await page.selectOption('.ui-pop select[name="deal_model"]', f.deal_model);
    await page.fill('.ui-pop input[name="deal_flat"]', f.deal_flat);
    await page.fill('.ui-pop input[name="deal_pct"]', f.deal_pct);
    await page.fill('.ui-pop input[name="deal_value"]', f.deal_value);
    await page.fill('.ui-pop input[name="tracking_id"]', f.tracking_id);
    await page.click('.ui-pop button:has-text("Save terms")');
    await waitEdits(n0, 5);
  });
  assert.deepEqual(writes, ["PATCH /api/partner/" + ID.deal], "one Save terms, one PATCH");
  const dealKeys = ["deal_model", "deal_flat", "deal_pct", "deal_value", "tracking_id"];
  assertGolden(golden.edits.filter((e) => dealKeys.includes(e.field)), await waitEdits(n0, 5), { message: "deal terms = golden rows" });
  await page.waitForSelector(P + '[data-psec="deal"]:has-text("Flat fee + commission")');
  assert.match(await page.textContent(P + ".rc-terms"), /\$1,200 \+ 12\.5%/);
  n0 = await lastEdit();
  await page.click(P + '[data-pplace="edit"]');
  await page.fill('.ui-pop input[name="content_url"]', f.content_url);
  await page.fill('.ui-pop input[name="live_date"]', f.live_date);
  await page.click('.ui-pop button[type="submit"]');
  assertGolden(golden.edits.filter((e) => e.field === "content_url" || e.field === "live_date"), await waitEdits(n0, 2), { message: "placement = golden rows" });
  await page.waitForSelector(P + '[data-psec="place"]:has-text("Goes live")');
  await shot(page, "show-all-fields-1440");
  // Show fewer fields: the deal now has values, so it stays; Details close.
  await page.click(P + '.rc-tools [data-pact="more"]');
  await page.click('.ui-menu .ui-mi-label:text-is("Show fewer fields")');
  await page.waitForFunction(() => !document.querySelector("#layer-panel .rc-details").open);
  assert.equal(await page.locator(P + '[data-psec="deal"]').isVisible(), true);
});

// ---------- contacts ----------

test("contacts: Copy, Gmail, Sheet ↗, Copy email, Open in sheet; Add contact explains, shows the 409 block, and adds a name-only contact", async () => {
  const { page } = session;
  const m = await page.evaluate(() => import("/js/core/meta.js").then((mm) => mm.get()));
  await openSite(page, ID.contact);
  const c = (await retry(() => d1("SELECT id, email FROM contacts WHERE account_id = '" + ID.contact + "' ORDER BY id LIMIT 1")))[0];
  assert.ok(c && c.email, "the fixture contact has an email");
  const email = String(c.email).split(/[,;]/)[0].trim();
  await page.waitForSelector(P + '.rc-ct:has-text("' + email + '")');
  // Copy.
  await page.click(P + '[data-pcopy="' + email + '"]');
  await toastWith(page, "Copied " + email);
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), email);
  // Gmail ↗ searches the address.
  const gmail = await page.getAttribute(P + '.rc-ct a[href^="https://mail.google.com/"]', "href");
  assert.equal(gmail, "https://mail.google.com/mail/u/0/#search/" + encodeURIComponent(email).replace(/%40/g, "@"));
  // Sheet ↗: the Contacts tab row (number + 1), and the id is copied.
  if (m.sheet_url) {
    const sheet = page.locator(P + '[data-psheet="' + c.id + '"]');
    assert.equal(await sheet.getAttribute("href"), m.sheet_url + "#gid=1&range=A" + (Number(c.id.replace(/^C-/, "")) + 1));
    await page.evaluate(() => document.addEventListener("click", (e) => { if (e.target.closest("[data-psheet]")) e.preventDefault(); }, { capture: true, once: true }));
    await sheet.click();
    await toastWith(page, c.id + " copied");
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), c.id);
  }
  // Copy email in the header.
  await page.click(P + '.rc-tools [data-pact="copy-email"]');
  await toastWith(page, "Copied " + email);
  // Open in sheet (⋯) opens the Accounts row and copies the id.
  await page.evaluate(() => { window.__opened = []; window.open = (u) => { window.__opened.push(u); return null; }; });
  await page.click(P + '.rc-tools [data-pact="more"]');
  if (m.sheet_url) {
    await page.click('.ui-menu .ui-mi-label:text-is("Open in sheet")');
    await toastWith(page, ID.contact + " copied");
    assert.deepEqual(await page.evaluate(() => window.__opened), [m.sheet_url + "#gid=0&range=A" + (Number(ID.contact.replace(/^PG-/, "")) + 1)]);
  } else {
    await page.keyboard.press("Escape");
  }

  // Add contact: an empty form explains; an email already in the CRM gives the 409 block.
  await page.click(P + '[data-padd="open"]');
  await page.waitForSelector(P + "[data-paddform]");
  await page.click(P + '[data-paddform] button[type="submit"]');
  await page.waitForSelector(P + "#rc-add-err:not([hidden])");
  const other = (await retry(() => d1("SELECT email, account_id FROM contacts WHERE account_id = '" + ID.neg + "' AND email IS NOT NULL ORDER BY id LIMIT 1")))[0];
  const n0 = await lastEdit();
  await page.fill(P + '[data-paddform] [name="first_name"]', "Dana");
  await page.fill(P + '[data-paddform] [name="email"]', String(other.email).split(/[,;]/)[0].trim());
  await page.click(P + '[data-paddform] button[type="submit"]');
  await page.waitForSelector(P + '[data-paddform] :text("Already a contact at")');
  await page.waitForSelector(P + '[data-popen="' + other.account_id + '"]');
  await page.waitForSelector(P + '[data-padd="force"]');
  await shot(page, "add-contact-409-1440");
  assert.equal(await lastEdit(), n0, "nothing written on a 409");
  // Unsaved add-contact text is guarded too.
  assert.equal(await page.evaluate(() => window.__rc.record.isDirty()), true);
  await page.click(P + '[data-padd="cancel"]');
  await page.waitForSelector(P + "[data-paddform]", { state: "detached" });
  assert.equal(await page.evaluate(() => window.__rc.record.isDirty()), false);

  // A name-only contact (golden add-contact#name-only, on its own site).
  const golden = goldenCase("add-contact", "name-only");
  await reset(page);
  await openSite(page, ID.contact2);
  const n1 = await lastEdit();
  await page.click(P + '[data-padd="open"]');
  await page.fill(P + '[data-paddform] [name="first_name"]', golden.request.body.first_name);
  await page.selectOption(P + '[data-paddform] select[name="client"]', "");
  await page.click(P + '[data-paddform] button[type="submit"]');
  await toastWith(page, "Contact added. Copies to the Google Sheet on the next weekday morning (08:47).");
  const rows = await waitEdits(n1, 1);
  addedContacts.push(rows[0].contact_id);
  assertGolden(golden.edits, rows, { message: "Add contact (name only) = golden" });
  await page.waitForSelector(P + '.rc-ct:has-text("' + golden.request.body.first_name + '")');
});

// ---------- T33: suggestions ----------

test("T33: suggestions: Add as contact opens the prefilled form, saves the golden row and marks it used; Dismiss writes no edits row; Copy text", async () => {
  const { page } = session;
  const id = ID.contact2;
  const golden = goldenCase("add-contact", "full");
  const g = golden.request.body;
  const posts = [];
  const profile = async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    const res = await route.fetch();
    const j = await res.json();
    j.suggestions = [
      { id: SUGG.candidate, run_date: TODAY, kind: "candidate", account_id: id, client: g.client, name: g.first_name + " " + g.last_name, title: g.title,
        linkedin: g.linkedin, source: "Apollo", to_email: null, subject: null, body: null, note: null, status: "open" },
      { id: SUGG.email, run_date: TODAY, kind: "email", account_id: id, client: "Soro", name: null, title: null, linkedin: null, source: "Daily run",
        to_email: "editor@c-contact-2.contract.example.test", subject: "A partnership idea", body: "Hi,\n\nWe would love to work with you on a review.\n\nThanks", note: null, status: "open" },
      { id: SUGG.slack, run_date: TODAY, kind: "slack_ask", account_id: id, client: null, name: null, title: null, linkedin: null, source: null,
        to_email: null, subject: null, body: null, note: "Is anyone already talking to this site?", status: "open" },
    ];
    return route.fulfill({ response: res, json: j });
  };
  const sugg = async (route) => {
    posts.push({ url: new URL(route.request().url()).pathname, body: JSON.parse(route.request().postData() || "{}") });
    return route.fulfill({ status: 200, json: { ok: true } });
  };
  await page.route("**/api/partner/" + id, profile);
  await page.route("**/api/suggestions/9900*", sugg);
  console.log("# mocked: GET /api/partner/" + id + " (+3 synthetic suggestions) and POST /api/suggestions/9900nn (T33)");
  try {
    // A fresh page: the panel keeps profiles for a minute.
    await page.evaluate(() => { location.hash = "#help"; });
    await page.reload();
    await setup(page);
    await openSite(page, id);
    await page.waitForSelector(P + '[data-psec="sugg"]:not([hidden])');
    assert.match(await page.textContent(P + "#rc-sg-h"), /Suggestions\s*\(3\)/);
    await shot(page, "suggestions-1440");
    // Copy text of the suggested email.
    await page.click(P + '[data-psugg-copy="' + SUGG.email + '"]');
    await toastWith(page, "Text copied");
    assert.match(await page.evaluate(() => navigator.clipboard.readText()), /A partnership idea[\s\S]*work with you/);
    // Dismiss: hidden, POST status dismissed, no edits row.
    let n0 = await lastEdit();
    await page.click(P + '[data-psugg-dismiss="' + SUGG.slack + '"]');
    await toastWith(page, "Suggestion dismissed.");
    await page.waitForSelector(P + '[data-psugg-dismiss="' + SUGG.slack + '"]', { state: "detached" });
    const dis = posts.pop();
    assert.deepEqual([dis.url, dis.body.status], ["/api/suggestions/" + SUGG.slack, "dismissed"]);
    assert.equal(await lastEdit(), n0, "Dismiss writes no edits row");
    // Add as contact: the form is prefilled (name, title, LinkedIn, client); the email goes in.
    await page.click(P + '[data-psugg-add="' + SUGG.candidate + '"]');
    await page.waitForSelector(P + "[data-paddform]");
    const F = P + "[data-paddform] ";
    assert.equal(await page.inputValue(F + '[name="first_name"]'), g.first_name);
    assert.equal(await page.inputValue(F + '[name="last_name"]'), g.last_name);
    assert.equal(await page.inputValue(F + '[name="title"]'), g.title);
    assert.equal(await page.inputValue(F + '[name="linkedin"]'), g.linkedin);
    assert.equal(await page.inputValue(F + 'select[name="client"]'), g.client);
    assert.equal(await page.evaluate(() => document.activeElement && document.activeElement.name), "email");
    await page.fill(F + '[name="email"]', g.email);
    n0 = await lastEdit();
    await page.click(F + 'button[type="submit"]');
    await toastWith(page, "Contact added.");
    const rows = await waitEdits(n0, 1);
    addedContacts.push(rows[0].contact_id);
    assertGolden(golden.edits, rows, { message: "Add as contact = golden add-contact#full" });
    const used = posts.find((p) => p.url === "/api/suggestions/" + SUGG.candidate);
    assert.equal(used && used.body.status, "used", "the suggestion is marked used");
    await page.waitForSelector(P + '.rc-ct:has-text("' + g.first_name + " " + g.last_name + '")');
  } finally {
    await page.unroute("**/api/partner/" + id, profile);
    await page.unroute("**/api/suggestions/9900*", sugg);
  }
});

// ---------- phone ----------

test("phone (390×844, Jonas): a full-screen sheet with a sticky footer, no sideways scroll, and a reply in one tap plus Undo", async () => {
  jonas = await signedInPage({ name: "Jonas", viewport: { width: 390, height: 844 }, contextOptions: { isMobile: true, hasTouch: true, deviceScaleFactor: 2 } });
  const { page } = jonas;
  await page.goto(BASE + "/#help?rec=" + ID.lostTerms);
  await setup(page);
  await page.waitForSelector(P + '.ui-panel[data-panel="' + ID.lostTerms + '"]');
  await profileLoaded(page);
  await settled(page);
  const panel = await rect(page, P + ".ui-panel");
  assert.deepEqual([Math.round(panel.left), Math.round(panel.top), Math.round(panel.width), Math.round(panel.height)], [0, 0, 390, 844], "full screen");
  const foot = await rect(page, P + ".rc-foot");
  assert.ok(foot && Math.round(foot.bottom) === 844 && foot.height >= 44, "the footer sits at the bottom: " + JSON.stringify(foot));
  assert.equal(await page.locator(P + '[data-pclose="x"]').isVisible(), true, "‹ is visible");
  const wide = await page.evaluate(() => ({
    doc: document.documentElement.scrollWidth,
    panel: document.querySelector("#layer-panel .ui-panel").scrollWidth,
    body: document.querySelector("#layer-panel [data-pbody]").scrollWidth,
  }));
  assert.ok(wide.doc <= 390 && wide.panel <= 390 && wide.body <= 390, "no horizontal scroll: " + JSON.stringify(wide));
  await shot(page, "phone-390-jonas-top");
  // Scrolled to the end, the footer stays put.
  await page.evaluate(() => { const b = document.querySelector("#layer-panel [data-pbody]"); b.scrollTop = b.scrollHeight; });
  await page.waitForTimeout(200);
  assert.equal(Math.round((await rect(page, P + ".rc-foot")).bottom), 844, "sticky footer");
  await shot(page, "phone-390-jonas-end");
  // The footer's Log what happened ▾ lists the outcomes.
  await page.tap(P + '[data-pfoot="log"]');
  await page.waitForSelector(".ui-menu");
  await shot(page, "phone-390-log-menu");
  await page.evaluate(() => window.__rc.menu.closeAll());
  await page.waitForSelector(".ui-menu", { state: "detached" });

  // A typical reply: one tap on Interested, then Undo.
  await page.evaluate((id) => window.__rc.record.openRecord(id), ID.interested);
  await page.waitForSelector(P + '.ui-panel[data-panel="' + ID.interested + '"]');
  await profileLoaded(page);
  const n0 = await lastEdit();
  await page.tap(P + '[data-outcome="interested"]');
  const t = await toastWith(page, "Moved to Negotiating");
  const rows = await waitEdits(n0, 4);
  assert.equal(rows[0].by_whom, "Jonas");
  assert.deepEqual(rows.slice(0, 3).map((r) => [r.field, r.new]), [["stage", "Negotiating"], ["next_step", "Agree terms"], ["next_due", addWorkingDays(TODAY, 3)]]);
  await shot(page, "phone-390-toast");
  const n1 = await lastEdit();
  await t.locator('[data-t="undo"]').tap();
  await toastWith(page, "Stage restored.");
  await waitEdits(n1, 3);
  assert.equal((await readRow(ID.interested)).stage, "Replied");
  assert.deepEqual(jonas.watch.pageErrors, [], "no page errors on the phone");
});

test("no page errors or console errors during the run", async () => {
  const { watch } = session;
  assert.deepEqual(watch.pageErrors, []);
  const unexpected = watch.consoleErrors.filter((e) => !/40[19]/.test(e.text));
  assert.deepEqual(unexpected, []);
});
