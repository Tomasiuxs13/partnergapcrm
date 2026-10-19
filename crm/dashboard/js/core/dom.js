// DOM helpers: the escaping html`` template, render, delegated events (spec 5.1, 5.4).
// G0 stub with a minimal working implementation; owner G1-A. No side effects at import time.

class SafeHtml {
  constructor(s) { this.s = s; }
  toString() { return this.s; }
}

const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

export function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ESC[c]);
}

export function raw(str) {
  return new SafeHtml(String(str == null ? "" : str));
}

function part(v) {
  if (v == null || v === false) return "";
  if (v instanceof SafeHtml) return v.s;
  if (Array.isArray(v)) return v.map(part).join("");
  return esc(v);
}

export function html(strings, ...values) {
  let out = strings[0];
  for (let i = 0; i < values.length; i++) out += part(values[i]) + strings[i + 1];
  return new SafeHtml(out);
}

export function render(el, safe) {
  if (!el) return;
  el.innerHTML = safe instanceof SafeHtml ? safe.s : esc(safe);
}

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

export function on(root, type, selector, handler) {
  const fn = (e) => {
    const t = e.target && e.target.closest ? e.target.closest(selector) : null;
    if (t && root.contains(t)) handler(e, t);
  };
  root.addEventListener(type, fn);
  return () => root.removeEventListener(type, fn);
}

export function safeUrl(u) {
  const s = String(u == null ? "" : u).trim();
  return /^https?:\/\//i.test(s) ? s : "";
}

export async function copyText(t) {
  try {
    await navigator.clipboard.writeText(String(t == null ? "" : t));
    return true;
  } catch (e) {
    return false;
  }
}
