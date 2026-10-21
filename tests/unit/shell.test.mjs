// Unit tests for the morning-copy banner in js/shell/shell.js (spec 4.11, 2.2.6, 6.4 R5). freshness
// counts only the waiting edits (a "not copied" conflict stays applied = 0 for good and never copies),
// and the banner's N is the number of waiting edits older than this morning's run (stale_pending).
// /api/meta is stubbed in memory; the hooks are scoped to the describe block (tests/unit/index.js loads
// every test file into one process).
import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import * as meta from "../../crm/dashboard/js/core/meta.js";
import { morningCopyBanner } from "../../crm/dashboard/js/shell/shell.js";
import { lastRunAt } from "../../crm/dashboard/js/core/format.js";
import { lastExpectedRun } from "../../lib/freshness.js";

// Wednesday 21 Oct 2026: the run is 08:47 Vilnius (05:47Z, summer time until 25 Oct).
const RUN = "2026-10-21T05:47:00Z";
const NOON = Date.parse("2026-10-21T09:00:00Z"); // 12:00 Vilnius, after run + 2 h
const EARLY = Date.parse("2026-10-21T07:00:00Z"); // 10:00 Vilnius, before run + 2 h
let body = null;
let saved;

async function withFreshness(freshness) {
  body = {
    v: 2, stages: [], timezone: "Europe/Vilnius", freshness,
    schedule: [{ name: "Find new sites", when: "Mondays 07:52" }, { name: "Morning copy (daily run)", when: "Mon–Fri 08:47" }],
  };
  await meta.load();
  assert.deepEqual(meta.get().freshness, freshness);
}

describe("morningCopyBanner with a stubbed /api/meta", () => {
  before(() => {
    saved = Object.getOwnPropertyDescriptor(globalThis, "fetch");
    Object.defineProperty(globalThis, "fetch", {
      configurable: true, writable: true,
      value: async (url) => {
        assert.equal(String(url), "/api/meta");
        return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
      },
    });
  });
  after(() => {
    if (saved) Object.defineProperty(globalThis, "fetch", saved);
    else delete globalThis.fetch;
  });

  test("the server's stale_before is the run the page counts from", () => {
    assert.equal(lastExpectedRun(NOON), RUN);
    assert.equal(lastExpectedRun(EARLY), RUN);
    assert.equal(Date.parse(lastExpectedRun(NOON)), lastRunAt(NOON, "Europe/Vilnius", "08:47"));
    // Saturday and Sunday have no run: Monday 06:00 Vilnius looks back to Friday.
    assert.equal(lastExpectedRun(Date.parse("2026-10-26T04:00:00Z")), "2026-10-23T05:47:00Z");
    // Winter time from 25 Oct: 08:47 Vilnius is 06:47Z.
    assert.equal(lastExpectedRun(Date.parse("2026-10-27T09:00:00Z")), "2026-10-27T06:47:00Z");
  });

  test("only a not-copied conflict left: no banner (freshness no longer counts it)", async () => {
    await withFreshness({ pending: 0, oldest_pending_at: null, stale_pending: 0, stale_before: RUN, max_applied_n: 33, last_sheet_change: RUN, last_run: null });
    assert.equal(morningCopyBanner(NOON), null);
  });

  test("N is the waiting edits older than this morning's run, not every waiting edit", async () => {
    await withFreshness({ pending: 15, oldest_pending_at: "2026-10-20T10:00:00Z", stale_pending: 13, stale_before: RUN, max_applied_n: 18, last_sheet_change: null, last_run: null });
    assert.match(morningCopyBanner(NOON), /didn't pick up 13 changes\. They're saved here\./);
    assert.equal(morningCopyBanner(EARLY), null, "not before run + 2 h");
    await withFreshness({ pending: 3, oldest_pending_at: "2026-10-20T10:00:00Z", stale_pending: 1, stale_before: RUN, max_applied_n: 18, last_sheet_change: null, last_run: null });
    assert.match(morningCopyBanner(NOON), /didn't pick up 1 change\./);
  });

  test("no banner when every waiting edit was made after the run", async () => {
    await withFreshness({ pending: 2, oldest_pending_at: "2026-10-21T08:00:00Z", stale_pending: 0, stale_before: RUN, max_applied_n: 18, last_sheet_change: null, last_run: null });
    assert.equal(morningCopyBanner(NOON), null);
  });

  test("freshness read before this morning's run: every waiting edit it counted is older than the run", async () => {
    await withFreshness({ pending: 4, oldest_pending_at: "2026-10-20T10:00:00Z", stale_pending: 0, stale_before: "2026-10-20T05:47:00Z", max_applied_n: 18, last_sheet_change: null, last_run: null });
    assert.match(morningCopyBanner(NOON), /didn't pick up 4 changes/);
  });

  test("a daily run that ended with an error shows the error banner", async () => {
    await withFreshness({ pending: 0, oldest_pending_at: null, stale_pending: 0, stale_before: RUN, max_applied_n: 18, last_sheet_change: null,
      last_run: { n: 3, name: "daily", started_at: RUN, finished_at: RUN, status: "error", summary: null } });
    assert.match(morningCopyBanner(NOON), /stopped with an error/);
  });
});
