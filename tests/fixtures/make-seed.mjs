// Synthetic fixture seed (spec 8; shape and groups in tests/fixtures/SCHEMA.md). Owner G1-D.
//
// 600 sites on *.example.test, 2,000 contacts, activity, edits, and (only when those tables exist)
// kv_meta, suggestions and runs. Everything is synthetic and deterministic: the same `today` always
// gives the same rows, and every date is relative to `today`.
//
//   node tests/fixtures/make-seed.mjs [--today YYYY-MM-DD] [--tables kv_meta,suggestions,runs | --all]
//       prints the seed SQL (base tables only unless --tables/--all names the optional ones)
//   node tests/fixtures/make-seed.mjs --counts [--today YYYY-MM-DD]
//       prints the counts, groups and intended Today lists as JSON
//
// Tests import it to get the expected numbers instead of writing them down twice:
//   import { buildFixture } from "../fixtures/make-seed.mjs";
//   const fx = buildFixture({ today: process.env.FIXTURE_TODAY });
//   fx.counts.by_stage.Replied; fx.groups["kamile-new"]; fx.intended.Kamile.doNow
//
// No side effects at import time. The seed never creates tables: run 001 (then 003, 004) first.
import { fileURLToPath } from "node:url";

export const FIXTURE_VERSION = 1;

/** Tables from migrations 003/004. Their rows are only written when the table exists. */
export const OPTIONAL_TABLES = ["kv_meta", "suggestions", "runs"];

export const COLUMNS = {
  partners: ["id", "domain", "name", "type", "dr", "traffic", "owner", "stage", "last_touch", "clients", "country", "contacts",
    "next_step", "next_due", "source", "seed_keyword", "notes", "deal_model", "deal_flat", "deal_pct", "deal_value",
    "content_url", "live_date", "tracking_id", "updated_at", "updated_by"],
  contacts: ["id", "account_id", "first_name", "last_name", "title", "linkedin", "email_status", "source", "primary_contact",
    "outreach_status", "last_email", "replied", "client", "email"],
  activity: ["n", "date", "account_id", "contact_id", "type", "by_whom", "summary", "client"],
  edits: ["n", "at", "by_whom", "kind", "account_id", "contact_id", "field", "old", "new", "applied"],
  client_programs: ["k", "network", "commission", "cookie_days", "payout_terms", "signup_url", "brief", "updated_at", "updated_by"],
  kv_meta: ["k", "v", "at", "by_whom"],
  suggestions: ["id", "run_date", "kind", "account_id", "client", "name", "title", "linkedin", "source", "to_email", "subject",
    "body", "note", "status", "reviewed_by", "reviewed_at"],
  runs: ["n", "name", "started_at", "finished_at", "status", "summary"],
};

export const TEAM = ["Jonas", "Vik", "Kamile", "Eivyda", "Monica", "Mantvydas", "Gaby", "Sandra", "Tomas", "Denisse", "Egle"];
export const PAST_OWNER = "Jay";

// ---------- dates ----------

/** The local calendar date, the same rule as js/core/format.js todayIso(). */
export function localToday(now = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return now.getFullYear() + "-" + p(now.getMonth() + 1) + "-" + p(now.getDate());
}

/** Calendar days added to a YYYY-MM-DD date. */
export function addDays(iso, n) {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

function monthDay(iso, monthsBack, day) {
  const [y, m] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1 - monthsBack, day)).toISOString().slice(0, 10);
}

// ---------- deterministic randomness ----------

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WORDS = ["hosting", "review", "coupon", "deals", "tech", "money", "travel", "finance", "wp", "saas",
  "inbox", "garden", "fitness", "health", "crypto", "photo", "gaming", "parent", "food", "design"];
const SUFFIXES = ["hub", "daily", "lab", "guide", "tips", "world", "insider", "zone", "base", "press"];
const TYPES = ["Media / Publisher", "Coupon / Deals", "Review", "Influencer / Social", "Affiliate Network", "Loyalty / Rewards",
  "Marketplace Partner", "Web Hosting", "Email Marketing", "WP / Web Platform", "Tech / SaaS", "Agency", "Other",
  "Uncategorized", "Uncategorized", "Uncategorized", "Uncategorized", null];
const COUNTRIES = ["US", "GB", "DE", "LT", "PL", "ES", "FR", null, null, null, null];
const FIRST = ["Lina", "Marek", "Sofia", "Tomasz", "Ieva", "Jonah", "Mia", "Leo", "Nora", "Paul", "Rita", "Sam", "Tara", "Uma",
  "Vera", "Will", "Yara", "Zoe", "Aldo", "Bea", "Cyril", "Dina", "Emil", "Fay"];
const LAST = ["Stone", "Rivers", "Fields", "Brooks", "Hill", "Lake", "Wood", "Ford", "Park", "Reed", "Marsh", "Vale", "Glen",
  "Shore", "Dale", "Heath", "Moor", "Banks", "Cliff", "Grove"];
const TITLES = ["Editor", "Founder", "Partnerships lead", "Marketing manager", "Content lead", "Owner", null, null];
const EMAIL_STATUS = ["Verified", "Guessed", "Unknown", "Delivered", "Valid", "Bounced"];
const CAP = (s) => s.charAt(0).toUpperCase() + s.slice(1);

// ---------- the fixture ----------

/**
 * Builds every row of the fixture plus the expected numbers.
 * @param {{today?: string}} [opts] today = YYYY-MM-DD (default FIXTURE_TODAY or the local date)
 */
export function buildFixture({ today } = {}) {
  today = today || process.env.FIXTURE_TODAY || localToday();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(today)) throw new Error("buildFixture: today must be YYYY-MM-DD, got " + today);
  const d = (n) => addDays(today, n);
  const ts = (n, hms) => d(n) + "T" + hms + "Z";
  const rnd = mulberry32(20261020);
  const pick = (list) => list[Math.floor(rnd() * list.length)];
  const int = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));

  const partners = [];
  const groups = {};
  const meta = new Map(); // id -> {cmode, fill}
  let pg = 0;

  function site(tagList, f = {}) {
    const id = f.id || "PG-" + String(++pg).padStart(5, "0");
    const num = Number(id.replace(/\D/g, ""));
    const word = WORDS[num % WORDS.length], suf = SUFFIXES[(num * 7) % SUFFIXES.length];
    const dr = f.dr !== undefined ? f.dr : (rnd() < 0.3 ? null : int(0, 85));
    const row = {
      id,
      domain: word + "-" + suf + "-" + num + ".example.test",
      name: CAP(word) + " " + CAP(suf) + " " + num,
      type: pick(TYPES),
      dr,
      traffic: dr == null ? null : int(0, 40) * 250,
      owner: null, stage: "New", last_touch: null, clients: null,
      country: pick(COUNTRIES),
      contacts: 0, next_step: null, next_due: null,
      source: "Past work (import)", seed_keyword: null, notes: null,
      deal_model: null, deal_flat: null, deal_pct: null, deal_value: null,
      content_url: null, live_date: null, tracking_id: null, updated_at: null, updated_by: null,
    };
    const { cmode, fill, ...rest } = f;
    Object.assign(row, rest);
    if (row.stage === "Contacted" || row.stage === "Replied") row.source = rest.source || "Gmail outreach";
    partners.push(row);
    meta.set(id, { cmode: cmode || defaultCmode(row), fill: fill !== false });
    for (const t of [].concat(tagList || [])) (groups[t] ||= []).push(id);
    return row;
  }
  function defaultCmode(row) {
    if (row.stage === "New" || row.stage === "Researching") return "none";
    if (row.stage === "Contacted") return row.last_touch ? "touch" : "none";
    if (row.stage === "Replied") return "none";
    return "replied";
  }
  const one = (tag) => {
    const ids = groups[tag];
    if (!ids || ids.length !== 1) throw new Error("fixture: group " + tag + " is not a single row");
    return byId(ids[0]);
  };
  const index = new Map();
  const byId = (id) => {
    if (!index.has(id)) index.set(id, partners.find((p) => p.id === id));
    return index.get(id);
  };

  // ---- Kamile (318 PG + 2 NEW): the busy prospector ----
  const kamClients = (i) => (i % 7 === 3 ? "UltaHost" : i % 7 === 5 ? "Weglot, Ultahost" : i % 11 === 4 ? "GuardBlinds" : "Ultahost");
  for (let i = 0; i < 28; i++) {
    site(["kamile-new", i < 5 ? "kamile-new-sugg" : null, i === 5 ? "kamile-new-dismissed" : null].filter(Boolean),
      { owner: "Kamile", stage: "New", clients: kamClients(i), source: i % 3 ? "Past work (import)" : "Ahrefs",
        seed_keyword: i % 3 ? null : "best web hosting", fill: false });
  }
  for (let i = 0; i < 150; i++) {
    site(["kamile-contacted-nodate"], { owner: "Kamile", stage: "Contacted", clients: kamClients(i),
      next_step: i % 4 === 0 ? "Follow up if no reply" : null });
  }
  for (let i = 0; i < 30; i++) {
    site(["kamile-contacted-20d"], { owner: "Kamile", stage: "Contacted", clients: kamClients(i), last_touch: d(-20) });
  }
  // The Today rows (B.1 to B.3), one each.
  site(["K-od1", "kamile-today"], { owner: "Kamile", stage: "Contacted", clients: "Ultahost", last_touch: d(-10), next_due: d(-3), next_step: "Send the follow-up" });
  site(["K-od2", "kamile-today"], { owner: "Kamile", stage: "Replied", clients: "UltaHost", last_touch: d(-4), next_due: d(-1), next_step: "Answer their reply" });
  site(["K-od3", "kamile-today"], { owner: "Kamile", stage: "Active", clients: "Ultahost", last_touch: d(-6), next_due: d(-6), next_step: "Check the placement is live",
    deal_model: "Flat fee", deal_flat: 300, deal_value: 300 });
  site(["K-due1", "kamile-today"], { owner: "Kamile", stage: "Contacted", clients: "Ultahost", last_touch: d(-7), next_due: d(0), next_step: "Follow up if no reply" });
  site(["K-due2", "kamile-today"], { owner: "Kamile", stage: "Replied", clients: "Ultahost", last_touch: d(-1), next_due: d(0), next_step: "Answer their reply" });
  site(["K-rep-a", "kamile-today"], { owner: "Kamile", stage: "Replied", clients: "Weglot, Ultahost", last_touch: d(-2) });
  site(["K-rep-b", "kamile-today"], { owner: "Kamile", stage: "Replied", clients: "Ultahost", last_touch: d(-5), cmode: "replied-email", fill: false });
  site(["K-rep-handled", "kamile-today"], { owner: "Kamile", stage: "Replied", clients: "Ultahost", last_touch: d(-3) });
  site(["K-rep-handled2", "kamile-today"], { owner: "Kamile", stage: "Replied", clients: "Ultahost", last_touch: d(-4) });
  site(["K-rep-stale", "kamile-today"], { owner: "Kamile", stage: "Replied", clients: "Ultahost", last_touch: d(-9) });
  site(["K-neg-decision", "kamile-today"], { owner: "Kamile", stage: "Negotiating", clients: "Ultahost", last_touch: d(-2),
    deal_model: "Commission (CPA)", deal_value: 2000 });
  site(["K-neg-waiting", "kamile-today"], { owner: "Kamile", stage: "Negotiating", clients: "UltaHost", last_touch: d(-9),
    next_step: "Waiting on client: pricing approval from UltaHost", deal_model: "Flat fee", deal_flat: 750, deal_value: 750 });
  site(["K-neg-snoozed", "kamile-today"], { owner: "Kamile", stage: "Negotiating", clients: "Ultahost", last_touch: d(-1), next_due: d(5),
    next_step: "Agree terms" });
  site(["K-fut1", "kamile-today"], { owner: "Kamile", stage: "Contacted", clients: "Ultahost", last_touch: d(-3), next_due: d(2), next_step: "Follow up if no reply" });
  site(["K-fut2", "kamile-today"], { owner: "Kamile", stage: "Replied", clients: "Ultahost", last_touch: d(-2), next_due: d(1), next_step: "Answer their reply" });
  site(["K-act-quiet", "kamile-today"], { owner: "Kamile", stage: "Active", clients: "GuardBlinds", last_touch: d(-20),
    deal_model: "Revenue share", deal_pct: 20 });
  site(["K-act-live", "kamile-today"], { owner: "Kamile", stage: "Active", clients: "Ultahost", last_touch: d(-40),
    content_url: "https://hosting-roundup.example.test/best-hosts", live_date: d(-40), deal_model: "Free placement" });
  for (const n of [-15, -45, -90]) site(["kamile-lost", "kamile-today"], { owner: "Kamile", stage: "Lost", clients: "Ultahost", last_touch: d(n) });
  for (let i = 0; i < 90; i++) {
    site(["kamile-replied-nodate", "replied-nodate"], { owner: "Kamile", stage: "Replied", clients: kamClients(i), cmode: i % 2 ? "none" : "replied-nodate" });
  }

  // ---- Jonas (81 PG + 1 NEW): deals and email-dated replies ----
  const jonClient = (i) => (i % 5 === 2 ? "TransferGO" : i % 9 === 4 ? "Soro, TransferGO" : "Soro");
  for (let i = 0; i < 40; i++) {
    site(["jonas-replied-old"], { owner: "Jonas", stage: "Replied", clients: jonClient(i), last_touch: d(-8 - (i % 23)),
      cmode: i % 3 ? "none" : "replied-nodate" });
  }
  for (let i = 0; i < 6; i++) {
    site(["jonas-replied-email"], { owner: "Jonas", stage: "Replied", clients: "Soro", last_touch: i < 3 ? d(-12) : null,
      cmode: "replied-email-10", fill: false });
  }
  site(["J-neg-1", "jonas-neg", "jonas-decision"], { owner: "Jonas", stage: "Negotiating", clients: "Soro", last_touch: d(-1),
    deal_model: "Flat fee", deal_flat: 1200, deal_value: 1200, next_step: "Agree terms" });
  site(["J-neg-2", "jonas-neg", "jonas-decision"], { owner: "Jonas", stage: "Negotiating", clients: "Soro", last_touch: d(-4),
    deal_model: "Revenue share", deal_pct: 25, deal_value: 3000 });
  site(["J-neg-3", "jonas-neg", "jonas-decision"], { owner: "Jonas", stage: "Negotiating", clients: "TransferGO", last_touch: d(-6),
    deal_model: "Commission (CPA)" });
  site(["J-neg-marker", "jonas-neg", "jonas-decision", "internal-marker"], { owner: "Jonas", stage: "Negotiating", clients: "Soro",
    last_touch: d(-8), deal_value: 800, next_step: "Check INTERNAL-MARKER-7 before the call", notes: "INTERNAL-MARKER-7 internal note" });
  site(["J-neg-wait-1", "jonas-neg", "waiting-on-client"], { owner: "Jonas", stage: "Negotiating", clients: "Soro", last_touch: d(-3),
    deal_model: "Flat fee", deal_flat: 500, next_step: "Waiting on client: Soro to approve the fee" });
  site(["J-neg-wait-2", "jonas-neg", "waiting-on-client"], { owner: "Jonas", stage: "Negotiating", clients: "TransferGO", last_touch: d(-10),
    next_step: "Waiting on client: TransferGO budget sign-off" });
  const lastMonth10 = monthDay(today, 1, 10), lastMonth20 = monthDay(today, 1, 20);
  site(["J-act-live-1", "soro-live-last-month"], { owner: "Jonas", stage: "Active", clients: "Soro", last_touch: lastMonth10,
    content_url: "https://soro-review.example.test/post-1", live_date: lastMonth10, deal_model: "Flat fee", deal_flat: 400, deal_value: 400,
    tracking_id: "EF-1001" });
  site(["J-act-live-2", "soro-live-last-month"], { owner: "Jonas", stage: "Active", clients: "Soro", last_touch: lastMonth20,
    content_url: "https://soro-review.example.test/post-2", live_date: lastMonth20, deal_model: "Revenue share", deal_pct: 30 });
  site(["J-act-future", "active-future-live"], { owner: "Jonas", stage: "Active", clients: "Soro", last_touch: d(-2),
    content_url: "https://soro-review.example.test/coming-soon", live_date: d(10), deal_model: "Flat fee", deal_flat: 650, deal_value: 650 });
  site(["J-act-signed"], { owner: "Jonas", stage: "Active", clients: "Soro", last_touch: d(-5), deal_model: "Gifted product",
    next_step: "Check the placement is live" });
  for (let i = 0; i < 10; i++) {
    const special = i === 2;
    site(special ? ["jonas-contacted", "site-x"] : ["jonas-contacted"], {
      owner: "Jonas", stage: "Contacted", clients: jonClient(i), last_touch: d(-3 - i),
      ...(special ? { domain: "x.example.test", name: "X Example Media", fill: false } : {}),
    });
  }
  for (let i = 0; i < 5; i++) site(["jonas-noreply"], { owner: "Jonas", stage: "Contacted", clients: "Soro", last_touch: d(-16 - i * 2) });
  site(["J-od"], { owner: "Jonas", stage: "Contacted", clients: "TransferGO", last_touch: d(-9), next_due: d(-2), next_step: "Send the follow-up" });
  for (let i = 0; i < 6; i++) {
    const big = i >= 4;
    site(big ? ["jonas-new", "platform"] : ["jonas-new"], { owner: "Jonas", stage: "New", clients: "Soro",
      ...(big ? { dr: 92 + i, traffic: 2500000, domain: "bigportal-j" + i + ".example.test", name: "Big Portal J" + i, fill: false } : {}) });
  }
  site(["J-lost-terms", "lost-with-terms"], { owner: "Jonas", stage: "Lost", clients: "Soro", last_touch: d(-20),
    deal_model: "Flat fee", deal_flat: 900, deal_value: 900, content_url: "https://lost-placement.example.test/p", live_date: d(-60),
    tracking_id: "EF-0999" });
  site(["jonas-lost"], { owner: "Jonas", stage: "Lost", clients: "Soro", last_touch: d(-5) });
  site(["jonas-lost"], { owner: "Jonas", stage: "Lost", clients: "TransferGO", last_touch: d(-100) });

  // ---- Vik (20) ----
  site(["vik-neg", "vik-decision"], { owner: "Vik", stage: "Negotiating", clients: "TransferGO", last_touch: d(-5), deal_model: "Flat fee + commission",
    deal_flat: 250, deal_pct: 10, deal_value: 1000 });
  for (let i = 0; i < 6; i++) site(["vik-replied-nodate", "replied-nodate"], { owner: "Vik", stage: "Replied", clients: "Soro" });
  site(["vik-replied-handled"], { owner: "Vik", stage: "Replied", clients: "Soro", last_touch: d(-6) });
  for (let i = 0; i < 5; i++) site(["vik-contacted"], { owner: "Vik", stage: "Contacted", clients: i % 2 ? "Soro" : "TransferGO", last_touch: d(-2 - i * 4) });
  for (let i = 0; i < 4; i++) site(["vik-new"], { owner: "Vik", stage: "New", clients: "TransferGO" });
  site(["vik-active"], { owner: "Vik", stage: "Active", clients: "TransferGO", last_touch: d(-30), content_url: "https://money-transfer.example.test/guide",
    live_date: d(-30), deal_model: "Commission (CPA)" });
  site(["vik-lost"], { owner: "Vik", stage: "Lost", clients: "Soro", last_touch: d(-12) });
  site(["vik-lost"], { owner: "Vik", stage: "Lost", clients: "TransferGO", last_touch: d(-70) });

  // ---- Eivyda (18): Botanical Synthesis and Melograno ----
  const eivClients = ["Botanical Synthesis", "Melograno - Trafft", "Botanical Synthesis", "Melograno - Trafft", "Melograno - wpDataTables", "Botanical Synthesis"];
  for (let i = 0; i < 6; i++) site(["eivyda-new"], { owner: "Eivyda", stage: "New", clients: eivClients[i] });
  for (let i = 0; i < 5; i++) site(["eivyda-contacted"], { owner: "Eivyda", stage: "Contacted", clients: eivClients[i], last_touch: d(-4 - i * 3) });
  site(["eivyda-replied"], { owner: "Eivyda", stage: "Replied", clients: "Botanical Synthesis", last_touch: d(-3) });
  site(["eivyda-replied"], { owner: "Eivyda", stage: "Replied", clients: "Melograno - Trafft", last_touch: d(-12) });
  site(["E-neg-1", "eivyda-decision"], { owner: "Eivyda", stage: "Negotiating", clients: "Melograno - Trafft", last_touch: d(-3), deal_model: "Revenue share", deal_pct: 15 });
  site(["E-neg-wait", "waiting-on-client"], { owner: "Eivyda", stage: "Negotiating", clients: "Melograno - Trafft", last_touch: d(-2),
    next_step: "Waiting on client: Melograno to confirm the Trafft budget" });
  site(["eivyda-active"], { owner: "Eivyda", stage: "Active", clients: "Botanical Synthesis", last_touch: d(-25),
    content_url: "https://wellness-reads.example.test/botanicals", live_date: d(-25), deal_model: "Gifted product" });
  site(["eivyda-lost"], { owner: "Eivyda", stage: "Lost", clients: "Botanical Synthesis", last_touch: d(-8) });
  site(["eivyda-lost"], { owner: "Eivyda", stage: "Lost", clients: "Melograno - Trafft", last_touch: d(-50) });

  // ---- Monica (14): Raibu, plus the channel row and the contact-name search row ----
  for (let i = 0; i < 4; i++) site(["monica-new"], { owner: "Monica", stage: "New", clients: "Raibu" });
  for (let i = 0; i < 5; i++) site(["monica-contacted"], { owner: "Monica", stage: "Contacted", clients: "Raibu", last_touch: d(-5) });
  site(["monica-contacted", "contact-name-site"], { owner: "Monica", stage: "Contacted", clients: "Raibu", last_touch: d(-5),
    domain: "garden-lab.example.test", name: "Garden Lab", fill: false });
  site(["monica-replied"], { owner: "Monica", stage: "Replied", clients: "Raibu", last_touch: d(-1) });
  site(["monica-active"], { owner: "Monica", stage: "Active", clients: "Raibu", last_touch: d(-3), deal_model: "Free placement" });
  site(["monica-lost"], { owner: "Monica", stage: "Lost", clients: "Raibu", last_touch: d(-40) });
  site(["channel"], { owner: "Monica", stage: "Contacted", clients: "Raibu", last_touch: d(-30), dr: 99, traffic: null,
    domain: "youtube.com/@pgfixture-channel", name: "PG Fixture Channel", type: "Influencer / Social" });

  // ---- Mantvydas (8): Fiverr ----
  for (let i = 0; i < 3; i++) site(["mantvydas-new"], { owner: "Mantvydas", stage: "New", clients: "Fiverr" });
  for (let i = 0; i < 3; i++) site(["mantvydas-contacted"], { owner: "Mantvydas", stage: "Contacted", clients: "Fiverr", last_touch: d(-6 - i) });
  site(["mantvydas-replied"], { owner: "Mantvydas", stage: "Replied", clients: "Fiverr", last_touch: d(-2) });
  site(["mantvydas-lost"], { owner: "Mantvydas", stage: "Lost", clients: "Fiverr", last_touch: d(-22) });

  // ---- Gaby (37): MailerLite / MailerSend / Headway, plus search and duplicate rows ----
  const gabClients = ["MailerLite/MailerSend", "MailerLite", "MailerSend", "Headway", "MailerLite/MailerSend"];
  for (let i = 0; i < 12; i++) site(["gaby-replied-nodate", "replied-nodate"], { owner: "Gaby", stage: "Replied", clients: gabClients[i % 5] });
  for (let i = 0; i < 5; i++) site(["gaby-new"], { owner: "Gaby", stage: "New", clients: gabClients[i] });
  site(["gaby-researching", "researching"], { owner: "Gaby", stage: "Researching", clients: "Headway" });
  for (let i = 0; i < 10; i++) site(["gaby-contacted"], { owner: "Gaby", stage: "Contacted", clients: gabClients[i % 5], last_touch: d(-3 - i * 2) });
  site(["gaby-contacted", "dupe-site"], { owner: "Gaby", stage: "Contacted", clients: "MailerLite/MailerSend", last_touch: d(-6),
    domain: "dupe.example.test", name: "Dupe Example" });
  site(["gaby-contacted", "mr-money"], { owner: "Gaby", stage: "Contacted", clients: "MailerLite", last_touch: d(-8),
    domain: "mrmoneymatters.example.test", name: "Mr. Money Matters" });
  site(["gaby-contacted", "site-y"], { owner: "Gaby", stage: "Contacted", clients: "MailerSend", last_touch: d(-9),
    domain: "y.example.test", name: "Y Example Deals", fill: false });
  site(["gaby-contacted", "site-w"], { owner: "Gaby", stage: "Contacted", clients: "Headway", last_touch: d(-10),
    domain: "w.example.test", name: "W Example Weekly", fill: false });
  site(["gaby-contacted", "site-ann"], { owner: "Gaby", stage: "Contacted", clients: "MailerLite", last_touch: d(-11),
    domain: "annex-reviews.example.test", name: "Annex Reviews", fill: false });
  site(["gaby-conflict"], { owner: "Gaby", stage: "Lost", clients: "Headway", last_touch: d(-4) });
  site(["gaby-active"], { owner: "Gaby", stage: "Active", clients: "MailerLite", last_touch: d(-15), deal_model: "Commission (CPA)" });
  site(["gaby-lost"], { owner: "Gaby", stage: "Lost", clients: "MailerSend", last_touch: d(-33) });
  site(["gaby-dnc", "do-not-contact"], { owner: "Gaby", stage: "Do not contact", clients: "MailerLite", last_touch: d(-60) });

  // ---- Sandra (7), Tomas (5), Denisse (2), Egle (2), Jay (3, past owner) ----
  for (let i = 0; i < 2; i++) site(["sandra-replied-nodate", "replied-nodate"], { owner: "Sandra", stage: "Replied", clients: "Desktronic" });
  for (let i = 0; i < 2; i++) site(["sandra-new"], { owner: "Sandra", stage: "New", clients: "Desktronic" });
  for (let i = 0; i < 2; i++) site(["sandra-contacted"], { owner: "Sandra", stage: "Contacted", clients: "Desktronic", last_touch: d(-15 - i) });
  site(["sandra-lost"], { owner: "Sandra", stage: "Lost", clients: "Desktronic", last_touch: d(-18) });
  for (let i = 0; i < 2; i++) site(["tomas-new"], { owner: "Tomas", stage: "New", clients: "Termly" });
  for (let i = 0; i < 2; i++) site(["tomas-contacted"], { owner: "Tomas", stage: "Contacted", clients: "Termly", last_touch: d(-21 - i) });
  site(["tomas-lost"], { owner: "Tomas", stage: "Lost", clients: "Termly", last_touch: d(-80) });
  for (let i = 0; i < 2; i++) site(["denisse-new"], { owner: "Denisse", stage: "New", clients: "TransferGO" });
  for (let i = 0; i < 2; i++) site(["egle-new"], { owner: "Egle", stage: "New", clients: "Headway" });
  for (let i = 0; i < 2; i++) site(["jay-contacted", "past-owner"], { owner: PAST_OWNER, stage: "Contacted", clients: "Weglot" });
  site(["jay-lost", "past-owner"], { owner: PAST_OWNER, stage: "Lost", clients: "Weglot", last_touch: d(-200) });

  // ---- No owner (41), including 8 platform rows ----
  for (let i = 0; i < 10; i++) site(["unowned-replied-nodate", "replied-nodate"], { stage: "Replied", clients: i % 2 ? "Weglot" : null });
  for (let i = 0; i < 25; i++) {
    const big = i < 8;
    site(big ? ["unowned-new", "platform"] : ["unowned-new"], { stage: "New", clients: i % 4 === 1 ? "Weglot" : i % 4 === 2 ? "Termly" : null,
      ...(big ? { dr: 90 + i, traffic: 5000000 + i * 1000, domain: "bigportal-" + i + ".example.test", name: "Big Portal " + i, fill: false } : {}) });
  }
  site(["unowned-researching", "researching"], { stage: "Researching" });
  site(["unowned-researching", "researching"], { stage: "Researching", clients: "Weglot" });
  for (let i = 0; i < 3; i++) site(["unowned-contacted"], { stage: "Contacted", clients: "Weglot", last_touch: i ? d(-40 - i) : null });
  site(["unowned-lost"], { stage: "Lost", clients: "Termly", last_touch: d(-120) });

  // ---- 20 nameless creators (no name, no domain) with contacts ----
  for (let i = 0; i < 20; i++) {
    const owner = i < 6 ? "Gaby" : i < 12 ? "Monica" : null;
    site(["nameless"], { owner, stage: i % 5 < 2 ? "New" : "Contacted", domain: null, name: null, type: "Influencer / Social", dr: null, traffic: null,
      clients: i % 3 ? "Raibu" : "MailerLite", fill: false });
  }

  // ---- 20 contract rows (PG-00577 to PG-00596) for tests/e2e/golden: no other test may change them ----
  const contract = (tag, f) => site(["contract", tag], { owner: "Tomas", fill: false, ...f,
    domain: tag + ".contract.example.test", name: "Contract " + tag });
  contract("c-interested", { stage: "Replied", clients: "Soro", last_touch: d(-2), next_step: "Answer their reply", type: "Review" });
  contract("c-deal", { stage: "Replied", clients: "Soro", last_touch: d(-3), type: "Review" });
  contract("c-lost", { stage: "Contacted", clients: "Ultahost", last_touch: d(-9), next_step: "Follow up if no reply", next_due: d(1) });
  contract("c-assign", { stage: "New", owner: null, clients: "Weglot ,Soro", type: "Uncategorized" });
  contract("c-nochange", { stage: "Contacted", clients: "Soro", next_step: "Follow up if no reply" });
  contract("c-waiting", { stage: "Replied", clients: "TransferGO", last_touch: d(-6), next_step: "Agree terms" });
  contract("c-note", { stage: "Contacted", clients: "MailerLite/MailerSend" });
  contract("c-live", { stage: "Active", clients: "Soro" });
  contract("c-bulk-a", { stage: "New", owner: "Mantvydas", clients: "Weglot, Ultahost" });
  contract("c-bulk-b", { stage: "New", owner: null, clients: null });
  contract("c-bulk-c", { stage: "Contacted", owner: "Gaby", clients: "soro" });
  contract("c-bulk-d", { stage: "Researching", owner: "Tomas", clients: "Ultahost" });
  contract("c-bulk-e", { stage: "Contacted", next_due: d(4) });
  contract("c-bulk-f", { stage: "Contacted", next_due: null });
  contract("c-contact", { stage: "Contacted", clients: "Soro" });
  contract("c-contact-2", { stage: "New", clients: null });
  contract("c-spare-1", { stage: "New" });
  contract("c-spare-2", { stage: "Contacted" });
  contract("c-spare-3", { stage: "Replied", last_touch: d(-15) });
  contract("c-spare-4", { stage: "Lost" });

  // ---- 4 sites added on the site and not copied yet (NEW-0001 to NEW-0004) ----
  const added = (n, tagList, f) => site(tagList, { id: "NEW-" + String(n).padStart(4, "0"), source: "Added on site", fill: false,
    domain: "fresh-find-" + n + ".example.test", name: "Fresh Find " + n, type: null, dr: null, traffic: null, country: null, ...f });
  added(1, ["kamile-new", "new-ids"], { owner: "Kamile", stage: "New", clients: "Ultahost", updated_at: ts(-1, "10:05:00"), updated_by: "Kamile" });
  added(2, ["kamile-new", "new-ids"], { owner: "Kamile", stage: "New", clients: "UltaHost", updated_at: ts(0, "07:30:00"), updated_by: "Kamile" });
  added(3, ["new-ids", "new-3"], { owner: "Gaby", stage: "Contacted", clients: "MailerSend", last_touch: d(-1), updated_at: ts(-1, "11:20:00"), updated_by: "Gaby" });
  added(4, ["new-ids", "jonas-new"], { owner: "Jonas", stage: "New", clients: "Soro", updated_at: ts(0, "08:02:00"), updated_by: "Jonas" });

  // ---------- contacts (2,000) ----------
  const contacts = [];
  let cn = 0;
  const firstClient = (p) => (p.clients ? p.clients.split(/\s*[,/]\s*/)[0] : null);
  function contact(p, f = {}) {
    const k = ++cn;
    const first = f.first_name !== undefined ? f.first_name : FIRST[(k * 7) % FIRST.length];
    const last = f.last_name !== undefined ? f.last_name : LAST[(k * 3) % LAST.length];
    const host = p.domain && !p.domain.includes("/") ? p.domain : "mail.example.test";
    const mode = meta.get(p.id).cmode;
    const firstOfSite = !contacts.some((c) => c.account_id === p.id);
    let last_email = null, replied = 0;
    if (mode === "touch") last_email = p.last_touch;
    else if (mode === "replied") { last_email = p.last_touch; replied = firstOfSite ? 1 : 0; }
    else if (mode === "replied-nodate") replied = firstOfSite ? 1 : 0;
    else if (mode === "replied-email") { last_email = firstOfSite ? p.last_touch : null; replied = firstOfSite ? 1 : 0; }
    else if (mode === "replied-email-10") { last_email = firstOfSite ? d(-10) : d(-40); replied = firstOfSite ? 1 : 0; }
    const noEmail = f.email === undefined && k % 23 === 0;
    const c = {
      id: f.id || "C-" + String(k).padStart(5, "0"),
      account_id: p.id,
      first_name: first,
      last_name: last,
      title: f.title !== undefined ? f.title : TITLES[k % TITLES.length],
      linkedin: k % 4 === 0 ? "https://linkedin.example.test/in/" + (first || "x").toLowerCase() + "-" + (last || "y").toLowerCase() + "-" + k : null,
      email_status: noEmail ? null : EMAIL_STATUS[k % EMAIL_STATUS.length],
      source: k % 3 ? "Gmail import" : "Apollo",
      primary_contact: firstOfSite ? 1 : 0,
      outreach_status: p.stage === "New" || p.stage === "Researching" ? "Not started"
        : p.stage === "Contacted" ? (k % 2 ? "Sent" : "In sequence") : replied ? "Replied" : "Sent",
      last_email,
      replied,
      client: firstClient(p),
      email: noEmail ? null : ((first || "hello") + "." + (last || "team") + "." + k + "@" + host).toLowerCase(),
    };
    Object.assign(c, f);
    contacts.push(c);
    return c;
  }
  // Named contacts the search and duplicate tests rely on.
  const siteX = one("site-x"), siteY = one("site-y"), siteW = one("site-w"), siteAnn = one("site-ann");
  contact(siteX, { first_name: "Rob", last_name: "Fields", title: "Editor", email: "rob@x.example.test" });
  contact(siteX, { first_name: "Jo", last_name: "Ann", title: "Partnerships lead", email: "joann@x.example.test" });
  contact(siteAnn, { first_name: "Ann", last_name: "Hill", title: "Founder", email: "ann@x.example.test" });
  contact(siteY, { first_name: "Abe", last_name: "Brooks", title: "Owner", email: "a@y.example.test; b@y.example.test" });
  contact(siteW, { first_name: "Jox", last_name: "Ann", title: null, email: "joxann@w.example.test" });
  contact(one("contact-name-site"), { first_name: "Ottilie", last_name: "Vance", title: "Content lead", email: "ottilie.vance@garden-lab.example.test" });
  contact(one("c-contact"), { first_name: "Dupe", last_name: "Contact", title: "Editor", email: "dupe-contact@contract.example.test" });
  contact(one("c-note"), { first_name: "Nell", last_name: "Note", title: "Editor", email: "nell@c-note.contract.example.test" });
  contact(one("K-rep-b"));
  for (const id of groups["jonas-replied-email"]) { contact(byId(id)); if (byId(id).last_touch) contact(byId(id)); }
  for (const id of groups.nameless) {
    const p = byId(id), i = groups.nameless.indexOf(id);
    contact(p, { first_name: i % 4 === 3 ? null : FIRST[(i * 5) % FIRST.length], last_name: i % 4 === 3 ? null : LAST[(i * 9) % LAST.length],
      email: "creator" + (i + 1) + "@mail.example.test", title: "Creator" });
    if (i % 3 === 0) contact(p, { email: "creator" + (i + 1) + ".team@mail.example.test", title: null });
  }
  // Site-added contacts not copied yet: NEWC-0001 on NEW-0003, NEWC-0002 on a Gaby site.
  const newc1 = contact(byId("NEW-0003"), { id: "NEWC-0001", first_name: "Fresh", last_name: "Contact", title: "Editor",
    email: "fresh.contact@fresh-find-3.example.test", email_status: "Unverified", source: "Added on site", outreach_status: "Not contacted",
    last_email: null, replied: 0, linkedin: null });
  const gabyNew = byId(groups["gaby-contacted"][0]);
  const newc2 = contact(gabyNew, { id: "NEWC-0002", first_name: "Second", last_name: "Find", title: null, email: "",
    email_status: null, source: "Added on site", outreach_status: "Not contacted", last_email: null, replied: 0, linkedin: null });
  newc2.email = null;
  // Fill the rest from the eligible sites, deterministically.
  const pool = partners.filter((p) => meta.get(p.id).fill && p.id.startsWith("PG-"));
  const C_TOTAL = 2000;
  const reserved = 2; // the two NEWC contacts above keep their own ids
  while (contacts.length < C_TOTAL) contact(pool[Math.floor(rnd() * pool.length)]);
  // Renumber C- ids so they run C-00001.. without gaps (NEWC ids stay as they are).
  let ck = 0;
  for (const c of contacts) if (!c.id.startsWith("NEWC-")) c.id = "C-" + String(++ck).padStart(5, "0");
  if (ck !== C_TOTAL - reserved) throw new Error("fixture: contact count " + ck);
  const perSite = new Map();
  for (const c of contacts) perSite.set(c.account_id, (perSite.get(c.account_id) || 0) + 1);
  for (const p of partners) p.contacts = perSite.get(p.id) || 0;

  // ---------- activity ----------
  const activity = [];
  const act = (p, date, type, by, summary, extra = {}) => {
    const a = { n: activity.length + 1, date, account_id: p.id, contact_id: null, type, by_whom: by, summary,
      client: firstClient(p) && canonicalForActivity(firstClient(p)), ...extra };
    activity.push(a);
    return a;
  };
  for (const tag of ["J-neg-1", "J-neg-2", "J-neg-3", "J-neg-marker", "J-neg-wait-1", "J-neg-wait-2"]) {
    const p = one(tag);
    act(p, p.last_touch, tag === "J-neg-3" ? "Call" : "Email", "Jonas", tag === "J-neg-marker" ? "Discussed terms. INTERNAL-MARKER-7" : "Discussed the terms.");
  }
  act(one("J-act-live-1"), one("J-act-live-1").live_date, "Content live", "Jonas", "https://soro-review.example.test/post-1");
  act(one("J-act-live-2"), one("J-act-live-2").live_date, "Content live", "Jonas", "https://soro-review.example.test/post-2");
  act(one("J-act-signed"), one("J-act-signed").last_touch, "Deal update", "Jonas", "Signed: gifted product.");
  act(one("J-lost-terms"), one("J-lost-terms").last_touch, "Deal update", "Jonas", "Not interested: Price too high.");
  const handled = act(one("K-rep-handled"), d(-2), "Email", "Kamile", "Answered their question about the offer.");
  act(one("K-neg-decision"), d(-2), "Call", "Kamile", "Call about commission terms.");
  act(one("K-act-quiet"), d(-20), "Deal update", "Kamile", "Signed: 20% revenue share.");
  act(one("K-act-live"), d(-40), "Content live", "Kamile", "https://hosting-roundup.example.test/best-hosts");
  for (const id of groups["kamile-contacted-20d"].slice(0, 3)) act(byId(id), d(-20), "Outreach email", "Kamile", "First email sent.");
  act(byId(groups["vik-replied-handled"][0]), d(-5), "Email", "Vik", "Sent the media kit.");
  act(one("vik-neg"), d(-5), "Meeting", "Vik", "Intro meeting.");
  for (const id of groups["monica-contacted"].slice(0, 3)) act(byId(id), d(-5), "Email", "Monica", "First email sent.");
  for (const id of groups["gaby-contacted"].slice(0, 4)) act(byId(id), byId(id).last_touch, "Call", "Gaby", "Quick call, they will think about it.");
  act(byId(groups["eivyda-active"][0]), d(-25), "Content live", "Eivyda", "https://wellness-reads.example.test/botanicals");
  act(one("E-neg-1"), d(-3), "Email", "Eivyda", "Sent the Trafft offer.");
  act(byId(groups["mantvydas-replied"][0]), d(-2), "Reply", "Mantvydas", "They asked for rates.");
  act(byId(groups["tomas-lost"][0]), d(-80), "Note", "Tomas", "Termly program ended.");
  // Written on the site (each has an edits row below):
  const actNew2 = act(byId("NEW-0002"), d(0), "Note", "Kamile", "Found through a hosting roundup.");
  const actMon = act(byId(groups["monica-contacted"][3]), d(-5), "Email", "Monica", "Sent the Raibu pitch.");
  const actJon = act(one("J-neg-1"), d(-1), "Note", "Jonas", "Asked for their media kit.", { contact_id: null });

  // ---------- client programs ----------
  const client_programs = [
    { k: "botanical synthesis", network: "Impact", commission: "20% per sale", cookie_days: 30, payout_terms: "Monthly, net 30",
      signup_url: "https://botanical-synthesis.example.test/partners", brief: "Natural skincare. Prefers review posts.",
      updated_at: ts(-4, "09:00:00"), updated_by: "Eivyda" },
  ];

  // ---------- edits (n 1..30; n 1-18 applied except the conflict row n 7) ----------
  const edits = [];
  const edit = (at, by, kind, account_id, f = {}) => {
    const e = { n: edits.length + 1, at, by_whom: by, kind, account_id, contact_id: null, field: null, old: null, new: null, applied: 0, ...f };
    edits.push(e);
    return e;
  };
  const touch = (p, at, by) => { if (!p.updated_at || p.updated_at < at) { p.updated_at = at; p.updated_by = by; } };
  const upd = (p, at, by, field, old, val, applied) => {
    edit(at, by, "update", p.id, { field, old: old == null ? null : String(old), new: val == null ? null : String(val), applied });
    touch(p, at, by);
  };
  const vikC = byId(groups["vik-contacted"][0]), gabyC = byId(groups["gaby-contacted"][1]), gabyC2 = byId(groups["gaby-contacted"][2]);
  const monC = byId(groups["monica-contacted"][3]), eivC = byId(groups["eivyda-contacted"][0]), manC = byId(groups["mantvydas-contacted"][0]);
  const conflict = byId(groups["gaby-conflict"][0]);
  const renamed = byId(groups["gaby-contacted"][4]);
  upd(vikC, ts(-6, "08:12:05"), "Vik", "owner", null, "Vik", 1);
  upd(vikC, ts(-6, "08:12:05"), "Vik", "stage", "New", "Contacted", 1);
  gabyC.next_step = "Follow up if no reply"; gabyC.next_due = d(2);
  upd(gabyC, ts(-5, "10:01:00"), "Gaby", "next_step", null, gabyC.next_step, 1);
  upd(gabyC, ts(-5, "10:01:00"), "Gaby", "next_due", null, gabyC.next_due, 1);
  edit(ts(-5, "11:30:00"), "Monica", "activity", monC.id, { field: String(actMon.n), applied: 1,
    new: JSON.stringify({ date: actMon.date, type: actMon.type, summary: actMon.summary, client: actMon.client }) });
  touch(monC, ts(-5, "11:30:00"), "Monica");
  edit(ts(-4, "09:00:00"), "Eivyda", "client_program", null, { field: "botanical synthesis", applied: 1,
    new: JSON.stringify({ network: "Impact", commission: "20% per sale", payout_terms: "Monthly, net 30",
      signup_url: "https://botanical-synthesis.example.test/partners", brief: "Natural skincare. Prefers review posts.", cookie_days: 30 }) });
  // n 7: the conflict row. The sheet kept a later hand edit (Lost), so this stays applied=0 below the max applied n.
  edit(ts(-4, "15:20:00"), "Gaby", "update", conflict.id, { field: "stage", old: "Contacted", new: "Replied", applied: 0 });
  touch(conflict, ts(-4, "15:20:00"), "Gaby");
  const h2 = one("K-rep-handled2");
  h2.next_step = "Send pricing";
  upd(h2, ts(-3, "09:40:00"), "Kamile", "next_step", null, "Send pricing", 1);
  upd(eivC, ts(-3, "13:15:00"), "Eivyda", "type", "Uncategorized", "Review", 1);
  eivC.type = "Review";
  upd(manC, ts(-3, "14:00:00"), "Mantvydas", "next_step", null, "Send rates", 1);
  manC.next_step = "Send rates";
  // A site-added account and contact that the daily run already copied (ids renamed to PG-/C-).
  renamed.source = "Added on site";
  edit(ts(-3, "16:45:00"), "Gaby", "create_account", renamed.id, { applied: 1,
    new: JSON.stringify({ domain: renamed.domain, name: renamed.name, stage: "New", owner: "Gaby", clients: renamed.clients, type: null,
      next_step: null, next_due: null, notes: "", added: d(-3) }) });
  const renamedContact = contacts.find((c) => c.account_id === renamed.id);
  if (renamedContact) {
    edit(ts(-3, "16:50:00"), "Gaby", "create_contact", renamed.id, { contact_id: renamedContact.id, applied: 1,
      new: JSON.stringify({ first_name: renamedContact.first_name || "", last_name: renamedContact.last_name || "", title: renamedContact.title,
        email: renamedContact.email || "", linkedin: renamedContact.linkedin || "", client: renamedContact.client }) });
  } else {
    upd(renamed, ts(-3, "16:50:00"), "Gaby", "type", null, renamed.type, 1);
  }
  upd(gabyC2, ts(-2, "09:05:00"), "Gaby", "owner", "Monica", "Gaby", 1);
  upd(gabyC2, ts(-2, "09:05:00"), "Gaby", "clients", "MailerLite", gabyC2.clients, 1);
  upd(vikC, ts(-2, "10:30:00"), "Vik", "deal_model", null, "Commission (CPA)", 1);
  vikC.deal_model = "Commission (CPA)";
  upd(monC, ts(-2, "12:00:00"), "Monica", "tracking_id", null, "RB-77", 1);
  monC.tracking_id = "RB-77";
  upd(byId(groups["vik-new"][0]), ts(-2, "15:10:00"), "Vik", "owner", null, "Vik", 1);
  upd(byId(groups["vik-new"][1]), ts(-2, "15:10:00"), "Vik", "owner", null, "Vik", 1);
  // n 19..: waiting for the next morning copy (applied=0).
  const created = (p, at, by) => edit(at, by, "create_account", p.id, {
    new: JSON.stringify({ domain: p.domain, name: p.name, stage: p.stage === "Contacted" ? "New" : p.stage, owner: p.owner, clients: p.clients,
      type: null, next_step: null, next_due: null, notes: "", added: at.slice(0, 10) }) });
  created(byId("NEW-0001"), ts(-1, "10:05:00"), "Kamile");
  created(byId("NEW-0003"), ts(-1, "11:20:00"), "Gaby");
  edit(ts(-1, "11:25:00"), "Gaby", "create_contact", "NEW-0003", { contact_id: newc1.id,
    new: JSON.stringify({ first_name: "Fresh", last_name: "Contact", title: "Editor", email: newc1.email, linkedin: "", client: "MailerSend" }) });
  upd(byId("NEW-0003"), ts(-1, "11:40:00"), "Gaby", "stage", "New", "Contacted", 0);
  edit(ts(-1, "14:00:00"), "Gaby", "create_contact", gabyNew.id, { contact_id: newc2.id,
    new: JSON.stringify({ first_name: "Second", last_name: "Find", title: null, email: "", linkedin: "", client: firstClient(gabyNew) }) });
  touch(gabyNew, ts(-1, "14:00:00"), "Gaby");
  upd(byId(groups["eivyda-new"][0]), ts(-1, "15:30:00"), "Eivyda", "type", null, "Review", 0);
  byId(groups["eivyda-new"][0]).type = "Review";
  upd(byId(groups["unowned-new"][10]), ts(-1, "16:00:00"), "Someone", "owner", null, "Sandra", 0);
  byId(groups["unowned-new"][10]).owner = "Sandra";
  groups["unowned-new"] = groups["unowned-new"].filter((id) => id !== byId(groups["unowned-new"][10]).id);
  created(byId("NEW-0002"), ts(0, "07:30:00"), "Kamile");
  edit(ts(0, "07:31:00"), "Kamile", "activity", "NEW-0002", { field: String(actNew2.n),
    new: JSON.stringify({ date: actNew2.date, type: actNew2.type, summary: actNew2.summary, client: actNew2.client }) });
  created(byId("NEW-0004"), ts(0, "08:02:00"), "Jonas");
  edit(ts(0, "08:10:00"), "Jonas", "activity", one("J-neg-1").id, { field: String(actJon.n),
    new: JSON.stringify({ date: actJon.date, type: actJon.type, summary: actJon.summary, client: actJon.client }) });
  touch(one("J-neg-1"), ts(0, "08:10:00"), "Jonas");
  upd(byId(groups["mantvydas-new"][0]), ts(0, "08:20:00"), "Mantvydas", "next_step", null, "Find the right contact", 0);
  byId(groups["mantvydas-new"][0]).next_step = "Find the right contact";

  // ---------- 003 / 004 tables (only written when they exist) ----------
  const teamOverride = TEAM.map((name) => (name === "Vik" ? { name, home: "team", active: true } : { name, active: true }));
  const kv_meta = [{ k: "team", v: JSON.stringify(teamOverride), at: ts(-2, "09:00:00"), by_whom: "Jonas" }];

  const suggestions = [];
  const sugg = (p, kind, runDate, f = {}) => {
    const k = f.k ? ":" + f.k : "";
    const s = { id: runDate + ":" + kind + ":" + p.id + k, run_date: runDate, kind, account_id: p.id, client: f.client || null,
      name: null, title: null, linkedin: null, source: null, to_email: null, subject: null, body: null, note: null,
      status: "open", reviewed_by: null, reviewed_at: null, ...f };
    delete s.k;
    suggestions.push(s);
    return s;
  };
  const kn = groups["kamile-new-sugg"].map(byId);
  sugg(kn[0], "candidate", d(-1), { k: "1", client: "UltaHost", name: "Lina Brooks", title: "Partnerships lead",
    linkedin: "https://linkedin.example.test/in/lina-brooks", source: "Apollo" });
  sugg(kn[1], "candidate", d(-1), { k: "1", client: "UltaHost", name: "Marek Stone", title: "Editor", source: "Apollo" });
  sugg(kn[1], "email", d(-1), { k: "1", client: "UltaHost", name: "Marek Stone", subject: "UltaHost partnership",
    body: "Hi Marek, we work with UltaHost and think your readers would like their plans. Nothing is sent from this site." });
  sugg(kn[2], "email", d(-1), { k: "1", client: "UltaHost", subject: "Hosting deal for your readers", body: "Hi there, a short note about UltaHost." });
  sugg(kn[3], "candidate", d(-1), { k: "1", client: "UltaHost", name: "Sofia Reed", title: "Founder",
    linkedin: "https://linkedin.example.test/in/sofia-reed", source: "Apollo" });
  sugg(kn[4], "candidate", d(-1), { k: "1", client: "UltaHost", name: "Paul Vale", title: "Owner", source: "Apollo" });
  sugg(one("kamile-new-dismissed"), "candidate", d(-8), { k: "1", client: "UltaHost", name: "Dina Moor", source: "Apollo",
    status: "dismissed", reviewed_by: "Kamile", reviewed_at: ts(-7, "09:12:00") });
  sugg(siteX, "email", d(-1), { k: "1", client: "Soro", name: "Rob Fields", to_email: "rob@x.example.test", subject: "Soro for X Example Media",
    body: "Hi Rob, following up about Soro." });
  sugg(byId(groups["jonas-new"][0]), "candidate", d(-8), { k: "1", client: "Soro", name: "Uma Glen", source: "Apollo",
    status: "used", reviewed_by: "Jonas", reviewed_at: ts(-6, "10:00:00") });
  sugg(byId(groups["unowned-new"][9]), "slack_ask", d(-1), { client: null, note: "This site has no owner. Who takes it?" });
  sugg(byId(groups["unowned-new"][11]), "slack_ask", d(-1), { client: "Weglot", note: "This site has no owner. Who takes it?" });
  sugg(byId(groups["jay-contacted"][0]), "slack_ask", d(-1), { client: "Weglot", note: "Jay is no longer on the team. Who takes over this site?" });
  sugg(byId(groups["gaby-contacted"][5]), "email", d(-8), { k: "1", client: "MailerLite", subject: "MailerLite partnership", body: "Hi, about MailerLite.",
    status: "dismissed", reviewed_by: "Gaby", reviewed_at: ts(-7, "11:00:00") });
  sugg(byId(groups["eivyda-new"][1]), "candidate", d(-1), { k: "1", client: "Melograno", name: "Cyril Banks", title: "Editor", source: "Apollo" });

  const runs = [
    { n: 1, name: "discovery", started_at: ts(-7, "04:52:00"), finished_at: ts(-7, "05:10:00"), status: "ok", summary: JSON.stringify({ found: 24 }) },
    { n: 2, name: "daily", started_at: ts(-2, "05:47:00"), finished_at: ts(-2, "06:02:00"), status: "error",
      summary: JSON.stringify({ edits_applied: 3, conflicts: 0, replies: 1, bounces: 0, candidates: 0, emails: 0, slack_asks: 0, error: "Sheet quota" }) },
    { n: 3, name: "daily", started_at: ts(-1, "05:47:00"), finished_at: ts(-1, "06:05:00"), status: "ok",
      summary: JSON.stringify({ edits_applied: 14, conflicts: 1, replies: 2, bounces: 1, candidates: 6, emails: 4, slack_asks: 3 }) },
  ];

  // ---------- checks, counts, groups, intended Today ----------
  if (partners.length !== 600) throw new Error("fixture: expected 600 sites, built " + partners.length);
  if (contacts.length !== C_TOTAL) throw new Error("fixture: expected 2000 contacts, built " + contacts.length);
  const ids = new Set(partners.map((p) => p.id));
  if (ids.size !== partners.length) throw new Error("fixture: duplicate site id");
  if (new Set(contacts.map((c) => c.id)).size !== contacts.length) throw new Error("fixture: duplicate contact id");
  for (const p of partners) if (p.domain && !/(^|\.)example\.test$/.test(p.domain) && !p.domain.startsWith("youtube.com/@pgfixture")) {
    throw new Error("fixture: domain outside example.test: " + p.domain);
  }
  for (const c of contacts) if (c.email && !c.email.split(/\s*[;,]\s*/).every((e) => /@([a-z0-9-]+\.)*example\.test$/.test(e))) {
    throw new Error("fixture: email outside example.test: " + c.email);
  }

  const counts = countAll({ partners, contacts, activity, edits, suggestions, kv_meta, runs });
  for (const k of Object.keys(groups)) groups[k] = groups[k].slice();
  const ofTag = (t) => groups[t][0];
  const intended = {
    Kamile: {
      doNow: {
        overdue: ["K-od3", "K-od1", "K-od2"].map(ofTag),
        reply: ["K-due2", "K-rep-a", "K-rep-b"].map(ofTag),
        decision: ["K-neg-decision"].map(ofTag),
        due: ["K-due1"].map(ofTag),
        quiet: ["K-act-quiet", "K-neg-waiting"].map(ofTag),
        noreply: { count: 10, candidates: groups["kamile-contacted-20d"].length + groups["kamile-contacted-nodate"].length,
          dated: groups["kamile-contacted-20d"].slice(), undated: groups["kamile-contacted-nodate"].slice() },
      },
      doNowCount: 3 + 3 + 1 + 1 + 2 + 10,
      noDateChip: ["K-rep-a", "K-rep-b", "K-neg-decision"].map(ofTag),
      notInDoNow: ["K-rep-handled", "K-rep-handled2", "K-rep-stale", "K-fut1", "K-fut2", "K-neg-snoozed", "K-act-live"].map(ofTag),
      newProspects: { count: 30, withSuggestions: groups["kamile-new-sugg"].slice(), newIds: ["NEW-0002", "NEW-0001"], shows: 7 },
      comingUp: ["K-fut2", "K-fut1", "K-neg-snoozed"].map(ofTag),
    },
    Jonas: {
      doNow: {
        overdue: ["J-od"].map(ofTag),
        reply: groups["jonas-replied-email"].slice(),
        decision: ["J-neg-marker", "J-neg-3", "J-neg-2", "J-neg-1"].map(ofTag),
        due: [],
        quiet: ["J-neg-wait-2"].map(ofTag),
        noreply: { count: 5, candidates: 5, dated: groups["jonas-noreply"].slice(), undated: [] },
      },
      doNowCount: 1 + 6 + 4 + 0 + 1 + 5,
      notInDoNow: groups["jonas-replied-old"].slice(),
      newProspects: { count: 5, newIds: ["NEW-0004"], platformsHidden: groups["jonas-new"].filter((id) => groups.platform.includes(id)) },
    },
  };
  return { version: FIXTURE_VERSION, today, partners, contacts, activity, edits, client_programs, kv_meta, suggestions, runs,
    groups, counts, intended, refs: { handledActivityN: handled.n } };
}

function canonicalForActivity(token) {
  // The old UI sends the record's first client token as typed; the fixture does the same.
  return token;
}

function tally(rows, key) {
  const out = {};
  for (const r of rows) { const k = r[key] == null || r[key] === "" ? "(none)" : r[key]; out[k] = (out[k] || 0) + 1; }
  return out;
}

function countAll({ partners, contacts, activity, edits, suggestions, kv_meta, runs }) {
  const ownerStage = {};
  for (const p of partners) {
    const o = p.owner || "(none)";
    (ownerStage[o] ||= {})[p.stage] = (ownerStage[o][p.stage] || 0) + 1;
  }
  const maxApplied = Math.max(...edits.filter((e) => e.applied === 1).map((e) => e.n));
  return {
    partners: partners.length,
    pg_ids: partners.filter((p) => p.id.startsWith("PG-")).length,
    new_ids: partners.filter((p) => p.id.startsWith("NEW-")).length,
    max_pg_id: partners.filter((p) => p.id.startsWith("PG-")).map((p) => p.id).sort().pop(),
    by_stage: tally(partners, "stage"),
    by_owner: tally(partners, "owner"),
    owner_stage: ownerStage,
    by_clients: tally(partners, "clients"),
    nameless: partners.filter((p) => !p.name && !p.domain).length,
    contacts: contacts.length,
    contacts_with_email: contacts.filter((c) => c.email).length,
    activity: activity.length,
    edits: edits.length,
    edits_pending: edits.filter((e) => e.applied === 0).length,
    edits_applied: edits.filter((e) => e.applied === 1).length,
    edits_by_kind: tally(edits, "kind"),
    edits_max_applied_n: maxApplied,
    edits_conflicts: edits.filter((e) => e.applied === 0 && e.n < maxApplied).map((e) => e.n),
    suggestions: suggestions.length,
    suggestions_open: suggestions.filter((s) => s.status === "open").length,
    suggestions_by_kind: tally(suggestions, "kind"),
    kv_meta: kv_meta.length,
    runs: runs.length,
  };
}

// ---------- SQL ----------

function lit(v) {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "number") { if (!Number.isFinite(v)) throw new Error("fixture: bad number"); return String(v); }
  if (typeof v === "boolean") return v ? "1" : "0";
  return "'" + String(v).replace(/'/g, "''") + "'";
}

function inserts(table, rows, { chunk = 40, verb = "INSERT INTO" } = {}) {
  const cols = COLUMNS[table];
  const out = [];
  for (let i = 0; i < rows.length; i += chunk) {
    const part = rows.slice(i, i + chunk).map((r) => "(" + cols.map((c) => lit(r[c])).join(", ") + ")");
    out.push(verb + " " + table + " (" + cols.join(", ") + ") VALUES\n" + part.join(",\n") + ";");
  }
  return out.join("\n");
}

/**
 * The seed SQL for one fixture. Base tables always; kv_meta, suggestions and runs only when listed in `tables`.
 * @param {ReturnType<typeof buildFixture>} fx
 * @param {{tables?: string[], base?: boolean}} [opts] tables: the optional tables that exist in the target database;
 *   base: false leaves out the base tables (to add the optional rows after a late 003/004)
 */
export function seedSql(fx, { tables = [], base = true } = {}) {
  const has = (t) => tables.includes(t);
  const parts = ["-- Synthetic test fixture (tests/fixtures/make-seed.mjs v" + FIXTURE_VERSION + ", today " + fx.today + "). Test databases only."];
  if (base) {
    parts.push(
      inserts("partners", fx.partners),
      inserts("contacts", fx.contacts, { chunk: 60 }),
      inserts("activity", fx.activity),
      inserts("edits", fx.edits),
      inserts("client_programs", fx.client_programs, { verb: "INSERT OR REPLACE INTO" }));
  }
  if (has("kv_meta")) parts.push("-- 003 tables", inserts("kv_meta", fx.kv_meta, { verb: "INSERT OR REPLACE INTO" }));
  if (has("suggestions")) parts.push("-- 004 tables", inserts("suggestions", fx.suggestions));
  if (has("runs")) parts.push(inserts("runs", fx.runs));
  return parts.join("\n") + "\n";
}

/** Seed SQL for `today` (G0 signature, kept). */
export function makeSeed({ today, tables } = {}) {
  return seedSql(buildFixture({ today }), { tables });
}

// ---------- CLI ----------

function cli(argv) {
  const arg = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
  const today = arg("--today");
  const fx = buildFixture({ today });
  if (argv.includes("--counts")) {
    process.stdout.write(JSON.stringify({ today: fx.today, counts: fx.counts, intended: fx.intended, groups: fx.groups }, null, 1) + "\n");
    return;
  }
  const tables = argv.includes("--all") ? OPTIONAL_TABLES : (arg("--tables") || "").split(",").map((s) => s.trim()).filter(Boolean);
  for (const t of tables) if (!OPTIONAL_TABLES.includes(t)) throw new Error("make-seed: unknown optional table " + t);
  process.stdout.write(seedSql(fx, { tables }));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) cli(process.argv.slice(2));
