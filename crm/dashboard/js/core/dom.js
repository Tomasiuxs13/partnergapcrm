// DOM helpers: the escaping html`` template, render, delegated events (spec 5.1, 5.4). Owner G1-A.
// No side effects at import time.

class SafeHtml {
  constructor(s) { this.s = s; }
  toString() { return this.s; }
}

const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

// Escapes & < > " ' so the text is safe in element content and in quoted attributes.
export function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ESC[c]);
}

// Marks a trusted string as HTML. Never pass data from the server or the user.
export function raw(str) {
  return new SafeHtml(String(str == null ? "" : str));
}

export function isSafe(v) {
  return v instanceof SafeHtml;
}

function part(v) {
  if (v == null || v === false || v === true) return "";
  if (v instanceof SafeHtml) return v.s;
  if (Array.isArray(v)) return v.map(part).join("");
  return esc(v);
}

// Values are escaped; SafeHtml values (nested html``) are kept; arrays are joined;
// null, undefined, true and false render nothing (so `${cond && html`...`}` works).
export function html(strings, ...values) {
  let out = strings[0];
  for (let i = 0; i < values.length; i++) out += part(values[i]) + strings[i + 1];
  return new SafeHtml(out);
}

export function render(el, safe) {
  if (!el) return;
  el.innerHTML = safe instanceof SafeHtml ? safe.s : esc(safe);
}

export const $ = (sel, root = document) => (root ? root.querySelector(sel) : null);
export const $$ = (sel, root = document) => (root ? Array.from(root.querySelectorAll(sel)) : []);

const NON_BUBBLING = new Set(["focus", "blur", "mouseenter", "mouseleave", "load", "error", "toggle", "scroll"]);

// Delegated listener on root: handler(event, matchedElement) when the target is inside selector.
// selector null or '' listens on root itself. Returns the function that removes the listener.
export function on(root, type, selector, handler) {
  if (!root) return () => {};
  const capture = NON_BUBBLING.has(type);
  const fn = (e) => {
    if (!selector) {
      handler(e, root);
      return;
    }
    const t = e.target && e.target.closest ? e.target.closest(selector) : null;
    if (t && root.contains(t)) handler(e, t);
  };
  root.addEventListener(type, fn, capture);
  return () => root.removeEventListener(type, fn, capture);
}

// Only http(s) links without spaces are used as href; anything else gives ''.
export function safeUrl(u) {
  const s = String(u == null ? "" : u).trim();
  return /^https?:\/\/[^\s"'<>]+$/i.test(s) ? s : "";
}

export async function copyText(t) {
  const text = String(t == null ? "" : t);
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch (e) { /* fall back below */ }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.cssText = "position:fixed;top:0;left:0;opacity:0;pointer-events:none";
    (document.activeElement && document.activeElement.closest && document.activeElement.closest("dialog,[data-layer]") || document.body).appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return !!ok;
  } catch (e) {
    return false;
  }
}

// Resolves in a new task, so the browser can paint and handle input between the steps of a long job
// (G3-4: no task over 100 ms while 7,500 sites load). scheduler.yield() where there is one (it is not
// throttled in a background tab like a timer), else a 0 ms timer.
export function nextTask() {
  const s = typeof scheduler !== "undefined" ? scheduler : null;
  if (s && typeof s.yield === "function") return s.yield();
  return new Promise((r) => setTimeout(r, 0));
}

// Runs fn once the next frame has been painted (a 0 ms timer queued from that frame's animation
// callback). Returns the function that cancels it.
export function afterPaint(fn) {
  let timer = 0;
  if (typeof requestAnimationFrame !== "function") {
    timer = setTimeout(fn, 0);
    return () => clearTimeout(timer);
  }
  const frame = requestAnimationFrame(() => { timer = setTimeout(fn, 0); });
  return () => {
    cancelAnimationFrame(frame);
    clearTimeout(timer);
  };
}
