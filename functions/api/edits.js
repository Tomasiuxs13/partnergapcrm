// Changes made on the site that the daily run has not yet copied into the Google Sheet.
import { json } from "../../lib/crm.js";

export async function onRequestGet({ env }) {
  const db = env.PARTNERS_DB;
  if (!db) return json({ pending: 0, recent: [] });
  const [c, r] = await Promise.all([
    db.prepare("SELECT COUNT(*) AS n FROM edits WHERE applied = 0").first(),
    db.prepare("SELECT n, at, by_whom, kind, account_id, field, new, applied FROM edits ORDER BY n DESC LIMIT 40").all(),
  ]);
  return json({ pending: c ? c.n : 0, recent: r.results });
}
