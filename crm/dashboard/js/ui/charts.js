// Bar charts with an aria-label and a visually hidden table (spec 4.13). Owner G1-C.
// No side effects at import time.
import { html } from "../core/dom.js";
import { num } from "../core/format.js";

// bars([{label, value, href?, tone?}], {unit, title, max}) -> SafeHtml. Horizontal bars scaled to the
// largest value; the visible chart is aria-hidden and a table carries the same numbers for screen
// readers. tone: a stage colour name (new, contacted, …) or omitted for the accent colour.
export function bars(rows, { unit = "", title = "", max } = {}) {
  const list = (rows || []).filter((r) => r && r.label != null);
  const top = max != null ? Number(max) : Math.max(0, ...list.map((r) => Number(r.value) || 0));
  const fmt = (v) => num(v || 0) + (unit ? " " + unit : "");
  const summary = (title ? title + ": " : "") + list.map((r) => r.label + " " + fmt(r.value)).join(", ");
  return html`<figure class="ui-bars" aria-label="${summary}">
${title ? html`<figcaption class="ui-bars-title">${title}</figcaption>` : ""}
<div class="ui-bars-list" aria-hidden="true">${list.map((r) => {
    const w = top > 0 ? Math.max(0, Math.min(100, ((Number(r.value) || 0) / top) * 100)) : 0;
    const label = r.href ? html`<a href="${r.href}" tabindex="-1">${r.label}</a>` : html`${r.label}`;
    return html`<div class="ui-bar"><span class="ui-bar-label">${label}</span><span class="ui-bar-track"><span class="ui-bar-fill${r.tone ? " is-" + r.tone : ""}" style="width:${w.toFixed(1)}%"></span></span><span class="ui-bar-value num">${fmt(r.value)}</span></div>`;
  })}</div>
<table class="sr-only"><caption>${title || "Chart"}</caption><thead><tr><th scope="col">Item</th><th scope="col">Value</th></tr></thead><tbody>${list.map((r) => html`<tr><th scope="row">${r.href ? html`<a href="${r.href}">${r.label}</a>` : r.label}</th><td>${fmt(r.value)}</td></tr>`)}</tbody></table>
</figure>`;
}
