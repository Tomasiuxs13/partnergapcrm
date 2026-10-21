// GET /api/runs?limit=5 (spec 6.3.12): the latest scheduled-run rows, newest first.
//   {"rows":[{n, name, started_at, finished_at, status, summary}]}; summary is parsed when it is JSON.
//   limit 1-50 (default 5). Empty until the daily run writes rows (after the prompt diffs, J3).
//   Before migration 004: 404 {"error":"Not available yet","unavailable":true} (the page shows "Not available yet").
import { json } from "../../lib/crm.js";
import { hasTable } from "../../lib/tables.js";

const EMAIL = /[^\s@<>"',;:()]+@[^\s@<>"',;:()]+\.[a-z]{2,}/gi;

function summaryOf(s) {
  if (s == null || s === "") return null;
  const clean = String(s).replace(EMAIL, "(email hidden)");
  try {
    return JSON.parse(clean);
  } catch (e) {
    return clean;
  }
}

export async function onRequestGet({ request, env }) {
  const db = env.PARTNERS_DB;
  if (!db || !(await hasTable(db, "runs"))) return json({ error: "Not available yet", unavailable: true }, 404);
  const n = Number(new URL(request.url).searchParams.get("limit"));
  const limit = Number.isInteger(n) && n > 0 ? Math.min(n, 50) : 5;
  const { results } = await db.prepare("SELECT n, name, started_at, finished_at, status, summary FROM runs ORDER BY n DESC LIMIT ?1").bind(limit).all();
  return json({ rows: (results || []).map((r) => ({ ...r, summary: summaryOf(r.summary) })) });
}
