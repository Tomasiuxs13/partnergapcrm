// Record panel: the sticky header (spec 4.2). Owner F1. No side effects at import time.
//   Queue strip (queue mode only): "‹ 3 of 17 · Do now ›".
//   Line 1: avatar, label (h2), small ID · domain ↗ · NEW- dot, [Copy email] [Visit site ↗] ⋯ ×.
//   Line 2: display-only stage path, Stage ▾ pill, owner chip, client tags, "Waiting on client"
//           (Replied and Negotiating only).
//   Line 3: what the site says about itself, one line ("more" expands it), loaded lazily.
// On a phone (< 640 px) record.css shows × as ‹ on the left and hides Copy email, Visit site and ⋯ (the
// sticky footer has ⋯, and its menu holds them).
import { html, raw, safeUrl } from "../../core/dom.js";
import { stagePath, stagePill, ownerChip, clientTags, avatar, newDot } from "../../ui/pills.js";
import { queueHtml } from "./queue.js";

const X_ICON = raw('<svg class="rc-ic-x" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>' +
  '<svg class="rc-ic-back" viewBox="0 0 24 24" aria-hidden="true"><path d="M15 5l-7 7 7 7"/></svg>');
const DOTS = raw('<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/></svg>');

const WAITING_STAGES = ["Replied", "Negotiating"];

// "https://example.test" for a domain or channel path ("youtube.com/@name"), or "".
export function siteUrl(r) {
  const d = String((r && r.domain) || "").trim().replace(/^https?:\/\//i, "");
  return d ? safeUrl("https://" + d) : "";
}

export function labelOf(r) {
  return (r && (r.label || r.domain || r.id)) || "";
}

export function titleText(r) {
  return labelOf(r);
}

export function subHtml(r) {
  const url = siteUrl(r);
  const domain = r.domain ? String(r.domain) : "";
  return html`<span class="ui-id">${r.id}</span>${domain
    ? html`<span aria-hidden="true">·</span>${url ? html`<a class="rc-domain" href="${url}" target="_blank" rel="noopener noreferrer">${domain} <span aria-hidden="true">↗</span></a>` : html`<span>${domain}</span>`}`
    : ""}${newDot(r)}`;
}

// Copy email / Visit site / ⋯. emailState: 'none' (no contacts), 'ready', 'noemail' (contacts, none with an
// email), 'unknown' (contacts, not loaded yet). copyEmail: false leaves Copy email out (a snapshot holds no email).
export function toolsHtml(r, { emailState = "unknown", copyEmail = true } = {}) {
  const url = siteUrl(r);
  const noEmail = emailState === "none" || emailState === "noemail";
  const tip = emailState === "none" ? "No contacts yet" : emailState === "noemail" ? "No contact has an email yet" : "Copies the main contact's email";
  return html`${copyEmail ? html`<button type="button" class="ui-btn is-sm rc-tool" data-pact="copy-email" title="${tip}"${noEmail ? raw(" disabled") : ""}>Copy email</button>` : ""}${url
    ? html`<a class="ui-btn is-sm rc-tool" href="${url}" target="_blank" rel="noopener noreferrer" data-pact="visit">Visit site <span aria-hidden="true">↗</span></a>` : ""}<button type="button" class="ui-x rc-tool rc-dots" data-pact="more" aria-haspopup="menu" aria-label="More actions">${DOTS}</button>`;
}

export function waitingHtml(r, { readOnly = false, roText = "" } = {}) {
  if (!r || (!WAITING_STAGES.includes(r.stage) && !r.waitingOnClient)) return html``;
  return html`<label class="ui-check rc-wait"${readOnly ? html` title="${roText}"` : ""}><input type="checkbox" data-pwait${r.waitingOnClient ? raw(" checked") : ""}${readOnly ? raw(" disabled") : ""}><span>Waiting on client</span></label>`;
}

export function metaHtml(r, opts = {}) {
  return html`${stagePath(r)}${stagePill(r)}<span class="rc-meta-rest">${ownerChip(r)}${clientTags(r, { max: 4, emptyText: "No client", add: true })}${waitingHtml(r, opts)}</span>`;
}

// The About line: description (else title) of the site, from the profile or GET …/about.
export function aboutText(about) {
  if (!about || typeof about !== "object") return "";
  const d = String(about.description || "").replace(/\s+/g, " ").trim();
  const t = String(about.title || "").replace(/\s+/g, " ").trim();
  return d || t;
}

export function aboutHtml(text, open) {
  if (!text) return html``;
  const long = text.length > 90;
  return html`<span class="rc-about-text">${text}</span>${long ? html` <button type="button" class="ui-linkbtn rc-about-more" data-pabout-more aria-expanded="${open ? "true" : "false"}">${open ? "less" : "more"}</button>` : ""}`;
}

// The whole header. st: {queue, aboutText, aboutOpen, emailState}; exists(id) tells the queue strip which
// neighbours are loaded.
export function renderHeader(r, st, { readOnly = false, roText = "", exists } = {}) {
  const label = labelOf(r);
  const about = st.aboutText || "";
  return html`<header class="ui-panel-head rc-head">
<div class="rc-qrow" data-pqueue${st.queue ? "" : raw(" hidden")}>${queueHtml(st.queue, exists)}</div>
<div class="ui-panel-top rc-top">${avatar(label, { size: "lg" })}<div class="ui-panel-title rc-title"><h2 id="rp-title" tabindex="-1" data-ptitle>${label}</h2><p class="ui-panel-sub rc-sub" data-psub>${subHtml(r)}</p></div><div class="rc-tools" data-ptools>${toolsHtml(r, st)}</div><button type="button" class="ui-x rc-close" data-pclose="x" aria-label="Close">${X_ICON}</button></div>
<div class="ui-panel-meta rc-meta" data-pmeta>${metaHtml(r, { readOnly, roText })}</div>
<p class="rc-about${st.aboutOpen ? " is-open" : ""}" data-pabout${about ? "" : raw(" hidden")}>${aboutHtml(about, st.aboutOpen)}</p>
</header>`;
}
