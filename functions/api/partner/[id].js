// One partner's profile for the record panel: details, contacts (with emails; the login in
// functions/_middleware.js covers this route), activity, the site's edit history and open suggestions.
//   GET   /api/partner/:id (spec 6.3.8)
//         {partner, contacts, activity, about, about_pending, history: {edits}, suggestions}
//         - activity rows: n, date, contact_id, type, by_whom, summary, client (newest first)
//         - history.edits: [{n, at, by_whom, kind, field, old, new, state, contact_id}], newest first, max 200.
//           state: copied (applied = 1), not_copied (applied = 0 below the highest applied n: a sheet edit
//           won, R5) or waiting
//         - suggestions: the site's open daily-run suggestions; null before migration 004
//         - deals (oldest first) and files (newest first): null before migration 006
//         - about: only from the 7-day cache, never fetched inline. On a miss about is null and
//           about_pending is true (GET /api/partner/:id/about answers it); the cache is warmed in the
//           background, so the next open has it.
//         404 {"error":"Not found"}.
//   PATCH /api/partner/:id: unchanged, plus "v2" (the row in /api/partners?v=2 column order). 400 with
//         the field check's sentence; a D1 failure is thrown (a 500), never a 400 with the D1 text.
import { json, bad, body, who, updatePartner, readPartner, v2Row } from "../../../lib/crm.js";
import { hasTables } from "../../../lib/tables.js";
import { cachedAbout, siteAbout, aboutable } from "../../../lib/about.js";

const HISTORY_MAX = 200;

export async function onRequestGet({ env, params, waitUntil }) {
  if (!env.PARTNERS_DB) return new Response("Partner list not connected", { status: 404 });
  const id = String(params.id || "");
  const db = env.PARTNERS_DB;
  const partner = await readPartner(db, id);
  if (!partner) return bad("Not found", 404);
  const t = await hasTables(db, ["suggestions", "deals", "files"]);
  const sugg = t.suggestions;
  const stmts = [
    db.prepare("SELECT * FROM contacts WHERE account_id = ? ORDER BY primary_contact DESC, replied DESC, last_email DESC").bind(id),
    db.prepare("SELECT n, date, contact_id, type, by_whom, summary, client FROM activity WHERE account_id = ? ORDER BY date DESC, n DESC").bind(id),
    db.prepare(`SELECT n, at, by_whom, kind, field, old, new,
        CASE WHEN applied = 1 THEN 'copied'
             WHEN n < COALESCE((SELECT MAX(n) FROM edits WHERE applied = 1), 0) THEN 'not_copied'
             ELSE 'waiting' END AS state, contact_id
      FROM edits WHERE account_id = ?1 ORDER BY n DESC LIMIT ${HISTORY_MAX}`).bind(id),
  ];
  const at = {};
  const add = (k, stmt) => { at[k] = stmts.length; stmts.push(stmt); };
  if (sugg) add("sugg", db.prepare("SELECT * FROM suggestions WHERE account_id = ? AND status = 'open' ORDER BY run_date DESC, id").bind(id));
  if (t.deals) add("deals", db.prepare("SELECT * FROM deals WHERE account_id = ? ORDER BY created, id").bind(id));
  if (t.files) add("files", db.prepare("SELECT * FROM files WHERE account_id = ? ORDER BY n DESC").bind(id));
  const res = await db.batch(stmts);
  const rows = (i) => (res[i] && res[i].results) || [];
  const opt = (k) => (k in at ? rows(at[k]) : null);
  let about = null, aboutPending = false;
  if (aboutable(partner.domain)) {
    about = await cachedAbout(partner.domain);
    if (!about) {
      aboutPending = true;
      // Warm the cache without making this answer wait (the old page shows it on the next open).
      if (waitUntil && typeof caches !== "undefined") waitUntil(siteAbout(String(partner.domain)).catch(() => null));
    }
  }
  return Response.json(
    {
      partner,
      contacts: rows(0),
      activity: rows(1),
      about,
      about_pending: aboutPending,
      history: { edits: rows(2) },
      suggestions: opt("sugg"),
      deals: opt("deals"),
      files: opt("files"),
    },
    { headers: { "Cache-Control": "private, no-store" } }
  );
}

// Saves edits from the record panel: stage, owner, next step, deal terms and placement.
export async function onRequestPatch({ request, env, params }) {
  const db = env.PARTNERS_DB;
  if (!db) return bad("Not connected", 404);
  const b = await body(request);
  let changed;
  try {
    changed = await updatePartner(db, String(params.id || ""), b.fields && typeof b.fields === "object" ? b.fields : {}, who(b));
  } catch (msg) {
    // A sentence from the field checks is the user's 400; a real Error (a D1 failure) is a 500, so the
    // page shows its own "The server couldn't save this…" (spec 4.11), never the raw D1 text.
    if (msg instanceof Error) throw msg;
    return bad(String(msg));
  }
  if (changed === null) return bad("Not found", 404);
  const partner = await db.prepare("SELECT * FROM partners WHERE id = ?").bind(String(params.id)).first();
  // v2: the row in /api/partners?v=2 column order, so the page can upsert it (spec 6.3.2).
  return json({ ok: true, changed, partner, v2: await v2Row(db, partner) });
}
