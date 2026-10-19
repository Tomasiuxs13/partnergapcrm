// Site constants from GET /api/meta (spec 5.4, 6.3.1). G0 stub; owner G1-A.
// load() waits for the boot fetch started in index.html and keeps the empty defaults below.
// Helpers take meta explicitly so rule modules stay pure.

function defaults() {
  return {
    v: 2,
    build: "",
    read_only: false,
    stages: [],
    deal_models: [],
    activity_types: [],
    affiliate_types: [],
    team: [],
    admins: [],
    clients: [],
    past_clients: [],
    sla: {},
    follow_up_days: {},
    reply_window: { email: 30, touch: 7 },
    noreply_cap: 10,
    lost_reasons: [],
    platform_domains: [],
    platform_dr: 90,
    schedule: [],
    timezone: "Europe/Vilnius",
    prod_host: "partnergap-crm.pages.dev",
    sheet_url: "",
    test_mode: true,
    limits: { plan: "free", bulk_ids: 90, bulk_rows: 20 },
    features: { settings: false, suggestions: false, runs: false, dnc: false },
    freshness: null,
  };
}

let current = null;

export async function load() {
  const boot = typeof window !== "undefined" && window.__boot ? window.__boot.meta : null;
  if (boot) await Promise.resolve(boot).catch(() => null);
  current = defaults();
}

export function get() {
  if (!current) current = defaults();
  return current;
}

export function stage(meta, name) {
  const list = (meta && meta.stages) || [];
  return list.find((s) => s.name === name) || null;
}

export function client(meta, keyOrRaw) { return null; }

export function splitClients(meta, raw) { return []; }

export function isPlatform(meta, domain, dr) { return false; }
