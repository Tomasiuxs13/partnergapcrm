// PATCH /api/deal/:id: changes one deal (migration 006). Request {by, fields: {...DEAL_EDITABLE}}.
// 200 {ok, changed, deal, partner, v2}; 400 with a sentence for the user; 404 {"error":"Not found"};
// 404 {unavailable: true} before migration 006. One deal_update edits row per changed field, and an
// `update` row for the site stage when a deal stage change moves it.
import { json, bad, body, who, v2Row } from "../../../lib/crm.js";
import { updateDeal, dealTables } from "../../../lib/deals.js";

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
