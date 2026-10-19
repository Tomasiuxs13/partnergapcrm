// Record panel: the timeline (spec 4.2), newest first. Owner F1. No side effects at import time.
//
// buildTimeline(profile, {today}) merges, from GET /api/partner/:id (6.3.8):
//   - activity rows (date, type, by_whom, summary);
//   - site edits from history.edits, grouped by the request that wrote them (same `at` and person):
//     an outcome's field changes and its activity row become one item ("Email · Kamile: Interested.
//     Stage: Replied → Negotiating · Follow-up: Wed 4 Nov"); "Added this site · Gaby"; "Added contact …";
//   - each contact's last email (and whether they replied).
// Sheet notes (partner.notes) are pinned above the list as "Notes from the sheet".
// Without history.edits (before B1 ships it) the list holds the activity rows and contact emails only.
import { html } from "../../core/dom.js";
import { date as fmtDate, toDay, money, pct, num } from "../../core/format.js";
import { skeletonRows } from "../../ui/skeleton.js";

export const FIELD_LABELS = {
  stage: "Stage", owner: "Owner", clients: "Clients", type: "Type", next_step: "Next step", next_due: "Follow-up",
  deal_model: "Deal type", deal_flat: "Flat fee", deal_pct: "Commission", deal_value: "Deal value",
  content_url: "Placement link", live_date: "Went live", tracking_id: "Tracking ID",
};

const SHOWN = 6;

const clip = (s, n) => {
  const t = String(s == null ? "" : s).replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n - 1).trimEnd() + "…" : t;
};

function shortUrl(u) {
  return clip(String(u || "").replace(/^https?:\/\//i, "").replace(/^www\./i, "").replace(/\/$/, ""), 48);
}

function show(field, v) {
  if (v == null || v === "") return "";
  if (field === "next_due" || field === "live_date") return fmtDate(v, "short") || String(v);
  if (field === "deal_flat" || field === "deal_value") return money(v) || String(v);
  if (field === "deal_pct") return pct(v) || String(v);
  if (field === "content_url") return shortUrl(v);
  if (field === "next_step") return "“" + clip(v, 60) + "”";
  return clip(v, 60);
}

// "Stage: Replied → Negotiating", "Owner: Kamile", "Follow-up cleared".
export function changeText(row) {
  const label = FIELD_LABELS[row.field] || String(row.field || "Field");
  const o = show(row.field, row.old);
  const n = show(row.field, row.new);
  if (!n) return label + " cleared";
  return label + ": " + (o ? o + " → " : "") + n;
}

function parseJson(s) {
  if (s && typeof s === "object") return s;
  try { return JSON.parse(String(s || "")); } catch (e) { return null; }
}

function personName(o) {
  if (!o) return "";
  const name = [o.first_name, o.last_name].filter((x) => x && String(x).trim()).join(" ");
  if (name) return name;
  const first = String(o.email || "").split(/\s*[,;]\s*/)[0];
  return first || "";
}

// Sort key: timestamps by their time; plain dates at the start of that local day (so on the same
// day, items with a time come first).
function keyOf(item) {
  if (item.at) {
    const t = Date.parse(String(item.at).replace(" ", "T"));
    if (isFinite(t)) return t;
  }
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(item.day || ""));
  return m ? new Date(+m[1], +m[2] - 1, +m[3]).getTime() : 0;
}

// The merged list, newest first: [{key, kind, at?, day, by, type, text, changes[], notCopied}].
export function buildTimeline(profile, { today } = {}) {
  const p = profile || {};
  const acts = (Array.isArray(p.activity) ? p.activity : []).map((a, i) => Object.assign({}, a, { _i: i }));
  const used = new Set();
  const items = [];
  const hist = p.history && Array.isArray(p.history.edits) ? p.history.edits.slice() : [];
  hist.sort((a, b) => (Number(a.n) || 0) - (Number(b.n) || 0));
  const groups = [];
  for (const e of hist) {
    const g = groups[groups.length - 1];
    const by = e.by_whom || "";
    if (g && g.at === e.at && g.by === by) g.rows.push(e);
    else groups.push({ at: e.at, by, rows: [e] });
  }
  for (const g of groups) {
    const day = toDay(g.at) || "";
    const notCopied = g.rows.some((e) => e.state === "not_copied");
    for (const e of g.rows) {
      if (e.kind === "create_account") {
        items.push({ kind: "added", at: g.at, day, by: g.by, type: "Added this site", text: "", changes: [], notCopied: e.state === "not_copied" });
      } else if (e.kind === "create_contact") {
        const who = personName(parseJson(e.new));
        items.push({ kind: "contact", at: g.at, day, by: g.by, type: "Added contact", text: who, changes: [], notCopied: e.state === "not_copied" });
      }
    }
    const changes = g.rows.filter((e) => e.kind === "update");
    const actRow = g.rows.find((e) => e.kind === "activity");
    let act = null;
    if (actRow) {
      const j = parseJson(actRow.new) || {};
      const idx = acts.findIndex((a) => !used.has(a._i) && (a.n != null
        ? String(a.n) === String(actRow.field)
        : a.type === j.type && a.summary === j.summary && (!j.date || !a.date || a.date === j.date)));
      if (idx >= 0) {
        used.add(acts[idx]._i);
        act = { type: acts[idx].type || j.type, summary: acts[idx].summary != null ? acts[idx].summary : j.summary };
      } else {
        act = { type: j.type, summary: j.summary };
      }
    }
    if (act || changes.length) {
      items.push({
        kind: act ? "activity" : "edit",
        at: g.at,
        day,
        by: g.by,
        type: act ? act.type || "Note" : "Changed",
        text: act ? String(act.summary || "") : "",
        changes: changes.map(changeText),
        notCopied,
      });
    }
  }
  for (const a of acts) {
    if (used.has(a._i)) continue;
    items.push({ kind: "activity", day: toDay(a.date) || "", by: a.by_whom || "", type: a.type || "Note", text: String(a.summary || ""), changes: [], notCopied: false });
  }
  for (const c of Array.isArray(p.contacts) ? p.contacts : []) {
    const d = toDay(c.last_email);
    if (!d) continue;
    const who = personName(c) || "a contact";
    const replied = Number(c.replied) > 0 || c.replied === true;
    items.push({ kind: "email", day: d, by: "", type: "Last email", text: "to " + who + (replied ? " · they replied" : ""), changes: [], notCopied: false });
  }
  items.forEach((it, i) => { it.key = keyOf(it); it.i = i; });
  items.sort((a, b) => b.key - a.key || a.i - b.i);
  void today;
  return items;
}

// "14:02" today (or "Today" without a time), else "Thu 22 Oct" ("22 Oct 2025" in another year).
export function whenText(item, today) {
  const day = item.day || (item.at ? toDay(item.at) : "");
  if (!day) return "";
  if (day === today) return (item.at && fmtDate(item.at, "time")) || "Today";
  if (today && day.slice(0, 4) !== String(today).slice(0, 4)) return fmtDate(day, "year");
  return fmtDate(day, "short");
}

const KIND_CLASS = {
  Email: "is-email", Call: "is-call", Meeting: "is-call", Note: "is-note", "Deal update": "is-deal",
  "Content live": "is-live", Changed: "is-edit", "Added this site": "is-added", "Added contact": "is-added", "Last email": "is-mail",
};

const CLAMP = 220;

function itemHtml(it, today, open) {
  const cls = KIND_CLASS[it.type] || "is-note";
  const inline = it.kind === "email" || it.kind === "contact";
  const long = !inline && it.text.length > CLAMP;
  const k = String(it.key) + ":" + it.i;
  const isOpen = !!(open && open[k]);
  const dt = it.at || it.day || "";
  return html`<li class="rc-ti ${cls}"><span class="rc-ti-dot" aria-hidden="true"></span><div class="rc-ti-main"><p class="rc-ti-head"><span class="rc-ti-what"><b>${it.type}</b>${inline && it.text ? html` ${it.text}` : ""}${it.by ? html` · ${it.by}` : ""}</span><time class="rc-ti-when"${dt ? html` datetime="${dt}"` : ""}>${whenText(it, today)}</time></p>${it.text && !inline
    ? html`<p class="rc-ti-text${long && !isOpen ? " is-clamp" : ""}">${it.text}</p>${long ? html`<button type="button" class="ui-linkbtn rc-more" data-pti="${k}" aria-expanded="${isOpen ? "true" : "false"}">${isOpen ? "Show less" : "Show more"}</button>` : ""}` : ""}${it.changes.length
    ? html`<p class="rc-ti-changes">${it.changes.join(" · ")}</p>` : ""}${it.notCopied ? html`<p class="rc-ti-warn">Not copied – a sheet edit won; check the sheet</p>` : ""}</div></li>`;
}

function notesHtml(st) {
  const notes = st.profile && st.profile.partner ? String(st.profile.partner.notes || "").trim() : "";
  if (!notes) return "";
  return html`<div class="rc-notes${st.notesOpen ? " is-open" : ""}"><p class="rc-notes-title">Notes from the sheet</p><p class="rc-notes-text" data-pnotes-text>${notes}</p>${notes.length > 140 ? html`<button type="button" class="ui-linkbtn rc-more" data-pnotes aria-expanded="${st.notesOpen ? "true" : "false"}">${st.notesOpen ? "Show less" : "Show more"}</button>` : ""}</div>`;
}

// The Timeline card. st: the panel state (profile, profileState, timelineAll, notesOpen).
export function renderTimeline(record, st, { today } = {}) {
  let body;
  if (st.profileState === "loading" && !st.profile) {
    body = skeletonRows(3);
  } else if (st.profileState === "snapshot") {
    body = html`<p class="ui-small rc-muted">Open the live site to see this.</p>`;
  } else if (st.profileState === "na") {
    body = html`<p class="ui-small rc-muted">Not available yet.</p>`;
  } else if (st.profileState === "error" && !st.profile) {
    body = html`<p class="ui-small rc-muted">Couldn't load the timeline. <button type="button" class="ui-linkbtn" data-preload>Try again</button></p>`;
  } else {
    const items = buildTimeline(st.profile, { today });
    const list = st.timelineAll ? items : items.slice(0, SHOWN);
    body = html`${notesHtml(st)}${items.length
      ? html`<ol class="rc-tl">${list.map((it) => itemHtml(it, today, st.tlOpen))}</ol>${items.length > SHOWN
        ? html`<button type="button" class="ui-linkbtn rc-more" data-ptl aria-expanded="${st.timelineAll ? "true" : "false"}">${st.timelineAll ? "Show fewer" : "Show all " + num(items.length)}</button>` : ""}`
      : html`<p class="ui-small rc-muted">Nothing logged yet. What you log above shows up here.</p>`}`;
  }
  return html`<h3 class="ui-card-title rc-card-title" id="rc-tl-h">Timeline</h3>${body}`;
}

// For tests and other callers: the count of timeline items a profile gives.
export function timelineCount(profile, opts) {
  return buildTimeline(profile, opts).length;
}

