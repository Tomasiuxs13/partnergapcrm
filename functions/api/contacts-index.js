// GET /api/contacts-index (spec 6.3.5): every contact, slim, for Search.
//   {"cols":["id","account_id","name","email_lc"],"rows":[[...], ...]}
//   name = first + last name (null when both are empty); email_lc = the stored email text lower-cased
//   (a list such as "a@x.test; b@x.test" stays one string). About 6k rows and 300 KB on production.
// Behind sign-in (functions/_middleware.js), Cache-Control: private, no-store. The page fetches it once per
// session on the first search and keeps it in memory only.
import { json } from "../../lib/crm.js";

const COLS = ["id", "account_id", "name", "email_lc"];

export async function onRequestGet({ env }) {
  const db = env.PARTNERS_DB;
  if (!db) return json({ error: "Partner list not connected" }, 404);
  const rows = await db.prepare(
    "SELECT id, account_id, NULLIF(TRIM(COALESCE(first_name, '') || ' ' || COALESCE(last_name, '')), '') AS name, " +
    "NULLIF(lower(TRIM(COALESCE(email, ''))), '') AS email_lc FROM contacts ORDER BY id"
  ).raw();
  return json({ cols: COLS, rows });
}
