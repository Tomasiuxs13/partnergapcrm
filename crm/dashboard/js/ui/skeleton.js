// Loading skeleton rows (spec 4.11). Owner G1-C. No side effects at import time.
import { html } from "../core/dom.js";

// n grey placeholder rows (aria-hidden; the page's main[aria-busy] tells screen readers it is loading).
export function skeletonRows(n = 5, { lines = 2 } = {}) {
  const rows = [];
  for (let i = 0; i < Math.max(0, Number(n) || 0); i++) {
    const w = 40 + ((i * 37) % 45);
    rows.push(html`<div class="ui-skel-row"><span class="ui-skel is-dot"></span><span class="ui-skel-lines"><span class="ui-skel" style="width:${w}%"></span>${lines > 1 ? html`<span class="ui-skel is-short" style="width:${Math.max(20, w - 22)}%"></span>` : ""}</span></div>`);
  }
  return html`<div class="ui-skeleton" aria-hidden="true">${rows}</div>`;
}
