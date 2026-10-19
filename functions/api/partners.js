// Partner list for every record page, and "Add site" from the website.
// Reads from the D1 database bound as PARTNERS_DB; until that binding exists the pages show a notice.
//   GET /api/partners              v1: positional rows, byte-identical to d5e91d9 (legacy.html, the old digest builder)
//   GET /api/partners?v=2          {"v":2,"cols":[...],"rows":[[...],...]}; a weak ETag and 304 (bodies up to 1 MB on Free)
//   GET /api/partners?v=2&ids=a,b  the same shape for up to 90 ids; no ETag, never 304
//   POST /api/partners             Add site: request, checks and the create_account edits row unchanged;
//                                  the response adds "v2" (the new row in cols order)
import { json, bad, body, who, text, cleanDomain, fieldValue, findDomain, now, today, V2_COLS, v2Sql, v2Row } from "../../lib/crm.js";
import { hasTable } from "../../lib/tables.js";

// CPU check (spec 6.3.2, Workers Free: 10 ms CPU per request). On a production-size list (7,500 synthetic
// rows, 1.8 MB) JSON.stringify took 5.9-8.5 ms and SHA-256 2.4-2.6 ms (medians, Node 22), so 8.4-11.2 ms in
// all: over the 7 ms budget. (v1's map + stringify of the same rows: 5.5 ms.) So on Free the hash and the 304
// path are skipped once the body is larger than ETAG_MAX_BYTES (1 MB, about 4,100 rows: 3.1 + 1.4 ms): a
// production-size list always answers 200, and the page still renders from its cache first.
// With WORKERS_PLAN=paid (J6) the ETag is computed at any size.
const ETAG_MAX_BYTES = 1000000;
const MAX_IDS = 90;

export async function onRequestGet({ request, env }) {
  if (!env.PARTNERS_DB) return new Response("Partner list not connected", { status: 404 });
  const url = new URL(request.url);
  if (url.searchParams.get("v") === "2") return listV2(request, url, env.PARTNERS_DB, String(env.WORKERS_PLAN || "").toLowerCase() === "paid");
  const { results } = await env.PARTNERS_DB.prepare("SELECT * FROM partners ORDER BY id").all();
  return json(results.map(row));
}

async function listV2(request, url, db, paid) {
  const generatedAt = now();
  const headers = { "Content-Type": "application/json", "Cache-Control": "private, no-store", "X-Generated-At": generatedAt };
  const sugg = await hasTable(db, "suggestions");
  if (url.searchParams.has("ids")) {
    const ids = [...new Set(String(url.searchParams.get("ids") || "").split(",").map((s) => s.trim()).filter(Boolean))];
    if (ids.length > MAX_IDS) return bad("Ask for at most " + MAX_IDS + " sites at a time.");
    const rows = ids.length ? await db.prepare(v2Sql({ mode: "ids", n: ids.length, sugg })).bind(...ids).raw() : [];
    return new Response(JSON.stringify({ v: 2, cols: V2_COLS, rows }), { headers });
  }
  const rows = await db.prepare(v2Sql({ mode: "list", sugg })).raw();
  const inner = JSON.stringify({ cols: V2_COLS, rows });
  if (paid || inner.length <= ETAG_MAX_BYTES) {
    const etag = 'W/"' + (await sha16(inner)) + '"';
    headers.ETag = etag;
    if (etagMatches(request.headers.get("If-None-Match"), etag)) return new Response(null, { status: 304, headers });
  }
  return new Response('{"v":2,' + inner.slice(1), { headers });
}

// First 16 hex characters of SHA-256.
async function sha16(s) {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
  let h = "";
  for (let i = 0; i < 8; i++) h += d[i].toString(16).padStart(2, "0");
  return h;
}

// If-None-Match may list several tags and may drop or add the W/ prefix (weak comparison).
function etagMatches(header, etag) {
  if (!header) return false;
  const bare = (t) => t.trim().replace(/^W\//i, "");
  return header.split(",").some((t) => t.trim() === "*" || bare(t) === bare(etag));
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
  return json({ ok: true, row: row(created), v2: await v2Row(db, created) }, 201);
}
