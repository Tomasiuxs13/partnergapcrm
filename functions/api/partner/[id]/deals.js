// POST /api/partner/:id/deals: adds a deal (one client) to a site (migration 006). Request
// {by, client, stage, owner, deal_model, deal_flat, deal_pct, deal_value, content_url, live_date,
// tracking_id, next_step, next_due, notes}. 201 {ok, deal, partner, v2}; 400 with a sentence for the user;
// 404 {"error":"Not found"}; 404 {unavailable: true} before migration 006. Writes one create_deal edits
// row, and an `update` row for the site stage when the deal moves it (lib/deals.js#siteStageFor).
import { json, bad, body, who, v2Row } from "../../../../lib/crm.js";
import { createDeal, dealTables } from "../../../../lib/deals.js";

export async function onRequestPost({ request, env, params }) {
  const db = env.PARTNERS_DB;
  if (!db) return bad("Not connected", 404);
  if (!(await dealTables(db)).deals) return json({ error: "Not available yet", unavailable: true }, 404);
  const b = await body(request);
  let out;
  try {
    out = await createDeal(db, String(params.id || ""), b, who(b));
  } catch (msg) {
    if (msg instanceof Error) throw msg;
    return bad(String(msg));
  }
  if (!out) return bad("Not found", 404);
  return json({ ok: true, deal: out.deal, partner: out.partner, v2: await v2Row(db, out.partner) }, 201);
}
