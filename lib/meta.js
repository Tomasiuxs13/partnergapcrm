// Site constants in one place (spec 1.2 principle 9, 6.3.1). GET /api/meta serves them merged with the
// kv_meta overrides (lib/settings.js), and lib/crm.js validates writes against the same lists.
// Pure data and pure functions: no side effects at import time, no D1 access here.

// Stored stage values the site always accepts. "Do not contact" (DNC_STAGE) is accepted only while the
// kv_meta setting allow_dnc = "1" (spec D3); lib/crm.js#fieldValue takes that flag.
export const STAGES = ["New", "Researching", "Contacted", "Replied", "Negotiating", "Active", "Lost"];
export const DNC_STAGE = "Do not contact";
export const DEAL_MODELS = ["Commission (CPA)", "Revenue share", "Flat fee", "Flat fee + commission", "Free placement", "Gifted product"];
export const ACTIVITY_TYPES = ["Email", "Call", "Meeting", "Note", "Deal update", "Content live"];

// The release sets this together with window.BUILD in crm/dashboard/index.html, in one commit (spec 5.1;
// tests/unit/build.test.mjs fails when they differ). On an open page, a difference between its
// window.BUILD and /api/meta build shows "A new version is ready".
export const BUILD = "records-1";
export const PROD_HOST = "partnergap-crm.pages.dev";

// Stage details for the page. Researching stays valid but is left out of the stage path (spec D1);
// Lost and Do not contact are closed.
export const STAGE_INFO = [
  { name: "New", desc: "Found, not contacted yet", color: "new", order: 1, not_contacted: true, closed: false, in_path: true },
  { name: "Researching", desc: "Finding the right contact", color: "research", order: 2, not_contacted: true, closed: false, in_path: false },
  { name: "Contacted", desc: "Emailed, waiting for an answer", color: "contacted", order: 3, not_contacted: false, closed: false, in_path: true },
  { name: "Replied", desc: "Wrote back; the owner answers next", color: "replied", order: 4, not_contacted: false, closed: false, in_path: true },
  { name: "Negotiating", desc: "Talking terms", color: "neg", order: 5, not_contacted: false, closed: false, in_path: true },
  { name: "Active", desc: "Agreed to work with us", color: "active", order: 6, not_contacted: false, closed: false, in_path: true },
  { name: "Lost", desc: "Said no or went quiet", color: "lost", order: 7, not_contacted: false, closed: true, in_path: false },
  { name: DNC_STAGE, desc: "Never email this site again", color: "dnc", order: 8, not_contacted: false, closed: true, in_path: false, flag: "dnc" },
];

export const AFFILIATE_TYPES = ["Media / Publisher", "Coupon / Deals", "Review", "Influencer / Social", "Affiliate Network",
  "Loyalty / Rewards", "Marketplace Partner", "Web Hosting", "Email Marketing", "WP / Web Platform", "Tech / SaaS", "Agency", "Other"];

// Owners shown in menus. Vik lands on Team overview (spec D6). Settings can change this list (kv_meta team).
export const TEAM = [
  { name: "Jonas" }, { name: "Vik", home: "team" }, { name: "Kamile" }, { name: "Eivyda" }, { name: "Monica" },
  { name: "Mantvydas" }, { name: "Gaby" }, { name: "Sandra" }, { name: "Tomas" }, { name: "Denisse" }, { name: "Egle" },
];
export const ADMINS = ["Jonas", "Vik"];

// A client's category (Tomas, 2026-10-23): a client page suggests sites that already work with another
// client in the same category. Settings can change a client's category or type a new one.
export const CLIENT_CATEGORIES = ["Software & SaaS", "Finance & money", "Health & wellness", "Home & office", "Books & learning",
  "Freelancing & business", "Travel", "Fashion & beauty", "Gaming", "Other"];

// k = the stored key (lower case with spaces, as the old clientKey()), used by client_programs and
// PUT /api/clients/:k. slug is for URLs only. Stored client tokens are never rewritten (spec D8):
// aliases only map a raw token to its client.
export const CLIENTS = [
  { k: "soro", slug: "soro", name: "Soro", what: "AI SEO content platform", category: "Software & SaaS", managers: ["Jonas", "Vik"], markets: "US", aliases: [] },
  { k: "transfergo", slug: "transfergo", name: "TransferGO", what: "Money transfer app", category: "Finance & money", managers: ["Jonas", "Vik"], markets: "GB · UA · PL · DE", aliases: [] },
  { k: "ultahost", slug: "ultahost", name: "UltaHost", what: "Web hosting", category: "Software & SaaS", managers: ["Kamile"], markets: "US", aliases: ["ultahost"] },
  { k: "mailerlite", slug: "mailerlite", name: "MailerLite", what: "Email marketing", category: "Software & SaaS", managers: ["Kamile"], markets: "US", aliases: [] },
  { k: "mailersend", slug: "mailersend", name: "MailerSend", what: "Transactional email", category: "Software & SaaS", managers: ["Kamile"], markets: "US", aliases: [] },
  { k: "headway", slug: "headway", name: "Headway", what: "Book summaries app", category: "Books & learning", managers: ["Kamile"], markets: "US · IN · GB", aliases: [] },
  { k: "guardblinds", slug: "guardblinds", name: "GuardBlinds", what: "Blackout blinds", category: "Home & office", managers: ["Kamile"], markets: "US", aliases: [] },
  { k: "fiverr", slug: "fiverr", name: "Fiverr", what: "Freelance marketplace", category: "Freelancing & business", managers: ["Mantvydas"], markets: "IN · US", aliases: [] },
  { k: "raibu", slug: "raibu", name: "Raibu", what: "Supplements", category: "Health & wellness", managers: ["Monica"], markets: "IT · ES · US", aliases: [] },
  { k: "desktronic", slug: "desktronic", name: "Desktronic", what: "Standing desks", category: "Home & office", managers: ["Eivyda"], markets: "DE · EU · US", aliases: [] },
  { k: "botanical synthesis", slug: "botanical-synthesis", name: "Botanical Synthesis", what: "Topical pain relief", category: "Health & wellness", managers: ["Eivyda"], markets: "US", aliases: [] },
  { k: "melograno", slug: "melograno", name: "Melograno", what: "Trafft, Amelia, wpDataTables, IvyForms", category: "Software & SaaS", managers: ["Eivyda"], markets: "US",
    aliases: [], products: ["Trafft", "Amelia", "wpDataTables", "IvyForms"], token: "Melograno - {product}" },
];
export const PAST_CLIENTS = [{ k: "weglot", slug: "weglot", name: "Weglot", category: "Software & SaaS" },
  { k: "termly", slug: "termly", name: "Termly", category: "Software & SaaS" }];

// Days without activity before a site counts as quiet, per stage (Appendix B).
export const SLA = { Contacted: 14, Replied: 3, Negotiating: 7, ActiveNotLive: 14 };
// The default follow-up per stage (Appendix A "stage default").
export const FOLLOW_UP_DAYS = { New: 2, Researching: 2, Contacted: 7, Replied: 2, Negotiating: 3, Active: 14 };
// Replies to answer: 30 days when the date comes from a contact's last_email, 7 from last_touch (spec D10).
export const REPLY_WINDOW = { email: 30, touch: 7 };
export const NOREPLY_CAP = 10;
export const LOST_REASONS = ["No budget", "Only paid placements", "Price too high", "Not a fit", "No reply after follow-ups",
  "Already works with a competitor", "Other"];

// Big platforms are hidden from prospect lists by default (spec D7).
export const PLATFORM_DOMAINS = ["google.com", "drive.google.com", "docs.google.com", "wordpress.org", "wordpress.com", "pinterest.com",
  "adobe.com", "shopify.com", "bit.ly", "wix.com", "forbes.com", "medium.com", "trustpilot.com", "nytimes.com", "cnn.com",
  "healthline.com", "webmd.com", "amazon.com", "apple.com", "microsoft.com", "github.com", "youtube.com", "facebook.com",
  "instagram.com", "linkedin.com", "x.com", "twitter.com", "reddit.com", "wikipedia.org", "blogspot.com"];
export const PLATFORM_DR = 90;

// Vilnius time, as the scheduled routines run.
export const SCHEDULE = [
  { name: "Find new sites", when: "Mondays 07:52" },
  { name: "Morning copy (daily run)", when: "Mon–Fri 08:47" },
  { name: "Weekly digest", when: "Fridays 15:51" },
];
export const TIMEZONE = "Europe/Vilnius";
export const SHEET_URL = "https://docs.google.com/spreadsheets/d/1llDAVFowJ1tHVXCTRc2Upos1FXndl2Iit3mfAOhp05I/edit";
// Nothing sends email or Slack from the site (spec 1.3).
export const TEST_MODE = true;

// Workers Free allows 50 queries per invocation, Paid 1,000 (spec 6.6). The bulk rows chunk follows the
// plan. The plan comes from the WORKERS_PLAN env var ("paid"); without it the site assumes Free (J6).
export function limitsFor(plan) {
  const paid = String(plan || "").toLowerCase() === "paid";
  return { plan: paid ? "paid" : "free", bulk_ids: 90, bulk_rows: paid ? 200 : 20 };
}

// Read-only hosts (spec 6.3.14, 4.14 b): every host except the production host and local hosts, and
// any host when READ_ONLY=1. The middleware stores its answer on ctx.data.readOnly; this is the same rule.
export function isReadOnlyHost(env, host) {
  const e = env || {};
  if (String(e.READ_ONLY || "") === "1") return true;
  const h = String(host || "").toLowerCase().replace(/:\d+$/, "");
  const prod = String(e.PROD_HOST || PROD_HOST).toLowerCase();
  return !(h === prod || h === "localhost" || h === "127.0.0.1");
}

const clone = (v) => JSON.parse(JSON.stringify(v));

/** A fresh copy of the constants in the /api/meta shape, before overrides, features and freshness. */
export function baseMeta() {
  return {
    v: 2,
    build: BUILD,
    read_only: false,
    stages: clone(STAGE_INFO),
    deal_models: DEAL_MODELS.slice(),
    activity_types: ACTIVITY_TYPES.slice(),
    affiliate_types: AFFILIATE_TYPES.slice(),
    client_categories: CLIENT_CATEGORIES.slice(),
    team: clone(TEAM),
    admins: ADMINS.slice(),
    clients: clone(CLIENTS),
    past_clients: clone(PAST_CLIENTS),
    sla: { ...SLA },
    follow_up_days: { ...FOLLOW_UP_DAYS },
    reply_window: { ...REPLY_WINDOW },
    noreply_cap: NOREPLY_CAP,
    lost_reasons: LOST_REASONS.slice(),
    platform_domains: PLATFORM_DOMAINS.slice(),
    platform_dr: PLATFORM_DR,
    schedule: clone(SCHEDULE),
    timezone: TIMEZONE,
    prod_host: PROD_HOST,
    sheet_url: SHEET_URL,
    test_mode: TEST_MODE,
    limits: limitsFor("free"),
    features: { settings: false, suggestions: false, runs: false, dnc: false },
    freshness: null,
  };
}

// "Botanical Synthesis", "botanical-synthesis" and "botanicalsynthesis" compact to one key.
const compact = (s) => String(s == null ? "" : s).toLowerCase().replace(/[^a-z0-9]+/g, "");

/** The URL slug of a stored client key ("botanical synthesis" -> "botanical-synthesis"). */
export function slugOf(k) {
  return String(k == null ? "" : k).trim().toLowerCase().replace(/\s+/g, "-");
}

/**
 * The display name of one raw client token, or the token itself when it is not a known client
 * ("Ultahost" -> "UltaHost"; "Melograno - Trafft" stays as it is). Used where the server picks an
 * activity's client (spec 6.3.3: "client defaults to the site's first client").
 */
export function clientName(token, clients = CLIENTS, past = PAST_CLIENTS) {
  const t = String(token == null ? "" : token).trim();
  const c = compact(t);
  if (!c) return "";
  for (const x of [...clients, ...past]) {
    if ([x.k, x.name, x.slug, ...(x.aliases || [])].some((v) => v != null && compact(v) === c)) return x.name;
  }
  return t;
}

/** The first client token of a stored clients value (split on "," and "/", as the old page did). */
export function firstClient(clients) {
  return String(clients == null ? "" : clients).split(/\s*[,/]\s*/).map((s) => s.trim()).filter(Boolean)[0] || "";
}
