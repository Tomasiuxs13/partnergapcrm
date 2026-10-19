// Every module under crm/dashboard/js/core, crm/dashboard/js/rules and lib imports in plain Node
// with no side effects (spec 5.1): no new globals, no fetch, no timers. The imports run in a fresh
// child process, so modules that other test files already loaded are evaluated again here.
// It also checks that the shared names from spec 5.4 are still exported. Modules may add exports;
// they must not drop these.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const DIRS = ["crm/dashboard/js/core", "crm/dashboard/js/rules", "lib"];

function modules(dir) {
  const abs = path.join(ROOT, dir);
  if (!fs.existsSync(abs)) return [];
  return fs.readdirSync(abs, { withFileTypes: true }).flatMap((e) => {
    const rel = dir + "/" + e.name;
    if (e.isDirectory()) return modules(rel);
    return e.isFile() && e.name.endsWith(".js") ? [rel] : [];
  });
}

// Spec 5.4 names, by module.
const SHARED = {
  "crm/dashboard/js/core/dom.js": ["html", "raw", "render", "$", "$$", "on", "esc", "safeUrl", "copyText"],
  "crm/dashboard/js/core/format.js": ["num", "money", "pct", "date", "ago", "daysBetween", "todayIso", "addWorkingDays",
    "addDays", "nextMonday", "dueLabel", "initials", "normDomain", "normName", "plural"],
  "crm/dashboard/js/core/meta.js": ["load", "get", "stage", "client", "splitClients", "isPlatform"],
  "crm/dashboard/js/core/api.js": ["ApiError", "request", "api"],
  "crm/dashboard/js/core/model.js": ["derive", "setWaitingOnClient", "parseNext"],
  "crm/dashboard/js/core/store.js": ["load", "all", "get", "upsert", "patchLocal", "remove", "subscribe", "refresh", "status"],
  "crm/dashboard/js/core/me.js": ["init", "get", "set", "ensure", "home"],
  "crm/dashboard/js/core/router.js": ["start", "current", "href", "go", "setParams", "onChange", "addGuard"],
  "crm/dashboard/js/core/keys.js": ["start"],
  "crm/dashboard/js/core/outcomes.js": ["OUTCOMES", "outcomesFor", "buildOutcomeRequest"],
  "crm/dashboard/js/rules/today.js": ["doNow", "doNowCount", "newProspects", "comingUp"],
  "crm/dashboard/js/rules/sites.js": ["tabs", "noReply", "presets", "cleanupCounts"],
  "crm/dashboard/js/rules/deals.js": ["dealGroups"],
  "crm/dashboard/js/rules/clients.js": ["clientMetrics", "clientRows"],
  "crm/dashboard/js/rules/team.js": ["needsDecision", "stuck", "teamRows"],
  "lib/meta.js": ["STAGES", "DEAL_MODELS", "ACTIVITY_TYPES"],
  "lib/tables.js": ["hasTable"],
  "lib/settings.js": ["readOverrides"],
};

const API_METHODS = ["meta", "partners", "partnersByIds", "partner", "about", "aboutDomain", "update", "outcome",
  "logActivity", "addContact", "addSite", "bulk", "bulkRows", "edits", "teamActivity", "contactsIndex", "programs",
  "saveProgram", "settings", "saveSettings", "suggestions", "setSuggestion", "runs"];

// Runs in the child process: imports each module with fetch and timers trapped, then reports.
const CHECKER = `
import path from "node:path";
import { pathToFileURL } from "node:url";
const [root, ...files] = process.argv.slice(1);
const calls = [];
const before = new Set(Object.getOwnPropertyNames(globalThis));
globalThis.fetch = () => { calls.push("fetch"); return new Promise(() => {}); };
globalThis.setTimeout = () => { calls.push("setTimeout"); return 0; };
globalThis.setInterval = () => { calls.push("setInterval"); return 0; };
globalThis.setImmediate = () => { calls.push("setImmediate"); return 0; };
const out = { modules: {}, added: [] };
for (const rel of files) {
  calls.length = 0;
  try {
    const mod = await import(pathToFileURL(path.join(root, rel)).href);
    const api = mod.api && typeof mod.api === "object"
      ? Object.keys(mod.api).filter((k) => typeof mod.api[k] === "function") : null;
    out.modules[rel] = { exports: Object.keys(mod), api, calls: calls.slice() };
  } catch (e) {
    out.modules[rel] = { error: String((e && e.stack) || e) };
  }
}
out.added = Object.getOwnPropertyNames(globalThis).filter((k) => !before.has(k));
process.stdout.write(JSON.stringify(out));
`;

const found = DIRS.flatMap(modules).sort();

test("there are modules to check", () => {
  for (const dir of DIRS) assert.ok(found.some((f) => f.startsWith(dir + "/")), `no modules in ${dir}`);
  for (const f of Object.keys(SHARED)) assert.ok(found.includes(f), `missing module ${f}`);
});

test("modules import in a fresh process without side effects", async (t) => {
  const stdout = execFileSync(process.execPath, ["--input-type=module", "-e", CHECKER, ROOT, ...found], {
    encoding: "utf8",
    env: { PATH: process.env.PATH || "" },
  });
  const report = JSON.parse(stdout);

  for (const rel of found) {
    await t.test(rel, () => {
      const m = report.modules[rel];
      assert.ok(m, `${rel} was not checked`);
      assert.equal(m.error, undefined, `${rel} failed to import:\n${m.error}`);
      assert.deepEqual(m.calls, [], `${rel} called ${m.calls.join(", ")} at import time`);
    });
  }

  await t.test("no globals added", () => {
    assert.deepEqual(report.added, [], `modules added globals: ${report.added.join(", ")}`);
  });

  await t.test("spec 5.4 names are exported", () => {
    for (const [rel, names] of Object.entries(SHARED)) {
      const m = report.modules[rel];
      assert.ok(m && m.exports, `${rel} did not load`);
      for (const n of names) assert.ok(m.exports.includes(n), `${rel} no longer exports ${n}`);
    }
    const api = report.modules["crm/dashboard/js/core/api.js"].api || [];
    for (const name of API_METHODS) assert.ok(api.includes(name), `api.${name} is missing`);
  });
});
