// GET /api/contact/:id: one contact's own page (Tomas, 2026-10-23: "like HubSpot").
//   {contact, partner, contacts, activity, deals, history: {edits}}
//   - contact: the contacts row (with its email; the login in functions/_middleware.js covers this route)
//   - partner: the contact's site (partners row), or null when the site is gone
//   - contacts: the other people at that site (primary first), without this one
//   - activity: every activity row of the site, newest first (contact_id tells which were with this person)
//   - deals: the site's deals, oldest first; null before migration 006
//   - history.edits: the edits rows about this contact, newest first, max 100
//   404 {"error":"Not found"}.
import { json, bad, readPartner } from "../../../lib/crm.js";
import { hasTables } from "../../../lib/tables.js";

export async function onRequestGet({ env, params }) {
  const db = env.PARTNERS_DB;
  if (!db) return bad("Not connected", 404);
  const id = String(params.id || "");
  const contact = await db.prepare("SELECT * FROM contacts WHERE id = ?").bind(id).first();
  if (!contact) return bad("Not found", 404);
  const site = String(contact.account_id || "");
  const t = await hasTables(db, ["deals"]);
  const stmts = [
    db.prepare("SELECT * FROM contacts WHERE account_id = ? AND id <> ? ORDER BY primary_contact DESC, replied DESC, last_email DESC").bind(site, id),
    db.prepare("SELECT n, date, contact_id, type, by_whom, summary, client FROM activity WHERE account_id = ? ORDER BY date DESC, n DESC").bind(site),
    db.prepare(`SELECT n, at, by_whom, kind, field, old, new, applied FROM edits WHERE contact_id = ? ORDER BY n DESC LIMIT 100`).bind(id),
  ];
  if (t.deals) stmts.push(db.prepare("SELECT * FROM deals WHERE account_id = ? ORDER BY created, id").bind(site));
  const res = await db.batch(stmts);
  const rows = (i) => (res[i] && res[i].results) || [];
  return json({
    contact,
    partner: site ? await readPartner(db, site) : null,
    contacts: rows(0),
    activity: rows(1),
    deals: t.deals ? rows(3) : null,
    history: { edits: rows(2) },
  });
}
