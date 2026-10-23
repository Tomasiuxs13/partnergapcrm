// What's new (spec 2.2.9): the one-time banner on Today and the modal it opens (also opened from Help).
// Owner F8. No side effects at import time.
//
// whatsNewBanner(ctx, slot): Today calls it once per mount with its empty banner slot. While the person has
// neither dismissed the banner nor opened What's new, it renders "The CRM has a new layout. [See what moved] ×"
// into the slot and returns null (Today then leaves the slot alone). Once dismissed or seen it stays away
// (localStorage pgcrm-dismiss-whatsnew; a blocked storage shows it again, which is harmless). Not shown in
// the read-only snapshot.
// openWhatsNew(): the modal with the old → new table (2.2.9). Every "Now" entry is a link to that place;
// following one closes the modal. Footer: "Old bookmarks still work."
// Styles live in css/pages/help.css (.hp-wn-*).
import { html, render, on } from "../core/dom.js";
import * as prefs from "../core/prefs.js";
import * as router from "../core/router.js";
import { openModal } from "../ui/dialog.js";

const SEEN_KEY = "pgcrm-dismiss-whatsnew";

// The table of spec 2.2.9. A "now" part is text, or [label, page, params] for a link.
export const MOVES = [
  { was: "Home", now: [["Today", "today"], " (your work) · ", ["Team overview", "team"], " (totals)"] },
  { was: "Tasks", now: [["Today › Do now", "today"], " · ", ["Sites › Waiting for reply › No reply in 14+ days", "sites", { tab: "waiting", quiet: "14" }]] },
  { was: "Prospecting", now: [["Sites › Mine to contact", "sites", { tab: "mine" }], " / ", ["Unowned", "sites", { tab: "unowned" }]] },
  { was: "All sites", now: [["Sites › All", "sites", { tab: "all" }]] },
  { was: "Partners", now: [["Records › Partners", "partners"], " · ", ["Deals › Live and Signed, not live", "deals"]] },
  { was: "Deals", now: [["Deals", "deals"]] },
  { was: "Campaigns", now: [["Clients", "clients"], " (numbers on each client page)"] },
  { was: "Team, Reports", now: [["Team overview", "team"]] },
  { was: "Change log", now: ["Footer sync line → ", ["Edit history", "history"]] },
  { was: "“Who are you?”", now: ["Pick your name when you sign in"] },
];

const isSnapshot = () => typeof window !== "undefined" && !!window.__SNAPSHOT__;

/** True once the person dismissed the banner or opened What's new. */
export function seen() {
  return prefs.get(SEEN_KEY) === "1";
}

function markSeen() {
  prefs.set(SEEN_KEY, "1");
}

function nowHtml(parts) {
  return parts.map((p) => (typeof p === "string"
    ? html`${p}`
    : html`<a href="${router.href(p[1], p[2] || {})}" data-wn-go>${p[0]}</a>`));
}

function tableHtml() {
  return html`<table class="hp-wn-table"><caption class="sr-only">Where things moved</caption><thead><tr><th scope="col">You used to go to</th><th scope="col">Now</th></tr></thead><tbody>${MOVES.map((m) => html`<tr><th scope="row">${m.was}</th><td>${nowHtml(m.now)}</td></tr>`)}</tbody></table>`;
}

let open = null;

/** Opens the What's new modal (one at a time). Returns {el, close}. */
export function openWhatsNew() {
  if (open) return open;
  markSeen();
  const m = openModal({
    title: "What's new",
    description: "The CRM has a new layout. Here is where everything moved.",
    body: tableHtml(),
    foot: "Old bookmarks still work.",
    actions: [{ label: "Got it", kind: "primary" }],
    className: "hp-wn-modal",
    size: "md",
    onClose: () => { open = null; },
  });
  // A link goes to its page; close the modal so the page shows.
  on(m.el, "click", "a[data-wn-go]", () => m.close());
  open = m;
  return m;
}

/**
 * The one-time Today banner. Renders into `slot` (Today's [data-td-banner]) and returns null; returns null
 * without rendering when it was dismissed or seen, or in the snapshot.
 */
export function whatsNewBanner(ctx, slot) {
  if (!slot || isSnapshot() || seen()) return null;
  render(slot, html`<div class="hp-wn-banner" role="status"><p class="hp-wn-msg"><span class="hp-wn-text">The CRM has a new layout.</span> <button type="button" class="ui-linkbtn hp-wn-open" data-wn-open>See what moved</button></p><button type="button" class="hp-wn-x" data-wn-dismiss aria-label="Dismiss this message"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg></button></div>`);
  const clear = () => render(slot, html``);
  on(slot, "click", "[data-wn-open]", () => {
    openWhatsNew();
    clear();
  });
  on(slot, "click", "[data-wn-dismiss]", () => {
    markSeen();
    clear();
    if (ctx && typeof ctx.announce === "function") ctx.announce("Message dismissed");
    const h1 = typeof document !== "undefined" ? document.querySelector("main h1") : null;
    if (h1) h1.focus({ preventScroll: true });
  });
  return null;
}
