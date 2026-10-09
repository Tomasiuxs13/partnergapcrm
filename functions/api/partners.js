// Partner list for every record page (Prospecting, Partners, Deals, Campaigns, Clients).
// Reads from the D1 database bound as PARTNERS_DB; until that binding exists the pages show a notice.

export async function onRequestGet({ env }) {
  if (!env.PARTNERS_DB) return new Response("Partner list not connected", { status: 404 });
  const { results } = await env.PARTNERS_DB.prepare(
    "SELECT id, domain, name, type, dr, traffic, owner, stage, last_touch, clients, country, contacts, next_step, next_due FROM partners ORDER BY id"
  ).all();
  const rows = results.map((r) => [r.id, r.domain || "", r.name || "", r.type || "", r.dr, r.traffic, r.owner || "", r.stage || "", r.last_touch || "", r.clients || "", r.country || "", r.contacts || 0, r.next_step || "", r.next_due || ""]);
  return Response.json(rows, { headers: { "Cache-Control": "private, no-store" } });
}
