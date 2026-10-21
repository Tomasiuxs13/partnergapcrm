// POST /api/partner/:id/files: adds a file link (Drive, Dropbox, a signed contract) to a site, optionally
// for one of its deals (migration 006). Request {by, label, kind, url, deal_id}. 201 {ok, file}; 400 with a
// sentence for the user; 404 {"error":"Not found"}; 404 {unavailable: true} before migration 006. Writes
// one create_file edits row whose field is the new files.n.
import { json, bad, body, who } from "../../../../lib/crm.js";
import { createFile, dealTables } from "../../../../lib/deals.js";

export async function onRequestPost({ request, env, params }) {
  const db = env.PARTNERS_DB;
  if (!db) return bad("Not connected", 404);
  if (!(await dealTables(db)).files) return json({ error: "Not available yet", unavailable: true }, 404);
  const b = await body(request);
  let file;
  try {
    file = await createFile(db, String(params.id || ""), b, who(b));
  } catch (msg) {
    if (msg instanceof Error) throw msg;
    return bad(String(msg));
  }
  if (!file) return bad("Not found", 404);
  return json({ ok: true, file }, 201);
}
