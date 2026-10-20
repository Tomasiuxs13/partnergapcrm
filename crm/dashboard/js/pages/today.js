// Today (spec 2.2.1, Appendix B.1-B.3, 4.5, 4.10, 4.12). Page module contract (spec 5.4). Owner F2.
//
// Header: h1 "Today", "Monday 19 October · Kamile" and Start (queue mode over the whole Do now list).
// Three blocks, each hidden when it has no rows; all three empty gives one "All clear" line:
//   1. Do now (N): rules/today.js#doNowInfo. Reason chip, No date chip, stage, clients, next step, and
//      [Log what happened ▾] [Follow up ▾] (ui/actions.js through ui/inline-edit.js). 7 rows, then
//      "Show all N" in place. Header chips All · Replies · Follow-ups · Deals; with Replies picked,
//      "Mark N as handled…" sets a follow-up (default in 2 weeks, next step "Check in" only where empty)
//      in one bulk request after a confirm.
//   2. New prospects: find a contact (7 of N): the daily run's suggested contact inline
//      (GET /api/suggestions?owner=me, once per visit), [Visit site ↗] [Add contact] [Not a fit], and
//      [Copy email] [Sent first email] once the site has a contact. Add contact opens a small form in the
//      row (POST /api/partner/:id/contacts through api.addContact; 409 -> Open that site / Add anyway).
//   3. Coming up (N), collapsed: my sites with a future follow-up date, soonest first.
// A click on a row (outside its buttons) opens the site in queue mode for that block. Phone (< 640 px):
// one column, row actions behind ⋯. The page keeps its own state (picked chip, expanded blocks, open forms)
// across store updates and redraws the blocks in place; it never remounts.
// Without a name (the snapshot) Today shows everyone's sites (rules/today.js: a falsy me = everyone).
import { html, raw, render, on, copyText, safeUrl } from "../core/dom.js";
import { date as fmtDate, num, plural, addDays } from "../core/format.js";
import { doNowInfo, filterDoNow, newProspects, comingUp } from "../rules/today.js";
import { avatar, stagePill, clientTags, reasonChip, dueBadge, waitingBadge, newDot } from "../ui/pills.js";
import { rowActions, bindInlineEdits } from "../ui/inline-edit.js";
import { openMenu, closeAll } from "../ui/menu.js";
import { openModal } from "../ui/dialog.js";
import { toast } from "../ui/toast.js";
import { skeletonRows } from "../ui/skeleton.js";
import { whatsNewBanner } from "../shell/whats-new.js";

const SHOWN = 7;
const SYNC = "Copies to the Google Sheet on the next weekday morning (08:47).";
const TEST_TIP = "Nothing is sent from this site.";
const DR_TIP = "Ahrefs domain rating, 0–100";
const FILTERS = [
  { id: "all", label: "All" },
  { id: "replies", label: "Replies" },
  { id: "followups", label: "Follow-ups" },
  { id: "deals", label: "Deals" },
];
const LABELS = { now: "Do now", prospects: "New prospects", coming: "Coming up" };
const FOCUS_ATTRS = ["data-open", "data-row-act", "data-td-act", "data-edit", "data-td-filter", "data-td-more",
  "data-td-start", "data-td-handled", "data-td-who", "name"];

const has = (v) => v != null && String(v).trim() !== "";
const title = () => "Today";

let st = null; // the mounted page's state

function fresh(root, ctx) {
  return {
    root, ctx,
    offs: [],
    frame: 0,
    filter: "all",
    expanded: { now: false, coming: false },
    comingOpen: false,
    forms: new Map(), // site id -> {email, name, title, linkedin, client, sid, busy, err, field, dupe}
    emails: new Map(), // site id -> an email (just added, or read from the profile)
    sugg: { state: "idle", rows: new Map() }, // state: idle | loading | ready | na | error
    announced: false,
    view: null, // the lists drawn last: {now, prospects, coming}
  };
}

// ---------- data ----------

function me(ctx) {
  try { return ctx.me.get() || null; } catch (e) { return null; }
}

function readOnly(ctx) {
  return !!(ctx.meta && ctx.meta.read_only);
}

// A snapshot (spec 4.14) holds no email address, so it has no Copy email (as in the record panel).
const snapshotMode = () => typeof window !== "undefined" && !!window.__SNAPSHOT__;

function compute(ctx) {
  const records = ctx.store.all();
  const o = { meta: ctx.meta, today: ctx.today, me: me(ctx) };
  const info = doNowInfo(records, o);
  return { info, prospects: newProspects(records, o), coming: comingUp(records, o) };
}

function loaded(ctx) {
  const s = ctx.store.status || {};
  return ctx.store.size() > 0 || (!s.loading && !s.error && s.loadedAt != null) || (!s.loading && !s.error && !!s.checkedAt);
}

// ---------- markup ----------

function rowHref(ctx, id) {
  return ctx.href("today", { rec: id });
}

function linkHtml(ctx, r) {
  return html`<a class="td-link" href="${rowHref(ctx, r.id)}" data-open="${r.id}">${r.label || r.domain || r.id}</a>${newDot(r)}`;
}

function nextHtml(r) {
  if (!has(r.nextText) && !r.waitingOnClient) return "";
  return html`<span class="td-next">${waitingBadge(r)}${has(r.nextText) ? html`<span class="td-next-text">${r.nextText}</span>` : ""}</span>`;
}

function siteRow(ctx, r, lead) {
  return html`<li class="td-row" data-key="${r.id}" data-rec="${r.id}"><span class="td-av">${avatar(r.label || r.domain || r.id)}</span><div class="td-main"><div class="td-l1">${linkHtml(ctx, r)}${lead}</div><div class="td-l2">${stagePill(r)}${clientTags(r, { edit: false })}${nextHtml(r)}</div></div><div class="td-acts">${rowActions(r)}</div></li>`;
}

function footHtml(block, total) {
  if (total <= SHOWN) return "";
  const open = st.expanded[block];
  return html`<button type="button" class="ui-linkbtn td-more" data-td-more="${block}" aria-expanded="${open ? "true" : "false"}">${open ? "Show fewer" : "Show all " + num(total)}</button>`;
}

function chipsHtml(info) {
  const shown = FILTERS.filter((f) => f.id === "all" || info.groups[f.id] > 0);
  if (shown.length <= 2) return ""; // one kind of row: the chips would only repeat the heading
  return html`<div class="td-chips" role="group" aria-label="Show in Do now">${shown.map((f) => html`<button type="button" class="ui-chipbtn td-chip" data-td-filter="${f.id}" aria-pressed="${st.filter === f.id ? "true" : "false"}">${f.label}${f.id === "all" ? "" : html` <span class="td-chip-n">(${num(info.groups[f.id])})</span>`}</button>`)}</div>`;
}

function nowHtml(ctx, info) {
  const rows = filterDoNow(info.rows, st.filter);
  const total = rows.length;
  const shown = st.expanded.now ? rows : rows.slice(0, SHOWN);
  const handled = st.filter === "replies" && total > 0 && !readOnly(ctx)
    ? html`<button type="button" class="ui-btn is-sm td-handled" data-td-handled data-write>Mark ${num(total)} as handled…</button>` : "";
  const capped = info.noreplyTotal > info.counts.noreply && (st.filter === "all" || st.filter === "followups")
    ? html`<p class="td-note">Showing ${num(info.counts.noreply)} of ${num(info.noreplyTotal)} sites with no reply, longest wait first. <a href="${ctx.href("sites", { tab: "waiting", quiet: "14" })}" data-td-noreply>See all in Sites</a></p>` : "";
  const foot = footHtml("now", total);
  return html`<section class="td-block td-now" data-block="now" aria-labelledby="td-now-h"><div class="td-bhead"><h2 class="td-h" id="td-now-h" tabindex="-1">Do now <span class="td-n">(${num(info.rows.length)})</span></h2>${chipsHtml(info)}${handled}</div><ol class="td-rows">${shown.map((x) => siteRow(ctx, x.record, reasonChip(x)))}</ol>${foot || capped ? html`<div class="td-bfoot">${foot}${capped}</div>` : ""}</section>`;
}

function comingHtml(ctx, list) {
  const shown = st.expanded.coming ? list : list.slice(0, SHOWN);
  const foot = footHtml("coming", list.length);
  return html`<details class="td-block td-coming" data-block="coming"${st.comingOpen ? raw(" open") : ""}><summary class="td-bhead td-sum"><h2 class="td-h" id="td-coming-h">Coming up <span class="td-n">(${num(list.length)})</span></h2><span class="td-sum-hint" aria-hidden="true">${st.comingOpen ? "Hide" : "Show"}</span></summary><ol class="td-rows" aria-labelledby="td-coming-h">${shown.map((r) => siteRow(ctx, r, dueBadge(r, { today: ctx.today })))}</ol>${foot ? html`<div class="td-bfoot">${foot}</div>` : ""}</details>`;
}

// ---------- New prospects ----------

function siteUrl(r) {
  const d = String((r && r.domain) || "").trim().replace(/^https?:\/\//i, "");
  return d ? safeUrl("https://" + d) : "";
}

function suggFor(id) {
  const rows = st.sugg.rows.get(String(id)) || [];
  return rows.filter((s) => s.status === "open" || !s.status);
}

function suggHtml(r) {
  if (!(Number(r.sugg) > 0)) return "";
  if (st.sugg.state === "loading" || st.sugg.state === "idle") return "";
  const rows = suggFor(r.id);
  const cand = rows.find((s) => s.kind === "candidate");
  const mail = rows.find((s) => s.kind === "email");
  const write = !readOnly(st.ctx);
  if (cand) {
    const who = [cand.name || "Someone at this site", cand.title].filter(Boolean).join(", ");
    const src = has(cand.source) && !/daily|run|script|cron/i.test(cand.source) ? " (" + cand.source + ")" : "";
    const more = rows.length > 1 ? html` <span class="td-muted">· ${num(rows.length - 1)} more on the site</span>` : "";
    return html`<p class="td-sugg"><span class="td-sugg-k">Suggested:</span> <b>${who}</b>${src}${write ? html` · <button type="button" class="ui-linkbtn" data-td-act="sugg-add" data-sid="${cand.id}" data-write>Add as contact</button>` : ""}${more}</p>`;
  }
  if (mail) {
    return html`<p class="td-sugg"><span class="td-sugg-k">Suggested email:</span> <b>${mail.subject || "No subject"}</b> <span class="td-muted" title="${TEST_TIP}">(test mode)</span> · <button type="button" class="ui-linkbtn" data-td-act="see">See it</button></p>`;
  }
  return html`<p class="td-sugg td-muted">Has a suggestion from the morning run. <button type="button" class="ui-linkbtn" data-td-act="see">See it</button></p>`;
}

function dupeHtml(f, r) {
  const d = f.dupe;
  if (!d) return "";
  const same = d.account_id && String(d.account_id) === String(r.id);
  const other = !same && d.account_id ? st.ctx.store.get(d.account_id) : null;
  const site = (other && other.label) || d.name || d.domain || d.account_id || "another site";
  const owner = d.owner || (other && other.owner) || "no owner";
  const stage = other && other.stage ? ", " + other.stage : "";
  return html`<div class="td-dupe" role="alert"><p>${same ? "This email is already a contact on this site." : html`Already a contact at <b>${site}</b> (${owner}${stage}).`}</p><div class="td-dupe-acts">${!same && d.account_id ? html`<button type="button" class="ui-btn is-sm" data-td-act="open-dupe" data-dupe="${d.account_id}">Open that site</button>` : ""}<button type="button" class="ui-btn is-sm" data-td-act="force">Add anyway</button></div></div>`;
}

function formHtml(r) {
  const f = st.forms.get(String(r.id));
  if (!f) return "";
  const id = "td-add-" + r.id;
  const inv = (k) => (f.field === k ? raw(' aria-invalid="true" aria-describedby="' + id + '-err"') : "");
  return html`<form class="td-add" data-td-form="${r.id}" novalidate aria-label="${"Add a contact to " + (r.label || r.id)}">${f.sid ? html`<p class="td-muted td-add-note">From the suggestion. The email is optional.</p>` : ""}<div class="td-add-fields"><label class="ui-field"><span class="ui-label">Email</span><input class="ui-input" type="email" name="email" maxlength="200" autocomplete="off" spellcheck="false" value="${f.email || ""}"${inv("email")}></label><label class="ui-field"><span class="ui-label">Name</span><input class="ui-input" name="name" maxlength="120" autocomplete="off" value="${f.name || ""}"${inv("name")}></label><div class="td-add-acts"><button type="submit" class="ui-btn is-primary"${f.busy ? raw(" disabled") : ""}>${f.busy ? "Adding…" : "Add"}</button><button type="button" class="ui-btn is-ghost" data-td-act="cancel">Cancel</button></div></div><p class="ui-error" id="${id}-err" role="alert"${f.err ? "" : raw(" hidden")}>${f.err || ""}</p>${dupeHtml(f, r)}</form>`;
}

function prospectRow(ctx, r) {
  const url = siteUrl(r);
  const write = !readOnly(ctx);
  const n = Number(r.contacts) || 0;
  const open = st.forms.has(String(r.id));
  const dom = r.domain && r.domain !== r.label ? html`<span class="td-dom">${r.domain}</span>` : "";
  const dr = r.dr != null ? html`<span class="td-dr" title="${DR_TIP}">DR ${num(r.dr)}</span>` : "";
  const people = n ? html`<span class="td-muted">${num(n)} ${plural(n, "contact")}</span>` : "";
  const acts = html`${url ? html`<a class="ui-btn is-sm" href="${url}" target="_blank" rel="noopener noreferrer" data-td-act="visit">Visit site <span aria-hidden="true">↗</span></a>` : ""}${n
    ? html`${snapshotMode() ? "" : html`<button type="button" class="ui-btn is-sm" data-td-act="copy">Copy email</button>`}${write ? html`<button type="button" class="ui-btn is-sm" data-td-act="emailed" data-write>Sent first email</button>` : ""}` : ""}${write && !open
    ? html`<button type="button" class="ui-btn is-sm" data-td-act="add" data-write>Add contact</button>` : ""}${write
    ? html`<button type="button" class="ui-btn is-sm is-ghost" data-td-act="notfit" data-write>Not a fit</button>` : ""}<button type="button" class="ui-btn is-sm is-ghost td-dots" data-td-act="more" aria-haspopup="menu" aria-label="${"Actions: " + (r.label || r.id)}"><span aria-hidden="true">⋯</span></button>`;
  return html`<li class="td-row td-prow" data-key="${r.id}" data-rec="${r.id}"><span class="td-av">${avatar(r.label || r.domain || r.id)}</span><div class="td-main"><div class="td-l1">${linkHtml(ctx, r)}${dom}</div><div class="td-l2">${clientTags(r, { edit: false })}${dr}${people}</div>${suggHtml(r)}</div><div class="td-acts">${acts}</div>${formHtml(r)}</li>`;
}

function prospectsHtml(ctx, list) {
  const shown = list.slice(0, SHOWN);
  const withSugg = list.filter((r) => Number(r.sugg) > 0).length;
  const count = list.length > SHOWN ? num(shown.length) + " of " + num(list.length) : num(list.length);
  const mine = me(ctx);
  const all = list.length > SHOWN && mine
    ? html`<div class="td-bfoot"><a class="td-more" href="${ctx.href("sites", { tab: "mine" })}">See all ${num(list.length)} in Sites</a></div>` : "";
  return html`<section class="td-block td-pros" data-block="prospects" aria-labelledby="td-pros-h"><div class="td-bhead"><h2 class="td-h" id="td-pros-h" tabindex="-1">New prospects: find a contact <span class="td-n">(${count})</span></h2>${withSugg ? html`<span class="td-hint">· ${num(withSugg)} with a suggested contact</span>` : ""}</div><ol class="td-rows">${shown.map((r) => prospectRow(ctx, r))}</ol>${all}</section>`;
}

// ---------- page ----------

function subText(ctx) {
  const who = me(ctx);
  return fmtDate(ctx.today, "long") + " · " + (who || "Everyone");
}

function headActs(ctx, info) {
  if (!info || !info.rows.length) return "";
  const n = info.rows.length;
  return html`<button type="button" class="ui-btn is-primary td-start" data-td-start title="${"Open the first Do now site. After each save the next one opens (" + n + " in all)."}" aria-label="${"Start: go through the " + n + " Do now " + plural(n, "site") + " one by one"}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>Start</button>`;
}

function whoHtml(ctx) {
  if (me(ctx) || readOnly(ctx)) return "";
  return html`<p class="td-who">Pick your name to see your own sites. Until then Today shows everyone's. <button type="button" class="ui-linkbtn" data-td-who>Pick your name</button></p>`;
}

function bodyHtml(ctx, v) {
  const blocks = [];
  if (v.info.rows.length) blocks.push(nowHtml(ctx, v.info));
  if (v.prospects.length) blocks.push(prospectsHtml(ctx, v.prospects));
  if (v.coming.length) blocks.push(comingHtml(ctx, v.coming));
  if (!blocks.length) {
    return html`${whoHtml(ctx)}<p class="td-clear" role="status"><b>All clear.</b> New replies arrive each weekday morning after 08:47. <a href="${ctx.href("sites", { tab: "mine" })}">Open Sites › Mine to contact</a></p>`;
  }
  return html`${whoHtml(ctx)}${blocks}`;
}

function el(sel) {
  return st && st.root ? st.root.querySelector(sel) : null;
}

// Where the focus is, so a redraw can put it back (or on the next row when its row left the block).
function focusInfo() {
  const a = typeof document !== "undefined" ? document.activeElement : null;
  if (!a || !st.root.contains(a) || a === st.root) return null;
  const row = a.closest("[data-key]");
  const block = a.closest("[data-block]");
  const attr = FOCUS_ATTRS.find((x) => a.hasAttribute(x)) || null;
  const rows = block ? Array.from(block.querySelectorAll(".td-rows > [data-key]")) : [];
  let sel = null;
  try { sel = typeof a.selectionStart === "number" ? [a.selectionStart, a.selectionEnd] : null; } catch (e) { sel = null; }
  return {
    key: row ? row.getAttribute("data-key") : null,
    block: block ? block.getAttribute("data-block") : null,
    index: row ? rows.indexOf(row) : -1,
    attr,
    value: attr ? a.getAttribute(attr) : null,
    sel,
  };
}

function restoreFocus(f) {
  if (!f) return;
  const esc = (v) => (typeof CSS !== "undefined" && CSS.escape ? CSS.escape(v) : String(v).replace(/"/g, '\\"'));
  let target = null;
  const scope = f.block ? el('[data-block="' + f.block + '"]') : st.root;
  if (f.key != null) {
    const row = st.root.querySelector('[data-key="' + esc(f.key) + '"]');
    if (row) target = f.attr ? row.querySelector("[" + f.attr + '="' + esc(f.value || "") + '"]') || row.querySelector("a,button,input") : row.querySelector("a");
    else if (scope) {
      // The row left its block (a save moved it): the row now at its place, else the block heading.
      const rows = scope.querySelectorAll(".td-rows > [data-key]");
      const next = rows[Math.min(Math.max(f.index, 0), rows.length - 1)];
      target = next ? next.querySelector("a[data-open]") : scope.querySelector(".td-h");
    } else {
      target = st.root.querySelector(".td-h") || st.root.querySelector("h1");
    }
  } else if (f.attr) {
    target = st.root.querySelector("[" + f.attr + '="' + esc(f.value || "") + '"]');
    if (!target && f.block) target = scope ? scope.querySelector(".td-h") : null;
  }
  if (!target) return;
  try { target.focus({ preventScroll: true }); } catch (e) { return; }
  if (f.sel && typeof target.setSelectionRange === "function") {
    try { target.setSelectionRange(f.sel[0], f.sel[1]); } catch (e) { /* not a text field */ }
  }
}

function draw() {
  if (!st || !st.root) return;
  st.frame = 0;
  const ctx = st.ctx;
  const sub = el("[data-td-sub]");
  if (sub) sub.textContent = subText(ctx);
  const body = el("[data-td-body]");
  const acts = el("[data-td-headacts]");
  if (!loaded(ctx)) {
    st.view = null;
    if (acts) render(acts, html``);
    if (body) {
      const s = ctx.store.status || {};
      render(body, s.error && !s.loading ? html`` : html`<div class="td-block td-loading">${skeletonRows(5)}</div>`);
    }
    return;
  }
  const v = compute(ctx);
  // Drop a chip whose rows are all gone (for example after "Mark as handled").
  if (st.filter !== "all" && !v.info.groups[st.filter]) st.filter = "all";
  for (const id of Array.from(st.forms.keys())) if (!v.prospects.some((r) => String(r.id) === id)) st.forms.delete(id);
  st.view = v;
  const f = focusInfo();
  if (acts) render(acts, headActs(ctx, v.info));
  if (body) render(body, bodyHtml(ctx, v));
  restoreFocus(f);
  maybeLoadSuggestions(v);
  if (!st.announced) {
    st.announced = true;
    ctx.announce(announceText(v));
  }
}

function announceText(v) {
  const n = v.info.rows.length;
  return n ? "Today, " + num(n) + " to do now" : v.prospects.length || v.coming.length ? "Today, nothing to do now" : "Today, all clear";
}

function schedule() {
  if (!st || st.frame) return;
  const raf = typeof requestAnimationFrame === "function" ? requestAnimationFrame : (fn) => setTimeout(fn, 16);
  st.frame = raf(() => {
    if (st) {
      st.frame = 0;
      draw();
    }
  }) || 1;
}

// ---------- suggestions (GET /api/suggestions?owner=me&status=open, once per visit) ----------

async function maybeLoadSuggestions(v) {
  if (st.sugg.state !== "idle") return;
  if (!v.prospects.some((r) => Number(r.sugg) > 0)) return;
  const mine = me(st.ctx);
  const my = st;
  my.sugg.state = "loading";
  let r = null;
  try {
    r = await st.ctx.api.suggestions(mine ? { owner: mine, status: "open" } : { status: "open" });
  } catch (e) {
    if (st !== my) return;
    my.sugg.state = "error";
    schedule();
    return;
  }
  if (st !== my) return;
  if (!r || !Array.isArray(r.rows)) {
    my.sugg.state = "na";
  } else {
    my.sugg.rows = new Map();
    for (const s of r.rows) {
      const k = String(s.account_id);
      if (!my.sugg.rows.has(k)) my.sugg.rows.set(k, []);
      my.sugg.rows.get(k).push(s);
    }
    my.sugg.state = "ready";
  }
  schedule();
}

// ---------- actions ----------

function rowRecord(node) {
  const row = node && node.closest ? node.closest("[data-rec]") : null;
  return row ? st.ctx.store.get(row.getAttribute("data-rec")) || null : null;
}

function queueOf(block) {
  const v = st.view;
  if (!v) return [];
  if (block === "now") return filterDoNow(v.info.rows, st.filter).map((x) => x.record.id);
  if (block === "prospects") return v.prospects.map((r) => r.id);
  if (block === "coming") return v.coming.map((r) => r.id);
  return [];
}

function openRow(id, block) {
  const ids = queueOf(block);
  const index = ids.indexOf(String(id));
  closeAll();
  if (index >= 0) st.ctx.openRecord(String(id), { queue: { ids, index, label: LABELS[block] || "Today" } });
  else st.ctx.openRecord(String(id));
}

function start() {
  const v = st.view;
  if (!v || !v.info.rows.length) return;
  const ids = v.info.rows.map((x) => x.record.id);
  st.ctx.openRecord(ids[0], { queue: { ids, index: 0, label: LABELS.now } });
}

function markHandled(anchor) {
  const v = st.view;
  if (!v) return;
  const rows = filterDoNow(v.info.rows, "replies");
  const ids = rows.map((x) => x.record.id);
  if (!ids.length) return;
  const ctx = st.ctx;
  const n = ids.length;
  const def = addDays(ctx.today, 14);
  const min = addDays(ctx.today, 1);
  const body = html`<p>${n === 1 ? "This reply leaves" : "These " + num(n) + " replies leave"} Do now until the follow-up date. Where the next step is empty it becomes “Check in”.</p><label class="ui-field td-mh-date"><span class="ui-label">Follow up on</span><input class="ui-input" type="date" name="due" value="${def}" min="${min}" required aria-describedby="td-mh-err"></label><p class="ui-error" id="td-mh-err" role="alert" hidden></p>`;
  let picked = null;
  const m = openModal({
    title: "Mark " + num(n) + " " + plural(n, "reply", "replies") + " as handled?",
    size: "sm",
    body,
    actions: [
      { label: "Cancel", kind: "ghost", value: null },
      {
        label: "Mark " + num(n) + " as handled",
        kind: "primary",
        value: "ok",
        onClick(modal) {
          const input = modal.el.querySelector('input[name="due"]');
          const val = input ? String(input.value || "") : "";
          if (!/^\d{4}-\d{2}-\d{2}$/.test(val) || val <= ctx.today) {
            const p = modal.el.querySelector("#td-mh-err");
            if (p) {
              p.textContent = "Pick a date after today.";
              p.hidden = false;
            }
            if (input) {
              input.setAttribute("aria-invalid", "true");
              input.focus();
            }
            return false;
          }
          picked = val;
          return true;
        },
      },
    ],
  });
  m.result.then(async (value) => {
    if (value !== "ok" || !picked || !st) return;
    await ctx.actions.bulk(ids, { next_step: "Check in", next_due: picked }, {
      confirm: false,
      onlyIfEmpty: ["next_step"],
      label: "Follow-up " + fmtDate(picked, "short"),
    });
  });
  void anchor;
}

function openForm(r, prefill = {}) {
  const key = String(r.id);
  const cur = st.forms.get(key);
  st.forms.set(key, Object.assign({ email: "", name: "", busy: false, err: "", field: "", dupe: null }, cur || {}, prefill));
  draw();
  const input = el('[data-td-form="' + (typeof CSS !== "undefined" && CSS.escape ? CSS.escape(key) : key) + '"] input[name="email"]');
  if (input) input.focus();
}

function closeForm(id) {
  st.forms.delete(String(id));
  draw();
  const row = st.root.querySelector('[data-key="' + (typeof CSS !== "undefined" && CSS.escape ? CSS.escape(String(id)) : id) + '"]');
  const b = row && (row.querySelector('[data-td-act="add"]') || row.querySelector("a[data-open]"));
  if (b) b.focus({ preventScroll: true });
}

function splitName(name) {
  const parts = String(name || "").replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  return { first_name: parts[0] || "", last_name: parts.slice(1).join(" ") };
}

function formError(id, msg, field) {
  const f = st.forms.get(String(id));
  if (!f) return;
  f.busy = false;
  f.err = msg;
  f.field = field || "";
  draw();
  const input = field ? el('[data-td-form="' + id + '"] [name="' + field + '"]') : null;
  if (input) input.focus();
}

async function submitForm(id, force) {
  const key = String(id);
  const f = st.forms.get(key);
  const r = st.ctx.store.get(key);
  if (!f || !r || f.busy) return;
  const email = String(f.email || "").trim();
  const name = String(f.name || "").trim();
  if (!email && !name) return formError(key, "Add an email or a name.", "email");
  if (email && !/^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/.test(email)) return formError(key, "That email address doesn't look right.", "email");
  const body = splitName(name);
  if (email) body.email = email;
  if (f.title) body.title = f.title;
  if (f.linkedin) body.linkedin = f.linkedin;
  const client = f.client || (r.cl && r.cl[0]) || "";
  if (client) body.client = client;
  for (const k of Object.keys(body)) if (!body[k]) delete body[k];
  f.busy = true;
  f.err = "";
  f.field = "";
  if (!force) f.dupe = null;
  draw();
  const my = st;
  let res = null;
  try {
    res = await my.ctx.api.addContact(key, body, { force: !!force });
    if (res == null) throw Object.assign(new Error("This isn't available yet. Nothing was saved."), { friendly: "This isn't available yet. Nothing was saved." });
  } catch (e) {
    if (e && e.status === 401) return;
    const why = (e && (e.friendly || e.message)) || "Try again.";
    if (st === my && st.forms.has(key)) return formError(key, "Not saved. " + why, "");
    toast((r.label || key) + " · Contact not added. " + why, { kind: "error" });
    return;
  }
  if (res.conflict) {
    if (st === my && st.forms.has(key)) {
      const cur = st.forms.get(key);
      cur.busy = false;
      cur.dupe = res.duplicate || {};
      draw();
      const b = el('[data-td-form="' + key + '"] [data-td-act="force"]');
      if (b) b.focus();
    }
    return;
  }
  // Added: count it on the row, remember the email for Copy email, mark a suggestion used.
  const now = my.ctx.store.get(key);
  if (now) my.ctx.store.patchLocal(key, { contacts: (Number(now.contacts) || 0) + 1 });
  if (email) my.emails.set(key, email.split(/\s*[;,]\s*/)[0]);
  if (f.sid) {
    try {
      const u = await my.ctx.api.setSuggestion(f.sid, "used");
      if (u && Array.isArray(u.v2)) my.ctx.store.upsert(u.v2);
      for (const s of my.sugg.rows.get(key) || []) if (String(s.id) === String(f.sid)) s.status = "used";
    } catch (e) { /* the contact is in; the suggestion stays open */ }
  }
  toast("Contact added. " + SYNC, { kind: "success" });
  if (st !== my) return;
  st.forms.delete(key);
  draw();
  const row = st.root.querySelector('[data-key="' + key + '"]');
  const next = row && (row.querySelector('[data-td-act="copy"]') || row.querySelector("a[data-open]"));
  if (next) next.focus({ preventScroll: true });
}

function firstEmail(profile) {
  const list = profile && Array.isArray(profile.contacts) ? profile.contacts.slice() : [];
  list.sort((a, b) => (Number(b.primary_contact) || 0) - (Number(a.primary_contact) || 0));
  for (const c of list) {
    const e = String((c && c.email) || "").split(/\s*[;,]\s*/).map((x) => x.trim()).find((x) => x.includes("@"));
    if (e) return e;
  }
  return "";
}

async function copyEmail(r) {
  const key = String(r.id);
  let email = st.emails.get(key) || "";
  if (!email) {
    let p = null;
    try {
      p = await st.ctx.api.partner(key);
    } catch (e) {
      if (!(e && e.status === 401)) toast("Couldn't read the contacts. " + ((e && e.friendly) || "Try again."), { kind: "error" });
      return;
    }
    if (!p) {
      toast("Open the live site to see this.", { kind: "info" });
      return;
    }
    email = firstEmail(p);
    if (email && st) st.emails.set(key, email);
  }
  if (!email) {
    toast("This site's contacts have no email yet.", { kind: "info" });
    return;
  }
  const ok = await copyText(email);
  toast(ok ? "Copied " + email : "Couldn't copy the email.", { kind: ok ? "success" : "error" });
}

async function prospectAct(act, node, e) {
  const r = rowRecord(node);
  if (!r) return;
  const ctx = st.ctx;
  switch (act) {
    case "visit":
      return; // a real link
    case "add":
      return openForm(r);
    case "cancel":
      return closeForm(r.id);
    case "force":
      return submitForm(r.id, true);
    case "open-dupe":
      return openRow(node.getAttribute("data-dupe"), "");
    case "copy":
      return copyEmail(r);
    case "emailed":
      return ctx.actions.outcome(r.id, "emailed");
    case "notfit":
      return ctx.actions.runOutcome(node, r, "not_fit");
    case "see":
      return openRow(r.id, "prospects");
    case "sugg-add": {
      const s = suggFor(r.id).find((x) => String(x.id) === node.getAttribute("data-sid"));
      if (!s) return;
      return openForm(r, { sid: s.id, name: s.name || "", title: s.title || "", linkedin: s.linkedin || "", client: s.client || "" });
    }
    case "more":
      return prospectMenu(node, r);
    default:
      void e;
  }
}

async function prospectMenu(anchor, r) {
  const write = !readOnly(st.ctx);
  const n = Number(r.contacts) || 0;
  const url = siteUrl(r);
  const items = [];
  if (url) items.push({ label: "Visit site ↗", value: "visit" });
  if (n && !snapshotMode()) items.push({ label: "Copy email", value: "copy" });
  if (n && write) items.push({ label: "Sent first email", value: "emailed" });
  if (write) items.push({ label: "Add contact", value: "add" });
  if (write) items.push({ label: "Not a fit…", value: "notfit" });
  items.push({ label: "Open details", value: "open" });
  const v = await openMenu(anchor, { items, label: "Actions for " + (r.label || r.id) });
  if (!v || !st) return;
  if (v === "visit") {
    if (typeof window !== "undefined") window.open(url, "_blank", "noopener");
    return;
  }
  if (v === "open") return openRow(r.id, "prospects");
  return prospectAct(v, anchor);
}

// ---------- events ----------

function bind() {
  const root = st.root;
  const offs = st.offs;
  offs.push(bindInlineEdits(root, { getRecord: (id) => st.ctx.store.get(id) }));
  offs.push(on(root, "click", "[data-td-start]", (e) => {
    e.preventDefault();
    start();
  }));
  offs.push(on(root, "click", "[data-td-filter]", (e, b) => {
    st.filter = b.getAttribute("data-td-filter") || "all";
    st.expanded.now = false;
    draw();
  }));
  offs.push(on(root, "click", "[data-td-more]", (e, b) => {
    const k = b.getAttribute("data-td-more");
    st.expanded[k] = !st.expanded[k];
    draw();
  }));
  offs.push(on(root, "click", "[data-td-handled]", (e, b) => markHandled(b)));
  offs.push(on(root, "click", "[data-td-who]", async () => {
    try { await st.ctx.me.ensure(); } catch (e) { /* closed */ }
  }));
  offs.push(on(root, "click", "a[data-open]", (e, a) => {
    if (e.ctrlKey || e.metaKey || e.shiftKey || e.altKey || e.button === 1) return; // a new tab
    e.preventDefault();
    const block = a.closest("[data-block]");
    openRow(a.getAttribute("data-open"), block ? block.getAttribute("data-block") : "");
  }));
  offs.push(on(root, "click", ".td-row", (e, row) => {
    if (e.target.closest("a,button,input,select,textarea,label,summary,form,[data-edit],[popover]")) return;
    const sel = typeof window !== "undefined" && window.getSelection ? String(window.getSelection()) : "";
    if (sel) return;
    const block = row.closest("[data-block]");
    openRow(row.getAttribute("data-rec"), block ? block.getAttribute("data-block") : "");
  }));
  offs.push(on(root, "click", "[data-td-act]", (e, b) => {
    const act = b.getAttribute("data-td-act");
    if (act === "visit") return;
    e.preventDefault();
    prospectAct(act, b, e);
  }));
  offs.push(on(root, "input", "[data-td-form] input", (e, input) => {
    const form = input.closest("[data-td-form]");
    const f = form ? st.forms.get(form.getAttribute("data-td-form")) : null;
    if (f && (input.name === "email" || input.name === "name")) f[input.name] = input.value;
  }));
  offs.push(on(root, "submit", "[data-td-form]", (e, form) => {
    e.preventDefault();
    submitForm(form.getAttribute("data-td-form"), false);
  }));
  offs.push(on(root, "keydown", "[data-td-form]", (e, form) => {
    if (e.key !== "Escape") return;
    e.preventDefault();
    e.stopPropagation();
    closeForm(form.getAttribute("data-td-form"));
  }));
}

export default {
  id: "today",
  title,
  mount(root, ctx) {
    if (st) this.unmount();
    st = fresh(root, ctx);
    render(root, html`<header class="td-head"><div class="td-titles"><h1 tabindex="-1">Today</h1><p class="td-sub" data-td-sub>${subText(ctx)}</p></div><div class="td-head-acts" data-td-headacts></div></header><div class="td-banner" data-td-banner></div><div class="td-body" data-td-body></div>`);
    const slot = el("[data-td-banner]");
    try {
      const b = whatsNewBanner(ctx, slot);
      if (b != null && slot && !slot.firstChild) render(slot, b);
    } catch (e) {
      if (typeof console !== "undefined") console.error(e);
    }
    bind();
    // The toggle event doesn't bubble: listen in the capture phase.
    const onToggle = (e) => {
      const d = e.target;
      if (!d || !d.matches || !d.matches("details[data-block]")) return;
      st.comingOpen = d.open;
      const hint = d.querySelector(".td-sum-hint");
      if (hint) hint.textContent = d.open ? "Hide" : "Show";
    };
    root.addEventListener("toggle", onToggle, true);
    st.offs.push(() => root.removeEventListener("toggle", onToggle, true));
    draw();
    if (!st.announced && !loaded(ctx)) ctx.announce("Today");
  },
  update(ctx, change) {
    if (!st) return;
    st.ctx = ctx;
    if (change && change.kind === "me") {
      st.sugg = { state: "idle", rows: new Map() };
      st.forms.clear();
      st.emails.clear();
      st.filter = "all";
    }
    if (change && change.kind === "route") return;
    schedule();
  },
  unmount() {
    if (!st) return;
    const raf = typeof cancelAnimationFrame === "function" ? cancelAnimationFrame : clearTimeout;
    if (st.frame) raf(st.frame);
    for (const off of st.offs) {
      try { off(); } catch (e) { /* already gone */ }
    }
    st = null;
  },
};
