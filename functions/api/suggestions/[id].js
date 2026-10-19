// POST /api/suggestions/:id (spec 6.3.12): marks a daily-run suggestion used, dismissed or open again.
//   {by, status: 'used'|'dismissed'|'open'} -> {ok, suggestion: {id, account_id, kind, status, reviewed_by,
//   reviewed_at}, v2}. Sets status, reviewed_by and reviewed_at (cleared again for 'open'). D1-only: no edits
//   row, nothing reaches the Google Sheet. "Add as contact" first saves the contact through
//   POST /api/partner/:id/contacts (a create_contact row), then sets 'used' here.
//   v2 is the site's list row (its sugg count changes), so the page can patch its list.
//   400 for a bad status, 404 {"error":"Not found"} for an unknown id.
// Before migration 004: 404 {"error":"Not available yet","unavailable":true}.
import { json, bad, body, who, now, readPartner, v2Row } from "../../../lib/crm.js";
import { hasTable } from "../../../lib/tables.js";

const STATUSES = ["used", "dismissed", "open"];

export async function onRequestPost({ request, env, params }) {
  const db = env.PARTNERS_DB;
  if (!db || !(await hasTable(db, "suggestions"))) return json({ error: "Not available yet", unavailable: true }, 404);
  let id = String(params.id || "");
  try {
    id = decodeURIComponent(id);
  } catch (e) {
    // keep the raw id
  }
  id = id.slice(0, 200);
  const b = await body(request);
  const status = String(b.status || "");
  if (!STATUSES.includes(status)) return bad("Pick a status: used, dismissed or open.");
  const open = status === "open";
  const by = open ? null : who(b);
  const at = open ? null : now();
  const row = await db.prepare("UPDATE suggestions SET status = ?1, reviewed_by = ?2, reviewed_at = ?3 WHERE id = ?4 " +
    "RETURNING id, account_id, kind, status, reviewed_by, reviewed_at").bind(status, by, at, id).first();
  if (!row) return bad("Not found", 404);
  const partner = await readPartner(db, row.account_id);
  return json({ ok: true, suggestion: row, v2: partner ? await v2Row(db, partner) : null });
}
