// Menus and popovers in the top layer (Popover API; mount rules in spec 4.13), and isBusy().
// Owner G1-C. No side effects at import time.
//
// - Both mount into anchor.closest('dialog,[data-layer]') or else document.body. With the Popover API
//   they render in the top layer, so they are clickable inside a modal <dialog> and inside the record
//   panel (#layer-panel) while .app is inert.
// - popover="auto": a click outside or Esc closes them (the browser does it; no global listeners).
//   A click on the anchor that just closed its menu does not open it again (toggle behaviour).
// - Phone (< 640 px): components.css shows them as sheets at the bottom of the screen.
// - isBusy() is true while a menu, popover or inline editor is open; store.js holds its notifications
//   meanwhile (app.js also asks record.isDirty()).
import { html, render, isSafe, raw } from "../core/dom.js";
import { normName } from "../core/format.js";

const openLayers = new Set();
const closers = new Map();
let holds = 0;
let lastClose = { anchor: null, at: 0 };
let seq = 0;

// True while a menu, popover or inline editor is open.
export function isBusy() {
  return openLayers.size > 0 || holds > 0;
}

// For editors that are not popovers (for example a form inside the record panel): marks the UI busy
// until the returned function is called.
export function holdBusy() {
  holds++;
  let done = false;
  return () => {
    if (done) return;
    done = true;
    holds = Math.max(0, holds - 1);
  };
}

// Where a menu or popover for this anchor is mounted (spec 4.13).
export function mountRoot(anchor) {
  const host = anchor && anchor.closest ? anchor.closest("dialog,[data-layer]") : null;
  return host || document.body;
}

// Closes every open menu and popover inside root (all of them without a root), for example when the
// record panel closes. Returns how many it closed.
export function closeAll(root) {
  let n = 0;
  for (const el of Array.from(openLayers)) {
    if (root && !(root === el || (root.contains && root.contains(el)))) continue;
    const fn = closers.get(el);
    if (fn) fn();
    else {
      openLayers.delete(el);
      el.remove();
    }
    n++;
  }
  return n;
}

const isOpen = (el) => {
  try { return el.matches(":popover-open"); } catch (e) { return false; }
};

// Below the anchor, left-aligned; flips above or right-aligned when there is no room.
export function place(el, anchor) {
  const vw = document.documentElement.clientWidth || window.innerWidth;
  const vh = window.innerHeight;
  const pad = 8;
  const a = anchor && anchor.isConnected && anchor.getBoundingClientRect
    ? anchor.getBoundingClientRect()
    : { left: vw / 2 - 120, right: vw / 2 + 120, top: vh / 3, bottom: vh / 3 };
  el.style.left = "0px";
  el.style.top = "0px";
  const r = el.getBoundingClientRect();
  let left = a.left;
  if (left + r.width > vw - pad) left = a.right - r.width;
  left = Math.max(pad, Math.min(left, vw - pad - r.width));
  let top = a.bottom + 4;
  if (top + r.height > vh - pad) {
    const above = a.top - 4 - r.height;
    top = above >= pad ? above : Math.max(pad, vh - pad - r.height);
  }
  el.style.left = Math.round(left) + "px";
  el.style.top = Math.round(top) + "px";
}

function justClosed(anchor) {
  return !!anchor && lastClose.anchor === anchor && Date.now() - lastClose.at < 350;
}

function returnFocus(el, anchor) {
  const active = document.activeElement;
  const inside = !active || active === document.body || el.contains(active);
  if (inside && anchor && anchor.isConnected && typeof anchor.focus === "function") {
    try { anchor.focus({ preventScroll: true }); } catch (e) { /* not focusable */ }
  }
}

// ---------- Menus ----------

// items: [{label, value, desc, hint, danger, disabled, checked}] plus {divider: true},
// {heading: 'Text'} and {label: 'More', more: [items]} (expands in place).
function itemsHtml(list, filter) {
  const q = normName(filter || "");
  const out = [];
  let any = false;
  list.forEach((it, i) => {
    if (!it) return;
    if (it.divider) {
      if (!q) out.push(html`<div class="ui-msep" role="separator"></div>`);
      return;
    }
    if (it.heading) {
      if (!q) out.push(html`<div class="ui-mh" role="presentation">${it.heading}</div>`);
      return;
    }
    if (q && !normName(it.label + " " + (it.desc || "")).includes(q)) return;
    any = true;
    const role = it.checked != null ? "menuitemradio" : "menuitem";
    out.push(html`<button type="button" class="ui-mi${it.danger ? " is-danger" : ""}${it.more ? " is-more" : ""}${it.checked ? " is-on" : ""}" role="${role}" data-i="${i}"${it.checked != null ? raw(' aria-checked="' + (it.checked ? "true" : "false") + '"') : ""}${it.disabled ? raw(' aria-disabled="true"') : ""}${it.more ? raw(' aria-expanded="false"') : ""}><span class="ui-mi-main"><span class="ui-mi-label">${it.label}</span>${it.desc ? html`<span class="ui-mi-desc">${it.desc}</span>` : ""}</span>${it.hint ? html`<span class="ui-mi-hint">${it.hint}</span>` : ""}${it.more ? html`<span class="ui-mi-hint" aria-hidden="true">▾</span>` : ""}</button>`);
  });
  if (!any) out.push(html`<p class="ui-mempty">No matches</p>`);
  return out;
}

function enabledItems(el) {
  return Array.from(el.querySelectorAll(".ui-mi")).filter((b) => b.getAttribute("aria-disabled") !== "true");
}

function move(el, dir) {
  const list = enabledItems(el);
  if (!list.length) return;
  const i = list.indexOf(document.activeElement);
  const next = dir === "first" ? 0 : dir === "last" ? list.length - 1 : i < 0 ? (dir > 0 ? 0 : list.length - 1) : (i + dir + list.length) % list.length;
  list[next].focus();
}

// Opens a menu next to the anchor. Resolves with the picked item's value (its label when it has no
// value), or null when the menu closes without a pick. search: true adds a filter box at the top.
export function openMenu(anchorEl, { items = [], search = false, label = "", className = "" } = {}) {
  return new Promise((resolve) => {
    if (typeof document === "undefined" || justClosed(anchorEl)) {
      resolve(null);
      return;
    }
    const list = (items || []).filter(Boolean).slice();
    const host = mountRoot(anchorEl);
    const el = document.createElement("div");
    const id = "ui-menu-" + ++seq;
    el.id = id;
    el.className = "ui-menu" + (className ? " " + className : "");
    el.setAttribute("popover", "auto");
    let picked = null;
    let pickedSet = false;
    let filter = "";

    function draw() {
      const body = html`<div class="ui-mlist" role="menu" aria-label="${label || "Options"}">${itemsHtml(list, filter)}</div>`;
      if (search) {
        const box = el.querySelector(".ui-msearch");
        if (box) {
          render(el.querySelector(".ui-mlist-wrap"), body);
          return;
        }
        render(el, html`<input type="search" class="ui-msearch" placeholder="Search…" aria-label="${"Filter " + (label || "options")}" autocomplete="off" spellcheck="false"><div class="ui-mlist-wrap">${body}</div>`);
      } else {
        render(el, body);
      }
    }

    function pick(i) {
      const it = list[i];
      if (!it || it.disabled) return;
      if (it.more) {
        list.splice(i, 1, ...it.more);
        draw();
        place(el, anchorEl);
        const first = el.querySelector('.ui-mi[data-i="' + i + '"]');
        if (first) first.focus();
        return;
      }
      picked = it.value !== undefined ? it.value : it.label;
      pickedSet = true;
      try { el.hidePopover(); } catch (e) { finish(); }
    }

    let finished = false;
    function finish() {
      if (finished) return;
      finished = true;
      openLayers.delete(el);
      closers.delete(el);
      if (!pickedSet) lastClose = { anchor: anchorEl, at: Date.now() };
      returnFocus(el, anchorEl);
      el.remove();
      if (anchorEl && anchorEl.getAttribute && anchorEl.getAttribute("aria-controls") === id) anchorEl.setAttribute("aria-expanded", "false");
      resolve(pickedSet ? picked : null);
    }

    el.addEventListener("click", (e) => {
      const b = e.target.closest(".ui-mi");
      if (b && el.contains(b)) pick(Number(b.getAttribute("data-i")));
    });
    el.addEventListener("keydown", (e) => {
      const inSearch = e.target.classList && e.target.classList.contains("ui-msearch");
      if (e.key === "ArrowDown") { e.preventDefault(); move(el, inSearch ? "first" : 1); }
      else if (e.key === "ArrowUp") { e.preventDefault(); if (!inSearch) move(el, -1); }
      else if (e.key === "Home" && !inSearch) { e.preventDefault(); move(el, "first"); }
      else if (e.key === "End" && !inSearch) { e.preventDefault(); move(el, "last"); }
      else if (e.key === "Enter" && inSearch) {
        e.preventDefault();
        const first = enabledItems(el)[0];
        if (first) pick(Number(first.getAttribute("data-i")));
      } else if (e.key === "Tab") {
        try { el.hidePopover(); } catch (x) { finish(); }
      }
    });
    el.addEventListener("input", (e) => {
      if (!e.target.classList.contains("ui-msearch")) return;
      filter = e.target.value;
      draw();
    });
    el.addEventListener("toggle", (e) => {
      if (e.newState === "closed") finish();
    });

    draw();
    host.appendChild(el);
    openLayers.add(el);
    closers.set(el, () => {
      pickedSet = false;
      try { if (isOpen(el)) el.hidePopover(); } catch (e) { /* already closed */ }
      finish();
    });
    try {
      el.showPopover();
    } catch (e) {
      finish();
      return;
    }
    if (anchorEl && anchorEl.setAttribute) {
      anchorEl.setAttribute("aria-controls", id);
      anchorEl.setAttribute("aria-expanded", "true");
    }
    place(el, anchorEl);
    const first = search ? el.querySelector(".ui-msearch") : el.querySelector(".ui-mi.is-on") || enabledItems(el)[0];
    if (first) first.focus({ preventScroll: true });
  });
}

// ---------- Popovers ----------

// A small form or panel next to the anchor. content: html`` (or text). onOpen(el) runs after it is
// shown (bind events there with dom.on); onClose() after it closes. manual: true keeps it open on
// outside clicks (Esc and close() still close it). Returns {el, close}.
export function openPopover(anchorEl, safeHtml, { onOpen, onClose, label = "", className = "", role = "dialog", manual = false } = {}) {
  if (typeof document === "undefined") return { el: null, close() {} };
  if (justClosed(anchorEl)) return { el: null, close() {} };
  const host = mountRoot(anchorEl);
  const el = document.createElement("div");
  el.id = "ui-pop-" + ++seq;
  el.className = "ui-pop" + (className ? " " + className : "");
  el.setAttribute("popover", manual ? "manual" : "auto");
  if (role) el.setAttribute("role", role);
  if (label) el.setAttribute("aria-label", label);
  render(el, isSafe(safeHtml) ? safeHtml : html`${safeHtml}`);
  let finished = false;
  let byCode = false;
  let ro = null;
  function finish() {
    if (finished) return;
    finished = true;
    openLayers.delete(el);
    closers.delete(el);
    if (ro) ro.disconnect();
    if (!byCode) lastClose = { anchor: anchorEl, at: Date.now() };
    returnFocus(el, anchorEl);
    el.remove();
    if (onClose) {
      try { onClose(); } catch (e) { if (typeof console !== "undefined") console.error(e); }
    }
  }
  function close() {
    if (finished) return;
    byCode = true;
    try {
      if (isOpen(el)) el.hidePopover();
      else finish();
    } catch (e) {
      finish();
    }
    // The toggle event is async; make sure the state is final when close() returns.
    finish();
  }
  el.addEventListener("toggle", (e) => {
    if (e.newState === "closed") finish();
  });
  el.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && manual) {
      e.preventDefault();
      close();
    }
  });
  host.appendChild(el);
  openLayers.add(el);
  closers.set(el, close);
  try {
    el.showPopover();
  } catch (e) {
    finish();
    return { el: null, close() {} };
  }
  place(el, anchorEl);
  if (onOpen) {
    try { onOpen(el); } catch (e) { if (typeof console !== "undefined") console.error(e); }
  }
  // The content can grow after it opens (onOpen renders, errors show, groups expand): keep it on screen.
  place(el, anchorEl);
  if (typeof ResizeObserver !== "undefined") {
    let last = "";
    ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect();
      const key = Math.round(r.width) + "x" + Math.round(r.height);
      if (key === last || finished) return;
      last = key;
      place(el, anchorEl);
    });
    ro.observe(el);
  }
  const first = el.querySelector("[autofocus]") || el.querySelector("input:not([type=hidden]),select,textarea,button");
  if (first && document.activeElement && !el.contains(document.activeElement)) first.focus({ preventScroll: true });
  return { el, close };
}
