// How fresh the site's data is, for /api/meta (spec 6.3.13, 4.11). Cheap indexed reads only:
//   1. pending edits and the oldest pending time (edits_pending index)
//   2. the highest applied edit n (only the daily run sets applied = 1)
//   3. the newest activity row the site did not write, so it came from the sheet (edits_kind_field index)
//   4. the newest sheet id in partners (primary key)
//   5. kv_meta sheet_sig and last_sheet_change
//   6. the latest runs row named 'daily', when the runs table exists
// sig = 2|3|4. When it differs from the stored sheet_sig, the request is not read-only and kv_meta
// exists, sheet_sig and last_sheet_change = now are written. That is the only write on a GET, and only
// on change. Without kv_meta (before migration 003) there is no freshness: the answer is null.
import { hasTables } from "./tables.js";

const now = () => new Date().toISOString().replace(/\.\d+Z$/, "Z");

// Query 3 walks activity from the newest n and stops at the first row with no `activity` edit: the same
// answer as SELECT MAX(a.n) ... LEFT JOIN edits ... WHERE e.n IS NULL, but it reads only the rows the
// site added since the last sheet row.
const SQL = {
  pending: "SELECT COUNT(*) AS pending, MIN(at) AS oldest FROM edits WHERE applied = 0",
  applied: "SELECT MAX(n) AS n FROM edits WHERE applied = 1",
  activity: "SELECT a.n AS n FROM activity a WHERE NOT EXISTS (SELECT 1 FROM edits e WHERE e.kind = 'activity' AND e.field = CAST(a.n AS TEXT)) ORDER BY a.n DESC LIMIT 1",
  sheetId: "SELECT id FROM partners WHERE id >= 'PG-' AND id < 'PG.' ORDER BY id DESC LIMIT 1",
  kv: "SELECT k, v, at FROM kv_meta WHERE k IN ('sheet_sig', 'last_sheet_change')",
  run: "SELECT n, name, started_at, finished_at, status, summary FROM runs WHERE name = 'daily' ORDER BY n DESC LIMIT 1",
};

function parseSummary(s) {
  if (s == null || s === "") return null;
  try {
    return JSON.parse(s);
  } catch (e) {
    return s;
  }
}

/**
 * {pending, oldest_pending_at, max_applied_n, last_sheet_change, last_run} or null when kv_meta is missing.
 * @param db        the D1 binding
 * @param o.readOnly true on preview hosts: never writes
 * @param o.at       the time to store as last_sheet_change (default now)
 * @param o.tables   prefetched {kv_meta, runs} booleans (lib/tables.js#hasTables), to skip that lookup
 */
export async function freshness(db, { readOnly = false, at, tables } = {}) {
  if (!db) return null;
  const t = tables || (await hasTables(db, ["kv_meta", "runs"]));
  if (!t.kv_meta) return null;
  const stmts = [SQL.pending, SQL.applied, SQL.activity, SQL.sheetId, SQL.kv];
  if (t.runs) stmts.push(SQL.run);
  const res = await db.batch(stmts.map((s) => db.prepare(s)));
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
    max_applied_n: applied ?? null,
    last_sheet_change: last,
    last_run: run ? { ...run, summary: parseSummary(run.summary) } : null,
  };
}
