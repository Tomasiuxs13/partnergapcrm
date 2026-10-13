// Logs an email, call, meeting or note on a partner's timeline.
import { json, bad, body, who, text, today, now, ACTIVITY_TYPES } from "../../../../lib/crm.js";

export async function onRequestPost({ request, env, params }) {
  const db = env.PARTNERS_DB;
  if (!db) return bad("Not connected", 404);
  const id = String(params.id || "");
  const b = await body(request);
  const by = who(b);
  const type = ACTIVITY_TYPES.includes(b.type) ? b.type : "";
  const summary = text(b.summary, 2000);
  if (!type) return bad("Pick what happened.");
  if (!summary) return bad("Write a short summary.");
  const p = await db.prepare("SELECT id, clients FROM partners WHERE id = ?").bind(id).first();
  if (!p) return bad("Not found", 404);
  const date = today(), at = now();
  const client = text(b.client, 60) || null;
  const contact = text(b.contact_id, 20) || null;
  const touch = type === "Email" || type === "Call" || type === "Meeting";
  const res = await db.prepare("INSERT INTO activity (date, account_id, contact_id, type, by_whom, summary, client) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .bind(date, id, contact, type, by, summary, client).run();
  const n = res.meta.last_row_id;
  const stmts = [db.prepare("INSERT INTO edits (at, by_whom, kind, account_id, contact_id, field, new) VALUES (?, ?, 'activity', ?, ?, ?, ?)")
    .bind(at, by, id, contact, String(n), JSON.stringify({ date, type, summary, client }))];
  if (touch) stmts.push(db.prepare("UPDATE partners SET last_touch = ?, updated_at = ?, updated_by = ? WHERE id = ?").bind(date, at, by, id));
  await db.batch(stmts);
  return json({ ok: true, activity: { n, date, contact_id: contact, type, by_whom: by, summary, client }, last_touch: touch ? date : undefined }, 201);
}
