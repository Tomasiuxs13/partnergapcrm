// Site settings stored in D1 kv_meta (migration 003): the team and client overrides and the
// allow_dnc switch (spec 6.3.11, D3, D11). D1-only: settings never write an `edits` row and never
// reach the Google Sheet. /api/meta merges the overrides on every call; the middleware reads the team
// for the sign-in form; lib/crm.js and bulk read allow_dnc once per request.
// Before 003 exists every reader returns the defaults (no overrides, allow_dnc off).
import { hasTable } from "./tables.js";
import { TEAM, CLIENTS, PAST_CLIENTS, slugOf } from "./meta.js";

export const SETTING_KEYS = ["team", "clients", "allow_dnc"];

const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);
const str = (v, max) => (v == null ? "" : String(v).replace(/[\u0000-\u001f]/g, " ").trim().slice(0, max));

function parse(v) {
  try {
    return JSON.parse(v);
  } catch (e) {
    return undefined;
  }
}

/** kv_meta rows for the given keys as {k: {v, at, by_whom}}; {} without the table. */
export async function readKv(db, keys) {
  if (!db || !keys.length || !(await hasTable(db, "kv_meta"))) return {};
  const marks = keys.map((_, i) => "?" + (i + 1)).join(", ");
  const { results } = await db.prepare(`SELECT k, v, at, by_whom FROM kv_meta WHERE k IN (${marks})`).bind(...keys).all();
  const out = {};
  for (const r of results || []) out[r.k] = { v: r.v, at: r.at, by_whom: r.by_whom };
  return out;
}

// One team entry: {name, home?, active?}. active is kept only when false (inactive names leave the
// menus but stay known as past owners).
function cleanMember(m) {
  const name = str(isObj(m) ? m.name : m, 40);
  if (name.length < 2) return null;
  const out = { name };
  if (isObj(m) && (m.home === "today" || m.home === "team")) out.home = m.home;
  if (isObj(m) && m.active === false) out.active = false;
  return out;
}

function cleanClient(c) {
  if (!isObj(c)) return null;
  const name = str(c.name, 60);
  const k = str(c.k, 60).toLowerCase() || name.toLowerCase();
  if (!k) return null;
  const out = { k };
  if (name) out.name = name;
  if (c.what != null) out.what = str(c.what, 200);
  if (Array.isArray(c.managers)) out.managers = c.managers.map((m) => str(m, 40)).filter(Boolean);
  if (c.markets != null) out.markets = str(c.markets, 100);
  if (c.category != null) out.category = str(c.category, 40);
  if (c.past === true || c.past === false) out.past = c.past;
  return out;
}

/**
 * The stored overrides: {team?: [{name, home?, active?}], clients?: [{k, name?, what?, managers?, markets?, category?, past?}],
 * allow_dnc: boolean}. Missing or unreadable values are left out. Pass `kv` (from readKv) to skip the query.
 */
export async function readOverrides(db, kv) {
  const rows = kv || (await readKv(db, SETTING_KEYS));
  const out = { allow_dnc: !!rows.allow_dnc && String(rows.allow_dnc.v) === "1" };
  const team = rows.team ? parse(rows.team.v) : undefined;
  if (Array.isArray(team)) {
    const seen = new Set();
    out.team = team.map(cleanMember).filter((m) => m && !seen.has(m.name.toLowerCase()) && seen.add(m.name.toLowerCase()));
  }
  const clients = rows.clients ? parse(rows.clients.v) : undefined;
  if (Array.isArray(clients)) {
    const seen = new Set();
    out.clients = clients.map(cleanClient).filter((c) => c && !seen.has(c.k) && seen.add(c.k));
  }
  return out;
}

/** True when "Do not contact" may be stored (kv_meta allow_dnc = "1"). One query; false before 003. */
export async function allowDnc(db) {
  const rows = await readKv(db, ["allow_dnc"]);
  return !!rows.allow_dnc && String(rows.allow_dnc.v) === "1";
}

/**
 * The team list with the overrides applied: the stored list in its order, then any built-in name it
 * does not mention. Each entry is {name, home?, active?}.
 */
export function mergeTeam(base = TEAM, team) {
  if (!Array.isArray(team) || !team.length) return base.map((m) => ({ ...m }));
  const names = new Set(team.map((m) => m.name.toLowerCase()));
  return [...team.map((m) => ({ ...m })), ...base.filter((m) => !names.has(m.name.toLowerCase())).map((m) => ({ ...m }))];
}

/**
 * {clients, past_clients} with the overrides applied by k. Existing clients keep their k, slug, aliases
 * and products; name, what, managers, markets and category are replaced when given; past: true moves a client to
 * past_clients (and false back). A new k is added with slug = k with spaces as dashes.
 */
export function mergeClients(clients = CLIENTS, past = PAST_CLIENTS, overrides) {
  const cur = clients.map((c) => ({ ...c, past: false }));
  const old = past.map((c) => ({ ...c, past: true }));
  const all = [...cur, ...old];
  for (const o of overrides || []) {
    let c = all.find((x) => x.k === o.k);
    if (!c) {
      c = { k: o.k, slug: slugOf(o.k), name: o.name || o.k, aliases: [], past: false };
      all.push(c);
    }
    for (const f of ["name", "what", "managers", "markets", "category"]) if (o[f] !== undefined) c[f] = o[f];
    if (o.past !== undefined) c.past = o.past;
  }
  const strip = (c) => {
    const { past: _p, ...rest } = c;
    return rest;
  };
  return { clients: all.filter((c) => !c.past).map(strip), past_clients: all.filter((c) => c.past).map(strip) };
}

/** Applies readOverrides() output to a meta object (from lib/meta.js baseMeta()); returns the same object. */
export function applyOverrides(meta, overrides) {
  const o = overrides || {};
  meta.team = mergeTeam(meta.team, o.team);
  const merged = mergeClients(meta.clients, meta.past_clients, o.clients);
  meta.clients = merged.clients;
  meta.past_clients = merged.past_clients;
  return meta;
}

/**
 * Storage for PUT /api/settings (the endpoint validates first): upserts the given keys and the
 * settings_log row (by, at, keys). team and clients are stored as JSON lists, allow_dnc as "1" or "0".
 * Returns the number of keys written; throws when kv_meta does not exist yet.
 */
export async function saveSettings(db, patch, by, at = new Date().toISOString().replace(/\.\d+Z$/, "Z")) {
  if (!(await hasTable(db, "kv_meta"))) throw new Error("kv_meta is missing (run migration 003)");
  const upsert = "INSERT INTO kv_meta (k, v, at, by_whom) VALUES (?1, ?2, ?3, ?4) " +
    "ON CONFLICT(k) DO UPDATE SET v = excluded.v, at = excluded.at, by_whom = excluded.by_whom";
  const keys = SETTING_KEYS.filter((k) => patch && patch[k] !== undefined);
  if (!keys.length) return 0;
  const value = (k) => (k === "allow_dnc" ? (patch[k] === true || String(patch[k]) === "1" ? "1" : "0") : JSON.stringify(patch[k]));
  await db.batch([
    ...keys.map((k) => db.prepare(upsert).bind(k, value(k), at, by)),
    db.prepare(upsert).bind("settings_log", JSON.stringify({ by, at, keys }), at, by),
  ]);
  return keys.length;
}
