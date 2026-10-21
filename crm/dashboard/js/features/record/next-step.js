// Record panel: the next-step line (spec 4.2): "Next: Agree terms · due Thu 22 Oct" with ✎, which opens
// the next-step editor (text + date, one PATCH; inline-edit.js 'next'). Overdue shows in red; a
// "Waiting on client" chip leads when the next step has that prefix. Owner F1. No side effects at import.
import { html, raw } from "../../core/dom.js";
import { dueLabel } from "../../core/format.js";

const PEN = raw('<svg class="rc-pen" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16v4z"/></svg>');

// "due Thu 22 Oct", "due today", "overdue 3d" and its tone, or null without a date.
export function dueText(iso, today) {
  if (!iso) return null;
  const d = dueLabel(iso, today);
  if (!d.text) return null;
  return { text: d.text.charAt(0).toLowerCase() + d.text.slice(1), tone: d.tone };
}

export function renderNextStep(r, { today, readOnly = false } = {}) {
  const text = r.nextText || "";
  const due = dueText(r.next_due, today);
  const wait = r.waitingOnClient ? html`<span class="ui-chip is-wait rc-waitchip">Waiting on client</span> ` : "";
  const body = html`${wait}${text ? html`<span class="rc-next-text">${text}</span>` : html`<span class="rc-muted">${r.closed ? "Nothing planned" : "No next step yet"}</span>`}${due
    ? html`<span class="rc-due is-${due.tone}"> · ${due.text}</span>` : ""}`;
  const label = "Next step: " + (text || "none") + (due ? ", " + due.text : "") + ". Edit";
  const line = readOnly
    ? html`<span class="rc-next">${body}</span>`
    : html`<button type="button" class="ui-next is-edit rc-next" data-edit="next" data-id="${r.id}" aria-label="${label}">${body} ${PEN}</button>`;
  return html`<div class="ui-nextline rc-nextline"><b>Next:</b> ${line}</div>`;
}
