# NEEDS (G1-D)

Changes G1-D needs in files it does not own. G3-1 merges these (spec 5.5).

1. **`functions/api/clients/[k].js` (unowned, "[unchanged]" in 5.2): decode the key.**
   On `d5e91d9` (wrangler 4.40 local), `PUT /api/clients/botanical%20synthesis` returns 400 "Unknown client.".
   The route gets the raw `botanical%20synthesis` in `params.k`, and the old page sends `encodeURIComponent(k)`.
   So no program with a space in its key can be saved today, and T23 ("`field = 'botanical synthesis'`") cannot
   pass without a fix. Suggested one-line change: `const k = text(decodeURIComponent(String(params.k || "")), 40).toLowerCase();`
   (wrapped in try/catch for a malformed `%`). The row it must then write is `tests/e2e/golden/client-program.json#partial`
   with `field` = `"botanical synthesis"`. The golden file records the d5e91d9 400 as `key-with-space-d5e91d9-bug`.

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
