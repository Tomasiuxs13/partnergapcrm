// Who is using the site (spec 5.4, D4). Owner G1-A. No side effects at import time.
// init() reads localStorage 'pgcrm-me' first, then the cookie 'pg_me'. set() always writes both.
// localStorage holds the name JSON-encoded ('"Kamile"'), as legacy.html reads and writes it; a plain
// value (written by another page) is read as well.
import * as bus from "./bus.js";

const KEY = "pgcrm-me";
const COOKIE = "pg_me";
const MAX_AGE = 2592000; // 30 days, like the session

let name = null;
let asker = null;

function clean(v) {
  const s = String(v == null ? "" : v).replace(/[\u0000-\u001f\u007f]/g, "").replace(/\s+/g, " ").trim().slice(0, 40);
  return s || null;
}

function readLocal() {
  try {
    const v = localStorage.getItem(KEY);
    if (v == null) return null;
    if (v.startsWith('"')) {
      try { return clean(JSON.parse(v)); } catch (e) { /* not JSON: use as is */ }
    }
    return clean(v);
  } catch (e) {
    return null;
  }
}

function readCookie() {
  try {
    const m = String(document.cookie || "").match(/(?:^|;\s*)pg_me=([^;]*)/);
    if (!m) return null;
    try { return clean(decodeURIComponent(m[1])); } catch (e) { return clean(m[1]); }
  } catch (e) {
    return null;
  }
}

function writeLocal(v) {
  try {
    if (v) localStorage.setItem(KEY, JSON.stringify(v));
    else localStorage.removeItem(KEY);
  } catch (e) { /* storage blocked */ }
}

function writeCookie(v) {
  try {
    document.cookie = v
      ? COOKIE + "=" + encodeURIComponent(v) + "; Path=/; Max-Age=" + MAX_AGE + "; Secure; SameSite=Lax"
      : COOKIE + "=; Path=/; Max-Age=0; Secure; SameSite=Lax";
  } catch (e) { /* no document */ }
}

export function init() {
  const local = readLocal();
  const cookie = readCookie();
  name = local || cookie || null;
  // Keep both stores in step, so the sign-in form and legacy.html see the same name.
  if (name && local !== name) writeLocal(name);
  if (name && cookie !== name) writeCookie(name);
}

export function get() {
  return name;
}

// Writes BOTH localStorage pgcrm-me and the cookie pg_me (Path=/; Max-Age=2592000; Secure; SameSite=Lax).
// set(null) or set('') forgets the name in both places.
export function set(v) {
  const next = clean(v);
  const changed = next !== name;
  name = next;
  writeLocal(next);
  writeCookie(next);
  if (changed) bus.emit("me", name);
}

// The picker used by ensure() (app.js wires the footer picker from shell/me-picker.js).
export function setAsker(fn) {
  asker = typeof fn === "function" ? fn : null;
}

// The name for a write: the current one, or asks once through the picker. '' if nobody is picked.
export async function ensure() {
  if (name) return name;
  if (asker) {
    try {
      const picked = await asker();
      if (!name && picked) set(picked);
    } catch (e) { /* picker closed */ }
  }
  return name || "";
}

// The landing page for the current person: team[].home ('team' for Vik), else 'today' (spec D6).
export function home(meta) {
  const t = ((meta && meta.team) || []).find((x) => x && x.name === name);
  return t && t.home === "team" ? "team" : "today";
}
