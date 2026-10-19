// Shared e2e helpers (spec 7.1 G1-D, 8). G0 stub; owner G1-D.
// run.sh exports BASE_URL, PERSIST_DIR and the tool paths; the defaults below match spec 7.
import { createRequire } from "node:module";
import path from "node:path";

export function tools() {
  return {
    wrangler: process.env.WRANGLER_BIN || "/tmp/wtest/node_modules/.bin/wrangler",
    playwright: process.env.PW_PATH || "/opt/node22/lib/node_modules/playwright",
    chrome: process.env.CHROME || "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
    axe: process.env.AXE_PATH ||
      "/tmp/claude-0/-home-claude-partnergapcrm/747cd0be-8b1d-5f07-83a7-c4a3d39a6045/scratchpad/redesign/audit/tools/node_modules/axe-core/axe.min.js",
  };
}

export function baseUrl() {
  return process.env.BASE_URL || "";
}

// Playwright 1.56 is installed globally, not in this repo: load it from PW_PATH.
export function loadPlaywright() {
  const dir = tools().playwright;
  return createRequire(path.join(dir, "package.json"))(dir);
}
