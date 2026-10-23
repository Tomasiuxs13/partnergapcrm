// GET /api/contacts: every contact for the Contacts page (Tomas, 2026-10-23), slim and in one answer.
//   {"cols":["id","account_id","first_name","last_name","title","client","email","outreach_status","last_email",
//   "replied","primary_contact"],"rows":[[...], ...]}, ordered by id. The page joins each row to its site
//   (name, owner, stage) from the site list it already has. About 6k rows on production.
// Emails are in the answer: like /api/partner/:id it sits behind sign-in (functions/_middleware.js) and is
// private, no-store. The page keeps it in memory only.
import { json } from "../../lib/crm.js";

const COLS = ["id", "account_id", "first_name", "last_name", "title", "client", "email", "outreach_status", "last_email",
  "replied", "primary_contact"];

export async function onRequestGet({ env }) {
  const db = env.PARTNERS_DB;
  if (!db) return json({ error: "Partner list not connected" }, 404);
  const rows = await db.prepare("SELECT " + COLS.join(", ") + " FROM contacts ORDER BY id").raw();
  return json({ cols: COLS, rows });
}
