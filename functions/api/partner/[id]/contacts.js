// Adds a contact person to a partner. The email is checked against every contact first.
import { json, bad, body, who, text, validEmail, now, nextTempId } from "../../../../lib/crm.js";

export async function onRequestPost({ request, env, params }) {
  const db = env.PARTNERS_DB;
  if (!db) return bad("Not connected", 404);
  const id = String(params.id || "");
  const b = await body(request);
  const by = who(b);
  const p = await db.prepare("SELECT id FROM partners WHERE id = ?").bind(id).first();
  if (!p) return bad("Not found", 404);
  const email = b.email ? validEmail(b.email) : "";
  if (b.email && !email) return bad("That email address doesn't look right.");
  const first = text(b.first_name, 60), last = text(b.last_name, 60);
  if (!email && !first) return bad("Add at least a name or an email.");
  const linkedin = text(b.linkedin, 300);
  if (linkedin && !/^https?:\/\//i.test(linkedin)) return bad("The LinkedIn link must start with https://.");
  if (email) {
    const dupe = await db.prepare("SELECT c.id, c.account_id, p.owner, p.name, p.domain FROM contacts c LEFT JOIN partners p ON p.id = c.account_id WHERE lower(c.email) LIKE ? LIMIT 1")
      .bind("%" + email + "%").first();
    if (dupe && !b.force) return json({ error: "This email is already in the CRM", duplicate: dupe }, 409);
  }
  const { id: cid, stmts: idStmts } = await nextTempId(db, "contact");
  const c = { id: cid, account_id: id, first_name: first || null, last_name: last || null, title: text(b.title, 100) || null, linkedin: linkedin || null,
    email_status: email ? "Unverified" : null, source: "Added on site", primary_contact: 0, outreach_status: "Not contacted", last_email: null,
    replied: 0, client: text(b.client, 60) || null, email: email || null };
  const at = now();
  await db.batch([
    db.prepare(`INSERT INTO contacts (id, account_id, first_name, last_name, title, linkedin, email_status, source, primary_contact, outreach_status, last_email, replied, client, email)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(c.id, c.account_id, c.first_name, c.last_name, c.title, c.linkedin, c.email_status, c.source, c.primary_contact, c.outreach_status, c.last_email, c.replied, c.client, c.email),
    db.prepare("UPDATE partners SET contacts = COALESCE(contacts, 0) + 1, updated_at = ?, updated_by = ? WHERE id = ?").bind(at, by, id),
    db.prepare("INSERT INTO edits (at, by_whom, kind, account_id, contact_id, new) VALUES (?, ?, 'create_contact', ?, ?, ?)")
      .bind(at, by, id, cid, JSON.stringify({ first_name: first, last_name: last, title: c.title, email, linkedin, client: c.client })),
    ...idStmts,
  ]);
  return json({ ok: true, contact: c }, 201);
}
