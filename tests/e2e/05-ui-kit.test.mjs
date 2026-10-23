// UI kit (spec 7.1 G1-C): createList (table/cards, sort, paging, selection, row links, column objects,
// fetchPage, CSV with formula safety), URL filters with chips, actions (update, outcome, followUp, claim,
// bulk) with toasts and Undo, the inline editors, <dialog> modals with a focus trap, and the top-layer
// rules: a menu opened inside a dialog and inside the record panel is clickable, and a toast shown while a
// dialog is open is visible. Owner G1-C.
// Run: bash tests/e2e/run.sh tests/e2e/05-ui-kit.test.mjs   (screenshots: SHOTS_DIR, default /tmp/shots-g1-c)
//
// Mocks (only while the backend lacks the endpoint; each test logs what it mocked):
//   - POST /api/partner/:id/outcome (G1-B, spec 6.3.3): when it answers the catch-all 404, page.route
//     answers it by sending the real PATCH /api/partner/:id and then the real POST .../activity, which
//     write the golden rows in the same order. Used by "Log what happened in the panel".
// POST /api/bulk is never mocked: ids mode and the rows mode Undo uses are real (B1).
// The tests write only to the contract rows (PG-00577..PG-00596) and put them back at the end.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  baseUrl, signedInPage, closeBrowser, pageFetch, d1, applyBefore, maxEditN, editsAfter, stripEdit,
  goldenCase, assertGolden, sortEdits, fixture, tools,
} from "./lib.mjs";

const BASE = baseUrl();
const SHOTS = process.env.SHOTS_DIR || "/tmp/shots-g1-c";
const fx = fixture();
const TODAY = fx.today || process.env.FIXTURE_TODAY;
const COLS = ["stage", "owner", "clients", "type", "next_step", "next_due", "deal_model", "deal_flat", "deal_pct", "deal_value",
  "content_url", "live_date", "tracking_id", "last_touch"];

const one = (tag) => {
  const ids = fx.groups[tag];
  assert.ok(ids && ids.length, "fixture group " + tag);
  return ids[0];
};
const ID = {
  interested: one("c-interested"),
  assign: one("c-assign"),
  note: one("c-note"),
  spare1: one("c-spare-1"),
  spare2: one("c-spare-2"),
  spare3: one("c-spare-3"),
  spare4: one("c-spare-4"),
  bulk: ["c-bulk-a", "c-bulk-b", "c-bulk-c", "c-bulk-d", "c-bulk-e", "c-bulk-f"].map(one),
};
const TOUCHED = [ID.interested, ID.assign, ID.note, ID.spare1, ID.spare2, ID.spare3, ID.spare4, ...ID.bulk];

let original = {};
let session = null;
const mocked = { outcome: 0, needOutcome: false };

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

async function readRows(ids) {
  const obj = "json_object('id', id, " + COLS.map((c) => "'" + c + "', " + c).join(", ") + ")";
  const rows = await d1("SELECT " + obj + " AS j FROM partners WHERE id IN (" + ids.map((i) => "'" + i + "'").join(",") + ")", { rawNulls: true });
  const out = {};
  for (const r of rows) {
    const o = JSON.parse(r.j);
    out[o.id] = {};
    for (const c of COLS) out[o.id][c] = o[c];
  }
  return out;
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

const upd = (account_id, field, old, nw) => ({ by_whom: "Kamile", kind: "update", account_id, contact_id: null, field, old, new: nw, applied: 0 });

// Finite animations (panel slide-in, toast fade-in) have ended; endless ones (skeleton pulse) are ignored.
function settled(page) {
  return page.waitForFunction(() => document.getAnimations().every((a) =>
    a.playState !== "running" || (a.effect && a.effect.getComputedTiming().iterations === Infinity)));
}

async function shot(page, name) {
  await settled(page);
  return page.screenshot({ path: path.join(SHOTS, name + ".png") });
}

// Waits for a toast with this text and returns its locator.
async function toastWith(page, text) {
  const t = page.locator("#toasts .ui-toast", { hasText: text }).last();
  await t.waitFor({ state: "visible", timeout: 10000 });
  return t;
}

// Installs the mocks (when needed) and the in-page harness: window.__uk holds the app's own module
// instances, window.__ukHost(id) makes a test host inside <main>, and every list in window.__ukLists
// refreshes on store changes (what a page's update() does).
async function setup(page) {
  if (mocked.needOutcome) {
    await page.route("**/api/partner/*/outcome", async (route) => {
      const req = route.request();
      const u = new URL(req.url());
      const id = decodeURIComponent(u.pathname.split("/")[3]);
      const body = JSON.parse(req.postData() || "{}");
      const out = { ok: true, changed: {}, partner: null, activity: null };
      if (body.fields && Object.keys(body.fields).length) {
        const r = await route.fetch({ url: u.origin + "/api/partner/" + encodeURIComponent(id), method: "PATCH", postData: JSON.stringify({ by: body.by, fields: body.fields }) });
        const j = await r.json();
        if (r.status() >= 400) return route.fulfill({ status: r.status(), json: j });
        out.changed = j.changed || {};
        out.partner = j.partner || null;
      }
      if (body.activity) {
        const r = await route.fetch({ url: u.origin + "/api/partner/" + encodeURIComponent(id) + "/activity", method: "POST", postData: JSON.stringify(Object.assign({ by: body.by }, body.activity)) });
        const j = await r.json();
        if (r.status() >= 400) return route.fulfill({ status: r.status(), json: j });
        out.activity = j.activity || null;
        if (j.last_touch) {
          out.last_touch = j.last_touch;
          if (out.partner) out.partner.last_touch = j.last_touch;
        }
      }
      mocked.outcome++;
      return route.fulfill({ status: body.activity ? 201 : 200, json: out });
    });
  }
  await page.evaluate(async () => {
    if (window.__uk) return;
    const [dom, store, router, list, filters, actions, toast, dialog, menu, record, columns, meta, me] = await Promise.all([
      import("/js/core/dom.js"), import("/js/core/store.js"), import("/js/core/router.js"), import("/js/ui/list.js"),
      import("/js/ui/filters.js"), import("/js/ui/actions.js"), import("/js/ui/toast.js"), import("/js/ui/dialog.js"),
      import("/js/ui/menu.js"), import("/js/features/record/index.js"), import("/js/ui/columns.js"), import("/js/core/meta.js"),
      import("/js/core/me.js"),
    ]);
    await store.whenLoaded();
    window.__uk = { dom, store, router, list, filters, actions, toast, dialog, menu, record, columns, meta, me };
    window.__ukLists = {};
    store.subscribe(() => { for (const l of Object.values(window.__ukLists)) l.refresh(); });
    window.__ukHost = (id, title) => {
      const old = document.getElementById(id);
      if (old) old.remove();
      const h = document.createElement("section");
      h.id = id;
      h.setAttribute("aria-label", title || id);
      h.style.marginTop = "24px";
      document.querySelector("main").appendChild(h);
      return h;
    };
  });
}

async function openApp(page, hash = "#help") {
  await page.goto(BASE + "/" + hash);
  await page.waitForSelector("main h1");
  await setup(page);
}

// The main list of these tests: Kamile's sites.
async function mountKamileList(page) {
  await page.evaluate(() => {
    const { list, store, record } = window.__uk;
    const host = window.__ukHost("uk-list", "Kamile's sites");
    window.__ukLists.main = list.createList(host, {
      id: "uikit", label: "Kamile's sites", rows: () => store.all().filter((r) => r.owner === "Kamile"),
      columns: ["site", "stage", "owner", "clients", "dr", "next", "due", "actions"],
      selectable: true, queueLabel: "Test queue", openRecord: record.openRecord, sort: "site",
    });
  });
}

// A list of the contract rows the editor tests use, with every editable column.
async function mountContractList(page, ids) {
  await page.evaluate((ids) => {
    const { list, store, record } = window.__uk;
    const host = window.__ukHost("uk-edit", "Contract rows");
    window.__ukLists.edit = list.createList(host, {
      id: "uk-edit", label: "Contract rows", rows: () => store.all().filter((r) => ids.includes(r.id)),
      columns: ["site", "stage", "owner", "clients", "type", "next", "due", "actions"], openRecord: record.openRecord, sort: "site",
    });
  }, ids);
}

const storeGet = (page, id) => page.evaluate((id) => {
  const r = window.__uk.store.get(id);
  return r ? { stage: r.stage, owner: r.owner, clients: r.clients, type: r.type, next_step: r.next_step, next_due: r.next_due } : null;
}, id);

async function waitStore(page, id, fn, ms = 10000) {
  await page.waitForFunction(([id, src]) => {
    const r = window.__uk.store.get(id);
    return !!r && new Function("r", "return (" + src + ")(r)")(r);
  }, [id, fn.toString()], { timeout: ms });
}

const rowSel = (id) => 'tr[data-key="' + id + '"]';

// ---------- setup / teardown ----------

before(async () => {
  assert.ok(BASE, "BASE_URL is set (run through tests/e2e/run.sh)");
  assert.ok(!/:8788\b/.test(BASE), "never the main dev server");
  fs.mkdirSync(SHOTS, { recursive: true });
  original = await readRows(TOUCHED);
  // Known starting states (the store reads them when the page loads).
  await applyBefore(goldenCase("patch-partner", "interested").before);
  await applyBefore({
    [ID.spare1]: { stage: "New", owner: "Tomas", clients: "Soro", type: null, next_step: null, next_due: null },
    [ID.spare2]: { stage: "Contacted", owner: "Tomas", clients: "Soro", type: "Review", next_step: null, next_due: null },
    [ID.spare3]: { stage: "Replied", owner: "Tomas", clients: "Soro", type: "Review", next_step: null, next_due: null },
    [ID.assign]: { stage: "New", owner: null, next_step: null, next_due: null },
    [ID.note]: { clients: "MailerLite/MailerSend" },
  });
  session = await signedInPage({ name: "Kamile" });
  const { page } = session;
  // Which endpoints are missing on this backend (the probes write nothing).
  const o = await pageFetch(page, "POST", "/api/partner/" + ID.spare4 + "/outcome", {});
  mocked.needOutcome = o.status === 404 && !!(o.json && o.json.unavailable);
  console.log("# mocks: /outcome " + (mocked.needOutcome ? "MOCKED (endpoint unavailable)" : "real"));
  await openApp(page);
});

// Each test starts with no panel, menu, popover, dialog or toast open.
beforeEach(async () => {
  if (!session || !session.page) return;
  const { page } = session;
  await page.evaluate(async () => {
    const uk = window.__uk;
    if (!uk) return;
    uk.menu.closeAll();
    for (const d of Array.from(document.querySelectorAll("dialog[open]"))) d.close();
    await uk.record.closeRecord({ force: true });
    uk.toast.clearToasts();
  });
  await page.waitForSelector("#layer-panel .ui-panel", { state: "detached" });
  await page.waitForSelector("dialog[open]", { state: "detached" });
});

after(async () => {
  try {
    if (Object.keys(original).length) await applyBefore(original);
  } finally {
    if (session) await session.close();
    await closeBrowser();
  }
});

// ---------- lists ----------

test("createList: table, sort, paging, selection and CSV", async () => {
  const { page } = session;
  await mountKamileList(page);
  const n = await page.evaluate(() => window.__uk.store.all().filter((r) => r.owner === "Kamile").length);
  assert.equal(n, fx.counts.by_owner.Kamile, "Kamile's rows in the store");
  assert.ok(n > 100, "enough rows to page");
  const L = "#uk-list ";
  assert.equal((await page.textContent(L + ".ui-list-count")).replace(/\D/g, ""), String(n));
  assert.equal(await page.locator(L + "tbody tr").count(), 50, "50 rows per page");
  assert.equal(await page.getAttribute(L + 'th:has([data-sort="site"])', "aria-sort"), "ascending");
  assert.equal(await page.locator(L + "tr[tabindex]").count(), 0, "rows have no tabindex");
  assert.equal(await page.locator(L + "tbody tr:first-child a.ui-row-link[href*='rec=']").count(), 1, "the name cell is a real link with rec");
  const first = await page.getAttribute(L + "tbody tr:first-child", "data-key");

  await page.click(L + '[data-page="next"]');
  assert.match(await page.textContent(L + ".ui-pager-info"), /^51–100 of /);
  assert.notEqual(await page.getAttribute(L + "tbody tr:first-child", "data-key"), first);
  await page.selectOption(L + "[data-per]", "100");
  assert.equal(await page.locator(L + "tbody tr").count(), 100, "100 rows per page");
  assert.match(await page.textContent(L + ".ui-pager-info"), /^1–100 of /);

  // Sort by DR: numbers start descending, then ascending; empty values stay last.
  await page.click(L + '[data-sort="dr"]');
  assert.equal(await page.getAttribute(L + 'th:has([data-sort="dr"])', "aria-sort"), "descending");
  const drs = async () => (await page.$$eval(L + "td.is-c-dr", (tds) => tds.map((t) => t.textContent.trim()))).filter((t) => /\d/.test(t)).map((t) => Number(t.replace(/\D/g, "")));
  let v = await drs();
  assert.ok(v.length > 10 && v.every((x, i) => i === 0 || v[i - 1] >= x), "DR descending");
  await page.click(L + '[data-sort="dr"]');
  assert.equal(await page.getAttribute(L + 'th:has([data-sort="dr"])', "aria-sort"), "ascending");
  v = await drs();
  assert.ok(v.every((x, i) => i === 0 || v[i - 1] <= x), "DR ascending");
  assert.equal(await page.getAttribute(L + 'th:has([data-sort="site"])', "aria-sort"), "none");

  // Selection: three rows, then the page, then clear.
  const boxes = page.locator(L + "tbody input[data-sel]");
  for (let i = 0; i < 3; i++) await boxes.nth(i).check();
  await page.waitForSelector(L + ".ui-bulkbar:not([hidden])");
  assert.match(await page.textContent(L + ".ui-bulkbar"), /^3 selected/);
  assert.equal(await page.evaluate(() => window.__ukLists.main.selected().length), 3);
  assert.match(await boxes.nth(0).getAttribute("aria-label"), /^Select /, "checkboxes are labelled with the site name");
  await page.check(L + "[data-selall]");
  assert.match(await page.textContent(L + ".ui-bulkbar"), /^100 selected/);
  await page.click(L + "[data-selclear]");
  assert.equal(await page.isHidden(L + ".ui-bulkbar"), true);
  await page.evaluate(() => window.__ukLists.main.refresh({ sort: "site", page: 1 }));
  await shot(page, "list-1440");

  // CSV: every filtered row (all pages), BOM, CRLF, the catalog's CSV columns.
  const [dl] = await Promise.all([page.waitForEvent("download"), page.click(L + "[data-csv]")]);
  assert.match(dl.suggestedFilename(), /^partnergap-uikit-\d{4}-\d{2}-\d{2}\.csv$/);
  const text = fs.readFileSync(await dl.path(), "utf8");
  assert.equal(text.charCodeAt(0), 0xfeff, "BOM");
  const lines = text.slice(1).split("\r\n");
  assert.equal(lines.pop(), "", "ends with CRLF");
  assert.equal(lines[0], "ID,Site,Domain,Stage,Owner,Clients,DR,Next step,Next step due,Follow-up");
  assert.equal(lines.length - 1, n, "one line per filtered row, all pages");
});

test("createList: column objects, fetchPage with Load more, escaping, and formula-safe CSV (T26)", async () => {
  const { page } = session;
  await page.evaluate(() => {
    const { list, dom } = window.__uk;
    const bad = { 0: '=HYPERLINK("http://evil.example.test","x")', 1: "+cmd", 2: "-2+3", 3: "@SUM(A1)", 4: "\tTab", 5: "\rCR",
      6: '<img src=x onerror="window.__xss=1">' };
    const all = Array.from({ length: 230 }, (_, i) => ({ id: "X-" + (i + 1), n: i + 1, label: bad[i] != null ? bad[i] : "Row " + (i + 1), note: i === 7 ? 'Comma, "quoted"' : "ok" }));
    window.__ukCalls = [];
    const host = window.__ukHost("uk-server", "Server list");
    window.__ukLists.server = list.createList(host, {
      id: "uk-server", csvName: "server rows", noun: ["row", "rows"],
      columns: [
        { id: "n", label: "Number", align: "num", priority: 1, cell: (r) => dom.html`<span class="num">${r.n}</span>`, sort: (r) => r.n, csv: (r) => r.n },
        { id: "label", label: "Label", priority: 1, cell: (r) => dom.html`<b>${r.label}</b>`, sort: (r) => r.label, csv: (r) => r.label },
        { id: "note", label: "Note", priority: 2, cell: (r) => dom.html`${r.note}` },
      ],
      async fetchPage({ page, per, sort, dir }) {
        window.__ukCalls.push({ page, per, sort, dir });
        const s = all.slice();
        if (sort === "n") s.sort((a, b) => (dir === "desc" ? b.n - a.n : a.n - b.n));
        return { rows: s.slice((page - 1) * per, page * per), total: s.length };
      },
    });
  });
  const L = "#uk-server ";
  await page.waitForSelector(L + "tbody tr");
  assert.equal(await page.locator(L + "tbody tr").count(), 100);
  assert.match(await page.textContent(L + ".ui-list-count"), /^Showing 100 of 230 rows$/);
  await page.click(L + "[data-load]");
  await page.waitForFunction(() => document.querySelectorAll("#uk-server tbody tr").length === 200);
  await page.click(L + "[data-load]");
  await page.waitForFunction(() => document.querySelectorAll("#uk-server tbody tr").length === 230);
  assert.equal(await page.locator(L + "[data-load]").count(), 0, "no Load more at the end");
  assert.match(await page.textContent(L + ".ui-list-count"), /^230 rows$/);
  // Escaping: the markup-looking label is text.
  assert.equal(await page.evaluate(() => window.__xss), undefined);
  assert.equal(await page.textContent(L + 'tr[data-key="X-7"] td.is-c-label'), '<img src=x onerror="window.__xss=1">');
  // Server sort: the column object's sort goes to fetchPage.
  await page.click(L + '[data-sort="n"]');
  await page.waitForFunction(() => {
    const c = window.__ukCalls[window.__ukCalls.length - 1];
    return c && c.sort === "n" && c.dir === "desc";
  });
  await page.waitForFunction(() => (document.querySelector("#uk-server tbody tr td.is-c-n") || {}).textContent === "230");
  await page.click(L + '[data-sort="n"]');
  await page.waitForFunction(() => (document.querySelector("#uk-server tbody tr td.is-c-n") || {}).textContent === "1");
  await page.click(L + "[data-load]");
  await page.click(L + "[data-load]");
  await page.waitForFunction(() => document.querySelectorAll("#uk-server tbody tr").length === 230);

  const [dl] = await Promise.all([page.waitForEvent("download"), page.click(L + "[data-csv]")]);
  assert.match(dl.suggestedFilename(), /^partnergap-server-rows-\d{4}-\d{2}-\d{2}\.csv$/);
  const text = fs.readFileSync(await dl.path(), "utf8");
  assert.equal(text.charCodeAt(0), 0xfeff);
  const rows = parseCsv(text.slice(1));
  assert.deepEqual(rows[0], ["Number", "Label", "Note"]);
  assert.equal(rows.length - 1, 230, "the CSV covers every fetched row");
  const byN = new Map(rows.slice(1).map((r) => [r[0], r]));
  assert.equal(byN.get("1")[1], '\'=HYPERLINK("http://evil.example.test","x")');
  assert.equal(byN.get("2")[1], "'+cmd");
  assert.equal(byN.get("3")[1], "'-2+3");
  assert.equal(byN.get("4")[1], "'@SUM(A1)");
  assert.equal(byN.get("5")[1], "'\tTab");
  assert.equal(byN.get("6")[1], "'\rCR");
  assert.equal(byN.get("8")[2], 'Comma, "quoted"');
  for (const r of rows.slice(1)) for (const cell of r) assert.ok(!/^[=+\-@\t\r]/.test(cell), "no cell starts a formula: " + JSON.stringify(cell));
  // The cell helper on its own.
  const cells = await page.evaluate(() => ["=1+1", "+1", "-1", "@a", "\tx", "\rx", "a,b", 'say "hi"', "plain", 5].map(window.__uk.list.csvCell));
  assert.deepEqual(cells, ["'=1+1", "'+1", "'-1", "'@a", "\"'\tx\"", "\"'\rx\"", '"a,b"', '"say ""hi"""', "plain", "5"]);
  await page.evaluate(() => { window.__ukLists.server.destroy(); delete window.__ukLists.server; document.getElementById("uk-server").remove(); });
});

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') q = false;
      else cell += ch;
    } else if (ch === '"') q = true;
    else if (ch === ",") { row.push(cell); cell = ""; }
    else if (ch === "\r" && text[i + 1] === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; i++; }
    else cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

test("row links: Enter opens the panel and it stays open; J moves through the queue; Esc closes and focus returns", async () => {
  const { page } = session;
  const L = "#uk-list ";
  const link = page.locator(L + "tbody tr:first-child a[data-open]");
  const id = await link.getAttribute("data-open");
  await link.focus();
  await page.keyboard.press("Enter");
  await page.waitForSelector('#layer-panel .ui-panel[data-panel="' + id + '"]');
  assert.match(page.url(), new RegExp("[?&]rec=" + id + "(&|$)"));
  await page.waitForTimeout(700);
  assert.equal(await page.locator("#layer-panel .ui-panel").count(), 1, "the panel stays open");
  assert.match(page.url(), /rec=/);
  assert.equal(await page.evaluate(() => document.activeElement && document.activeElement.id), "rp-title", "focus on the h2");
  assert.equal(await page.evaluate(() => document.querySelector(".sh-main").inert), true, "the page behind is inert");
  assert.equal(await page.evaluate(() => document.querySelector(".sh-side").inert), false, "the sidebar stays in reach");
  assert.equal(await page.getAttribute("#layer-panel .ui-panel", "role"), "dialog");
  assert.equal(await page.getAttribute("#layer-panel .ui-panel", "aria-modal"), "true");
  const q = await page.textContent("#layer-panel .ui-queue-text");
  assert.match(q, /^1 of \d+ · Test queue$/);
  await shot(page, "panel-1440");

  // J: the next site of the queue.
  await page.keyboard.press("j");
  await page.waitForFunction(() => /^2 of /.test((document.querySelector("#layer-panel .ui-queue-text") || {}).textContent || ""));
  const second = await page.getAttribute("#layer-panel .ui-panel", "data-panel");
  assert.notEqual(second, id);
  assert.equal(second, await page.getAttribute(L + "tbody tr:nth-child(2)", "data-key"));
  await page.keyboard.press("k");
  await page.waitForSelector('#layer-panel .ui-panel[data-panel="' + id + '"]');

  await page.keyboard.press("Escape");
  await page.waitForSelector("#layer-panel .ui-panel", { state: "detached" });
  assert.doesNotMatch(page.url(), /rec=/);
  assert.equal(await page.evaluate(() => document.querySelector(".sh-main").inert), false);
  assert.equal(await page.evaluate(() => document.activeElement && document.activeElement.getAttribute("data-open")), id, "focus returns to the row link");

  // A click elsewhere on the row (not on a control) follows the link too; × closes.
  await page.click(L + "tbody tr:nth-child(3) td.is-c-dr");
  await page.waitForSelector("#layer-panel .ui-panel");
  await page.click('#layer-panel [data-pclose="x"]');
  await page.waitForSelector("#layer-panel .ui-panel", { state: "detached" });
});

// ---------- filters ----------

test("filters live in the URL as chips with × and Clear all", async () => {
  const { page } = session;
  await page.evaluate(() => {
    const { filters, router, store } = window.__uk;
    const host = window.__ukHost("uk-filters", "Filters");
    const bar = filters.createFilterBar(host, { fields: ["q", "owner", "stage", "client", "has_contact"], params: router.current().params, label: "Filters" });
    router.onChange((r) => bar.update(r.params));
    const count = document.createElement("p");
    count.id = "uk-fcount";
    host.appendChild(count);
    const draw = () => { count.textContent = String(filters.applyFilters(store.all(), router.current().params).length); };
    router.onChange(draw);
    draw();
  });
  const F = "#uk-filters ";
  await page.click(F + '[data-ffield="stage"]');
  await page.click('.ui-menu .ui-mi-label:text-is("Contacted")');
  await page.waitForFunction(() => /[?&]stage=Contacted/.test(location.hash));
  await page.waitForSelector(F + '.ui-fchip:has-text("Stage: Contacted")');
  await page.click(F + '[data-ffield="owner"]');
  await page.click('.ui-menu .ui-mi-label:text-is("Me")');
  await page.waitForFunction(() => /[?&]owner=me/.test(location.hash));
  await page.waitForSelector(F + '.ui-fchip:has-text("Owner: Me")');
  const expected = fx.partners.filter((p) => p.owner === "Kamile" && p.stage === "Contacted").length;
  assert.equal(await page.textContent("#uk-fcount"), String(expected), "applyFilters matches the fixture");
  await page.click(F + '[data-ffield="client"]');
  await page.click('.ui-menu .ui-mi-label:text-is("Melograno - Amelia")');
  await page.waitForFunction(() => /[?&]client=melograno-amelia/.test(location.hash));
  await page.waitForSelector(F + '.ui-fchip:has-text("Client: Melograno - Amelia")');
  await page.fill(F + "[data-fq]", "example");
  await page.waitForFunction(() => /[?&]q=example/.test(location.hash));
  await page.waitForSelector(F + '.ui-fchip:has-text("“example”")');
  await shot(page, "filters-1440");
  // × removes one filter.
  await page.click(F + '[data-fremove="client"]');
  await page.waitForFunction(() => !/client=/.test(location.hash));
  assert.equal(await page.locator(F + '.ui-fchip:has-text("Client:")').count(), 0);
  // Back restores it (the URL is the state).
  await page.goBack();
  await page.waitForFunction(() => /client=melograno-amelia/.test(location.hash));
  await page.waitForSelector(F + '.ui-fchip:has-text("Client: Melograno - Amelia")');
  await page.click(F + "[data-fclear]");
  await page.waitForFunction(() => !/(stage|owner|client|q)=/.test(location.hash));
  assert.equal(await page.locator(F + ".ui-fchip").count(), 0);
  await page.evaluate(() => document.getElementById("uk-filters").remove());
});

// ---------- inline editors ----------

test("inline editors: stage (with toast and Undo), Lost asks for a reason, owner, type", async () => {
  const { page } = session;
  await mountContractList(page, [ID.spare1, ID.spare2, ID.spare3, ID.note, ID.assign]);
  const R = (id) => "#uk-edit " + rowSel(id) + " ";

  // Stage New -> Contacted, then Undo.
  let n0 = await lastEdit();
  await page.click(R(ID.spare1) + '[data-edit="stage"]');
  await page.click('.ui-menu .ui-mi-label:text-is("Contacted")');
  let t = await toastWith(page, "Contacted");
  assert.deepEqual(await waitEdits(n0, 1), [upd(ID.spare1, "stage", "New", "Contacted")]);
  await page.waitForSelector(R(ID.spare1) + '[data-edit="stage"]:has-text("Contacted")');
  n0 = await lastEdit();
  await t.locator('[data-t="undo"]').click();
  assert.deepEqual(await waitEdits(n0, 1), [upd(ID.spare1, "stage", "Contacted", "New")]);
  await waitStore(page, ID.spare1, (r) => r.stage === "New");

  // Stage -> Lost opens the reason form; Cancel writes nothing.
  n0 = await lastEdit();
  await page.click(R(ID.spare1) + '[data-edit="stage"]');
  await page.click('.ui-menu .ui-mi-label:text-is("Lost")');
  await page.waitForSelector(".ui-pop form .ui-radios");
  const reasons = await page.locator('.ui-pop input[name="reason"]').count();
  assert.ok(reasons >= 2, "lost reasons listed");
  await page.click('.ui-pop [data-f="Save"], .ui-pop button[type="submit"]');
  await page.waitForSelector('.ui-pop .ui-error:not([hidden])');
  await page.click('.ui-pop [data-f="cancel"]');
  await page.waitForSelector(".ui-pop", { state: "detached" });
  assert.equal(await lastEdit(), n0, "nothing written");

  // Owner Tomas -> Gaby (Me is first).
  n0 = await lastEdit();
  await page.click(R(ID.spare1) + '[data-edit="owner"]');
  const firstItem = page.locator(".ui-menu .ui-mi").first();
  assert.match(await firstItem.textContent(), /Kamile.*me/);
  await page.click('.ui-menu .ui-mi-label:text-is("Gaby")');
  await toastWith(page, "Gaby");
  assert.deepEqual(await waitEdits(n0, 1), [upd(ID.spare1, "owner", "Tomas", "Gaby")]);

  // Type (not set) -> Review, from the searchable menu.
  n0 = await lastEdit();
  await page.click(R(ID.spare1) + '[data-edit="type"]');
  await page.fill(".ui-menu .ui-msearch", "rev");
  await page.click('.ui-menu .ui-mi-label:text-is("Review")');
  assert.deepEqual(await waitEdits(n0, 1), [upd(ID.spare1, "type", null, "Review")]);
  await waitStore(page, ID.spare1, (r) => r.type === "Review");
});

test("inline editors: next step (text + date), follow-up date, clients with Melograno and Other…", async () => {
  const { page } = session;
  const R = (id) => "#uk-edit " + rowSel(id) + " ";

  // Next step: one PATCH with next_step and next_due.
  const due = addDays(TODAY, 5);
  let n0 = await lastEdit();
  await page.click(R(ID.spare2) + '[data-edit="next"]');
  await page.fill('.ui-pop input[name="text"]', "Send the media kit");
  await page.fill('.ui-pop input[name="due"]', due);
  await page.click('.ui-pop button[type="submit"]');
  assert.deepEqual(await waitEdits(n0, 2), [upd(ID.spare2, "next_step", null, "Send the media kit"), upd(ID.spare2, "next_due", null, due)]);
  await waitStore(page, ID.spare2, (r) => r.next_step === "Send the media kit");

  // Follow-up date from the due badge: In 2 weeks (the next step is set, so only next_due changes).
  n0 = await lastEdit();
  await page.click(R(ID.spare2) + '[data-edit="due"]');
  await page.click('.ui-menu .ui-mi-label:text-is("In 2 weeks")');
  assert.deepEqual(await waitEdits(n0, 1), [upd(ID.spare2, "next_due", due, addDays(TODAY, 14))]);

  // Clients: existing "MailerLite/MailerSend" is kept exactly; Melograno expands into products; Other… adds free text.
  n0 = await lastEdit();
  await page.click(R(ID.note) + '[data-edit="clients"]');
  await page.waitForSelector(".ui-clients-form");
  assert.equal(await page.getAttribute('.ui-clients-form [data-key="mailerlite|"]', "aria-pressed"), "true");
  await page.click('.ui-clients-form [data-group="melograno"]');
  await page.click('.ui-clients-form [data-key="melograno|amelia"]');
  await page.fill('.ui-clients-form input[name="other"]', "x");
  await page.click('.ui-clients-form [data-f="other"]');
  await page.waitForSelector(".ui-clients-form .ui-error:not([hidden])");
  assert.equal(await page.getAttribute('.ui-clients-form input[name="other"]', "aria-invalid"), "true");
  await page.fill('.ui-clients-form input[name="other"]', "Acme Widgets");
  await page.click('.ui-clients-form [data-f="other"]');
  assert.equal(await page.textContent(".ui-clients-form [data-preview]"), "Saved as: MailerLite/MailerSend, Melograno - Amelia, Acme Widgets");
  await shot(page, "clients-editor-1440");
  await page.click('.ui-clients-form button[type="submit"]');
  assert.deepEqual(await waitEdits(n0, 1), [upd(ID.note, "clients", "MailerLite/MailerSend", "MailerLite/MailerSend, Melograno - Amelia, Acme Widgets")]);
  await page.waitForSelector(R(ID.note) + '.ui-tag:has-text("Melograno - Amelia")');
});

// ---------- actions ----------

test("Log what happened in the panel: Interested writes the golden rows, then Undo (/outcome is mocked only when the server lacks it)", async () => {
  const { page } = session;
  const patch = goldenCase("patch-partner", "interested");
  const act = goldenCase("activity-log", "interested");
  await page.evaluate((id) => window.__uk.record.openRecord(id), ID.interested);
  await page.waitForSelector('#layer-panel .ui-panel[data-panel="' + ID.interested + '"]');
  await page.fill("#layer-panel [data-pnote]", "Wants the media kit.");
  assert.equal(await page.evaluate(() => window.__uk.record.isDirty()), true);
  await page.click('#layer-panel [data-pchip="pick"]');
  await page.fill('.ui-pop input[name="d"]', patch.request.body.fields.next_due);
  await page.click('.ui-pop button[type="submit"]');
  await page.waitForSelector('#layer-panel [data-pchip="pick"][aria-pressed="true"]');
  const n0 = await lastEdit();
  const before = mocked.outcome;
  await page.click('#layer-panel [data-outcome="interested"]');
  const t = await toastWith(page, "Moved to Negotiating");
  const rows = await waitEdits(n0, 4);
  assertGolden(patch.edits.concat(act.edits), rows, { message: "Interested = golden PATCH rows, then the activity row" });
  if (mocked.needOutcome) {
    assert.equal(mocked.outcome, before + 1, "the mock answered /outcome");
    console.log("# mocked: POST /api/partner/" + ID.interested + "/outcome (Log what happened in the panel)");
  }
  assert.equal(await page.inputValue("#layer-panel [data-pnote]"), "", "the note box is cleared after the save");
  await page.waitForSelector('#layer-panel [data-edit="stage"]:has-text("Negotiating")');
  // Undo reverts the changed fields; the note stays.
  const n1 = await lastEdit();
  await t.locator('[data-t="undo"]').click();
  await toastWith(page, "Stage restored. The note stays in the history.");
  const back = await waitEdits(n1, 3);
  assert.deepEqual(back.map((r) => [r.field, r.old]), [["stage", "Negotiating"], ["next_step", "Agree terms"], ["next_due", "2026-11-04"]]);
  assert.deepEqual(back.map((r) => r.new), ["Replied", "Answer their reply", null]);
  await waitStore(page, ID.interested, (r) => r.stage === "Replied");
  await page.click('#layer-panel [data-pclose="x"]');
  await page.waitForSelector("#layer-panel .ui-panel", { state: "detached" });
});

test("actions.followUp from the row menu, actions.claim, both with Undo", async () => {
  const { page } = session;
  const R = (id) => "#uk-edit " + rowSel(id) + " ";
  // Follow up ▾ -> Tomorrow: next_step "Follow up" only because it is empty.
  let n0 = await lastEdit();
  await page.click(R(ID.spare3) + '[data-row-act="follow"]');
  await page.click('.ui-menu .ui-mi-label:text-is("Tomorrow")');
  const t = await toastWith(page, "Follow-up");
  const tomorrow = addWorkingDays(TODAY, 1);
  assert.deepEqual(await waitEdits(n0, 2), [upd(ID.spare3, "next_step", null, "Follow up"), upd(ID.spare3, "next_due", null, tomorrow)]);
  n0 = await lastEdit();
  await t.locator('[data-t="undo"]').click();
  const undone = await waitEdits(n0, 2);
  assert.deepEqual(undone.map((r) => [r.field, r.old, r.new]), [["next_step", "Follow up", null], ["next_due", tomorrow, null]]);

  // Claim: owner = me, follow-up +2 working days, next step only if empty; no stage change.
  n0 = await lastEdit();
  await page.evaluate((id) => window.__uk.actions.claim(id), ID.assign);
  const c = await toastWith(page, "Claimed");
  const due = addWorkingDays(TODAY, 2);
  assert.deepEqual(await waitEdits(n0, 3), [
    upd(ID.assign, "owner", null, "Kamile"),
    upd(ID.assign, "next_step", null, "Find the right contact and email"),
    upd(ID.assign, "next_due", null, due),
  ]);
  n0 = await lastEdit();
  await c.locator('[data-t="undo"]').click();
  const u = await waitEdits(n0, 3);
  assert.deepEqual(u.map((r) => [r.field, r.new]), [["owner", null], ["next_step", null], ["next_due", null]]);
  await waitStore(page, ID.assign, (r) => !r.owner);
});

test("actions.bulk: confirm over 20, progress-free small run, toast and Undo (rows mode)", async () => {
  const { page } = session;
  // More than 20 sites asks first; Cancel writes nothing.
  const many = fx.groups["kamile-contacted-nodate"].slice(0, 25);
  let n0 = await lastEdit();
  const pending = page.evaluate((ids) => window.__uk.actions.bulk(ids, { owner: "Gaby" }), many);
  await page.waitForSelector("dialog.ui-modal[open]");
  assert.equal(await page.textContent("dialog.ui-modal[open] .ui-modal-title"), "Assign 25 sites to Gaby?");
  await page.click('dialog.ui-modal[open] .ui-modal-foot button:has-text("Cancel")');
  const r0 = await pending;
  assert.equal(r0.cancelled, true);
  assert.equal(await lastEdit(), n0, "nothing written");

  // Six contract rows to Gaby (one is already hers).
  const ids = ID.bulk;
  const owners = Object.fromEntries(await Promise.all(ids.map(async (id) => [id, (await storeGet(page, id)).owner])));
  n0 = await lastEdit();
  await page.evaluate((ids) => window.__uk.actions.bulk(ids, { owner: "Gaby" }), ids);
  const t = await toastWith(page, "Updated");
  const changed = ids.filter((id) => owners[id] !== "Gaby");
  const rows = await waitEdits(n0, changed.length);
  assert.deepEqual(sortEdits(rows), sortEdits(changed.map((id) => upd(id, "owner", owners[id], "Gaby"))));
  for (const id of ids) await waitStore(page, id, (r) => r.owner === "Gaby");
  n0 = await lastEdit();
  await t.locator('[data-t="undo"]').click();
  await toastWith(page, "Restored");
  const back = await waitEdits(n0, changed.length);
  assert.deepEqual(sortEdits(back), sortEdits(changed.map((id) => upd(id, "owner", "Gaby", owners[id]))));
  for (const id of changed) assert.equal((await storeGet(page, id)).owner || null, owners[id] || null);
});

// ---------- dialogs and the top layer ----------

test("dialogs: focus trap, a menu inside is clickable, a toast shown meanwhile is visible, Esc closes", async () => {
  const { page } = session;
  await page.evaluate(() => {
    const { dialog, dom, menu, toast } = window.__uk;
    const opener = document.createElement("button");
    opener.id = "uk-open";
    opener.type = "button";
    opener.className = "ui-btn";
    opener.textContent = "Open dialog";
    document.getElementById("uk-edit").appendChild(opener);
    opener.focus();
    const m = dialog.openModal({
      title: "Test dialog",
      body: dom.html`<label class="ui-field"><span class="ui-label">Name</span><input class="ui-input" id="uk-in"></label><p><button type="button" class="ui-btn" id="uk-menu-btn" aria-haspopup="menu">Pick a stage ▾</button></p>`,
      actions: [{ label: "Cancel", value: "cancel" }, { label: "Save", kind: "primary", value: "save" }],
    });
    window.__ukModal = m;
    m.result.then((v) => { window.__ukModalResult = v; });
    m.body.querySelector("#uk-menu-btn").addEventListener("click", async (e) => {
      window.__ukPicked = await menu.openMenu(e.currentTarget, { label: "Stage", items: [{ label: "Contacted", value: "Contacted" }, { label: "Replied", value: "Replied" }] });
    });
    void toast;
  });
  await page.waitForSelector("dialog.ui-modal[open]");
  // Focus trap: Tab and Shift+Tab never leave the dialog.
  for (let i = 0; i < 8; i++) {
    await page.keyboard.press("Tab");
    assert.equal(await page.evaluate(() => !!document.activeElement.closest("dialog[open]")), true, "Tab " + i + " stays in the dialog");
  }
  for (let i = 0; i < 8; i++) {
    await page.keyboard.press("Shift+Tab");
    assert.equal(await page.evaluate(() => !!document.activeElement.closest("dialog[open]")), true, "Shift+Tab " + i + " stays in the dialog");
  }
  // A menu opened inside the dialog mounts in it and is clickable.
  await page.click("#uk-menu-btn");
  await page.waitForSelector("dialog[open] .ui-menu");
  await page.click('dialog[open] .ui-menu .ui-mi-label:text-is("Replied")');
  await page.waitForFunction(() => window.__ukPicked === "Replied");
  // A toast shown while the dialog is open is on top (top layer) and clickable.
  await page.evaluate(() => window.__uk.toast.toast("Shown while the dialog is open", { kind: "success" }));
  const t = await toastWith(page, "Shown while the dialog is open");
  const top = await t.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return !!hit && el.contains(hit);
  });
  assert.equal(top, true, "the toast is the topmost element at its centre");
  await shot(page, "dialog-toast-1440");
  await t.locator('[data-t="close"]').click();
  await t.waitFor({ state: "detached" });
  // Esc closes the dialog (result null) and focus returns to the opener.
  await page.focus("#uk-in");
  await page.keyboard.press("Escape");
  await page.waitForSelector("dialog.ui-modal", { state: "detached" });
  assert.equal(await page.evaluate(() => window.__ukModalResult), null);
  assert.equal(await page.evaluate(() => document.activeElement && document.activeElement.id), "uk-open");
  // confirm(): the primary action resolves true.
  const p = page.evaluate(() => window.__uk.dialog.confirm({ title: "Sure?", confirmLabel: "Yes" }));
  await page.click('dialog.ui-modal[open] button:has-text("Yes")');
  assert.equal(await p, true);
});

test("after a save the footer's waiting count comes from freshness, without the not-copied conflicts (spec 4.11, 2.2.6)", async () => {
  const { page } = session;
  const n0 = await lastEdit();
  await page.evaluate((id) => window.__uk.actions.update(id, { next_step: "Footer count check" }, { undo: false }), ID.spare4);
  await waitEdits(n0, 1);
  const m = await pageFetch(page, "GET", "/api/meta");
  const e = await pageFetch(page, "GET", "/api/edits");
  const waiting = m.json.freshness.pending;
  assert.ok(e.json.pending > waiting, "the fixture has a not-copied conflict: /api/edits counts " + e.json.pending + ", freshness " + waiting);
  await page.waitForFunction((n) => {
    const el = document.querySelector(".sh-side [data-sync]");
    return !!el && new RegExp("· " + n + " changes? copy to the Google Sheet").test(el.textContent);
  }, waiting, { timeout: 10000 });
});

test("desktop: a toast sits at the bottom left of the content, clear of the sidebar footer (spec 4.9)", async () => {
  const { page } = session;
  await page.evaluate(() => window.__uk.toast.toast("Saved next to the footer", { kind: "success", undo: () => {} }));
  const t = await toastWith(page, "Saved next to the footer");
  await settled(page);
  const box = await t.boundingBox();
  const vp = page.viewportSize();
  const sideRight = await page.evaluate(() => document.querySelector(".sh-side").getBoundingClientRect().right);
  assert.ok(box.x >= sideRight, "the toast starts right of the sidebar (" + box.x + " >= " + sideRight + ")");
  assert.ok(box.x <= sideRight + 32, "at the left of the content area");
  assert.ok(box.y + box.height >= vp.height - 80, "at the bottom");
  const clear = await page.evaluate(() => Array.from(document.querySelectorAll(".sh-side .sh-foot a, .sh-side .sh-foot button")).map((el) => {
    const r = el.getBoundingClientRect();
    const h = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return { what: el.textContent.trim(), top: !!h && el.contains(h) };
  }));
  assert.ok(clear.length >= 3, "the footer has its controls");
  assert.deepEqual(clear.filter((c) => !c.top), [], "every sidebar footer control takes clicks while the toast shows");
});

test("the record panel: its stage menu is clickable, a toast while it is open is visible, Esc closes it", async () => {
  const { page } = session;
  await page.evaluate((id) => window.__uk.record.openRecord(id), ID.spare3);
  await page.waitForSelector('#layer-panel .ui-panel[data-panel="' + ID.spare3 + '"]');
  const n0 = await lastEdit();
  await page.click('#layer-panel .ui-panel-meta [data-edit="stage"]');
  await page.waitForSelector("#layer-panel .ui-menu");
  const item = page.locator('#layer-panel .ui-menu .ui-mi-label:text-is("Negotiating")');
  const hit = await item.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const h = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return !!h && el.closest(".ui-mi").contains(h);
  });
  assert.equal(hit, true, "the menu item is the topmost element");
  await shot(page, "panel-menu-1440");
  await item.click();
  const t = await toastWith(page, "Negotiating");
  assert.deepEqual(await waitEdits(n0, 1), [upd(ID.spare3, "stage", "Replied", "Negotiating")]);
  await page.waitForSelector('#layer-panel .ui-panel-meta [data-edit="stage"]:has-text("Negotiating")');
  // The outcome buttons follow the new stage.
  await page.waitForSelector('#layer-panel [data-outcome="approve"]');
  const top = await t.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const h = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return !!h && el.contains(h);
  });
  assert.equal(top, true, "the toast is above the panel");
  // The record is a full page (2026-10-21), so the toast sits on top of it (checked above), inside the window.
  const tb = await t.boundingBox();
  assert.ok(tb.x >= 0 && tb.x + tb.width <= page.viewportSize().width, "the toast is inside the window");
  // Esc closes the panel even while the toast is showing.
  await page.focus("#layer-panel [data-pnote]");
  await page.keyboard.press("Escape");
  await page.waitForSelector("#layer-panel .ui-panel", { state: "detached" });
});

test("the panel asks before discarding a typed note", async () => {
  const { page } = session;
  await page.evaluate((id) => window.__uk.record.openRecord(id), ID.spare3);
  await page.waitForSelector("#layer-panel .ui-panel");
  await page.fill("#layer-panel [data-pnote]", "Half-written note");
  await page.click('#layer-panel [data-pclose="x"]');
  await page.waitForSelector('dialog.ui-modal[open] .ui-modal-title:text-is("Discard your note?")');
  await page.click('dialog.ui-modal[open] button:has-text("Keep editing")');
  await page.waitForSelector("dialog.ui-modal", { state: "detached" });
  assert.equal(await page.locator("#layer-panel .ui-panel").count(), 1, "still open");
  assert.equal(await page.inputValue("#layer-panel [data-pnote]"), "Half-written note");
  // A route change asks too (router guard), then Discard closes.
  await page.evaluate(() => window.__uk.router.setParams({ rec: null }));
  await page.waitForSelector('dialog.ui-modal[open] .ui-modal-title:text-is("Discard your note?")');
  await page.click('dialog.ui-modal[open] button:has-text("Discard")');
  await page.waitForSelector("#layer-panel .ui-panel", { state: "detached" });
  assert.doesNotMatch(page.url(), /rec=/);
});

test("axe: no serious or critical issues in the lists, the panel, a menu and a dialog (light and dark)", async () => {
  const { page } = session;
  const axeSrc = fs.readFileSync(tools().axe, "utf8");
  for (const scheme of ["light", "dark"]) {
    await page.emulateMedia({ colorScheme: scheme });
    await mountKamileList(page);
    await page.evaluate(axeSrc);
    const check = async (where) => {
      // Let the open animations (panel slide-in, toast) finish: axe reads the colours as painted.
      await settled(page);
      const res = await page.evaluate(async (inc) => {
        const r = await window.axe.run({ include: inc }, { resultTypes: ["violations"] });
        return r.violations.filter((v) => v.impact === "serious" || v.impact === "critical")
          .map((v) => v.id + ": " + v.help + " -> " + v.nodes.slice(0, 3).map((n) => n.target.join(" ")).join(" | "));
      }, where);
      assert.deepEqual(res, [], scheme + " " + JSON.stringify(where));
    };
    await check([["#uk-list"], ["#uk-edit"]]);
    await page.evaluate((id) => window.__uk.record.openRecord(id), ID.spare2);
    await page.waitForSelector("#layer-panel .ui-panel");
    await check([["#layer-panel"]]);
    await page.click('#layer-panel .ui-panel-meta [data-edit="owner"]');
    await page.waitForSelector("#layer-panel .ui-menu");
    await check([["#layer-panel .ui-menu"]]);
    if (scheme === "dark") await shot(page, "panel-menu-dark-1440");
    await page.keyboard.press("Escape");
    await page.waitForSelector("#layer-panel .ui-menu", { state: "detached" });
    await page.keyboard.press("Escape");
    await page.waitForSelector("#layer-panel .ui-panel", { state: "detached" });
    await page.evaluate(() => window.__uk.dialog.openModal({ title: "Axe dialog", body: "Body text", actions: [{ label: "Cancel" }, { label: "OK", kind: "primary" }] }));
    await page.waitForSelector("dialog.ui-modal[open]");
    await check([["dialog.ui-modal"]]);
    await page.keyboard.press("Escape");
    await page.waitForSelector("dialog.ui-modal", { state: "detached" });
  }
  await page.emulateMedia({ colorScheme: "light" });
});

// ---------- phone ----------

test("phone (390 px): cards, no horizontal scroll, filter sheet with a working menu, menus as sheets, full-screen panel", async () => {
  const s = await signedInPage({ name: "Kamile", viewport: { width: 390, height: 844 }, contextOptions: { isMobile: true, hasTouch: true, deviceScaleFactor: 2 } });
  try {
    const { page } = s;
    await openApp(page);
    await mountKamileList(page);
    await page.evaluate(() => {
      const { filters, router } = window.__uk;
      const host = document.createElement("div");
      host.id = "uk-pfilters";
      document.getElementById("uk-list").prepend(host);
      const bar = filters.createFilterBar(host, { fields: ["q", "owner", "stage", "client"], params: router.current().params, label: "Filters" });
      router.onChange((r) => bar.update(r.params));
    });
    const L = "#uk-list ";
    assert.equal(await page.isHidden(L + "thead"), true, "no table header on cards");
    assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector("#uk-list tbody tr")).display), "flex", "rows are cards");
    assert.equal(await page.isVisible(L + "tbody tr:first-child .ui-row-more"), true, "⋯ on cards");
    assert.equal(await page.isVisible(L + ".ui-more-btn"), true, "Show 50 more");
    const noScroll = () => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
    assert.equal(await noScroll(), true, "no horizontal scroll");
    await shot(page, "list-390");
    await page.click(L + ".ui-more-btn");
    assert.equal(await page.locator(L + "tbody tr").count(), 100);

    // Filters: the sheet is a dialog, its menus open inside it and are clickable.
    await page.click("#uk-pfilters [data-fsheet]");
    await page.waitForSelector("dialog.ui-modal[open] [data-fbtns-sheet]");
    await page.click('dialog.ui-modal[open] [data-ffield="stage"]');
    await page.waitForSelector("dialog[open] .ui-menu");
    await shot(page, "filters-sheet-menu-390");
    await page.click('dialog[open] .ui-menu .ui-mi-label:text-is("Replied")');
    await page.waitForFunction(() => /[?&]stage=Replied/.test(location.hash));
    await page.keyboard.press("Escape");
    await page.waitForSelector("dialog.ui-modal", { state: "detached" });
    await page.waitForSelector('#uk-pfilters .ui-fchip:has-text("Stage: Replied")');
    await page.click("#uk-pfilters [data-fclear]");

    // ⋯ on a card opens the actions menu as a bottom sheet.
    await page.click(L + "tbody tr:first-child .ui-row-more");
    const sheet = page.locator(".ui-menu");
    await sheet.waitFor();
    const box = await sheet.boundingBox();
    assert.ok(Math.abs(box.x) < 1 && Math.abs(box.width - 390) < 2, "the menu spans the width");
    assert.ok(Math.abs(box.y + box.height - 844) < 2, "the menu sits at the bottom");
    await shot(page, "row-menu-390");
    await page.keyboard.press("Escape");

    // The panel is full screen.
    await page.click(L + "tbody tr:first-child a[data-open]");
    await page.waitForSelector("#layer-panel .ui-panel");
    const pb = await page.locator("#layer-panel .ui-panel").boundingBox();
    assert.ok(pb.width >= 389 && pb.x < 1, "full-screen panel");
    assert.equal(await noScroll(), true, "no horizontal scroll with the panel open");
    await shot(page, "panel-390");
    await page.click('#layer-panel .ui-panel-meta [data-edit="stage"]');
    await page.waitForSelector("#layer-panel .ui-menu");
    await shot(page, "panel-menu-390");
    await page.keyboard.press("Escape");
    await page.click('#layer-panel [data-pclose="x"]');
    await page.waitForSelector("#layer-panel .ui-panel", { state: "detached" });

    // A toast shown while the shell's More sheet is open sits on top and takes clicks.
    await page.click(".sh-tabs [data-more]");
    await page.waitForSelector("dialog.sh-more[open]");
    await page.evaluate(() => {
      window.__ukMoreUndo = 0;
      window.__uk.toast.toast("Shown over More", { kind: "success", undo: () => { window.__ukMoreUndo++; } });
    });
    const moreToast = await toastWith(page, "Shown over More");
    await settled(page);
    const onTop = await moreToast.evaluate((el) => {
      const r = el.getBoundingClientRect();
      const h = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return !!h && el.contains(h);
    });
    assert.equal(onTop, true, "the toast is above the More sheet");
    await moreToast.locator('[data-t="undo"]').click();
    await page.waitForFunction(() => window.__ukMoreUndo === 1);
    assert.equal(await page.evaluate(() => document.querySelector("dialog.sh-more").open), true, "the sheet stays open");
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => !document.querySelector("dialog.sh-more").open);
    assert.equal(await page.evaluate(() => document.getElementById("toasts").parentNode === document.body), true, "the region goes back to <body>");
    assert.deepEqual(s.watch.pageErrors, [], "no page errors");
  } finally {
    await s.close();
  }
});

test("touch (390 px, coarse pointer): list and filter controls are at least 44 px, inputs are 16 px (spec 4.1, 4.12)", async () => {
  const s = await signedInPage({ name: "Kamile", viewport: { width: 390, height: 844 }, contextOptions: { isMobile: true, hasTouch: true, deviceScaleFactor: 2 } });
  try {
    const { page } = s;
    await openApp(page);
    assert.equal(await page.evaluate(() => matchMedia("(pointer: coarse)").matches), true, "a coarse pointer");
    await mountKamileList(page);
    await page.evaluate(() => {
      const { filters, router } = window.__uk;
      const host = document.createElement("div");
      host.id = "uk-tfilters";
      document.getElementById("uk-list").prepend(host);
      filters.createFilterBar(host, { fields: ["q", "owner", "stage", "client"], params: Object.assign({}, router.current().params, { stage: "Contacted" }), label: "Filters" });
    });
    // The checkbox's target is its label; a hidden control (width 0) is not a target.
    const measure = (scope) => page.evaluate((scope) => {
      const out = { small: [], fonts: [] };
      for (const root of document.querySelectorAll(scope)) {
        for (const el of root.querySelectorAll("a[href], button, input, select, textarea, [tabindex='0']")) {
          const box = el.matches("input[type=checkbox], input[type=radio]") && el.closest("label") ? el.closest("label") : el;
          const r = box.getBoundingClientRect();
          if (!r.width || !r.height || getComputedStyle(el).visibility === "hidden") continue;
          const what = el.tagName.toLowerCase() + "." + String(box.className || "").split(" ")[0] + " " + (el.getAttribute("aria-label") || el.textContent || "").trim().slice(0, 30);
          if (r.width < 43.5 || r.height < 43.5) out.small.push(what + " " + Math.round(r.width) + "x" + Math.round(r.height));
          if (el.matches("input:not([type=checkbox]):not([type=radio]), select, textarea")) {
            const fs = parseFloat(getComputedStyle(el).fontSize);
            if (fs < 16) out.fonts.push(what + " " + fs + "px");
          }
        }
      }
      return out;
    }, scope);
    const list = await measure("#uk-list, [data-banners]");
    assert.deepEqual(list.small, [], "list, filter bar and banner targets under 44 px");
    assert.deepEqual(list.fonts, [], "inputs under 16 px");
    await shot(page, "touch-list-390");

    // The filter sheet and a menu with a search box opened from it.
    await page.click("#uk-tfilters [data-fsheet]");
    await page.waitForSelector("dialog.ui-modal[open] [data-fbtns-sheet]");
    const sheet = await measure("dialog.ui-modal[open]");
    assert.deepEqual(sheet, { small: [], fonts: [] }, "filter sheet");
    await page.click('dialog.ui-modal[open] [data-ffield="client"]');
    await page.waitForSelector(".ui-menu:popover-open .ui-msearch");
    const menu = await measure(".ui-menu:popover-open");
    assert.deepEqual(menu, { small: [], fonts: [] }, "menu with search");
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
    await page.waitForSelector("dialog.ui-modal", { state: "detached" });
    // The label toggles the row checkbox (and does not open the row).
    const first = "#uk-list tbody tr:first-child";
    const lb = await page.locator(first + " .ui-selbox").boundingBox();
    await page.touchscreen.tap(lb.x + 3, lb.y + 3);
    assert.equal(await page.isChecked(first + " input[data-sel]"), true, "a tap near the label's corner selects the row");
    assert.equal(await page.locator("#layer-panel .ui-panel").count(), 0, "and opens nothing");
    assert.deepEqual(s.watch.pageErrors, [], "no page errors");
  } finally {
    await s.close();
  }
});

test("no page errors during the run", async () => {
  assert.deepEqual(session.watch.pageErrors, []);
});
