// Column catalog for createList (spec 4.7). Owner G1-C. No side effects at import time.
// A column is {id, label, cell(row, cx) -> SafeHtml, sort?(row) -> value, priority, csv?, align?, title?,
//   className?, labelHidden?}:
//   - priority 1 and 2 show in the table and on phone cards (2 in the card's second line), 3 hides below
//     1100 px and on phone cards (spec 2.2.2, 4.12). Number columns (align 'num') also hide on cards.
//   - csv: a function (row) -> value, or a list [{label, value(row)}] for several CSV columns, or false.
//     Without it the CSV uses the cell's text.
//   - cx (cell context) = {link(row) -> href with rec, today}.
// Lists take catalog ids or column objects (pages may pass their own objects, spec 4.7).
import { html, safeUrl } from "../core/dom.js";
import { num, date, ago } from "../core/format.js";
import { stagePill, ownerChip, clientTags, dueBadge, waitingBadge, newDot, quietChip } from "./pills.js";
import { rowActions } from "./inline-edit.js";
import { termsText } from "../core/outcomes.js";

const STAGE_ORDER = { New: 1, Researching: 2, Contacted: 3, Replied: 4, Negotiating: 5, Active: 6, Lost: 7, "Do not contact": 8 };
const has = (v) => v != null && String(v).trim() !== "";
const dash = html`<span class="ui-faint" aria-label="none">—</span>`;
const lower = (v) => (has(v) ? String(v).toLowerCase() : null);

// The PG/NEW number of an id: "PG-00577" -> 577.
function idNumber(id) {
  const m = /(\d+)\s*$/.exec(String(id || ""));
  return m ? Number(m[1]) : 0;
}

// Newest first (spec 2.2.2): NEW- ids, then PG number descending. Use with dir 'desc'.
export function newestKey(row) {
  const n = idNumber(row && row.id);
  return (row && row.isNew ? 10000000 : 0) + n;
}

export const SORTS = {
  newest: { label: "Newest", value: newestKey, dir: "desc" },
  last_activity: { label: "Last activity", value: (r) => r.lastActivity || null, dir: "desc" },
};

export function siteCell(r, cx) {
  const href = cx && cx.link ? cx.link(r) : "#";
  return html`<span class="ui-site"><a class="ui-row-link" href="${href}" data-open="${r.id}">${r.label || r.domain || r.id}</a>${newDot(r)}${r.domain && r.domain !== r.label ? html`<span class="ui-sub">${r.domain}</span>` : ""}</span>`;
}

function nextCell(r, cx) {
  const text = r.nextText || "";
  const editable = !(cx && cx.readOnly);
  const body = html`${waitingBadge(r)}${text ? html`<span class="ui-next-text">${text}</span>` : html`<span class="ui-faint">No next step</span>`}`;
  const due = dueBadge(r, { today: cx && cx.today, noDate: !r.closed && has(text) });
  if (!editable) return html`<span class="ui-next">${body}</span> ${due}`;
  return html`<button type="button" class="ui-next is-edit" data-edit="next" data-id="${r.id}" aria-label="${"Next step: " + (r.next_step || "none") + ". Edit"}">${body}</button> ${due}`;
}

// Type: a button that opens the type menu (spec 4.4), plain text in read-only mode.
function typeCell(r, cx) {
  const body = has(r.type) ? html`${r.type}` : html`<span class="ui-faint">Type not set</span>`;
  if (cx && cx.readOnly) return body;
  return html`<button type="button" class="ui-next is-edit" data-edit="type" data-id="${r.id}" aria-haspopup="menu" aria-label="${"Type: " + (r.type || "not set") + ". Change type"}">${body}</button>`;
}

// Follow-up date: the due badge as a button that opens the Follow up menu (spec 4.4, 4.5).
function dueCell(r, cx) {
  const badge = dueBadge(r, { today: cx && cx.today, noDate: !r.closed });
  if ((cx && cx.readOnly) || r.closed) return badge;
  const due = r.due || r.next_due || "";
  return html`<button type="button" class="ui-next is-edit" data-edit="due" data-id="${r.id}" aria-haspopup="menu" aria-label="${"Follow-up: " + (due || "no date") + ". Change"}">${badge}</button>`;
}

const DEAL_CSV = [
  { label: "Deal type", value: (r) => r.deal_model },
  { label: "Flat fee", value: (r) => r.deal_flat },
  { label: "Commission %", value: (r) => r.deal_pct },
  { label: "Deal value", value: (r) => r.deal_value },
];

export const COLUMNS = {
  id: { id: "id", label: "ID", priority: 3, cell: (r) => html`<span class="ui-id">${r.id}</span>`, sort: (r) => newestKey(r), csv: (r) => r.id },
  site: {
    id: "site", label: "Site", priority: 1, className: "is-site",
    cell: siteCell,
    sort: (r) => lower(r.label),
    csv: [{ label: "ID", value: (r) => r.id }, { label: "Site", value: (r) => r.label }, { label: "Domain", value: (r) => r.domain }],
  },
  stage: { id: "stage", label: "Stage", priority: 1, cell: (r) => stagePill(r), sort: (r) => STAGE_ORDER[r.stage] || 99, csv: (r) => r.stage },
  owner: { id: "owner", label: "Owner", priority: 1, cell: (r) => ownerChip(r), sort: (r) => lower(r.owner), csv: (r) => r.owner },
  clients: { id: "clients", label: "Clients", priority: 2, cell: (r) => clientTags(r), sort: (r) => lower((r.cl || []).join(", ")), csv: (r) => r.clients },
  dr: {
    id: "dr", label: "DR", title: "Ahrefs domain rating, 0–100", priority: 2, align: "num",
    cell: (r) => (r.dr == null ? dash : html`<span class="num">${num(r.dr)}</span>`), sort: (r) => r.dr, csv: (r) => r.dr,
  },
  traffic: {
    id: "traffic", label: "Traffic", priority: 3, align: "num",
    cell: (r) => (r.traffic == null ? dash : html`<span class="num">${num(r.traffic)}</span>`), sort: (r) => r.traffic, csv: (r) => r.traffic,
  },
  type: { id: "type", label: "Type", priority: 3, cell: typeCell, sort: (r) => lower(r.type), csv: (r) => r.type },
  country: { id: "country", label: "Country", priority: 3, cell: (r) => (has(r.country) ? html`${r.country}` : dash), sort: (r) => lower(r.country), csv: (r) => r.country },
  source: { id: "source", label: "Source", priority: 3, cell: (r) => (has(r.source) ? html`${r.source}` : dash), sort: (r) => lower(r.source), csv: (r) => r.source },
  contacts: { id: "contacts", label: "Contacts", priority: 3, align: "num", cell: (r) => html`<span class="num">${num(r.contacts || 0)}</span>`, sort: (r) => r.contacts || 0, csv: (r) => r.contacts || 0 },
  last_activity: {
    id: "last_activity", label: "Last activity", priority: 3,
    cell: (r, cx) => (r.lastActivity ? html`<span title="${date(r.lastActivity, "year")}">${ago(r.lastActivity, cx && cx.today)}</span>` : dash),
    sort: (r) => r.lastActivity || null, csv: (r) => r.lastActivity,
  },
  last_touch: {
    id: "last_touch", label: "Last touch", priority: 3,
    cell: (r) => (r.last_touch ? html`${date(r.last_touch, "day")}` : dash), sort: (r) => r.last_touch || null, csv: (r) => r.last_touch,
  },
  next: {
    id: "next", label: "Next step", priority: 2, cell: nextCell, sort: (r) => r.due || null,
    csv: [{ label: "Next step", value: (r) => r.next_step }, { label: "Next step due", value: (r) => r.next_due }],
  },
  due: {
    id: "due", label: "Follow-up", priority: 2,
    cell: dueCell, sort: (r) => r.due || null, csv: (r) => r.next_due,
  },
  quiet: { id: "quiet", label: "Quiet", priority: 3, cell: (r) => quietChip(r), sort: (r) => r.quietDays, csv: (r) => r.quietDays },
  terms: {
    id: "terms", label: "Terms", priority: 2,
    cell: (r) => {
      const t = termsText(r);
      return has(r.deal_model) || t ? html`<span class="ui-terms">${[r.deal_model, t].filter(Boolean).join(" · ")}</span>` : html`<span class="ui-faint">No terms yet</span>`;
    },
    sort: (r) => r.deal_value != null ? r.deal_value : r.deal_flat,
    csv: DEAL_CSV,
  },
  placement: {
    id: "placement", label: "Placement", priority: 3,
    cell: (r) => {
      const u = safeUrl(r.content_url);
      return u ? html`<a href="${u}" target="_blank" rel="noopener noreferrer">Open ↗</a>` : has(r.content_url) ? html`${r.content_url}` : dash;
    },
    sort: (r) => lower(r.content_url), csv: (r) => r.content_url,
  },
  live_date: { id: "live_date", label: "Went live", priority: 3, cell: (r) => (r.live_date ? html`${date(r.live_date, "year")}` : dash), sort: (r) => r.live_date || null, csv: (r) => r.live_date },
  tracking_id: { id: "tracking_id", label: "Tracking ID", priority: 3, cell: (r) => (has(r.tracking_id) ? html`${r.tracking_id}` : dash), sort: (r) => lower(r.tracking_id), csv: (r) => r.tracking_id },
  actions: {
    id: "actions", label: "Actions", labelHidden: true, priority: 1, className: "is-actions",
    cell: (r) => rowActions(r), csv: false,
  },
};

// The CSV columns of a site list when a page asks for the standard set (old RecordTable order).
export const CSV_SITES = ["site", "stage", "owner", "clients", "type", "dr", "traffic", "country", "last_activity", "next"];
export const CSV_DEALS = CSV_SITES.concat(["terms", "placement", "live_date", "tracking_id"]);

export function column(id) {
  return COLUMNS[id] || null;
}

// A column id or object as a full column object (unknown ids give null).
export function resolveColumn(c) {
  if (!c) return null;
  if (typeof c === "string") return COLUMNS[c] || null;
  if (typeof c === "object" && c.id) {
    const base = COLUMNS[c.id] || {};
    return Object.assign({ priority: 2 }, base, c);
  }
  return null;
}
