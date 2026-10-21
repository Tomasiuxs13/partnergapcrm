// GET /api/team-activity?days=7 (spec 6.3.7): site edits per person, for Team overview.
//   {"since":"<ISO>","days":7,"by":{"Kamile":{"total":12,"update":7,"activity":4,"create_account":1,
//     "create_contact":0,"client_program":0,"last_at":"<ISO>"}}}
//   total and the per-kind counts cover the last `days` days (1-90, default 7); last_at is the person's
//   latest edit on the site ever ("Last active on the site"), so a person with only older edits is listed
//   with total 0. Edits without a name count as "Someone". Changes made in the Google Sheet are not here.
import { json } from "../../lib/crm.js";

const KINDS = ["update", "activity", "create_account", "create_contact", "client_program"];

export async function onRequestGet({ request, env }) {
  const db = env.PARTNERS_DB;
  if (!db) return json({ error: "Partner list not connected" }, 404);
  const d = Number(new URL(request.url).searchParams.get("days"));
  const days = Number.isInteger(d) && d > 0 ? Math.min(d, 90) : 7;
  const since = new Date(Date.now() - days * 86400000).toISOString().replace(/\.\d+Z$/, "Z");
  const [win, last] = await db.batch([
    db.prepare("SELECT by_whom, kind, COUNT(*) AS c, MAX(at) AS last_at FROM edits WHERE at >= ?1 GROUP BY by_whom, kind").bind(since),
    db.prepare("SELECT by_whom, MAX(at) AS last_at FROM edits GROUP BY by_whom"),
  ]);
  const by = {};
  const person = (name) => {
    const k = name == null || String(name).trim() === "" ? "Someone" : String(name);
    if (!by[k]) {
      by[k] = { total: 0 };
      for (const kind of KINDS) by[k][kind] = 0;
      by[k].last_at = null;
    }
    return by[k];
  };
  for (const r of last.results || []) {
    const p = person(r.by_whom);
    if (!p.last_at || (r.last_at && r.last_at > p.last_at)) p.last_at = r.last_at;
  }
  for (const r of win.results || []) {
    const p = person(r.by_whom);
    p[r.kind] = (p[r.kind] || 0) + r.c;
    p.total += r.c;
  }
  return json({ since, days, by });
}
