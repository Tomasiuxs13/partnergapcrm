// GET /api/partner/:id/about (spec 6.3.9): {title, description}, what the site says about itself.
// lib/about.js#siteAbout: from the 7-day cache, else one fetch of the site (4 s timeout, 300 KB). A site
// with no plain domain (a creator, a channel URL) gives empty strings. 404 {"error":"Not found"}.
import { json, bad } from "../../../../lib/crm.js";
import { siteAbout, aboutable } from "../../../../lib/about.js";

export async function onRequestGet({ env, params, waitUntil }) {
  const db = env.PARTNERS_DB;
  if (!db) return bad("Partner list not connected", 404);
  const row = await db.prepare("SELECT domain FROM partners WHERE id = ?").bind(String(params.id || "")).first();
  if (!row) return bad("Not found", 404);
  const about = aboutable(row.domain) ? await siteAbout(String(row.domain), waitUntil) : null;
  return json({ title: (about && about.title) || "", description: (about && about.description) || "" });
}
