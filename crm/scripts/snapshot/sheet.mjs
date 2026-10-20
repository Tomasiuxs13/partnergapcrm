// Google Sheets dumps -> the v2 rows the site serves (spec 4.14, 6.3.2). Owner G3-6. Node only; the page
// never loads this file. Docs: crm/docs/snapshot.md.
//
// The Friday digest has only the Google Sheets connector. It dumps Accounts!A1:AC (and, when it can,
// Contacts!A1:Q and 'Activity log'!A1:H) as {range, values}. sheetRows() turns those dumps into exactly the
// rows GET /api/partners?v=2 returns after crm/scripts/build_d1_import.py loaded the same dumps into D1:
//   - the importer's part, ported line for line with Python's semantics: column positions, blanking a
//     Domain or Brand with "@", "[email in sheet]" in Next step and Notes, int(float()) for DR and traffic,
//     round(float(), 2) for deal amounts, sheet serial dates (46301 -> 2026-10-06), str.strip();
//   - the server's part (v2Sql in lib/crm.js): the contacts and activity lookups as SQLite computes them
//     (MAX in BINARY order, the contact label of contactLabelSql), then v2FromParts for the label and the
//     column order, the same function v2Row uses.
// Without the Contacts dump every site has 0 contacts and no last email or reply; without the Activity log
// no site has an activity date: what the site serves after an import of empty tabs.
// tests/unit/snapshot-sheet.test.mjs proves the equality against the real importer and the server's SQL.
import { V2_COLS, v2FromParts, needsContactLabel, contactLabel, binaryCompare } from "../../../lib/crm.js";

export class SheetError extends Error {}

const fail = (message) => {
  throw new SheetError(message);
};

// ---------- Python semantics (build_d1_import.py runs on Python 3) ----------

// str.isspace() and re's \s: what str.strip() removes and r"\s" matches. float() strips the same set
// except \x1c-\x1f (it keeps ASCII as it is and strips only " \t\n\v\f\r" of it).
const PY_SPACE = "\\t\\n\\x0b\\x0c\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
const SPACE = new RegExp("[" + PY_SPACE + "]");
const FLOAT_SPACE = new RegExp("[" + PY_SPACE.replace("\\x1c-\\x1f", "") + "]");

function strip(s, set) {
  let a = 0;
  let b = s.length;
  while (a < b && set.test(s[a])) a++;
  while (b > a && set.test(s[b - 1])) b--;
  return s.slice(a, b);
}

/** str.strip() */
export const pyStrip = (s) => strip(s, SPACE);

const DIGITS = "[0-9](?:_?[0-9])*";
const FLOAT = new RegExp("^[+-]?(?:" + DIGITS + "(?:\\.(?:" + DIGITS + ")?)?|\\." + DIGITS + ")(?:[eE][+-]?" + DIGITS + ")?$");
const SPECIAL = /^[+-]?(?:inf|infinity|nan)$/i;

/** float(s): a number, or undefined where Python raises ValueError. ASCII digits only. */
export function pyFloat(s) {
  const t = strip(s, FLOAT_SPACE);
  if (SPECIAL.test(t)) return /nan/i.test(t) ? NaN : t[0] === "-" ? -Infinity : Infinity;
  return FLOAT.test(t) ? Number(t.replace(/_/g, "")) : undefined;
}

/** round(x, 2) for a finite float: half-even on the exact binary value, as Python does. -0 becomes 0. */
export function pyRound2(x) {
  if (Number.isInteger(x)) return x === 0 ? 0 : x;
  // toFixed(100) is exact for |x| >= 2^-48; anything smaller rounds to 0 either way.
  const [int, frac] = Math.abs(x).toFixed(100).split(".");
  let cents = BigInt(int + frac.slice(0, 2));
  const rest = frac.slice(2);
  const half = rest[0] === "5" && !/[1-9]/.test(rest.slice(1));
  if (rest[0] > "5" || (rest[0] === "5" && !half) || (half && cents % 2n === 1n)) cents += 1n;
  const v = Number((cents / 100n).toString() + "." + (cents % 100n).toString().padStart(2, "0"));
  return x < 0 && v !== 0 ? -v : v;
}

// ---------- the importer's helpers (build_d1_import.py) ----------

// EMAIL = r"[\w.+-]+@[\w-]+\.[\w.-]+" (Python's \w is [\p{L}\p{N}_]).
const PY_EMAIL = /[\p{L}\p{N}_.+-]+@[\p{L}\p{N}_-]+\.[\p{L}\p{N}_.-]+/gu;

/** no_email(s): free text keeps no address. */
export const noEmail = (s) => s.replace(PY_EMAIL, "[email in sheet]");

const noAt = (s) => (s.includes("@") ? "" : s);

/** num(s): int(float(s without commas)), else null. */
export function num(s) {
  const f = pyFloat(s.replace(/,/g, ""));
  // NaN is a ValueError (null). The importer stops on inf (OverflowError); here it is null too.
  if (f === undefined || !Number.isFinite(f)) return null;
  return Math.trunc(f) || 0;
}

const AMOUNT_JUNK = new RegExp("[$,%" + PY_SPACE + "]", "g");

/** amount(s): "$1,200.50" or "12.5%" -> round(float, 2), else null. */
export function amount(s) {
  const f = pyFloat(s.replace(AMOUNT_JUNK, ""));
  // The importer writes nan/inf into SQL as bare words and stops; here they are null.
  if (f === undefined || !Number.isFinite(f)) return null;
  return pyRound2(f);
}

const SERIAL = /^[0-9]{5}(?:\.[0-9]+)?$/;
const EPOCH = Date.UTC(1899, 11, 30);

/** day(s): a sheet serial date (days since 1899-12-30) as YYYY-MM-DD; anything else as it is. */
export function day(s) {
  if (!SERIAL.test(s)) return s;
  return new Date(EPOCH + Math.trunc(Number(s)) * 86400000).toISOString().slice(0, 10);
}

const flag = (s) => (s.toUpperCase() === "TRUE" ? 1 : 0);

/**
 * cell(row, i): the stripped text, "" for a missing cell. The connector gives strings; a number or a
 * true/false (unformatted values, which the importer can't read) is taken as the sheet shows it.
 */
function cell(row, i) {
  const v = i < row.length ? row[i] : null;
  if (v == null) return "";
  if (typeof v === "string") return pyStrip(v);
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
  return fail("a cell holds " + JSON.stringify(v).slice(0, 40) + ", not text.");
}

// ---------- the dumps ----------

/** Accounts columns as build_d1_import.py reads them: [index, partners column, header, parse]. */
export const ACCOUNT_COLUMNS = [
  [0, "id", "Account ID"], [1, "domain", "Domain", noAt], [2, "name", "Brand / site name", noAt],
  [3, "type", "Affiliate type"], [7, "dr", "Domain rating", num], [8, "traffic", "Organic traffic", num],
  [9, "owner", "Owner"], [12, "stage", "Stage"], [16, "last_touch", "Last touch", day],
  [20, "clients", "Clients pitched"], [21, "country", "Top traffic country"], [17, "next_step", "Next step", noEmail],
  [18, "next_due", "Next step due", day], [5, "source", "Source"], [6, "seed_keyword", "Seed keyword"],
  [19, "notes", "Notes", noEmail], [22, "deal_model", "Deal model"], [23, "deal_flat", "Flat fee (USD)", amount],
  [24, "deal_pct", "Commission %", amount], [25, "deal_value", "Deal value (USD)", amount],
  [26, "content_url", "Placement URL"], [27, "live_date", "Go-live date", day], [28, "tracking_id", "Tracking ID"],
];

/** True for a Sheets values dump ({range, values}) rather than an API body. */
export function isSheetDump(body) {
  return !!body && typeof body === "object" && !Array.isArray(body) && Array.isArray(body.values) && !("cols" in body);
}

function grid(body, what, tab) {
  if (!isSheetDump(body)) fail(what + ": expected a Sheets dump of " + tab + " ({range, values}).");
  if (String(body.majorDimension || "ROWS").toUpperCase() !== "ROWS") fail(what + ": the dump must be by rows (majorDimension ROWS).");
  body.values.forEach((r, i) => {
    if (!Array.isArray(r)) fail(what + ": row " + (i + 1) + " of the dump is not a list of cells.");
  });
  if (!body.values.length) fail(what + ": the dump has no header row; dump " + tab + ".");
  return body.values;
}

const letter = (i) => (i < 26 ? "" : String.fromCharCode(64 + Math.floor(i / 26))) + String.fromCharCode(65 + (i % 26));

/**
 * Turns the dumps into a v2 body. accounts: Accounts!A1:AC (required); contacts: Contacts!A1:Q; activity:
 * 'Activity log'!A1:H. Returns {v: 2, cols, rows, warnings, counts}. Throws SheetError on a wrong dump.
 */
export function sheetRows({ accounts, contacts = null, activity = null } = {}) {
  const warnings = [];
  const acc = grid(accounts, "--rows", "Accounts!A1:AC");
  // The importer's checks, word for word: assert accounts[0][0] == "Account ID" and accounts[0][1] == "Domain".
  if (acc[0][0] !== "Account ID" || acc[0][1] !== "Domain") {
    fail("--rows: a Sheets dump must start at Accounts!A1 (headers \"Account ID\", \"Domain\", ...), like build_d1_import.py reads it.");
  }
  // Columns are read by position, as the importer does, so the rows match the site; a header that moved is noted.
  const norm = (s) => pyStrip(String(s == null ? "" : s)).toLowerCase();
  for (const [i, , header] of ACCOUNT_COLUMNS) {
    const got = norm(acc[0][i]);
    if (got && got !== header.toLowerCase()) {
      warnings.push("Accounts column " + letter(i) + " is headed \"" + pyStrip(String(acc[0][i])) + "\" (expected \"" + header +
        "\"); it is read by position, like build_d1_import.py does.");
    }
  }

  // Contacts: [:2] == ["Contact ID", "Account ID"] and [6] == "Email"; rows with a contact id.
  const people = new Map();
  let contactCount = 0;
  if (contacts != null) {
    const con = grid(contacts, "--contacts-sheet", "Contacts!A1:Q");
    const h = con[0];
    if (h[0] !== "Contact ID" || h[1] !== "Account ID" || h[6] !== "Email") {
      fail("--contacts-sheet: a Sheets dump must be Contacts!A1:Q (headers \"Contact ID\", \"Account ID\", ... G \"Email\").");
    }
    const seen = new Set();
    let repeated = 0;
    for (const r of con.slice(1)) {
      const id = cell(r, 0);
      if (!id) continue;
      contactCount++;
      if (seen.has(id)) repeated++;
      seen.add(id);
      const account = cell(r, 1);
      const k = { id, first_name: cell(r, 3), last_name: cell(r, 4), email: cell(r, 6), primary_contact: flag(cell(r, 11)) };
      const last = day(cell(r, 14));
      const replied = flag(cell(r, 15));
      const p = people.get(account);
      if (!p) people.set(account, { n: 1, last, replied, list: [k] });
      else {
        p.n++;
        if (binaryCompare(last, p.last) > 0) p.last = last;
        if (replied > p.replied) p.replied = replied;
        p.list.push(k);
      }
    }
    if (repeated) warnings.push("Contacts has " + repeated + " repeated contact ID" + (repeated === 1 ? "" : "s") + "; build_d1_import.py refuses such a sheet.");
  }

  // Activity log: [:2] == ["Date", "Account ID"]; rows with a date. act_at = MAX(date) per site.
  const acts = new Map();
  let activityCount = 0;
  if (activity != null) {
    const log = grid(activity, "--activity-sheet", "'Activity log'!A1:H");
    if (log[0][0] !== "Date" || log[0][1] !== "Account ID") {
      fail("--activity-sheet: a Sheets dump must start at 'Activity log'!A1 (headers \"Date\", \"Account ID\", ...).");
    }
    for (const r of log.slice(1)) {
      if (!cell(r, 0)) continue;
      activityCount++;
      const date = day(cell(r, 0));
      const account = cell(r, 1);
      if (!acts.has(account) || binaryCompare(date, acts.get(account)) > 0) acts.set(account, date);
    }
  }

  // partners: INSERT OR REPLACE, so a repeated Account ID keeps its last row (the importer then stops on
  // its row count check; the snapshot keeps going and says so).
  const sites = new Map();
  let repeatedSites = 0;
  for (const r of acc.slice(1)) {
    const id = cell(r, 0);
    if (!id) continue;
    const row = {};
    for (const [i, field, , parse] of ACCOUNT_COLUMNS) row[field] = parse ? parse(cell(r, i)) : cell(r, i);
    row.contacts = people.has(id) ? people.get(id).n : 0;
    if (sites.has(id)) repeatedSites++;
    sites.set(id, row);
  }
  if (repeatedSites) {
    warnings.push("Accounts has " + repeatedSites + " repeated Account ID" + (repeatedSites === 1 ? "" : "s") +
      "; the last row of each is used. build_d1_import.py refuses such a sheet.");
  }

  const rows = [...sites.keys()].sort(binaryCompare).map((id) => {
    const row = sites.get(id);
    const p = people.get(id);
    return v2FromParts(row, {
      last_email: p ? p.last : null,
      replied_contact: p ? p.replied : null,
      act_at: acts.has(id) ? acts.get(id) : null,
      sugg: null,
      contact_label: p && needsContactLabel(row) ? contactLabel(p.list) : null,
    });
  });
  return { v: 2, cols: V2_COLS.slice(), rows, warnings, counts: { sites: rows.length, contacts: contactCount, activity: activityCount } };
}
