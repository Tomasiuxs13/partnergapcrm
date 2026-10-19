// Record panel: Details (spec 4.2), collapsed by default; "Show all fields" opens it. Type (pick-list,
// inline edit), DR, traffic, top country, source, seed keyword and "Last edited on the site by X, date".
// Owner F1. No side effects at import time.
import { html, raw } from "../../core/dom.js";
import { date as fmtDate, num } from "../../core/format.js";

const PEN = raw('<svg class="rc-pen" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16v4z"/></svg>');

function row(label, value, title) {
  const v = value == null || value === "" ? html`<span class="rc-muted">–</span>` : value;
  return html`<dt${title ? html` title="${title}"` : ""}>${label}</dt><dd>${v}</dd>`;
}

// "Last edited on the site by Gaby, Thu 15 Oct" ("…, today"), or "".
export function lastEdited(r, today) {
  if (!r || !r.updated_by) return "";
  const day = r.updated_at ? String(r.updated_at).slice(0, 10) : "";
  const at = !day ? "" : day === today ? "today" : fmtDate(r.updated_at, today && day.slice(0, 4) !== today.slice(0, 4) ? "year" : "short");
  return "Last edited on the site by " + r.updated_by + (at ? ", " + at : "");
}

// st: {profile, detailsOpen, showAll}.
export function renderDetails(r, st, { today, readOnly = false } = {}) {
  const p = st.profile && st.profile.partner ? st.profile.partner : {};
  const type = r.type ? String(r.type) : "";
  const typeCell = readOnly
    ? (type || html`<span class="rc-muted">Type not set</span>`)
    : html`<button type="button" class="ui-next is-edit rc-type" data-edit="type" data-id="${r.id}" aria-haspopup="menu" aria-label="${"Type: " + (type || "not set") + ". Change type"}">${type || html`<span class="rc-muted">Type not set</span>`} ${PEN}</button>`;
  const seed = p.seed_keyword != null ? p.seed_keyword : "";
  const edited = lastEdited(r, today);
  const open = st.detailsOpen || st.showAll;
  return html`<details class="rc-details" data-pdetails${open ? raw(" open") : ""}><summary class="rc-summary"><span class="ui-card-title rc-card-title" id="rc-det-h">Details</span></summary><dl class="rc-dl">
${row("Type", typeCell)}${row("DR", r.dr != null ? num(r.dr) : "", "Ahrefs domain rating, 0–100")}${row("Traffic", r.traffic != null ? num(r.traffic) : "")}${row("Top country", r.country || "")}${row("Source", r.source || p.source || "")}${row("Seed keyword", seed)}
</dl>${edited ? html`<p class="ui-small rc-muted">${edited}</p>` : ""}</details>`;
}
