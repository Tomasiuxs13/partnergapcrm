// One deal's own page, #deal/<id> (Tomas, 2026-10-23: "like HubSpot"). Opened from a deal in a site's
// record, from Partners and from a contact's page. Built on features/record-page.js.
//   Header: Deals › "Soro deal · Site"; h1 "Soro deal"; site · stage · owner; [Edit deal] [Add file link]
//   [Log what happened] [Open site].
//   Left: the deal (stage, terms, value, owner, next step, placement, went live, tracking ID, notes).
//   Middle: what happened about this client at the site, with the deal's own changes; then the rest.
//   Right: the site, its people (each opens their page), the file links (this deal's first).
// Edit deal and Add file link are the record's own forms (features/record/deals.js), so they save the same
// way (PATCH /api/deal/:id, POST /api/partner/:id/files) and tell the other pages ("deals:changed").
import { html, on, safeUrl } from "../core/dom.js";
import { money, pct } from "../core/format.js";
import * as bus from "../core/bus.js";
import { client as metaClient } from "../core/meta.js";
import { toast } from "../ui/toast.js";
import { avatar, stageDot } from "../ui/pills.js";
import { dealStageText, openDealForm, openFileForm } from "../features/record/deals.js";
import { createRecordPage, card, facts, whenOf, timeline, moreBlock, siteCard, peopleList } from "../features/record-page.js";

const SYNC = "Copies to the Google Sheet on the next weekday morning (08:47).";
const has = (v) => v != null && String(v).trim() !== "";
const low = (s) => String(s == null ? "" : s).trim().toLowerCase();

function shortUrl(u) {
  const s = String(u || "").replace(/^https?:\/\//i, "").replace(/^www\./i, "").replace(/\/$/, "");
  return s.length > 48 ? s.slice(0, 47) + "…" : s;
}

function siteOf(data, ctx) {
  const id = String((data.deal && data.deal.account_id) || "");
  return { id, site: ctx.store.get(id) || null, partner: data.partner || null };
}

function siteLabelOf(s) {
  return (s.site && (s.site.label || s.site.domain)) || (s.partner && (s.partner.name || s.partner.domain)) || s.id;
}

// Same client: the meta client key when both names are known, else the names.
function sameClient(meta, a, b) {
  const x = metaClient(meta, a);
  const y = metaClient(meta, b);
  return x && y ? x.k === y.k && low(x.product) === low(y.product) : low(a) === low(b) && has(a);
}

function fileItem(f) {
  const url = safeUrl(f.url);
  const name = f.label || f.kind || "File";
  const sub = [f.kind && f.kind !== name ? f.kind : "", f.added_by, f.added_at ? String(f.added_at).slice(0, 10) : ""].filter(has).join(" · ");
  return html`<li>${url ? html`<a href="${url}" target="_blank" rel="noopener noreferrer"><b>${name}</b> <span aria-hidden="true">↗</span></a>` : html`<b>${name}</b>`}${sub ? html`<span class="rv-sub">${sub}</span>` : ""}</li>`;
}

function filesCard(files, d, ro) {
  const mine = (files || []).filter((f) => f.deal_id === d.id);
  const rest = (files || []).filter((f) => f.deal_id !== d.id);
  const add = ro ? "" : html`<button type="button" class="ui-btn is-sm is-ghost" data-rv-file>+ Add file link</button>`;
  const body = mine.length || rest.length
    ? html`${mine.length ? html`<ul class="rv-list">${mine.map(fileItem)}</ul>` : html`<p class="ui-small rv-muted">No files for this deal yet.</p>`}${rest.length ? html`<p class="rv-label">Other files at the site</p><ul class="rv-list">${rest.map(fileItem)}</ul>` : ""}`
    : html`<p class="ui-small rv-muted">No files yet. Upload a contract or brief to Google Drive, then add its link here.</p>`;
  return card("files", "Files", body, { extra: add });
}

function view(data, ctx) {
  const d = data.deal || {};
  const s = siteOf(data, ctx);
  const siteLabel = siteLabelOf(s);
  const client = d.client || "No client";
  const today = ctx.today;
  const ro = !!(ctx.meta && ctx.meta.read_only);
  const stage = html`<span class="ui-pill ui-stage">${stageDot(d.stage)}<span class="ui-pill-text">${dealStageText(d)}</span></span>`;
  const tools = html`${ro ? "" : html`<button type="button" class="ui-btn is-sm" data-rv-edit>Edit deal</button><button type="button" class="ui-btn is-sm" data-rv-site="${s.id}" data-rv-focus="log">Log what happened</button>`}<button type="button" class="ui-btn is-sm is-primary" data-rv-site="${s.id}">Open site</button>`;
  const head = html`<div class="rv-top">${avatar(siteLabel, { size: "lg" })}<div class="rv-title"><h1 tabindex="-1">${client} deal</h1><p class="rv-sub"><a href="${ctx.href(ctx.route.page, Object.assign({}, ctx.route.params, { rec: s.id }), ctx.route.sub)}" data-rv-site="${s.id}">${siteLabel}</a> · ${stage}${has(d.owner) ? html` · ${d.owner}` : ""}</p></div><div class="rv-tools">${tools}</div></div>`;
  const place = safeUrl(d.content_url);
  const live = has(d.live_date) ? String(d.live_date).slice(0, 10) : "";
  const about = facts([
    ["Stage", stage],
    ["Deal type", has(d.deal_model) ? html`${d.deal_model}` : ""],
    ["Flat fee", has(d.deal_flat) ? money(d.deal_flat) || String(d.deal_flat) : ""],
    ["Commission", has(d.deal_pct) ? pct(d.deal_pct) || String(d.deal_pct) : ""],
    ["Deal value", has(d.deal_value) ? money(d.deal_value) || String(d.deal_value) : ""],
    ["Owner", has(d.owner) ? html`${d.owner}` : ""],
    ["Next step", d.stage !== "Lost" && has(d.next_step) ? html`${d.next_step}${has(d.next_due) ? html`<span class="rv-sub">Due ${whenOf(d.next_due, today)}</span>` : ""}` : ""],
    ["Placement", has(d.content_url) ? (place ? html`<a class="rv-tap" href="${place}" target="_blank" rel="noopener noreferrer">${shortUrl(place)} <span aria-hidden="true">↗</span></a>` : html`${d.content_url}`) : ""],
    [live > today ? "Goes live" : "Went live", live ? whenOf(live, today) : ""],
    ["Tracking ID", has(d.tracking_id) ? html`${d.tracking_id}` : ""],
    ["Notes", has(d.notes) ? html`<span class="rc-pre">${d.notes}</span>` : ""],
    ["Added", has(d.created) ? whenOf(d.created, today) : ""],
    ["Last changed", has(d.updated_at) ? html`${whenOf(d.updated_at, today)}${has(d.updated_by) ? " by " + d.updated_by : ""}` : ""],
    ["ID", html`<span class="ui-id">${d.id}</span>`],
  ]);
  const acts = Array.isArray(data.activity) ? data.activity : [];
  const mine = acts.filter((a) => sameClient(ctx.meta, a.client, d.client));
  const rest = acts.filter((a) => !sameClient(ctx.meta, a.client, d.client));
  const main = html`${card("activity", "Activity for " + client, timeline({ activity: mine, history: data.history, deals: [d] }, today, { empty: "Nothing logged for " + client + " here yet." }))}${rest.length
    ? card("site-activity", "Other activity at " + siteLabel, moreBlock("site-activity", rest.length, timeline({ activity: rest }, today))) : ""}`;
  return {
    title: client + " deal · " + siteLabel,
    crumb: client + " deal · " + siteLabel,
    head,
    left: card("deal", "Deal", about),
    main,
    side: html`${siteCard(s.site, s.partner, ctx)}${card("people", "People at " + siteLabel, peopleList(data.contacts, ctx))}${filesCard(data.files, d, ro)}`,
  };
}

function siteRecord(page) {
  const d = page.data && page.data.deal;
  if (!d) return null;
  return page.ctx.store.get(d.account_id) || Object.assign({ id: String(d.account_id) }, page.data.partner || {});
}

function bind(page) {
  return [
    on(page.root, "click", "[data-rv-edit]", async () => {
      const d = page.data && page.data.deal;
      const r = siteRecord(page);
      if (!d || !r) return;
      const answer = await openDealForm(r, d);
      if (!answer || !answer.deal) return;
      if (answer.v2) page.ctx.store.upsert(answer.v2);
      bus.emit("deals:changed", { id: d.account_id });
      page.setData(Object.assign({}, page.data, { deal: answer.deal }));
      toast((answer.deal.client || "Deal") + " deal saved. " + SYNC);
      page.reload();
    }),
    on(page.root, "click", "[data-rv-file]", async () => {
      const d = page.data && page.data.deal;
      const r = siteRecord(page);
      if (!d || !r) return;
      const answer = await openFileForm(r, [d], { dealId: d.id });
      if (!answer) return;
      bus.emit("deals:changed", { id: d.account_id });
      toast("File link added. " + SYNC);
      page.reload();
    }),
  ];
}

export default createRecordPage({
  id: "deal",
  noun: "deal",
  back: { page: "deals", label: "Deals" },
  load: (api, id) => api.deal(id),
  view,
  bind,
});
