// Small row widgets: stage pill and path, owner chip, client tags, due badge, reason chip, waiting
// badge, avatar (spec 5.4). Each returns SafeHtml. Owner G1-C. No side effects at import time.
//
// Editable widgets are buttons with data-edit="<field>" and data-id="<site id>"; inline-edit.js
// bindInlineEdits(root) opens their editors (they never navigate, spec 4.4). In read-only mode, or with
// {edit: false}, they render as plain text.
import { html, raw } from "../core/dom.js";
import { dueLabel, initials, todayIso } from "../core/format.js";
import * as metaMod from "../core/meta.js";

const STAGE_COLOR = {
  New: "new", Researching: "research", Contacted: "contacted", Replied: "replied", Negotiating: "neg",
  Active: "active", Lost: "lost", "Do not contact": "dnc",
};

const PATH = ["New", "Contacted", "Replied", "Negotiating", "Active"];

function meta() {
  return metaMod.get();
}

function canEdit(opts) {
  if (opts && opts.edit === false) return false;
  return !meta().read_only;
}

export function stageColor(name) {
  const s = metaMod.stage(meta(), name);
  return (s && s.color) || STAGE_COLOR[name] || "new";
}

function stageDesc(name) {
  const s = metaMod.stage(meta(), name);
  return (s && s.desc) || "";
}

const caret = raw('<svg class="ui-caret" viewBox="0 0 24 24" aria-hidden="true"><path d="M7 10l5 5 5-5"/></svg>');

export function stageDot(name) {
  return html`<span class="ui-dot is-${stageColor(name)}" aria-hidden="true"></span>`;
}

// Stage ▾ pill (inline edit: data-edit="stage").
export function stagePill(record, opts = {}) {
  const name = (record && record.stage) || "No stage";
  const inner = html`${stageDot(name)}<span class="ui-pill-text">${name}</span>`;
  if (!canEdit(opts) || !record) return html`<span class="ui-pill ui-stage" title="${stageDesc(name)}">${inner}</span>`;
  return html`<button type="button" class="ui-pill ui-stage is-edit" data-edit="stage" data-id="${record.id}" aria-haspopup="menu" aria-label="${"Stage: " + name + ". Change stage"}" title="${stageDesc(name)}">${inner}${caret}</button>`;
}

// Display-only stage path: New → Contacted → Replied → Negotiating → Active. Lost and Do not contact
// replace it with a pill.
export function stagePath(record, opts = {}) {
  const name = (record && record.stage) || "";
  if (name === "Lost" || name === "Do not contact") {
    return html`<div class="ui-path is-closed">${stagePill(record, { edit: false })}</div>`;
  }
  const at = name === "Researching" ? 0 : PATH.indexOf(name);
  return html`<ol class="ui-path" aria-label="Stage path">${PATH.map((s, i) => html`<li class="ui-path-step${i < at ? " is-done" : ""}${i === at ? " is-on" : ""}"${i === at ? raw(' aria-current="step"') : ""}><span>${s}</span></li>`)}</ol>`;
}

function teamNames() {
  return (meta().team || []).filter((t) => t && t.active !== false).map((t) => t.name);
}

// Owner chip (inline edit: data-edit="owner"). Owners not on the team show as "past owner".
export function ownerChip(record, opts = {}) {
  const owner = record && record.owner ? String(record.owner) : "";
  const past = owner && !teamNames().includes(owner);
  const text = owner || "No owner";
  const inner = html`${owner ? avatar(owner, { size: "xs" }) : ""}<span class="ui-pill-text">${text}</span>${past ? html`<span class="ui-faint"> (past owner)</span>` : ""}`;
  const cls = "ui-owner" + (owner ? "" : " is-none");
  if (!canEdit(opts) || !record) return html`<span class="${cls}">${inner}</span>`;
  return html`<button type="button" class="${cls} is-edit" data-edit="owner" data-id="${record.id}" aria-haspopup="menu" aria-label="${"Owner: " + text + ". Change owner"}">${inner}${caret}</button>`;
}

// Client tags (inline edit: data-edit="clients"). Uses the canonical display names (spec D8).
export function clientTags(record, opts = {}) {
  const names = (record && record.cl) || [];
  const max = opts.max || 3;
  const shown = names.slice(0, max);
  const extra = names.length - shown.length;
  const tags = html`${shown.map((n) => html`<span class="ui-tag">${n}</span>`)}${extra > 0 ? html`<span class="ui-tag is-more" title="${names.slice(max).join(", ")}">+${extra}</span>` : ""}`;
  if (!canEdit(opts) || !record) {
    return names.length ? html`<span class="ui-tags">${tags}</span>` : html`<span class="ui-tags is-none">${opts.emptyText || ""}</span>`;
  }
  const label = names.length ? "Clients: " + names.join(", ") + ". Change clients" : "Add a client";
  // opts.add: a "+" after the tags says another client can be added (the record header; Tomas couldn't
  // find how to give a site several clients, 2026-10-23).
  const plus = names.length && opts.add ? html`<span class="ui-tag is-add" aria-hidden="true">+</span>` : "";
  return html`<button type="button" class="ui-tags is-edit${names.length ? "" : " is-none"}" data-edit="clients" data-id="${record.id}" aria-haspopup="dialog" aria-label="${label}" title="Pick one or more clients">${names.length ? html`${tags}${plus}` : html`<span class="ui-tag is-add">+ Client</span>`}</button>`;
}

// "Overdue 3d" / "Due today" / "Due Thu 22 Oct"; {noDate: true} shows a "No date" chip without a date.
export function dueBadge(record, opts = {}) {
  const due = record && (record.due || record.next_due);
  if (!due) return opts.noDate ? html`<span class="ui-chip is-nodate">No date</span>` : html``;
  const d = dueLabel(due, opts.today || todayIso());
  return html`<span class="ui-due is-${d.tone}">${d.text}</span>`;
}

// The Do now reason chip: row = {reason, chip, noDate} from rules/today.js.
export function reasonChip(row, opts = {}) {
  if (!row || !row.chip) return html``;
  const tone = { overdue: "danger", reply: "accent", decision: "info", due: "ok", quiet: "warn", noreply: "plain" }[row.reason] || "plain";
  return html`<span class="ui-chip is-${tone}" data-reason="${row.reason || ""}">${row.chip}</span>${row.noDate && opts.noDate !== false ? html` <span class="ui-chip is-nodate">No date</span>` : ""}`;
}

export function waitingBadge(record, opts = {}) {
  if (!record || !record.waitingOnClient) return html``;
  return html`<span class="ui-chip is-wait" title="The next step starts with “Waiting on client:”">Waiting on client</span>`;
}

// Letters only (spec 4.2). size: 'xs' | 'sm' (default) | 'lg'.
export function avatar(label, opts = {}) {
  const letters = initials(label);
  let h = 0;
  for (const c of String(label || "")) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return html`<span class="ui-avatar is-${opts.size || "sm"} is-c${h % 6}" aria-hidden="true">${letters}</span>`;
}

// The dot on NEW- sites (spec 2.5).
export function newDot(record) {
  if (!record || !record.isNew) return html``;
  const tip = "Added on this site; reaches the Google Sheet on the next weekday morning.";
  return html`<span class="ui-newdot" title="${tip}" role="img" aria-label="${tip}"></span>`;
}

// "Quiet 9d" (Going quiet) for open deals.
export function quietChip(record, opts = {}) {
  const n = record && record.quietDays;
  if (n == null || n < (opts.min || 1)) return html``;
  return html`<span class="ui-chip is-warn">Quiet ${n}d</span>`;
}
