// Toasts in the #toasts popover region (spec 4.9). Owner G1-C. No side effects at import time.
//
// - #toasts (index.html) is a popover="manual" element outside .app, so toasts render in the top
//   layer. raiseToasts() hides and re-shows it, which puts it above a <dialog> opened after it;
//   openModal() calls it after showModal(); shell.js re-shows it for the More sheet, and the next toast()
//   moves the region into that sheet too (any modal dialog counts, see topModal()).
// - Everything outside a modal <dialog> is inert, so a toast above it would show but not take clicks.
//   raiseToasts(dialog) therefore moves the region into that dialog while it is open (still in the top
//   layer, now clickable), and releaseToasts(dialog) moves it back when the dialog closes.
// - Bottom-left on desktop, above the bottom tabs on compact screens (--tabs-h). At most 3.
// - Success and info close after 6 s, with Undo after 8 s; hovering or focusing a toast pauses it.
//   Errors stay until closed and carry an action; they also get role="alert".
import { html, render, isSafe } from "../core/dom.js";

const MAX = 3;
const live = [];

function region() {
  if (typeof document === "undefined") return null;
  let el = document.getElementById("toasts");
  if (!el) {
    el = document.createElement("div");
    el.id = "toasts";
    el.setAttribute("popover", "manual");
    document.body.appendChild(el);
  }
  if (!el.hasAttribute("aria-live")) el.setAttribute("aria-live", "polite");
  el.classList.add("ui-toasts");
  return el;
}

const isOpen = (el) => {
  try { return el.matches(":popover-open"); } catch (e) { return false; }
};

function show(el) {
  try { if (!isOpen(el)) el.showPopover(); } catch (e) { /* no Popover API: it is a fixed element */ }
}

function hide(el) {
  try { if (isOpen(el)) el.hidePopover(); } catch (e) { /* already hidden */ }
}

const watched = new WeakSet();

// The innermost open modal dialog (openModal dialogs, the shell's More sheet, any showModal() dialog).
// Browsers without :modal fall back to openModal dialogs and dialogs marked data-toasts.
function topModal() {
  let list;
  try {
    list = Array.from(document.querySelectorAll("dialog:modal"));
  } catch (e) {
    list = Array.from(document.querySelectorAll("dialog.ui-modal[open], dialog[data-toasts][open]"));
  }
  return list.length ? list[list.length - 1] : null;
}

function watch(host) {
  if (watched.has(host)) return;
  watched.add(host);
  host.addEventListener("close", () => {
    watched.delete(host);
    releaseToasts(host);
  }, { once: true });
}

// Puts the region back on top of the top layer (call after a dialog opens). With host (an open modal
// <dialog>), the region moves into it so its buttons stay clickable while the dialog is open.
export function raiseToasts(host) {
  if (typeof document === "undefined") return;
  const el = document.getElementById("toasts");
  if (!el) return;
  if (host && host.tagName === "DIALOG" && host.open && el.parentNode !== host) {
    hide(el);
    host.appendChild(el);
    watch(host);
  }
  if (!live.length) return;
  hide(el);
  show(el);
}

// Moves the region out of a dialog that is closing: into the next open modal, else back to <body>.
// openModal() calls it before it removes its dialog.
export function releaseToasts(host) {
  if (typeof document === "undefined") return;
  const el = document.getElementById("toasts");
  if (!el || !host || el.parentNode !== host) return;
  hide(el);
  const next = topModal();
  const target = next && next !== host ? next : document.body;
  target.appendChild(el);
  if (target !== document.body) watch(target);
  if (live.length) show(el);
}

function icon(kind) {
  if (kind === "error") return html`<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7.5v5.5M12 16.5h.01"/></svg>`;
  if (kind === "success") return html`<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>`;
  return html`<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 11v5.5M12 7.5h.01"/></svg>`;
}

// toast(message, {kind: 'info'|'success'|'error', undo: async fn, action: {label, fn}, sticky, timeout})
// -> {el, close(), update(message)}. message is text or html``.
export function toast(message, { kind = "info", undo, action, sticky, timeout } = {}) {
  const box = region();
  if (!box) return { el: null, close() {}, update() {} };
  const k = kind === "error" || kind === "success" ? kind : "info";
  const el = document.createElement("div");
  el.className = "ui-toast is-" + k;
  if (k === "error") el.setAttribute("role", "alert");
  else el.setAttribute("role", "status");
  const msg = isSafe(message) ? message : String(message == null ? "" : message);
  render(el, html`<span class="ui-toast-icon">${icon(k)}</span><span class="ui-toast-msg">${msg}</span>${action && action.label
    ? html`<button type="button" class="ui-toast-btn" data-t="action">${action.label}</button>` : ""}${typeof undo === "function"
    ? html`<button type="button" class="ui-toast-btn" data-t="undo">Undo</button>` : ""}<button type="button" class="ui-toast-x" data-t="close" aria-label="Close"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg></button>`);

  let timer = null;
  let closed = false;
  const ms = timeout != null ? Number(timeout) : sticky || k === "error" ? 0 : typeof undo === "function" ? 8000 : 6000;
  const start = () => {
    clearTimeout(timer);
    if (ms > 0 && !closed) timer = setTimeout(close, ms);
  };
  const stop = () => clearTimeout(timer);

  function close() {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    const i = live.indexOf(handle);
    if (i >= 0) live.splice(i, 1);
    const hadFocus = el.contains(document.activeElement);
    el.remove();
    if (!live.length) hide(box);
    if (hadFocus) {
      const next = box.querySelector(".ui-toast-btn, .ui-toast-x");
      if (next) next.focus();
    }
  }

  el.addEventListener("click", async (e) => {
    const b = e.target.closest("[data-t]");
    if (!b) return;
    const t = b.getAttribute("data-t");
    if (t === "close") return close();
    for (const x of el.querySelectorAll("button")) x.disabled = true;
    try {
      if (t === "undo") await undo();
      else if (t === "action") await action.fn();
    } catch (err) {
      if (typeof console !== "undefined") console.error(err);
    }
    close();
  });
  el.addEventListener("mouseenter", stop);
  el.addEventListener("mouseleave", start);
  el.addEventListener("focusin", stop);
  el.addEventListener("focusout", (e) => { if (!el.contains(e.relatedTarget)) start(); });

  const handle = {
    el,
    close,
    update(next) {
      const m = el.querySelector(".ui-toast-msg");
      if (m) render(m, isSafe(next) ? next : html`${String(next == null ? "" : next)}`);
    },
  };
  live.push(handle);
  box.appendChild(el);
  while (live.length > MAX) live[0].close();
  // Above (and inside) the modal that is open now; a dialog opened later calls raiseToasts().
  const modal = topModal();
  if (modal) raiseToasts(modal);
  else if (document.querySelector("dialog[open]")) {
    hide(box);
    show(box);
  } else {
    show(box);
  }
  start();
  return handle;
}

// Closes every toast (used by tests and on sign-out).
export function clearToasts() {
  for (const t of live.slice()) t.close();
}
