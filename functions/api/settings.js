// GET/PUT /api/settings (spec 6.3.11, D3, D11): the team and client lists and the "Allow 'Do not contact'"
// switch, stored in D1 kv_meta (lib/settings.js). D1-only: no edits row, nothing reaches the Google Sheet.
// /api/meta merges the overrides on every call, and the sign-in form reads the team list.
//   GET  {team, clients, allow_dnc}: the stored overrides only (team/clients null when never saved).
//   PUT  {by, team?, clients?, allow_dnc?} -> {ok, saved (how many settings), team, clients, allow_dnc}
//        - only a name in meta.admins (Jonas, Vik; any case) may save: self-declared, low stakes; each save
//          also writes kv_meta settings_log (by, at, keys)
//        - team: [{name (2-40 letters, spaces, ' and -), home?: 'today'|'team', active?: true|false}], the
//          whole list in order; inactive names leave the menus but stay known as past owners. At least one
//          active name.
//        - clients: [{k?, name, what?, managers?, markets?, past?}]: a new client's k is its name in lower
//          case; an existing client keeps its k (it can't be renamed, only its shown name changes).
//        - allow_dnc: true|false
//        400 {"error": "<sentence>"} on a bad value, 403 for someone else; nothing is saved on error. A D1
//        failure is thrown (a 500), never a 400 with the D1 text.
// Before migration 003 (no kv_meta): 404 {"error":"Not available yet","unavailable":true}.
import { json, bad, body, who } from "../../lib/crm.js";
import { hasTable } from "../../lib/tables.js";
import { ADMINS, CLIENTS, PAST_CLIENTS } from "../../lib/meta.js";
import { readOverrides, saveSettings, readKv } from "../../lib/settings.js";

const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);
const str = (v, max) => (v == null ? "" : String(v).replace(/[\u0000-\u001f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max));
const unavailable = () => json({ error: "Not available yet", unavailable: true }, 404);

function personName(v) {
  const s = str(v, 41);
  return s.length >= 2 && s.length <= 40 && /^[\p{L}\p{M}' ’-]+$/u.test(s) && (s.match(/\p{L}/gu) || []).length >= 2 ? s : "";
}

function cleanTeam(list) {
  if (!Array.isArray(list)) throw "The team must be a list of names.";
  const seen = new Set();
  const out = list.map((m) => {
    const name = personName(isObj(m) ? m.name : m);
    if (!name) throw "Each team name needs 2–40 letters (spaces, ' and - are fine).";
    if (seen.has(name.toLowerCase())) throw name + " is on the list twice.";
    seen.add(name.toLowerCase());
    const e = { name };
    if (isObj(m) && m.home != null && m.home !== "") {
      if (m.home !== "today" && m.home !== "team") throw "The landing page is Today or Team overview.";
      e.home = m.home;
    }
    e.active = !(isObj(m) && m.active === false);
    return e;
  });
  if (!out.some((m) => m.active)) throw "Keep at least one person on the team.";
  return out;
}

function cleanClients(list, stored) {
  if (!Array.isArray(list)) throw "The clients must be a list.";
  const known = new Set([...CLIENTS, ...PAST_CLIENTS, ...(stored || [])].map((c) => String(c.k).toLowerCase()));
  const seen = new Set();
  return list.map((c) => {
    if (!isObj(c)) throw "Each client needs a name.";
    const name = str(c.name, 61);
    if (name.length < 2 || name.length > 60) throw "Each client name needs 2–60 characters.";
    if (/[,/;]/.test(name)) throw "A client name can't contain , / or ;.";
    let k = str(c.k, 60).toLowerCase();
    if (k && !known.has(k) && k !== name.toLowerCase()) throw "A client's key can't be changed (" + k + ").";
    if (!k) k = name.toLowerCase();
    if (seen.has(k)) throw name + " is on the list twice.";
    seen.add(k);
    const out = { k, name };
    if (c.what != null) out.what = str(c.what, 200);
    if (c.managers != null) {
      if (!Array.isArray(c.managers)) throw "Managers must be a list of names.";
      out.managers = c.managers.map((m) => personName(m)).filter(Boolean).slice(0, 10);
    }
    if (c.markets != null) out.markets = str(c.markets, 100);
    if (c.past != null) out.past = c.past === true;
    return out;
  });
}

function view(o) {
  return { team: o.team || null, clients: o.clients || null, allow_dnc: !!o.allow_dnc };
}

export async function onRequestGet({ env }) {
  const db = env.PARTNERS_DB;
  if (!db || !(await hasTable(db, "kv_meta"))) return unavailable();
  return json(view(await readOverrides(db)));
}

export async function onRequestPut({ request, env }) {
  const db = env.PARTNERS_DB;
  if (!db || !(await hasTable(db, "kv_meta"))) return unavailable();
  const b = await body(request);
  const by = ADMINS.find((a) => a.toLowerCase() === who(b).toLowerCase());
  if (!by) return bad("Only " + ADMINS.join(" or ") + " can change settings.", 403);
  const patch = {};
  try {
    if (b.team !== undefined) patch.team = cleanTeam(b.team);
    if (b.clients !== undefined) {
      const kv = await readKv(db, ["clients"]);
      let stored = [];
      try {
        stored = kv.clients ? JSON.parse(kv.clients.v) : [];
      } catch (e) {
        stored = [];
      }
      patch.clients = cleanClients(b.clients, Array.isArray(stored) ? stored : []);
    }
    if (b.allow_dnc !== undefined) {
      if (typeof b.allow_dnc !== "boolean") throw "allow_dnc is true or false.";
      patch.allow_dnc = b.allow_dnc;
    }
  } catch (msg) {
    if (msg instanceof Error) throw msg; // a D1 failure: a 500, not a 400 with the raw D1 text (spec 4.11)
    return bad(String(msg));
  }
  if (!Object.keys(patch).length) return bad("Nothing to save.");
  const saved = await saveSettings(db, patch, by);
  return json({ ok: true, saved, ...view(await readOverrides(db)) });
}
