// Keyboard shortcuts (spec 4.6). Owner G1-A. One of the two modules with global listeners (with
// shell.js). Disabled while typing, except Esc and Ctrl/Cmd+K. No side effects at import time.
//   Ctrl/Cmd+K, /  Search             n  Add site            Enter  open the focused [data-rec] row
//   Esc            close the innermost layer: menus, popovers and dialogs close themselves (Popover
//                  API and <dialog>); the record panel closes through handlers.escape()
//   J / K          next / previous site in queue mode (handlers.queue(+1 | -1))
// app.js passes the handlers, so this core module never imports feature modules.
let handlers = {};
let started = false;

function typing(el) {
  if (!el || el.nodeType !== 1) return false;
  if (el.isContentEditable) return true;
  if (el.tagName === "TEXTAREA" || el.tagName === "SELECT") return true;
  if (el.tagName === "INPUT") return !/^(checkbox|radio|button|submit|reset|range|color|file)$/i.test(el.type || "");
  return false;
}

// A menu, popover or modal dialog is open: it handles Esc itself.
function layerOpen() {
  try {
    if (document.querySelector(":popover-open")) return true;
  } catch (e) { /* no Popover API */ }
  return !!document.querySelector("dialog[open]");
}

function call(name, ...args) {
  const fn = handlers[name];
  if (typeof fn !== "function") return false;
  fn(...args);
  return true;
}

function onKey(e) {
  if (e.defaultPrevented || e.isComposing) return;
  const k = e.key;
  if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && (k === "k" || k === "K")) {
    if (call("search")) e.preventDefault();
    return;
  }
  if (k === "Escape") {
    if (!layerOpen()) call("escape", e);
    return;
  }
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (typing(e.target)) return;
  if (k === "/") {
    if (call("search")) e.preventDefault();
  } else if (k === "n") {
    if (call("addSite")) e.preventDefault();
  } else if (k === "j" || k === "J") {
    if (!layerOpen()) call("queue", 1);
  } else if (k === "k" || k === "K") {
    if (!layerOpen()) call("queue", -1);
  } else if (k === "Enter") {
    const row = e.target && e.target.closest ? e.target.closest("[data-rec]") : null;
    if (row && !e.target.closest("a[href],button,input,select,textarea,summary")) {
      if (call("open", row.getAttribute("data-rec"))) e.preventDefault();
    }
  }
}

// handlers: {search(), addSite(), escape(event), queue(dir), open(id)}; any may be left out.
export function start(h = {}) {
  handlers = Object.assign({}, h);
  if (started || typeof document === "undefined") return;
  started = true;
  document.addEventListener("keydown", onKey);
}
