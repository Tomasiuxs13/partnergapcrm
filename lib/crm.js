// Shared helpers for the CRM's write API. Every write is also logged in the `edits` table so the
// daily run can copy it into the Google Sheet, which stays the source of truth.

export const STAGES = ["New", "Researching", "Contacted", "Replied", "Negotiating", "Active", "Lost"];
export const DEAL_MODELS = ["Commission (CPA)", "Revenue share", "Flat fee", "Flat fee + commission", "Free placement", "Gifted product"];
export const ACTIVITY_TYPES = ["Email", "Call", "Meeting", "Note", "Deal update", "Content live"];

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
export function fieldValue(field, v) {
  const s = text(v, 2000);
  switch (field) {
    case "stage":
      if (!STAGES.includes(s)) throw "Pick a stage from the list.";
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

// Applies field changes to one partner and logs each change. Returns the changed fields.
export async function updatePartner(db, id, fields, by) {
  const row = await db.prepare("SELECT * FROM partners WHERE id = ?").bind(id).first();
  if (!row) return null;
  const changes = {};
  for (const f of Object.keys(fields)) {
    if (!EDITABLE.includes(f)) continue;
    const v = fieldValue(f, fields[f]);
    const old = row[f] == null ? null : row[f];
    if (String(old ?? "") !== String(v ?? "")) changes[f] = { old, v };
  }
  const keys = Object.keys(changes);
  if (!keys.length) return {};
  const at = now();
  const stmts = [
    db.prepare(`UPDATE partners SET ${keys.map((k) => k + " = ?").join(", ")}, updated_at = ?, updated_by = ? WHERE id = ?`)
      .bind(...keys.map((k) => changes[k].v), at, by, id),
    ...keys.map((k) =>
      db.prepare("INSERT INTO edits (at, by_whom, kind, account_id, field, old, new) VALUES (?, ?, 'update', ?, ?, ?, ?)")
        .bind(at, by, id, k, changes[k].old == null ? null : String(changes[k].old), changes[k].v == null ? null : String(changes[k].v))
    ),
  ];
  await db.batch(stmts);
  const out = {};
  keys.forEach((k) => (out[k] = changes[k].v));
  return out;
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
