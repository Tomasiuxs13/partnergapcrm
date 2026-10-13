// Saves one client's affiliate program terms from the client page.
import { json, bad, body, who, text, now } from "../../../lib/crm.js";

const FIELDS = { network: 80, commission: 200, payout_terms: 300, signup_url: 300, brief: 3000 };

export async function onRequestPut({ request, env, params }) {
  const db = env.PARTNERS_DB;
  if (!db) return bad("Not connected", 404);
  const k = text(params.k, 40).toLowerCase();
  if (!/^[a-z0-9 -]+$/.test(k)) return bad("Unknown client.");
  const b = await body(request);
  const by = who(b);
  const v = {};
  for (const f in FIELDS) v[f] = text(b[f], FIELDS[f]) || null;
  if (v.signup_url && !/^https?:\/\//i.test(v.signup_url)) return bad("The sign-up link must start with http:// or https://.");
  const cd = text(b.cookie_days, 6);
  const cookie = cd === "" ? null : Number(cd);
  if (cookie != null && (!Number.isInteger(cookie) || cookie < 0 || cookie > 3650)) return bad("Cookie length is a number of days.");
  const at = now();
  await db.batch([
    db.prepare(`INSERT INTO client_programs (k, network, commission, cookie_days, payout_terms, signup_url, brief, updated_at, updated_by)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(k) DO UPDATE SET network=excluded.network, commission=excluded.commission, cookie_days=excluded.cookie_days,
                payout_terms=excluded.payout_terms, signup_url=excluded.signup_url, brief=excluded.brief, updated_at=excluded.updated_at, updated_by=excluded.updated_by`)
      .bind(k, v.network, v.commission, cookie, v.payout_terms, v.signup_url, v.brief, at, by),
    db.prepare("INSERT INTO edits (at, by_whom, kind, field, new) VALUES (?, ?, 'client_program', ?, ?)")
      .bind(at, by, k, JSON.stringify({ ...v, cookie_days: cookie })),
  ]);
  return json({ ok: true, program: await db.prepare("SELECT * FROM client_programs WHERE k = ?").bind(k).first() });
}
