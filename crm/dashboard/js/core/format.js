// Pure formatting and date helpers (spec 5.4, Appendix B). G0 stub; owner G1-A.
// Safe defaults only; G1-D's unit tests define the real behaviour. todayIso() is the only clock read.

export function num(n) { return n == null || n === "" ? "" : String(n); }
export function money(v) { return v == null || v === "" ? "" : String(v); }
export function pct(v) { return v == null || v === "" ? "" : String(v); }
export function date(iso, style = "short") { return iso ? String(iso) : ""; }
export function ago(iso, today) { return ""; }
export function daysBetween(a, b) { return null; }

export function todayIso() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate());
}

export function addWorkingDays(iso, n) { return iso; }
export function addDays(iso, n) { return iso; }
export function nextMonday(iso) { return iso; }

export function dueLabel(iso, today) { return { text: "", tone: "later" }; }

export function initials(label) { return ""; }
export function normDomain(input) { return String(input == null ? "" : input).trim().toLowerCase(); }
export function normName(s) { return String(s == null ? "" : s).trim().toLowerCase(); }
export function plural(n, one, many) { return n === 1 ? one : many; }
