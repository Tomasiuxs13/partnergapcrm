// Record panel: Contacts (n) · + Add contact (spec 4.2, 6.3.10). Owner F1. No side effects at import.
// Each contact: name (or first email), title, client, outreach status, each email with [Copy] and
// [Gmail ↗], LinkedIn (http(s) only), last email + replied, and [Sheet ↗] (its Contacts tab row; the
// click also copies the contact id, as "Open in sheet" does for the site).
// The add form is inline. A 409 from POST /api/partner/:id/contacts shows "Already a contact at <site>
// (owner, stage)" with [Open that site] [Add anyway]. The panel (index.js) owns the state and the request.
import { html, raw, safeUrl } from "../../core/dom.js";
import { date as fmtDate, num } from "../../core/format.js";
import { skeletonRows } from "../../ui/skeleton.js";

const SHOWN = 3;
export const ADD_FIELDS = ["first_name", "last_name", "email", "title", "client", "linkedin"];

export function emailsOf(c) {
  return String((c && c.email) || "").split(/\s*[,;]\s*/).map((e) => e.trim()).filter(Boolean);
}

export function contactName(c) {
  const n = [c && c.first_name, c && c.last_name].filter((x) => x && String(x).trim()).join(" ");
  return n || emailsOf(c)[0] || "Unnamed contact";
}

// The email "Copy email" copies: the first address of the first contact that has one (the profile lists
// the primary contact first).
export function firstEmail(profile) {
  const list = profile && Array.isArray(profile.contacts) ? profile.contacts : [];
  for (const c of list) {
    const e = emailsOf(c)[0];
    if (e) return e;
  }
  return "";
}

export function gmailUrl(email) {
  return "https://mail.google.com/mail/u/0/#search/" + encodeURIComponent(email).replace(/%40/g, "@");
}

// The Google Sheet row of a site (Accounts tab) or a contact (Contacts tab): the number + 1 (row 1 is the
// header). '' for NEW- / NEWC- ids, which are not in the sheet yet, or without meta.sheet_url.
export function sheetUrl(meta, id) {
  const base = meta && meta.sheet_url ? String(meta.sheet_url) : "";
  if (!base) return "";
  const s = /^PG-(\d+)$/.exec(String(id || ""));
  if (s) return base + "#gid=0&range=A" + (Number(s[1]) + 1);
  const c = /^C-(\d+)$/.exec(String(id || ""));
  if (c) return base + "#gid=1&range=A" + (Number(c[1]) + 1);
  return "";
}

export function sheetToast(id) {
  return id + " copied – if the row doesn't match, press Ctrl+F";
}

function lastEmailText(c, today) {
  const d = c.last_email ? fmtDate(c.last_email, today && String(c.last_email).slice(0, 4) !== today.slice(0, 4) ? "year" : "short") : "";
  const replied = Number(c.replied) > 0 || c.replied === true;
  if (!d) return replied ? "They replied" : "";
  return "Last email " + d + (replied ? " · they replied" : "");
}

function contactHtml(c, { meta, today }) {
  const name = contactName(c);
  const emails = emailsOf(c);
  const sheet = sheetUrl(meta, c.id);
  const isNew = /^NEWC-/i.test(String(c.id || ""));
  const sub = [c.title, c.client].filter((x) => x && String(x).trim()).join(" · ");
  const li = safeUrl(c.linkedin);
  const last = lastEmailText(c, today);
  const status = c.outreach_status && c.outreach_status !== "Not contacted" ? c.outreach_status : "";
  return html`<li class="rc-ct"><div class="rc-ct-head"><b class="rc-ct-name">${name}</b>${status ? html`<span class="rc-ct-status">${status}</span>` : ""}${sheet
    ? html`<a class="rc-sheet" href="${sheet}" target="_blank" rel="noopener noreferrer" data-psheet="${c.id}" title="${"Open " + c.id + " in the Google Sheet"}">Sheet <span aria-hidden="true">↗</span></a>`
    : isNew ? html`<span class="rc-ct-new" title="Added on this site; reaches the Google Sheet on the next weekday morning.">New</span>` : ""}</div>${sub ? html`<p class="rc-ct-sub">${sub}</p>` : ""}${emails.length
    ? html`<ul class="rc-emails">${emails.map((e) => html`<li><span class="rc-email">${e}</span><span class="rc-email-acts"><button type="button" class="ui-btn is-sm is-ghost rc-mini" data-pcopy="${e}" aria-label="${"Copy " + e}">Copy</button><a class="ui-btn is-sm is-ghost rc-mini" href="${gmailUrl(e)}" target="_blank" rel="noopener noreferrer" aria-label="${"Search Gmail for " + e}">Gmail <span aria-hidden="true">↗</span></a></span></li>`)}</ul>`
    : html`<p class="rc-ct-sub rc-muted">No email</p>`}${last || li ? html`<p class="rc-ct-sub">${last}${last && li ? " · " : ""}${li ? html`<a href="${li}" target="_blank" rel="noopener noreferrer">LinkedIn <span aria-hidden="true">↗</span></a>` : ""}</p>` : ""}</li>`;
}

function clientOptions(r, add) {
  const names = ((r && r.cl) || []).slice();
  if (add.client && !names.includes(add.client)) names.unshift(add.client);
  return html`<option value=""${add.client ? "" : raw(" selected")}>None</option>${names.map((n) => html`<option${n === add.client ? raw(" selected") : ""}>${n}</option>`)}`;
}

function dupeHtml(st, r, lookup) {
  const d = st.addDupe;
  if (!d) return html``;
  if (d.account_id && r && String(d.account_id) === String(r.id)) {
    return html`<div class="rc-dupe" role="alert"><p>This email is already a contact on this site.</p><div class="rc-dupe-acts"><button type="button" class="ui-btn is-sm" data-padd="force">Add anyway</button></div></div>`;
  }
  const other = lookup && d.account_id ? lookup(d.account_id) : null;
  const site = (other && other.label) || d.name || d.domain || d.account_id || "another site";
  const owner = d.owner || (other && other.owner) || "no owner";
  const stage = other && other.stage ? other.stage : "";
  return html`<div class="rc-dupe" role="alert"><p>Already a contact at <b>${site}</b> (${owner}${stage ? ", " + stage : ""}).</p><div class="rc-dupe-acts">${d.account_id
    ? html`<button type="button" class="ui-btn is-sm" data-popen="${d.account_id}">Open that site</button>` : ""}<button type="button" class="ui-btn is-sm" data-padd="force">Add anyway</button></div></div>`;
}

function addFormHtml(r, st, lookup) {
  const a = st.add || {};
  const v = (k) => a[k] || "";
  const inv = (k) => (st.addField === k ? raw(' aria-invalid="true" aria-describedby="rc-add-err"') : "");
  return html`<form class="rc-addform" data-paddform novalidate aria-label="Add contact">${st.addSugg ? html`<p class="ui-small rc-muted">From the suggestion. The email is optional.</p>` : ""}<div class="ui-grid2">
<label class="ui-field"><span class="ui-label">First name</span><input class="ui-input" name="first_name" maxlength="60" autocomplete="off" value="${v("first_name")}"${inv("first_name")}></label>
<label class="ui-field"><span class="ui-label">Last name</span><input class="ui-input" name="last_name" maxlength="60" autocomplete="off" value="${v("last_name")}"></label>
<label class="ui-field is-wide"><span class="ui-label">Email</span><input class="ui-input" type="email" name="email" maxlength="200" autocomplete="off" value="${v("email")}"${inv("email")}></label>
<label class="ui-field"><span class="ui-label">Title</span><input class="ui-input" name="title" maxlength="100" autocomplete="off" value="${v("title")}"></label>
<label class="ui-field"><span class="ui-label">Client</span><select class="ui-input" name="client">${clientOptions(r, a)}</select></label>
<label class="ui-field is-wide"><span class="ui-label">LinkedIn</span><input class="ui-input" type="url" name="linkedin" maxlength="300" placeholder="https://" autocomplete="off" value="${v("linkedin")}"${inv("linkedin")}></label>
</div><p class="ui-error" id="rc-add-err" role="alert"${st.addErr ? "" : raw(" hidden")}>${st.addErr || ""}</p>${dupeHtml(st, r, lookup)}<div class="ui-form-acts"><button type="button" class="ui-btn is-ghost" data-padd="cancel">Cancel</button><button type="submit" class="ui-btn is-primary"${st.addBusy ? raw(" disabled") : ""}>${st.addBusy ? "Adding…" : "Add contact"}</button></div></form>`;
}

// Reads the add form: {first_name, last_name, email, title, client, linkedin} (trimmed).
export function readAddForm(form) {
  const out = {};
  for (const k of ADD_FIELDS) out[k] = form && form.elements[k] ? String(form.elements[k].value || "").trim() : "";
  return out;
}

// A plain sentence and the field it is about, or null when the contact can be sent.
export function checkContact(c) {
  if (!c.first_name && !c.email) return { error: "Add at least a first name or an email.", field: "first_name" };
  if (c.email && !/^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/.test(c.email)) return { error: "That email address doesn't look right.", field: "email" };
  if (c.linkedin && !/^https?:\/\/\S+$/i.test(c.linkedin)) return { error: "The LinkedIn link must start with https://.", field: "linkedin" };
  return null;
}

// The Contacts card. st: {profile, profileState, contactsAll, add, addErr, addField, addDupe, addBusy, addSugg}.
// lookup(id) finds another site in the store (for the duplicate line).
export function renderContacts(r, st, { meta, today, readOnly = false, lookup } = {}) {
  const list = st.profile && Array.isArray(st.profile.contacts) ? st.profile.contacts : null;
  const count = list ? list.length : Number(r.contacts) || 0;
  const addBtn = readOnly || st.add ? "" : html`<button type="button" class="ui-linkbtn rc-head-act" data-padd="open">+ Add contact</button>`;
  const title = html`<div class="rc-card-head"><h3 class="ui-card-title rc-card-title" id="rc-ct-h">Contacts${count ? html` <span class="rc-count">(${num(count)})</span>` : ""}</h3>${addBtn}</div>`;
  const form = st.add && !readOnly ? addFormHtml(r, st, lookup) : "";
  let body;
  if (list) {
    const shown = st.contactsAll ? list : list.slice(0, SHOWN);
    body = list.length
      ? html`<ul class="rc-cts">${shown.map((c) => contactHtml(c, { meta, today }))}</ul>${list.length > SHOWN
        ? html`<button type="button" class="ui-linkbtn rc-more" data-pcall aria-expanded="${st.contactsAll ? "true" : "false"}">${st.contactsAll ? "Show fewer" : "Show all " + num(list.length)}</button>` : ""}`
      : html`<p class="ui-small rc-muted">No contacts yet.</p>`;
  } else if (st.profileState === "snapshot") {
    body = html`<p class="ui-small rc-muted">Open the live site to see this.</p>`;
  } else if (st.profileState === "na") {
    body = html`<p class="ui-small rc-muted">Not available yet.</p>`;
  } else if (st.profileState === "error") {
    body = html`<p class="ui-small rc-muted">Couldn't load the contacts. <button type="button" class="ui-linkbtn" data-preload>Try again</button></p>`;
  } else if (!count) {
    body = html`<p class="ui-small rc-muted">No contacts yet.</p>`;
  } else {
    body = skeletonRows(Math.min(count, 2));
  }
  return html`${title}${form}${body}`;
}
