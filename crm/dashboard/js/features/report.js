// Client monthly report (spec 2.2.4, F8 in section 3). Owner F5. No side effects at import time.
//
// openReport({clientKey, month, product}) opens a modal for one client (or one Melograno product). It
// defaults to last month, with a month picker (the current month and the 5 before it). The content comes
// from rules/clients.js#buildReport, which is client-safe: it never holds next-step text, notes, contact
// emails, internal ids or owner names. Warnings (deals without terms, live dates after today, unnamed
// creators, placements without a link) show in the footer, right above the actions; no checkboxes.
// Actions: "Copy as email" (plain text on the clipboard) and "Print / Save as PDF" (window.print, live
// site only: the snapshot has no Print button). css/print.css prints only a dialog marked data-print, and
// leaves out everything marked data-noprint (the month picker, the warnings and the buttons).
import { html, render, on, copyText, safeUrl } from "../core/dom.js";
import { todayIso, date as fmtDate, num } from "../core/format.js";
import * as metaMod from "../core/meta.js";
import * as store from "../core/store.js";
import { openModal } from "../ui/dialog.js";
import { toast } from "../ui/toast.js";
import {
  buildReport, reportMonths, defaultMonth, monthLabel, clientOf, productOf, clientToken, REPORT_NOTE, TERMS_NONE,
} from "../rules/clients.js";

let current = null;

function isLive() {
  return !(typeof window !== "undefined" && window.__SNAPSHOT__);
}

// "soro-review.example.test/post-1" for the link text (the href keeps the whole address).
function shortUrl(u) {
  return String(u || "").replace(/^https?:\/\//i, "").replace(/^www\./i, "").replace(/\/$/, "");
}

function docHtml(r) {
  const month = r.monthLabel;
  const sum = [
    ["Sites contacted in " + month, num(r.contacted), "approx."],
    ["Replies in " + month, num(r.replies), "approx."],
    ["Placements that went live in " + month, num(r.live.length), ""],
    ["Deals in talks now", num(r.inTalks.length), ""],
    ["Active partners now", num(r.activeCount), ""],
  ];
  const live = r.live.length
    ? html`<ul class="rp-list">${r.live.map((x) => {
      const url = safeUrl(x.url);
      return html`<li><b>${x.name}</b>${x.website ? html` <span class="rp-dim">${x.website}</span>` : ""}${x.date ? html` · live ${fmtDate(x.date, "day")}` : ""}${url ? html` · <a href="${url}" target="_blank" rel="noopener noreferrer">${shortUrl(url)}</a>` : ""}</li>`;
    })}</ul>`
    : html`<p class="rp-none">None went live in ${month}.</p>`;
  const talks = r.inTalks.length
    ? html`<ul class="rp-list">${r.inTalks.map((x) => html`<li><b>${x.name}</b>: ${x.terms ? x.terms : html`<span class="rp-dim">${TERMS_NONE}</span>`}</li>`)}</ul>`
    : html`<p class="rp-none">No deals in talks right now.</p>`;
  return html`<h3 class="rp-title">${r.title}</h3>
<table class="rp-sum"><tbody>${sum.map(([k, v, note]) => html`<tr><th scope="row">${k}${note ? html` <span class="rp-dim">(${note})</span>` : ""}</th><td>${v}</td></tr>`)}</tbody></table>
<h4 class="rp-h">Placements live in ${month}</h4>${live}
<h4 class="rp-h">Deals in talks now</h4>${talks}
<h4 class="rp-h">Pipeline</h4><p class="rp-p">${r.pipeline}</p>
<p class="rp-note">${REPORT_NOTE}</p>`;
}

function warnHtml(r) {
  if (!r.warnings.length) return html``;
  return html`<div class="rp-warn" role="note"><p class="rp-warn-h">Check before you send</p><ul>${r.warnings.map((w) => html`<li>${w}</li>`)}</ul></div>`;
}

/**
 * Opens the report for a client: {clientKey (stored key, slug or name), month ('YYYY-MM', default last
 * month), product (a Melograno product, optional)}. Returns the modal, or null for an unknown client.
 */
export function openReport({ clientKey, month, product } = {}) {
  const meta = metaMod.get();
  const c = clientOf(meta, clientKey);
  if (!c) {
    toast("That client wasn't found.", { kind: "error" });
    return null;
  }
  if (current && current.modal && current.modal.el.open) current.modal.close();
  const today = todayIso();
  const months = reportMonths(today);
  const p = productOf(c, product);
  const who = clientToken(c, p);
  const st = { ym: months.includes(month) ? month : defaultMonth(today), report: null, modal: null };
  current = st;

  const compute = () => {
    st.report = buildReport(store.all(), { meta: metaMod.get(), client: c.k, product: p, month: st.ym, today });
  };
  compute();

  let off = () => {};
  const actions = [];
  if (isLive()) {
    actions.push({ label: "Print / Save as PDF", kind: "ghost", onClick: () => { doPrint(); return false; } });
  }
  actions.push({ label: "Copy as email", kind: "primary", onClick: () => { doCopy(); return false; } });

  const modal = openModal({
    title: "Monthly report · " + who,
    size: "lg",
    className: "rp-modal",
    body: html`<div class="rp">
<div class="rp-tools" data-noprint><label class="ui-label" for="rp-month">Month</label><select id="rp-month" class="ui-input rp-month" data-rp-month>${months.map((m) => html`<option value="${m}"${m === st.ym ? html` selected` : ""}>${monthLabel(m)}</option>`)}</select><span class="rp-hint">Only what the client may see: no notes, next steps, emails or owners.</span></div>
<article class="rp-doc" data-rp-doc aria-live="polite"></article>
</div>`,
    actions,
    onClose: () => {
      off();
      if (current === st) current = null;
    },
  });
  st.modal = modal;
  modal.el.setAttribute("data-print", "");
  const head = modal.el.querySelector(".ui-modal-head");
  if (head) head.setAttribute("data-noprint", "");
  const foot = modal.el.querySelector(".ui-modal-foot");
  if (foot) foot.setAttribute("data-noprint", "");
  const copyBtn = Array.from(modal.el.querySelectorAll(".ui-modal-foot button")).find((b) => /copy as email/i.test(b.textContent));
  if (copyBtn) copyBtn.setAttribute("data-rp-copy", "");
  const printBtn = Array.from(modal.el.querySelectorAll(".ui-modal-foot button")).find((b) => /print/i.test(b.textContent));
  if (printBtn) printBtn.setAttribute("data-rp-print", "");

  // The warnings sit in the footer, right above the actions, so they show without scrolling the report.
  const warn = document.createElement("div");
  warn.className = "rp-warns";
  warn.setAttribute("data-rp-warn", "");
  warn.setAttribute("data-noprint", "");
  if (foot) foot.insertBefore(warn, foot.firstChild);
  else modal.body.appendChild(warn);
  const doc = modal.body.querySelector("[data-rp-doc]");
  const draw = () => {
    render(doc, docHtml(st.report));
    render(warn, warnHtml(st.report));
  };
  draw();

  off = on(modal.body, "change", "[data-rp-month]", (e, sel) => {
    st.ym = sel.value;
    compute();
    draw();
  });

  async function doCopy() {
    const ok = await copyText(st.report.text);
    if (ok) {
      toast("Report copied. Paste it into your email to " + who + ".", { kind: "success" });
      return;
    }
    try {
      const range = document.createRange();
      range.selectNodeContents(doc);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    } catch (e) { /* nothing to select */ }
    toast("Press Ctrl+C (or Cmd+C) to copy the selected report.", { kind: "info" });
  }

  function doPrint() {
    if (!isLive() || typeof window.print !== "function") return;
    window.print();
  }

  return modal;
}
