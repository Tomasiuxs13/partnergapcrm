// POST /api/bulk (spec 6.3.4): one change on many sites, and Undo of it.
//
// ids mode {by, ids[<=500], fields: {owner?, stage?, next_due?, next_step?, type?, add_client?}, only_if_empty?: [field]}
//   - Checks everything first; nothing is written on error (400 with a sentence for the user).
//   - Set-based: per chunk of <= 90 ids, one SELECT of the before-values, then per field one INSERT of the
//     `update` edits rows and one UPDATE, with numbered parameters only: ?1 = at, ?2 = by, ?3 = the value,
//     ?4..?93 = the ids. Only sites whose value differs are touched (and with only_if_empty, only sites
//     where the field is empty). Every chunk's writes go in one db.batch, so a request is all or nothing.
//   - On Workers Free (50 statements per request) a request with many fields takes fewer ids: 90 x
//     floor(45 / (1 + 2 x fields)), at most 500 (1 field: 500; 6 fields: 270). The page sends 90 at a time.
//   - add_client appends ", <client>" to the stored text as it is (MailerLite/MailerSend -> "MailerLite/MailerSend,
//     Soro"), skips sites that already have the client (any case, spaces and "/" ignored) and sites whose
//     clients text is 190 characters or more. It must be a client name, a Melograno product ("Melograno -
//     Amelia"), a past client, or another name of 2-40 characters without , / % or _.
// rows mode {by, rows: [{id, fields: {<EDITABLE incl. clients>}}]} (used by Undo)
//   - At most meta.limits.bulk_rows rows per request (20 on Workers Free, 200 on Paid; the page sends that
//     many per request). Each row is checked like PATCH (lib/crm.js#updateStatements): one UPDATE per
//     changed site and its `update` edits rows, the same rows as PATCH writes, in one INSERT per site so a
//     request stays within the Free plan's 50 statements. A row with a bad value or an unknown id is
//     reported in `failed`; the other rows are saved together in one db.batch.
// Response (both modes): {ok, changed (a number, as legacy.html reads it), changed_ids, before: {id: {field: old}},
//   v2: {id: [v2 row]}, failed: [{ids, error}]}. ids mode sends v2 for requests of up to 90 ids (the page sends
//   90 at a time); larger requests (legacy.html) get v2: {} to stay within the statement budget.
// The allow_dnc setting ("Do not contact") is read at most once per request.
import { json, bad, body, who, text, now, fieldValue, updateStatements, dncFlag, v2Rows, EDITABLE } from "../../lib/crm.js";
import { CLIENTS, PAST_CLIENTS, DNC_STAGE, limitsFor, clientName } from "../../lib/meta.js";
import { allowDnc as readAllowDnc } from "../../lib/settings.js";

const IDS_MAX = 500;
const FREE_BUDGET = 45; // statements for the chunks of one ids-mode request on Workers Free (of 50)
const CHUNK = 90; // ids per statement: ?4..?93, under D1's 100 bound parameters
const ID_FIELDS = ["owner", "stage", "next_due", "next_step", "type"];
const BEFORE_COLS = ["owner", "stage", "next_due", "next_step", "type", "clients"];
const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);

export async function onRequestPost({ request, env }) {
  const db = env.PARTNERS_DB;
  if (!db) return bad("Partner list not connected", 404);
  const b = await body(request);
  const by = who(b);
  const limits = limitsFor(env.WORKERS_PLAN);
  if (Array.isArray(b.rows)) return rowsMode(db, b.rows, by, limits);
  return idsMode(db, b, by, limits);
}

// ---------- ids mode ----------

// The client to add: a known client's name, a Melograno product token, or another name. Throws the message.
function clientToken(raw) {
  const t = text(raw, 80).replace(/\s+/g, " ");
  if (!t) return "";
  const known = clientName(t, CLIENTS, PAST_CLIENTS);
  if (known !== t || [...CLIENTS, ...PAST_CLIENTS].some((c) => c.name === t)) return known;
  const mel = CLIENTS.find((c) => Array.isArray(c.products) && c.token);
  const m = /^melograno\s*-\s*(.+)$/i.exec(t);
  if (mel && m) {
    const p = mel.products.find((x) => x.toLowerCase() === m[1].trim().toLowerCase());
    if (p) return mel.token.replace("{product}", p);
  }
  if (t.length < 2 || t.length > 40 || /[,/%_\\]/.test(t)) throw "Client names are 2–40 characters, without commas or slashes.";
  return t;
}

async function idsMode(db, b, by, limits) {
  const ids = Array.isArray(b.ids) ? [...new Set(b.ids.map((x) => text(x, 40)).filter(Boolean))].slice(0, IDS_MAX) : [];
  if (!ids.length) return bad("Select at least one site.");
  const f = isObj(b.fields) ? b.fields : {};
  const fields = Object.keys(f).filter((k) => ID_FIELDS.includes(k));
  let token = "";
  try {
    token = "add_client" in f ? clientToken(f.add_client) : "";
  } catch (msg) {
    return bad(String(msg));
  }
  if (!fields.length && !token) return bad("Nothing to change.");
  const values = {};
  const allow = await dncFlag(db, f);
  try {
    for (const k of fields) values[k] = fieldValue(k, f[k], { allowDnc: allow });
  } catch (msg) {
    return bad(String(msg));
  }
  const onlyEmpty = new Set((Array.isArray(b.only_if_empty) ? b.only_if_empty : []).map(String).filter((k) => fields.includes(k)));
  // Workers Free runs at most 50 statements per request: each chunk costs 1 + 2 per field, and 45 leaves
  // room for the allow_dnc read and v2. One field (all legacy.html sends) still allows the full 500.
  if (limits.plan !== "paid") {
    const maxIds = Math.min(IDS_MAX, CHUNK * Math.max(1, Math.floor(FREE_BUDGET / (1 + 2 * (fields.length + (token ? 1 : 0))))));
    if (ids.length > maxIds) return bad("Send at most " + maxIds + " sites at a time.");
  }

  const at = now();
  const chunks = [];
  for (let i = 0; i < ids.length; i += CHUNK) chunks.push(ids.slice(i, i + CHUNK));
  const found = new Map();
  const stmts = [];
  const updates = []; // indexes in stmts of the UPDATE ... RETURNING id statements
  for (const part of chunks) {
    const marks = part.map((_, i) => "?" + (i + 4)).join(", ");
    const { results } = await db.prepare(`SELECT id, ${BEFORE_COLS.join(", ")} FROM partners WHERE id IN (${part.map((_, i) => "?" + (i + 1)).join(", ")})`)
      .bind(...part).all();
    for (const r of results || []) found.set(r.id, r);
    for (const k of fields) {
      const where = `id IN (${marks}) AND COALESCE(${k}, '') <> COALESCE(?3, '')` + (onlyEmpty.has(k) ? ` AND COALESCE(${k}, '') = ''` : "");
      stmts.push(db.prepare(`INSERT INTO edits (at, by_whom, kind, account_id, field, old, new) SELECT ?1, ?2, 'update', id, '${k}', ${k}, ?3 FROM partners WHERE ${where}`)
        .bind(at, by, values[k], ...part));
      updates.push(stmts.length);
      stmts.push(db.prepare(`UPDATE partners SET ${k} = ?3, updated_at = ?1, updated_by = ?2 WHERE ${where} RETURNING id`).bind(at, by, values[k], ...part));
    }
    if (token) {
      const add = "CASE WHEN COALESCE(clients, '') = '' THEN ?3 ELSE clients || ', ' || ?3 END";
      const where = `id IN (${marks}) AND (',' || lower(replace(replace(COALESCE(clients, ''), ' ', ''), '/', ',')) || ',') NOT LIKE ('%,' || lower(replace(?3, ' ', '')) || ',%')` +
        " AND length(COALESCE(clients, '')) < 190";
      stmts.push(db.prepare(`INSERT INTO edits (at, by_whom, kind, account_id, field, old, new) SELECT ?1, ?2, 'update', id, 'clients', clients, ${add} FROM partners WHERE ${where}`)
        .bind(at, by, token, ...part));
      updates.push(stmts.length);
      stmts.push(db.prepare(`UPDATE partners SET clients = ${add}, updated_at = ?1, updated_by = ?2 WHERE ${where} RETURNING id`).bind(at, by, token, ...part));
    }
  }
  const res = stmts.length ? await db.batch(stmts) : [];
  const hit = new Set();
  for (const i of updates) for (const r of (res[i] && res[i].results) || []) hit.add(r.id);
  const changedIds = ids.filter((id) => hit.has(id));
  const before = {};
  for (const id of changedIds) {
    const r = found.get(id);
    before[id] = {};
    for (const c of BEFORE_COLS) before[id][c] = r[c] == null ? null : r[c];
  }
  const v2 = {};
  if (ids.length <= CHUNK && changedIds.length) for (const row of await v2Rows(db, changedIds)) v2[row[0]] = row;
  const missing = ids.filter((id) => !found.has(id));
  const failed = missing.length ? [{ ids: missing, error: "Not found" }] : [];
  return json({ ok: true, changed: changedIds.length, changed_ids: changedIds, before, v2, failed });
}

// ---------- rows mode ----------

async function rowsMode(db, list, by, limits) {
  // One entry per id; a later entry for the same id adds its fields.
  const rows = new Map();
  for (const r of list) {
    if (!isObj(r)) continue;
    const id = text(r.id, 40);
    if (!id) continue;
    rows.set(id, Object.assign(rows.get(id) || {}, isObj(r.fields) ? r.fields : {}));
  }
  if (!rows.size) return bad("Select at least one site.");
  const max = limits.bulk_rows || 20;
  if (rows.size > max) return bad("Send at most " + max + " sites at a time.");
  const ids = [...rows.keys()];
  const found = new Map();
  for (let i = 0; i < ids.length; i += CHUNK) {
    const part = ids.slice(i, i + CHUNK);
    const { results } = await db.prepare(`SELECT * FROM partners WHERE id IN (${part.map((_, j) => "?" + (j + 1)).join(", ")})`).bind(...part).all();
    for (const r of results || []) found.set(r.id, r);
  }
  const wantsDnc = [...rows.values()].some((f) => text(f.stage, 2000) === DNC_STAGE);
  const allow = wantsDnc ? await readAllowDnc(db) : false;
  const at = now();
  const stmts = [];
  const changedIds = [];
  const before = {};
  const errors = new Map(); // error -> [ids]
  const fail = (id, msg) => errors.set(msg, (errors.get(msg) || []).concat(id));
  for (const id of ids) {
    const row = found.get(id);
    if (!row) {
      fail(id, "Not found");
      continue;
    }
    const fields = rows.get(id);
    let u;
    try {
      u = updateStatements(db, row, fields, by, at, { allowDnc: allow });
    } catch (msg) {
      fail(id, String(msg));
      continue;
    }
    const keys = Object.keys(u.changed);
    if (!keys.length) continue;
    // The UPDATE of lib/crm.js#updateStatements, then its `update` rows (same values and order) in one INSERT.
    stmts.push(u.statements[0]);
    const vals = [at, by, id];
    const tuples = keys.map((k) => {
      const old = row[k] == null ? null : String(row[k]);
      const v = u.changed[k] == null ? null : String(u.changed[k]);
      vals.push(k, old, v);
      const p = vals.length;
      return `(?1, ?2, 'update', ?3, ?${p - 2}, ?${p - 1}, ?${p})`;
    });
    stmts.push(db.prepare("INSERT INTO edits (at, by_whom, kind, account_id, field, old, new) VALUES " + tuples.join(", ")).bind(...vals));
    changedIds.push(id);
    before[id] = {};
    for (const k of Object.keys(fields)) if (EDITABLE.includes(k)) before[id][k] = row[k] == null ? null : row[k];
  }
  if (stmts.length) await db.batch(stmts);
  const v2 = {};
  if (changedIds.length) for (const row of await v2Rows(db, changedIds)) v2[row[0]] = row;
  const failed = [...errors].map(([error, list2]) => ({ ids: list2, error }));
  return json({ ok: true, changed: changedIds.length, changed_ids: changedIds, before, v2, failed });
}
