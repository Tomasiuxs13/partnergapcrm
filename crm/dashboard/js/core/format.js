// Pure formatting and date helpers (spec 5.4, Appendix B, Appendix C). Owner G1-A.
// No side effects at import time. todayIso() is the only clock read; everything else takes its
// dates (and, for the run-time helpers, the current time in ms) as arguments.
//
// Dates: 'YYYY-MM-DD' strings are calendar dates and are never shifted by a time zone. Full ISO
// timestamps ('2026-10-21T06:12:40Z') are converted to the browser's local calendar date and time,
// because Appendix C says times are local. Invalid or empty input gives '' (or null for numbers).

const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const WD_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const WD_LONG = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MON_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MON_LONG = ["January", "February", "March", "April", "May", "June", "July", "August", "September",
  "October", "November", "December"];
const DAY_MS = 86400000;

const pad = (n) => String(n).padStart(2, "0");

const DAYS_IN = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

// Whether y-m-d is a real calendar day. Years 0-99 are not (Date.UTC would read them as 1900-1999).
function realDay(y, m, d) {
  if (y < 100 || m < 1 || m > 12 || d < 1) return false;
  const leap = y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);
  return d <= (m === 2 && leap ? 29 : DAYS_IN[m - 1]);
}

// {y, m, d, hh, mm, hasTime} for a date string, a timestamp string or a Date; null when invalid.
function parts(v) {
  if (v == null || v === "") return null;
  if (v instanceof Date) {
    if (isNaN(v.getTime())) return null;
    return { y: v.getFullYear(), m: v.getMonth() + 1, d: v.getDate(), hh: v.getHours(), mm: v.getMinutes(), hasTime: true };
  }
  const s = String(v).trim();
  const m = DAY_RE.exec(s);
  if (m) {
    const y = +m[1], mo = +m[2], d = +m[3];
    if (!realDay(y, mo, d)) return null;
    return { y, m: mo, d, hh: 0, mm: 0, hasTime: false };
  }
  if (!/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(s)) return null;
  const t = new Date(s.replace(" ", "T"));
  if (isNaN(t.getTime())) return null;
  return { y: t.getFullYear(), m: t.getMonth() + 1, d: t.getDate(), hh: t.getHours(), mm: t.getMinutes(), hasTime: true };
}

// Whole days since 1970-01-01 for a calendar date (no time zone involved).
function dayNum(p) {
  return Math.round(Date.UTC(p.y, p.m - 1, p.d) / DAY_MS);
}

function fromDayNum(n) {
  const t = new Date(n * DAY_MS);
  return t.getUTCFullYear() + "-" + pad(t.getUTCMonth() + 1) + "-" + pad(t.getUTCDate());
}

function weekdayOf(n) {
  return new Date(n * DAY_MS).getUTCDay();
}

// The local calendar date 'YYYY-MM-DD' of a date or a timestamp, or null.
export function toDay(v) {
  // Fast path (7,500 sites x 5 dates on every load): a plain 'YYYY-MM-DD' is already its own answer.
  if (typeof v === "string" && v.length === 10) {
    const m = DAY_RE.exec(v);
    if (m && +m[1] >= 1000) return realDay(+m[1], +m[2], +m[3]) ? v : null;
  }
  const p = parts(v);
  return p ? fromDayNum(dayNum(p)) : null;
}

function toNumber(v) {
  if (v == null || v === "" || typeof v === "boolean") return null;
  const x = typeof v === "number" ? v : Number(String(v).replace(/[$,%\s]/g, ""));
  return isFinite(x) ? x : null;
}

// Thousands separators and at most 2 decimals.
function group(x) {
  const r = Math.round(Math.abs(x) * 100) / 100;
  const [i, f] = String(r).split(".");
  return { neg: x < 0 && r !== 0, int: i.replace(/\B(?=(\d{3})+(?!\d))/g, ","), frac: f || "" };
}

// 7403 -> "7,403"; 3.456 -> "3.46"; empty or not a number -> "".
export function num(n) {
  const x = toNumber(n);
  if (x == null) return "";
  const g = group(x);
  return (g.neg ? "-" : "") + g.int + (g.frac ? "." + g.frac : "");
}

// US dollars: 350 -> "$350"; 1234.5 -> "$1,234.50"; empty -> "".
export function money(v) {
  const x = toNumber(v);
  if (x == null) return "";
  const g = group(x);
  return (g.neg ? "-$" : "$") + g.int + (g.frac ? "." + g.frac.padEnd(2, "0") : "");
}

// A percentage value, as deal_pct stores it (30 means 30 %): 30 -> "30%"; 12.5 -> "12.5%".
// For a ratio such as a reply rate, pass ratio * 100.
export function pct(v) {
  const x = toNumber(v);
  return x == null ? "" : num(x) + "%";
}

// Styles: 'short' "Thu 22 Oct" (default) · 'long' "Thursday 22 October" · 'day' "22 Oct" ·
// 'year' "22 Oct 2026" · 'month' "October 2026" · 'iso' "2026-10-22" · 'time' "08:52" ·
// 'datetime' "Thu 22 Oct 08:52" · 'weekdayTime' "Thu 08:52". Time styles need a timestamp;
// for a plain date they give the date part only ('time' gives '').
export function date(iso, style = "short") {
  const p = parts(iso);
  if (!p) return "";
  const wd = weekdayOf(dayNum(p));
  const time = pad(p.hh) + ":" + pad(p.mm);
  const short = WD_SHORT[wd] + " " + p.d + " " + MON_SHORT[p.m - 1];
  switch (style) {
    case "long": return WD_LONG[wd] + " " + p.d + " " + MON_LONG[p.m - 1];
    case "day": return p.d + " " + MON_SHORT[p.m - 1];
    case "year": return p.d + " " + MON_SHORT[p.m - 1] + " " + p.y;
    case "month": return MON_LONG[p.m - 1] + " " + p.y;
    case "iso": return fromDayNum(dayNum(p));
    case "time": return p.hasTime ? time : "";
    case "datetime": return p.hasTime ? short + " " + time : short;
    case "weekdayTime": return p.hasTime ? WD_SHORT[wd] + " " + time : short;
    default: return short;
  }
}

// Day numbers of 'YYYY-MM-DD' strings already seen (speed, G3-4: the rules ask for the same few
// thousand dates over and over on 7,500 sites). Bounded, so a long session can't grow it forever.
const DAY_NUMS = new Map();

function dayNumOf(v) {
  if (typeof v === "string" && v.length === 10) {
    const hit = DAY_NUMS.get(v);
    if (hit !== undefined) return hit;
    const p = parts(v);
    const n = p ? dayNum(p) : null;
    if (DAY_NUMS.size >= 20000) DAY_NUMS.clear();
    DAY_NUMS.set(v, n);
    return n;
  }
  const p = parts(v);
  return p ? dayNum(p) : null;
}

// Calendar days from a to b (b - a), in local dates. null when either is missing or invalid.
export function daysBetween(a, b) {
  const na = dayNumOf(a);
  if (na == null) return null;
  const nb = dayNumOf(b);
  if (nb == null) return null;
  return nb - na;
}

// "today", "yesterday", "12d ago"; future dates: "tomorrow", "in 3d"; unknown: "".
export function ago(iso, today) {
  const n = daysBetween(iso, today);
  if (n == null) return "";
  if (n === 0) return "today";
  if (n === 1) return "yesterday";
  if (n > 1) return n + "d ago";
  if (n === -1) return "tomorrow";
  return "in " + -n + "d";
}

// The local calendar date. The only clock read in the rule layer (d defaults to now).
export function todayIso(d = new Date()) {
  return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
}

export function addDays(iso, n) {
  const p = parts(iso);
  if (!p) return "";
  return fromDayNum(dayNum(p) + Math.trunc(Number(n) || 0));
}

// Skips Saturdays and Sundays: Fri + 1 -> Mon, Sat + 1 -> Mon. n = 0 returns the date itself;
// a negative n counts back.
export function addWorkingDays(iso, n) {
  const p = parts(iso);
  if (!p) return "";
  let d = dayNum(p);
  const k = Math.trunc(Number(n) || 0);
  const step = k < 0 ? -1 : 1;
  let left = Math.abs(k);
  while (left > 0) {
    d += step;
    const wd = weekdayOf(d);
    if (wd !== 0 && wd !== 6) left--;
  }
  return fromDayNum(d);
}

// The first Monday strictly after the date (a Monday gives the Monday a week later).
export function nextMonday(iso) {
  const p = parts(iso);
  if (!p) return "";
  let d = dayNum(p) + 1;
  while (weekdayOf(d) !== 1) d++;
  return fromDayNum(d);
}

export function isWeekend(iso) {
  const p = parts(iso);
  if (!p) return false;
  const wd = weekdayOf(dayNum(p));
  return wd === 0 || wd === 6;
}

// Due badge: overdue "Overdue 3d" · today "Due today" · soon (1-7 days ahead) "Due tomorrow" or
// "Due Thu 22 Oct" · later "Due Thu 29 Oct". No date: {text: "", tone: "later"}.
export function dueLabel(iso, today) {
  const n = daysBetween(today, iso);
  if (n == null) return { text: "", tone: "later" };
  if (n < 0) return { text: "Overdue " + -n + "d", tone: "overdue" };
  if (n === 0) return { text: "Due today", tone: "today" };
  if (n === 1) return { text: "Due tomorrow", tone: "soon" };
  return { text: "Due " + date(iso, "short"), tone: n <= 7 ? "soon" : "later" };
}

// Avatar letters: the first letter or digit of each of the first two words.
// "Jonas Vik" -> "JV"; "(ZTG) Mashable" -> "ZM"; "mashable.com" -> "M"; "" -> "?".
export function initials(label) {
  let out = "";
  for (const w of String(label == null ? "" : label).trim().split(/\s+/)) {
    const m = /[\p{L}\p{N}]/u.exec(w);
    if (m) out += m[0];
    if (out.length >= 2) break;
  }
  return out ? out.toUpperCase() : "?";
}

// The same rules as lib/crm.js cleanDomain(): lower-case; strip the scheme, "www."/"m.", the query
// and the hash; keep the channel path on creator platforms (youtube.com/@name). '' if not a website.
const DOMAIN = /^[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/i;
const PLATFORMS = /^(youtube\.com|instagram\.com|tiktok\.com|x\.com|twitter\.com|facebook\.com|linkedin\.com|medium\.com|twitch\.tv|pinterest\.com)$/;

export function normDomain(input) {
  const text = String(input == null ? "" : input).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").trim().slice(0, 300);
  const raw = text.toLowerCase().replace(/^https?:\/\//, "").replace(/^(www|m)\./, "").split(/[?#\s]/)[0];
  const [host, ...path] = raw.split("/");
  if (!DOMAIN.test(host)) return "";
  const seg = path.filter(Boolean);
  if (PLATFORMS.test(host) && seg.length) {
    const keep = /^(channel|c|user|in|company)$/.test(seg[0]) && seg[1] ? seg.slice(0, 2) : seg.slice(0, 1);
    return (host + "/" + keep.join("/")).slice(0, 200);
  }
  return host;
}

// For name matching: lower-case, accents removed, apostrophes dropped, other punctuation turned
// into single spaces. "Mr. Money's Blog!" -> "mr moneys blog".
export function normName(s) {
  return String(s == null ? "" : s)
    .normalize("NFKD").replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/['’`]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

// The word only: plural(1, "site", "sites") -> "site"; plural(3, "site") -> "sites".
export function plural(n, one, many) {
  return Number(n) === 1 ? one : many == null ? one + "s" : many;
}

// ---------- Run schedule (pure: these take the current time in ms) ----------

const zoneFormatters = new Map();
function zoneFormatter(tz) {
  if (!zoneFormatters.has(tz)) {
    zoneFormatters.set(tz, new Intl.DateTimeFormat("en-GB", {
      timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
    }));
  }
  return zoneFormatters.get(tz);
}

// Wall-clock parts of an instant in a time zone: {y, m, d, hh, mm, ss, day: 'YYYY-MM-DD', wd}.
export function zonedParts(ms, tz = "Europe/Vilnius") {
  const o = {};
  for (const p of zoneFormatter(tz).formatToParts(new Date(ms))) o[p.type] = p.value;
  const y = +o.year, m = +o.month, d = +o.day;
  return { y, m, d, hh: +o.hour % 24, mm: +o.minute, ss: +o.second, day: y + "-" + pad(m) + "-" + pad(d), wd: weekdayOf(dayNum({ y, m, d })) };
}

// The instant (ms) of a wall-clock time "HH:MM" on a calendar day in a time zone.
export function zonedTime(day, hhmm, tz = "Europe/Vilnius") {
  const p = parts(day);
  if (!p) return NaN;
  const [hh, mm] = String(hhmm || "00:00").split(":").map(Number);
  const guess = Date.UTC(p.y, p.m - 1, p.d, hh || 0, mm || 0);
  let t = guess;
  for (let i = 0; i < 2; i++) {
    const z = zonedParts(t, tz);
    t = guess - (Date.UTC(z.y, z.m - 1, z.d, z.hh, z.mm, z.ss) - t);
  }
  return t;
}

// The latest weekday run at "HH:MM" (in tz) at or before nowMs.
export function lastRunAt(nowMs, tz = "Europe/Vilnius", hhmm = "08:47") {
  let day = zonedParts(nowMs, tz).day;
  for (let i = 0; i < 8; i++, day = addDays(day, -1)) {
    if (isWeekend(day)) continue;
    const t = zonedTime(day, hhmm, tz);
    if (t <= nowMs) return t;
  }
  return NaN;
}

// The next weekday run at "HH:MM" (in tz) strictly after nowMs.
export function nextRunAt(nowMs, tz = "Europe/Vilnius", hhmm = "08:47") {
  let day = zonedParts(nowMs, tz).day;
  for (let i = 0; i < 8; i++, day = addDays(day, 1)) {
    if (isWeekend(day)) continue;
    const t = zonedTime(day, hhmm, tz);
    if (t > nowMs) return t;
  }
  return NaN;
}
