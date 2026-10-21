# Snapshot: a read-only copy of the site in one HTML file

`crm/scripts/build_snapshot.mjs` builds one self-contained HTML file from the site's own API bodies, or from
Google Sheets dumps of the CRM sheet. It is made to be published as a claude.ai artifact (a sandboxed frame
with no network) and for the Friday digest.
Spec: 4.14 (read-only mode and snapshot) and 5.1 (bundler-safe module style).

## Build it

There are two ways in: the site's own GET bodies, or Google Sheets dumps (what the Friday digest has).

### From the site's GET bodies

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

### From Google Sheets dumps (the Friday digest)

The digest session has only the Google Sheets connector. It saves each range as a JSON file shaped
`{range, values}` and passes them in. `--rows` tells a Sheets dump from a v2 body by its shape.

| File | Sheets range | Needed |
|---|---|---|
| accounts | `Accounts!A1:AC` | yes (as `--rows`) |
| contacts | `Contacts!A1:Q` | recommended (`--contacts-sheet`) |
| activity log | `'Activity log'!A1:H` | recommended (`--activity-sheet`) |

```sh
node crm/scripts/build_snapshot.mjs --rows accounts.json --contacts-sheet contacts.json \
  --activity-sheet activity-log.json --out crm-snapshot.html
```

The rows are exactly the ones `GET /api/partners?v=2` serves after `crm/scripts/build_d1_import.py` loaded
the same dumps into D1 (`crm/scripts/snapshot/sheet.mjs`):
- The importer's part, with Python's own rules: columns by position (A Account ID, B Domain, C Brand, D type,
  F source, H DR, I traffic, J owner, M stage, Q last touch, R next step, S due, U clients, V country, W–AC the
  deal columns), `str.strip()` on every cell, a Domain or Brand containing `@` left blank, addresses in Next
  step replaced by "[email in sheet]", DR and traffic as `int(float())` with commas removed ("12.5K" is no
  number), deal amounts as `round(float(), 2)` with `$`, `,`, `%` and spaces removed, and sheet serial dates
  (`46301`, also `46301.75`) turned into `2026-10-06`; ISO dates and anything else are kept as typed. Rows
  without an Account ID are skipped.
- The server's part (`v2Sql` in `lib/crm.js`): the contact count, the latest "Last email date", "Replied" and
  the latest activity date per site, as SQLite computes them; the label is name, else domain, else the first
  contact's name or the part of its email before `@`, else "Unnamed creator" (`v2FromParts`, which the server
  uses too). `updated_at`, `updated_by` and `sugg` are empty, as after a fresh import.
- The Contacts dump is read for those numbers and names only. No email address from it reaches the file.

Without `--contacts-sheet`, every site has 0 contacts and no last email or reply: a reply is dated by Last
touch only (most replies then drop out of Do now), new prospects with a contact no longer come first and "Has
contact" finds nothing. Without `--activity-sheet`, no site has an activity date. These are the rows the site
would serve after an import with those tabs empty. On the 20 Oct data, Accounts alone differed from the site
in `contacts`, `last_email` and `replied_contact` (5,677 sites), `label` (101 nameless creators) and `act_at`
(38 sites), and Do now for Everyone fell from 179 to 30; with all three dumps the rows were the same.

Not from the sheet:
- **Team overview's "Changes this week" and "Last active"** count edits made on the site (`edits`, by kind,
  with times). The Activity log has no field changes, mixes the daily run's and the sheet's own entries with
  the site's, and holds days, not times. So `--activity-sheet` does not feed them; without `--activity` (the
  `/api/team-activity` body) Team overview says "Changes this week and Last active: Not available yet."
- Client programs have no sheet tab (they live in D1 only), so client pages say "Open the live site to see
  this" unless `--programs` is given.
- Without `--meta`, the team, clients and stages are the constants of `lib/meta.js` (no Settings overrides).

The Accounts columns are read by position, as the importer reads them, so the rows match the site even if a
header was renamed. A header that differs from the expected name is printed as a note. The run stops when
the first headers are not the importer's (`Account ID`, `Domain`; `Contact ID`, `Account ID`, G `Email`;
`Date`, `Account ID`). A repeated Account ID keeps its last row and a repeated contact ID is counted, each with
a note: the importer itself refuses such a sheet.

| Option | What it does |
|---|---|
| `--rows <file>` | The v2 body `{v: 2, cols, rows}`, or a Sheets dump of `Accounts!A1:AC` (`{range, values}`). The old list (`GET /api/partners`) is refused. |
| `--contacts-sheet <file>` | With a Sheets dump only: `Contacts!A1:Q`, for contact counts, last emails, replies and nameless creators' labels. |
| `--activity-sheet <file>` | With a Sheets dump only: `'Activity log'!A1:H`, for each site's last activity date. |
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
- `--rows` is neither a v2 body nor a Sheets dump, has no `id` column, or a row has the wrong number of values;
- a Sheets dump doesn't start where the importer expects (see above), is by columns, or a cell is not text,
  a number or true/false; `--contacts-sheet` or `--activity-sheet` comes with a v2 body;
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
node --test tests/unit/snapshot-sheet.test.mjs         # Sheets dumps: the real importer + the server's SQL
bash tests/e2e/run.sh tests/e2e/96-snapshot.test.mjs   # T34: builds from the fixture, then offline Chromium
```

`snapshot-sheet` runs `build_d1_import.py` (python3) on the synthetic dumps in `tests/fixtures/sheets`, loads
the SQL into SQLite after `001_base.sql` (then 003 and 004) and reads it back with the server's own `v2Sql`:
the builder's rows must be the same, with and without the Contacts and Activity log dumps. It also checks the
importer's number, date, strip and email helpers against Python input by input. `96-snapshot` does the same
once through a fixture server and local D1.

`96-snapshot` builds the file from the fixture server's own GET bodies. It opens the file offline with every
request counted, at 1440x900 and 390x844, in a sandboxed frame (where `localStorage` throws) and in an
`about:srcdoc` frame. It checks that Today, Sites, Deals, Clients and Team overview render and that no request
leaves the page. It also checks that no write control is visible and enabled, that no email pattern is in the
file, and that the numbers match the live site at the same moment. Screenshots go to `SHOTS_DIR` (default
`/tmp/shots-g36`).
