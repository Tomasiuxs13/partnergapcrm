# NEEDS (G1-D)

Changes G1-D needs in files it does not own. G3-1 merges these (spec 5.5).

1. **`functions/api/clients/[k].js` (unowned, "[unchanged]" in 5.2): decode the key.**
   On `d5e91d9` (wrangler 4.40 local), `PUT /api/clients/botanical%20synthesis` returns 400 "Unknown client.".
   The route gets the raw `botanical%20synthesis` in `params.k`, and the old page sends `encodeURIComponent(k)`.
   So no program with a space in its key can be saved today, and T23 ("`field = 'botanical synthesis'`") cannot
   pass without a fix. Suggested one-line change: `const k = text(decodeURIComponent(String(params.k || "")), 40).toLowerCase();`
   (wrapped in try/catch for a malformed `%`). The row it must then write is `tests/e2e/golden/client-program.json#partial`
   with `field` = `"botanical synthesis"`. The golden file records the d5e91d9 400 as `key-with-space-d5e91d9-bug`.

# NEEDS (G1-B)

Changes G1-B needs in files it does not own. The lib helpers they call are on crm-easy-site-g1-b.

1. **`functions/api/partner/[id].js` (B1): PATCH response carries `v2`** (G1-B acceptance 5).
   Import `v2Row` from `lib/crm.js` and return `{ ok, changed, partner, v2: await v2Row(db, partner) }`.
   (`updatePartner` already reads the allow_dnc switch itself when a stage of "Do not contact" is asked for,
   so PATCH needs no other change; the edits rows stay the same.)
2. **`functions/api/bulk.js` (B1): allow_dnc and `v2`.** Read the switch once with `lib/settings.js#allowDnc(db)`
   (only when a stage of "Do not contact" is asked for) and pass `{ allowDnc }` to `updatePartner`/`updateStatements`
   (without it each site's call reads the switch again; the result is the same), and add `v2: await v2Rows(db, ids)` (sorted by id, 90 ids per query) to the response.
3. **`functions/_middleware.js` (B1):** set `ctx.data.readOnly` (reuse `lib/meta.js#isReadOnlyHost(env, host)`);
   `/api/meta` and the freshness check already read it when present. The sign-in team list can come from
   `baseMeta().team` merged with `readOverrides(db)` via `mergeTeam`. `PUT /api/settings` can use
   `lib/settings.js#saveSettings(db, patch, by, at)` (writes kv_meta + settings_log, never `edits`).
4. **`tests/e2e/00-smoke.test.mjs` (G1-D / G3-1):** `/api/meta` now exists; empty `ALLOWED_404`.
5. **Front end (G1-A / G3-1): remove the "TEMP until G1-B" fallbacks** (`js/core/meta.js` fallback(),
   `js/core/store.js` v1 mapping/legacyRows, `model.fromV1Row` if nothing else uses it). `/api/partners?v=2`
   now returns real v2 with a weak ETag (body up to 1 MB on Free, any size with `WORKERS_PLAN=paid`).
   G1-A's scratch shell check (store test, step 5) asserts the old v1 fallback and now fails as expected.
6. **Release (G3-1):** `lib/meta.js` `BUILD` ("dev") must change together with `window.BUILD` in `index.html`.
