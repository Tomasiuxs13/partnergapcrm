// Bar charts (spec 4.13). Owner G1-C; restructured by G3-3 (NEEDS F6 2). No side effects at import time.
//
// The visible bars are the accessible version: a list with one item per bar, so screen readers, the
// keyboard and the mouse use the same links. (The first version hid the bars with aria-hidden and gave
// screen readers a visually hidden table. The table's links took the Tab stops, so a keyboard user tabbed
// onto links they couldn't see; putting the visible links in the Tab order instead put focusable content
// inside aria-hidden, which axe reports as serious. One accessible list replaces both.)
import { html } from "../core/dom.js";
import { num } from "../core/format.js";

// bars([{label, value, href?, tone?}], {unit, title, max}) -> SafeHtml. Horizontal bars scaled to the
// largest value (or max). A bar with href is a link named "label, value", and its whole row is the target
// (44 px tall on touch screens; components.css). tone: a stage colour name (new, contacted, …) or omitted
// for the accent colour. With a title, the caption names the figure.
export function bars(rows, { unit = "", title = "", max } = {}) {
  const list = (rows || []).filter((r) => r && r.label != null);
  const top = max != null ? Number(max) : Math.max(0, ...list.map((r) => Number(r.value) || 0));
  const fmt = (v) => num(v || 0) + (unit ? " " + unit : "");
  return html`<figure class="ui-bars">
${title ? html`<figcaption class="ui-bars-title">${title}</figcaption>` : ""}
<ul class="ui-bars-list">${list.map((r) => {
    const w = top > 0 ? Math.max(0, Math.min(100, ((Number(r.value) || 0) / top) * 100)) : 0;
    const label = r.href ? html`<a href="${r.href}" aria-label="${r.label + ", " + fmt(r.value)}">${r.label}</a>` : html`${r.label}`;
    return html`<li class="ui-bar${r.href ? " is-link" : ""}"><span class="ui-bar-label">${label}</span><span class="ui-bar-track" aria-hidden="true"><span class="ui-bar-fill${r.tone ? " is-" + r.tone : ""}" style="width:${w.toFixed(1)}%"></span></span><span class="ui-bar-value num"${r.href ? html` aria-hidden="true"` : ""}>${fmt(r.value)}</span></li>`;
  })}</ul>
</figure>`;
}
