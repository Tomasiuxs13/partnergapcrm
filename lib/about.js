// What a site says about itself: its <title> and meta description (spec 6.3.9). Moved here unchanged from
// functions/api/partner/[id].js: a 4 s timeout, at most 300 KB of HTML read, and a 7-day cache
// (caches.default), so each site is fetched rarely. A slow or blocked site gives empty strings.
//   siteAbout(domain, waitUntil)  fetches on a cache miss (GET /api/partner/:id/about, GET /api/about)
//   cachedAbout(domain)           the cache only, never a fetch (GET /api/partner/:id)
// No side effects at import time.

const DOMAIN = /^[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/i;

/** True for a plain host name that can be fetched (no path, no channel URL). */
export function aboutable(domain) {
  return DOMAIN.test(String(domain || ""));
}

function cacheKey(domain) {
  return new Request("https://partnergap-crm.pages.dev/__about/" + String(domain).toLowerCase());
}

/** {title, description} from the cache, or null on a miss (or without Cache API). */
export async function cachedAbout(domain) {
  if (!aboutable(domain) || typeof caches === "undefined") return null;
  try {
    const hit = await caches.default.match(cacheKey(domain));
    return hit ? await hit.json() : null;
  } catch (e) {
    return null;
  }
}

// The site's own title and description, cached for a week so each site is fetched rarely.
export async function siteAbout(domain, waitUntil) {
  const cache = caches.default;
  const key = cacheKey(domain);
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
