// window.BUILD in crm/dashboard/index.html and BUILD in lib/meta.js are one value (spec 5.1, 4.11): the
// release changes both in one commit. If they differed, every page would offer "A new version is ready"
// forever. /api/meta answers build = lib/meta.js BUILD (also checked live by 91-migrations).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { BUILD } from "../../lib/meta.js";

const INDEX = fileURLToPath(new URL("../../crm/dashboard/index.html", import.meta.url));

test("index.html window.BUILD equals lib/meta.js BUILD, and it is set once", () => {
  const html = fs.readFileSync(INDEX, "utf8");
  const all = [...html.matchAll(/window\.BUILD\s*=\s*['"]([^'"]*)['"]/g)].map((m) => m[1]);
  assert.equal(all.length, 1, "one window.BUILD in index.html");
  assert.equal(all[0], BUILD, "window.BUILD = lib/meta.js BUILD");
  assert.match(BUILD, /^[a-z0-9][a-z0-9.-]{0,39}$/, "a short build name");
});
