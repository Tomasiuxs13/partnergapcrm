// GET /api/deals: every deal (migration 006) for the Deals page, oldest first, plus how many files each
// deal has. {deals: [...]}; {deals: null} before migration 006, so the page falls back to the sites'
// own deal terms.
import { json } from "../../lib/crm.js";
import { dealTables } from "../../lib/deals.js";

export async function onRequestGet({ env }) {
  const db = env.PARTNERS_DB;
  if (!db) return json({ deals: null });
  const t = await dealTables(db);
  if (!t.deals) return json({ deals: null });
  const sql = t.files
    ? "SELECT d.*, (SELECT COUNT(*) FROM files f WHERE f.deal_id = d.id) AS files FROM deals d ORDER BY d.created, d.id"
    : "SELECT d.*, 0 AS files FROM deals d ORDER BY d.created, d.id";
  const { results } = await db.prepare(sql).all();
  return json({ deals: results || [] });
}
