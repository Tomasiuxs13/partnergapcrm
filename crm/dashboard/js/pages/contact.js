// One contact's own page, #contact/<id> (Tomas, 2026-10-23: "like HubSpot"). Opened from a name on
// Contacts, in a site's record and on a deal's page. Built on features/record-page.js.
//   Header: Contacts › name; h1 name; title · site · client; [Copy email] [Log what happened] [Open site].
//   Left: About (email, title, client, status, last email, replied, main contact, LinkedIn, source, ID).
//   Middle: Activity with this person (and the contact's last email), then the rest of the site's activity.
//   Right: the site, the site's deals (each opens its page), the other people at the site.
// "Log what happened" opens the site's record at its log box: the log is per site, with this person picked.
import { html, on, copyText, safeUrl } from "../core/dom.js";
import { toast } from "../ui/toast.js";
import { avatar, stageDot } from "../ui/pills.js";
import { dealStageText, dealTerms } from "../features/record/deals.js";
import { createRecordPage, card, facts, whenOf, timeline, moreBlock, siteCard, peopleList } from "../features/record-page.js";

const has = (v) => v != null && String(v).trim() !== "";

function nameOf(c) {
  return [c.first_name, c.last_name].filter(has).join(" ").trim() || String(c.id || "");
}

function emailsOf(c) {
  return String(c.email || "").split(/\s*[,;]\s*/).map((s) => s.trim()).filter(Boolean);
}

function dealsCard(deals, ctx, client) {
  if (!Array.isArray(deals)) return "";
  const list = deals.slice().sort((a, b) => (a.stage === "Lost") - (b.stage === "Lost"));
  const body = list.length
    ? html`<ul class="rv-list">${list.map((d) => html`<li><a href="${ctx.href("deal", {}, d.id)}"><b>${d.client || "No client"}</b></a> <span class="ui-pill ui-stage">${stageDot(d.stage)}<span class="ui-pill-text">${dealStageText(d)}</span></span>${client && d.client === client ? html` <span class="ui-chip">This contact's client</span>` : ""}${dealTerms(d) ? html`<span class="rv-sub">${dealTerms(d)}</span>` : ""}</li>`)}</ul>`
    : html`<p class="ui-small rv-muted">No deals at this site yet.</p>`;
  return card("deals", "Deals", body, { count: list.length });
}

function view(data, ctx) {
  const c = data.contact || {};
  const name = nameOf(c);
  const site = ctx.store.get(c.account_id) || null;
  const partner = data.partner || null;
  const siteLabel = (site && (site.label || site.domain)) || (partner && (partner.name || partner.domain)) || c.account_id || "";
  const emails = emailsOf(c);
  const today = ctx.today;
  const li = safeUrl(c.linkedin);
  const ro = !!(ctx.meta && ctx.meta.read_only);
  const siteId = String(c.account_id || "");
  const sub = [c.title, siteLabel, c.client].filter(has);
  const head = html`<div class="rv-top">${avatar(name, { size: "lg" })}<div class="rv-title"><h1 tabindex="-1">${name}</h1><p class="rv-sub">${sub.join(" · ")}</p></div><div class="rv-tools">${emails.length ? html`<button type="button" class="ui-btn is-sm" data-rv-copy="${emails[0]}">Copy email</button>` : ""}${siteId && !ro ? html`<button type="button" class="ui-btn is-sm" data-rv-site="${siteId}" data-rv-focus="log">Log what happened</button>` : ""}${siteId ? html`<button type="button" class="ui-btn is-sm is-primary" data-rv-site="${siteId}">Open site</button>` : ""}</div></div>`;
  const about = facts([
    ["Email", emails.length ? html`${emails.map((e, i) => html`${i ? html`<br>` : ""}<span class="rv-email">${e}</span>`)}` : html`<span class="rv-muted">No email</span>`],
    ["Title", has(c.title) ? html`${c.title}` : ""],
    ["Client", has(c.client) ? html`<span class="ui-tag">${c.client}</span>` : ""],
    ["Status", has(c.outreach_status) ? html`${c.outreach_status}` : ""],
    ["Last email", has(c.last_email) ? whenOf(c.last_email, today) : ""],
    ["Replied", Number(c.replied) > 0 ? "Yes" : ""],
    ["Main contact", Number(c.primary_contact) > 0 ? "Yes" : ""],
    ["Email check", has(c.email_status) ? html`${c.email_status}` : ""],
    ["LinkedIn", li ? html`<a class="rv-tap" href="${li}" target="_blank" rel="noopener noreferrer">Profile <span aria-hidden="true">↗</span></a>` : ""],
    ["Found through", has(c.source) ? html`${c.source}` : ""],
    ["ID", html`<span class="ui-id">${c.id}</span>`],
  ]);
  const acts = Array.isArray(data.activity) ? data.activity : [];
  const mine = acts.filter((a) => String(a.contact_id || "") === String(c.id));
  const rest = acts.filter((a) => String(a.contact_id || "") !== String(c.id));
  const first = has(c.first_name) ? c.first_name : name;
  const withThem = timeline({ activity: mine, history: data.history, contacts: [c] }, today, { empty: "Nothing logged with " + first + " yet. Log what happened on the site and pick " + first + "." });
  const others = rest.length
    ? card("site-activity", "Other activity at " + siteLabel, moreBlock("site-activity", rest.length, timeline({ activity: rest }, today)))
    : "";
  return {
    title: name,
    crumb: name,
    head,
    left: card("about", "About " + first, about),
    main: html`${card("activity", "Activity with " + first, withThem)}${others}`,
    side: html`${siteCard(site, partner, ctx)}${dealsCard(data.deals, ctx, c.client)}${card("people", "Other people at " + siteLabel, peopleList(data.contacts, ctx, { current: c.id }))}`,
  };
}

function bind(page) {
  return [on(page.root, "click", "[data-rv-copy]", async (e, b) => {
    const t = b.getAttribute("data-rv-copy");
    const ok = await copyText(t);
    toast(ok ? "Copied " + t + "." : "Couldn't copy. Select the address and copy it.", { kind: ok ? "info" : "error" });
  })];
}

export default createRecordPage({
  id: "contact",
  noun: "contact",
  back: { page: "contacts", label: "Contacts" },
  load: (api, id) => api.contact(id),
  view,
  bind,
});
