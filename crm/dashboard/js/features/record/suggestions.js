// Record panel: Suggestions (spec 4.2, 6.3.12), shown only when the site has open rows. Owner F1. No side
// effects at import time.
//   - Suggested contact: "Emily Rhodes, Managing Editor" [Add as contact] [Dismiss]. Add opens the add-contact
//     form prefilled (name, title, LinkedIn; the email is optional); on success the row is marked used.
//   - Suggested email (test mode): subject and body (expandable), [Copy text] [Dismiss].
//   - Ownership check: the note, [Copy message] [Dismiss].
// Dismiss is POST /api/suggestions/:id {status:'dismissed'} (no edits row). The rows come from the profile
// (`suggestions`, 6.3.8) or, when the profile doesn't carry them, GET /api/suggestions?account=ID.
import { html, raw, safeUrl } from "../../core/dom.js";
import { date as fmtDate, num } from "../../core/format.js";

const TEST_TIP = "Nothing is sent from this site.";

export function openRows(rows) {
  return (Array.isArray(rows) ? rows : []).filter((s) => s && s.id != null && (!s.status || s.status === "open"));
}

// Splits "Emily Rhodes" into first and last name for the add form.
export function splitName(name) {
  const parts = String(name || "").replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  if (!parts.length) return { first_name: "", last_name: "" };
  return { first_name: parts[0], last_name: parts.slice(1).join(" ") };
}

// The text [Copy text] / [Copy message] puts on the clipboard.
export function copyTextOf(s) {
  if (!s) return "";
  if (s.kind === "email") return (s.subject ? "Subject: " + s.subject + "\n\n" : "") + String(s.body || "");
  if (s.kind === "slack_ask") return String(s.note || "");
  return [s.name, s.title, s.linkedin].filter(Boolean).join(", ");
}

function when(s) {
  return s.run_date ? fmtDate(s.run_date, "short") : "";
}

function itemHtml(s, st, readOnly) {
  const id = String(s.id);
  const dismiss = readOnly ? "" : html`<button type="button" class="ui-btn is-sm is-ghost" data-psugg-dismiss="${id}">Dismiss</button>`;
  const date = when(s);
  if (s.kind === "candidate") {
    const li = safeUrl(s.linkedin);
    const who = s.name ? String(s.name) : "Someone at this site";
    return html`<li class="rc-sg"><p class="rc-sg-kind">Suggested contact${sourceText(s.source) ? " · " + sourceText(s.source) : ""}${date ? html` <span class="rc-muted">· ${date}</span>` : ""}</p><p class="rc-sg-main"><b>${who}</b>${s.title ? ", " + s.title : ""}${li ? html` · <a href="${li}" target="_blank" rel="noopener noreferrer">LinkedIn <span aria-hidden="true">↗</span></a>` : ""}</p><div class="rc-sg-acts">${readOnly ? "" : html`<button type="button" class="ui-btn is-sm" data-psugg-add="${id}">Add as contact</button>`}${dismiss}</div></li>`;
  }
  if (s.kind === "email") {
    const open = !!(st.suggOpen && st.suggOpen[id]);
    const body = String(s.body || "");
    const long = body.length > 120;
    return html`<li class="rc-sg"><p class="rc-sg-kind">Suggested email <span class="rc-test" title="${TEST_TIP}">Test mode</span>${date ? html` <span class="rc-muted">· ${date}</span>` : ""}</p>${s.to_email ? html`<p class="rc-sg-sub">To ${s.to_email}</p>` : ""}<p class="rc-sg-main"><b>${s.subject || "No subject"}</b></p>${body
      ? html`<p class="rc-sg-body${open || !long ? " is-open" : ""}">${body}</p>${long ? html`<button type="button" class="ui-linkbtn rc-more" data-psugg-more="${id}" aria-expanded="${open ? "true" : "false"}">${open ? "Show less" : "Show more"}</button>` : ""}` : ""}<div class="rc-sg-acts"><button type="button" class="ui-btn is-sm" data-psugg-copy="${id}">Copy text</button>${dismiss}</div></li>`;
  }
  if (s.kind === "slack_ask") {
    return html`<li class="rc-sg"><p class="rc-sg-kind">Ownership check${date ? html` <span class="rc-muted">· ${date}</span>` : ""}</p><p class="rc-sg-main">${s.note || ""}</p><div class="rc-sg-acts"><button type="button" class="ui-btn is-sm" data-psugg-copy="${id}">Copy message</button>${dismiss}</div></li>`;
  }
  return html``;
}

// The Suggestions card body, or an empty string when there is nothing open (the card is then hidden).
// Where a candidate came from ("Apollo"); internal job names are left out of the page.
function sourceText(src) {
  const t = String(src || "").trim();
  return /daily|run|script|cron/i.test(t) ? "" : t;
}

export function renderSuggestions(r, st, { readOnly = false } = {}) {
  const rows = openRows(st.sugg).filter((s) => ["candidate", "email", "slack_ask"].includes(s.kind));
  if (!rows.length) return raw("");
  return html`<h3 class="ui-card-title rc-card-title" id="rc-sg-h">Suggestions <span class="rc-count">(${num(rows.length)})</span></h3><ul class="rc-sgs">${rows.map((s) => itemHtml(s, st, readOnly))}</ul>`;
}
