#!/usr/bin/env node
// Snapshot builder (spec 4.14, 7.3 G3-6): one read-only, self-contained HTML file for the dashboard
// artifact and the Friday digest. Owner G3-6. Docs: crm/docs/snapshot.md.
//
// The file inlines every stylesheet in index.html's order (no web font: the system fallback in --font),
// bundles every js/ module into one classic script with the mini-bundler (scripts/snapshot/bundle.mjs,
// spec 5.1), swaps core/api.js for scripts/snapshot/api.js (rows from memory, null for everything else,
// every write refused) and embeds window.__SNAPSHOT__ = {builtAt, asOf, meta, cols, rows, programs?, activity?}.
//
//   node crm/scripts/build_snapshot.mjs --rows partners.json [--meta meta.json] [--programs clients.json]
//        [--activity team-activity.json] [--as-of 2026-10-21T19:00] [--out snapshot.html] [--redact-emails]
//
//   --rows       a GET /api/partners?v=2 body ({v:2, cols, rows}). Required.
//   --meta       a GET /api/meta body. Default: the constants of lib/meta.js (no kv_meta overrides).
//   --programs   a GET /api/clients body (client programs), shown on client pages.
//   --activity   a GET /api/team-activity?days=7 body ("Changes this week" and "Last active" on Team overview).
//   --as-of      when the data is from (ISO date or date-time, local time when no zone). Default: now. The
//                banner shows it, and the page's clock starts there, so Today is that day's Today.
//   --out        the HTML file to write. Default: partnergap-snapshot-<as-of day>.html in the system temp dir.
//   --redact-emails  replace email addresses found in the inputs with "(email hidden)" instead of refusing.
//
// It refuses (exit 1, nothing written) when an input string looks like an email address (unless
// --redact-emails), and always when the finished file contains anything that looks like one.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath, pathToFileURL } from "node:url";
import { bundle, scan } from "./snapshot/bundle.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../..");
const DASH = path.join(REPO, "crm", "dashboard");
const SNAP = path.join(HERE, "snapshot");

// Anything that looks like an email address (also inside longer text: "mail jo@x.example.test today").
export const EMAIL_RE = /[A-Za-z0-9._%+'-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
const EMAIL_ONE = new RegExp(EMAIL_RE.source);
const HIDDEN = "(email hidden)";

export class SnapshotError extends Error {}

function fail(message) {
  throw new SnapshotError(message);
}

function readJson(file, what) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (e) {
    fail(what + ": can't read " + file + " (" + e.code + ")");
  }
  try {
    return JSON.parse(text);
  } catch (e) {
    fail(what + ": " + file + " is not JSON (" + e.message + ")");
  }
}

// ---------- inputs ----------

function checkRows(body) {
  if (Array.isArray(body)) fail("--rows: this is the old list (GET /api/partners). Use the GET /api/partners?v=2 body.");
  if (!body || !Array.isArray(body.cols) || !Array.isArray(body.rows)) fail("--rows: expected a GET /api/partners?v=2 body ({v:2, cols, rows}).");
  if (!body.cols.includes("id")) fail("--rows: the cols list has no \"id\".");
  body.rows.forEach((r, i) => {
    if (!Array.isArray(r) || r.length !== body.cols.length) fail("--rows: row " + i + " doesn't have " + body.cols.length + " values.");
  });
  return { cols: body.cols.slice(), rows: body.rows };
}

function checkMeta(body) {
  if (!body || typeof body !== "object" || Array.isArray(body) || !Array.isArray(body.stages)) {
    fail("--meta: expected a GET /api/meta body (an object with stages).");
  }
  return body;
}

// The snapshot's meta: read-only, no sheet link, no freshness (a copy never waits for the morning run) and
// no Settings. Everything else as the live site had it.
export function snapshotMeta(meta) {
  const m = JSON.parse(JSON.stringify(meta));
  m.read_only = true;
  m.sheet_url = "";
  m.freshness = null;
  m.features = Object.assign({}, m.features || {}, { settings: false });
  return m;
}

async function defaultMeta() {
  const lib = await import(pathToFileURL(path.join(REPO, "lib", "meta.js")).href);
  return lib.baseMeta();
}

/** The as-of time as an ISO string. "2026-10-21" is noon local time that day. */
export function asOfIso(v, now = new Date()) {
  if (v == null || v === "") return now.toISOString();
  const s = String(v).trim();
  const t = /^\d{4}-\d{2}-\d{2}$/.test(s) ? new Date(s + "T12:00:00") : new Date(s);
  if (Number.isNaN(t.getTime())) fail("--as-of: not a date: " + s);
  return t.toISOString();
}

// ---------- emails ----------

/** Every string (value or object key) in `value` that looks like an email: [{where, sample}] (sample masked). */
export function findEmails(value, where = "$", out = []) {
  if (typeof value === "string") {
    const m = EMAIL_ONE.exec(value);
    if (m) out.push({ where, sample: mask(m[0]) });
  } else if (Array.isArray(value)) {
    value.forEach((v, i) => findEmails(v, where + "[" + i + "]", out));
  } else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      const m = EMAIL_ONE.exec(k);
      if (m) out.push({ where: where + " (a key)", sample: mask(m[0]) });
      findEmails(v, where + "." + (m ? "<key>" : k), out);
    }
  }
  return out;
}

function mask(email) {
  const [user, dom] = email.split("@");
  return user.slice(0, 1) + "…@" + dom.slice(0, 1) + "…";
}

/** A deep copy of `value` with every email-looking text replaced. Returns {value, count}. */
export function redactEmails(value) {
  let count = 0;
  const walk = (v) => {
    if (typeof v === "string") {
      return v.replace(EMAIL_RE, () => {
        count++;
        return HIDDEN;
      });
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") {
      const o = {};
      for (const [k, x] of Object.entries(v)) o[walk(k)] = walk(x);
      return o;
    }
    return v;
  };
  return { value: walk(value), count };
}

// "$.rows[12][13]" -> "rows: PG-00013 next_step" (so a refusal says where to look).
function describe(where, data) {
  const m = /^\$\.rows\[(\d+)\]\[(\d+)\]$/.exec(where);
  if (m && data.rows[m[1]]) {
    const idAt = data.cols.indexOf("id");
    return "rows: " + data.rows[m[1]][idAt] + " " + (data.cols[m[2]] || "column " + m[2]);
  }
  return where.replace(/^\$\./, "");
}

// ---------- page parts ----------

/** The stylesheets of index.html, in order: [{href, media, file}]. */
export function stylesheets(indexHtml) {
  const out = [];
  const re = /<link\b[^>]*\brel=["']?stylesheet["']?[^>]*>/gi;
  let m;
  while ((m = re.exec(indexHtml))) {
    const tag = m[0];
    const href = (/\bhref=["']([^"']+)["']/i.exec(tag) || [])[1];
    if (!href) continue;
    const media = (/\bmedia=["']([^"']+)["']/i.exec(tag) || [])[1] || "";
    out.push({ href, media, file: path.join(DASH, href.replace(/^\//, "")) });
  }
  return out;
}

/** CSS with @font-face rules removed (the snapshot uses the fallback fonts of --font). */
export function stripFontFaces(css) {
  return css.replace(/@font-face\s*\{[^}]*\}\s*/g, "");
}

function styles() {
  const index = fs.readFileSync(path.join(DASH, "index.html"), "utf8");
  const sheets = stylesheets(index);
  if (!sheets.length) fail("index.html lists no stylesheets.");
  const blocks = [];
  for (const s of sheets) {
    const css = stripFontFaces(fs.readFileSync(s.file, "utf8"));
    blocks.push({ media: s.media, css: "/* " + s.href + " */\n" + css });
  }
  blocks.push({ media: "", css: "/* snapshot.css */\n" + fs.readFileSync(path.join(SNAP, "snapshot.css"), "utf8") });
  for (const b of blocks) {
    const urls = b.css.match(/url\(\s*(?!["']?data:)[^)]*\)/gi);
    if (urls) fail("CSS would load a file: " + urls[0]);
    if (/@import\b/i.test(b.css)) fail("CSS uses @import.");
    if (/<\/style/i.test(b.css)) fail("CSS contains </style.");
  }
  return blocks;
}

/** The bundled dashboard ({code, modules}): entry scripts/snapshot/entry.js, core/api.js swapped. */
export function snapshotBundle() {
  const swap = { [path.join(DASH, "js", "core", "api.js")]: path.join(SNAP, "api.js") };
  let out;
  try {
    out = bundle(path.join(SNAP, "entry.js"), { swap, root: REPO });
  } catch (e) {
    fail(e.message);
  }
  try {
    new vm.Script(out.code, { filename: "snapshot-bundle.js" });
  } catch (e) {
    fail("The bundle doesn't compile: " + e.message);
  }
  return { code: out.code, modules: out.order.length };
}

function safeScript(code, what) {
  if (/<\/script/i.test(code) || /<!--/.test(code)) fail(what + " contains </script or <!--.");
  return code;
}

// JSON inside <script type="application/json">: "<" never appears raw, so no tag can end it early.
function jsonForHtml(value) {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

const escHtml = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// ---------- build ----------

/**
 * Builds the snapshot from parsed bodies. Returns {html, stats}. Throws SnapshotError when an input is
 * wrong or an email would be embedded.
 */
export async function buildSnapshot({ rows, meta, programs = null, activity = null, asOf, redact = false, now = new Date() } = {}) {
  const list = checkRows(rows);
  const m = snapshotMeta(checkMeta(meta || (await defaultMeta())));
  if (programs != null && !Array.isArray(programs)) fail("--programs: expected a GET /api/clients body (a list).");
  if (activity != null && (typeof activity !== "object" || Array.isArray(activity) || !activity.by || typeof activity.by !== "object")) {
    fail("--activity: expected a GET /api/team-activity body ({since, by}).");
  }
  let data = { builtAt: now.toISOString(), asOf: asOfIso(asOf, now), meta: m, cols: list.cols, rows: list.rows };
  if (programs) data.programs = programs;
  if (activity) data.activity = activity;

  let redacted = 0;
  const found = findEmails(data);
  if (found.length) {
    if (!redact) {
      const lines = found.slice(0, 20).map((f) => "  " + describe(f.where, data) + " (" + f.sample + ")");
      fail("Refusing to build: " + found.length + " input " + (found.length === 1 ? "value looks" : "values look") +
        " like an email address. A snapshot never holds emails. Remove them, or run again with --redact-emails.\n" +
        lines.join("\n") + (found.length > 20 ? "\n  … and " + (found.length - 20) + " more" : ""));
    }
    const r = redactEmails(data);
    data = r.value;
    redacted = r.count;
  }

  const css = styles();
  const js = snapshotBundle();
  const prelude = scan(fs.readFileSync(path.join(SNAP, "prelude.classic.js"), "utf8")).code.replace(/^\s*\n/gm, "");
  const day = data.asOf.slice(0, 10);
  const html = `<!doctype html>
<html lang="en" data-snapshot data-readonly>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>PartnerGap CRM snapshot</title>
<meta name="robots" content="noindex">
<meta name="description" content="${escHtml("Read-only copy of the PartnerGap CRM, data from " + day)}">
${css.map((b) => "<style" + (b.media ? ' media="' + escHtml(b.media) + '"' : "") + ">\n" + b.css + "\n</style>").join("\n")}
</head>
<body>
<div class="app"></div>
<div id="layer-panel" data-layer></div>
<div id="toasts" popover="manual" aria-live="polite"></div>
<script type="application/json" id="pg-snapshot-data">${jsonForHtml(data)}</script>
<script>
${safeScript(prelude, "The prelude")}
</script>
<script>
${safeScript(js.code, "The bundle")}
</script>
</body>
</html>
`;
  const leaks = html.match(EMAIL_RE);
  if (leaks) {
    fail("Refusing to write: the finished file contains " + leaks.length + " email-like " +
      (leaks.length === 1 ? "string" : "strings") + " (" + mask(leaks[0]) + ").");
  }
  return {
    html,
    stats: { rows: list.rows.length, bytes: Buffer.byteLength(html), modules: js.modules, redacted, asOf: data.asOf },
  };
}

// ---------- command line ----------

const FLAGS = { "--rows": "rows", "--meta": "meta", "--programs": "programs", "--activity": "activity", "--as-of": "asOf", "--out": "out" };

export function parseArgs(argv) {
  const o = { redact: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const eq = a.indexOf("=");
    const flag = eq > 0 ? a.slice(0, eq) : a;
    if (flag === "--redact-emails") { o.redact = true; continue; }
    if (flag === "--help" || flag === "-h") { o.help = true; continue; }
    const key = FLAGS[flag];
    if (!key) fail("Unknown option " + a + ". Run with --help.");
    const v = eq > 0 ? a.slice(eq + 1) : argv[++i];
    if (v == null || v === "") fail(flag + " needs a value.");
    o[key] = v;
  }
  return o;
}

const HELP = `Usage: node crm/scripts/build_snapshot.mjs --rows <partners-v2.json> [options]
  --rows <file>       GET /api/partners?v=2 body (required)
  --meta <file>       GET /api/meta body (default: lib/meta.js constants)
  --programs <file>   GET /api/clients body
  --activity <file>   GET /api/team-activity?days=7 body
  --as-of <when>      date or date-time the data is from (default: now)
  --out <file>        where to write the HTML (default: the temp dir)
  --redact-emails     hide email addresses found in the inputs instead of refusing
See crm/docs/snapshot.md.`;

async function main(argv) {
  const o = parseArgs(argv);
  if (o.help) {
    console.log(HELP);
    return 0;
  }
  if (!o.rows) fail("--rows is required. Run with --help.");
  const built = await buildSnapshot({
    rows: readJson(o.rows, "--rows"),
    meta: o.meta ? readJson(o.meta, "--meta") : null,
    programs: o.programs ? readJson(o.programs, "--programs") : null,
    activity: o.activity ? readJson(o.activity, "--activity") : null,
    asOf: o.asOf,
    redact: o.redact,
  });
  const out = path.resolve(o.out || path.join(os.tmpdir(), "partnergap-snapshot-" + built.stats.asOf.slice(0, 10) + ".html"));
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const tmp = out + ".tmp-" + process.pid;
  fs.writeFileSync(tmp, built.html);
  fs.renameSync(tmp, out);
  const s = built.stats;
  console.log("Snapshot written: " + out);
  console.log("  " + s.rows + " sites, " + (s.bytes / 1024).toFixed(0) + " KB, " + s.modules + " modules, data from " + s.asOf +
    (s.redacted ? ", " + s.redacted + " email " + (s.redacted === 1 ? "address" : "addresses") + " hidden" : ""));
  if (s.bytes > 15 * 1024 * 1024) console.warn("  Warning: over 15 MB; an artifact page may be at most 16 MB.");
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e) => {
      console.error(e instanceof SnapshotError ? "build_snapshot: " + e.message : e);
      process.exit(1);
    },
  );
}
