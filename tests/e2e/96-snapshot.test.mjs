// Snapshot builder output (spec 4.14, 7.3 G3-6; test T34). Owner G3-6.
// Run: bash tests/e2e/run.sh tests/e2e/96-snapshot.test.mjs   (screenshots: SHOTS_DIR, default /tmp/shots-g36)
//
// before(): reads GET /api/meta, /api/partners?v=2, /api/clients and /api/team-activity?days=7 from the
// fixture server (signed in from Node), and runs the real CLI (crm/scripts/build_snapshot.mjs) on them with
// --as-of FIXTURE_TODAY 12:00 UTC. The tests then check the file itself (one self-contained page, no email
// pattern, refusals) and open it in Chromium with the network switched off: every request other than the
// snapshot document (and the host page of the frame tests) is counted and aborted, and must be 0. The page
// runs top level, in a sandboxed frame (no allow-same-origin, so localStorage throws) and in a sandboxed
// srcdoc frame. Its numbers are compared with the live site at the same moment. Nothing is written to D1.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { baseUrl, apiClient, browser, closeBrowser, signedInPage, fixture, HARNESS_ROOT } from "./lib.mjs";

const BASE = baseUrl();
const SHOTS = process.env.SHOTS_DIR || "/tmp/shots-g36";
const fx = fixture();
const TODAY = fx.today || process.env.FIXTURE_TODAY;
const AS_OF = TODAY + "T12:00:00Z";
const BUILDER = path.join(HARNESS_ROOT, "crm", "scripts", "build_snapshot.mjs");
const DOC = "https://artifact.example.test/snapshot.html";
const HOST = "https://host.example.test/page";
const DESKTOP = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };
// Anything that looks like an email address (independent of the builder's own pattern).
const EMAIL = /[\w.%+'-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/;

let dir = "";
let html = "";
let meta = null;

function build(args) {
  const r = spawnSync(process.execPath, [BUILDER, ...args], { encoding: "utf8", cwd: dir, timeout: 60000 });
  return { status: r.status, stdout: r.stdout || "", stderr: r.stderr || "" };
}

function write(name, value) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value));
  return file;
}

before(async () => {
  assert.ok(BASE, "run through tests/e2e/run.sh (BASE_URL)");
  fs.mkdirSync(SHOTS, { recursive: true });
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "pgcrm-snapshot-"));
  const c = await apiClient(BASE);
  for (const [name, url] of [["meta", "/api/meta"], ["rows", "/api/partners?v=2"], ["programs", "/api/clients"], ["activity", "/api/team-activity?days=7"]]) {
    const r = await c.call("GET", url);
    assert.equal(r.status, 200, url + " " + r.text.slice(0, 200));
    write(name + ".json", r.text);
  }
  meta = JSON.parse(fs.readFileSync(path.join(dir, "meta.json"), "utf8"));
  const r = build(["--rows", "rows.json", "--meta", "meta.json", "--programs", "programs.json", "--activity", "activity.json",
    "--as-of", AS_OF, "--out", path.join(dir, "snapshot.html")]);
  assert.equal(r.status, 0, "build failed:\n" + r.stderr + r.stdout);
  html = fs.readFileSync(path.join(dir, "snapshot.html"), "utf8");
});

after(async () => {
  await closeBrowser();
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

function embedded(text = html) {
  const m = /<script type="application\/json" id="pg-snapshot-data">([\s\S]*?)<\/script>/.exec(text);
  assert.ok(m, "the snapshot data block is there");
  return JSON.parse(m[1]);
}

// ---------- a browser with the network off ----------

/**
 * A context with the network off. Only DOC (the snapshot) and HOST (a frame host page) are answered; every
 * other request is recorded and aborted. frame: "src" (sandboxed frame loading DOC + hash) or "srcdoc"
 * (sandboxed frame given the HTML as srcdoc). Returns {page, view (page or frame), requests, errors, popups, close}.
 */
async function openSnapshot({ viewport = DESKTOP, hash = "", frame = "", contextOptions = {} } = {}) {
  const b = await browser();
  const context = await b.newContext({ viewport, timezoneId: "UTC", ...contextOptions });
  await context.setOffline(true);
  const requests = [];
  const errors = [];
  const popups = [];
  const hostHtml = '<!doctype html><title>Host</title><body style="margin:0"><iframe id="f" title="Snapshot" sandbox="allow-scripts" ' +
    (frame === "src" ? 'src="' + DOC + hash + '" ' : "") + 'style="display:block;width:100vw;height:100vh;border:0"></iframe></body>';
  const mine = (u) => u.startsWith(DOC) || u.startsWith(HOST);
  await context.route("**/*", (route) => {
    const u = route.request().url();
    if (u.startsWith(HOST)) return route.fulfill({ status: 200, contentType: "text/html", body: hostHtml });
    if (u.startsWith(DOC)) return route.fulfill({ status: 200, contentType: "text/html", body: html });
    return route.abort();
  });
  context.on("request", (r) => { if (!mine(r.url())) requests.push(r.method() + " " + r.url()); });
  context.on("page", (p) => popups.push(p));
  const page = await context.newPage();
  page.on("pageerror", (e) => errors.push("pageerror: " + ((e && e.stack) || e)));
  page.on("console", (m) => { if (m.type() === "error") errors.push("console: " + m.text()); });
  let view = page;
  if (!frame) {
    await page.goto(DOC + hash);
  } else {
    await page.goto(HOST);
    if (frame === "srcdoc") await page.evaluate((h) => { document.getElementById("f").srcdoc = h; }, html);
    view = await (await page.waitForSelector("#f")).contentFrame();
  }
  await view.waitForSelector("[data-snapshot-bar]");
  await view.waitForSelector("main#main h1");
  popups.length = 0; // the context's own first page is not a popup
  return { page, view, requests, errors, popups, close: () => context.close() };
}

// Opens a page with its nav link (sidebar, or bottom tab on a phone), else through the hash.
async function go(view, nav) {
  const link = await view.$('.sh-side a[data-nav="' + nav + '"]:visible, .sh-tabs a[data-nav="' + nav + '"]:visible');
  if (link) await link.click();
  else await view.evaluate((h) => { location.hash = h; }, "#" + nav);
  await view.waitForFunction((p) => {
    const page = document.querySelector("main#main .page");
    return !!page && page.getAttribute("data-page") === p && !!page.querySelector("h1");
  }, nav);
}

const h1 = (view) => view.$eval("main#main h1", (e) => e.textContent.trim());
const text = (view, sel) => view.$eval(sel, (e) => e.textContent.replace(/\s+/g, " ").trim());

// Visible controls that would change data or download a file, and are not disabled.
function writeControls(view) {
  return view.evaluate(() => {
    const LABEL = /^(log what happened|follow up|add site|add contact|add as contact|sent first email|not a fit|save|claim|edit\b|mark .* as handled|dismiss|add terms|add placement|export|use this name)/i;
    const ATTRS = ["data-write", "data-edit", "data-row-act", "data-sel", "data-selall", "data-csv", "data-si-csv", "data-dl-csv", "download"];
    const visible = (el) => {
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none";
    };
    const out = [];
    for (const el of document.querySelectorAll("button, input, select, textarea, a[href], [role=button], [contenteditable]")) {
      if (el.closest("[data-snapshot-bar]") || !visible(el)) continue;
      if (el.disabled || el.getAttribute("aria-disabled") === "true") continue;
      const label = (el.getAttribute("aria-label") || el.textContent || el.value || "").replace(/\s+/g, " ").trim();
      const hit = ATTRS.some((a) => el.hasAttribute(a)) || LABEL.test(label) ||
        el.matches("input[type=checkbox], input[type=radio], [contenteditable]") ||
        /^\s*(mailto|blob|data):/i.test(el.getAttribute("href") || "");
      if (hit) out.push(el.tagName.toLowerCase() + ' "' + label.slice(0, 50) + '"');
    }
    return out;
  });
}

// ---------- the file ----------

test("T34 builds one self-contained page from the fixture's v2 rows", () => {
  assert.match(html, /^<!doctype html>/i);
  assert.ok(Buffer.byteLength(html) < 16 * 1024 * 1024, "under the 16 MB artifact limit");
  assert.doesNotMatch(html, /<link\b/i, "no linked stylesheet, icon or preload");
  assert.doesNotMatch(html, /<script\b[^>]*\bsrc=/i, "no external script");
  assert.doesNotMatch(html, /type=["']?module/i, "classic scripts only (one bundle)");
  assert.doesNotMatch(html, /@import\b|@font-face/i, "no imported CSS and no web font");
  const css = (html.match(/<style\b[^>]*>[\s\S]*?<\/style>/gi) || []).join("\n");
  assert.ok(css.length > 10000, "the styles are inlined");
  assert.deepEqual(css.match(/\burl\(\s*["']?(?!data:)[^)"']+/gi) || [], [], "CSS loads no files");
  const markup = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "").replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "");
  assert.doesNotMatch(markup, /<a\b[^>]*\bdownload\b/i, "no download links in the markup");
  assert.doesNotMatch(markup, /\b(src|href)=/i, "the markup loads nothing and links nowhere");
  assert.doesNotMatch(html, /mailto:/i, "no mailto links anywhere, scripts included");
  const data = embedded();
  const rows = JSON.parse(fs.readFileSync(path.join(dir, "rows.json"), "utf8"));
  assert.equal(data.rows.length, fx.partners.length, "every fixture site is in the snapshot");
  assert.deepEqual(data.cols, rows.cols);
  assert.equal(data.asOf, new Date(AS_OF).toISOString());
  assert.equal(data.meta.read_only, true);
  assert.equal(data.meta.sheet_url, "", "no Google Sheet link");
  assert.equal(data.meta.freshness, null);
  assert.ok(Array.isArray(data.programs) && data.activity && data.activity.by, "programs and team activity are embedded");
});

test("T34 the file holds no email address", () => {
  const m = EMAIL.exec(html);
  assert.equal(m, null, "email-like text in the snapshot: " + (m && m[0]));
  const withEmail = fx.contacts.filter((c) => c.email);
  assert.ok(withEmail.length > 1000, "the fixture has contact emails that could leak");
  for (const c of withEmail) {
    for (const e of String(c.email).split(/\s*[;,]\s*/)) {
      if (e.includes("@")) assert.ok(!html.includes(e) && !html.includes(e.split("@")[0] + "@"), "contact email " + e + " leaked");
    }
  }
});

test("T34 refuses inputs that look like an email address, and --redact-emails hides them", () => {
  const rows = JSON.parse(fs.readFileSync(path.join(dir, "rows.json"), "utf8"));
  const idAt = rows.cols.indexOf("id");
  const next = rows.cols.indexOf("next_step");
  const id = rows.rows[0][idAt];
  const bad = JSON.parse(JSON.stringify(rows));
  bad.rows[0][next] = "Write to jo.smith@partner-site.example.test about the fee";
  write("bad-rows.json", bad);
  const out = path.join(dir, "refused.html");
  let r = build(["--rows", "bad-rows.json", "--meta", "meta.json", "--out", out, "--as-of", AS_OF]);
  assert.equal(r.status, 1, "refused");
  assert.match(r.stderr, /Refusing to build: 1 input value looks like an email address/);
  assert.ok(r.stderr.includes(id + " next_step"), "says where: " + r.stderr);
  assert.ok(!r.stderr.includes("jo.smith@"), "the refusal doesn't print the address");
  assert.equal(fs.existsSync(out), false, "nothing written");

  // A program note and a team-activity name (an object key) are refused too.
  write("bad-programs.json", [{ k: "soro", notes: "Payouts: billing@soro-pay.example.test" }]);
  r = build(["--rows", "rows.json", "--meta", "meta.json", "--programs", "bad-programs.json", "--out", out]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /programs\[0\]\.notes/);
  write("bad-activity.json", { since: AS_OF, days: 7, by: { "kamile@pg.example.test": { total: 1, last_at: AS_OF } } });
  r = build(["--rows", "rows.json", "--meta", "meta.json", "--activity", "bad-activity.json", "--out", out]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /activity\.by \(a key\)/);
  assert.equal(fs.existsSync(out), false);

  // --redact-emails builds, with the address replaced.
  r = build(["--rows", "bad-rows.json", "--meta", "meta.json", "--out", out, "--as-of", AS_OF, "--redact-emails"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /1 email address hidden/);
  const red = fs.readFileSync(out, "utf8");
  assert.equal(EMAIL.exec(red), null);
  const row = embedded(red).rows.find((x) => x[idAt] === id);
  assert.equal(row[next], "Write to (email hidden) about the fee");

  // Inputs that aren't the right bodies are refused with a reason.
  write("v1.json", [["PG-00001", "a.example.test"]]);
  r = build(["--rows", "v1.json", "--out", out]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /GET \/api\/partners\?v=2 body/);
  r = build(["--meta", "meta.json"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /--rows is required/);
});

// ---------- in the browser ----------

test("T34 offline: opens on Today with the snapshot banner, core pages render, 0 network requests", async () => {
  for (const viewport of [DESKTOP, PHONE]) {
    const s = await openSnapshot({ viewport, contextOptions: viewport === PHONE ? { hasTouch: true, isMobile: true } : {} });
    const v = s.view;
    const tag = viewport.width;
    try {
      // No hash in the address: Today, for everyone, with the banner and the picker.
      assert.match(s.page.url(), /#today$/, "landed on Today");
      assert.equal(await h1(v), "Today");
      const day = new Date(AS_OF);
      const wd = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][day.getUTCDay()];
      const mon = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][day.getUTCMonth()];
      const title = "Snapshot of " + wd + " " + day.getUTCDate() + " " + mon + " " + day.getUTCFullYear() + " 12:00, read-only.";
      const banner = await text(v, "[data-snapshot-bar] .sn-text");
      assert.ok(banner.startsWith(title), "banner: " + banner);
      assert.equal(await v.$eval("[data-sn-me]", (e) => e.value), "", "View as: Everyone");
      assert.match(await text(v, "[data-td-sub]"), /· Everyone$/);
      assert.equal(await v.$$eval("[data-banner=readonly]", (els) => els.filter((e) => e.offsetParent).length), 0, "one banner, not two");
      assert.equal(await v.$$eval(".sh-foot", (els) => els.filter((e) => e.offsetParent).length), 0, "no sign-in footer");
      assert.ok(Number((await text(v, "#td-now-h")).replace(/\D+/g, "")) > 0, "Do now has rows");
      await s.page.screenshot({ path: path.join(SHOTS, "snapshot-today-" + tag + ".png") });

      await go(v, "sites");
      assert.equal(await h1(v), "Sites");
      await s.page.screenshot({ path: path.join(SHOTS, "snapshot-sites-" + tag + ".png") });
      await v.evaluate(() => { location.hash = "#sites?tab=all"; });
      await v.waitForFunction(() => /\d/.test((document.querySelector("[data-si-count]") || {}).textContent || ""));
      assert.ok(Number((await text(v, "[data-si-count]")).replace(/\D+/g, "")) > 500, "All sites listed");

      await go(v, "deals");
      assert.equal(await h1(v), "Deals");
      await v.waitForSelector("[data-dl-group]");
      assert.ok((await v.$$("[data-dl-group]")).length >= 3, "deal groups");
      await s.page.screenshot({ path: path.join(SHOTS, "snapshot-deals-" + tag + ".png") });

      await go(v, "clients");
      assert.equal(await h1(v), "Clients");
      await v.waitForFunction((n) => document.querySelector("main#main").textContent.includes(n + " active clients"), (meta.clients || []).length);
      await s.page.screenshot({ path: path.join(SHOTS, "snapshot-clients-" + tag + ".png") });

      await go(v, "team");
      assert.equal(await h1(v), "Team overview");
      await v.waitForFunction(() => /Needs a decision/.test(document.querySelector("main#main").textContent));
      await s.page.screenshot({ path: path.join(SHOTS, "snapshot-team-" + tag + ".png") });

      await go(v, "today");
      assert.equal(await h1(v), "Today");
      assert.deepEqual(s.requests, [], "no network requests");
      assert.deepEqual(s.errors, [], "no errors");
    } finally {
      await s.close();
    }
  }
});

test("T34 every write control is hidden or disabled; no downloads, popups or print", async () => {
  const s = await openSnapshot({ hash: "#today" });
  const v = s.view;
  try {
    await v.selectOption("[data-sn-me]", "Kamile");
    await v.waitForFunction(() => /· Kamile$/.test(document.querySelector("[data-td-sub]").textContent.trim()));
    const found = {};
    const client = (meta.clients || [])[0];
    for (const hash of ["#today", "#sites?tab=mine", "#sites?tab=all", "#deals", "#clients", "#clients/" + client.slug, "#team", "#help"]) {
      await v.evaluate((h) => { location.hash = h; }, hash);
      await v.waitForFunction((p) => {
        const page = document.querySelector("main#main .page");
        return !!page && page.getAttribute("data-page") === p && !!page.querySelector("h1");
      }, hash.slice(1).split(/[/?]/)[0]);
      await v.waitForTimeout(400);
      found[hash] = await writeControls(v);
    }
    // The record panel, opened from Deals.
    await v.evaluate(() => { location.hash = "#deals"; });
    await v.waitForSelector("[data-dl-group] tbody tr a");
    await v.click("[data-dl-group] tbody tr a");
    await v.waitForSelector("#layer-panel [data-pclose]");
    await v.waitForTimeout(300);
    found.panel = await writeControls(v);
    assert.match(await text(v, "#layer-panel [data-plog]"), /Read-only copy\. Open partnergap-crm\.pages\.dev to edit\./);
    assert.equal(await v.$eval("#layer-panel [data-pwait]", (e) => e.disabled), true, "Waiting on client is disabled");
    assert.equal(await v.isVisible("#layer-panel [data-pact=copy-email]"), false, "no Copy email (a snapshot holds no email)");
    for (const [where, list] of Object.entries(found)) assert.deepEqual(list, [], "write controls on " + where);
    await v.keyboard.press("Escape");

    // Keyboard: n (Add site) opens nothing.
    await v.evaluate(() => { location.hash = "#sites?tab=all"; });
    await v.waitForTimeout(300);
    await v.locator("main#main h1").click();
    await v.keyboard.press("n");
    await v.waitForTimeout(300);
    assert.equal(await v.$$eval("dialog[open]", (els) => els.length), 0, "no Add site dialog");
    // window.open and window.print do nothing; a download link is cancelled.
    const res = await v.evaluate(() => {
      const opened = window.open("https://elsewhere.example.test/");
      window.print();
      const a = document.createElement("a");
      a.href = "data:text/plain,x";
      a.download = "x.txt";
      document.body.appendChild(a);
      let prevented = null;
      a.addEventListener("click", (e) => { prevented = e.defaultPrevented; });
      a.click();
      a.remove();
      return { opened, prevented };
    });
    assert.equal(res.opened, null);
    assert.equal(res.prevented, true, "download click cancelled");
    assert.equal(s.popups.length, 0, "no popup or download page");
    assert.deepEqual(s.requests, []);
    assert.deepEqual(s.errors, []);
  } finally {
    await s.close();
  }
});

// The numbers are the live site's, for the same person at the same moment.
test("T34 shows the live site's numbers for the same moment (Kamile)", async () => {
  const live = await signedInPage({ name: "Kamile", clock: AS_OF, contextOptions: { timezoneId: "UTC" } });
  const s = await openSnapshot({ hash: "#today" });
  const read = async (view) => {
    const out = {};
    await view.evaluate(() => { location.hash = "#today"; });
    await view.waitForSelector("#td-now-h");
    out.today = await text(view, "#td-now-h");
    out.badge = await view.$eval(".sh-side [data-badge=today]", (e) => e.textContent.trim());
    await view.evaluate(() => { location.hash = "#sites?tab=all"; });
    await view.waitForFunction(() => /\d/.test((document.querySelector("[data-si-count]") || {}).textContent || ""));
    out.sites = await text(view, "[data-si-count]");
    await view.evaluate(() => { location.hash = "#deals"; });
    await view.waitForSelector("[data-dl-group]");
    out.deals = await view.$$eval("[data-dl-group] h2", (els) => els.map((e) => e.textContent.replace(/\s+/g, " ").trim()));
    await view.evaluate(() => { location.hash = "#clients"; });
    await view.waitForSelector("main#main table tbody tr");
    out.clients = await view.$$eval("main#main table tbody tr", (els) => els.map((e) => e.innerText.replace(/\s+/g, " ").trim()));
    await view.evaluate(() => { location.hash = "#team"; });
    // Changes this week and Last active show "…" until GET /api/team-activity has answered.
    await view.waitForFunction(() => {
      const rows = document.querySelectorAll("main#main table tbody tr");
      return rows.length > 0 && !Array.from(rows).some((r) => r.textContent.includes("…"));
    });
    out.decision = await view.$$eval("main#main h2", (els) => els.map((e) => e.textContent.replace(/\s+/g, " ").trim()).filter((t) => /^Needs a decision/.test(t)));
    out.team = await view.$$eval("main#main table tbody tr", (els) => els.map((e) => e.innerText.replace(/\s+/g, " ").trim()));
    return out;
  };
  try {
    await s.view.selectOption("[data-sn-me]", "Kamile");
    const want = await read(live.page);
    const got = await read(s.view);
    assert.deepEqual(got, want);
    assert.match(got.today, /^Do now \(\d+\)/);
    assert.deepEqual(s.requests, []);
    assert.deepEqual(s.errors, []);
  } finally {
    await s.close();
    await live.close();
  }
});

test("T34 in a sandboxed frame: storage throws, the picker keeps the name in memory, #links route in place", async () => {
  const s = await openSnapshot({ frame: "src", hash: "#deals" });
  const v = s.view;
  try {
    assert.equal(await h1(v), "Deals", "a #hash in the frame's address opens that page");
    assert.match(await v.evaluate(() => { try { localStorage.getItem("pgcrm-me"); return "ok"; } catch (e) { return "throws " + e.name; } }), /^throws/);
    await v.selectOption("[data-sn-me]", "Jonas");
    await go(v, "today");
    assert.match(await text(v, "[data-td-sub]"), /· Jonas$/);
    await go(v, "sites");
    await go(v, "today");
    assert.match(await text(v, "[data-td-sub]"), /· Jonas$/, "the name is kept while storage is blocked");
    assert.equal(await v.$eval("[data-sn-me]", (e) => e.value), "Jonas");
    assert.match(v.url(), /#today$/);
    await s.page.screenshot({ path: path.join(SHOTS, "snapshot-frame-1440.png") });
    assert.deepEqual(s.requests, []);
    assert.deepEqual(s.errors, []);
  } finally {
    await s.close();
  }

  // An about:srcdoc frame can't rewrite its URL with history.pushState, and its #links resolve against the
  // host page: the prelude keeps routing in place.
  const d = await openSnapshot({ frame: "srcdoc" });
  try {
    assert.equal(await h1(d.view), "Today");
    for (const nav of ["team", "clients", "deals", "today"]) {
      await go(d.view, nav);
      assert.equal(await d.view.evaluate(() => location.hash), "#" + nav);
    }
    assert.deepEqual(d.requests, []);
    assert.deepEqual(d.errors, []);
  } finally {
    await d.close();
  }
});
