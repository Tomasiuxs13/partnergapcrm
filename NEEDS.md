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

# NEEDS (G1-C)

Changes G1-C needs in files it does not own.

1. **`crm/dashboard/js/core/keys.js` (G1-A): don't count the toast region as an open layer.**
   `layerOpen()` returns true for any `:popover-open`, and `#toasts` is a manual popover that stays open
   for 6–8 s after every save. Until it closes, page-level Esc does nothing and J/K don't move the queue.
   This matters most in queue mode, where every save shows a toast. Suggested change:
   `document.querySelector(":popover-open:not(#toasts)")`.
   Workaround in place: the record panel handles Esc on its own element. J/K still wait for the toast to go.
2. **`crm/dashboard/js/app.js` (G1-A), optional: add the editors to `ctx.ui`.**
   `uiKit()` doesn't merge `ui/inline-edit.js` (`bindInlineEdits`, `rowActions`) or `ui/columns.js`
   (`COLUMNS`, `columns`, ...). Pages can import them directly, so this is only for consistency.
3. **Backend B1 (after G1-B): `POST /api/bulk` rows mode and v2 response (spec 6.3.4).**
   - `actions.bulk()` reads `changed_ids`, `before` and `v2` from the ids-mode response when they are
     present. Without them it falls back to the store's values.
   - Undo sends rows mode, `{rows: [{id, fields}]}` (≤ `limits.bulk_rows`). On d5e91d9 and on
     `crm-easy-site-g1-b` (4bc4a4e), that request returns 400 "Select at least one site.".
   - `tests/e2e/05-ui-kit.test.mjs` probes for rows mode and mocks it with `page.route` only when it is
     missing. It logs `# mocked: POST /api/bulk {rows}`.

# Status at the G1 checkpoint (tag g1-checkpoint)

Applied at the checkpoint (js/core/*, lib/meta.js and js/ui/columns.js are frozen from here on):
- G1-D 1: `functions/api/clients/[k].js` decodes the key (try/catch on a malformed `%`). `91-migrations` now
  replays `client-program#key-with-space-d5e91d9-bug` and expects `#partial`'s row with `field` = `"botanical synthesis"`.
- G1-B 1: PATCH `/api/partner/:id` returns `v2` (checked for every 200 PATCH case in `91-migrations` test 10).
- G1-B 4: `ALLOWED_404` in `00-smoke` is empty.
- G1-B 5: the "TEMP until G1-B" fallbacks are gone: `meta.js` `fallback()` (a failed `/api/meta` now gives the
  neutral shape), `store.js` v1 mapping and `status.legacyRows`, `model.fromV1Row`.
- G1-C 1: `keys.js` `layerOpen()` ignores `#toasts`.
- G1-C 2: `app.js` `ctx.ui` also holds `ui/inline-edit.js` and `ui/columns.js`.

Still open:
- G1-B 2 and G1-C 3 (B1, `functions/api/bulk.js`): the ids-mode rewrite with `changed_ids`, `before` and `v2`,
  rows mode, and `allow_dnc` read once per request. `05-ui-kit` mocks rows mode until it ships.
- G1-B 3 (B1, `functions/_middleware.js`): the read-only guard and `ctx.data.readOnly`, the sign-in team list
  from meta + kv overrides, and `PUT /api/settings` through `lib/settings.js#saveSettings`.
- G1-B 6 (G3-1, release): change `BUILD` in `lib/meta.js` together with `window.BUILD` in `index.html`.

# NEEDS (F1)

Changes the record panel (F1) needs in files it does not own. Each has a local workaround, so nothing blocks.

1. **`crm/dashboard/js/ui/dialog.js` (G1-C): `trapFocus()` counts controls inside a closed `<details>`.**
   Chrome keeps a box for the content of a closed `<details>` (content-visibility), so `focusables()` lists a
   button that cannot take focus as the last one, and Tab from the real last control leaves the trap for one
   press. Suggested filter: skip `el` when `el.closest("details:not([open])")` and `el` is not that details'
   own `summary`. Workaround in `css/record.css`: `.rc-details:not([open]) > :not(summary) { display: none; }`.
2. **`crm/dashboard/js/ui/actions.js` (G1-C): `note(id, text, {throw: true})`.** `update()` and `outcome()`
   can throw so a caller can show its own inline error; `note()` only returns null, so the panel says
   "Not saved. Check your connection and try again." without the real reason (timeout, 400 text).
3. **`crm/dashboard/js/ui/actions.js` (G1-C): let `runOutcome()` pass `quiet`/`throw` through to the
   outcome form.** The outcomes with a form (Not interested…, Not a fit…, Do not contact…, Counter-offer…,
   Signed…, Placement is live…, and Had a call without a note) use actions' own toasts and error toast. The panel words every other save itself (inline
   "Not saved. … Retry", no toast once the panel has moved to another site). With a pass-through the panel
   could treat all outcomes the same.
4. **`crm/dashboard/css/components.css` (G1-C): wrap `:hover` rules in `@media (hover: hover)`.** On touch
   screens a tapped `.ui-chipbtn` keeps its hover look and reads as picked. `record.css` resets it for the
   panel's own chips under `@media (hover: none)`.
5. **B1 (`functions/api/partner/[id].js` GET):** the panel reads `history.edits` (with `state`), `suggestions`
   (null before 004), `about` and `about_pending` exactly as 6.3.8 says, and shows "Not available yet." for a
   missing part. Suggestions come only from this response (the panel makes no separate
   `GET /api/suggestions?account=` call). The 409 of `POST …/contacts` may add `stage` to `duplicate`; the
   panel falls back to the store row's stage when the site is loaded.
