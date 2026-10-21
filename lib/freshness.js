// How fresh the site's data is, for /api/meta (spec 6.3.13, 4.11). Cheap indexed reads only:
//   1. the edits waiting for the morning copy: applied = 0 and newer than the last applied edit
//      (2.2.6 "Waiting"; edits_pending index). A "not copied" edit (applied = 0 below the highest
//      applied n, R5) stays applied = 0 for good, so it is not counted. Also the oldest waiting time and
//      stale_pending: how many waiting edits are older than the last expected daily run (stale_before)
//   2. the highest applied edit n (only the daily run sets applied = 1)
//   3. the newest activity row the site did not write, so it came from the sheet (edits_kind_field index)
//   4. the newest sheet id in partners (primary key)
//   5. kv_meta sheet_sig and last_sheet_change
//   6. the latest runs row named 'daily', when the runs table exists
// sig = 2|3|4. When it differs from the stored sheet_sig, the request is not read-only and kv_meta
// exists, sheet_sig and last_sheet_change = now are written. That is the only write on a GET, and only
// on change. Without kv_meta (before migration 003) there is no freshness: the answer is null.
import { hasTables } from "./tables.js";
import { SCHEDULE, TIMEZONE } from "./meta.js";
import { lastRunAt } from "../crm/dashboard/js/core/format.js";

const iso = (ms) => new Date(ms).toISOString().replace(/\.\d+Z$/, "Z");
const now = () => iso(Date.now());

// The weekday time of the morning copy ("08:47" Vilnius), as the page reads it (js/core/meta.js#runTime).
function runTime() {
  const row = SCHEDULE.find((x) => /daily|morning copy/i.test((x && x.name) || "")) || null;
  const m = row && /(\d{1,2}):(\d{2})/.exec(row.when || "");
  return m ? m[1].padStart(2, "0") + ":" + m[2] : "08:47";
}

/** The last expected daily run at or before nowMs (weekdays, Vilnius time), as an ISO string, or null. */
export function lastExpectedRun(nowMs = Date.now()) {
  const t = lastRunAt(nowMs, TIMEZONE, runTime());
  return isFinite(t) ? iso(t) : null;
}

// Query 3 walks activity from the newest n and stops at the first row with no `activity` edit: the same
// answer as SELECT MAX(a.n) ... LEFT JOIN edits ... WHERE e.n IS NULL, but it reads only the rows the
// site added since the last sheet row.
const SQL = {
  pending: "SELECT COUNT(*) AS pending, MIN(at) AS oldest, COALESCE(SUM(at < ?1), 0) AS stale FROM edits " +
    "WHERE applied = 0 AND n > COALESCE((SELECT MAX(n) FROM edits WHERE applied = 1), 0)",
  applied: "SELECT MAX(n) AS n FROM edits WHERE applied = 1",
  activity: "SELECT a.n AS n FROM activity a WHERE NOT EXISTS (SELECT 1 FROM edits e WHERE e.kind = 'activity' AND e.field = CAST(a.n AS TEXT)) ORDER BY a.n DESC LIMIT 1",
  sheetId: "SELECT id FROM partners WHERE id >= 'PG-' AND id < 'PG.' ORDER BY id DESC LIMIT 1",
  kv: "SELECT k, v, at FROM kv_meta WHERE k IN ('sheet_sig', 'last_sheet_change')",
  run: "SELECT n, name, started_at, finished_at, status, summary FROM runs WHERE name = 'daily' ORDER BY n DESC LIMIT 1",
};

// The run's summary is free text from the daily run; an error such as "bounce from x@…" must not put an
// address in /api/meta (spec 6.7), so addresses are hidden first, as GET /api/runs does.
const EMAIL = /[^\s@<>"',;:()]+@[^\s@<>"',;:()]+\.[a-z]{2,}/gi;

function parseSummary(s) {
  if (s == null || s === "") return null;
  const clean = String(s).replace(EMAIL, "(email hidden)");
  try {
    return JSON.parse(clean);
  } catch (e) {
    return clean;
  }
}

/**
 * {pending, oldest_pending_at, stale_pending, stale_before, max_applied_n, last_sheet_change, last_run},
 * or null when kv_meta is missing. pending and oldest_pending_at cover only the waiting edits;
 * stale_pending counts the waiting edits made before stale_before (the last expected daily run).
 * @param db        the D1 binding
 * @param o.readOnly true on preview hosts: never writes
 * @param o.at       the time to store as last_sheet_change (default now)
 * @param o.tables   prefetched {kv_meta, runs} booleans (lib/tables.js#hasTables), to skip that lookup
 * @param o.nowMs    the current time, for stale_before (default Date.now())
 */
export async function freshness(db, { readOnly = false, at, tables, nowMs = Date.now() } = {}) {
  if (!db) return null;
  const t = tables || (await hasTables(db, ["kv_meta", "runs"]));
  if (!t.kv_meta) return null;
  const staleBefore = lastExpectedRun(nowMs);
  const stmts = [db.prepare(SQL.pending).bind(staleBefore || "")];
  for (const s of [SQL.applied, SQL.activity, SQL.sheetId, SQL.kv]) stmts.push(db.prepare(s));
  if (t.runs) stmts.push(db.prepare(SQL.run));
  const res = await db.batch(stmts);
  const first = (i) => ((res[i] && res[i].results) || [])[0] || null;
  const p = first(0) || {};
  const applied = first(1) ? first(1).n : null;
  const act = first(2) ? first(2).n : null;
  const sheetId = first(3) ? first(3).id : null;
  const kv = {};
  for (const r of (res[4] && res[4].results) || []) kv[r.k] = r;
  const run = t.runs ? first(5) : null;

  const sig = [applied ?? "", act ?? "", sheetId ?? ""].join("|");
  let last = kv.last_sheet_change ? kv.last_sheet_change.v : null;
  const stored = kv.sheet_sig ? kv.sheet_sig.v : null;
  if (sig !== stored && !readOnly) {
    const when = at || now();
    const upsert = "INSERT INTO kv_meta (k, v, at, by_whom) VALUES (?1, ?2, ?3, 'site') " +
      "ON CONFLICT(k) DO UPDATE SET v = excluded.v, at = excluded.at, by_whom = excluded.by_whom";
    await db.batch([db.prepare(upsert).bind("sheet_sig", sig, when), db.prepare(upsert).bind("last_sheet_change", when, when)]);
    last = when;
  }
  return {
    pending: Number(p.pending) || 0,
    oldest_pending_at: p.oldest || null,
    stale_pending: Number(p.stale) || 0,
    stale_before: staleBefore,
    max_applied_n: applied ?? null,
    last_sheet_change: last,
    last_run: run ? { ...run, summary: parseSummary(run.summary) } : null,
  };
}
