// Bundler-safe module style for crm/dashboard/js (spec 5.1), the snapshot's mini-bundler and the snapshot
// builder's pure parts (spec 4.14). Owner G3-6. The browser side of the snapshot is tests/e2e/96-snapshot.
//
// Style rules checked on every module: relative ".js" specifiers only; one import per statement in the
// forms {a, b as c} / * as x / x (default); exports only as function, async function, const, class,
// default or {a, b as c}; no export let/var/*, no export ... from, no circular imports, no dynamic
// import(), no top-level await and no import.meta.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath, pathToFileURL } from "node:url";
import { scan, parseModule, checkStyle, graph, bundle } from "../../crm/scripts/snapshot/bundle.mjs";
import {
  EMAIL_RE, SnapshotError, snapshotMeta, asOfIso, findEmails, redactEmails, stylesheets, stripFontFaces,
  snapshotBundle, buildSnapshot, parseArgs,
} from "../../crm/scripts/build_snapshot.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const JS = path.join(ROOT, "crm", "dashboard", "js");
const SNAP = path.join(ROOT, "crm", "scripts", "snapshot");
const rel = (f) => path.relative(ROOT, f).split(path.sep).join("/");

function jsFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return jsFiles(p);
    return e.isFile() && e.name.endsWith(".js") ? [p] : [];
  });
}

const DASH_MODULES = jsFiles(JS).sort();
const SNAP_MODULES = ["api.js", "ui.js", "entry.js"].map((f) => path.join(SNAP, f));

// Writes {name: source} into a fresh temp dir and returns its path.
function tempModules(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pg-bundle-"));
  for (const [name, src] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), src);
  return dir;
}

// ---------- the real modules ----------

test("every module in crm/dashboard/js and the snapshot's own modules follow the bundler-safe style", () => {
  assert.ok(DASH_MODULES.length >= 40, "found " + DASH_MODULES.length + " modules");
  const problems = DASH_MODULES.concat(SNAP_MODULES).flatMap((f) => checkStyle(rel(f), fs.readFileSync(f, "utf8")));
  assert.deepEqual(problems, []);
});

test("app.js reaches every module with no cycle or missing name, and index.html preloads exactly that set", () => {
  const g = graph(path.join(JS, "app.js"));
  assert.deepEqual(g.problems, []);
  const inGraph = g.order.map(rel).sort();
  assert.deepEqual(inGraph, DASH_MODULES.map(rel), "a module under js/ that app.js never imports would be missing from the snapshot");
  const index = fs.readFileSync(path.join(ROOT, "crm", "dashboard", "index.html"), "utf8");
  const preload = [...index.matchAll(/<link\b[^>]*\brel=["']?modulepreload["']?[^>]*>/gi)]
    .map((m) => "crm/dashboard/" + /\bhref=["']\/?([^"']+)["']/i.exec(m[0])[1])
    .sort();
  assert.deepEqual(preload, inGraph);
  assert.equal(rel(g.order[g.order.length - 1]), "crm/dashboard/js/app.js", "app.js runs last, after everything it imports");
});

test("parsed exports match what Node's own ES module loader exports, module by module", () => {
  const files = DASH_MODULES.filter((f) => !f.endsWith(path.sep + "app.js")).concat(path.join(SNAP, "api.js"), path.join(SNAP, "ui.js"));
  // A fresh process: page modules are imported without running app.js, and nothing leaks into this one.
  const CHECKER = `
import { pathToFileURL } from "node:url";
const out = {};
for (const f of process.argv.slice(1)) {
  try { out[f] = Object.keys(await import(pathToFileURL(f).href)).sort(); }
  catch (e) { out[f] = "import failed: " + e.message; }
}
process.stdout.write(JSON.stringify(out));
`;
  const node = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", CHECKER, ...files], { encoding: "utf8" }));
  const wrong = [];
  for (const f of files) {
    const parsed = parseModule(fs.readFileSync(f, "utf8")).exports.map((e) => e.name).sort();
    if (JSON.stringify(parsed) !== JSON.stringify(node[f])) wrong.push(rel(f) + ": parsed " + parsed.join(",") + " / node " + node[f]);
  }
  assert.deepEqual(wrong, []);
});

// ---------- the scanner ----------

test("the scanner drops comments but keeps strings, templates and regexes, line for line", () => {
  const src = [
    'const a = "// not a comment"; // a comment',
    "const b = '/* not one either */';",
    "/* a block",
    "   comment */ const c = 1;",
    "const d = `x ${ `y // ${1 /* in */}` } // z`;",
    "const e = /\\/\\/ [/*]/g.test(a) / 2;",
    "const f = c / 2 / 1; // division",
    "const g = (x) => x / 2 + d.length; /* end */",
  ].join("\n");
  const { code, problems } = scan(src);
  const lines = code.split("\n");
  assert.equal(lines.length, 8, "line breaks are kept");
  assert.equal(lines[0].trimEnd(), 'const a = "// not a comment";');
  assert.equal(lines[1], "const b = '/* not one either */';");
  assert.equal(lines[2], "");
  assert.equal(lines[3].trim(), "const c = 1;");
  assert.equal(lines[4], "const d = `x ${ `y // ${1  }` } // z`;");
  assert.equal(lines[5], "const e = /\\/\\/ [/*]/g.test(a) / 2;");
  assert.equal(lines[6].trimEnd(), "const f = c / 2 / 1;");
  assert.equal(lines[7].trimEnd(), "const g = (x) => x / 2 + d.length;");
  assert.deepEqual(problems, []);
  // The stripped code still runs the same.
  const run = (s) => JSON.stringify(vm.runInNewContext(s + "\n;[a, b, c, d, e, f, g(4)]"));
  assert.equal(run(code), run(src));
});

test("import and export inside strings, templates, comments or nested code are not statements", () => {
  const src = [
    "const t = `",
    'import x from "lodash";',
    "export let y = 1;",
    "`;",
    "// import z from 'nope';",
    "/*",
    "export * from './a.js';",
    "*/",
    "const s = 'export let q';",
    "const o = { import: 1, export: 2 };",
    "o.import + o.export;",
    "export const ok = t.length;",
  ].join("\n");
  const mod = parseModule(src);
  assert.deepEqual(mod.problems, []);
  assert.deepEqual(mod.imports, []);
  assert.deepEqual(mod.exports, [{ name: "ok", local: "ok" }]);
  assert.deepEqual(checkStyle("t.js", src), []);
});

// ---------- the style rules ----------

const BAD = [
  ["export let n = 1;", /export let\/var is not allowed/],
  ["export var n = 1;", /export let\/var is not allowed/],
  ['export * from "./a.js";', /export \* is not allowed/],
  ['export * as a from "./a.js";', /export \* is not allowed/],
  ['export { a } from "./a.js";', /export \.\.\. from is not allowed/],
  ["const o = {};\nexport const { a, b } = o;", /destructuring/],
  ['import x from "lodash";', /relative and end in \.js: lodash/],
  ['import x from "./a";', /relative and end in \.js/],
  ['import x from "./a.mjs";', /relative and end in \.js/],
  ['import x from "/js/a.js";', /relative and end in \.js/],
  ['import x from "https://cdn.example.test/a.js";', /relative and end in \.js/],
  ['import "./a.js";', /unsupported import form/],
  ['import x, { a } from "./a.js";', /unsupported import form/],
  ['import { a } from "./a.js"; import { b } from "./b.js";', /doesn't compile inside the bundle/],
  ['const m = import("./a.js");', /dynamic import\(\)/],
  ['const m = await import("./a.js");', /dynamic import\(\)/],
  ["const u = import.meta.url;", /import\.meta/],
  ["const v = await load();", /await/],
  ["const v = await(load());", /top-level await is not allowed/],
  ["for await (const x of []) {}", /reserved word|await/],
  ["export default 1;\nexport default 2;", /duplicate export default/],
  ["const a = 1;\nexport { a };\nexport { a };", /duplicate export a/],
  ["if (true) {\n  export const a = 1;\n}", /doesn't compile inside the bundle/],
  ["export const a = 1 +;", /doesn't compile inside the bundle/],
];

for (const [src, want] of BAD) {
  test("rejects: " + src.replace(/\n/g, " / "), () => {
    const problems = checkStyle("bad.js", src);
    assert.ok(problems.length > 0, "no problem reported");
    assert.match(problems.join("\n"), want);
    assert.match(problems[0], /^bad\.js:\d+ /, "a problem names the file and line");
  });
}

test("a problem reports the line it is on", () => {
  assert.deepEqual(checkStyle("m.js", "const a = 1;\n\n// fine\nexport let b = 2;\n"), ["m.js:4 export let/var is not allowed"]);
  assert.deepEqual(checkStyle("m.js", "const a = 1;\nfunction f() {\n  return a +;\n}\n").map((p) => p.split(" ")[0]), ["m.js:3"]);
  assert.deepEqual(checkStyle("m.js", "const a = 1;\n\nconst b = await(a);\n").map((p) => p.split(" ")[0]), ["m.js:3"]);
});

test("every allowed form is accepted, and await inside async functions is fine", () => {
  const src = [
    'import { a, b as c } from "./x.js";',
    'import * as ns from "../y/z.js";',
    'import d from "./d.js";',
    "export function f() { return a; }",
    "export async function g() { await c; for await (const v of []) {} return d; }",
    "export async function* h() { yield await ns; }",
    "export function* k() { yield 1; }",
    "export const A = 1, B = 2;",
    "export class K { async m() { await 1; } }",
    "const local = () => 1;",
    "const hidden = async () => await local();",
    "export { local, hidden as shown };",
    "export default class Thing {}",
  ].join("\n");
  assert.deepEqual(checkStyle("ok.js", src), []);
  const mod = parseModule(src);
  assert.deepEqual(mod.imports.map((i) => [i.kind, i.spec, i.local || i.names]), [
    ["named", "./x.js", [{ name: "a", local: "a" }, { name: "b", local: "c" }]],
    ["ns", "../y/z.js", "ns"],
    ["default", "./d.js", "d"],
  ]);
  assert.deepEqual(mod.exports.map((e) => e.name), ["f", "g", "h", "k", "A", "K", "local", "shown", "default"]);
  assert.deepEqual(mod.exports.find((e) => e.name === "default"), { name: "default", local: "Thing" });
  assert.deepEqual(mod.exports.find((e) => e.name === "shown"), { name: "shown", local: "hidden" });
});

// ---------- the bundler ----------

test("bundles a small graph into one classic script that behaves like the ES modules", async () => {
  const dir = tempModules({
    "log.js": "export const seen = [];\n",
    "a.js": [
      'import { seen } from "./log.js";',
      'seen.push("a");',
      "export const ONE = 1;",
      "export function add(x, y) { return x + y; }",
      'export async function later() { return await Promise.resolve("later"); }',
      "export class Box { constructor(v) { this.v = v; } }",
      "const hidden = 41;",
      "function inc(x) { return x + 1; }",
      "export { inc, hidden as answerMinusOne };",
      'export default function named() { return "a-default"; }',
    ].join("\n"),
    "b.js": [
      'import { ONE, add as plus, Box } from "./a.js";',
      'import * as A from "./a.js";',
      'import aDefault from "./a.js";',
      'import { seen } from "./log.js";',
      'seen.push("b");',
      "// export let nope = 1;",
      "const tpl = `",
      'import x from "./nope.js";',
      "`;",
      "export const sum = plus(ONE, A.inc(A.answerMinusOne));",
      "export const boxed = new Box(aDefault()).v;",
      'export const lines = tpl.trim().split("\\n").length;',
      "export default { keys: Object.keys(A).sort() };",
    ].join("\n"),
    "entry.js": [
      'import { sum, boxed, lines } from "./b.js";',
      'import b from "./b.js";',
      'import { later } from "./a.js";',
      'import * as log from "./log.js";',
      'log.seen.push("entry");',
      "export const result = { sum, boxed, lines, keys: b.keys, seen: log.seen.slice() };",
      "export { later };",
    ].join("\n"),
  });
  try {
    const out = bundle(path.join(dir, "entry.js"), { root: dir, expose: "__t" });
    assert.deepEqual(out.order.map((f) => path.basename(f)), ["log.js", "a.js", "b.js", "entry.js"]);
    // A classic script: running it at all proves no import or export statement is left.
    assert.match(out.code, /^import x from "\.\/nope\.js";$/m, "text inside a template is kept as it is");
    assert.doesNotMatch(out.code, /export let nope/, "comments are gone");
    assert.match(out.code, /^\/\/ a\.js$/m, "each module is headed by its path");
    const ctx = vm.createContext({});
    vm.runInContext(out.code, ctx);
    const t = ctx.__t;
    const expected = {
      sum: 43,
      boxed: "a-default",
      lines: 1,
      keys: ["Box", "ONE", "add", "answerMinusOne", "default", "inc", "later"],
      seen: ["a", "b", "entry"],
    };
    assert.deepEqual(JSON.parse(JSON.stringify(t.result)), expected);
    assert.equal(await t.later(), "later");
    // The same graph loaded as real ES modules gives the same answer.
    const real = await import(pathToFileURL(path.join(dir, "entry.js")).href);
    assert.deepEqual(JSON.parse(JSON.stringify(real.result)), expected);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("swap replaces a module with a stand-in everywhere except inside the stand-in itself", () => {
  const dir = tempModules({
    "real.js": 'export function who() { return "real"; }\nexport const extra = 1;\n',
    "fake.js": 'import { extra } from "./real.js";\nexport function who() { return "fake+" + extra; }\nexport { extra };\n',
    "user.js": 'import { who } from "./real.js";\nexport const said = who();\n',
    "entry.js": 'import { said } from "./user.js";\nexport const out = said;\n',
  });
  try {
    const swap = { [path.join(dir, "real.js")]: path.join(dir, "fake.js") };
    const b = bundle(path.join(dir, "entry.js"), { root: dir, swap, expose: "__t" });
    assert.deepEqual(b.order.map((f) => path.basename(f)), ["real.js", "fake.js", "user.js", "entry.js"]);
    const ctx = vm.createContext({});
    vm.runInContext(b.code, ctx);
    assert.equal(ctx.__t.out, "fake+1");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the graph reports cycles, missing modules, missing names and the reserved prefix", () => {
  const dir = tempModules({
    "c1.js": 'import { two } from "./c2.js";\nexport const one = 1;\n',
    "c2.js": 'import { one } from "./c1.js";\nexport const two = 2;\n',
    "miss.js": 'import { x } from "./gone.js";\nexport const y = 1;\n',
    "names.js": 'import { nope } from "./plain.js";\nimport def from "./plain.js";\nexport const z = 1;\n',
    "plain.js": "export const yes = 1;\n",
    "prefix.js": "export const __pg_m0 = 1;\n",
    "bad.js": 'import { yes } from "./plain.js";\nexport let v = yes;\n',
  });
  try {
    const at = (f) => path.join(dir, f);
    assert.match(graph(at("c1.js")).problems.join("\n"), /circular import: c1\.js -> c2\.js -> c1\.js/);
    assert.match(graph(at("miss.js")).problems.join("\n"), /missing module: .*gone\.js \(imported by .*miss\.js\)/);
    const names = graph(at("names.js")).problems.join("\n");
    assert.match(names, /names\.js:1 \.\/plain\.js does not export nope/);
    assert.match(names, /names\.js:2 \.\/plain\.js has no default export/);
    assert.match(graph(at("prefix.js")).problems.join("\n"), /reserved prefix __pg_/);
    assert.match(graph(at("bad.js")).problems.join("\n"), /bad\.js:2 export let\/var is not allowed/);
    assert.throws(() => bundle(at("c1.js"), { root: dir }), (e) => {
      assert.match(e.message, /bundler-safe style \(spec 5\.1\)/);
      assert.ok(Array.isArray(e.problems) && e.problems.length === 1);
      return true;
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------- the snapshot's bundle and stand-in api ----------

test("the snapshot bundle compiles, swaps core/api.js for the stand-in, and holds no network call", () => {
  const b = snapshotBundle();
  const app = graph(path.join(JS, "app.js"));
  assert.equal(b.modules, app.order.length + 2, "every dashboard module (the stand-in api in place of core/api.js), ui.js and entry.js");
  assert.doesNotThrow(() => new vm.Script(b.code));
  assert.match(b.code, /^\/\/ crm\/scripts\/snapshot\/api\.js$/m);
  assert.doesNotMatch(b.code, /^\/\/ crm\/dashboard\/js\/core\/api\.js$/m);
  const headers = [...b.code.matchAll(/^\/\/ (\S+\.js)$/gm)].map((m) => m[1]);
  assert.equal(headers.length, b.modules);
  assert.equal(headers[headers.length - 1], "crm/scripts/snapshot/entry.js", "entry.js runs last");
  for (const re of [/\bfetch\s*\(/, /XMLHttpRequest/, /sendBeacon/, /\bWebSocket\b/, /\bEventSource\b/, /importScripts/, /<\/script/i, /<!--/]) {
    assert.doesNotMatch(b.code, re);
  }
});

test("the stand-in api has every export and api method of core/api.js, serves rows from memory and refuses writes", async () => {
  const core = await import(pathToFileURL(path.join(JS, "core", "api.js")).href);
  const stand = await import(pathToFileURL(path.join(SNAP, "api.js")).href);
  assert.deepEqual(Object.keys(core).filter((k) => !(k in stand)), []);
  assert.deepEqual(Object.keys(core.api).filter((k) => typeof stand.api[k] !== "function"), []);

  const had = Object.getOwnPropertyDescriptor(globalThis, "window");
  const realFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = (...args) => {
    calls.push(args);
    return Promise.reject(new Error("no network"));
  };
  globalThis.window = {
    __SNAPSHOT__: {
      builtAt: "2026-10-20T12:00:00.000Z",
      meta: { v: 2, stages: [], read_only: true },
      cols: ["id", "domain"],
      rows: [["PG-1", "one.example.test"], ["PG-2", "two.example.test"]],
      activity: { since: "2026-10-13", by: {} },
    },
  };
  try {
    const p = await stand.api.partners();
    assert.equal(p.status, 200);
    assert.deepEqual(p.data, { v: 2, cols: ["id", "domain"], rows: [["PG-1", "one.example.test"], ["PG-2", "two.example.test"]] });
    assert.deepEqual((await stand.api.partnersByIds(["PG-2"])).rows, [["PG-2", "two.example.test"]]);
    const meta = await stand.api.meta();
    meta.read_only = false;
    assert.equal(globalThis.window.__SNAPSHOT__.meta.read_only, true, "callers get a copy");
    assert.deepEqual(await stand.api.teamActivity(), { since: "2026-10-13", by: {} });
    assert.equal(await stand.api.programs(), null);
    for (const read of ["partner", "about", "aboutDomain", "edits", "contactsIndex", "settings", "suggestions", "runs"]) {
      assert.equal(await stand.api[read]("PG-1"), null, read);
    }
    assert.equal(await stand.request("GET", "/api/meta"), null);
    for (const write of ["update", "outcome", "logActivity", "addContact", "addSite", "bulk", "bulkRows", "saveProgram", "saveSettings", "setSuggestion"]) {
      await assert.rejects(stand.api[write]("PG-1", {}), (e) => {
        assert.ok(e instanceof stand.ApiError, write);
        assert.equal(e.status, 403);
        assert.equal(e.friendly, "Read-only copy. Open partnergap-crm.pages.dev to edit.");
        return true;
      });
    }
    await assert.rejects(stand.request("POST", "/api/partners/PG-1", {}), /Read-only copy/);
    assert.equal(stand.pendingWrites(), 0);
    assert.equal(calls.length, 0, "the stand-in never calls fetch");
  } finally {
    if (had) Object.defineProperty(globalThis, "window", had);
    else delete globalThis.window;
    globalThis.fetch = realFetch;
  }
});

// ---------- the builder ----------

test("findEmails finds addresses in values and keys, and masks what it shows", () => {
  const found = findEmails({ a: "mail ana@client.example.test today", list: ["ok", "b@y.example.test"], "c@z.example.test": 1, n: 5, nested: { d: null } });
  assert.deepEqual(found, [
    { where: "$.a", sample: "a…@c…" },
    { where: "$.list[1]", sample: "b…@y…" },
    { where: "$ (a key)", sample: "c…@z…" },
  ]);
  for (const fine of ["PG-00013", "@handle", "a@b", "x@y.z", "5@10.5", "50% @ 2x", "partnergap-crm.pages.dev", "Meet @ 10:00"]) {
    assert.deepEqual(findEmails(fine), [], fine);
  }
  for (const bad of ["jo@x.example.test", "first.last+tag@sub.domain.example.test", "O'Neil@site.example.test", "<a@b.example.test>"]) {
    assert.equal(findEmails(bad).length, 1, bad);
    assert.match(bad, new RegExp(EMAIL_RE.source));
  }
});

test("redactEmails hides every address, keys included, and leaves the input alone", () => {
  const input = { a: "jo@x.example.test and al@y.example.test", "k@z.example.test": ["m@n.example.test"], keep: 3 };
  const { value, count } = redactEmails(input);
  assert.equal(count, 4);
  assert.deepEqual(value, { a: "(email hidden) and (email hidden)", "(email hidden)": ["(email hidden)"], keep: 3 });
  assert.equal(input.a, "jo@x.example.test and al@y.example.test");
  assert.deepEqual(findEmails(value), []);
});

test("asOfIso, snapshotMeta, stylesheets, stripFontFaces and parseArgs", () => {
  const now = new Date("2026-10-20T08:30:00.000Z");
  assert.equal(asOfIso(undefined, now), now.toISOString());
  assert.equal(asOfIso("", now), now.toISOString());
  assert.equal(asOfIso("2026-10-21"), new Date("2026-10-21T12:00:00").toISOString(), "a date alone is noon local time");
  assert.equal(asOfIso("2026-10-21T19:00:00Z"), "2026-10-21T19:00:00.000Z");
  assert.throws(() => asOfIso("next friday"), SnapshotError);

  const meta = {
    v: 2, stages: [{ key: "lead" }], sheet_url: "https://docs.example.test/x", freshness: { stale: true },
    features: { settings: true, digest: true }, team: [{ name: "Kamile" }],
  };
  const m = snapshotMeta(meta);
  assert.equal(m.read_only, true);
  assert.equal(m.sheet_url, "");
  assert.equal(m.freshness, null);
  assert.deepEqual(m.features, { settings: false, digest: true });
  assert.deepEqual(m.team, meta.team);
  assert.equal(meta.features.settings, true, "the input is not changed");

  const index = fs.readFileSync(path.join(ROOT, "crm", "dashboard", "index.html"), "utf8");
  const sheets = stylesheets(index);
  assert.equal(sheets[0].href, "/css/tokens.css");
  assert.ok(sheets.length >= 5);
  for (const s of sheets) assert.ok(fs.existsSync(s.file), s.href);
  assert.deepEqual(sheets.filter((s) => s.media).map((s) => [s.href, s.media]), [["/css/print.css", "print"]]);

  const css = "a{color:red}\n@font-face {\n  font-family: X;\n  src: url(/fonts/x.woff2) format('woff2');\n}\nb{color:blue}";
  assert.equal(stripFontFaces(css), "a{color:red}\nb{color:blue}");

  assert.deepEqual(parseArgs(["--rows", "p.json", "--as-of=2026-10-21", "--redact-emails", "--out", "o.html"]), {
    redact: true, rows: "p.json", asOf: "2026-10-21", out: "o.html",
  });
  assert.equal(parseArgs(["--help"]).help, true);
  assert.throws(() => parseArgs(["--rows"]), /--rows needs a value/);
  assert.throws(() => parseArgs(["--nope", "x"]), /Unknown option --nope/);
});

const COLS = ["id", "domain", "stage", "owner", "next_step"];
const ROWS = { v: 2, cols: COLS, rows: [["PG-00001", "alpha.example.test", "lead", "Kamile", "Call back </script><!-- <b>"]] };
const AS_OF = "2026-10-20T12:00:00Z";
const NOW = new Date("2026-10-20T13:00:00.000Z");

function embedded(html) {
  const m = /<script type="application\/json" id="pg-snapshot-data">([^]*?)<\/script>/.exec(html);
  assert.ok(m, "the data script is there");
  return JSON.parse(m[1]);
}

test("buildSnapshot makes one self-contained page with the data embedded safely", async () => {
  const { html, stats } = await buildSnapshot({ rows: ROWS, meta: null, asOf: AS_OF, now: NOW });
  assert.match(html, /^<!doctype html>\n<html lang="en" data-snapshot data-readonly>/);
  assert.equal(stats.rows, 1);
  assert.equal(stats.asOf, "2026-10-20T12:00:00.000Z");
  assert.equal(stats.redacted, 0);
  assert.equal(stats.bytes, Buffer.byteLength(html));
  assert.equal((html.match(/<script\b/g) || []).length, 3, "data, prelude and bundle");
  assert.equal((html.match(/<\/script>/g) || []).length, 3, "no script ends early");
  assert.doesNotMatch(html, /<link\b|<script\b[^>]*\bsrc=|type="module"|@import|@font-face/);
  assert.equal(html.match(EMAIL_RE), null);
  for (const m of html.matchAll(/<style\b[^>]*>([^]*?)<\/style>/g)) assert.doesNotMatch(m[1], /\burl\(\s*(?!["']?data:)/);

  const data = embedded(html);
  assert.deepEqual(data.rows, ROWS.rows, "the text survives the trip, < included");
  assert.deepEqual(data.cols, COLS);
  assert.equal(data.asOf, "2026-10-20T12:00:00.000Z");
  assert.equal(data.builtAt, NOW.toISOString());
  assert.equal(data.meta.read_only, true);
  assert.ok(Array.isArray(data.meta.stages) && data.meta.stages.length > 0, "meta defaults to lib/meta.js");
  assert.equal("programs" in data, false);
  assert.equal("activity" in data, false);
});

test("buildSnapshot refuses an email in any input, says where, and --redact-emails hides it instead", async () => {
  const rows = { v: 2, cols: COLS, rows: [["PG-00007", "beta.example.test", "lead", "Jonas", "mail ana@client.example.test"]] };
  await assert.rejects(buildSnapshot({ rows, asOf: AS_OF, now: NOW }), (e) => {
    assert.ok(e instanceof SnapshotError);
    assert.match(e.message, /Refusing to build: 1 input value looks like an email address/);
    assert.match(e.message, /rows: PG-00007 next_step \(a…@c…\)/);
    assert.doesNotMatch(e.message, /ana@/, "the refusal never prints the address");
    return true;
  });
  const clean = { v: 2, cols: COLS, rows: [["PG-00008", "gamma.example.test", "lead", "Jonas", "ok"]] };
  const at = (input, want) => assert.rejects(buildSnapshot(Object.assign({ rows: clean, asOf: AS_OF, now: NOW }, input)), want);
  await at({ programs: [{ client: "Acme", note: "ask bo@acme.example.test" }] }, /programs\[0\]\.note/);
  await at({ activity: { since: "2026-10-13", by: { "kamile@team.example.test": {} } } }, /activity\.by \(a key\)/);
  await at({ meta: { v: 2, stages: [{ key: "lead" }], team: [{ name: "Kamile", email: "k@team.example.test" }] } }, /meta\.team\[0\]\.email/);

  const { html, stats } = await buildSnapshot({ rows, asOf: AS_OF, now: NOW, redact: true });
  assert.equal(stats.redacted, 1);
  assert.equal(embedded(html).rows[0][4], "mail (email hidden)");
  assert.equal(html.match(EMAIL_RE), null);
});

test("buildSnapshot refuses bodies of the wrong shape", async () => {
  const bad = [
    [{ rows: [{ id: "PG-1" }] }, /old list \(GET \/api\/partners\)/],
    [{ rows: { v: 2, cols: ["domain"], rows: [] } }, /no "id"/],
    [{ rows: { v: 2, cols: ["id", "domain"], rows: [["PG-1"]] } }, /row 0 doesn't have 2 values/],
    [{ rows: ROWS, meta: { v: 2 } }, /--meta: expected a GET \/api\/meta body/],
    [{ rows: ROWS, programs: { list: [] } }, /--programs: expected a GET \/api\/clients body/],
    [{ rows: ROWS, activity: [] }, /--activity: expected a GET \/api\/team-activity body/],
    [{ rows: ROWS, asOf: "someday" }, /--as-of: not a date/],
  ];
  for (const [input, want] of bad) {
    await assert.rejects(buildSnapshot(Object.assign({ now: NOW }, input)), (e) => e instanceof SnapshotError && want.test(e.message));
  }
});
