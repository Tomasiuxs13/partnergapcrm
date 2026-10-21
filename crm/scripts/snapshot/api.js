// Snapshot stand-in for crm/dashboard/js/core/api.js (spec 4.14). Owner G3-6.
// build_snapshot.mjs swaps it in at bundle time; the live site never loads it. Same exports as core/api.js.
// It never calls fetch: the site list (and, when the snapshot was built with them, client programs and
// team activity) comes from window.__SNAPSHOT__; every other GET resolves to null, which the pages show as
// "Open the live site to see this" or "Not available yet"; every write rejects with the read-only text.
// No side effects at import time.

export class ApiError extends Error {
  constructor(status, friendly = "", data = null) {
    super(friendly || "Request failed (" + status + ")");
    this.name = "ApiError";
    this.status = status;
    this.data = data;
    this.friendly = friendly;
  }
}

const config = { readOnly: true, prodHost: "partnergap-crm.pages.dev", limits: { bulk_ids: 90, bulk_rows: 20 } };

// meta.js calls this after load(). The snapshot stays read-only whatever it is told.
export function configure(patch = {}) {
  if (patch.prodHost) config.prodHost = patch.prodHost;
  if (patch.limits) config.limits = Object.assign({}, config.limits, patch.limits);
}

export const TEXT = {
  offline: "No connection. Your changes are kept.",
  timeout: "The server took too long to answer. Your changes are kept. Try again.",
  server: "The server couldn't save this. Try again in a moment.",
  signin: "Please sign in again.",
};

export function readOnlyText() {
  return "Read-only copy. Open " + config.prodHost + " to edit.";
}

export function pendingWrites() {
  return 0;
}

export function loginUrl() {
  return "#";
}

// Nobody signs in to a snapshot.
export function unauthorized() {}

function snap() {
  return (typeof window !== "undefined" && window.__SNAPSHOT__) || {};
}

function denied() {
  return Promise.reject(new ApiError(403, readOnlyText(), { readOnly: true }));
}

// The boot fetches of index.html aren't in the snapshot; these keep the core/api.js signatures.
export async function readResponse() {
  return null;
}

export async function readPartners() {
  return null;
}

export async function request(method) {
  const m = String(method || "GET").toUpperCase();
  if (m !== "GET" && m !== "HEAD") return denied();
  return null;
}

function listBody() {
  const s = snap();
  return { v: 2, cols: Array.isArray(s.cols) ? s.cols : [], rows: Array.isArray(s.rows) ? s.rows : [] };
}

const copy = (v) => (v == null ? null : JSON.parse(JSON.stringify(v)));

export const api = {
  async meta() {
    return copy(snap().meta);
  },
  async partners() {
    const data = listBody();
    return { status: 200, data, etag: null, generatedAt: snap().builtAt || null };
  },
  async partnersByIds(ids) {
    const want = new Set((ids || []).map(String));
    const body = listBody();
    const at = body.cols.indexOf("id");
    return { v: 2, cols: body.cols, rows: body.rows.filter((r) => want.has(String(Array.isArray(r) ? r[at] : r && r.id))) };
  },
  partner: () => request("GET"),
  about: () => request("GET"),
  aboutDomain: () => request("GET"),
  update: () => denied(),
  outcome: () => denied(),
  logActivity: () => denied(),
  addContact: () => denied(),
  addSite: () => denied(),
  bulk: () => denied(),
  bulkRows: () => denied(),
  edits: () => request("GET"),
  async teamActivity() {
    return copy(snap().activity);
  },
  contactsIndex: () => request("GET"),
  async programs() {
    return copy(snap().programs);
  },
  saveProgram: () => denied(),
  settings: () => request("GET"),
  saveSettings: () => denied(),
  suggestions: () => request("GET"),
  setSuggestion: () => denied(),
  runs: () => request("GET"),
  deals: () => request("GET"),
  createDeal: () => denied(),
  updateDeal: () => denied(),
  addFile: () => denied(),
};
