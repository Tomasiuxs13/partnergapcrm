// GET /api/deal/:id: one deal's own page (Tomas, 2026-10-23: "like HubSpot").
//   {deal, partner, contacts, activity, files, history: {edits}}
//   - partner: the deal's site; contacts: the people at that site (primary first, with emails: the login
//     in functions/_middleware.js covers this route); activity: the site's activity, newest first (the
//     client column tells which rows were about this deal's client)
//   - files: the site's file links, newest first (deal_id tells which belong to this deal)
//   - history.edits: the deal's create_deal and deal_update rows, newest first
//   404 {"error":"Not found"}; 404 {unavailable: true} before migration 006.
// PATCH /api/deal/:id: changes one deal (migration 006). Request {by, fields: {...DEAL_EDITABLE}}.
// 200 {ok, changed, deal, partner, v2}; 400 with a sentence for the user; 404 {"error":"Not found"};
// 404 {unavailable: true} before migration 006. One deal_update edits row per changed field, and an
// `update` row for the site stage when a deal stage change moves it.
import { json, bad, body, who, v2Row, readPartner } from "../../../lib/crm.js";
import { updateDeal, dealTables } from "../../../lib/deals.js";

export async function onRequestGet({ env, params }) {
  const db = env.PARTNERS_DB;
  if (!db) return bad("Not connected", 404);
  const t = await dealTables(db);
  if (!t.deals) return json({ error: "Not available yet", unavailable: true }, 404);
  const id = String(params.id || "");
  const deal = await db.prepare("SELECT * FROM deals WHERE id = ?").bind(id).first();
  if (!deal) return bad("Not found", 404);
  const site = String(deal.account_id || "");
  const stmts = [
    db.prepare("SELECT * FROM contacts WHERE account_id = ? ORDER BY primary_contact DESC, replied DESC, last_email DESC").bind(site),
    db.prepare("SELECT n, date, contact_id, type, by_whom, summary, client FROM activity WHERE account_id = ? ORDER BY date DESC, n DESC").bind(site),
    db.prepare(`SELECT n, at, by_whom, kind, field, old, new, applied FROM edits
      WHERE (kind = 'create_deal' AND field = ?1) OR (kind = 'deal_update' AND substr(field, 1, length(?1) + 1) = ?1 || '.')
      ORDER BY n DESC LIMIT 100`).bind(id),
  ];
  if (t.files) stmts.push(db.prepare("SELECT * FROM files WHERE account_id = ? ORDER BY n DESC").bind(site));
  const res = await db.batch(stmts);
  const rows = (i) => (res[i] && res[i].results) || [];
  return json({
    deal,
    partner: await readPartner(db, site),
    contacts: rows(0),
    activity: rows(1),
    files: t.files ? rows(3) : [],
    history: { edits: rows(2) },
  });
}

export async function onRequestPatch({ request, env, params }) {
  const db = env.PARTNERS_DB;
  if (!db) return bad("Not connected", 404);
  if (!(await dealTables(db)).deals) return json({ error: "Not available yet", unavailable: true }, 404);
  const b = await body(request);
  let out;
  try {
    out = await updateDeal(db, String(params.id || ""), b.fields && typeof b.fields === "object" ? b.fields : {}, who(b));
  } catch (msg) {
    if (msg instanceof Error) throw msg;
    return bad(String(msg));
  }
  if (!out) return bad("Not found", 404);
  return json({ ok: true, changed: out.changed, deal: out.deal, partner: out.partner, v2: out.partner ? await v2Row(db, out.partner) : null });
}
