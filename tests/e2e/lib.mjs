// Shared e2e helpers (spec 7.1 G1-D, spec 8). Owner G1-D.
//
// What tests get from here:
//   - tools(), baseUrl(), loadPlaywright()                       tool paths and the server run.sh started
//   - startServer(opts) -> server                                 a fixture server of your own (T29: {extra: false})
//   - d1(sql), d1All(sql), listTables()                           local D1 through `wrangler d1 execute --local --json`
//   - api(method, url, body) / apiClient()                        signed-in HTTP calls from Node (no browser)
//   - signedInPage(opts), signIn(page), watchPage(page), fixClock(page, when), pageFetch(page, ...)
//   - fixture(), loadGolden(name), matchGolden(...), assertGolden(...), editsAfter(n), maxEditN(), applyBefore(before)
//
// Command line (run.sh calls this; see run.sh for the flags):
//   node tests/e2e/lib.mjs run [--root DIR] [--bare] [--serve] [files...]
//
// Rules this file enforces: local D1 only (never --remote), never port 8788, a free port and a unique
// inspector port for every server, a fresh mktemp -d persist dir, and every server it starts is stopped.
import { createRequire } from "node:module";
import { spawn, execFile } from "node:child_process";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildFixture, seedSql, OPTIONAL_TABLES, localToday } from "../fixtures/make-seed.mjs";

export const HARNESS_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const GOLDEN_DIR = path.join(HARNESS_ROOT, "tests", "e2e", "golden");
export const PASSWORD = "testpass";
const MAIN_PORT = 8788; // the main checkout's dev server: never ours
const MIGRATIONS = ["001_base.sql", "003_site_meta.sql", "004_suggestions_runs.sql"];

// ---------- tools ----------

export function tools() {
  return {
    wrangler: process.env.WRANGLER_BIN || "/tmp/wtest/node_modules/.bin/wrangler",
    playwright: process.env.PW_PATH || "/opt/node22/lib/node_modules/playwright",
    chrome: process.env.CHROME || "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
    axe: process.env.AXE_PATH ||
      "/tmp/claude-0/-home-claude-partnergapcrm/747cd0be-8b1d-5f07-83a7-c4a3d39a6045/scratchpad/redesign/audit/tools/node_modules/axe-core/axe.min.js",
  };
}

/** Missing tools, as readable lines (empty when everything is there). */
export function missingTools() {
  const t = tools(), out = [];
  const exec = (p) => { try { fs.accessSync(p, fs.constants.X_OK); return true; } catch (e) { return false; } };
  if (!exec(t.wrangler)) out.push("WRANGLER_BIN not found or not executable: " + t.wrangler);
  if (!fs.existsSync(t.playwright)) out.push("PW_PATH not found: " + t.playwright);
  if (!exec(t.chrome)) out.push("CHROME not found or not executable: " + t.chrome);
  if (!fs.existsSync(t.axe)) out.push("AXE_PATH not found: " + t.axe);
  return out;
}

export function baseUrl() {
  return process.env.BASE_URL || "";
}

// Playwright 1.56 is installed globally, not in this repo: load it from PW_PATH.
export function loadPlaywright() {
  const dir = tools().playwright;
  return createRequire(path.join(dir, "package.json"))(dir);
}

/** The run's fixture (same `today` as the seed run.sh wrote). */
export function fixture({ today } = {}) {
  return buildFixture({ today: today || process.env.FIXTURE_TODAY || localToday() });
}

// ---------- local D1 ----------

function wranglerEnv(extra = {}) {
  return { ...process.env, WRANGLER_SEND_METRICS: "false", ...extra };
}

function noRemote(args) {
  if (args.some((a) => /^--remote\b/.test(String(a)))) throw new Error("e2e: --remote is not allowed; tests use local D1 only.");
}

function d1Target(opts = {}) {
  const persistDir = opts.persistDir || process.env.PERSIST_DIR;
  const root = opts.root || process.env.SERVE_ROOT || HARNESS_ROOT;
  if (!persistDir) throw new Error("e2e: no persist dir (run through tests/e2e/run.sh, or pass {persistDir}).");
  return { persistDir, root };
}

function runWrangler(args, { cwd, timeout = 120000 } = {}) {
  noRemote(args);
  return new Promise((resolve, reject) => {
    execFile(tools().wrangler, args, { cwd, env: wranglerEnv(), maxBuffer: 256 * 1024 * 1024, timeout }, (err, stdout, stderr) => {
      if (err) {
        err.message += "\n" + String(stderr || "").slice(-4000) + "\n" + String(stdout || "").slice(-4000);
        reject(err);
      } else resolve({ stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

function parseJsonOutput(stdout) {
  // wrangler may print a notice line (for example about proxies) before the JSON.
  const i = stdout.search(/^[[{]/m);
  if (i < 0) throw new Error("e2e: wrangler printed no JSON:\n" + stdout.slice(0, 2000));
  return JSON.parse(stdout.slice(i));
}

/**
 * Runs SQL (or a file) on the local D1 of a fixture server; returns one entry per statement:
 * [{results, success, meta}]. Defaults to the server run.sh started (PERSIST_DIR, SERVE_ROOT).
 *
 * wrangler 4.40 prints SQL NULL as the string "null" in --json output. d1All turns every "null" string
 * back into null (pass {rawNulls: true} to keep them). Where a real "null" string must stay apart from
 * NULL, select json_object(...) and parse it, as editsAfter() does.
 *
 * The CLI opens the same SQLite file as the running dev server, so a call can meet the server's lock
 * and fail at once with SQLITE_BUSY ("database is locked"): workerd does not wait for it. Such a call is
 * retried (up to 6 more times, 0.4 s longer each time). miniflare runs all the statements of one call in
 * one transaction (transactionSync), so a call that failed this way wrote nothing and is safe to repeat.
 */
export async function d1All(sql, opts = {}) {
  const { persistDir, root } = d1Target(opts);
  const args = ["d1", "execute", "PARTNERS_DB", "--local", "--persist-to", persistDir, "--json"];
  if (opts.file) args.push("--file", path.resolve(opts.file));
  else args.push("--command", sql);
  let stdout = "";
  for (let i = 0; ; i++) {
    try {
      ({ stdout } = await runWrangler(args, { cwd: root }));
      break;
    } catch (e) {
      if (i >= 6 || !/SQLITE_BUSY|database is locked/i.test(String(e && e.message))) throw e;
      await new Promise((r) => setTimeout(r, 400 * (i + 1)));
    }
  }
  let out = parseJsonOutput(stdout);
  out = Array.isArray(out) ? out : [out];
  if (!opts.rawNulls) {
    for (const st of out) for (const row of st.results || []) for (const k of Object.keys(row)) if (row[k] === "null") row[k] = null;
  }
  return out;
}

/** Runs SQL on the local D1 and returns the result rows of the last statement. */
export async function d1(sql, opts = {}) {
  const all = await d1All(sql, opts);
  const last = all[all.length - 1];
  return (last && last.results) || [];
}

export async function listTables(opts = {}) {
  const rows = await d1("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name", opts);
  return rows.map((r) => r.name);
}

export function sqlLit(v) {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "number") return String(v);
  if (typeof v === "boolean") return v ? "1" : "0";
  return "'" + String(v).replace(/'/g, "''") + "'";
}

/** True when a migration file holds at least one statement (G0 stubs hold only comments). */
export function hasStatements(file) {
  if (!fs.existsSync(file)) return false;
  return fs.readFileSync(file, "utf8").split("\n").some((l) => l.replace(/--.*$/, "").trim() !== "");
}

/** Migration files to apply, in order: 001, then 003 and 004 unless extra is false. */
export function migrationFiles({ extra = true, dir = path.join(HARNESS_ROOT, "crm", "scripts", "migrations"), only } = {}) {
  const names = only || (extra ? MIGRATIONS : MIGRATIONS.slice(0, 1));
  return names.map((n) => path.join(dir, n.endsWith(".sql") ? n : MIGRATIONS.find((m) => m.startsWith(n)) || n)).filter(hasStatements);
}

// ---------- servers ----------

export function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.unref();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

const live = new Set();
let exitHook = false;
function guardExit() {
  if (exitHook) return;
  exitHook = true;
  // Last resort if a test process dies without calling stop(): kill every server group we started.
  process.on("exit", () => {
    for (const pid of live) { try { process.kill(-pid, "SIGKILL"); } catch (e) { /* gone */ } }
  });
}

function waitExit(child, ms) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(false), ms);
    child.once("exit", () => { clearTimeout(t); resolve(true); });
  });
}

/**
 * Starts a fixture server: free port, unique inspector port, fresh mktemp -d persist dir,
 * migrations 001 -> 003 -> 004 (003/004 only with extra, and only when the files hold SQL),
 * the synthetic seed, and `wrangler pages dev` with DASHBOARD_PASSWORD=testpass.
 *
 * @param {object} [o]
 * @param {string} [o.root]     checkout to serve (functions/, crm/dashboard, wrangler.toml); default SERVE_ROOT or this repo
 * @param {boolean} [o.extra]   apply 003/004 (default true; false for T29). Env BARE=1 flips the default.
 * @param {boolean} [o.seed]    load the fixture (default true; env NO_SEED=1 flips it)
 * @param {string} [o.today]    fixture day (default FIXTURE_TODAY or the local date)
 * @param {boolean} [o.keep]    keep the persist dir after stop() (default env KEEP=1)
 * @param {number} [o.port]     fixed port (default a free one; never 8788)
 */
export async function startServer(o = {}) {
  const t = tools();
  const root = path.resolve(o.root || process.env.SERVE_ROOT || HARNESS_ROOT);
  const extra = o.extra !== undefined ? o.extra : process.env.BARE !== "1";
  const seed = o.seed !== undefined ? o.seed : process.env.NO_SEED !== "1";
  const today = o.today || process.env.FIXTURE_TODAY || localToday();
  const keep = o.keep !== undefined ? o.keep : process.env.KEEP === "1";
  if (!fs.existsSync(path.join(root, "wrangler.toml"))) throw new Error("e2e: no wrangler.toml in " + root);
  const port = Number(o.port || (await freePort()));
  let inspectorPort = Number(o.inspectorPort || (await freePort()));
  while (inspectorPort === port) inspectorPort = await freePort();
  if (port === MAIN_PORT || inspectorPort === MAIN_PORT) throw new Error("e2e: port 8788 belongs to the main dev server; pick another.");
  const persistDir = o.persistDir || fs.mkdtempSync(path.join(os.tmpdir(), "pgcrm-e2e-"));
  const target = { persistDir, root };

  const server = {
    root, port, inspectorPort, persistDir, today, extra,
    baseUrl: "http://127.0.0.1:" + port,
    tables: [],
    log: path.join(persistDir, "wrangler.log"),
    pid: null,
    d1: (sql, opts = {}) => d1(sql, { ...target, ...opts }),
    d1All: (sql, opts = {}) => d1All(sql, { ...target, ...opts }),
    async applyMigrations(names) {
      for (const f of migrationFiles({ only: names })) await d1All(null, { ...target, file: f });
      server.tables = await listTables(target);
      return server.tables;
    },
    /** Inserts the fixture rows of optional tables that exist now (after 003/004 were applied late). */
    async seedOptional() {
      const tables = (await listTables(target)).filter((n) => OPTIONAL_TABLES.includes(n));
      if (!tables.length) return [];
      const file = path.join(persistDir, "seed-optional.sql");
      fs.writeFileSync(file, seedSql(buildFixture({ today }), { tables, base: false }));
      await d1All(null, { ...target, file });
      return tables;
    },
    env() {
      return {
        BASE_URL: server.baseUrl, PORT: String(port), INSPECTOR_PORT: String(inspectorPort), PERSIST_DIR: persistDir,
        SERVE_ROOT: root, HARNESS_ROOT, FIXTURE_TODAY: today, D1_TABLES: server.tables.join(","),
        DASHBOARD_PASSWORD: PASSWORD, WRANGLER_BIN: t.wrangler, PW_PATH: t.playwright, CHROME: t.chrome, AXE_PATH: t.axe,
        OUT_DIR: path.join(HARNESS_ROOT, "tests", "e2e", "out"),
      };
    },
    async stop() {
      if (server._stopped) return;
      server._stopped = true;
      const child = server._child;
      if (child && child.pid) {
        try { process.kill(-child.pid, "SIGTERM"); } catch (e) { /* already gone */ }
        if (!(await waitExit(child, 8000))) { try { process.kill(-child.pid, "SIGKILL"); } catch (e) { /* gone */ } await waitExit(child, 3000); }
        live.delete(child.pid);
      }
      if (!keep && !o.persistDir) fs.rmSync(persistDir, { recursive: true, force: true });
    },
  };

  try {
    for (const f of migrationFiles({ extra })) await d1All(null, { ...target, file: f });
    server.tables = await listTables(target);
    if (seed) {
      const optional = server.tables.filter((n) => OPTIONAL_TABLES.includes(n));
      const file = path.join(persistDir, "seed.sql");
      fs.writeFileSync(file, seedSql(buildFixture({ today }), { tables: optional }));
      await d1All(null, { ...target, file });
    }
    guardExit();
    const out = fs.openSync(server.log, "a");
    const args = ["pages", "dev", "crm/dashboard", "--ip", "127.0.0.1", "--port", String(port), "--inspector-port", String(inspectorPort),
      "--persist-to", persistDir, "--binding", "DASHBOARD_PASSWORD=" + PASSWORD];
    noRemote(args);
    // detached: wrangler and its workerd children get their own process group, so stop() ends them all.
    const child = spawn(t.wrangler, args, { cwd: root, detached: true, stdio: ["ignore", out, out], env: wranglerEnv() });
    fs.closeSync(out);
    server._child = child;
    server.pid = child.pid;
    live.add(child.pid);
    await waitReady(server, child);
  } catch (e) {
    await server.stop();
    throw e;
  }
  return server;
}

async function waitReady(server, child, ms = 90000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (child.exitCode !== null || child.signalCode !== null) break;
    try {
      const r = await fetch(server.baseUrl + "/login", { redirect: "manual", signal: AbortSignal.timeout(2000) });
      await r.arrayBuffer();
      if (r.status === 200) return;
    } catch (e) { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 400));
  }
  let tail = "";
  try { tail = fs.readFileSync(server.log, "utf8").split("\n").slice(-40).join("\n"); } catch (e) { /* no log */ }
  throw new Error("e2e: the dev server did not start on " + server.baseUrl + "\n" + tail);
}

// ---------- HTTP from Node (no browser) ----------

/**
 * Signs in once with the shared password and returns a client whose call() sends the session cookie.
 * Writes pass the same-origin check because Node's fetch sends no Origin header.
 */
export async function apiClient(base = baseUrl(), { password = PASSWORD, name } = {}) {
  if (!base) throw new Error("e2e: no BASE_URL");
  const post = async (extra) => {
    const form = new URLSearchParams({ password, next: "/", ...extra });
    const res = await fetch(base + "/login", { method: "POST", body: form, redirect: "manual" });
    await res.arrayBuffer();
    return res;
  };
  // Without a name the form has no "who" field (an API client). A name off the team list goes in as
  // "Someone else" (who=__other, who_other=name), as the sign-in form sends it.
  let r = await post(name ? { who: name } : {});
  if (name && r.status === 400) r = await post({ who: "__other", who_other: name });
  const cookie = r.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  if (!/pg_session=/.test(cookie)) throw new Error("e2e: sign-in failed (" + r.status + ")");
  const client = {
    base, cookie,
    async call(method, url, body, headers = {}) {
      const init = { method, redirect: "manual", headers: { Cookie: cookie, ...headers } };
      if (body !== undefined) { init.body = typeof body === "string" ? body : JSON.stringify(body); init.headers["Content-Type"] = "application/json"; }
      const res = await fetch(base + url, init);
      const text = await res.text();
      let json;
      try { json = JSON.parse(text); } catch (e) { json = undefined; }
      return { status: res.status, headers: res.headers, type: res.headers.get("content-type") || "", text, json };
    },
  };
  return client;
}

let sharedClient = null;
/** One signed-in call against BASE_URL: api("PATCH", "/api/partner/PG-00001", {by, fields}). */
export async function api(method, url, body, headers) {
  if (!sharedClient || sharedClient.base !== baseUrl()) sharedClient = await apiClient(baseUrl());
  return sharedClient.call(method, url, body, headers);
}

// ---------- browser ----------

let browserPromise = null;

/** One Chromium per test process (closed by closeBrowser() or at exit). */
export function browser() {
  if (!browserPromise) browserPromise = loadPlaywright().chromium.launch({ executablePath: tools().chrome });
  return browserPromise;
}

export async function closeBrowser() {
  if (!browserPromise) return;
  const b = await browserPromise.catch(() => null);
  browserPromise = null;
  if (b) await b.close();
}

/**
 * Collects what a page reports: uncaught errors, console errors, and failed requests (status >= 400, or
 * no response). Requests the browser aborts because the page navigated away (net::ERR_ABORTED) are left
 * out unless keepAborted is set. Returns {pageErrors, consoleErrors, failed, clear()}.
 */
export function watchPage(page, { keepAborted = false } = {}) {
  const w = { pageErrors: [], consoleErrors: [], failed: [] };
  page.on("pageerror", (e) => w.pageErrors.push(String((e && e.stack) || e)));
  page.on("console", (m) => { if (m.type() === "error") w.consoleErrors.push({ text: m.text(), url: (m.location() || {}).url || "" }); });
  page.on("response", (r) => { if (r.status() >= 400) w.failed.push({ url: r.url(), status: r.status(), method: r.request().method() }); });
  page.on("requestfailed", (r) => {
    const error = (r.failure() || {}).errorText || "";
    if (keepAborted || !/ERR_ABORTED/.test(error)) w.failed.push({ url: r.url(), status: 0, method: r.method(), error });
  });
  w.clear = () => { w.pageErrors.length = 0; w.consoleErrors.length = 0; w.failed.length = 0; };
  return w;
}

/**
 * Fixes the page clock (call before the first goto). `when` is a Date, an ISO string or a number.
 * mode 'fixed' (default): Date is frozen, timers run. mode 'install': Playwright's fake clock from `when`.
 */
export async function fixClock(page, when, { mode = "fixed" } = {}) {
  const t = when instanceof Date ? when : new Date(when);
  if (Number.isNaN(t.getTime())) throw new Error("e2e: bad clock time " + when);
  if (mode === "install") await page.clock.install({ time: t });
  else await page.clock.setFixedTime(t);
}

/**
 * Signs a page in through the real /login form. With `name`, the pg_me cookie is set first (spec 6.3.14 format)
 * and that name is picked in the form's "Your name" select (or typed after "Someone else" when it is not
 * on the team list). Without `name` the page signs in like an API client: the form is posted without a
 * name (no pg_me), then `next` is opened.
 */
export async function signIn(page, { base = baseUrl(), name, password = PASSWORD, next = "/" } = {}) {
  if (!name) {
    const r = await page.request.post(base + "/login", { form: { password, next }, maxRedirects: 0 });
    if (r.status() !== 303) throw new Error("e2e: sign-in failed (" + r.status() + ")");
    await page.goto(base + next);
    return;
  }
  await page.context().addCookies([{ name: "pg_me", value: encodeURIComponent(name), url: base }]);
  await page.goto(base + "/login?next=" + encodeURIComponent(next));
  await page.fill('input[name="password"]', password);
  const who = await page.$('select[name="who"]');
  if (who) {
    const values = await who.$$eval("option", (os) => os.map((o) => ({ v: o.value, t: o.textContent.trim() })));
    const hit = values.find((o) => o.v === name || o.t === name);
    if (hit) await who.selectOption(hit.v);
    else {
      const other = values.find((o) => /someone else/i.test(o.t));
      if (other) { await who.selectOption(other.v); await page.fill('input[name="who_other"]', name); }
    }
  }
  await Promise.all([
    page.waitForURL((u) => !/\/login$/.test(new URL(u).pathname), { timeout: 15000 }),
    page.click('button[type="submit"]'),
  ]);
}

/**
 * A new browser context and page, signed in. Options: name (me), viewport, clock (fixed time before load),
 * colorScheme, contextOptions. Returns {context, page, watch, close()}.
 */
export async function signedInPage({ base = baseUrl(), name, viewport = { width: 1440, height: 900 }, clock, clockMode, colorScheme,
  contextOptions = {}, next = "/" } = {}) {
  const b = await browser();
  const context = await b.newContext({ viewport, colorScheme, ...contextOptions });
  const page = await context.newPage();
  const watch = watchPage(page);
  if (clock) await fixClock(page, clock, { mode: clockMode });
  await signIn(page, { base, name, next });
  return { context, page, watch, close: () => context.close() };
}

/** Same-origin fetch from inside a signed-in page (the browser sends the Secure session cookie). */
export async function pageFetch(page, method, url, body) {
  return page.evaluate(async ([m, u, d]) => {
    const init = { method: m, credentials: "same-origin", headers: {} };
    if (d !== undefined) { init.body = JSON.stringify(d); init.headers["Content-Type"] = "application/json"; }
    const r = await fetch(u, init);
    const text = await r.text();
    let json; try { json = JSON.parse(text); } catch (e) { json = undefined; }
    return { status: r.status, type: r.headers.get("content-type") || "", text, json };
  }, [method, url, body]);
}

// ---------- golden files and the edits contract ----------

/** The edits columns a golden row keeps (everything except n and at). */
export const EDIT_KEYS = ["by_whom", "kind", "account_id", "contact_id", "field", "old", "new", "applied"];

export function stripEdit(row) {
  const out = {};
  for (const k of EDIT_KEYS) out[k] = row[k] === undefined ? null : row[k];
  return out;
}

export function loadGolden(name) {
  const file = path.join(GOLDEN_DIR, name.endsWith(".json") ? name : name + ".json");
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

/** One case of a golden file by name: goldenCase("patch-partner", "interested"). */
export function goldenCase(file, name) {
  const g = loadGolden(file);
  const c = g.cases.find((x) => x.name === name);
  if (!c) throw new Error("e2e: no case " + name + " in golden " + file);
  return c;
}

export async function maxEditN(opts = {}) {
  const rows = await d1("SELECT COALESCE(MAX(n), 0) AS n FROM edits", opts);
  return rows[0].n;
}

const EDIT_COLS = ["n", "at", ...EDIT_KEYS];

/** edits rows with n > after, in n order (exact: NULL and the string "null" stay apart). */
export async function editsAfter(after, opts = {}) {
  const obj = "json_object(" + EDIT_COLS.map((c) => "'" + c + "', " + c).join(", ") + ")";
  const rows = await d1("SELECT " + obj + " AS j FROM edits WHERE n > " + Number(after) + " ORDER BY n", { ...opts, rawNulls: true });
  return rows.map((r) => JSON.parse(r.j));
}

/** Puts partners rows into a golden case's `before` state ({id: {column: value}}). */
export async function applyBefore(before, opts = {}) {
  const stmts = [];
  for (const [id, cols] of Object.entries(before || {})) {
    const set = Object.entries(cols).map(([k, v]) => k + " = " + sqlLit(v));
    if (set.length) stmts.push("UPDATE partners SET " + set.join(", ") + " WHERE id = " + sqlLit(id));
  }
  if (stmts.length) await d1All(stmts.join(";\n") + ";", opts);
}

// Tokens in golden values. Each matches a pattern; one token name binds one value across a case.
//   {{today}}           the server's UTC date when the request ran (YYYY-MM-DD)
//   {{at}}              a timestamp YYYY-MM-DDTHH:MM:SSZ (only in responses; edits rows drop `at`)
//   {{activity_n}}      the activity row's n (edits.field of an activity row is this, as text)
//   {{new_account_id}}  the NEW-nnnn id Add site picked
//   {{new_contact_id}}  the NEWC-nnnn id Add contact picked
export const TOKENS = {
  today: "\\d{4}-\\d{2}-\\d{2}",
  at: "\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}Z",
  activity_n: "\\d+",
  new_account_id: "NEW-\\d{4}",
  new_contact_id: "NEWC-\\d{4}",
};
const TOKEN_RE = /\{\{([a-z_]+)\}\}/g;
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function matchString(exp, act, vars, where, errors) {
  const names = [];
  let pattern = "", last = 0, m;
  TOKEN_RE.lastIndex = 0;
  while ((m = TOKEN_RE.exec(exp))) {
    pattern += escapeRe(exp.slice(last, m.index)) + "(" + (TOKENS[m[1]] || "[\\s\\S]*?") + ")";
    names.push(m[1]);
    last = m.index + m[0].length;
  }
  if (!names.length) {
    if (exp !== act) errors.push(where + ": expected " + JSON.stringify(exp) + ", got " + JSON.stringify(act));
    return;
  }
  pattern += escapeRe(exp.slice(last));
  const hit = new RegExp("^" + pattern + "$").exec(act);
  if (!hit) { errors.push(where + ": expected " + JSON.stringify(exp) + ", got " + JSON.stringify(act)); return; }
  names.forEach((n, i) => {
    const v = hit[i + 1];
    if (n in vars && String(vars[n]) !== v) errors.push(where + ": {{" + n + "}} is " + JSON.stringify(v) + " here but " + JSON.stringify(vars[n]) + " elsewhere");
    else vars[n] = v;
  });
}

function matchValue(exp, act, vars, where, errors, extraKeys) {
  if (exp === null) { if (act !== null && act !== undefined) errors.push(where + ": expected null, got " + JSON.stringify(act)); return; }
  if (typeof exp === "string") {
    if (typeof act === "number" && /^\{\{[a-z_]+\}\}$/.test(exp)) act = String(act);
    if (typeof act !== "string") { errors.push(where + ": expected string " + JSON.stringify(exp) + ", got " + JSON.stringify(act)); return; }
    matchString(exp, act, vars, where, errors);
    return;
  }
  if (typeof exp !== "object") { if (exp !== act) errors.push(where + ": expected " + JSON.stringify(exp) + ", got " + JSON.stringify(act)); return; }
  if (Array.isArray(exp)) {
    if (!Array.isArray(act)) { errors.push(where + ": expected an array, got " + JSON.stringify(act)); return; }
    if (exp.length !== act.length) errors.push(where + ": expected " + exp.length + " items, got " + act.length);
    for (let i = 0; i < Math.min(exp.length, act.length); i++) matchValue(exp[i], act[i], vars, where + "[" + i + "]", errors, extraKeys);
    return;
  }
  if (!act || typeof act !== "object" || Array.isArray(act)) { errors.push(where + ": expected an object, got " + JSON.stringify(act)); return; }
  for (const k of Object.keys(exp)) {
    if (!(k in act)) errors.push(where + "." + k + ": missing");
    else matchValue(exp[k], act[k], vars, where + "." + k, errors, extraKeys);
  }
  if (!extraKeys) for (const k of Object.keys(act)) if (!(k in exp)) errors.push(where + "." + k + ": unexpected key");
}

/**
 * Compares actual values with golden ones. Strings may hold tokens (TOKENS above); `vars` pre-binds them
 * (for example {today, activity_n}) and comes back filled in. extraKeys: allow keys the golden lacks
 * (for responses, which may gain fields such as "v2"). Returns {ok, errors, vars}.
 */
export function matchGolden(expected, actual, { vars = {}, extraKeys = false, where = "$" } = {}) {
  const errors = [];
  const v = { ...vars };
  matchValue(expected, actual, v, where, errors, extraKeys);
  return { ok: errors.length === 0, errors, vars: v };
}

/** Throws with a readable diff when actual edits rows (or a response) differ from the golden ones. */
export function assertGolden(expected, actual, opts = {}) {
  const rows = Array.isArray(actual) && actual.length && actual[0] && "kind" in actual[0] ? actual.map(stripEdit) : actual;
  const r = matchGolden(expected, rows, opts);
  if (!r.ok) {
    assert.fail((opts.message ? opts.message + "\n" : "") + r.errors.join("\n") + "\nactual: " + JSON.stringify(rows, null, 1));
  }
  return r.vars;
}

/** Sorts edits rows by account_id, then field (bulk ids mode is set-based, so its row order is not part of the contract). */
export function sortEdits(rows) {
  return rows.slice().sort((a, b) => String(a.account_id).localeCompare(String(b.account_id)) || String(a.field).localeCompare(String(b.field)));
}

/**
 * Replays one golden case on a fixture server and compares: the status, the edits rows (exact, minus n/at)
 * and the response (golden keys must match; extra keys such as "v2" are allowed).
 * Puts the case's `before` state in place first, so earlier tests that touched the row do not matter.
 * @param c        a case from loadGolden(file).cases
 * @param o.client an apiClient() (default: the shared one on BASE_URL)
 * @param o.target {persistDir, root} of the server (default: the run.sh server)
 * @param o.order  "request" (default) or "any" (bulk: rows compared after sortEdits)
 * @param o.vars   pre-bound tokens, e.g. {today}
 * @returns {ok, errors, rows, response, vars}
 */
export async function replayCase(c, { client, target = {}, order = "request", vars = {} } = {}) {
  const stmts = [];
  for (const [id, cols] of Object.entries(c.before || {})) {
    const set = Object.entries(cols).map(([k, v]) => k + " = " + sqlLit(v));
    if (set.length) stmts.push("UPDATE partners SET " + set.join(", ") + " WHERE id = " + sqlLit(id));
  }
  stmts.push("SELECT COALESCE(MAX(n), 0) AS n FROM edits");
  const pre = await d1All(stmts.join(";\n") + ";", target);
  const max = pre[pre.length - 1].results[0].n;
  const call = client ? client.call.bind(client) : api;
  const res = await call(c.request.method, c.request.url, c.request.body);
  const rows = (await editsAfter(max, target)).map(stripEdit);
  const errors = [];
  if (res.status !== c.status) errors.push("status: expected " + c.status + ", got " + res.status + " " + res.text.slice(0, 300));
  const any = order === "any" || /^any/.test(String(order));
  const m1 = matchGolden(any ? sortEdits(c.edits) : c.edits, any ? sortEdits(rows) : rows, { vars, where: "edits" });
  const m2 = matchGolden(c.response, res.json === undefined ? res.text : res.json, { vars: m1.vars, extraKeys: true, where: "response" });
  errors.push(...m1.errors, ...m2.errors);
  return { ok: errors.length === 0, errors, rows, response: res, vars: m2.vars };
}

// ---------- command line: node tests/e2e/lib.mjs run ... ----------

async function cliRun(argv) {
  const opts = { root: process.env.ROOT || undefined, extra: process.env.BARE === "1" ? false : undefined, serve: false };
  const files = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (/^--remote\b/.test(a)) { console.error("run.sh: --remote is not allowed; tests use local D1 only."); return 2; }
    if (a === "--root") opts.root = argv[++i];
    else if (a.startsWith("--root=")) opts.root = a.slice(7);
    else if (a === "--bare") opts.extra = false;
    else if (a === "--serve") opts.serve = true;
    else if (a === "--keep") opts.keep = true;
    else if (a.startsWith("--")) { console.error("run.sh: unknown flag " + a); return 2; }
    else files.push(path.resolve(a));
  }
  const missing = missingTools();
  if (missing.length) { console.error(missing.map((l) => "run.sh: " + l).join("\n")); return 3; }
  if (process.env.PORT && Number(process.env.PORT) === MAIN_PORT) { console.error("run.sh: port 8788 belongs to the main dev server; pick another."); return 2; }

  let server = null, child = null, stopping = false;
  const stopAll = async (code) => {
    if (stopping) return;
    stopping = true;
    if (child && child.exitCode === null) { try { child.kill("SIGTERM"); } catch (e) { /* gone */ } }
    if (server) await server.stop();
    process.exit(code);
  };
  process.on("SIGINT", () => stopAll(130));
  process.on("SIGTERM", () => stopAll(143));

  try {
    server = await startServer({ root: opts.root, extra: opts.extra, keep: opts.keep, port: process.env.PORT ? Number(process.env.PORT) : undefined,
      inspectorPort: process.env.INSPECTOR_PORT ? Number(process.env.INSPECTOR_PORT) : undefined });
  } catch (e) {
    console.error("run.sh: " + (e && e.message));
    return 5;
  }
  const env = { ...process.env, ...server.env() };
  fs.mkdirSync(env.OUT_DIR, { recursive: true });
  console.error("run.sh: server on " + server.baseUrl + " (inspector " + server.inspectorPort + ", persist " + server.persistDir +
    ", root " + server.root + ", tables " + server.tables.join(",") + ", fixture day " + server.today + ")");
  if (server.keep || opts.keep || process.env.KEEP === "1") console.error("run.sh: keeping " + server.persistDir);

  if (opts.serve) {
    for (const [k, v] of Object.entries(server.env())) console.log(k + "=" + v);
    console.error("run.sh: serving until Ctrl-C");
    await new Promise(() => {});
  }

  let list = files;
  if (!list.length) {
    const dir = path.join(HARNESS_ROOT, "tests", "e2e");
    list = fs.readdirSync(dir).filter((f) => f.endsWith(".test.mjs")).sort().map((f) => path.join(dir, f));
  }
  if (!list.length) { console.error("run.sh: no test files"); await stopAll(0); return 0; }
  child = spawn(process.execPath, ["--test", "--test-concurrency=1", ...list], { stdio: "inherit", env, cwd: HARNESS_ROOT });
  const code = await new Promise((resolve) => child.on("exit", (c, sig) => resolve(c === null ? (sig ? 1 : 0) : c)));
  await stopAll(code);
  return code;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]) && process.argv[2] === "run") {
  cliRun(process.argv.slice(3)).then((code) => process.exit(code), (e) => { console.error(e); process.exit(1); });
}
