// Logs an email, call, meeting or note on a partner's timeline. Request, response and edits row are
// unchanged from d5e91d9; the three writes now run in one atomic batch (spec 6.3.3, statements 2-4).
import { json, bad, body, who, text, today, now, activityInput, activityStatements } from "../../../../lib/crm.js";

export async function onRequestPost({ request, env, params }) {
  const db = env.PARTNERS_DB;
  if (!db) return bad("Not connected", 404);
  const id = String(params.id || "");
  const b = await body(request);
  const by = who(b);
  const input = activityInput(b);
  if (input.error) return bad(input.error);
  const p = await db.prepare("SELECT id, clients FROM partners WHERE id = ?").bind(id).first();
  if (!p) return bad("Not found", 404);
  const date = today(), at = now();
  const client = text(b.client, 60) || null;
  const { type, summary, contact_id } = input;
  const { statements, touch } = activityStatements(db, { id, by, at, date, type, summary, contact_id, client });
  const res = await db.batch(statements);
  const n = res[0].meta.last_row_id;
  return json({ ok: true, activity: { n, date, contact_id, type, by_whom: by, summary, client }, last_touch: touch ? date : undefined }, 201);
}
