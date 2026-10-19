// GET /api/about?domain= (spec 6.3.9, P1): {domain, title, description} for a site that isn't in the CRM
// yet, so Add site can suggest a name. The input goes through lib/crm.js#cleanDomain (a pasted URL,
// www. and a path are fine); only a plain host is fetched, so a channel URL such as youtube.com/@name
// answers 400. lib/about.js#siteAbout: the 7-day cache, else one fetch (4 s timeout, 300 KB).
import { json, bad, cleanDomain } from "../../lib/crm.js";
import { siteAbout, aboutable } from "../../lib/about.js";

export async function onRequestGet({ request, waitUntil }) {
  const raw = new URL(request.url).searchParams.get("domain") || "";
  const domain = cleanDomain(raw);
  if (!domain || !aboutable(domain)) return bad("That doesn't look like a website address.");
  const about = await siteAbout(domain, waitUntil);
  return json({ domain, title: (about && about.title) || "", description: (about && about.description) || "" });
}
