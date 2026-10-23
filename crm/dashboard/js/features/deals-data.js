// Every deal (GET /api/deals) for the pages that only read them: Partners and the client pages'
// suggested partners. One request is shared and kept for a minute; a deal saved anywhere on the site
// ("deals:changed") drops it. Resolves to the deals list, or null before migration 006, in the snapshot,
// or when the request fails (the pages then use the sites' own stages). No side effects at import time.
import { api } from "../core/api.js";
import * as bus from "../core/bus.js";

const TTL = 60000;
let cached = null; // {at, list}
let inflight = null;
let listening = false;

function listen() {
  if (listening) return;
  listening = true;
  bus.on("deals:changed", () => {
    cached = null;
  });
}

export function loadDeals({ force = false } = {}) {
  listen();
  if (!force && cached && Date.now() - cached.at < TTL) return Promise.resolve(cached.list);
  if (!force && inflight) return inflight;
  const p = Promise.resolve()
    .then(() => api.deals())
    .then((r) => {
      const list = r && Array.isArray(r.deals) ? r.deals : null;
      cached = { at: Date.now(), list };
      return list;
    }, () => null) // a failed request is asked again next time
    .then((list) => {
      if (inflight === p) inflight = null;
      return list;
    });
  inflight = p;
  return p;
}

/** The deals from the last answer, without asking again (undefined before the first one). */
export function cachedDeals() {
  return cached ? cached.list : undefined;
}
