// One partner's profile for the record panel: details, contacts (with emails; the login in
// functions/_middleware.js covers this route), activity and what the site says about itself.
const DOMAIN = /^[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/i;

export async function onRequestGet({ env, params, waitUntil }) {
  if (!env.PARTNERS_DB) return new Response("Partner list not connected", { status: 404 });
  const id = String(params.id || "");
  const db = env.PARTNERS_DB;
  const partner = await db.prepare("SELECT * FROM partners WHERE id = ?").bind(id).first();
  if (!partner) return new Response("Not found", { status: 404 });
  const [contacts, activity] = await Promise.all([
    db.prepare("SELECT * FROM contacts WHERE account_id = ? ORDER BY primary_contact DESC, replied DESC, last_email DESC").bind(id).all(),
    db.prepare("SELECT date, contact_id, type, by_whom, summary, client FROM activity WHERE account_id = ? ORDER BY date DESC, n DESC").bind(id).all(),
  ]);
  const about = DOMAIN.test(partner.domain || "") ? await siteAbout(partner.domain, waitUntil) : null;
  return Response.json(
    { partner, contacts: contacts.results, activity: activity.results, about },
    { headers: { "Cache-Control": "private, no-store" } }
  );
}

// The site's own title and description, cached for a week so each site is fetched rarely.
async function siteAbout(domain, waitUntil) {
  const cache = caches.default;
  const key = new Request("https://partnergap-crm.pages.dev/__about/" + domain.toLowerCase());
  const hit = await cache.match(key);
  if (hit) return hit.json();
  let about = { title: "", description: "" };
  try {
    const res = await fetch("https://" + domain, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; PartnerGapCRM/1.0)", Accept: "text/html" },
      redirect: "follow",
      signal: AbortSignal.timeout(4000),
    });
    if (res.ok && (res.headers.get("content-type") || "").includes("html")) {
      const html = (await res.text()).slice(0, 300000);
      about = {
        title: clean(pick(html, /<title[^>]*>([^<]*)<\/title>/i)),
        description: clean(
          meta(html, "description") || meta(html, "og:description") || meta(html, "twitter:description")
        ),
      };
    }
  } catch (e) {
    // Slow or blocked sites just show no description.
  }
  const save = cache.put(key, new Response(JSON.stringify(about), {
    headers: { "Content-Type": "application/json", "Cache-Control": "max-age=604800" },
  }));
  if (waitUntil) waitUntil(save); else await save;
  return about;
}

function meta(html, name) {
  const n = name.replace(".", "\\.");
  return pick(html, new RegExp(`<meta[^>]+(?:name|property)=["']${n}["'][^>]*content=["']([^"']*)["']`, "i"))
    || pick(html, new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*(?:name|property)=["']${n}["']`, "i"));
}

function pick(s, re) {
  const m = s.match(re);
  return m ? m[1] : "";
}

function clean(s) {
  return s
    .replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d))
    .replace(/\s+/g, " ").trim().slice(0, 400);
}
