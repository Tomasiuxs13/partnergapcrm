// POST /api/partner/:id/outcome (spec 6.3.3): one "Log what happened" outcome in one request.
//   Request  {by, fields?: {<EDITABLE>: value}, activity?: {type, summary, contact_id?, client?}}, at least one of the two.
//            activity.client defaults to the site's first client when the key is left out.
//   Checks   everything first; nothing is written on error: 400 {"error": "<sentence>"} or 404 {"error": "Not found"}.
//   Writes   one db.batch, in the old UI's order (drawer Save, then Log): the PATCH statements (one UPDATE plus
//            one `update` edits row per changed field), then the activity row, its `activity` edits row
//            (field = the new activity.n) and, for Email, Call and Meeting, partners.last_touch.
//            The edits rows equal golden/patch-partner.json followed by golden/activity-log.json.
//   Response 201 when an activity was logged, else 200:
//            {ok, changed, partner, v2, activity: {n, date, contact_id, type, by_whom, summary, client} | null, last_touch?}
import {
  json, bad, body, who, text, today, now, readPartner, dncFlag, updateStatements, activityInput, activityStatements, v2Row,
} from "../../../../lib/crm.js";
import { clientName, firstClient } from "../../../../lib/meta.js";

const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);

export async function onRequestPost({ request, env, params }) {
  const db = env.PARTNERS_DB;
  if (!db) return bad("Not connected", 404);
  const id = String(params.id || "");
  const b = await body(request);
  const by = who(b);
  const fields = isObj(b.fields) ? b.fields : {};
  const hasActivity = isObj(b.activity);
  if (!Object.keys(fields).length && !hasActivity) return bad("Nothing to save. Pick what happened or change a field.");
  const input = hasActivity ? activityInput(b.activity) : null;
  if (input && input.error) return bad(input.error);
  const row = await readPartner(db, id);
  if (!row) return bad("Not found", 404);

  const at = now(), date = today();
  let upd;
  try {
    upd = updateStatements(db, row, fields, by, at, { allowDnc: await dncFlag(db, fields) });
  } catch (msg) {
    return bad(String(msg));
  }
  const statements = upd.statements.slice();
  let activity = null, touch = false;
  if (input) {
    const after = { ...row, ...upd.changed };
    const client = b.activity.client !== undefined ? text(b.activity.client, 60) || null : clientName(firstClient(after.clients)) || null;
    const act = activityStatements(db, { id, by, at, date, ...input, client });
    activity = { n: null, date, contact_id: input.contact_id, type: input.type, by_whom: by, summary: input.summary, client };
    touch = act.touch;
    statements.push(...act.statements);
  }
  let partner = row;
  if (statements.length) {
    const res = await db.batch(statements);
    if (activity) activity.n = res[upd.statements.length].meta.last_row_id;
    partner = await readPartner(db, id);
  }
  return json({ ok: true, changed: upd.changed, partner, v2: await v2Row(db, partner), activity, last_touch: touch ? date : undefined },
    activity ? 201 : 200);
}
