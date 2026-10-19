// GET /api/meta (spec 6.3.1): the constants of lib/meta.js merged with the kv_meta overrides (team,
// clients), plus features, build, read_only, limits and freshness. The page loads it at boot.
//   features   settings (kv_meta exists), suggestions and runs (their tables exist), dnc (allow_dnc = "1")
//   read_only  the middleware's ctx.data.readOnly, else the same host rule (lib/meta.js#isReadOnlyHost)
//   freshness  lib/freshness.js; null before migration 003. Its sheet_sig write never runs when read-only.
// Each optional part fails soft: the page still gets the constants.
import { json } from "../../lib/crm.js";
import { baseMeta, isReadOnlyHost, limitsFor } from "../../lib/meta.js";
import { hasTables } from "../../lib/tables.js";
import { readOverrides, applyOverrides } from "../../lib/settings.js";
import { freshness } from "../../lib/freshness.js";

export async function onRequestGet({ request, env, data }) {
  const db = env.PARTNERS_DB;
  const readOnly = data && typeof data.readOnly === "boolean" ? data.readOnly : isReadOnlyHost(env, new URL(request.url).hostname);
  const meta = baseMeta();
  meta.read_only = readOnly;
  meta.limits = limitsFor(env.WORKERS_PLAN);
  if (db) {
    let t = { kv_meta: false, suggestions: false, runs: false };
    try {
      t = await hasTables(db, ["kv_meta", "suggestions", "runs"]);
    } catch (e) {
      // keep every optional feature off
    }
    let overrides = {};
    if (t.kv_meta) {
      try {
        overrides = await readOverrides(db);
      } catch (e) {
        overrides = {};
      }
    }
    applyOverrides(meta, overrides);
    meta.features = { settings: !!t.kv_meta, suggestions: !!t.suggestions, runs: !!t.runs, dnc: !!overrides.allow_dnc };
    try {
      meta.freshness = await freshness(db, { readOnly, tables: t });
    } catch (e) {
      meta.freshness = null;
    }
  }
  return json(meta);
}
