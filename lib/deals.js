// Deals (several per site, one per client) and files (links to contracts, price lists, briefs) for the
// record page. Tables come from migration 006; before it every function here reports "not available".
// Like every site write, each change is also logged in `edits` so the daily run copies it into the sheet's
// Deals and Files tabs. These three kinds are new and additive; the frozen kinds and their rows are
// unchanged (crm/docs/edits-contract.md section 5):
//   create_deal  account_id = site, field = the new deal id, new = JSON (DEAL_JSON_KEYS order)
//   deal_update  account_id = site, field = "<deal id>.<column>", old, new (text, NULL when cleared)
//   create_file  account_id = site, field = the new files.n as text, new = JSON {label, kind, url, deal_id, added}
// A deal's stage also moves the site's stage (siteStageFor), and its client joins the site's clients,
// written as ordinary `update` rows.
import { fieldValue, text, now, today, nextTempId, updateStatements, readPartner } from "./crm.js";
import { DNC_STAGE } from "./meta.js";
import { hasTables } from "./tables.js";

export const DEAL_STAGES = ["Negotiating", "Active", "Lost"];
export const DEAL_EDITABLE = ["client", "stage", "owner", "deal_model", "deal_flat", "deal_pct", "deal_value", "content_url", "live_date",
  "tracking_id", "next_step", "next_due", "notes"];
const DEAL_JSON_KEYS = ["client", "stage", "owner", "deal_model", "deal_flat", "deal_pct", "deal_value", "next_step", "next_due", "notes", "added"];
export const FILE_KINDS = ["Contract", "Price list", "Brief", "Invoice", "Other"];

/** {deals, files}: whether each table exists (migration 006). */
export async function dealTables(db) {
  return hasTables(db, ["deals", "files"]);
}

/** One deal field from the site to its stored value, or throws the user's sentence. */
export function dealFieldValue(field, v) {
  const s = text(v, 2000);
  switch (field) {
    case "client":
      if (/[,/]/.test(s)) throw "A deal is for one client.";
      return text(s, 60) || null;
    case "stage":
      if (!DEAL_STAGES.includes(s)) throw "Pick a deal stage from the list.";
      return s;
    case "notes":
      return text(s, 2000) || null;
    default:
      if (!DEAL_EDITABLE.includes(field)) throw "That field can't be edited here.";
      return fieldValue(field, v);
  }
}

const ORDER = { Lost: 0, Negotiating: 1, Active: 2 };

/**
 * The site stage that follows from its deals' stages: Active when any deal is Active, else Negotiating
 * when any is, else Lost when every deal is Lost. null = leave the site alone (no deals, the site is
 * "Do not contact", or it already has that stage).
 */
export function siteStageFor(siteStage, dealStages) {
  const list = (dealStages || []).filter((s) => s in ORDER);
  if (!list.length || siteStage === DNC_STAGE) return null;
  const best = list.reduce((a, b) => (ORDER[b] > ORDER[a] ? b : a));
  return best === siteStage ? null : best;
}

/** A site's deals, oldest first. */
export async function readDeals(db, accountId) {
  const { results } = await db.prepare("SELECT * FROM deals WHERE account_id = ? ORDER BY created, id").bind(accountId).all();
  return results || [];
}

/** A site's files, newest first. */
export async function readFiles(db, accountId) {
  const { results } = await db.prepare("SELECT * FROM files WHERE account_id = ? ORDER BY n DESC").bind(accountId).all();
  return results || [];
}

/** The site's clients with `client` added at the end, or null when it is already there. */
export function clientsWith(clients, client) {
  if (!client) return null;
  const list = String(clients || "").split(/\s*,\s*/).filter(Boolean);
  if (list.some((c) => c.toLowerCase() === client.toLowerCase())) return null;
  return list.concat(client).join(", ");
}

// The site follows its deals: stage (siteStageFor) and clients (a deal's client joins the site's
// clients). Ordinary `update` rows, one UPDATE.
function siteSync(db, partner, { stages, client }, by, at) {
  const fields = {};
  const stage = stages ? siteStageFor(partner.stage, stages) : null;
  if (stage) fields.stage = stage;
  const clients = clientsWith(partner.clients, client);
  if (clients) fields.clients = clients;
  return Object.keys(fields).length ? updateStatements(db, partner, fields, by, at).statements : [];
}

/**
 * Adds a deal to a site. input: the DEAL_EDITABLE fields (stage defaults to Negotiating, owner to the
 * site's owner). Returns {deal, partner} after the write, or null when the site is unknown. Throws the
 * user's sentence for a bad value, before anything is written.
 */
export async function createDeal(db, accountId, input, by) {
  const partner = await readPartner(db, accountId);
  if (!partner) return null;
  const f = input && typeof input === "object" ? input : {};
  const deal = {};
  for (const k of DEAL_EDITABLE) deal[k] = f[k] === undefined ? null : dealFieldValue(k, f[k]);
  if (!deal.stage) deal.stage = "Negotiating";
  if (!deal.owner) deal.owner = partner.owner || null;
  if (!deal.client) throw "Pick the client this deal is for.";
  const at = now();
  const added = today();
  const { id, stmts } = await nextTempId(db, "deal");
  const existing = await readDeals(db, accountId);
  const json = {};
  for (const k of DEAL_JSON_KEYS) json[k] = k === "added" ? added : deal[k];
  const cols = ["id", "account_id", ...DEAL_EDITABLE, "created", "updated_at", "updated_by"];
  const vals = [id, accountId, ...DEAL_EDITABLE.map((k) => deal[k]), added, at, by];
  await db.batch([
    db.prepare(`INSERT INTO deals (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`).bind(...vals),
    db.prepare("INSERT INTO edits (at, by_whom, kind, account_id, field, new) VALUES (?, ?, 'create_deal', ?, ?, ?)")
      .bind(at, by, accountId, id, JSON.stringify(json)),
    ...stmts,
    ...siteSync(db, partner, { stages: existing.map((d) => d.stage).concat(deal.stage), client: deal.client }, by, at),
  ]);
  return {
    deal: await db.prepare("SELECT * FROM deals WHERE id = ?").bind(id).first(),
    partner: await readPartner(db, accountId),
  };
}

/**
 * Changes a deal. fields: any of DEAL_EDITABLE; unchanged fields write nothing. Returns {deal, partner,
 * changed}, or null when the deal is unknown. Throws the user's sentence for a bad value.
 */
export async function updateDeal(db, dealId, fields, by) {
  const deal = await db.prepare("SELECT * FROM deals WHERE id = ?").bind(dealId).first();
  if (!deal) return null;
  const changes = {};
  for (const k of Object.keys(fields || {})) {
    if (!DEAL_EDITABLE.includes(k)) continue;
    const v = dealFieldValue(k, fields[k]);
    if (k === "client" && !v) throw "Pick the client this deal is for.";
    const old = deal[k] == null ? null : deal[k];
    if (String(old ?? "") !== String(v ?? "")) changes[k] = { old, v };
  }
  const keys = Object.keys(changes);
  const changed = {};
  keys.forEach((k) => (changed[k] = changes[k].v));
  const partner = await readPartner(db, deal.account_id);
  if (!keys.length) return { deal, partner, changed };
  const at = now();
  const stmts = [
    db.prepare(`UPDATE deals SET ${keys.map((k) => k + " = ?").join(", ")}, updated_at = ?, updated_by = ? WHERE id = ?`)
      .bind(...keys.map((k) => changes[k].v), at, by, dealId),
    ...keys.map((k) =>
      db.prepare("INSERT INTO edits (at, by_whom, kind, account_id, field, old, new) VALUES (?, ?, 'deal_update', ?, ?, ?, ?)")
        .bind(at, by, deal.account_id, dealId + "." + k, changes[k].old == null ? null : String(changes[k].old), changes[k].v == null ? null : String(changes[k].v))
    ),
  ];
  if ((changes.stage || changes.client) && partner) {
    const stages = changes.stage ? (await readDeals(db, deal.account_id)).map((d) => (d.id === dealId ? changes.stage.v : d.stage)) : null;
    stmts.push(...siteSync(db, partner, { stages, client: changes.client ? changes.client.v : null }, by, at));
  }
  await db.batch(stmts);
  return {
    deal: await db.prepare("SELECT * FROM deals WHERE id = ?").bind(dealId).first(),
    partner: partner ? await readPartner(db, deal.account_id) : null,
    changed,
  };
}

/** A file link from the site, checked: {label, kind, url, deal_id}, or throws the user's sentence. */
export function fileInput(b) {
  const f = b && typeof b === "object" ? b : {};
  const label = text(f.label, 120);
  const url = text(f.url, 1000);
  const kind = text(f.kind, 40) || "Other";
  if (!url) throw "Paste the link to the file.";
  if (!/^https:\/\/[^\s]+$/i.test(url)) throw "The link must start with https://.";
  if (!FILE_KINDS.includes(kind)) throw "Pick a file type from the list.";
  return { label: label || kind, kind, url, deal_id: text(f.deal_id, 20) || null };
}

/** Adds a file link to a site (and optionally one of its deals). Returns the file, or null for an unknown site. */
export async function createFile(db, accountId, input, by) {
  const partner = await db.prepare("SELECT id FROM partners WHERE id = ?").bind(accountId).first();
  if (!partner) return null;
  const f = fileInput(input);
  if (f.deal_id) {
    const d = await db.prepare("SELECT id FROM deals WHERE id = ? AND account_id = ?").bind(f.deal_id, accountId).first();
    if (!d) throw "That deal isn't on this site.";
  }
  const at = now();
  const added = today();
  const res = await db.batch([
    db.prepare("INSERT INTO files (account_id, deal_id, label, kind, url, added_at, added_by) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .bind(accountId, f.deal_id, f.label, f.kind, f.url, at, by),
    db.prepare("INSERT INTO edits (at, by_whom, kind, account_id, field, new) VALUES (?, ?, 'create_file', ?, CAST(last_insert_rowid() AS TEXT), ?)")
      .bind(at, by, accountId, JSON.stringify({ label: f.label, kind: f.kind, url: f.url, deal_id: f.deal_id, added })),
  ]);
  const n = res[0] && res[0].meta ? res[0].meta.last_row_id : null;
  return (await db.prepare("SELECT * FROM files WHERE n = ?").bind(n).first()) || { n, account_id: accountId, ...f, added_at: at, added_by: by };
}
