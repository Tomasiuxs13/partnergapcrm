// Team overview (spec 2.2.5, Appendix B.7). Page module contract (spec 5.4). Owner F6.
//
// #team, top to bottom:
// 1. Needs a decision: Negotiating deals not waiting on the client, every owner, grouped by owner (rules/team.js).
//    Each row: the site (opens in queue mode over the whole list), client tags, the terms, the next step with its
//    date and "Quiet Nd", the "Waiting on client?" tick box when the next step names the client or says
//    "waiting" (one click ticks it, with Undo in the toast) and [Log what happened ▾].
// 2. Stuck: 5 tiles with a big number; each opens the sites behind it.
// 3. Team: one row per person (then past owners, then "No owner"). Every number opens a list with the same
//    count: Sites when Sites can show exactly those sites, else this page's own list (#team?show=<flag>&
//    owner=<name|none>, rules/team.js#target). A name opens Edit history for that person. Changes this week
//    and Last active come from GET /api/team-activity.
// 4. Morning run card: open suggestions by kind and client (GET /api/suggestions) with a link to Sites › Has a
//    suggestion, and the latest runs (GET /api/runs) once there are any; before that, the fallback text.
// 5. Data clean-up card: five read-only counts with links.
// 6. Charts, collapsed; drawn when opened (ui/charts.js bars: labels and values are text).
// #team?show=<flag>[&owner=…]: one list (ui/list.js) under "‹ Team overview", with CSV and queue mode.
// Every write goes through ui/actions.js (the tick box, the row menus). Endpoints that aren't there yet
// (api.* gives null) show "Not available yet"; the page never remounts itself on updates.
import { html, render, on } from "../core/dom.js";
import { num, plural, date as fmtDate, toDay, daysBetween } from "../core/format.js";
import * as rules from "../rules/team.js";
import { isQuiet } from "../rules/deals.js";
import { createList } from "../ui/list.js";
import { bars } from "../ui/charts.js";
import { clientTags, dueBadge, avatar, newDot } from "../ui/pills.js";
import { rowActions, bindInlineEdits } from "../ui/inline-edit.js";
import { emptyState } from "../ui/empty.js";
import { skeletonRows } from "../ui/skeleton.js";

const TITLE = "Team overview";
const SUB = "What needs a decision, what is stuck, and how each person is doing.";
const DECISION_QUEUE = "Needs a decision";
const NOT_AVAILABLE = "Not available yet";
const LIVE_ONLY = "Open the live site to see this."; // a snapshot has no suggestions (spec 4.14)
const snapshot = () => typeof window !== "undefined" && !!window.__SNAPSHOT__;
const FALLBACK = "Suggestions from the morning run (contacts found, test emails) appear here once it writes them to the site. Until then they're in the daily review in the CRM project.";
const SHEET_NOTE = "Changes made in the Google Sheet or brought in from Gmail aren't counted here.";

const STUCK_TEXT = {
  overdue: { label: "Overdue follow-ups", desc: "The follow-up date has passed." },
  unanswered: { label: "Unanswered replies (3+ days)", desc: "Wrote back 3+ days ago. Nobody has answered." },
  quiet: { label: "Deals going quiet", desc: "Talking terms or signed, and nothing new for a while." },
  noreply: { label: "No reply in 14+ days", desc: "Emailed over 14 days ago. No answer yet." },
  unowned: { label: "Unowned new prospects", desc: "New sites nobody owns yet." },
};

// The Team table columns, in the order of spec 2.2.5. n: a site count that opens a list.
const COLS = [
  { id: "owns", label: "Owns", n: true, title: "Sites this person owns, in every stage" },
  { id: "prospects", label: "Prospects", n: true, title: "Not contacted yet (New or Researching)" },
  { id: "emailed", label: "Emailed", n: true, title: "Emailed and waiting for an answer (Contacted)" },
  { id: "negotiating", label: "Negotiating", n: true, title: "Talking terms" },
  { id: "active", label: "Active", n: true, title: "Agreed to work with us" },
  { id: "replies", label: "Replies waiting", n: true, title: "Wrote back recently and nobody has answered yet" },
  { id: "clients", label: "Clients managed", title: "Clients this person manages" },
  { id: "changes", label: "Changes this week", title: "Edits made on this site in the last 7 days" },
  { id: "overdue", label: "Overdue now", n: true, title: "Open sites whose follow-up date has passed" },
  { id: "quiet", label: "Quiet deals now", n: true, title: "Deals going quiet: talking terms, or signed without a placement, and nothing new for a while" },
  { id: "last", label: "Last active", title: "This person's latest edit on this site" },
];

const CLEAN_TEXT = {
  replied_nodate: "Replied with no date",
  replied_old: "Replied, last touch over 30 days",
  no_owner: "No owner",
  odd_clients: "Client name variants",
  no_type: "Type not set",
};

const RUN_LABEL = { daily: "Last copy to the Google Sheet", discovery: "Last search for new sites" };
const RUN_STATUS = { ok: "Done", done: "Done", error: "Failed", failed: "Failed", running: "Running" };

const has = (v) => v != null && String(v).trim() !== "";
const title = () => TITLE;
const sitesText = (n) => num(n) + " " + plural(n, "site");
const dash = html`<span class="ui-faint" aria-label="none">—</span>`;

let st = null; // the mounted page's state

function fresh(root, ctx) {
  return {
    root, ctx, offs: [], frame: 0, pending: null, announced: false, sayTimer: 0, actTimer: 0, token: 0,
    view: "", // "overview" | "list"
    listKey: "", list: null, listRows: [], listTitle: "",
    vm: null, // the overview's numbers
    activity: undefined, sugg: undefined, runs: undefined, // undefined: loading, null: not there, {error}: failed
    scrollY: 0, back: null, // where the overview was when a number opened a list
    busy: new Set(), // tick boxes saving
  };
}

// ---------- data ----------

function params(ctx) {
  return (ctx && ctx.route && ctx.route.params) || {};
}

function loaded(ctx) {
  const s = ctx.store.status || {};
  return ctx.store.size() > 0 || !s.loading;
}

function readOnly(ctx) {
  return !!(ctx.meta && ctx.meta.read_only);
}

function listKeyOf(ctx) {
  const p = params(ctx);
  return has(p.show) ? String(p.show) + "|" + (has(p.owner) ? String(p.owner) : "") : "";
}

function compute(ctx) {
  const all = ctx.store.all();
  const o = { meta: ctx.meta, today: ctx.today };
  const decision = rules.needsDecision(all, o);
  const ids = [];
  for (const g of decision) for (const r of g.records) ids.push(String(r.id));
  return {
    decision,
    decisionIds: ids,
    stuck: rules.stuck(all, o),
    rows: rules.teamRows(all, ok(st.activity) ? st.activity : null, o),
    cleanup: rules.cleanup(all, o),
    suggSites: all.filter((r) => Number(r.sugg) > 0).length,
  };
}

const ok = (v) => !!v && typeof v === "object" && !v.error;

// One GET; null when the endpoint isn't there, {error} when it failed.
async function fetchOne(fn) {
  try {
    const r = await fn();
    return r == null ? null : r;
  } catch (e) {
    return { error: (e && e.friendly) || "Couldn't load this." };
  }
}

async function fetchSide() {
  if (!st) return;
  const my = ++st.token;
  const api = st.ctx.api;
  const [a, s, r] = await Promise.all([
    fetchOne(() => api.teamActivity({ days: 7 })),
    fetchOne(() => api.suggestions({ status: "open" })),
    fetchOne(() => api.runs({ limit: 10 })),
  ]);
  if (!st || my !== st.token) return;
  st.activity = a;
  st.sugg = s;
  st.runs = r;
  schedule("all");
}

// After an edit made here, "Changes this week" and "Last active" move: read them again (once, 1.5 s later).
function refetchActivity() {
  if (!st) return;
  clearTimeout(st.actTimer);
  st.actTimer = setTimeout(async () => {
    if (!st) return;
    const my = st.token;
    const a = await fetchOne(() => st.ctx.api.teamActivity({ days: 7 }));
    if (!st || my !== st.token || !ok(a)) return;
    st.activity = a;
    schedule("all");
  }, 1500);
}

// ---------- small helpers ----------

function href(t) {
  return st.ctx.href(t.page, t.params);
}

// "Today 10:12", "Yesterday", "Thu 15 Oct", "15 Oct 2025".
function lastText(iso, today) {
  const d = toDay(iso);
  if (!d) return "";
  const n = today ? daysBetween(d, today) : null;
  if (n === 0) return "Today " + fmtDate(iso, "time");
  if (n === 1) return "Yesterday";
  return d.slice(0, 4) === String(today || "").slice(0, 4) ? fmtDate(iso, "short") : fmtDate(iso, "year");
}

// A run's time: "Today 07:47" or "Mon 19 Oct 07:47" (Appendix C: local, with the date when older).
function runWhen(iso, today) {
  const d = toDay(iso);
  if (!d) return "";
  return d === today ? "Today " + fmtDate(iso, "time") : d.slice(0, 4) === String(today || "").slice(0, 4) ? fmtDate(iso, "datetime") : fmtDate(iso, "year");
}

function personName(p) {
  return p.none ? "No owner" : p.name;
}

// ---------- 1. Needs a decision ----------

function quietChip(r) {
  if (!isQuiet(r, { meta: st.ctx.meta })) return "";
  return html`<span class="ui-chip is-warn" title="${"Nothing has happened for " + r.quietDays + " days"}">Quiet ${r.quietDays}d</span>`;
}

function decisionRow(r) {
  const ctx = st.ctx;
  const ro = readOnly(ctx);
  const id = String(r.id);
  const terms = ctx.actions.termsLine(r);
  const hint = !ro && rules.decisionHint(r, { meta: ctx.meta });
  const link = ctx.href("team", Object.assign({}, params(ctx), { rec: id }));
  const next = r.nextText
    ? html`<span class="tm-dnext-text">${r.nextText}</span>`
    : html`<span class="ui-faint">No next step</span>`;
  return html`<li class="tm-drow" data-key="${id}" data-rec="${id}">
<div class="tm-dsite"><a class="ui-row-link tm-dlink" href="${link}" data-tm-open="${id}" data-tm-f="${"open:" + id}">${r.label || r.domain || id}</a>${newDot(r)}<span class="tm-dtags">${clientTags(r, { edit: false, max: 2 })}</span></div>
<div class="tm-dterms">${terms ? html`<span>${terms}</span>` : html`<span class="ui-faint">No terms yet</span>`}</div>
<div class="tm-dnext">${next} <span class="tm-dchips">${dueBadge(r, { today: ctx.today, noDate: !!r.nextText })}${quietChip(r)}</span>${hint ? html`<label class="tm-hint" title="The next step mentions the client or waiting. Tick it and this deal leaves the list until the client answers."><input type="checkbox" data-tm-wait="${id}" data-tm-f="${"wait:" + id}"><span>Waiting on client?</span></label>` : ""}</div>
<div class="tm-dacts">${ro ? "" : rowActions(r, { follow: false })}</div>
</li>`;
}

function decisionHtml(v) {
  if (!v.decision.length) {
    return emptyState({ title: "Nothing needs a decision.", body: "Negotiating deals show here while the next move is ours." });
  }
  return html`${v.decision.map((g) => html`<div class="tm-dgroup" data-tm-group="${g.none ? "none" : g.owner}"><h3 class="tm-dh">${g.none ? "" : avatar(g.owner, { size: "xs" })}<span>${g.owner}</span> <span class="tm-n">(${num(g.records.length)})</span></h3><ul class="tm-drows">${g.records.map(decisionRow)}</ul></div>`)}`;
}

// ---------- 2. Stuck ----------

function stuckHtml(v) {
  return html`${rules.STUCK.map((k) => {
    const n = v.stuck[k];
    const t = STUCK_TEXT[k];
    const inner = html`<span class="tm-tile-n">${num(n)}</span><span class="tm-tile-label">${t.label}</span><span class="tm-tile-desc">${t.desc}</span>`;
    if (!n) return html`<div class="tm-tile is-zero" data-tm-stuck="${k}">${inner}</div>`;
    return html`<a class="tm-tile" href="${href(rules.target(k))}" data-tm-stuck="${k}" data-tm-f="${"stuck:" + k}">${inner}</a>`;
  })}`;
}

// ---------- 3. Team table ----------

function nameCell(p) {
  if (p.none) return html`<span class="tm-person is-none">No owner</span>`;
  return html`<a class="tm-person" href="${st.ctx.href("history", { by: p.name })}" data-tm-f="${"name:" + p.key}" title="${"Changes " + p.name + " made on this site"}">${avatar(p.name, { size: "xs" })}<span>${p.name}</span></a>${p.past ? html` <span class="ui-faint tm-past">(past owner)</span>` : ""}`;
}

function clientsCell(p) {
  if (p.none) return dash;
  if (!p.clients.length) return dash;
  const shown = p.clients.slice(0, 2);
  const more = p.clients.slice(2);
  return html`<span class="tm-clients">${shown.map((c, i) => html`${i ? html`<span aria-hidden="true">, </span>` : ""}<a href="${st.ctx.href("clients", {}, c.slug)}">${c.name}</a>`)}${more.length ? html` <span class="tm-more" title="${more.map((c) => c.name).join(", ")}">+${more.length}<span class="sr-only">: ${more.map((c) => c.name).join(", ")}</span></span>` : ""}</span>`;
}

function activityCell(p, kind) {
  if (p.none) return dash;
  const a = st.activity;
  if (a === undefined) return html`<span class="ui-faint" aria-label="Loading">…</span>`;
  if (!ok(a)) return dash;
  if (kind === "changes") return html`<span class="tm-plain">${num(p.changes || 0)}</span>`;
  if (!p.lastAt) return html`<span class="ui-faint">No edits yet</span>`;
  return html`<span class="tm-last" title="${fmtDate(p.lastAt, "datetime")}">${lastText(p.lastAt, st.ctx.today)}</span>`;
}

function countCell(p, c) {
  const n = p[c.id] || 0;
  if (!n) return html`<span class="tm-zero">0</span>`;
  const t = rules.target(c.id, { owner: p.none ? "none" : p.name });
  return html`<a class="tm-num" href="${href(t)}" data-tm-f="${"cell:" + (p.none ? "none" : p.key) + ":" + c.id}">${num(n)}</a>`;
}

function cellHtml(p, c) {
  if (c.n) return countCell(p, c);
  if (c.id === "clients") return clientsCell(p);
  return activityCell(p, c.id);
}

// Explicit roles: the phone layout turns rows into cards with display: grid, which drops the table roles.
function teamTableHtml(v) {
  return html`<div class="tm-table-wrap"><table class="tm-table" role="table"><caption class="sr-only">Team: sites and changes per person</caption><thead role="rowgroup"><tr role="row"><th scope="col" role="columnheader" class="tm-c-name">Person</th>${COLS.map((c) => html`<th scope="col" role="columnheader" class="${"tm-c-" + c.id + (c.n || c.id === "changes" ? " is-num" : "")}" title="${c.title}">${c.label}</th>`)}</tr></thead><tbody role="rowgroup">${v.rows.map((p) => html`<tr role="row" class="${p.none ? "is-none" : p.past ? "is-past" : ""}" data-tm-person="${p.none ? "none" : p.name}"><th scope="row" role="rowheader" class="tm-c-name">${nameCell(p)}</th>${COLS.map((c) => html`<td role="cell" class="${"tm-c-" + c.id + (c.n || c.id === "changes" ? " is-num" : "")}" data-label="${c.label}" data-tm-cell="${c.id}">${cellHtml(p, c)}</td>`)}</tr>`)}</tbody></table></div>`;
}

function teamNote() {
  const a = st.activity;
  if (a === null) return html`<span class="tm-na">Changes this week and Last active: ${NOT_AVAILABLE}.</span> ${SHEET_NOTE}`;
  if (a && a.error) return html`<span class="tm-na">Changes this week and Last active couldn't load. Reload the page to try again.</span> ${SHEET_NOTE}`;
  return html`${SHEET_NOTE}`;
}

// ---------- 4. Morning run ----------

function runDetail(r) {
  const s = r.summary;
  if (r.status === "error" || r.status === "failed") {
    const why = s && typeof s === "object" ? s.error : typeof s === "string" ? s : "";
    return why ? String(why) : "";
  }
  if (!s || typeof s !== "object") return typeof s === "string" ? s : "";
  const bits = [];
  if (s.edits_applied != null) bits.push(num(s.edits_applied) + " " + plural(s.edits_applied, "change") + " copied");
  if (s.replies) bits.push(num(s.replies) + " " + plural(s.replies, "reply", "replies") + " found");
  if (s.candidates) bits.push(num(s.candidates) + " " + plural(s.candidates, "contact") + " suggested");
  if (s.found != null) bits.push(num(s.found) + " new " + plural(s.found, "site") + " found");
  return bits.join(", ");
}

function runsHtml() {
  const r = st.runs;
  if (!ok(r) || !Array.isArray(r.rows) || !r.rows.length) return "";
  const last = rules.latestRuns(r.rows);
  const lines = ["daily", "discovery"].filter((k) => last[k]).map((k) => {
    const x = last[k];
    const status = RUN_STATUS[String(x.status || "").toLowerCase()] || (has(x.status) ? String(x.status) : "");
    const bad = status === "Failed";
    const detail = runDetail(x);
    return html`<li class="tm-run" data-tm-run="${k}"><span class="tm-run-label">${RUN_LABEL[k]}</span><span class="tm-run-what">${runWhen(x.finished_at || x.started_at, st.ctx.today)}${status ? html` · <span class="${bad ? "tm-bad" : "tm-good"}">${status}</span>` : ""}${detail ? html`<span class="tm-run-detail">${bad ? ": " : " · "}${detail}</span>` : ""}</span></li>`;
  });
  return lines.length ? html`<ul class="tm-runs">${lines}</ul>` : "";
}

function runCardHtml(v) {
  const s = st.sugg;
  const runs = runsHtml();
  if (s === undefined) return html`<div class="tm-mini-skel">${skeletonRows(2, { lines: 1 })}</div>`;
  let body;
  if (!ok(s)) {
    body = html`<p class="tm-fallback">${s && s.error ? "Suggestions couldn't load. Reload the page to try again." : snapshot() ? LIVE_ONLY : FALLBACK}</p>`;
  } else {
    const sum = rules.suggestionSummary(s.rows, { meta: st.ctx.meta });
    if (!sum.total) {
      body = html`<p class="tm-cline">No open suggestions.</p>`;
    } else {
      const link = st.ctx.href("sites", { tab: "all", sugg: "1", big: "1" });
      body = html`<p class="tm-cline"><b>${num(sum.total)} open ${plural(sum.total, "suggestion")}</b></p>
<ul class="tm-kv">${sum.kinds.map((k) => html`<li><span>${k.label}</span><span class="tm-kv-n">${num(k.n)}</span></li>`)}</ul>
<p class="tm-cby"><span class="tm-cby-label">By client:</span> ${sum.clients.map((c, i) => html`${i ? " · " : ""}<span class="tm-nowrap">${c.name} ${num(c.n)}</span>`)}</p>
${v.suggSites ? html`<p class="tm-cline"><a href="${link}" data-tm-sugg data-tm-f="sugg">See the ${sitesText(v.suggSites)} in Sites › Has a suggestion</a></p>` : ""}`;
    }
  }
  return html`<p class="tm-desc">Each weekday morning it copies changes to the Google Sheet and suggests contacts and emails.</p>${body}${runs}`;
}

// ---------- 5. Data clean-up ----------

function cleanHtml(v) {
  const c = v.cleanup;
  return html`<ul class="tm-kv tm-clean">${rules.CLEANUP.map((k) => {
    const n = c[k];
    const tokens = k === "odd_clients" && c.tokens.length
      ? html`<span class="tm-tokens">${c.tokens.slice(0, 3).map((t, i) => html`${i ? " · " : ""}<span class="tm-nowrap">“${t.raw}”${t.name ? html` → ${t.name}` : html` (not a client)`} (${num(t.n)})</span>`)}${c.tokens.length > 3 ? " · …" : ""}</span>` : "";
    const count = n ? html`<a class="tm-kv-n" href="${href(rules.target(k))}" data-tm-clean="${k}" data-tm-f="${"clean:" + k}">${num(n)}</a>` : html`<span class="tm-kv-n tm-zero" data-tm-clean="${k}">0</span>`;
    return html`<li><span class="tm-kv-label">${CLEAN_TEXT[k]}${tokens}</span>${count}</li>`;
  })}</ul>`;
}

// ---------- 6. Charts ----------

function chartRows(list) {
  return list.map((x) => Object.assign({}, x, { href: x.params ? st.ctx.href("sites", x.params) : undefined }));
}

function chartsHtml() {
  const c = rules.charts(st.ctx.store.all(), { meta: st.ctx.meta });
  const box = (key, inner, note) => html`<div class="tm-chart" data-tm-chart="${key}">${inner}${note ? html`<p class="tm-chart-note">${note}</p>` : ""}</div>`;
  const reply = c.replyRate.length
    ? bars(c.replyRate, { title: "Reply rate by owner (%)", max: 100 })
    : html`<p class="ui-bars-title">Reply rate by owner (%)</p><p class="tm-desc">Shows once someone has emailed 10 or more sites.</p>`;
  return html`<p class="tm-desc tm-charts-help">Numbers are sites. A bar's name opens those sites in Sites.</p><div class="tm-chart-grid">
${box("pipeline", bars(chartRows(c.pipeline), { title: "Pipeline by stage" }))}
${box("clients", bars(chartRows(c.clients), { title: "Sites per client" }))}
${box("types", bars(chartRows(c.types), { title: "Affiliate type (top 10)" }))}
${box("countries", bars(chartRows(c.countries), { title: "Top countries (top 10)" }))}
${box("dr", bars(chartRows(c.dr), { title: "DR bands" }), "DR: Ahrefs domain rating, 0–100.")}
${box("reply", reply, "Sites that wrote back, out of the sites each person emailed (10 or more).")}
</div>`;
}

function drawCharts() {
  const d = st.root.querySelector("[data-tm-charts]");
  const body = st.root.querySelector("[data-tm-charts-body]");
  if (!d || !body || !d.open) return;
  render(body, loaded(st.ctx) ? chartsHtml() : skeletonRows(4, { lines: 1 }));
}

// ---------- focus ----------

function focusKey() {
  const a = typeof document !== "undefined" ? document.activeElement : null;
  if (!a || !st.root.contains(a) || a === document.body) return null;
  if (a.closest("[data-tm-list]")) return null; // the list keeps its own focus
  const f = a.getAttribute("data-tm-f");
  if (f) return { f, row: rowIndex(a) };
  const act = a.getAttribute("data-row-act");
  if (act) return { f: "act:" + act + ":" + (a.getAttribute("data-id") || ""), row: rowIndex(a) };
  return null;
}

function rowIndex(el) {
  const li = el.closest(".tm-drow");
  if (!li) return -1;
  return Array.from(st.root.querySelectorAll(".tm-drow")).indexOf(li);
}

function findKey(f) {
  const esc = (v) => (typeof CSS !== "undefined" && CSS.escape ? CSS.escape(v) : String(v).replace(/"/g, '\\"'));
  if (f.startsWith("act:")) {
    const [, act, id] = f.split(":");
    return st.root.querySelector('[data-row-act="' + esc(act) + '"][data-id="' + esc(id) + '"]');
  }
  return st.root.querySelector('[data-tm-f="' + esc(f) + '"]');
}

function restoreFocus(k) {
  if (!k) return;
  const a = document.activeElement;
  if (a && a !== document.body && a.isConnected && st.root.contains(a)) return;
  let el = findKey(k.f);
  if (!el && k.row >= 0) {
    // The row left the list (ticked, or logged): the row now in its place, else the section heading.
    const rows = st.root.querySelectorAll(".tm-drow");
    const li = rows[Math.min(k.row, rows.length - 1)];
    el = li ? li.querySelector("a[data-tm-open]") : st.root.querySelector("#tm-h-decision");
  }
  if (el) el.focus({ preventScroll: true });
}

// ---------- drawing ----------

function say(text, { now = false } = {}) {
  clearTimeout(st.sayTimer);
  if (now) {
    st.ctx.announce(text);
    return;
  }
  st.sayTimer = setTimeout(() => {
    if (st) st.ctx.announce(text);
  }, 700);
}

function overviewShell() {
  return html`<div class="tm-overview" data-tm-overview hidden>
<header class="tm-head"><h1 tabindex="-1">${TITLE}</h1><p class="tm-sub">${SUB}</p></header>
<section class="tm-sec" aria-labelledby="tm-h-decision"><div class="tm-shead"><h2 class="tm-h" id="tm-h-decision" tabindex="-1">Needs a decision <span class="tm-n" data-tm-n></span></h2><p class="tm-desc">Negotiating deals where the next move is ours. Log what happened, or tick “Waiting on client?” when the client has the next move.</p></div><div class="tm-decision" data-tm-decision></div></section>
<section class="tm-sec" aria-labelledby="tm-h-stuck"><div class="tm-shead"><h2 class="tm-h" id="tm-h-stuck">Stuck</h2><p class="tm-desc">Across the whole team. A number opens the sites behind it.</p></div><div class="tm-tiles" data-tm-stuck-list></div></section>
<section class="tm-sec" aria-labelledby="tm-h-team"><div class="tm-shead"><h2 class="tm-h" id="tm-h-team">Team</h2><p class="tm-desc">A number opens those sites. A name opens that person's changes in Edit history.</p></div><div data-tm-team></div><p class="tm-note" data-tm-team-note></p></section>
<div class="tm-cards">
<section class="ui-card tm-card" aria-labelledby="tm-h-run" data-tm-run-card><h2 class="tm-h" id="tm-h-run">Morning run</h2><div class="tm-card-body" data-tm-runs></div></section>
<section class="ui-card tm-card" aria-labelledby="tm-h-clean" data-tm-clean-card><h2 class="tm-h" id="tm-h-clean">Data clean-up</h2><p class="tm-desc">Bulk clean-ups run once, after Jonas decides.</p><div class="tm-card-body" data-tm-cleanup></div></section>
</div>
<details class="tm-charts" data-tm-charts><summary class="tm-charts-sum" data-tm-f="charts"><h2 class="tm-h">Charts</h2><span class="tm-charts-what">Pipeline, clients, types, countries, DR, reply rate</span></summary><div class="tm-charts-body" data-tm-charts-body></div></details>
</div>`;
}

function drawOverview(what) {
  const ctx = st.ctx;
  const ov = st.root.querySelector("[data-tm-overview]");
  const busy = !loaded(ctx);
  const k = focusKey();
  if (busy) {
    ov.setAttribute("aria-busy", "true");
    render(ov.querySelector("[data-tm-decision]"), skeletonRows(3));
    render(ov.querySelector("[data-tm-stuck-list]"), html`${rules.STUCK.map(() => html`<div class="tm-tile is-zero is-loading" aria-hidden="true"><span class="ui-skel" style="width:40%"></span></div>`)}`);
    render(ov.querySelector("[data-tm-team]"), skeletonRows(6, { lines: 1 }));
    render(ov.querySelector("[data-tm-cleanup]"), skeletonRows(3, { lines: 1 }));
    render(ov.querySelector("[data-tm-runs]"), skeletonRows(2, { lines: 1 }));
    return;
  }
  ov.removeAttribute("aria-busy");
  const v = (st.vm = compute(ctx));
  render(ov.querySelector("[data-tm-n]"), html`(${num(v.decisionIds.length)})`);
  render(ov.querySelector("[data-tm-decision]"), decisionHtml(v));
  render(ov.querySelector("[data-tm-stuck-list]"), stuckHtml(v));
  render(ov.querySelector("[data-tm-team]"), teamTableHtml(v));
  render(ov.querySelector("[data-tm-team-note]"), teamNote());
  render(ov.querySelector("[data-tm-runs]"), runCardHtml(v));
  render(ov.querySelector("[data-tm-cleanup]"), cleanHtml(v));
  if (what !== "side") drawCharts();
  restoreFocus(k);
  if (!st.announced) {
    st.announced = true;
    const n = v.decisionIds.length;
    say(TITLE + ", " + (n ? num(n) + " " + plural(n, "deal needs", "deals need") + " a decision" : "nothing needs a decision"), { now: true });
  }
}

// ---------- the list view (#team?show=<flag>&owner=…) ----------

function listTitleOf(flag, owner) {
  const f = rules.FLAGS[flag];
  if (!f) return "";
  const who = owner === "none" ? "No owner" : owner;
  return f.label + (has(who) && !(flag === "no_owner" && owner === "none") ? " · " + who : "");
}

function listRowsOf(ctx) {
  const p = params(ctx);
  if (!loaded(ctx)) return [];
  return rules.flagged(ctx.store.all(), String(p.show), { meta: ctx.meta, today: ctx.today, owner: has(p.owner) ? String(p.owner) : null });
}

function openList() {
  const ctx = st.ctx;
  const p = params(ctx);
  const flag = String(p.show);
  const owner = has(p.owner) ? String(p.owner) : "";
  const lv = st.root.querySelector("[data-tm-listview]");
  if (st.list) {
    try { st.list.destroy(); } catch (e) { /* already gone */ }
    st.list = null;
  }
  const back = html`<p class="tm-back"><a href="${ctx.href("team")}" data-tm-back><span aria-hidden="true">‹</span>Team overview</a></p>`;
  if (!rules.FLAGS[flag]) {
    st.listTitle = "";
    render(lv, html`${back}<header class="tm-head"><h1 tabindex="-1">This list doesn't exist</h1><p class="tm-sub">The link may be old. Go back to the Team overview and pick a number again.</p></header>`);
    return;
  }
  st.listTitle = listTitleOf(flag, owner);
  render(lv, html`${back}<header class="tm-head"><h1 tabindex="-1">${st.listTitle}</h1><p class="tm-sub">${rules.FLAGS[flag].desc}</p></header><div class="tm-list" data-tm-list></div>`);
  st.listRows = listRowsOf(ctx);
  st.list = createList(lv.querySelector("[data-tm-list]"), {
    id: "team-" + flag,
    rows: () => (st ? st.listRows : []),
    columns: ["site", "stage", "owner", "clients", "next", "last_activity", "actions"],
    csvName: "team-" + flag + (owner ? "-" + owner : ""),
    noun: ["site", "sites"],
    label: st.listTitle,
    queueLabel: st.listTitle,
    loading: () => !!st && !loaded(st.ctx),
    empty: { title: "No sites here now.", body: "They may have moved on since the overview counted them." },
    openRecord: (id, o) => st.ctx.openRecord(id, o || {}),
  });
}

function drawList() {
  if (!st.list) return;
  st.listRows = listRowsOf(st.ctx);
  st.list.refresh();
}

function listSay() {
  return st.listTitle ? st.listTitle + ", " + sitesText(st.listRows.length) : "This list doesn't exist";
}

// Shows the overview or a list for the URL. Remembers where the overview was, and comes back there.
function showView({ first = false } = {}) {
  const ctx = st.ctx;
  const key = listKeyOf(ctx);
  const want = key ? "list" : "overview";
  const ov = st.root.querySelector("[data-tm-overview]");
  const lv = st.root.querySelector("[data-tm-listview]");
  const win = typeof window !== "undefined" ? window : null;
  if (want === "list") {
    if (st.view === "list" && st.listKey === key) return;
    if (st.view === "overview" && win) st.scrollY = win.scrollY || 0;
    st.view = "list";
    st.listKey = key;
    ov.hidden = true;
    lv.hidden = false;
    openList();
    if (!first) {
      if (win && win.scrollTo) win.scrollTo(0, 0);
      const h1 = lv.querySelector("h1");
      if (h1) h1.focus({ preventScroll: true });
    }
    if (loaded(ctx)) {
      st.announced = true;
      say(listSay(), { now: true });
    }
    return;
  }
  if (st.view === "overview") return;
  const fromList = st.view === "list";
  st.view = "overview";
  st.listKey = "";
  if (st.list) {
    try { st.list.destroy(); } catch (e) { /* already gone */ }
    st.list = null;
  }
  render(lv, html``);
  lv.hidden = true;
  ov.hidden = false;
  st.announced = !first && loaded(ctx); // a return trip says the title, not the count again
  drawOverview("all");
  if (fromList) {
    if (win && win.scrollTo) win.scrollTo(0, st.scrollY || 0);
    const el = st.back ? findKey(st.back) : null;
    (el || ov.querySelector("h1")).focus({ preventScroll: true });
    say(TITLE, { now: true });
  }
}

function draw(what = "all") {
  if (!st) return;
  st.frame = 0;
  if (st.view === "list") {
    drawList();
    if (!st.announced && loaded(st.ctx)) {
      st.announced = true;
      say(listSay(), { now: true });
    }
    return;
  }
  drawOverview(what);
}

function schedule(what) {
  if (!st) return;
  st.pending = st.pending && st.pending !== what ? "all" : what;
  if (st.frame) return;
  const raf = typeof requestAnimationFrame === "function" ? requestAnimationFrame : (fn) => setTimeout(fn, 16);
  st.frame = raf(() => {
    if (!st) return;
    const w = st.pending || "all";
    st.pending = null;
    draw(w);
  }) || 1;
}

// ---------- events ----------

function openDecision(e, a) {
  if (e && (e.ctrlKey || e.metaKey || e.shiftKey || e.altKey || e.button === 1)) return; // new tab
  e.preventDefault();
  const id = a.getAttribute("data-tm-open");
  const ids = (st.vm && st.vm.decisionIds) || [];
  const index = ids.indexOf(id);
  st.ctx.openRecord(id, index >= 0 ? { queue: { ids, index, label: DECISION_QUEUE } } : {});
}

// The tick box stays focusable while it saves (a disabled box would drop the focus); a second click waits.
async function tickWaiting(input) {
  const id = input.getAttribute("data-tm-wait");
  if (readOnly(st.ctx)) return;
  if (st.busy.has(id)) {
    input.checked = true;
    return;
  }
  if (!input.checked) return;
  st.busy.add(id);
  let r = null;
  try {
    r = await st.ctx.actions.setWaiting(id, true);
  } catch (e) {
    r = null;
  }
  if (!st) return;
  st.busy.delete(id);
  if (!r && input.isConnected) {
    // Not saved (the toast says why): untick so it can be tried again.
    input.checked = false;
    input.focus({ preventScroll: true });
  }
}

function bind() {
  const root = st.root;
  st.offs.push(on(root, "click", "a[data-tm-open]", openDecision));
  st.offs.push(on(root, "click", ".tm-drow", (e, li) => {
    if (e.target.closest("a,button,input,label,select,textarea,summary,[data-edit]")) return;
    const sel = typeof window !== "undefined" && window.getSelection ? String(window.getSelection()) : "";
    if (sel) return;
    const a = li.querySelector("a[data-tm-open]");
    if (a) a.click();
  }));
  st.offs.push(on(root, "change", "input[data-tm-wait]", (e, input) => tickWaiting(input)));
  // Remember which number opened a list, to come back to it.
  st.offs.push(on(root, "click", "[data-tm-overview] a[data-tm-f]", (e, a) => {
    st.back = a.getAttribute("data-tm-f");
  }));
  st.offs.push(on(root, "toggle", "[data-tm-charts]", () => drawCharts()));
  const dec = root.querySelector("[data-tm-decision]");
  if (dec) st.offs.push(bindInlineEdits(dec, { getRecord: (id) => st && st.ctx.store.get(id) }));
}

export default {
  id: "team",
  title,
  mount(root, ctx) {
    if (st) this.unmount();
    st = fresh(root, ctx);
    render(root, html`<div class="tm-page">${overviewShell()}<div class="tm-listview" data-tm-listview hidden></div></div>`);
    bind();
    showView({ first: true });
    if (!st.announced) ctx.announce(TITLE); // the rows aren't loaded yet: the count follows when they are
    fetchSide();
  },
  update(ctx, change) {
    if (!st) return;
    st.ctx = ctx;
    const kind = change && change.kind;
    if (kind === "route") {
      if (st.frame) {
        const caf = typeof cancelAnimationFrame === "function" ? cancelAnimationFrame : clearTimeout;
        caf(st.frame);
        st.frame = 0;
        st.pending = null;
      }
      showView();
      return;
    }
    if (kind === "store") {
      if (change.reason === "edit" || change.reason === "bulk") refetchActivity();
      schedule("store");
      return;
    }
    if (kind === "meta" || kind === "me") fetchSide();
    schedule("all");
  },
  unmount() {
    if (!st) return;
    const caf = typeof cancelAnimationFrame === "function" ? cancelAnimationFrame : clearTimeout;
    if (st.frame) caf(st.frame);
    clearTimeout(st.sayTimer);
    clearTimeout(st.actTimer);
    st.token++;
    for (const off of st.offs) {
      try { off(); } catch (e) { /* already gone */ }
    }
    if (st.list) {
      try { st.list.destroy(); } catch (e) { /* already gone */ }
    }
    st = null;
  },
};
