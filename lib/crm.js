// Shared helpers for the CRM's write API. Every write is also logged in the `edits` table so the
// daily run can copy it into the Google Sheet, which stays the source of truth. The rows each write
// path adds are a frozen contract (crm/docs/edits-contract.md, tests/e2e/golden/).
import { STAGES, DNC_STAGE, DEAL_MODELS, ACTIVITY_TYPES } from "./meta.js";
import { allowDnc } from "./settings.js";
import { hasTable } from "./tables.js";

export { STAGES, DEAL_MODELS, ACTIVITY_TYPES };

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const EMAIL = /^[^\s@<>,;]+@[^\s@<>,;]+\.[a-z]{2,}$/i;
const DOMAIN = /^[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/i;

export const today = () => new Date().toISOString().slice(0, 10);
export const now = () => new Date().toISOString().replace(/\.\d+Z$/, "Z");

export function json(data, status = 200) {
  return Response.json(data, { status, headers: { "Cache-Control": "private, no-store" } });
}
export const bad = (msg, status = 400) => json({ error: msg }, status);

export async function body(request) {
  try {
    const b = await request.json();
    return b && typeof b === "object" && !Array.isArray(b) ? b : {};
  } catch (e) {
    return {};
  }
}

export function who(b) {
  return text(b.by, 40) || "Someone";
}

export function text(v, max) {
  if (v == null) return "";
  return String(v).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").trim().slice(0, max);
}

// Temporary ids for new sites and contacts: NEW-nnnn and NEWC-nnnn (spec 1.3, 6.4). The daily run renames
// them to PG-/C- ids (R2), so the highest number left in the table drops after each run, and MAX + 1 alone
// would hand a renamed id out again: an old link or recent-site entry for NEW-0012 would then open a
// different site (spec 2.4 expects "That site wasn't found"). kv_meta (migration 003) keeps the highest
// number handed out (new_site_n, new_contact_n), so a number is never reused. Without kv_meta: MAX + 1.
// Returns {id, stmts}: put stmts in the same db.batch as the INSERT (they record the number).
const TEMP_IDS = {
  site: { prefix: "NEW-", table: "partners", key: "new_site_n" },
  contact: { prefix: "NEWC-", table: "contacts", key: "new_contact_n" },
};
export async function nextTempId(db, kind) {
  const t = TEMP_IDS[kind];
  const inTable = `SELECT COALESCE(MAX(CAST(SUBSTR(id, ${t.prefix.length + 1}) AS INTEGER)), 0) AS n FROM ${t.table} WHERE id LIKE '${t.prefix}%'`;
  const kv = await hasTable(db, "kv_meta");
  const last = kv
    ? await db.prepare(`SELECT MAX(n) AS n FROM (${inTable} UNION ALL SELECT CAST(v AS INTEGER) AS n FROM kv_meta WHERE k = ?1)`).bind(t.key).first()
    : await db.prepare(inTable).first();
  const n = (last && Number(last.n)) || 0;
  const id = t.prefix + String(n + 1).padStart(4, "0");
  const stmts = kv
    ? [db.prepare("INSERT INTO kv_meta (k, v, at, by_whom) VALUES (?1, ?2, ?3, 'site') ON CONFLICT(k) DO UPDATE SET " +
        "v = excluded.v, at = excluded.at, by_whom = excluded.by_whom WHERE CAST(kv_meta.v AS INTEGER) < CAST(excluded.v AS INTEGER)")
        .bind(t.key, String(n + 1), now())]
    : [];
  return { id, stmts };
}

// Creator platforms keep the channel path (youtube.com/@name), so two channels are two partners.
const PLATFORMS = /^(youtube\.com|instagram\.com|tiktok\.com|x\.com|twitter\.com|facebook\.com|linkedin\.com|medium\.com|twitch\.tv|pinterest\.com)$/;

export function cleanDomain(v) {
  const raw = text(v, 300).toLowerCase().replace(/^https?:\/\//, "").replace(/^(www|m)\./, "").split(/[?#\s]/)[0];
  const [host, ...path] = raw.split("/");
  if (!DOMAIN.test(host)) return "";
  const seg = path.filter(Boolean);
  if (PLATFORMS.test(host) && seg.length) {
    const keep = /^(channel|c|user|in|company)$/.test(seg[0]) && seg[1] ? seg.slice(0, 2) : seg.slice(0, 1);
    return (host + "/" + keep.join("/")).slice(0, 200);
  }
  return host;
}

export function validEmail(v) {
  const e = text(v, 200).toLowerCase();
  return EMAIL.test(e) ? e : "";
}

// Turns one field from the site into the value stored in D1, or throws a message for the user.
// "Do not contact" is a valid stage only with {allowDnc: true} (kv_meta allow_dnc = "1", spec D3).
export function fieldValue(field, v, { allowDnc = false } = {}) {
  const s = text(v, 2000);
  switch (field) {
    case "stage":
      if (!STAGES.includes(s) && !(allowDnc && s === DNC_STAGE)) throw "Pick a stage from the list.";
      return s;
    case "deal_model":
      if (s && !DEAL_MODELS.includes(s)) throw "Pick a deal type from the list.";
      return s || null;
    case "owner":
      return text(s, 40) || null;
    case "clients":
      return s.split(/\s*,\s*/).filter(Boolean).slice(0, 12).join(", ").slice(0, 200) || null;
    case "type":
      return text(s, 60) || null;
    case "next_step":
      return text(s, 500) || null;
    case "tracking_id":
      return text(s, 200) || null;
    case "next_due":
    case "live_date":
      if (s && !DAY.test(s)) throw "Use a date like 2026-10-31.";
      return s || null;
    case "content_url":
      if (s && !/^https?:\/\/[^\s]+$/i.test(s)) throw "The placement link must start with http:// or https://.";
      return text(s, 500) || null;
    case "deal_flat":
    case "deal_pct":
    case "deal_value": {
      if (s === "") return null;
      const n = Number(s.replace(/[$,%\s]/g, ""));
      if (!isFinite(n) || n < 0 || n > 10000000) throw "Enter a number.";
      if (field === "deal_pct" && n > 100) throw "Commission is a percentage up to 100.";
      return Math.round(n * 100) / 100;
    }
    default:
      throw "That field can't be edited here.";
  }
}
export const EDITABLE = ["stage", "owner", "clients", "type", "next_step", "next_due", "deal_model", "deal_flat", "deal_pct", "deal_value", "content_url", "live_date", "tracking_id"];

/** The partners row, or null. */
export async function readPartner(db, id) {
  return (await db.prepare("SELECT * FROM partners WHERE id = ?").bind(id).first()) || null;
}

/**
 * Whether this request may store "Do not contact": reads the allow_dnc setting (one query) only when
 * the fields ask for that stage, so the usual request costs nothing extra.
 */
export async function dncFlag(db, fields) {
  const want = fields && typeof fields === "object" && text(fields.stage, 2000) === DNC_STAGE;
  return want ? allowDnc(db) : false;
}

/**
 * The statements that apply field changes to one partner row (spec 6.3.3 step 1): one UPDATE of the
 * changed columns plus updated_at/updated_by, then one `update` edits row per changed field, in the
 * order of the keys in `fields`. Keys outside EDITABLE are ignored. Every value is checked first and a
 * bad one throws the user's message, so nothing is written on error. No change gives no statements.
 * @returns {{statements: D1PreparedStatement[], changed: object}} changed = {field: stored value}
 */
export function updateStatements(db, row, fields, by, at = now(), { allowDnc = false } = {}) {
  const changes = {};
  for (const f of Object.keys(fields || {})) {
    if (!EDITABLE.includes(f)) continue;
    const v = fieldValue(f, fields[f], { allowDnc });
    const old = row[f] == null ? null : row[f];
    if (String(old ?? "") !== String(v ?? "")) changes[f] = { old, v };
  }
  const keys = Object.keys(changes);
  const changed = {};
  keys.forEach((k) => (changed[k] = changes[k].v));
  if (!keys.length) return { statements: [], changed };
  const statements = [
    db.prepare(`UPDATE partners SET ${keys.map((k) => k + " = ?").join(", ")}, updated_at = ?, updated_by = ? WHERE id = ?`)
      .bind(...keys.map((k) => changes[k].v), at, by, row.id),
    ...keys.map((k) =>
      db.prepare("INSERT INTO edits (at, by_whom, kind, account_id, field, old, new) VALUES (?, ?, 'update', ?, ?, ?, ?)")
        .bind(at, by, row.id, k, changes[k].old == null ? null : String(changes[k].old), changes[k].v == null ? null : String(changes[k].v))
    ),
  ];
  return { statements, changed };
}

// Applies field changes to one partner and logs each change. Returns the changed fields, or null when
// the id is unknown. opts.allowDnc skips the allow_dnc lookup when the caller already read it.
export async function updatePartner(db, id, fields, by, opts = {}) {
  const row = await readPartner(db, id);
  if (!row) return null;
  const allow = opts.allowDnc !== undefined ? !!opts.allowDnc : await dncFlag(db, fields);
  const { statements, changed } = updateStatements(db, row, fields, by, now(), { allowDnc: allow });
  if (statements.length) await db.batch(statements);
  return changed;
}

// ---------- activity (spec 6.3.3 statements 2-4) ----------

const TOUCH = ["Email", "Call", "Meeting"];

/** Checks an activity in a request body: {type, summary, contact_id}, or {error} with the user's message. */
export function activityInput(b) {
  const a = b && typeof b === "object" ? b : {};
  const type = ACTIVITY_TYPES.includes(a.type) ? a.type : "";
  const summary = text(a.summary, 2000);
  if (!type) return { error: "Pick what happened." };
  if (!summary) return { error: "Write a short summary." };
  return { type, summary, contact_id: text(a.contact_id, 20) || null };
}

/**
 * The statements that log one activity, for a single db.batch: the activity row, then its `activity`
 * edits row whose field is CAST(last_insert_rowid() AS TEXT) (the new activity.n; that statement must
 * directly follow the INSERT), then for Email, Call and Meeting partners.last_touch = date.
 * In the batch result, the first statement's meta.last_row_id is the new n.
 */
export function activityStatements(db, { id, by, at, date, type, summary, contact_id = null, client = null }) {
  const touch = TOUCH.includes(type);
  const statements = [
    db.prepare("INSERT INTO activity (date, account_id, contact_id, type, by_whom, summary, client) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .bind(date, id, contact_id, type, by, summary, client),
    db.prepare("INSERT INTO edits (at, by_whom, kind, account_id, contact_id, field, new) VALUES (?, ?, 'activity', ?, ?, CAST(last_insert_rowid() AS TEXT), ?)")
      .bind(at, by, id, contact_id, JSON.stringify({ date, type, summary, client })),
  ];
  if (touch) statements.push(db.prepare("UPDATE partners SET last_touch = ?, updated_at = ?, updated_by = ? WHERE id = ?").bind(date, at, by, id));
  return { statements, touch };
}

// ---------- the v2 list row (spec 6.3.2) ----------

/** Columns of GET /api/partners?v=2 and of every "v2" in a write response, in order. */
export const V2_COLS = ["id", "domain", "name", "label", "type", "dr", "traffic", "owner", "stage", "last_touch", "clients", "country",
  "contacts", "next_step", "next_due", "deal_model", "deal_flat", "deal_pct", "deal_value", "live_date", "content_url", "tracking_id",
  "source", "updated_at", "updated_by", "last_email", "replied_contact", "act_at", "sugg"];

const LOOKUPS = ["label", "last_email", "replied_contact", "act_at", "sugg"];

// A nameless creator's label comes from a contact: first + last name, else the email's local part.
// Contacts with a name come first, then the primary contact, then the lowest id. contactLabel() below is
// the same rule in JS (tests/unit/snapshot-sheet.test.mjs runs both on the same contacts).
function contactLabelSql(idExpr) {
  const named = "TRIM(COALESCE(k.first_name, '') || COALESCE(k.last_name, ''))";
  return `(SELECT COALESCE(NULLIF(TRIM(COALESCE(k.first_name, '') || ' ' || COALESCE(k.last_name, '')), ''),
      NULLIF(TRIM(substr(k.email, 1, instr(k.email, '@') - 1)), ''))
    FROM contacts k WHERE k.account_id = ${idExpr} AND (${named} <> '' OR instr(COALESCE(k.email, ''), '@') > 1)
    ORDER BY ${named} = '', COALESCE(k.primary_contact, 0) DESC, k.id LIMIT 1)`;
}

// label = name || domain || <contact label> || 'Unnamed creator'. COALESCE stops at the first value, so
// the contact lookup runs only for rows with no name and no domain.
const LABEL_SQL = `COALESCE(NULLIF(p.name, ''), NULLIF(p.domain, ''), ${contactLabelSql("p.id")}, 'Unnamed creator')`;
const SUGG_WHERE = "status = 'open' AND kind IN ('candidate', 'email')";

/**
 * The v2 SELECT. mode "list": every row, with the grouped joins of spec 6.3.2. mode "ids": rows whose id
 * is one of ?1..?n (n <= 90), with indexed per-row lookups. sugg: the suggestions table exists.
 * Both modes give the same values for the same row.
 */
export function v2Sql({ mode = "list", n = 0, sugg = false } = {}) {
  const list = mode === "list";
  const expr = {
    label: LABEL_SQL,
    last_email: list ? "c.last_email" : "(SELECT MAX(last_email) FROM contacts WHERE account_id = p.id)",
    replied_contact: list ? "c.replied_contact" : "(SELECT MAX(replied) FROM contacts WHERE account_id = p.id)",
    act_at: list ? "a.act_at" : "(SELECT MAX(date) FROM activity WHERE account_id = p.id)",
    sugg: !sugg ? "NULL" : list ? "g.sugg" : `(SELECT NULLIF(COUNT(*), 0) FROM suggestions WHERE account_id = p.id AND ${SUGG_WHERE})`,
  };
  const cols = V2_COLS.map((c) => (LOOKUPS.includes(c) ? expr[c] + " AS " + c : "p." + c)).join(", ");
  if (!list) {
    const marks = Array.from({ length: n }, (_, i) => "?" + (i + 1)).join(", ");
    return `SELECT ${cols} FROM partners p WHERE p.id IN (${marks}) ORDER BY p.id`;
  }
  return `SELECT ${cols} FROM partners p
    LEFT JOIN (SELECT account_id, MAX(last_email) last_email, MAX(replied) replied_contact FROM contacts GROUP BY account_id) c ON c.account_id = p.id
    LEFT JOIN (SELECT account_id, MAX(date) act_at FROM activity GROUP BY account_id) a ON a.account_id = p.id
    ${sugg ? `LEFT JOIN (SELECT account_id, COUNT(*) sugg FROM suggestions WHERE ${SUGG_WHERE} GROUP BY account_id) g ON g.account_id = p.id` : ""}
    ORDER BY p.id`;
}

/** v2 rows (arrays in V2_COLS order) for up to any number of ids, 90 per query, sorted by id. */
export async function v2Rows(db, ids) {
  const list = [...new Set((ids || []).map(String))];
  if (!list.length) return [];
  const sugg = await hasTable(db, "suggestions");
  const out = [];
  for (let i = 0; i < list.length; i += 90) {
    const part = list.slice(i, i + 90);
    out.push(...(await db.prepare(v2Sql({ mode: "ids", n: part.length, sugg })).bind(...part).raw()));
  }
  return out.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

const filled = (v) => v != null && v !== "";

/** True when the v2 label needs a contact: the row has no name and no domain. */
export function needsContactLabel(row) {
  return !filled(row.name) && !filled(row.domain);
}

// SQLite's TRIM(x) removes spaces only.
const sqlTrim = (s) => String(s).replace(/^ +| +$/g, "");

/** SQLite's BINARY order (UTF-8 bytes, which is code point order) for two strings: <0, 0 or >0. */
export function binaryCompare(a, b) {
  const x = String(a);
  const y = String(b);
  for (let i = 0, j = 0; i < x.length && j < y.length; ) {
    const cx = x.codePointAt(i);
    const cy = y.codePointAt(j);
    if (cx !== cy) return cx - cy;
    i += cx > 0xffff ? 2 : 1;
    j += cy > 0xffff ? 2 : 1;
  }
  return [...x].length - [...y].length;
}

/**
 * contactLabelSql in JS, for code that holds the contacts rather than a database (the snapshot builder's
 * Sheets path): the label of the first matching contact in [{id, first_name, last_name, email,
 * primary_contact}], or null.
 */
export function contactLabel(contacts) {
  const named = (k) => sqlTrim((k.first_name || "") + (k.last_name || ""));
  const at = (k) => String(k.email || "").indexOf("@");
  const pick = (contacts || []).filter((k) => named(k) !== "" || at(k) > 0)
    .sort((a, b) => (named(a) === "") - (named(b) === "") || (Number(b.primary_contact) || 0) - (Number(a.primary_contact) || 0) || binaryCompare(a.id, b.id))[0];
  if (!pick) return null;
  return sqlTrim((pick.first_name || "") + " " + (pick.last_name || "")) || (at(pick) > 0 && sqlTrim(pick.email.slice(0, at(pick)))) || null;
}

/**
 * The v2 array (V2_COLS order) of a partners row and its lookups {last_email, replied_contact, act_at, sugg,
 * contact_label}: LABEL_SQL in JS. v2Row uses it, and so does the snapshot builder for a Sheets dump
 * (crm/scripts/snapshot/sheet.mjs), so both shape a row the same way.
 */
export function v2FromParts(row, x = {}) {
  const label = filled(row.name) ? row.name : filled(row.domain) ? row.domain : filled(x.contact_label) ? x.contact_label : "Unnamed creator";
  return V2_COLS.map((c) => (c === "label" ? label : LOOKUPS.includes(c) ? x[c] ?? null : row[c] ?? null));
}

/**
 * One v2 row for a partners row (`SELECT *` result): the row's columns plus three small indexed lookups
 * (contacts aggregate, last activity date, open suggestions) and the label. Write responses add it as
 * "v2", so the page can patch its list without a reload.
 */
export async function v2Row(db, row) {
  if (!row) return null;
  const sugg = await hasTable(db, "suggestions");
  const x = (await db.prepare(`SELECT (SELECT MAX(last_email) FROM contacts WHERE account_id = ?1) AS last_email,
      (SELECT MAX(replied) FROM contacts WHERE account_id = ?1) AS replied_contact,
      (SELECT MAX(date) FROM activity WHERE account_id = ?1) AS act_at,
      ${sugg ? `(SELECT NULLIF(COUNT(*), 0) FROM suggestions WHERE account_id = ?1 AND ${SUGG_WHERE})` : "NULL"} AS sugg,
      ${needsContactLabel(row) ? contactLabelSql("?1") : "NULL"} AS contact_label`).bind(row.id).first()) || {};
  return v2FromParts(row, x);
}

// Finds accounts on the same site, so nobody pitches a partner another manager already owns.
export async function findDomain(db, domain) {
  // Plain string comparisons (no LIKE patterns built from stored domains): same site, a subdomain
  // either way, or a channel path on the same site such as youtube.com/@name.
  const { results } = await db.prepare(
    `WITH p AS (SELECT id, domain, name, owner, stage, clients,
       CASE WHEN lower(domain) LIKE 'www.%' THEN substr(lower(domain), 5) ELSE lower(domain) END AS d FROM partners WHERE domain IS NOT NULL AND domain != '')
     SELECT id, domain, name, owner, stage, clients FROM p
     WHERE d = ?1 OR substr(d, -length(?1) - 1) = '.' || ?1 OR substr(?1, -length(d) - 1) = '.' || d OR substr(d, 1, length(?1) + 1) = ?1 || '/'
     LIMIT 5`
  ).bind(domain).all();
  return results;
}
