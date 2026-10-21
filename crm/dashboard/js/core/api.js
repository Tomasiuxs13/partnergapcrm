// The only module that calls fetch (spec 5.1, 5.4, 6.3.15, 4.11). Owner G1-A.
// request() returns null when the response is not JSON or the body has unavailable:true (a feature
// that isn't deployed yet), resolves a 409 to {conflict: true, ...data}, sends a 401 to sign-in with
// the hash kept, and turns every other failure into an ApiError with a plain `friendly` message.
// No side effects at import time.
import * as me from "./me.js";
import * as bus from "./bus.js";

export class ApiError extends Error {
  constructor(status, friendly = "", data = null) {
    super(friendly || "Request failed (" + status + ")");
    this.name = "ApiError";
    this.status = status;
    this.data = data;
    this.friendly = friendly;
  }
}

// Set by meta.load(); api.js never imports meta.js (meta.js imports this module).
const config = { readOnly: false, prodHost: "partnergap-crm.pages.dev", limits: { bulk_ids: 90, bulk_rows: 20 } };

export function configure(patch = {}) {
  if ("readOnly" in patch) config.readOnly = !!patch.readOnly;
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

// Number of writes in flight; the footer shows "Saving…" while it is above 0 (bus "api:writes").
let writes = 0;
export function pendingWrites() {
  return writes;
}

// /login?next=/?h=<encoded hash> (spec 4.11, 6.3.14): the hash survives sign-in.
export function loginUrl(hash) {
  const h = hash == null ? (typeof location !== "undefined" ? location.hash : "") : hash;
  const next = h && h !== "#" ? "/?h=" + encodeURIComponent(h) : "/";
  return "/login?next=" + encodeURIComponent(next);
}

let leaving = false;
// Lets the record panel save its draft (bus "unauthorized"), then goes to sign-in once.
export function unauthorized() {
  if (leaving || typeof location === "undefined") return;
  leaving = true;
  bus.emit("unauthorized", { hash: location.hash });
  location.assign(loginUrl());
}

const isJson = (res) => /\bjson\b/i.test((res.headers && res.headers.get("content-type")) || "");

function friendly(status, msg) {
  if (status >= 500) return TEXT.server;
  if (msg) return msg;
  if (status === 403) return "This change was blocked. Reload the page and try again.";
  if (status === 404) return "Not found";
  if (status === 413) return "That is too much to save at once.";
  if (status === 429) return "Too many changes at once. Try again in a moment.";
  return "Something went wrong (" + status + "). Try again.";
}

// Turns a Response (or a promise of one, such as the boot fetch) into data, following the rules above.
export async function readResponse(resOrPromise) {
  let res;
  try {
    res = await resOrPromise;
  } catch (e) {
    throw new ApiError(0, TEXT.offline, { offline: true });
  }
  if (!res) return null;
  if (res.status === 401) {
    unauthorized();
    throw new ApiError(401, TEXT.signin);
  }
  const json = isJson(res);
  let data = null;
  if (json) {
    try { data = await res.json(); } catch (e) { data = null; }
  }
  if (res.status === 409) return Object.assign({ conflict: true }, data && typeof data === "object" ? data : {});
  if (json && data && data.unavailable === true) return null;
  if (res.ok) return json ? data : null;
  if (!json && res.status === 404) return null;
  const msg = data && typeof data.error === "string" ? data.error : "";
  throw new ApiError(res.status, friendly(res.status, msg), data);
}

export async function request(method, url, body, { timeout = 15000, signal, headers } = {}) {
  const m = String(method || "GET").toUpperCase();
  const write = m !== "GET" && m !== "HEAD";
  if (write && config.readOnly) throw new ApiError(403, readOnlyText(), { readOnly: true });
  const init = { method: m, credentials: "same-origin", headers: Object.assign({ Accept: "application/json" }, headers || {}) };
  if (write) {
    const by = me.get() || (await me.ensure()) || undefined;
    const payload = Object.assign({}, body && typeof body === "object" ? body : {});
    if (payload.by == null && by) payload.by = by;
    init.headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(payload);
  }
  const ctrl = new AbortController();
  let timedOut = false;
  const timer = timeout > 0 ? setTimeout(() => { timedOut = true; ctrl.abort(); }, timeout) : null;
  const onAbort = () => ctrl.abort();
  if (signal) {
    if (signal.aborted) ctrl.abort();
    else signal.addEventListener("abort", onAbort, { once: true });
  }
  init.signal = ctrl.signal;
  if (write) bus.emit("api:writes", ++writes);
  try {
    let res;
    try {
      res = await fetch(url, init);
    } catch (e) {
      if (timedOut) throw new ApiError(0, TEXT.timeout, { timeout: true });
      if (signal && signal.aborted) throw e;
      throw new ApiError(0, TEXT.offline, { offline: true });
    }
    return await readResponse(res);
  } finally {
    if (timer) clearTimeout(timer);
    if (signal) signal.removeEventListener("abort", onAbort);
    if (write) bus.emit("api:writes", --writes);
  }
}

// GET /api/partners?v=2 with an optional ETag. Resolves to {status: 304}, or
// {status: 200, data, etag, generatedAt} (data is {v:2, cols, rows} or, before G1-B, the v1 array),
// or null when the list endpoint answers with something that isn't JSON.
export async function readPartners(resOrPromise) {
  let res;
  try {
    res = await resOrPromise;
  } catch (e) {
    throw new ApiError(0, TEXT.offline, { offline: true });
  }
  if (!res) return null;
  if (res.status === 401) {
    unauthorized();
    throw new ApiError(401, TEXT.signin);
  }
  if (res.status === 304) return { status: 304 };
  if (res.ok && isJson(res)) {
    // Keep the text: the store caches exactly what the server sent.
    let text, data;
    try {
      text = await res.text();
      data = JSON.parse(text);
    } catch (e) {
      throw new ApiError(0, TEXT.offline, { offline: true });
    }
    if (data && data.unavailable === true) return null;
    return { status: res.status, data, text, etag: res.headers.get("ETag"), generatedAt: res.headers.get("X-Generated-At") };
  }
  const data = await readResponse(res);
  if (data == null) return null;
  return { status: res.status, data, etag: res.headers.get("ETag"), generatedAt: res.headers.get("X-Generated-At") };
}

function qs(params) {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params || {})) if (v != null && v !== "") q.set(k, String(v));
  const s = q.toString();
  return s ? "?" + s : "";
}

const enc = encodeURIComponent;

function chunks(list, size) {
  const out = [];
  const n = Math.max(1, Number(size) || 1);
  for (let i = 0; i < list.length; i += n) out.push(list.slice(i, i + n));
  return out;
}

// Runs bulk chunks one after another and merges the responses (spec 6.3.4 response shape).
async function bulkChunks(parts, send, onProgress, countOf) {
  if (config.readOnly) throw new ApiError(403, readOnlyText(), { readOnly: true });
  const out = { ok: true, changed: 0, changed_ids: [], before: {}, v2: {}, failed: [] };
  const total = parts.reduce((n, p) => n + countOf(p), 0);
  let done = 0;
  for (const part of parts) {
    try {
      const r = await send(part);
      if (r == null) {
        out.failed.push({ ids: part.map((x) => (typeof x === "string" ? x : x.id)), error: "Not available yet" });
      } else {
        out.changed += Number(r.changed) || 0;
        if (Array.isArray(r.changed_ids)) out.changed_ids.push(...r.changed_ids);
        Object.assign(out.before, r.before || {});
        Object.assign(out.v2, r.v2 || {});
        if (Array.isArray(r.failed)) out.failed.push(...r.failed);
      }
    } catch (e) {
      if (e && e.status === 401) throw e;
      out.failed.push({ ids: part.map((x) => (typeof x === "string" ? x : x.id)), error: (e && (e.friendly || e.message)) || "Failed" });
    }
    done += countOf(part);
    if (onProgress) onProgress({ done, total });
  }
  out.ok = out.failed.length === 0;
  return out;
}

export const api = {
  meta() {
    return request("GET", "/api/meta");
  },
  partners({ etag } = {}) {
    const headers = { Accept: "application/json" };
    if (etag) headers["If-None-Match"] = etag;
    return readPartners(fetch("/api/partners?v=2", { credentials: "same-origin", headers }));
  },
  // Up to 90 ids per request; larger lists are split and the rows merged ({v:2, cols, rows}).
  async partnersByIds(ids) {
    const list = Array.from(new Set((ids || []).filter(Boolean)));
    if (!list.length) return { v: 2, cols: [], rows: [] };
    let cols = null;
    const rows = [];
    for (const part of chunks(list, 90)) {
      const r = await request("GET", "/api/partners?v=2&ids=" + part.map(enc).join(","));
      if (!r || !Array.isArray(r.rows)) return null;
      cols = cols || r.cols;
      rows.push(...r.rows);
    }
    return { v: 2, cols: cols || [], rows };
  },
  partner(id) {
    return request("GET", "/api/partner/" + enc(id));
  },
  about(id) {
    return request("GET", "/api/partner/" + enc(id) + "/about");
  },
  aboutDomain(domain) {
    return request("GET", "/api/about" + qs({ domain }));
  },
  update(id, fields) {
    return request("PATCH", "/api/partner/" + enc(id), { fields });
  },
  outcome(id, { fields, activity } = {}) {
    const body = {};
    if (fields && Object.keys(fields).length) body.fields = fields;
    if (activity) body.activity = activity;
    return request("POST", "/api/partner/" + enc(id) + "/outcome", body);
  },
  logActivity(id, { type, summary, contact_id, client } = {}) {
    return request("POST", "/api/partner/" + enc(id) + "/activity", { type, summary, contact_id, client });
  },
  addContact(id, contact, { force } = {}) {
    return request("POST", "/api/partner/" + enc(id) + "/contacts", Object.assign({}, contact, force ? { force: true } : {}));
  },
  addSite(site, { force } = {}) {
    return request("POST", "/api/partners", Object.assign({}, site, force ? { force: true } : {}));
  },
  // ids mode, chunked by meta.limits.bulk_ids (90 on Free). onProgress({done, total}).
  bulk(ids, fields, { onlyIfEmpty, onProgress } = {}) {
    const list = Array.from(new Set((ids || []).filter(Boolean)));
    const extra = onlyIfEmpty && onlyIfEmpty.length ? { only_if_empty: onlyIfEmpty } : {};
    return bulkChunks(chunks(list, config.limits.bulk_ids || 90),
      (part) => request("POST", "/api/bulk", Object.assign({ ids: part, fields }, extra)), onProgress, (p) => p.length);
  },
  // rows mode (Undo), chunked by meta.limits.bulk_rows (20 on Free). rows = [{id, fields}].
  bulkRows(rows, { onProgress } = {}) {
    return bulkChunks(chunks(rows || [], config.limits.bulk_rows || 20),
      (part) => request("POST", "/api/bulk", { rows: part }), onProgress, (p) => p.length);
  },
  edits({ before, limit, by, state, account } = {}) {
    return request("GET", "/api/edits" + qs({ before, limit, by, state, account }));
  },
  teamActivity({ days } = {}) {
    return request("GET", "/api/team-activity" + qs({ days }));
  },
  contactsIndex() {
    return request("GET", "/api/contacts-index");
  },
  programs() {
    return request("GET", "/api/clients");
  },
  saveProgram(k, program) {
    return request("PUT", "/api/clients/" + enc(k), program);
  },
  settings() {
    return request("GET", "/api/settings");
  },
  saveSettings(patch) {
    return request("PUT", "/api/settings", patch);
  },
  suggestions({ account, owner, status } = {}) {
    return request("GET", "/api/suggestions" + qs({ account, owner, status }));
  },
  setSuggestion(id, status) {
    return request("POST", "/api/suggestions/" + enc(id), { status });
  },
  runs({ limit } = {}) {
    return request("GET", "/api/runs" + qs({ limit }));
  },
};
