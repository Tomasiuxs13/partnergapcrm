// GET /api/edits (spec 6.3.6): changes made on the site, and whether the morning copy took them to the sheet.
//   No params (legacy.html, unchanged): {pending, recent}: pending = every applied = 0 row (conflicts too),
//     recent = the newest 40 rows. Rows: n, at, by_whom, kind, account_id, field, new, applied, plus (additive)
//     old, contact_id and state.
//   Params (Edit history): before=<n> (rows with n below it), limit (default 100, max 200), by, account,
//     state=waiting|copied|not_copied, from, to (YYYY-MM-DD, UTC days, or ISO times). Newest first.
//     {pending, recent, next_before, max_applied_n}: next_before is the n to ask for next ("Load more"),
//     or null when there is nothing older.
//   state: copied (applied = 1); not_copied (applied = 0 and n below the highest applied n: a sheet edit won,
//     R5); waiting (the rest).
// Email addresses in old/new (an added contact's email) are shown as "(email hidden)": emails reach the page
// only through the partner profile and the contacts index (spec 6.7).
import { json, bad } from "../../lib/crm.js";

const PARAMS = ["before", "limit", "by", "state", "account", "from", "to"];
const STATES = ["waiting", "copied", "not_copied"];
const EMAIL = /[^\s@<>"',;:()]+@[^\s@<>"',;:()]+\.[a-z]{2,}/gi;
const WHEN = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2})?Z?)?$/;
const COLS = "n, at, by_whom, kind, account_id, field, new, applied, old, contact_id";
const STATE_SQL = "CASE WHEN applied = 1 THEN 'copied' WHEN n < m.mx THEN 'not_copied' ELSE 'waiting' END AS state";
const MAX_APPLIED = "(SELECT COALESCE(MAX(n), 0) AS mx FROM edits WHERE applied = 1) m";

const hide = (v) => (typeof v === "string" ? v.replace(EMAIL, "(email hidden)") : v);
const scrub = (r) => ({ ...r, old: hide(r.old), new: hide(r.new) });

export async function onRequestGet({ request, env }) {
  const db = env.PARTNERS_DB;
  if (!db) return json({ pending: 0, recent: [] });
  const sp = new URL(request.url).searchParams;
  const paged = PARAMS.some((k) => (sp.get(k) || "") !== "");
  const pendingSql = db.prepare("SELECT COUNT(*) AS n FROM edits WHERE applied = 0");
  if (!paged) {
    const [c, r] = await db.batch([pendingSql, db.prepare(`SELECT ${COLS}, ${STATE_SQL} FROM edits, ${MAX_APPLIED} ORDER BY n DESC LIMIT 40`)]);
    const n = c.results && c.results[0] ? c.results[0].n : 0;
    return json({ pending: n, recent: (r.results || []).map(scrub) });
  }

  const where = [];
  const vals = [];
  const add = (sql, v) => {
    vals.push(v);
    where.push(sql.replace("?", "?" + vals.length));
  };
  const before = sp.get("before");
  if (before) {
    if (!/^\d+$/.test(before)) return bad("before must be an edit number.");
    add("n < ?", Number(before));
  }
  const lim = Number(sp.get("limit") || 100);
  const limit = Number.isInteger(lim) && lim > 0 ? Math.min(lim, 200) : 100;
  if (sp.get("by")) add("by_whom = ?", sp.get("by").slice(0, 40));
  if (sp.get("account")) add("account_id = ?", sp.get("account").slice(0, 40));
  const state = sp.get("state") || "";
  if (state) {
    if (!STATES.includes(state)) return bad("Pick a state: waiting, copied or not_copied.");
    where.push(state === "copied" ? "applied = 1" : state === "not_copied" ? "applied = 0 AND n < m.mx" : "applied = 0 AND n > m.mx");
  }
  for (const [k, op] of [["from", ">="], ["to", "<="]]) {
    const v = sp.get(k);
    if (!v) continue;
    if (!WHEN.test(v)) return bad("Use a date like 2026-10-31.");
    add("at " + op + " ?", v.length === 10 ? v + (k === "from" ? "T00:00:00Z" : "T23:59:59Z") : v);
  }
  vals.push(limit + 1);
  const sql = `SELECT ${COLS}, ${STATE_SQL} FROM edits, ${MAX_APPLIED}` + (where.length ? " WHERE " + where.join(" AND ") : "") +
    ` ORDER BY n DESC LIMIT ?${vals.length}`;
  const [c, m, r] = await db.batch([
    pendingSql,
    db.prepare("SELECT MAX(n) AS n FROM edits WHERE applied = 1"),
    db.prepare(sql).bind(...vals),
  ]);
  const rows = (r.results || []).map(scrub);
  const more = rows.length > limit;
  if (more) rows.length = limit;
  return json({
    pending: c.results && c.results[0] ? c.results[0].n : 0,
    recent: rows,
    next_before: more ? rows[rows.length - 1].n : null,
    max_applied_n: m.results && m.results[0] ? m.results[0].n : null,
  });
}
