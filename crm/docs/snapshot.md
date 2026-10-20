# Snapshot: a read-only copy of the site in one HTML file

`crm/scripts/build_snapshot.mjs` builds one self-contained HTML file from the site's own API bodies. It is
made to be published as a claude.ai artifact (a sandboxed frame with no network) and for the Friday digest.
Spec: 4.14 (read-only mode and snapshot) and 5.1 (bundler-safe module style).

## Build it

Save these GET bodies as JSON files from a signed-in session. In the browser, sign in to the site, open each
URL and save the page. In the tests, use `apiClient` from `tests/e2e/lib.mjs`.

| File | GET | Needed |
|---|---|---|
| rows | `/api/partners?v=2` | yes |
| meta | `/api/meta` | recommended (without it: the constants of `lib/meta.js`, no Settings overrides) |
| programs | `/api/clients` | optional (client programs on the client pages) |
| activity | `/api/team-activity?days=7` | optional ("Changes this week" and "Last active" on Team overview) |

```sh
node crm/scripts/build_snapshot.mjs --rows rows.json --meta meta.json \
  --programs programs.json --activity activity.json --as-of 2026-10-21T19:00 --out snapshot.html
```

It prints the file and a one-line summary: `600 sites, 829 KB, 57 modules, data from 2026-10-20T12:00:00.000Z`.

| Option | What it does |
|---|---|
| `--rows <file>` | The v2 body `{v: 2, cols, rows}`. The old list (`GET /api/partners`) is refused. |
| `--meta <file>` | The meta body. The snapshot always sets `read_only`, clears `sheet_url` and `freshness`, and turns Settings off. |
| `--programs <file>` | The client programs list. |
| `--activity <file>` | The team activity body `{since, days, by}`. |
| `--as-of <when>` | When the data is from: a date (noon local time) or a date-time. Default: now. |
| `--out <file>` | Where to write. Default: `partnergap-snapshot-<day>.html` in the system temp folder. The file is written whole or not at all. |
| `--redact-emails` | Replace every email address found in the inputs with "(email hidden)" instead of refusing. |
| `--help` | The options. |

## What it refuses

It stops with exit code 1 and writes nothing when:
- any input value or key looks like an email address (`name@domain.tld`, also inside longer text). The message
  lists up to 20 places, such as `rows: PG-00013 next_step (j…@p…)`, and never prints the address itself. Fix
  the data or run again with `--redact-emails`;
- the finished file contains anything that looks like an email address, whatever the flags. This is the last
  check before writing;
- `--rows` is not a v2 body, has no `id` column, or a row has the wrong number of values;
- `--meta` has no `stages`, `--programs` is not a list, `--activity` has no `by`, or `--as-of` is not a date;
- a stylesheet would load a file (`url(...)` other than `data:`, or `@import`), or the code contains `</script`
  or `<!--`;
- a module under `crm/dashboard/js` breaks the bundler-safe style (below). The message names the file and line.

## What the page does

- All CSS (in `index.html`'s order, `@font-face` removed, so the system font stack) and all code are inline.
  The page makes no network request: no fonts, images, scripts or API calls.
- A bar on every page says "Snapshot of Tue 20 Oct 2026 12:00, read-only. To make changes, open
  partnergap-crm.pages.dev." It has a "View as" picker: Everyone (the default) or a name from the team list.
  Today and Sites › Mine show that person's sites. The name is kept in memory, and also in `localStorage`
  when the browser allows it.
- With no `#hash` it opens on Today. In-page links work as on the site, also in an `about:srcdoc` frame,
  where only the hash can change.
- The page's clock starts at `--as-of`, so Today, due dates and "quiet" days are those of that day.
- Every write is hidden or disabled. The footer (sign-in name, sync line, Refresh, Google Sheet, Sign out),
  Export CSV, Copy email and the shell's own read-only banner are hidden. `window.open` and `window.print`
  do nothing, and clicks on download, `blob:`, `data:` and `mailto:` links are cancelled.
- Contacts, the timeline, suggestions, Edit history and the morning run aren't in a snapshot. Those sections
  say "Open the live site to see this" (the record panel, and client pages built without `--programs`) or
  "Not available yet".

## How it is built

- `crm/scripts/snapshot/bundle.mjs` is a small bundler with no dependencies. It turns the ES modules into
  one classic script: each module becomes a function that returns its exports, run once in dependency order.
- `crm/scripts/snapshot/entry.js` is the entry point: `app.js`, then the snapshot bar (`ui.js`).
- `crm/scripts/snapshot/api.js` replaces `js/core/api.js` at bundle time. It has the same exports. Rows,
  meta, programs and activity come from the embedded data, every other GET gives `null`, and every write
  is refused with "Read-only copy. Open partnergap-crm.pages.dev to edit."
- `crm/scripts/snapshot/prelude.classic.js` runs first. It reads the embedded data into
  `window.__SNAPSHOT__`, sets the clock, and blocks popups, printing and downloads.
- `crm/scripts/snapshot/snapshot.css` holds the bar's styles and the snapshot-only hiding rules.
- The data is embedded as `<script type="application/json">` with every `<` written as `<`.

### Bundler-safe module style (spec 5.1)

Every module under `crm/dashboard/js` must follow these rules. `tests/unit/bundle.test.mjs` checks them.
- Imports: only relative specifiers ending in `.js`, one per statement:
  `import {a, b as c} from "./x.js"`, `import * as x from "./x.js"` or `import x from "./x.js"`.
- Exports: `export function | async function | const | class`, `export default`, `export {a, b as c}`.
- Not allowed: `export let`, `export var`, `export *`, `export ... from`, circular imports, dynamic `import()`,
  top-level `await` and `import.meta`.
- `app.js` must import every module, and `index.html` must modulepreload exactly that set.

## Tests

```sh
node --test tests/unit/bundle.test.mjs                 # style rules, bundler, builder (no browser)
bash tests/e2e/run.sh tests/e2e/96-snapshot.test.mjs   # T34: builds from the fixture, then offline Chromium
```

`96-snapshot` builds the file from the fixture server's own GET bodies. It opens the file offline with every
request counted, at 1440x900 and 390x844, in a sandboxed frame (where `localStorage` throws) and in an
`about:srcdoc` frame. It checks that Today, Sites, Deals, Clients and Team overview render and that no request
leaves the page. It also checks that no write control is visible and enabled, that no email pattern is in the
file, and that the numbers match the live site at the same moment. Screenshots go to `SHOTS_DIR` (default
`/tmp/shots-g36`).
