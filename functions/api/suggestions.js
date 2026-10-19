// GET /api/suggestions (spec 6.3.12): what the daily run suggests (contacts to find, test emails, ownership
// asks). D1-only rows; the daily run writes them (after the prompt diffs, J3).
//   ?account=ID              one site's rows
//   ?owner=Name              the rows of that person's sites (joins partners)
//   (neither)                every row, for the Team overview card
//   &status=open|used|dismissed|all   (default: every status for ?account, open otherwise)
//   -> {"rows":[{id, run_date, kind, account_id, client, name, title, linkedin, source, subject, body, note,
//      status, reviewed_by, reviewed_at, owner, has_email}]}, newest run first, at most 500 rows.
//   to_email is left out (has_email says whether there is one): emails reach the page only through the
//   partner profile, which carries the site's open suggestions in full, and the contacts index (spec 6.7).
// Before migration 004: 404 {"error":"Not available yet","unavailable":true}.
import { json, bad } from "../../lib/crm.js";
import { hasTable } from "../../lib/tables.js";

const MAX = 500;
const STATUSES = ["open", "used", "dismissed"];
const COLS = ["id", "run_date", "kind", "account_id", "client", "name", "title", "linkedin", "source", "subject", "body", "note",
  "status", "reviewed_by", "reviewed_at"];

export async function onRequestGet({ request, env }) {
  const db = env.PARTNERS_DB;
  if (!db || !(await hasTable(db, "suggestions"))) return json({ error: "Not available yet", unavailable: true }, 404);
  const sp = new URL(request.url).searchParams;
  const account = (sp.get("account") || "").slice(0, 40);
  const owner = (sp.get("owner") || "").slice(0, 40);
  const status = sp.get("status") || (account ? "all" : "open");
  if (status !== "all" && !STATUSES.includes(status)) return bad("Pick a status: open, used, dismissed or all.");
  const where = [];
  const vals = [];
  const add = (sql, v) => {
    vals.push(v);
    where.push(sql + " ?" + vals.length);
  };
  if (account) add("s.account_id =", account);
  if (owner) add("p.owner =", owner);
  if (status !== "all") add("s.status =", status);
  vals.push(MAX);
  const sql = `SELECT ${COLS.map((c) => "s." + c).join(", ")}, p.owner AS owner,
      CASE WHEN COALESCE(s.to_email, '') <> '' THEN 1 ELSE 0 END AS has_email
    FROM suggestions s LEFT JOIN partners p ON p.id = s.account_id` +
    (where.length ? " WHERE " + where.join(" AND ") : "") + ` ORDER BY s.run_date DESC, s.id LIMIT ?${vals.length}`;
  const { results } = await db.prepare(sql).bind(...vals).all();
  return json({ rows: (results || []).map((r) => ({ ...r, has_email: !!r.has_email })) });
}
