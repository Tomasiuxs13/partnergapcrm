// The only UI write path for site fields (spec 4.4, 4.5, 4.8, 5.4). Owner G1-C. No side effects at import.
//
// - update(): optimistic store patch, PATCH, then the store row from the response (v2 when the server
//   sends it). Rolled back on error with an error toast that offers Retry. Success toast with Undo,
//   which PATCHes the old values back (update rows, so the sheet ends up right).
// - outcome(): one POST /api/partner/:id/outcome (6.3.3) built by core/outcomes.js. Undo reverts the
//   changed fields only; the logged note stays ("Stage restored. The note stays in the history.").
// - followUp(), claim(), note(), setWaiting(): small writes on top of update()/the activity endpoint.
// - bulk(): ids mode in chunks (api.bulk), confirm over 20 rows, progress toast, store patched from the
//   response, and an undo() that uses rows mode with the before-values (<= 100 rows).
// - logMenu(), followUpMenu(), outcomeForm(): the menus and the 5 small forms (reason, terms, link,
//   the note for "Had a call").
// Every function resolves to null (not an exception) when a save fails, after showing the error,
// unless opts.throw is set.
import { html, raw, on } from "../core/dom.js";
import * as store from "../core/store.js";
import * as metaMod from "../core/meta.js";
import * as me from "../core/me.js";
import * as router from "../core/router.js";
import { api, ApiError, readOnlyText } from "../core/api.js";
import { todayIso, date as fmtDate, num, plural } from "../core/format.js";
import { V2_COLS, setWaitingOnClient } from "../core/model.js";
import { buildOutcomeRequest, outcomesFor, outcome as outcomeDef, buttonLabel, chipDate, autoFollowUp,
  termsText, firstClientName, FIELD_ORDER } from "../core/outcomes.js";
import { toast } from "./toast.js";
import { confirm, openModal } from "./dialog.js";
import { openMenu, openPopover } from "./menu.js";

const NOT_AVAILABLE = "This isn't available yet. Nothing was saved.";
const UNDO_MAX = 100;

const meta = () => metaMod.get();
const readOnly = () => !!meta().read_only;
const has = (v) => v != null && String(v).trim() !== "";
const sendable = (v) => (v == null ? "" : v);
const short = (iso) => fmtDate(iso, "short");

// Field values as the store keeps them ("" is stored as null).
function localFields(fields) {
  const out = {};
  for (const [k, v] of Object.entries(fields || {})) out[k] = v === "" || v === undefined ? null : v;
  return out;
}

function ordered(fields) {
  const out = {};
  for (const k of FIELD_ORDER) if (k in fields) out[k] = fields[k];
  for (const k of Object.keys(fields)) if (!(k in out)) out[k] = fields[k];
  return out;
}

function pickCols(obj) {
  const out = {};
  for (const k of V2_COLS) if (obj && k in obj) out[k] = obj[k];
  return out;
}

// Puts the server's answer into the store: the v2 row when there is one, else the old `partner`
// object, else the changed fields.
function applyResponse(id, r, sent) {
  if (r && Array.isArray(r.v2)) return store.upsert(r.v2);
  if (r && r.partner && typeof r.partner === "object") return store.upsert(Object.assign(pickCols(r.partner), { id }));
  if (r && r.changed && typeof r.changed === "object") return store.patchLocal(id, localFields(r.changed));
  return store.patchLocal(id, localFields(sent));
}

function errorText(e) {
  if (!e) return "Something went wrong. Try again.";
  return e.friendly || e.message || "Something went wrong. Try again.";
}

function failToast(e, retry) {
  if (e && e.status === 401) return;
  toast(errorText(e), { kind: "error", action: retry ? { label: "Retry", fn: retry } : undefined });
}

function guardReadOnly() {
  if (!readOnly()) return false;
  toast(readOnlyText(), { kind: "error" });
  return true;
}

// The success message for a PATCH (spec 4.4, 4.5 wording).
export function describe(fields) {
  const keys = Object.keys(fields || {});
  const f = fields || {};
  if (keys.includes("stage")) {
    const due = has(f.next_due) ? " · follow-up " + short(f.next_due) : "";
    return "Moved to " + f.stage + due;
  }
  if (keys.length === 1 || (keys.length === 2 && keys.includes("next_due") && keys.includes("next_step"))) {
    if (keys.includes("next_due")) return has(f.next_due) ? "Follow-up " + short(f.next_due) : "Follow-up cleared";
    if (keys.includes("owner")) return has(f.owner) ? "Owner: " + f.owner : "Owner removed";
    if (keys.includes("clients")) return has(f.clients) ? "Clients: " + f.clients : "Clients removed";
    if (keys.includes("type")) return has(f.type) ? "Type: " + f.type : "Type cleared";
    if (keys.includes("next_step")) return "Next step saved";
  }
  if (keys.every((k) => /^deal_|tracking_id/.test(k))) return "Deal terms saved";
  if (keys.every((k) => k === "content_url" || k === "live_date")) return "Placement saved";
  return "Saved";
}

// ---------- update ----------

// PATCH a site's fields. opts: label (toast text), undo (default true), quiet (no toasts), throw.
// Resolves to the updated Record, or null when it failed (the store row is rolled back).
export async function update(id, fields, opts = {}) {
  const { label, undo = true, quiet = false } = opts;
  const send = ordered(Object.assign({}, fields || {}));
  const keys = Object.keys(send);
  const rec = store.get(id);
  if (!keys.length) return rec || null;
  if (guardReadOnly()) return null;
  const before = {};
  for (const k of keys) before[k] = rec ? sendable(rec[k]) : "";
  if (rec && keys.every((k) => String(before[k]) === String(sendable(send[k])))) return rec;
  if (rec) store.patchLocal(id, localFields(send));
  try {
    const r = await api.update(id, send);
    if (r == null) throw new ApiError(404, NOT_AVAILABLE);
    applyResponse(id, r, send);
    if (!quiet) {
      toast(label || describe(send), {
        kind: "success",
        undo: undo ? async () => {
          const back = await update(id, before, { undo: false, quiet: true });
          if (back) toast("Change undone.", { kind: "info" });
        } : undefined,
      });
    }
    return store.get(id) || null;
  } catch (e) {
    if (rec) store.patchLocal(id, localFields(before));
    if (!quiet) failToast(e, () => update(id, fields, opts));
    if (opts.throw) throw e;
    return null;
  }
}

// ---------- outcomes ----------

function outcomeMessage(o, req, rec) {
  const f = req.fields || {};
  const due = has(f.next_due) ? short(f.next_due) : "";
  if (o.id === "claim") return "Claimed" + (due ? " · follow-up " + due : "");
  if (o.id === "assign_manager") return "Owner: " + f.owner;
  if ("stage" in f && f.stage !== (rec && rec.stage)) return "Moved to " + f.stage + (due ? " · follow-up " + due : "");
  if (due) return "Follow-up " + due;
  return "Logged: " + buttonLabel(o);
}

// One outcome (Appendix A) for a site: opts = {note, reason, terms, link, date, followUp, undo, quiet,
// onAddTerms, throw}. Resolves to the updated Record, or null.
export async function outcome(id, outcomeId, opts = {}) {
  const rec = store.get(id);
  const o = outcomeDef(outcomeId);
  if (!rec || !o) {
    if (!opts.quiet) toast(!rec ? "That site isn't loaded yet. Try again in a moment." : "Pick what happened.", { kind: "error" });
    return null;
  }
  if (guardReadOnly()) return null;
  const who = me.get() || (await me.ensure());
  let req;
  try {
    req = buildOutcomeRequest(rec, outcomeId, Object.assign({}, opts, { me: who, meta: meta(), today: todayIso() }));
  } catch (e) {
    if (!opts.quiet) toast(errorText(e), { kind: "error" });
    if (opts.throw) throw e;
    return null;
  }
  const keys = Object.keys(req.fields);
  const before = {};
  for (const k of keys) before[k] = sendable(rec[k]);
  const changedKeys = keys.filter((k) => String(before[k]) !== String(sendable(req.fields[k])));
  store.patchLocal(id, localFields(req.fields));
  try {
    const r = await api.outcome(id, req);
    if (r == null) throw new ApiError(404, NOT_AVAILABLE);
    applyResponse(id, r, req.fields);
    if (!Array.isArray(r.v2) && req.activity) {
      const extra = { act_at: (r.activity && r.activity.date) || todayIso() };
      if (r.last_touch) extra.last_touch = r.last_touch;
      store.patchLocal(id, extra);
    }
    if (!opts.quiet) {
      const revert = {};
      for (const k of changedKeys) revert[k] = before[k];
      const canUndo = opts.undo !== false && changedKeys.length > 0;
      const action = o.id === "approve" && !termsText(rec)
        ? { label: "Add terms", fn: () => (opts.onAddTerms ? opts.onAddTerms() : router.setParams({ rec: id })) }
        : undefined;
      toast(outcomeMessage(o, req, rec), {
        kind: "success",
        action,
        undo: canUndo ? async () => {
          const back = await update(id, revert, { undo: false, quiet: true });
          if (!back) return;
          const kept = req.activity ? " The note stays in the history." : "";
          toast(("stage" in revert ? "Stage restored." : "Change undone.") + kept, { kind: "info" });
        } : undefined,
      });
    }
    return store.get(id) || null;
  } catch (e) {
    store.patchLocal(id, localFields(before));
    if (!opts.quiet) failToast(e, () => outcome(id, outcomeId, opts));
    if (opts.throw) throw e;
    return null;
  }
}

// A note on its own ("Save note" in the Log box): POST /api/partner/:id/activity, type Note.
// opts: type, quiet (no toasts), throw (rethrow the error instead of resolving to null).
export async function note(id, text, opts = {}) {
  const { type = "Note", quiet = false } = opts;
  const summary = String(text == null ? "" : text).replace(/\s+/g, " ").trim();
  if (!summary) return null;
  if (guardReadOnly()) return null;
  const rec = store.get(id);
  const client = rec ? firstClientName(rec, meta()) : null;
  try {
    const r = await api.logActivity(id, { type, summary: summary.slice(0, 2000), client: client || undefined });
    if (r == null) throw new ApiError(404, NOT_AVAILABLE);
    const extra = { act_at: (r.activity && r.activity.date) || todayIso() };
    if (r.last_touch) extra.last_touch = r.last_touch;
    if (rec) store.patchLocal(id, extra);
    if (!quiet) toast("Note saved.", { kind: "success" });
    return r.activity || r;
  } catch (e) {
    if (!quiet) failToast(e, () => note(id, text, opts));
    if (opts.throw) throw e;
    return null;
  }
}

// ---------- Follow up, Claim, Waiting on client ----------

// Sets (or clears, with null) the follow-up date. next_step becomes "Follow up" only where it is empty.
// An array of ids goes through bulk().
export async function followUp(idOrIds, iso) {
  const v = iso || "";
  if (Array.isArray(idOrIds)) {
    const ids = Array.from(new Set(idOrIds.filter(Boolean)));
    if (ids.length === 1) return followUp(ids[0], iso);
    if (!ids.length) return null;
    const fields = v ? { next_step: "Follow up", next_due: v } : { next_due: "" };
    return bulk(ids, fields, { onlyIfEmpty: v ? ["next_step"] : undefined, label: v ? "Follow-up " + short(v) : "Follow-up cleared" });
  }
  const rec = store.get(idOrIds);
  const fields = {};
  if (v && rec && !has(rec.next_step)) fields.next_step = "Follow up";
  fields.next_due = v;
  return update(idOrIds, fields, { label: v ? "Follow-up " + short(v) : "Follow-up cleared" });
}

// Claim (spec 4.5): owner = me, follow-up +2 working days, next step only if empty. No stage change.
export async function claim(id) {
  const rec = store.get(id);
  if (!rec) return null;
  const who = me.get() || (await me.ensure());
  let req;
  try {
    req = buildOutcomeRequest(rec, "claim", { me: who, meta: meta(), today: todayIso() });
  } catch (e) {
    toast(errorText(e), { kind: "error" });
    return null;
  }
  return update(id, req.fields, { label: "Claimed · follow-up " + short(req.fields.next_due) });
}

// The "Waiting on client" checkbox (spec D2): adds or removes the next_step prefix.
export async function setWaiting(id, on) {
  const rec = store.get(id);
  if (!rec) return null;
  const next = setWaitingOnClient(rec.next_step, !!on);
  return update(id, { next_step: next }, { label: on ? "Marked as waiting on the client" : "No longer waiting on the client" });
}

// ---------- Bulk ----------

const tokenKey = (s) => String(s || "").toLowerCase().replace(/\s+/g, "");

function addClientLocal(clients, token) {
  const cur = String(clients || "");
  const parts = cur.split(/\s*[,/]\s*/).map(tokenKey).filter(Boolean);
  if (parts.includes(tokenKey(token))) return cur || null;
  return cur.trim() ? cur + ", " + token : token;
}

function bulkWords(fields, n) {
  const sites = num(n) + " " + plural(n, "site");
  if ("stage" in fields) return "Change stage to " + fields.stage + " for " + sites + "?";
  if ("owner" in fields) return (has(fields.owner) ? "Assign " + sites + " to " + fields.owner : "Remove the owner of " + sites) + "?";
  if ("add_client" in fields) return "Add " + fields.add_client + " to " + sites + "?";
  if ("next_due" in fields) return (has(fields.next_due) ? "Set the follow-up to " + short(fields.next_due) + " for " + sites : "Clear the follow-up of " + sites) + "?";
  if ("type" in fields) return "Set the type of " + sites + " to " + fields.type + "?";
  if ("next_step" in fields) return "Set the next step of " + sites + "?";
  return "Change " + sites + "?";
}

function failedIds(r) {
  const out = [];
  for (const f of (r && r.failed) || []) for (const id of f.ids || []) out.push(String(id));
  return out;
}

function showFailures(r) {
  const rows = (r.failed || []).map((f) => html`<li><b>${(f.ids || []).length} ${plural((f.ids || []).length, "site")}</b>: ${f.error || "Failed"}<br><span class="ui-faint">${(f.ids || []).slice(0, 20).join(", ")}${(f.ids || []).length > 20 ? "…" : ""}</span></li>`);
  openModal({ title: "Not updated", body: html`<ul class="ui-plain-list">${rows}</ul>`, actions: [{ label: "Close", kind: "primary" }] });
}

// Patches the store after a bulk response (v2 rows when the server sends them, else the fields).
function patchAfterBulk(r, ids, fields, before, onlyIfEmpty) {
  const v2 = r && r.v2 && typeof r.v2 === "object" ? r.v2 : null;
  if (v2 && Object.keys(v2).length) {
    for (const row of Object.values(v2)) if (Array.isArray(row)) store.upsert(row, { reason: "bulk" });
    return;
  }
  for (const id of ids) {
    const b = before[id];
    if (!b) continue;
    const local = {};
    for (const [k, v] of Object.entries(fields)) {
      if (k === "add_client") local.clients = addClientLocal(b.clients, v);
      else if ((onlyIfEmpty || []).includes(k) && has(b[k])) continue;
      else local[k] = v === "" ? null : v;
    }
    store.patchLocal(id, local, { reason: "bulk" });
  }
}

// ids mode bulk (spec 4.8, 6.3.4). opts: confirm (default true: asks over 20 rows), onlyIfEmpty,
// label, quiet. Resolves to {changed, changed_ids, failed, cancelled?, undo()}.
export async function bulk(ids, fields, opts = {}) {
  const list = Array.from(new Set((ids || []).filter(Boolean).map(String)));
  const none = { changed: 0, changed_ids: [], failed: [], async undo() {} };
  if (!list.length) return none;
  if (guardReadOnly()) return none;
  const f = Object.assign({}, fields || {});
  if (f.stage === "Lost" || f.stage === "Do not contact") {
    f.next_step = "";
    f.next_due = "";
  }
  const send = ordered(f);
  if (opts.confirm !== false && list.length > 20) {
    const ok = await confirm({
      title: bulkWords(send, list.length),
      body: "This also updates the Google Sheet on the next weekday morning.",
      confirmLabel: "Change " + num(list.length) + " " + plural(list.length, "site"),
      danger: send.stage === "Lost",
    });
    if (!ok) return Object.assign({}, none, { cancelled: true });
  }
  // Before-values from the store (used when the server doesn't send `before`).
  const keys = Object.keys(send).map((k) => (k === "add_client" ? "clients" : k));
  const before = {};
  for (const id of list) {
    const rec = store.get(id);
    if (!rec) continue;
    const b = {};
    for (const k of keys) b[k] = rec[k] == null ? "" : rec[k];
    before[id] = b;
  }
  const progress = list.length > 20 && !opts.quiet ? toast("Updating 0 of " + num(list.length) + " sites…", { kind: "info", sticky: true }) : null;
  let r;
  try {
    r = await api.bulk(list, send, {
      onlyIfEmpty: opts.onlyIfEmpty,
      onProgress: ({ done, total }) => progress && progress.update("Updating " + num(done) + " of " + num(total) + " sites…"),
    });
  } catch (e) {
    if (progress) progress.close();
    if (!opts.quiet) failToast(e, () => bulk(ids, fields, Object.assign({}, opts, { confirm: false })));
    if (opts.throw) throw e;
    return Object.assign({}, none, { failed: [{ ids: list, error: errorText(e) }] });
  }
  if (progress) progress.close();
  const bad = new Set(failedIds(r));
  const okIds = list.filter((id) => !bad.has(id));
  const changedIds = Array.isArray(r.changed_ids) && r.changed_ids.length ? r.changed_ids.map(String) : okIds;
  patchAfterBulk(r, changedIds, send, before, opts.onlyIfEmpty);
  const beforeOf = r.before && Object.keys(r.before).length ? r.before : before;
  const changed = Number(r.changed) || 0;
  const result = {
    changed,
    changed_ids: changedIds,
    failed: r.failed || [],
    async undo() {
      const rows = changedIds.filter((id) => beforeOf[id]).map((id) => {
        const b = beforeOf[id];
        const fieldsBack = {};
        for (const k of keys) if (k in b) fieldsBack[k] = sendable(b[k]);
        return { id, fields: ordered(fieldsBack) };
      });
      if (!rows.length) return null;
      if (rows.length > UNDO_MAX) {
        toast("Undo works for up to " + UNDO_MAX + " sites at a time.", { kind: "error" });
        return null;
      }
      const t = rows.length > 20 ? toast("Undoing 0 of " + num(rows.length) + " sites…", { kind: "info", sticky: true }) : null;
      let u;
      try {
        u = await api.bulkRows(rows, { onProgress: ({ done, total }) => t && t.update("Undoing " + num(done) + " of " + num(total) + " sites…") });
      } catch (e) {
        if (t) t.close();
        failToast(e);
        return null;
      }
      if (t) t.close();
      const backIds = rows.map((x) => x.id).filter((id) => !new Set(failedIds(u)).has(id));
      const v2 = u && u.v2 && typeof u.v2 === "object" ? u.v2 : null;
      if (v2 && Object.keys(v2).length) {
        for (const row of Object.values(v2)) if (Array.isArray(row)) store.upsert(row, { reason: "bulk" });
      } else {
        for (const row of rows) if (backIds.includes(row.id)) store.patchLocal(row.id, localFields(row.fields), { reason: "bulk" });
      }
      const nFail = failedIds(u).length;
      toast(nFail ? "Restored " + num(backIds.length) + " · " + num(nFail) + " failed" : "Restored " + num(backIds.length) + " " + plural(backIds.length, "site") + ".",
        { kind: nFail ? "error" : "info", action: nFail ? { label: "Show", fn: () => showFailures(u) } : undefined });
      return u;
    },
  };
  if (!opts.quiet) {
    const nFail = bad.size;
    const head = opts.label ? opts.label + " · " : "";
    toast(head + "Updated " + num(changed) + (nFail ? " · " + num(nFail) + " failed" : ""), {
      kind: nFail ? "error" : "success",
      action: nFail ? { label: "Show", fn: () => showFailures(r) } : undefined,
      undo: changedIds.length && changedIds.length <= UNDO_MAX ? () => result.undo() : undefined,
      sticky: nFail > 0,
    });
  }
  return result;
}

// ---------- Menus and forms ----------

const pf = (id) => "ui-of-" + id;

function reasonOptions() {
  const list = meta().lost_reasons || [];
  return list.length ? list : ["Not a fit", "Other"];
}

function formHtml(o, record, opts) {
  const m = meta();
  const noteVal = opts.note || "";
  const noteBox = (label, required) => html`<label class="ui-field"><span class="ui-label">${label}</span><textarea name="note" rows="2" class="ui-input"${required ? raw(" required") : ""}>${noteVal}</textarea></label>`;
  const title = html`<h3 class="ui-pop-title">${buttonLabel(o)}</h3>`;
  let fields = html``;
  if (o.popover === "reason" && o.id !== "dnc") {
    fields = html`<fieldset class="ui-fieldset"><legend class="ui-label">Reason</legend><div class="ui-radios">${reasonOptions().map((r) => html`<label class="ui-radio"><input type="radio" name="reason" value="${r}"><span>${r}</span></label>`)}</div></fieldset>${noteBox("Add a note (optional)")}`;
  } else if (o.id === "dnc") {
    fields = html`<label class="ui-field"><span class="ui-label">Why?</span><input type="text" name="reason" class="ui-input" maxlength="200" autocomplete="off"></label>`;
  } else if (o.popover === "terms" || o.popover === "terms?") {
    const cur = (k) => (record && record[k] != null ? record[k] : "");
    fields = html`<div class="ui-grid2"><label class="ui-field is-wide"><span class="ui-label">Deal type</span><select name="deal_model" class="ui-input"><option value="">Not set</option>${(m.deal_models || []).map((d) => html`<option${d === cur("deal_model") ? raw(" selected") : ""}>${d}</option>`)}</select></label>
<label class="ui-field"><span class="ui-label">Flat fee ($)</span><input type="text" inputmode="decimal" name="deal_flat" class="ui-input" value="${cur("deal_flat")}" autocomplete="off"></label>
<label class="ui-field"><span class="ui-label">Commission (%)</span><input type="text" inputmode="decimal" name="deal_pct" class="ui-input" value="${cur("deal_pct")}" autocomplete="off"></label></div>${noteBox("Add a note (optional)")}`;
  } else if (o.popover === "link") {
    fields = html`<label class="ui-field"><span class="ui-label">Placement link</span><input type="url" name="link" class="ui-input" placeholder="https://" value="${record && record.content_url ? record.content_url : ""}" autocomplete="off" required></label>
<label class="ui-field"><span class="ui-label">Went live on</span><input type="date" name="date" class="ui-input" value="${(record && record.live_date) || todayIso()}"></label>${noteBox("Add a note (optional)")}`;
  } else if (o.needsNote) {
    fields = noteBox("What did you talk about?", true);
  }
  const save = o.closes ? (o.id === "dnc" ? "Mark as Do not contact" : "Move to Lost") : "Save";
  return html`<form class="ui-form" novalidate>${title}${fields}<p class="ui-error" id="${pf(o.id)}-err" role="alert" hidden></p><div class="ui-form-acts"><button type="button" class="ui-btn is-ghost" data-f="cancel">Cancel</button><button type="submit" class="ui-btn is-primary">${save}</button></div></form>`;
}

function numText(v) {
  const s = String(v == null ? "" : v).trim();
  if (!s) return "";
  const n = Number(s.replace(/[$,%\s]/g, ""));
  return isFinite(n) && n >= 0 ? String(n) : null;
}

// Reads the small form; returns {opts} or {error, field}.
function readForm(o, form, record) {
  const get = (n) => (form.elements[n] ? String(form.elements[n].value || "").trim() : "");
  const out = { note: get("note") };
  if (o.popover === "reason") {
    out.reason = o.id === "dnc" ? get("reason") : (form.querySelector('input[name="reason"]:checked') || {}).value || "";
    if (!out.reason) return { error: o.id === "dnc" ? "Write why." : "Pick a reason.", field: o.id === "dnc" ? "reason" : null };
  }
  if (o.popover === "terms" || o.popover === "terms?") {
    const flat = numText(get("deal_flat"));
    const p = numText(get("deal_pct"));
    if (flat === null) return { error: "The flat fee must be a number.", field: "deal_flat" };
    if (p === null || (p && Number(p) > 100)) return { error: "Commission is a percentage up to 100.", field: "deal_pct" };
    const model = get("deal_model");
    const given = !!(model || flat || p);
    if (o.popover === "terms" && !given) return { error: "Add the terms: a deal type, a flat fee or a commission.", field: "deal_flat" };
    // The form shows the stored terms, so an emptied box clears that term. Unchanged values write nothing.
    if (given) out.terms = { deal_model: model, deal_flat: flat, deal_pct: p };
  }
  if (o.popover === "link") {
    out.link = get("link");
    out.date = get("date");
    if (!/^https?:\/\/[^\s]+$/i.test(out.link)) return { error: "Add the placement link (it starts with http:// or https://).", field: "link" };
  }
  if (o.needsNote && !out.note) return { error: "Write a short note about the call.", field: "note" };
  return { opts: out };
}

function showError(form, msg, field, id) {
  const p = form.querySelector(".ui-error");
  if (p) {
    p.textContent = msg;
    p.hidden = false;
  }
  for (const el of form.querySelectorAll("[aria-invalid]")) el.removeAttribute("aria-invalid");
  const el = field ? form.elements[field] : null;
  if (el && el.setAttribute) {
    el.setAttribute("aria-invalid", "true");
    el.setAttribute("aria-describedby", pf(id) + "-err");
    el.focus();
  }
}

// The small form for Not interested / Not a fit / Do not contact (reason), Counter-offer / Signed
// (terms), Placement is live (link + date) and Had a call (note). One Save. opts are passed on to
// outcome() (note, followUp, onAddTerms, quiet, throw). Resolves to the Record, or null when cancelled
// or failed; with opts.throw a failed save rejects with the error instead.
export function outcomeForm(anchorEl, record, outcomeId, opts = {}) {
  const o = outcomeDef(outcomeId);
  if (!o || !record) return Promise.resolve(null);
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (v) => {
      if (settled) return;
      settled = true;
      resolve(v);
    };
    const pop = openPopover(anchorEl, formHtml(o, record, opts), {
      label: buttonLabel(o),
      className: "ui-pop-form",
      manual: true,
      onClose: () => done(null),
      onOpen(el) {
        const form = el.querySelector("form");
        on(el, "click", '[data-f="cancel"]', () => pop.close());
        on(form, "submit", null, (e) => {
          e.preventDefault();
          const read = readForm(o, form, record);
          if (read.error) {
            showError(form, read.error, read.field, o.id);
            return;
          }
          const callOpts = Object.assign({}, opts, read.opts);
          const p = outcome(record.id, o.id, callOpts);
          settled = true;
          pop.close();
          p.then(resolve, (err) => (opts.throw ? reject(err) : resolve(null)));
        });
      },
    });
    if (!pop.el) done(null);
  });
}

// Runs an outcome picked from a menu or a button: the small form when it needs one, else at once.
// opts (quiet, throw included) reach outcome() either way.
export function runOutcome(anchorEl, record, outcomeId, opts = {}) {
  const o = outcomeDef(outcomeId);
  if (!o || !record) return Promise.resolve(null);
  if (o.popover || (o.needsNote && !has(opts.note))) return outcomeForm(anchorEl, record, outcomeId, opts);
  return outcome(record.id, outcomeId, opts);
}

function outcomeItems(record) {
  const { primary, more } = outcomesFor(record, { meta: meta() });
  const today = todayIso();
  const item = (o) => {
    const due = autoFollowUp(record, o.id, { meta: meta(), today });
    return { label: buttonLabel(o), value: o.id, hint: o.popover ? "…" : due ? "→ " + fmtDate(due, "day") : "" };
  };
  const items = primary.map(item);
  if (more.length) items.push({ divider: true }, { label: "More", more: more.map(item) });
  return items;
}

// "Log what happened ▾" on rows (spec 4.5): the stage-fitting outcomes; popover outcomes open their form.
export async function logMenu(anchorEl, record, { onDone, note: text, followUp: chip } = {}) {
  if (!record || readOnly()) return null;
  const id = await openMenu(anchorEl, { items: outcomeItems(record), label: "Log what happened" });
  if (!id) return null;
  const r = await runOutcome(anchorEl, record, id, { note: text, followUp: chip });
  if (r && onDone) onDone(r, id);
  return r;
}

// A date picker popover: resolves to 'YYYY-MM-DD' or null.
export function pickDate(anchorEl, { value = "", label = "Follow-up date" } = {}) {
  return new Promise((resolve) => {
    let result = null;
    const pop = openPopover(anchorEl, html`<form class="ui-form" novalidate><label class="ui-field"><span class="ui-label">${label}</span><input type="date" name="d" class="ui-input" value="${value || ""}" min="2000-01-01" required></label><p class="ui-error" role="alert" hidden></p><div class="ui-form-acts"><button type="button" class="ui-btn is-ghost" data-f="cancel">Cancel</button><button type="submit" class="ui-btn is-primary">Save</button></div></form>`, {
      label,
      className: "ui-pop-form",
      onClose: () => resolve(result),
      onOpen(el) {
        const form = el.querySelector("form");
        on(el, "click", '[data-f="cancel"]', () => pop.close());
        on(form, "submit", null, (e) => {
          e.preventDefault();
          const v = String(form.elements.d.value || "");
          if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) {
            const p = form.querySelector(".ui-error");
            p.textContent = "Pick a date.";
            p.hidden = false;
            form.elements.d.setAttribute("aria-invalid", "true");
            return;
          }
          result = v;
          pop.close();
        });
      },
    });
    if (!pop.el) resolve(null);
  });
}

// "Follow up ▾" (spec 4.5): Tomorrow · In 3 days · Next Monday · In 2 weeks · Pick date… · Clear.
export async function followUpMenu(anchorEl, recordOrIds, { onDone } = {}) {
  if (readOnly()) return null;
  const today = todayIso();
  const many = Array.isArray(recordOrIds);
  const current = !many && recordOrIds ? recordOrIds.next_due || "" : "";
  const hint = (c) => fmtDate(chipDate(c, today), "short");
  const items = [
    { label: "Tomorrow", value: "tomorrow", hint: hint("tomorrow") },
    { label: "In 3 days", value: "3d", hint: hint("3d") },
    { label: "Next Monday", value: "monday", hint: hint("monday") },
    { label: "In 2 weeks", value: "2w", hint: hint("2w") },
    { label: "Pick date…", value: "pick" },
    { divider: true },
    { label: "Clear", value: "clear", disabled: !many && !current },
  ];
  const v = await openMenu(anchorEl, { items, label: "Follow up" });
  if (!v) return null;
  const iso = v === "pick" ? await pickDate(anchorEl, { value: current }) : chipDate(v, today);
  if (iso == null) return null;
  const target = many ? recordOrIds.map((x) => (typeof x === "string" ? x : x.id)) : recordOrIds.id;
  const r = await followUp(target, iso || null);
  if (r && onDone) onDone(r);
  return r;
}

// "Flat fee + commission · $350 + 30%" (spec 4.2 deal terms display).
export function termsLine(record) {
  if (!record) return "";
  return [record.deal_model, termsText(record)].filter(Boolean).join(" · ");
}
