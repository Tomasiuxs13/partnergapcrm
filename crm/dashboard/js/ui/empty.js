// Empty states (spec 4.10). Owner G1-C. No side effects at import time.
// emptyState({title, body, action}) -> SafeHtml. action: {label, href} renders a link; {label, act}
// renders a button with data-empty-act="<act>" that the page handles with dom.on().
import { html } from "../core/dom.js";

// The copy of spec 4.10, so every page says the same thing.
export const EMPTY = {
  today: { title: "All clear.", body: "New replies arrive each weekday morning after 08:47." },
  mine: { title: "No new prospects for you.", body: "Monday's discovery adds new sites for your clients." },
  filtered: { title: "No sites match.", body: "Try removing a filter." },
  history: { title: "No edits yet.", body: "Changes you make here copy to the sheet each weekday morning." },
  deals: { title: "No deals yet.", body: "Sites move here when they reach Negotiating." },
};

// "No contacts match "jane@". New contacts from the sheet appear the next weekday morning."
export function noContacts(query) {
  return { title: "No contacts match “" + String(query || "") + "”.", body: "New contacts from the sheet appear the next weekday morning." };
}

export function emptyState({ title = "", body = "", action } = {}) {
  let act = "";
  if (action && action.label) {
    act = action.href
      ? html`<a class="ui-btn" href="${action.href}">${action.label}</a>`
      : html`<button type="button" class="ui-btn" data-empty-act="${action.act || "action"}">${action.label}</button>`;
  }
  return html`<div class="ui-empty" role="status"><p class="ui-empty-title">${title}</p>${body ? html`<p class="ui-empty-body">${body}</p>` : ""}${act}</div>`;
}
