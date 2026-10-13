// Partner list for every record page, and "Add site" from the website.
// Reads from the D1 database bound as PARTNERS_DB; until that binding exists the pages show a notice.
import { json, bad, body, who, text, cleanDomain, fieldValue, findDomain, now, today } from "../../lib/crm.js";

export async function onRequestGet({ env }) {
  if (!env.PARTNERS_DB) return new Response("Partner list not connected", { status: 404 });
  const { results } = await env.PARTNERS_DB.prepare("SELECT * FROM partners ORDER BY id").all();
  return json(results.map(row));
}

/* row: [id, domain, name, type, DR, traffic, owner, stage, lastTouch, clients, country, contacts, nextStep, nextDue,
         dealModel, dealFlat, dealPct, dealValue, liveDate, contentUrl] */
export function row(r) {
  return [r.id, r.domain || "", r.name || "", r.type || "", r.dr, r.traffic, r.owner || "", r.stage || "", r.last_touch || "",
    r.clients || "", r.country || "", r.contacts || 0, r.next_step || "", r.next_due || "",
    r.deal_model || "", r.deal_flat ?? null, r.deal_pct ?? null, r.deal_value ?? null, r.live_date || "", r.content_url || ""];
}

// New sites get a temporary NEW-n id; the daily run gives them the next PG id in the sheet.
export async function onRequestPost({ request, env }) {
  const db = env.PARTNERS_DB;
  if (!db) return bad("Partner list not connected", 404);
  const b = await body(request);
  const by = who(b);
  const domain = b.domain ? cleanDomain(b.domain) : "";
  const name = text(b.name, 120);
  if (b.domain && !domain) return bad("That doesn't look like a website address.");
  if (!domain && !name) return bad("Add a website or a name.");
  if (domain && !b.force) {
    const dupes = await findDomain(db, domain);
    if (dupes.length) return json({ error: "Already in the CRM", duplicates: dupes }, 409);
  }
  let vals;
  try {
    vals = {
      stage: fieldValue("stage", b.stage || "New"),
      owner: fieldValue("owner", b.owner || by),
      clients: fieldValue("clients", b.clients || ""),
      type: fieldValue("type", b.type || ""),
      next_step: fieldValue("next_step", b.next_step || ""),
      next_due: fieldValue("next_due", b.next_due || ""),
    };
  } catch (msg) {
    return bad(String(msg));
  }
  const last = await db.prepare("SELECT COALESCE(MAX(CAST(SUBSTR(id, 5) AS INTEGER)), 0) AS n FROM partners WHERE id LIKE 'NEW-%'").first();
  const id = "NEW-" + String((last ? last.n : 0) + 1).padStart(4, "0");
  const at = now();
  await db.batch([
    db.prepare(`INSERT INTO partners (id, domain, name, type, owner, stage, clients, contacts, next_step, next_due, source, notes, updated_at, updated_by)
                VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, 'Added on site', ?, ?, ?)`)
      .bind(id, domain || null, name || domain, vals.type, vals.owner, vals.stage, vals.clients, vals.next_step, vals.next_due,
        text(b.notes, 2000) || null, at, by),
    db.prepare("INSERT INTO edits (at, by_whom, kind, account_id, new) VALUES (?, ?, 'create_account', ?, ?)")
      .bind(at, by, id, JSON.stringify({ domain, name: name || domain, ...vals, notes: text(b.notes, 2000), added: today() })),
  ]);
  const created = await db.prepare("SELECT * FROM partners WHERE id = ?").bind(id).first();
  return json({ ok: true, row: row(created) }, 201);
}
