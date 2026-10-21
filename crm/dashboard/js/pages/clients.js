// Clients list #clients and client page #clients/<slug> (spec 2.2.4, Appendix B.6). Page module contract
// (spec 5.4). Owner F5.
//
// Clients list: one row per active client (name + what they sell, Manager, Prospects, Emailed, Deals in
// talks, Live partners, [Report]), a final "All clients" totals row (every site with an active client,
// counted once) and the past clients in a collapsed group. A row opens its client page; Report opens the
// monthly report (features/report.js). Below 640 px each row is a card.
//
// Client page (#clients/soro; the slug is the key with spaces as "-"; any key, name or alias also works):
// - Header: name, what they sell, markets, managers. Report, "+ Add site for Soro" (Add site with the client
//   picked; on Melograno it asks for the product first) and "See all N sites" (Sites › All for the client).
// - Melograno: product chips All · Trafft · Amelia · wpDataTables · IvyForms (URL param product) filter
//   every section.
// - Numbers strip: Prospects, Emailed, Replied, Reply rate, In talks, Active, Live. A number opens Sites
//   filtered to it when one stage holds exactly those sites.
// - Waiting on client (hidden when empty) with "Copy list for client" (client-safe: name, terms and the text
//   after "Waiting on client:"), Deals (Negotiating + Active) with terms, Live placements, Best new
//   prospects, Pipeline bars, and the Affiliate program card (GET /api/clients; Edit saves with
//   PUT /api/clients/:k, k = the stored key, e.g. "botanical synthesis").
// A site row opens the record panel in queue mode over its section; its stage pill edits in place. Store
// updates redraw in place (the program card keeps an open form); nothing remounts.
import { html, render, on, copyText, safeUrl } from "../core/dom.js";
import { num, plural, date as fmtDate, ago } from "../core/format.js";
import * as router from "../core/router.js";
import {
  clientRows, pastClientRows, clientTotals, clientOf, productOf, clientMetrics, clientToken, clientParam, rateText,
  waitingList, dealList, liveList, bestProspects, pipelineRows, waitingCopyText, clientTerms,
} from "../rules/clients.js";
import { stagePill, waitingBadge, newDot } from "../ui/pills.js";
import { bindInlineEdits } from "../ui/inline-edit.js";
import { openMenu, closeAll } from "../ui/menu.js";
import { confirm } from "../ui/dialog.js";
import { toast } from "../ui/toast.js";
import { bars } from "../ui/charts.js";
import { skeletonRows } from "../ui/skeleton.js";
import { openReport } from "../features/report.js";
import { openAddSite } from "../features/add-site.js";

const has = (v) => v != null && String(v).trim() !== "";
const DR_TIP = "Ahrefs domain rating, 0–100";
const TEST_TIP = "Nothing is sent from this site.";
const PROGRAM_FIELDS = [
  { name: "network", label: "Network", max: 80, placeholder: "e.g. Impact, PartnerStack" },
  { name: "commission", label: "Commission", max: 200, placeholder: "e.g. 30% recurring for 12 months" },
  { name: "cookie_days", label: "Cookie length (days)", max: 6, placeholder: "e.g. 30", numeric: true },
  { name: "payout_terms", label: "Payouts", max: 300, placeholder: "e.g. Monthly, net 30, $50 minimum" },
  { name: "signup_url", label: "Partner sign-up link", max: 300, placeholder: "https://", url: true },
  { name: "brief", label: "Brief for partners", max: 3000, placeholder: "What to promote, key selling points, what not to say", area: true },
];
const SECTION_LABEL = { waiting: "Waiting on client", deals: "Deals", live: "Live placements", prospects: "Best new prospects" };

let st = null; // the mounted page's state

const snapshot = () => typeof window !== "undefined" && !!window.__SNAPSHOT__;

// Admins (meta.admins) add clients; the button opens Help › Settings with the Add client form open.
function isAdmin(ctx) {
  let name = "";
  try { name = String(ctx.me.get() || "").toLowerCase(); } catch (e) { name = ""; }
  return !!name && !(ctx.meta && ctx.meta.read_only) && ((ctx.meta && ctx.meta.admins) || []).some((a) => String(a).toLowerCase() === name);
}

function fresh(root, ctx) {
  return {
    root,
    ctx,
    sub: (ctx.route && ctx.route.sub) || "",
    offs: [],
    frame: 0,
    lists: {}, // section -> ids, for queue mode
    prog: { state: "idle", row: null, editing: false, saving: false, err: "", field: "", draft: null },
    guardOff: null,
  };
}

// ---------- data ----------

function meta(ctx) {
  return (ctx && ctx.meta) || {};
}

function loaded(ctx) {
  const s = ctx.store.status || {};
  return ctx.store.size() > 0 || (!s.loading && !s.error && s.loadedAt != null) || (!s.loading && !s.error && !!s.checkedAt);
}

function readOnly(ctx) {
  return !!meta(ctx).read_only;
}

function currentClient(ctx) {
  const sub = (ctx.route && ctx.route.sub) || "";
  return sub ? clientOf(meta(ctx), sub) : null;
}

function currentProduct(ctx, c) {
  return c ? productOf(c, ctx.route && ctx.route.params ? ctx.route.params.product : "") : null;
}

function title(ctx) {
  const sub = ctx && ctx.route && ctx.route.sub;
  if (!sub) return "Clients";
  const c = clientOf(meta(ctx), sub);
  return c ? c.name : "Client not found";
}

// "Jonas and Vik", "Jonas, Vik and Kamile".
function names(list) {
  const l = (list || []).filter(has);
  if (l.length <= 1) return l[0] || "";
  return l.slice(0, -1).join(", ") + " and " + l[l.length - 1];
}

function sitesHref(ctx, c, p, extra = {}) {
  return ctx.href("sites", Object.assign({ tab: "all", client: clientParam(c, p), big: "1" }, extra));
}

// ---------- Clients list ----------

const LIST_COLS = [
  { key: "prospects", label: "Prospects", hint: "not contacted" },
  { key: "emailed", label: "Emailed", hint: "waiting for a reply" },
  { key: "inTalks", label: "Deals in talks", hint: "negotiating" },
  { key: "live", label: "Live partners", hint: "placement is live" },
];

function numCells(m) {
  return LIST_COLS.map((c) => html`<td class="cl-c-num" data-label="${c.label}"><span class="cl-num">${num(m[c.key])}</span></td>`);
}

function listRow(ctx, row, { past = false } = {}) {
  const c = row.client;
  const href = ctx.href("clients", {}, c.slug);
  const mgr = names(c.managers);
  return html`<tr class="cl-row-c" data-cl-go="${c.slug}">
<th scope="row" class="cl-c-name"><a class="cl-name" href="${href}" data-cl-key="${"name:" + c.k}">${c.name}</a>${has(c.what) ? html`<span class="cl-what">${c.what}</span>` : ""}</th>
<td class="cl-c-mgr" data-label="Manager">${mgr || html`<span class="cl-dim">–</span>`}</td>
${numCells(row.metrics)}
<td class="cl-c-act">${past ? "" : html`<button type="button" class="ui-btn is-sm" data-cl-report="${c.k}" data-cl-key="${"report:" + c.k}" aria-label="${"Monthly report for " + c.name}">Report</button>`}</td>
</tr>`;
}

function headRow() {
  return html`<tr><th scope="col" class="cl-c-name">Client</th><th scope="col" class="cl-c-mgr">Manager</th>${LIST_COLS.map((c) => html`<th scope="col" class="cl-c-num"><span class="cl-th">${c.label}</span><span class="cl-th-hint">${c.hint}</span></th>`)}<th scope="col" class="cl-c-act"><span class="sr-only">Report</span></th></tr>`;
}

function listHtml(ctx) {
  const recs = ctx.store.all();
  const m = meta(ctx);
  const rows = clientRows(recs, { meta: m });
  const past = pastClientRows(recs, { meta: m });
  const tot = clientTotals(recs, { meta: m });
  const ready = loaded(ctx);
  const body = !rows.length
    ? html`<p class="cl-empty">No clients yet. Jonas or Vik can add one in Help › Settings.</p>`
    : html`<div class="cl-tablewrap"><table class="cl-table">
<caption class="sr-only">Active clients and their sites</caption>
<thead>${headRow()}</thead>
<tbody>${rows.map((r) => listRow(ctx, r))}</tbody>
<tfoot><tr class="cl-total" title="Each site counts once, even when it works with more than one client."><th scope="row" class="cl-c-name"><span class="cl-name">All clients</span><span class="cl-what">${num(tot.clients)} ${plural(tot.clients, "client")} · each site counted once</span></th><td class="cl-c-mgr"></td>${numCells(tot.metrics)}<td class="cl-c-act"></td></tr></tfoot>
</table></div>`;
  const pastHtml = past.length
    ? html`<details class="cl-past" data-cl-past${st && st.pastOpen ? html` open` : ""}><summary class="cl-past-sum" data-cl-key="past">Past clients <span class="cl-dim">(${num(past.length)})</span></summary><div class="cl-tablewrap"><table class="cl-table is-past"><caption class="sr-only">Past clients and their sites</caption><thead>${headRow()}</thead><tbody>${past.map((r) => listRow(ctx, r, { past: true }))}</tbody></table></div></details>`
    : "";
  return html`<div class="cl-page cl-list">
<header class="cl-head"><div class="cl-titles"><h1 tabindex="-1">Clients</h1><p class="cl-sub">${num(rows.length)} active ${plural(rows.length, "client")}. Open one for its deals, placements and program, or send its monthly report.</p></div>${isAdmin(ctx) ? html`<a class="ui-btn" href="${ctx.href("help", { add: "client" })}" data-cl-addclient>+ Add client</a>` : ""}</header>
${ready ? body : html`<div class="cl-card">${skeletonRows(6)}</div>`}
${ready ? pastHtml : ""}
</div>`;
}

// ---------- Client page ----------

function siteHref(ctx, id) {
  return ctx.href("clients", Object.assign({}, (ctx.route && ctx.route.params) || {}, { rec: id }), (ctx.route && ctx.route.sub) || "");
}

function ownerText(r) {
  return has(r.owner) ? r.owner : "No owner";
}

function siteRow(ctx, r, sec, second) {
  return html`<li class="cl-srow" data-rec="${r.id}" data-cl-sec="${sec}">
<div class="cl-l1"><a class="cl-link" href="${siteHref(ctx, r.id)}" data-open="${r.id}" data-cl-key="${"open:" + sec + ":" + r.id}">${r.label || r.domain || r.id}</a>${newDot(r)}${stagePill(r)}</div>
<div class="cl-l2">${second}</div>
</li>`;
}

// The second line's parts, each in its own box. clients.css draws the "·" before every part and hides
// the one that starts a line, so a wrapped line never starts or ends with a separator.
const join = (parts) => parts.filter((x) => x != null && x !== "" && x !== false).map((x) => html`<span class="cl-part">${x}</span>`);

function termsHtml(r) {
  const t = clientTerms(r);
  return t ? html`<span class="cl-terms">${t}</span>` : html`<span class="cl-dim">No terms yet</span>`;
}

function activityText(ctx, r) {
  return r.lastActivity ? "Last activity " + ago(r.lastActivity, ctx.today) : "No activity yet";
}

function cardHtml(sec, head, body, { count, action, id } = {}) {
  return html`<section class="cl-card" data-cl-card="${sec}" aria-labelledby="${"cl-h-" + (id || sec)}"><header class="cl-card-h"><h2 class="cl-h" id="${"cl-h-" + (id || sec)}">${head}${count != null ? html` <span class="cl-n">(${num(count)})</span>` : ""}</h2>${action || ""}</header>${body}</section>`;
}

function emptyLine(text) {
  return html`<p class="cl-none">${text}</p>`;
}

function headerHtml(ctx, c, p, m) {
  const who = clientToken(c, p);
  const sub = [c.past ? "Past client" : "", c.what, c.markets, c.managers && c.managers.length ? "Managed by " + names(c.managers) : ""].filter(has).join(" · ");
  const products = c.products && c.products.length;
  const addLabel = products && !p ? "+ Add site for " + c.name + "…" : "+ Add site for " + who;
  const acts = html`<div class="cl-head-acts"><button type="button" class="ui-btn is-primary" data-cl-act="report" data-cl-key="act:report">Report</button>${c.past ? "" : html`<button type="button" class="ui-btn" data-cl-act="add" data-cl-key="act:add" data-write${products && !p ? html` aria-haspopup="menu"` : ""}>${addLabel}</button>`}<a class="ui-btn" href="${sitesHref(ctx, c, p)}" data-cl-key="act:all">See all ${num(m.sites)} ${plural(m.sites, "site")}</a></div>`;
  return html`<nav class="cl-crumb" aria-label="Breadcrumb"><a href="${ctx.href("clients")}" data-cl-key="crumb">Clients</a><span aria-hidden="true"> ›</span></nav>
<header class="cl-head"><div class="cl-titles"><h1 tabindex="-1">${c.name}</h1>${sub ? html`<p class="cl-sub">${sub}</p>` : ""}</div>${acts}</header>`;
}

function productsHtml(c, p) {
  if (!c.products || !c.products.length) return "";
  const chip = (value, label) => html`<button type="button" class="ui-chipbtn cl-chip" data-cl-product="${value}" data-cl-key="${"product:" + value}" aria-pressed="${(p || "") === value ? "true" : "false"}">${label}</button>`;
  return html`<div class="cl-products" role="group" aria-label="Show one product">${chip("", "All")}${c.products.map((x) => chip(x, x))}</div>`;
}

function stripHtml(ctx, c, p, m) {
  const link = (stage) => sitesHref(ctx, c, p, { stage });
  const research = m.byStage.Researching || 0;
  const tiles = [
    { k: "prospects", n: num(m.prospects), l: "Prospects", tip: "Found, not contacted yet", href: research ? "" : link("New") },
    { k: "emailed", n: num(m.emailed), l: "Emailed", tip: "Emailed, waiting for an answer", href: link("Contacted") },
    { k: "replied", n: num(m.replied), l: "Replied", tip: "Wrote back; the owner answers next", href: link("Replied") },
    { k: "rate", n: rateText(m.replyRate), l: "Reply rate", tip: "Sites that wrote back (Replied, Negotiating, Active or Lost) out of every site emailed", sub: num(m.wroteBack) + " of " + num(m.contacted) },
    { k: "talks", n: num(m.inTalks), l: "In talks", tip: "Negotiating: talking terms", href: link("Negotiating") },
    { k: "active", n: num(m.active), l: "Active", tip: "Agreed to work with us", href: link("Active") },
    { k: "live", n: num(m.live), l: "Live", tip: "Active with a placement link" },
  ];
  const tile = (t) => {
    const inner = html`<span class="cl-tile-n">${t.n}</span><span class="cl-tile-l">${t.l}</span>${t.sub ? html`<span class="cl-tile-s">${t.sub}</span>` : ""}`;
    return t.href
      ? html`<li><a class="cl-tile is-link" href="${t.href}" title="${t.tip}" data-cl-key="${"tile:" + t.k}" data-cl-tile="${t.k}">${inner}</a></li>`
      : html`<li><span class="cl-tile" title="${t.tip}" data-cl-tile="${t.k}">${inner}</span></li>`;
  };
  return html`<section class="cl-strip" aria-labelledby="cl-h-nums"><h2 class="sr-only" id="cl-h-nums">Numbers</h2><ul class="cl-tiles">${tiles.map(tile)}</ul><p class="cl-note" title="${TEST_TIP}">Current counts. Outreach is in test mode.</p></section>`;
}

function waitingHtml(ctx, c, p, list) {
  if (!list.length) return "";
  const rows = list.map((r) => siteRow(ctx, r, "waiting", join([
    termsHtml(r),
    has(r.nextText) ? html`<span class="cl-wait-text">${r.nextText}</span>` : html`<span class="cl-dim">No details</span>`,
    ownerText(r),
    r.quietDays != null ? "waiting " + num(r.quietDays) + "d" : "",
  ])));
  const action = html`<button type="button" class="ui-btn is-sm" data-cl-act="copy-waiting" data-cl-key="act:copy-waiting" title="Names, terms and what you are waiting for. No notes, owners or emails.">Copy list for client</button>`;
  return cardHtml("waiting", "Waiting on " + clientToken(c, p), html`<ul class="cl-rows">${rows}</ul>`, { count: list.length, action });
}

function dealsHtml(ctx, c, p, list) {
  const rows = list.map((r) => siteRow(ctx, r, "deals", join([
    termsHtml(r),
    r.waitingOnClient ? waitingBadge(r) : "",
    ownerText(r),
    activityText(ctx, r),
  ])));
  const body = rows.length ? html`<ul class="cl-rows">${rows}</ul>` : emptyLine("No deals yet. Sites move here when they reach Negotiating.");
  return cardHtml("deals", "Deals", body, { count: list.length });
}

function liveWhen(ctx, r) {
  if (!r.live_date) return html`<span class="cl-dim">Live date not set</span>`;
  const future = r.live_date > ctx.today;
  return future ? html`<span class="cl-soon">Goes live ${fmtDate(r.live_date)}</span>` : "Went live " + fmtDate(r.live_date, "year");
}

function liveHtml(ctx, c, p, list) {
  const rows = list.map((r) => {
    const url = safeUrl(r.content_url);
    const short = url.replace(/^https?:\/\//i, "").replace(/^www\./i, "").replace(/\/$/, "");
    return siteRow(ctx, r, "live", join([
      liveWhen(ctx, r),
      url ? html`<a class="cl-out" href="${url}" target="_blank" rel="noopener noreferrer" data-cl-key="${"out:" + r.id}">${short}<span aria-hidden="true"> ↗</span></a>` : html`<span class="cl-dim">No web link</span>`,
      ownerText(r),
    ]));
  });
  const body = rows.length ? html`<ul class="cl-rows">${rows}</ul>` : emptyLine("No live placements yet.");
  return cardHtml("live", "Live placements", body, { count: list.length });
}

function prospectsHtml(ctx, c, p, best) {
  const rows = best.rows.map((r) => siteRow(ctx, r, "prospects", join([
    has(r.domain) && r.domain !== r.label ? html`<span class="cl-dom">${r.domain}</span>` : "",
    r.dr != null ? html`<span title="${DR_TIP}">DR ${num(r.dr)}</span>` : html`<span class="cl-dim" title="${DR_TIP}">No DR</span>`,
    ownerText(r),
  ])));
  const more = best.total > best.rows.length
    ? html`<div class="cl-card-f"><a href="${sitesHref(ctx, c, p, { stage: "New" })}" data-cl-key="more:prospects">See new sites for ${clientToken(c, p)} in Sites</a></div>`
    : "";
  const body = rows.length
    ? html`<ul class="cl-rows">${rows}</ul>${more}`
    : emptyLine("No new prospects. Monday's discovery adds new sites.");
  return cardHtml("prospects", "Best new prospects", body, { count: best.total });
}

function pipelineHtml(ctx, c, p, m) {
  const rows = pipelineRows(ctx.store.all(), { meta: meta(ctx), client: c.k, product: p });
  const body = m.sites
    ? bars(rows.map((r) => ({ label: r.stage, value: r.n, href: sitesHref(ctx, c, p, { stage: r.stage }), tone: r.color })), { title: "" })
    : emptyLine("No sites for " + clientToken(c, p) + " yet.");
  return cardHtml("pipeline", "Pipeline", html`<div class="cl-pipe">${body}</div>`, { count: m.sites });
}

// ---------- Affiliate program ----------

function programView(ctx, c) {
  const pr = st.prog;
  const write = !readOnly(ctx);
  if (pr.state === "idle" || pr.state === "loading") return html`<div class="cl-prog">${skeletonRows(3, { lines: 1 })}</div>`;
  if (pr.state === "na") return emptyLine(snapshot() ? "Open the live site to see this." : "Not available yet.");
  if (pr.state === "error") {
    return html`<div class="cl-prog"><p class="cl-none">Couldn't load the program.</p><button type="button" class="ui-btn is-sm" data-cl-act="prog-retry" data-cl-key="act:prog-retry">Retry</button></div>`;
  }
  const g = pr.row || {};
  const rows = [
    ["Network", g.network],
    ["Commission", g.commission],
    ["Cookie length", g.cookie_days != null && g.cookie_days !== "" ? num(g.cookie_days) + " " + plural(g.cookie_days, "day") : ""],
    ["Payouts", g.payout_terms],
  ];
  const link = safeUrl(g.signup_url);
  const any = rows.some((x) => has(x[1])) || has(g.signup_url) || has(g.brief);
  if (!any) {
    return html`<div class="cl-prog"><p class="cl-none">No program details yet: network, commission, cookie length, payouts and a brief for partners.</p>${write ? html`<button type="button" class="ui-btn is-sm" data-cl-act="prog-edit" data-cl-key="act:prog-edit" data-write>Add program details</button>` : ""}</div>`;
  }
  return html`<div class="cl-prog"><dl class="cl-dl">${rows.filter((x) => has(x[1])).map(([k, v]) => html`<div><dt>${k}</dt><dd>${v}</dd></div>`)}${has(g.signup_url) ? html`<div><dt>Partner sign-up link</dt><dd>${link ? html`<a href="${link}" target="_blank" rel="noopener noreferrer">${link.replace(/^https?:\/\//i, "")}<span aria-hidden="true"> ↗</span></a>` : g.signup_url}</dd></div>` : ""}${has(g.brief) ? html`<div class="is-wide"><dt>Brief for partners</dt><dd class="cl-brief">${g.brief}</dd></div>` : ""}</dl>${has(g.updated_by) || has(g.updated_at) ? html`<p class="cl-updated">Updated${has(g.updated_by) ? " by " + g.updated_by : ""}${has(g.updated_at) ? ", " + fmtDate(g.updated_at, "year") : ""}</p>` : ""}</div>`;
}

function programForm(c) {
  const pr = st.prog;
  const d = pr.draft || {};
  const err = pr.err;
  const inv = (name) => (pr.field === name ? html` aria-invalid="true" aria-describedby="cl-prog-err"` : "");
  return html`<form class="cl-prog-form" data-cl-prog-form novalidate aria-label="${"Affiliate program for " + c.name}">
${PROGRAM_FIELDS.map((f) => html`<label class="ui-field${f.area ? " is-wide" : ""}"><span class="ui-label">${f.label}</span>${f.area
    ? html`<textarea class="ui-input cl-ta" name="${f.name}" maxlength="${f.max}" rows="4" placeholder="${f.placeholder}"${inv(f.name)}>${d[f.name] || ""}</textarea>`
    : html`<input class="ui-input" name="${f.name}" maxlength="${f.max}" autocomplete="off" placeholder="${f.placeholder}" value="${d[f.name] == null ? "" : d[f.name]}"${f.numeric ? html` inputmode="numeric"` : ""}${f.url ? html` type="url" inputmode="url" spellcheck="false"` : ""}${inv(f.name)}>`}</label>`)}
<p class="ui-error is-wide" id="cl-prog-err" role="alert"${err ? "" : html` hidden`}>${err}</p>
<div class="cl-prog-acts is-wide"><button type="button" class="ui-btn is-ghost" data-cl-act="prog-cancel">Cancel</button><button type="submit" class="ui-btn is-primary"${pr.saving ? html` disabled` : ""}>${pr.saving ? "Saving…" : "Save program"}</button></div>
</form>`;
}

function programHtml(ctx, c) {
  const pr = st.prog;
  const write = !readOnly(ctx);
  const canEdit = write && !pr.editing && pr.state === "ready" && pr.row && Object.keys(pr.row).some((k) => k !== "k" && has(pr.row[k]));
  const action = canEdit ? html`<button type="button" class="ui-btn is-sm is-ghost" data-cl-act="prog-edit" data-cl-key="act:prog-edit" data-write>Edit</button>` : "";
  return cardHtml("program", "Affiliate program", pr.editing ? programForm(c) : programView(ctx, c), { action });
}

async function loadProgram() {
  const s = st;
  const c = currentClient(s.ctx);
  if (!c) return;
  s.prog.state = "loading";
  drawProgram();
  let rows = null;
  let failed = false;
  try {
    const api = s.ctx.api;
    rows = api && typeof api.programs === "function" ? await api.programs() : null;
  } catch (e) {
    failed = true;
  }
  if (st !== s) return;
  if (failed) s.prog.state = "error";
  else if (rows == null || !Array.isArray(rows)) s.prog.state = "na";
  else {
    s.prog.state = "ready";
    s.prog.row = rows.find((x) => x && String(x.k).toLowerCase() === String(c.k).toLowerCase()) || null;
  }
  drawProgram();
}

function formValues(form) {
  const out = {};
  for (const f of PROGRAM_FIELDS) {
    const el = form.elements[f.name];
    out[f.name] = el ? String(el.value).trim() : "";
  }
  return out;
}

function startEdit() {
  const g = st.prog.row || {};
  const d = {};
  for (const f of PROGRAM_FIELDS) d[f.name] = g[f.name] == null ? "" : String(g[f.name]);
  st.prog.editing = true;
  st.prog.err = "";
  st.prog.field = "";
  st.prog.draft = d;
  st.prog.start = JSON.stringify(d);
  drawProgram();
  const first = st.root.querySelector("[data-cl-prog-form] input");
  if (first) first.focus();
}

function programDirty() {
  if (!st || !st.prog.editing) return false;
  const form = st.root.querySelector("[data-cl-prog-form]");
  if (!form) return false;
  return JSON.stringify(formValues(form)) !== st.prog.start;
}

function stopEdit() {
  st.prog.editing = false;
  st.prog.err = "";
  st.prog.field = "";
  st.prog.draft = null;
  drawProgram();
  const b = st.root.querySelector('[data-cl-card="program"] [data-cl-act="prog-edit"]') || st.root.querySelector("#cl-h-program");
  if (b) b.focus({ preventScroll: true });
}

async function saveProgram(form) {
  const s = st;
  const c = currentClient(s.ctx);
  if (!c || s.prog.saving) return;
  const v = formValues(form);
  s.prog.draft = v;
  let err = "";
  let field = "";
  if (v.signup_url && !/^https?:\/\/\S+$/i.test(v.signup_url)) {
    err = "The sign-up link must start with http:// or https://.";
    field = "signup_url";
  } else if (v.cookie_days !== "" && !(/^\d+$/.test(v.cookie_days) && Number(v.cookie_days) <= 3650)) {
    err = "Cookie length is a number of days (0 to 3650).";
    field = "cookie_days";
  }
  if (err) {
    s.prog.err = err;
    s.prog.field = field;
    drawProgram();
    const el = st.root.querySelector('[data-cl-prog-form] [name="' + field + '"]');
    if (el) el.focus();
    return;
  }
  s.prog.saving = true;
  s.prog.err = "";
  s.prog.field = "";
  drawProgram();
  let res = null;
  let fail = "";
  try {
    const api = s.ctx.api;
    res = api && typeof api.saveProgram === "function" ? await api.saveProgram(c.k, v) : null;
    if (res == null) fail = "Not available yet.";
  } catch (e) {
    fail = (e && (e.friendly || e.message)) || "Not saved. Try again.";
  }
  if (st !== s) return;
  s.prog.saving = false;
  if (fail) {
    s.prog.err = fail;
    drawProgram();
    return;
  }
  s.prog.row = (res && res.program) || Object.assign({ k: c.k }, v);
  s.prog.state = "ready";
  stopEdit();
  toast("Program saved for " + c.name + ".", { kind: "success" });
}

// ---------- drawing ----------

const FOCUS_SEL = "[data-cl-key]";

function keepFocus(fn) {
  const a = typeof document !== "undefined" ? document.activeElement : null;
  const key = a && st.root.contains(a) && a.getAttribute ? a.getAttribute("data-cl-key") : null;
  fn();
  if (!key) return;
  const el = Array.from(st.root.querySelectorAll(FOCUS_SEL)).find((x) => x.getAttribute("data-cl-key") === key);
  if (el && el !== document.activeElement) el.focus({ preventScroll: true });
}

function el(sel) {
  return st && st.root ? st.root.querySelector(sel) : null;
}

function drawProgram() {
  if (!st) return;
  const box = el("[data-cl-program]");
  const c = currentClient(st.ctx);
  if (!box || !c) return;
  keepFocus(() => render(box, programHtml(st.ctx, c)));
}

function drawClient(ctx, c) {
  const p = currentProduct(ctx, c);
  const recs = ctx.store.all();
  const o = { meta: meta(ctx), client: c.k, product: p };
  const m = clientMetrics(recs, o);
  const ready = loaded(ctx);
  const waiting = waitingList(recs, o);
  const deals = dealList(recs, o);
  const live = liveList(recs, o);
  const best = bestProspects(recs, o);
  st.lists = { waiting: waiting.map((r) => r.id), deals: deals.map((r) => r.id), live: live.map((r) => r.id), prospects: best.rows.map((r) => r.id) };
  keepFocus(() => {
    render(el("[data-cl-top]"), html`${headerHtml(ctx, c, p, m)}${productsHtml(c, p)}${ready ? stripHtml(ctx, c, p, m) : html`<div class="cl-card">${skeletonRows(2, { lines: 1 })}</div>`}`);
    render(el("[data-cl-left]"), ready
      ? html`${waitingHtml(ctx, c, p, waiting)}${dealsHtml(ctx, c, p, deals)}${liveHtml(ctx, c, p, live)}${prospectsHtml(ctx, c, p, best)}`
      : html`<div class="cl-card">${skeletonRows(6)}</div>`);
    render(el("[data-cl-pipeline]"), ready ? pipelineHtml(ctx, c, p, m) : "");
  });
  return m;
}

function draw() {
  if (!st) return;
  const ctx = st.ctx;
  if (!st.sub) {
    keepFocus(() => render(st.root, listHtml(ctx)));
    return;
  }
  const c = currentClient(ctx);
  if (!c) {
    render(st.root, html`<div class="cl-page"><nav class="cl-crumb" aria-label="Breadcrumb"><a href="${ctx.href("clients")}">Clients</a><span aria-hidden="true"> ›</span></nav><h1 tabindex="-1">Client not found</h1><p class="cl-sub">There's no client at this address. It may have been renamed in Help › Settings.</p><p><a class="ui-btn" href="${ctx.href("clients")}">See all clients</a></p></div>`);
    return;
  }
  drawClient(ctx, c);
}

function schedule() {
  if (!st || st.frame) return;
  const raf = typeof requestAnimationFrame === "function" ? requestAnimationFrame : (fn) => setTimeout(fn, 16);
  st.frame = raf(() => {
    if (!st) return;
    st.frame = 0;
    draw();
  });
}

function clientShell() {
  return html`<div class="cl-page cl-client"><div data-cl-top></div><div class="cl-grid"><div class="cl-main" data-cl-left></div><div class="cl-side"><div data-cl-pipeline></div><div data-cl-program></div></div></div></div>`;
}

// ---------- actions ----------

function openRow(id, sec) {
  const ids = (st.lists && st.lists[sec]) || [];
  const index = ids.indexOf(String(id));
  closeAll();
  const c = currentClient(st.ctx);
  const label = (c ? c.name + " · " : "") + (SECTION_LABEL[sec] || "Sites");
  if (index >= 0 && ids.length > 1) st.ctx.openRecord(String(id), { queue: { ids, index, label } });
  else st.ctx.openRecord(String(id));
}

async function addSite(btn) {
  const c = currentClient(st.ctx);
  if (!c || readOnly(st.ctx)) return;
  const p = currentProduct(st.ctx, c);
  if (c.products && c.products.length && !p) {
    const v = await openMenu(btn, { label: "Which product?", items: c.products.map((x) => ({ label: clientToken(c, x), value: x })) });
    if (v == null || !st) return;
    openAddSite({ clients: clientToken(c, v) });
    return;
  }
  openAddSite({ clients: clientToken(c, p) });
}

async function copyWaiting() {
  const ctx = st.ctx;
  const c = currentClient(ctx);
  if (!c) return;
  const p = currentProduct(ctx, c);
  const list = waitingList(ctx.store.all(), { meta: meta(ctx), client: c.k, product: p });
  const ok = await copyText(waitingCopyText(list, { client: c, product: p, today: ctx.today }));
  if (ok) toast("List copied. Paste it into your message to " + clientToken(c, p) + ".", { kind: "success" });
  else toast("Couldn't copy. Your browser blocked the clipboard.", { kind: "error" });
}

function bind() {
  const root = st.root;
  const offs = st.offs;
  offs.push(bindInlineEdits(root, {}));
  offs.push(on(root, "click", "[data-cl-report]", (e, b) => {
    e.preventDefault();
    openReport({ clientKey: b.getAttribute("data-cl-report") });
  }));
  offs.push(on(root, "click", "tr[data-cl-go]", (e, tr) => {
    if (e.target.closest("a,button,input,select,textarea,label,summary")) return;
    const sel = typeof window !== "undefined" && window.getSelection ? String(window.getSelection()) : "";
    if (sel) return;
    st.ctx.go("clients", {}, { sub: tr.getAttribute("data-cl-go") });
  }));
  offs.push(on(root, "click", "a[data-open]", (e, a) => {
    if (e.ctrlKey || e.metaKey || e.shiftKey || e.altKey || e.button === 1) return; // a new tab
    e.preventDefault();
    const row = a.closest("[data-cl-sec]");
    openRow(a.getAttribute("data-open"), row ? row.getAttribute("data-cl-sec") : "");
  }));
  offs.push(on(root, "click", ".cl-srow", (e, row) => {
    if (e.target.closest("a,button,input,select,textarea,label,summary,form,[data-edit],[popover]")) return;
    const sel = typeof window !== "undefined" && window.getSelection ? String(window.getSelection()) : "";
    if (sel) return;
    openRow(row.getAttribute("data-rec"), row.getAttribute("data-cl-sec"));
  }));
  offs.push(on(root, "click", "[data-cl-product]", (e, b) => {
    e.preventDefault();
    const v = b.getAttribute("data-cl-product");
    st.ctx.setParams({ product: v || null }, { replace: true });
  }));
  offs.push(on(root, "click", "[data-cl-act]", (e, b) => {
    const act = b.getAttribute("data-cl-act");
    e.preventDefault();
    const c = currentClient(st.ctx);
    if (act === "report" && c) openReport({ clientKey: c.k, product: currentProduct(st.ctx, c) || undefined });
    else if (act === "add") addSite(b);
    else if (act === "copy-waiting") copyWaiting();
    else if (act === "prog-edit") startEdit();
    else if (act === "prog-cancel") stopEdit();
    else if (act === "prog-retry") loadProgram();
  }));
  offs.push(on(root, "submit", "[data-cl-prog-form]", (e, form) => {
    e.preventDefault();
    saveProgram(form);
  }));
  offs.push(on(root, "keydown", "[data-cl-prog-form]", (e) => {
    if (e.key !== "Escape" || st.prog.saving) return;
    e.preventDefault();
    e.stopPropagation();
    if (!programDirty()) {
      stopEdit();
      return;
    }
    askDiscard().then((ok) => { if (ok && st) stopEdit(); });
  }));
  // The past clients' group keeps its open state across redraws (toggle doesn't bubble: capture).
  const onToggle = (e) => {
    const d = e.target;
    if (d && d.matches && d.matches("details[data-cl-past]")) st.pastOpen = d.open;
  };
  root.addEventListener("toggle", onToggle, true);
  offs.push(() => root.removeEventListener("toggle", onToggle, true));
}

function askDiscard() {
  return confirm({ title: "Discard your changes?", body: "Your changes to the affiliate program aren't saved yet.", confirmLabel: "Discard", cancelLabel: "Keep editing", danger: true });
}

export default {
  id: "clients",
  title,
  mount(root, ctx) {
    if (st) this.unmount();
    st = fresh(root, ctx);
    if (st.sub) render(root, clientShell());
    bind();
    draw();
    const c = currentClient(ctx);
    if (st.sub && c) {
      loadProgram();
      // Typed program details survive a route change only when the person says so (spec 4.2's guard).
      st.guardOff = router.addGuard((next) => {
        if (!st || !programDirty()) return true;
        if (next && next.page === "clients" && next.sub === st.sub) return true;
        return askDiscard();
      });
    }
    if (loaded(ctx)) {
      if (!st.sub) ctx.announce("Clients, " + num((meta(ctx).clients || []).length) + " " + plural((meta(ctx).clients || []).length, "client"));
      else if (c) {
        const m = clientMetrics(ctx.store.all(), { meta: meta(ctx), client: c.k, product: currentProduct(ctx, c) });
        ctx.announce(c.name + ", " + num(m.sites) + " " + plural(m.sites, "site"));
      }
    }
  },
  update(ctx, change) {
    if (!st) return;
    st.ctx = ctx;
    if (change && change.kind === "meta" && st.sub && !st.prog.editing) drawProgram();
    schedule();
  },
  unmount() {
    if (!st) return;
    const caf = typeof cancelAnimationFrame === "function" ? cancelAnimationFrame : clearTimeout;
    if (st.frame) caf(st.frame);
    if (st.guardOff) st.guardOff();
    for (const off of st.offs) {
      try { off(); } catch (e) { /* already gone */ }
    }
    st = null;
  },
};
