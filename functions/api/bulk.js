// Bulk changes from the record tables: assign an owner, set a stage or add a client to many sites.
import { json, bad, body, who, updatePartner } from "../../lib/crm.js";

export async function onRequestPost({ request, env }) {
  const db = env.PARTNERS_DB;
  if (!db) return bad("Partner list not connected", 404);
  const b = await body(request);
  const by = who(b);
  const ids = Array.isArray(b.ids) ? [...new Set(b.ids.map(String))].slice(0, 500) : [];
  if (!ids.length) return bad("Select at least one site.");
  const f = b.fields && typeof b.fields === "object" ? b.fields : {};
  const allowed = {};
  ["owner", "stage", "next_due"].forEach((k) => { if (k in f) allowed[k] = f[k]; });
  const addClient = typeof f.add_client === "string" ? f.add_client.trim().slice(0, 60) : "";
  if (!Object.keys(allowed).length && !addClient) return bad("Nothing to change.");
  let changed = 0;
  try {
    for (const id of ids) {
      const fields = { ...allowed };
      if (addClient) {
        const r = await db.prepare("SELECT clients FROM partners WHERE id = ?").bind(id).first();
        if (!r) continue;
        const cl = (r.clients || "").split(/\s*[,/]\s*/).filter(Boolean);
        if (!cl.some((c) => c.toLowerCase() === addClient.toLowerCase())) fields.clients = cl.concat(addClient).join(", ");
      }
      const out = await updatePartner(db, id, fields, by);
      if (out && Object.keys(out).length) changed++;
    }
  } catch (msg) {
    return bad(String(msg));
  }
  return json({ ok: true, changed });
}
