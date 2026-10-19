// <dialog> modals with a focus trap, and confirm (spec 4.13, 5.4). Owner G1-C. No side effects at import.
//
// openModal() uses showModal(): the page behind is inert, Esc and the × close it, and Tab wraps
// inside the dialog. Menus and popovers opened from inside mount into the dialog (menu.js), and the
// toast region moves into it while it is open (toast.js raiseToasts), so toasts stay on top and
// clickable. Below 640 px components.css shows modals as bottom sheets.
import { html, render, isSafe } from "../core/dom.js";
import { raiseToasts, releaseToasts } from "./toast.js";

let seq = 0;

const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]):not([type=hidden]),select:not([disabled]),' +
  'textarea:not([disabled]),[tabindex]:not([tabindex="-1"]),summary';

function focusables(root) {
  return Array.from(root.querySelectorAll(FOCUSABLE)).filter((el) => {
    if (el.closest("[popover]") && !el.closest("[popover]").matches(":popover-open")) return false;
    if (el.closest("[inert]")) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 || r.height > 0;
  });
}

// Tab and Shift+Tab stay inside the dialog (popovers it holds included).
export function trapFocus(root) {
  const onKey = (e) => {
    if (e.key !== "Tab") return;
    const list = focusables(root);
    if (!list.length) {
      e.preventDefault();
      return;
    }
    const first = list[0];
    const last = list[list.length - 1];
    const active = document.activeElement;
    if (e.shiftKey && (active === first || !root.contains(active))) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && (active === last || !root.contains(active))) {
      e.preventDefault();
      first.focus();
    }
  };
  root.addEventListener("keydown", onKey);
  return () => root.removeEventListener("keydown", onKey);
}

function bodyHtml(body) {
  if (body == null) return html``;
  if (isSafe(body)) return body;
  return html`<p>${String(body)}</p>`;
}

// openModal({title, body, actions, size, onClose, canClose, className, description})
//   body: html`` (or text, or a DOM node); actions: [{label, value, kind: 'primary'|'danger'|'ghost',
//   onClick(modal) -> false keeps it open, disabled, autofocus}]. With actions the body and footer
//   sit in one <form method="dialog">, so Enter in a field submits the first submit/primary action.
//   size: 'sm' | 'md' (default) | 'lg'. canClose(value) -> boolean|Promise<boolean> guards ×, Esc and
//   the backdrop (the unsaved-text guard). onClose(value) runs once after it closes.
// Returns {el, body, close(value), result}: result resolves with the value it closed with
//   (an action's value, or null for ×/Esc).
export function openModal({ title = "", body, actions = [], size = "md", onClose, canClose, className = "", description = "" } = {}) {
  const id = "ui-modal-" + ++seq;
  const el = document.createElement("dialog");
  el.className = "ui-modal is-" + (size || "md") + (className ? " " + className : "");
  el.setAttribute("aria-labelledby", id + "-h");
  if (description) el.setAttribute("aria-describedby", id + "-d");
  const acts = (actions || []).filter(Boolean);
  const primaryIndex = acts.findIndex((a) => a.type === "submit" || a.kind === "primary" || a.kind === "danger");
  const foot = acts.length
    ? html`<footer class="ui-modal-foot">${acts.map((a, i) => html`<button type="${i === primaryIndex ? "submit" : "button"}" class="ui-btn${a.kind === "primary" ? " is-primary" : a.kind === "danger" ? " is-danger" : a.kind === "ghost" ? " is-ghost" : ""}" data-a="${i}"${a.disabled ? html` disabled` : ""}${a.autofocus ? html` autofocus` : ""}>${a.label}</button>`)}</footer>`
    : "";
  render(el, html`<form method="dialog" class="ui-modal-form" novalidate>
<header class="ui-modal-head"><h2 id="${id}-h" class="ui-modal-title" tabindex="-1">${title}</h2><button type="button" class="ui-x" data-a="x" aria-label="Close"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg></button></header>
<div class="ui-modal-body">${description ? html`<p id="${id}-d" class="ui-modal-desc">${description}</p>` : ""}<div data-body></div></div>
${foot}
</form>`);
  const bodyEl = el.querySelector("[data-body]");
  if (body && typeof body === "object" && body.nodeType === 1) bodyEl.appendChild(body);
  else render(bodyEl, bodyHtml(body));

  const opener = document.activeElement;
  let closed = false;
  let resolveResult;
  const result = new Promise((r) => { resolveResult = r; });
  let value = null;

  const modal = { el, body: bodyEl, close: (v) => doClose(v === undefined ? null : v, true), result };

  async function allowed(v) {
    if (!canClose) return true;
    try { return (await canClose(v)) !== false; } catch (e) { return false; }
  }

  async function doClose(v, force) {
    if (closed) return;
    if (!force && !(await allowed(v))) return;
    closed = true;
    value = v;
    if (el.open) el.close();
    else finish();
  }

  function finish() {
    untrap();
    releaseToasts(el);
    el.remove();
    if (opener && opener.isConnected && typeof opener.focus === "function") {
      try { opener.focus({ preventScroll: true }); } catch (e) { /* not focusable */ }
    }
    resolveResult(value);
    if (onClose) {
      try { onClose(value); } catch (e) { if (typeof console !== "undefined") console.error(e); }
    }
  }

  el.addEventListener("close", () => {
    if (!closed) {
      closed = true;
      value = null;
    }
    finish();
  });
  // Esc: guard first, then close ourselves (the browser would close it without asking).
  el.addEventListener("cancel", (e) => {
    e.preventDefault();
    doClose(null, false);
  });
  el.addEventListener("click", async (e) => {
    if (e.target === el) {
      // A click on the backdrop (outside the dialog box).
      const r = el.getBoundingClientRect();
      const inside = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
      if (!inside) doClose(null, false);
      return;
    }
    const b = e.target.closest("[data-a]");
    if (!b || !el.contains(b) || b.closest(".ui-modal-form") !== el.querySelector(".ui-modal-form")) return;
    const a = b.getAttribute("data-a");
    if (a === "x") {
      e.preventDefault();
      doClose(null, false);
      return;
    }
    if (b.type === "submit") return; // handled by submit below
    e.preventDefault();
    await runAction(Number(a));
  });
  el.querySelector(".ui-modal-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    if (primaryIndex >= 0) await runAction(primaryIndex);
  });

  async function runAction(i) {
    const a = acts[i];
    if (!a || a.disabled) return;
    let keep = false;
    if (typeof a.onClick === "function") {
      try {
        keep = (await a.onClick(modal)) === false;
      } catch (err) {
        keep = true;
        if (typeof console !== "undefined") console.error(err);
      }
    }
    if (!keep) doClose(a.value !== undefined ? a.value : a.label, true);
  }

  const untrap = trapFocus(el);
  document.body.appendChild(el);
  el.showModal();
  raiseToasts(el);
  const first = el.querySelector("[autofocus]") || focusables(bodyEl)[0] || el.querySelector('footer [type="submit"]') || el.querySelector(".ui-modal-title");
  if (first) first.focus({ preventScroll: true });
  return modal;
}

// confirm({title, body, confirmLabel, cancelLabel, danger}) -> Promise<boolean>
export async function confirm({ title = "Are you sure?", body = "", confirmLabel = "OK", cancelLabel = "Cancel", danger = false } = {}) {
  const m = openModal({
    title,
    body: body ? (isSafe(body) ? body : html`<p>${body}</p>`) : null,
    size: "sm",
    actions: [
      { label: cancelLabel, value: false, kind: "ghost", autofocus: !!danger },
      { label: confirmLabel, value: true, kind: danger ? "danger" : "primary" },
    ],
  });
  const v = await m.result;
  return v === true;
}
