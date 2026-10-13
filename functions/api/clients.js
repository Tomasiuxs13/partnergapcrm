// Each client's affiliate program terms (network, commission, cookie, payouts, brief).
import { json } from "../../lib/crm.js";

export async function onRequestGet({ env }) {
  const db = env.PARTNERS_DB;
  if (!db) return json([]);
  const { results } = await db.prepare("SELECT * FROM client_programs").all();
  return json(results);
}
