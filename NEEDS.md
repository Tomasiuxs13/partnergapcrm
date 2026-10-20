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

# Status after the F1 merge (crm-easy-site)

Applied at the F1 merge:
- F1 1: `js/ui/dialog.js` `focusables()` skips controls inside a closed `<details>` (a details' own `summary`
  stays focusable unless an outer details is closed). The `record.css` workaround stays; it is harmless.
- F1 2: `js/ui/actions.js` `note(id, text, {throw: true})` rethrows the error. The panel's Save note now uses
  it, so "Not saved. …" names the real reason (timeout, 400 text) and a 401 no longer shows an inline error.
- F1 3: `actions.outcomeForm()` (so `runOutcome()`) rejects with the error when `opts.throw` is set; `quiet`
  already reached `outcome()`. The panel still sends the outcomes with a form through actions' own form
  toasts (no `quiet`/`throw`), as F1 shipped it. Switching them to the panel's wording and inline
  "Not saved. … Retry" is open for the panel owner (F1, or G3-1 at integration).
- F1 4: every `:hover` rule in `css/components.css` sits in `@media (hover: hover)` at its old place (rules
  that also held `:focus-visible` or `[aria-expanded]` were split; the cascade order is unchanged).
  `record.css`'s `@media (hover: none)` chip reset is now redundant but harmless.

Still open:
- F1 5 (B1, `functions/api/partner/[id].js` GET and `POST …/contacts` 409): the profile shape the panel reads
  (6.3.8) and an optional `stage` in the 409 `duplicate`.
- G1-B 2, G1-C 3, G1-B 3 (B1) and G1-B 6 (G3-1) as listed above.

# NEEDS (B1)

Changes B1 needs in files it does not own.

1. **`lib/freshness.js` (G1-B): hide email addresses in `last_run.summary`.** `/api/meta` passes the latest
   `daily` runs row's summary on as it is. The daily run writes counts there today, but an `error` text such as
   "bounce from x@…" would put an address in `/api/meta` (spec 6.7: emails only in the profile and the contacts
   index). `/api/runs` already replaces addresses with "(email hidden)"; the same one-line replace before
   `parseSummary` would do (regex in `functions/api/runs.js`). `90-api-contract` uses a `discovery` run for its
   email probe until then.

Status of the B1 items above: G1-B 2 and G1-C 3 (`functions/api/bulk.js` ids mode with `changed_ids`, `before`
and `v2`, rows mode, `allow_dnc` read once) and G1-B 3 (`functions/_middleware.js` read-only guard,
`ctx.data.readOnly`, the sign-in team list, `PUT /api/settings` through `saveSettings`) are done on
crm-easy-site-b1. `05-ui-kit` no longer mocks rows mode.

# Status after the B1 merge (crm-easy-site)

Applied or closed at the B1 merge:
- G1-B 2 and G1-C 3 (`functions/api/bulk.js`), G1-B 3 (`functions/_middleware.js`, `PUT /api/settings`): done in B1
  (merged as is). `05-ui-kit` runs rows mode against the real endpoint.
- B1 1: `lib/freshness.js` hides email addresses in `last_run.summary` with the same replace as `GET /api/runs`.
  `90-api-contract`'s email scan now inserts a `daily` run and checks `/api/meta` `freshness.last_run` too.
- F1 5, profile part: `GET /api/partner/:id` returns `history.edits` (with `state`), `suggestions` (null before
  004, `to_email` kept), `about` from the cache only and `about_pending`, as the panel reads them.
- F1 5, `stage` in the 409 `duplicate` of `POST …/contacts`: not applied. Spec 6.3.10 keeps that response
  unchanged and `golden/add-contact.json#duplicate` fixes its body; the panel's fallback (the store row's stage)
  covers it. Closed unless the spec changes (owner then: B1's `contacts.js` plus the golden file, G1-D).

Still open:
- G1-B 6 (G3-1, release): change `BUILD` in `lib/meta.js` together with `window.BUILD` in `index.html`.
- F1 3 follow-up (record panel owner F1, or G3-1): send the outcomes with a form through `quiet`/`throw` so the
  panel words them like its other saves (see "Status after the F1 merge").

# NEEDS (F2)

Changes F2 (Today) needs in files it does not own. Today works without them.

1. **`js/shell/whats-new.js` (F8): the banner hook.** `pages/today.js` calls `whatsNewBanner(ctx, slot)` once per
   mount. `slot` is the empty `<div class="td-banner" data-td-banner>` between the header and the blocks (hidden by
   `today.css` while empty). F8 can either return markup (Today renders it into the slot when the slot is still
   empty) or render into `slot` itself and empty it on dismiss. A throw is caught and logged; Today still renders.
2. **Sites (F3): the links Today makes.** The capped no-reply note links to `#sites?tab=waiting&quiet=14` (the
   "No reply in 14+ days" chip of spec 2.2.2, owner filter left at its Me default); New prospects' "See all N in
   Sites" and the All clear line link to `#sites?tab=mine`. Please keep those params working.

# Status after the F2 merge (crm-easy-site)

No F2 item is addressed to a frozen file (`js/core/*`, `lib/meta.js`, `js/ui/columns.js`) or to a merged task's file,
so nothing was applied at the F2 merge. Today works without them.

Still open:
- F2 1 (F8, `js/shell/whats-new.js`): the Today banner hook `whatsNewBanner(ctx, slot)`. The G0 stub returns empty
  markup, so the slot stays hidden until F8 ships.
- F2 2 (F3, `js/pages/sites.js` and `js/rules/sites.js`): keep `#sites?tab=waiting&quiet=14` and `#sites?tab=mine`
  working (Today links to both). Sites is still the G0 stub at this merge.
- G1-B 6 (G3-1, release) and the F1 3 follow-up (panel owner) as listed after the B1 merge.

# NEEDS (F7)

Changes F7 (Search + Add site) needs in files it does not own. Search and Add site work without them.

1. **`js/app.js` (shell owner / G3-1): start the "Recently opened" list at boot.** `features/search.js` exports
   `start()`, which records every site the record panel opens (router `rec`) for the empty search. Today it starts
   only on the first `openSearch()` or `openAddSite()`, so sites opened before the first search are not listed.
   Suggested change: `import { openSearch, start as startSearch } from "./features/search.js";` and call
   `startSearch();` right after `router.start(PAGES, ...)` in `boot()`. It is idempotent and only reads the route.
2. **Pages that add a site for a context (F5 Clients, F3 Sites): use the prefill.** `openAddSite(prefill)` takes a
   website string, or `{ domain, name, clients, owner, type, stage, next_step, next_due, notes }` (`clients` as
   the stored text, such as `"Soro"` or `"Melograno - Amelia"`). For example a client page's "Add site" can call
   `openAddSite({ clients: "Soro" })`. `openSearch({ query })` opens Search with a query typed in.

# Status after the F7 merge (crm-easy-site)

Applied at the F7 merge:
- F7 1: `js/app.js` calls Search's `start()` right after `router.start(PAGES, ...)` in `boot()`, so the "Recently
  opened" list records sites opened before the first search. Changed from the suggested named import: app.js
  imports `* as search` and calls `search.start()` only when it exists (like `record.start`), because `start` is
  not in spec 5.4 and `00-smoke`'s shortcut test stubs `features/search.js` with `openSearch` alone; a named
  import of `start` failed to link there and the app never booted (smoke test 7 timed out). `70-search-add`'s
  recents test now opens a site by URL before its first search and expects it third.

Still open:
- F7 2 (F5 Clients, F3 Sites; optional): a page that adds a site for a context calls `openAddSite(prefill)`, for
  example a client page's "Add site" with `openAddSite({ clients: "Soro" })`. Neither page is merged yet.
- F2 1 (F8), F2 2 (F3), G1-B 6 (G3-1, release) and the F1 3 follow-up (panel owner) as listed after the F2 merge.

# NEEDS (F3)

Changes the Sites page (F3) needs in files it does not own. Each has a local workaround, so nothing blocks.

1. **`crm/dashboard/js/ui/list.js` (G1-C): sort text with one shared `Intl.Collator`.** `compareValues()` calls
   `String(a).localeCompare(b, "en", {numeric: true, sensitivity: "base"})`, which builds a collator per call:
   sorting 7,500 sites by name took about 350 ms (Chromium 141). A module-level
   `const COLLATOR = new Intl.Collator("en", {numeric: true, sensitivity: "base"})` and `COLLATOR.compare(a, b)`
   gives the same order in about 20 ms. Workaround in `pages/sites.js`: the Site, Owner and Clients columns sort
   by a numeric rank (one collator sort per column, cached until the store changes), and Last activity and
   Next step by a YYYYMMDD number. With the fix, those `col()` overrides can go.
2. **`crm/dashboard/js/features/record/log.js` (F1): honour `queue.primary`.** Spec 2.2.2: in the Waiting for
   reply queue (`quiet=14`, Start) the primary outcome is "Sent a follow-up". Sites opens the queue with
   `{queue: {ids, index, label: "No reply in 14+ days", primary: "followed_up"}}`; `features/record/queue.js`
   keeps `primary`, but the log box always makes the stage's first outcome primary ("They replied" for
   Contacted). Suggested: when `queue.primary` is one of the shown outcomes, move it first and give it
   `is-primary`. No workaround on the page (it cannot reach into the panel).

F2 2 is handled on this branch: `#sites?tab=waiting&quiet=14` and `#sites?tab=mine` open those views, and
`30-sites` covers both.

# Status after the F3 merge (crm-easy-site)

Applied at the F3 merge:
- F3 1: `js/ui/list.js` `compareValues()` compares text with one module-level
  `Intl.Collator("en", {numeric: true, sensitivity: "base"})` (same order as the old `localeCompare` call).
  The fast sort keys in `pages/sites.js` (`col()` overrides: numeric ranks for Site, Owner and Clients, YYYYMMDD for
  Last activity and Next step) are kept: they are still faster than any text compare and 30-sites' 7,500-row speed
  test was tuned with them. Removing them is optional clean-up for the Sites owner (F3).
- F3 2: `features/record/log.js` `outsHtml()` moves `queue.primary` first and marks it `is-primary` when it is one of
  the shown outcomes (in the Sites quiet queue "Sent a follow-up" now comes before "They replied"); otherwise the
  stage's order stays. `features/record/index.js` redraws the outcome buttons when `openRecord()` gives the open
  site a new queue. `30-sites` checks the primary button in its Start test.
- F2 2: done by F3 (`#sites?tab=waiting&quiet=14` and `#sites?tab=mine` work; `30-sites` covers both). F7's links
  `#sites?tab=all&q=<text>` and `#sites?tab=all&owner=<name|me>` work too.
- F7 2, Sites part: closed. Spec 2.2.2 gives Sites no in-context Add site (the top bar's "+ Add site" covers it).

Still open:
- F7 2 (F5 Clients; optional): a client page's "Add site" can call `openAddSite({ clients: "Soro" })`.
- F2 1 (F8, `js/shell/whats-new.js`): the Today banner hook `whatsNewBanner(ctx, slot)`.
- G1-B 6 (G3-1, release): change `BUILD` in `lib/meta.js` together with `window.BUILD` in `index.html`.
- F1 3 follow-up (record panel owner F1, or G3-1): send the outcomes with a form through `quiet`/`throw`.

# NEEDS (F4)

1. **`tests/e2e/00-smoke.test.mjs` (G1-D / G3-1), optional: point the title-fallback check at a page that does
   not announce.** Test 7 ("a page's own announcement replaces its title") ends with `#deals` and waits for the
   live region to read exactly "Deals", which held while Deals was a stub. Spec 4.13 wants the page's own
   announcement ("Sites, 36 sites"). Meanwhile Deals says "Deals" during mount (so the smoke check passes) and
   "54 deals" 700 ms later (also after each filter change). If the check moves to a page with no announcement
   of its own (for example `#history` while it is a stub, or a stubbed page like the Help one), Deals can say
   "Deals, 54 deals" once: in `js/pages/deals.js` `mount()`, drop `ctx.announce("Deals")` and announce
   `"Deals, " + text` at once on the first loaded draw.

# Status after the F4 merge (crm-easy-site)

Applied at the F4 merge:
- F4 1: `00-smoke` test 7 checks the title fallback on a stubbed Edit history page with no announcement of its own
  (stubbed in that test's context only, like Help), not on `#deals`. Deals now says "Deals, 54 deals" once (spec
  4.13): during mount when the rows are loaded, else "Deals" at mount and the count as soon as they load; a filter
  change still says "N deals" 700 ms later. `40-deals` T13 expects "Deals, N deals".

Still open:
- F7 2 (F5 Clients; optional): a client page's "Add site" can call `openAddSite({ clients: "Soro" })`.
- F2 1 (F8, `js/shell/whats-new.js`): the Today banner hook `whatsNewBanner(ctx, slot)`.
- G1-B 6 (G3-1, release): change `BUILD` in `lib/meta.js` together with `window.BUILD` in `index.html`.
- F1 3 follow-up (record panel owner F1, or G3-1): send the outcomes with a form through `quiet`/`throw`.

# NEEDS (F5)

Changes F5 (Clients, client page, report) needs in files it does not own. Nothing blocks; each has a workaround.

1. **`js/ui/dialog.js` (G1-C), optional: a footer slot in `openModal()`.** The report's warnings ("Check before you
   send") must sit right above the actions without scrolling (spec 2.2.4). `openModal()` has no place for markup in
   the footer, so `features/report.js` inserts its own `<div class="rp-warns" data-rp-warn data-noprint>` as the
   first child of `.ui-modal-foot` (and tags the head and foot `data-noprint`, the buttons `data-rp-copy` and
   `data-rp-print`). Suggested: `openModal({..., foot})`, markup rendered above the buttons.

F7 2, Clients part: done on this branch. The client page's "+ Add site for Soro" calls `openAddSite({ clients: "Soro" })`;
on Melograno (no product picked) it first asks "Which product?" and passes `"Melograno - Amelia"`. `50-clients` T8
covers it.

# Status after the F5 merge (crm-easy-site)

Applied at the F5 merge:
- F5 1: `js/ui/dialog.js` `openModal()` takes an optional `foot` (html``, or text shown as a `<p>`), rendered in
  `.ui-modal-foot` before the buttons; a modal with `foot` and no actions still gets the footer. `features/report.js`
  passes its `<div class="rp-warns" data-rp-warn data-noprint>` that way instead of inserting it after `openModal()`;
  the DOM is the same as before, so `clients.css` and `50-clients` are unchanged.
- F7 2, Clients part: done by F5 (the client page's "+ Add site for <client>" calls `openAddSite({ clients })`;
  Melograno asks "Which product?" first). F7 2 is closed (its Sites part was closed at the F3 merge).

Still open:
- F2 1 (F8, `js/shell/whats-new.js`): the Today banner hook `whatsNewBanner(ctx, slot)`.
- G1-B 6 (G3-1, release): change `BUILD` in `lib/meta.js` together with `window.BUILD` in `index.html`.
- F1 3 follow-up (record panel owner F1, or G3-1): send the outcomes with a form through `quiet`/`throw`.

# NEEDS (F6)

1. **`js/pages/sites.js` (F3): a `flag=<id>` filter on the All tab, so every Team overview number can open Sites.**
   Sites can't show some Team overview numbers exactly: Prospects of someone else (New and Researching), Replies
   waiting, Overdue now, Quiet deals now, Unanswered replies (3+ days), Deals going quiet, and the clean-up counts
   "Replied, last touch over 30 days", "No owner" (owner=none also lists closed sites), "Client name variants" and
   "Type not set" (type=none leaves out "Uncategorized"). Meanwhile those numbers open the Team overview's own list
   (`#team?show=<flag>&owner=<name|none>`, same columns, CSV and queue mode), and every count still matches
   (`tests/e2e/60-team.test.mjs`). Suggested change: on All, read `flag` and keep the rows where
   `FLAGS[flag].test(r, {meta, today})` from `js/rules/team.js` (read-only import, no circle: rules/team.js imports
   rules/sites.js, pages/sites.js imports both), shown as a removable chip "FLAGS[flag].label"; then set
   `SITES_FLAGS` in `js/rules/team.js` to the flags Sites reads and `target()` links there (`{tab: "all", flag,
   owner, big: "1"}`). `tests/unit/rules-team.test.mjs` already checks every target against `siteView` and
   accepts `flag` once it is in `SITES_FLAGS`; Sites' own view would need the same `flag` test.
2. **`js/ui/charts.js` (G1-C), optional: keyboard focus on the bars.** The visible bar labels are links with
   `tabindex="-1"`, and the hidden table's links take the Tab stops, so a keyboard user tabs onto links they can't
   see (no visible focus ring). Suggested change: keep the visible label links in the Tab order and give the
   hidden table's links `tabindex="-1"` (screen readers still read them as table cells).

# Status after the F6 merge (crm-easy-site)

Nothing was applied at the F6 merge; both F6 items stay open.
- F6 1 (owners F3 then F6): not small. It adds a new Sites filter with a removable chip (`js/pages/sites.js`, plus a
  `30-sites` check), then fills `SITES_FLAGS` in `js/rules/team.js`, which moves about a dozen Team overview links
  from `#team?show=` to Sites and changes what `60-team` and `rules-team.test.mjs` expect. Until then those numbers
  open the Team overview's own list, with matching counts (`60-team` T20).
- F6 2 (owner G1-C, `js/ui/charts.js`; or G3-3 with `95-mobile-a11y`): not applied as suggested. The visible bar
  list is `aria-hidden="true"`, so putting its links back in the Tab order makes focusable elements inside
  `aria-hidden` (axe `aria-hidden-focus`, serious) on the client page's stage bars and the Team overview's charts.
  A fix needs a different chart structure, for example a visible list that is not `aria-hidden` and a hidden table
  without links. Keyboard users can still reach every chart link through the hidden table.

Still open:
- F6 1 (F3, then F6) and F6 2 (G1-C or G3-3) as above.
- F2 1 (F8, `js/shell/whats-new.js`): the Today banner hook `whatsNewBanner(ctx, slot)`.
- G1-B 6 (G3-1, release): change `BUILD` in `lib/meta.js` together with `window.BUILD` in `index.html`.
- F1 3 follow-up (record panel owner F1, or G3-1): send the outcomes with a form through `quiet`/`throw`.

# NEEDS (F8)

Changes F8 (Edit history, Help, Settings, What's new) needs in files it does not own. Nothing blocks; each has a
workaround.

F2 1 is done on this branch: `js/shell/whats-new.js` `whatsNewBanner(ctx, slot)` renders "The CRM has a new layout.
[See what moved] ×" into Today's slot and returns null (Today leaves the slot alone). Opening What's new (from the
banner or Help) or × hides it for good in this browser (localStorage `pgcrm-dismiss-whatsnew` = "1"); not shown in
the snapshot. Styles: `css/pages/help.css` (`.hp-wn-*`).

1. **`js/ui/list.js` (G1-C), optional: a server-mode refresh that keeps the rows.** `refresh()` on a `fetchPage`
   list empties `state.fetched` and draws skeleton rows until every loaded page is fetched again, so each refresh
   flashes. Edit history works around it: after a save, a store load/refresh or a meta re-read it fetches the first
   page itself and calls `list.refresh()` only when that page differs from the rows shown. Suggested: keep the
   current rows (aria-busy on the table) until the new pages arrive, or expose `redraw()` for cells that read
   live data (site labels from the store).
2. **`functions/api/edits.js` (B1), optional: a `total` in GET /api/edits.** With filters there is no total, so
   the list can't say "N changes" until every page is loaded; Edit history says "Showing the newest 100 changes"
   while more pages remain and its own count line after that. `fetchPage` already passes `r.total` through when it
   is a number.

# Status after the F8 merge (crm-easy-site)

Applied or closed at the F8 merge:
- F2 1: done by F8 (`js/shell/whats-new.js` `whatsNewBanner(ctx, slot)` renders the banner into Today's slot and
  returns null). Closed.
- F8 1: `js/ui/list.js` `refresh()` on a `fetchPage` list with the same params (no `next.params`) keeps the shown
  rows, with `aria-busy="true"` on the list body, until the new pages arrive, then redraws once (spec 4.7: a refresh
  keeps page, scroll and focus). A refresh with new params, a sort click and "Try again" still start from an empty
  list; a failed keep-refresh empties the list and shows the error, as before. Edit history's own first-page check
  (it calls `list.refresh()` only when the first page changed) is kept; dropping it is optional clean-up for F8.

Fixed at the F8 merge (`tests/e2e/80-history-help.test.mjs`, F8's file):
- "A save made from Edit history's site panel ..." failed in the full run: it looked for PG-00452's fixture edit (n 30)
  on the unfiltered first page, but earlier files on the same server leave edits rows behind (30-sites about 380,
  05/10/20 about 80), so it was no longer among the newest 100. The test now opens `#history?account=PG-00452` and
  counts that site's edits. Its restore also read `next_due` with `rawNulls`, which wrote the string "null" back
  into a NULL `next_due`; it now reads without it.

Still open:
- F8 2 (B1, `functions/api/edits.js`, optional): not applied. Spec 6.3.6 fixes the paged response as
  `{pending, recent, next_before, max_applied_n}` and `90-api-contract` asserts exactly those keys; a `total` also
  needs a `COUNT(*)` over every matching `edits` row on each page request (spec 6.6 budgets Edit history at < 2k rows
  read per call). It needs a spec change first (owners B1 and `90-api-contract`). Edit history works without it
  ("Showing the newest 100 changes", then "N changes").
- F6 1 (F3, then F6) and F6 2 (G1-C or G3-3) as listed after the F6 merge.
- G1-B 6 (G3-1, release): change `BUILD` in `lib/meta.js` together with `window.BUILD` in `index.html`.
- F1 3 follow-up (record panel owner F1, or G3-1): send the outcomes with a form through `quiet`/`throw`.

# NEEDS (G3-6)

Snapshot builder (`crm/scripts/build_snapshot.mjs`, `crm/scripts/snapshot/`). Nothing here blocks the snapshot:
each item has a workaround in `crm/scripts/snapshot/snapshot.css` or the prelude. A snapshot is detected with
`window.__SNAPSHOT__` (set before any module runs) or `html[data-snapshot]`.

1. **`js/features/record/index.js` (F1, panel owner): no "Copy email" in a snapshot.** A snapshot holds no email,
   so `copyEmail()` can only fail, and it shows the error toast "Couldn't load the contacts. Try again." Suggested
   change: when `snapshotMode()`, leave "Copy email" out of the phone ⋯ menu (`moreMenu`) and out of
   `toolsHtml()`. Workaround: `snapshot.css` hides the header button (`[data-pact="copy-email"]`). The phone
   ⋯ menu item still shows, and menu items have no attribute that CSS could match.
2. **Export CSV (G1-C `js/ui/list.js` `[data-csv]`, F3 `js/pages/sites.js` `[data-si-csv]`, F4
   `js/pages/deals.js` `[data-dl-csv]`), optional: one shared marker.** A snapshot allows no downloads. Suggested
   change: give every download button a `data-download` attribute, so that one rule (`html[data-snapshot]
   [data-download]`) hides them all, including future ones. Workaround: `snapshot.css` hides the three selectors.
   The prelude also cancels any click on a `download`, `blob:` or `data:` link, so a new button would do nothing.
3. **`js/pages/team.js` (F6), optional: the morning run card in a snapshot.** It shows "Not available yet".
   `js/pages/clients.js` already says "Open the live site to see this." when `window.__SNAPSHOT__` is set.
   Suggested change: the same text there.

# Status after the G3-6 merge (crm-easy-site)

Applied at the G3-6 merge:
- G3-6 1 (F1): in a snapshot (`window.__SNAPSHOT__`) the record panel leaves "Copy email" out of the header tools
  (`header.js` `toolsHtml(r, {emailState, copyEmail})`, `copyEmail` defaults to true) and out of the phone ⋯ menu
  (`index.js` `moreMenu`; its first divider is added only when an item precedes it). The live site is unchanged.
  `snapshot.css` keeps hiding `[data-pact="copy-email"]` as a second guard.
- G3-6 2: every Export CSV button also carries `data-download` (G1-C `ui/list.js` `[data-csv]`, F3 `pages/sites.js`
  `[data-si-csv]` (both), F4 `pages/deals.js` `[data-dl-csv]`). `snapshot.css` hides `html[data-snapshot]
  [data-download]` next to the three old selectors, and `96-snapshot`'s write-control detector counts it. A new
  download button only needs `data-download`.
- G3-6 3 (F6): in a snapshot, the Team overview morning run card says "Open the live site to see this." where the
  live site shows the suggestions fallback text (spec 4.14: a snapshot has no suggestions). `96-snapshot` checks it.

Still open:
- F8 2 (B1, `functions/api/edits.js`, optional): needs a spec change first, as listed after the F8 merge.
- F6 1 (F3, then F6) and F6 2 (G1-C or G3-3) as listed after the F6 merge.
- G1-B 6 (G3-1, release): change `BUILD` in `lib/meta.js` together with `window.BUILD` in `index.html`.
- F1 3 follow-up (record panel owner F1, or G3-1): send the outcomes with a form through `quiet`/`throw`.

# NEEDS (G2 checkpoint)

1. **`functions/api/partner/[id].js` (B1) PATCH, optional: a D1 failure answers 400 with the raw error text.**
   `onRequestPatch` wraps `updatePartner()` (which runs the D1 batch) in `catch (msg) { return bad(String(msg)); }`,
   as d5e91d9 did. The string throws are the validation messages ("Pick a stage from the list.", …), but a D1
   error lands there too and comes back as 400 `{"error":"Error: D1_ERROR: … internal error; reference = …"}`.
   `api.js` shows 400 texts as they are (spec 4.11), so the panel and the inline editors would say that text,
   where 4.11 wants "The server couldn't save this. Try again in a moment." for a 5xx/D1 failure. Seen on a local
   fixture server: 11 of 6,983 PATCHes got this 400 while a `wrangler d1 execute --local` held the database lock
   (3 more got workerd's own 500 page). Suggested change: in that catch, `if (msg instanceof Error) throw msg;`
   (or return 500 JSON) before `return bad(String(msg));`, so only the string validation messages stay 400. The
   same applies to `settings.js` PUT, whose `catch (msg)` also wraps one D1 read (`readKv`). The other
   `catch (msg)` blocks (`partners.js` POST, `bulk.js`, `outcome.js`) wrap validation only.

# Status at the G2 checkpoint (tag g2-checkpoint)

Read every section above. No open item is small and clearly right, so nothing was applied to product files at
this checkpoint. Test change: `tests/e2e/lib.mjs` `d1All()` now retries a `wrangler d1 execute --local` call that
fails with SQLITE_BUSY ("database is locked"), as the page test files' own `retry()` already did for their reads;
`90-api-contract`, `91-migrations`, `96-snapshot` and the lib helpers (`maxEditN`, `editsAfter`, `applyBefore`,
`replayCase`) had no retry (`90-api-contract` failed once on it in F4's full run).

Still open (owners in brackets):
- G2 checkpoint 1 (B1, or G3-1): PATCH (and settings PUT) turn a D1 error into a 400 with the raw text (above).
- F6 1 (F3, then F6; or G3-1 as cross-link work): Sites `flag=` filter, then `SITES_FLAGS`. Not small.
- F6 2 (G1-C or G3-3): chart bar focus; needs a different chart structure (the suggested change fails axe).
- F8 2 (B1 + a spec change): `total` in `GET /api/edits`.
- F1 3 follow-up (F1, or G3-1): the form outcomes through `quiet`/`throw`; the panel would have to own the
  form's busy state, Retry and Undo. Not required by the spec.
- G1-B 6 (G3-1, release): change `BUILD` in `lib/meta.js` together with `window.BUILD` in `index.html`.

# Status at G3-1 (integration, crm-easy-site-g31)

Closed at G3-1:
- G2 checkpoint 1: `functions/api/partner/[id].js` PATCH and `functions/api/settings.js` PUT rethrow a real `Error`
  (a D1 failure) instead of answering 400 with its text; the string field checks stay 400. The page shows "The
  server couldn't save this. Try again in a moment." (4.11). Tests: `tests/unit/api-errors.test.mjs` (stub D1),
  `98-scenarios` T35 (a 500 on a save, through `api.request` and through a Deals row's Next step).
- F6 1: Sites › All takes `flag=<Team overview list id>` (a removable chip named after the list, shown first, and
  the list's description under the h1); `rules/team.js` `SITES_FLAGS` holds every flag and `target()` sends every
  Team overview number, Stuck tile and clean-up count to Sites. `#team?show=<flag>&owner=` (the old list view, now
  removed) redirects to the same Sites list; Back from a number returns to it with the focus on it.
- G1-B 6: `window.BUILD` (index.html) and `BUILD` (lib/meta.js) are both `easy-rc0`; `tests/unit/build.test.mjs`
  fails when they differ, so a release changes both in one commit.
- 2.3 "Deals board … + stage menu": every Deals row has the Stage pill under the site name (the panel's Stage
  write, with Undo); Signed → Live stays "Log what happened › Placement is live".
- Found and fixed while testing T18: the boot requests in `index.html` (meta, list) had no handler until the
  modules loaded, so a failed list request on a warm start was reported as an uncaught page error; each now has a
  no-op `catch` (the store and meta still read the failure).

Still open (owners in brackets):
- F6 2 (G1-C or G3-3): chart bar focus.
- F8 2 (B1 + a spec change): `total` in `GET /api/edits`.
- F1 3 follow-up (F1): the form outcomes through `quiet`/`throw`. Not small (the panel would own the form's busy
  state, Retry and Undo) and not required by the spec, so G3-1 left it.
