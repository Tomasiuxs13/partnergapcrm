// Help and Settings (spec 2.2.7, D3, D11, 6.3.11). Page module contract (spec 5.4). Owner F8.
//
// Help, for everyone: how this CRM works (three sentences), the name edits are signed with, the stage
// glossary, what each Today block and reason chip means, the 5 shortcuts (4.6), who manages which client,
// the schedule of the automatic jobs (Vilnius time; shown only here), the Google Sheet link, "Report a
// problem" (copies version, build, browser and the last error) and What's new.
// Settings, only for meta.admins (Jonas, Vik), saved at once with PUT /api/settings (D1 kv_meta only: no
// edits row, nothing reaches the sheet):
//   - Team: add a name, remove one (it stays a past owner; Add back), and each person's landing page.
//   - Clients: add a client (name, what they sell, managers, markets), mark one as past (or current again).
//   - Allow "Do not contact": a switch, off by default (D3).
// After a save the page re-reads /api/meta, so this browser's menus follow at once; everyone else sees it
// on their next page load ("Saved. Everyone sees it on their next page load."). Without kv_meta the
// settings say "Not available yet"; in a read-only copy they are shown but can't be changed.
import { html, render, on, copyText } from "../core/dom.js";
import * as metaMod from "../core/meta.js";
import { readOnlyText } from "../core/api.js";
import { num } from "../core/format.js";
import { stageDot, reasonChip, avatar } from "../ui/pills.js";
import { toast } from "../ui/toast.js";
import { confirm, openModal } from "../ui/dialog.js";
import { openWhatsNew } from "../shell/whats-new.js";
import { errorDetails, freshnessLine } from "../shell/shell.js";
import { openMePicker, cleanTypedName } from "../shell/me-picker.js";

const SAVED = "Saved. Everyone sees it on their next page load.";
const DNC = "Do not contact";
const DNC_HELP = "Turn on only after the morning copy knows this stage.";

const has = (v) => v != null && String(v).trim() !== "";
const title = () => "Help";
const lower = (s) => String(s == null ? "" : s).trim().toLowerCase();
const compact = (s) => lower(s).replace(/[^a-z0-9]+/g, "");

let st = null; // the mounted page's state

// ---------- content ----------

const BLOCKS = [
  { name: "Do now", text: "Your sites that need something from you today, the most urgent first. Start opens them one after another." },
  { name: "New prospects: find a contact", text: "Your new sites that have no contact yet. Add a contact, send the first email, then click Sent first email." },
  { name: "Coming up", text: "Your sites with a follow-up date later on. It stays closed until you open it." },
];

function chips(meta) {
  const cap = meta && meta.noreply_cap != null ? Number(meta.noreply_cap) : 10;
  return [
    { reason: "overdue", chip: "Overdue 3d", text: "The follow-up date was 3 days ago." },
    { reason: "reply", chip: "Replied 2d ago", text: "They wrote back 2 days ago and nobody has answered yet." },
    { reason: "decision", chip: "Your decision", text: "A deal in Negotiating that waits for you, not for the client." },
    { reason: "due", chip: "Due today", text: "The follow-up date is today." },
    { reason: "quiet", chip: "Quiet 9d", text: "A deal with no activity for 9 days." },
    { reason: "noreply", chip: "No reply 16d", text: "Emailed 16 days ago with no answer. Today shows at most " + num(cap) + "; the rest are in Sites › Waiting for reply." },
    { reason: "noreply", chip: "No reply · no date", text: "Emailed, but no date was recorded." },
    { nodate: true, chip: "No date", text: "A reply or a decision with no follow-up date yet. Use Follow up to set one." },
  ];
}

const SHORTCUTS = [
  { keys: [["Ctrl", "K"], ["/"]], text: "Search (Cmd K on a Mac)" },
  { keys: [["n"]], text: "Add site" },
  { keys: [["Enter"]], text: "Open the site in the row you are on" },
  { keys: [["Esc"]], text: "Close the menu, search, window or site panel" },
  { keys: [["j"], ["k"]], text: "Next or previous site while you go through a list (after Start)" },
];

// The schedule rows (meta.schedule) in the site's words: "the morning copy to the Google Sheet" (2.5).
function jobOf(row) {
  const name = String((row && row.name) || "");
  if (/daily|morning copy/i.test(name)) {
    return { name: "Morning copy to the Google Sheet", text: "Copies the changes made here to the Google Sheet, then brings the sheet's own changes here." };
  }
  if (/find|discover/i.test(name)) return { name, text: "Adds new prospect sites for each client." };
  if (/digest|weekly/i.test(name)) return { name, text: "A summary of the week for the team." };
  return { name, text: "" };
}

// ---------- who is this ----------

function me(ctx) {
  try { return ctx.me.get() || ""; } catch (e) { return ""; }
}

function isAdmin(ctx) {
  const name = lower(me(ctx));
  return !!name && (ctx.meta.admins || []).some((a) => lower(a) === name);
}

function adminNames(ctx) {
  const list = (ctx.meta.admins || []).map(String);
  if (!list.length) return "Jonas or Vik";
  return list.length === 1 ? list[0] : list.slice(0, -1).join(", ") + " or " + list[list.length - 1];
}

// ---------- Help cards ----------

const ICON = {
  news: html`<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3l2.2 5.3L20 9l-4.4 3.8L17 18.5 12 15.6 7 18.5l1.4-5.7L4 9l5.8-.7z"/></svg>`,
  bug: html`<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="7" width="8" height="12" rx="4"/><path d="M12 7V4M8 11H4M20 11h-4M8 15H4M20 15h-4M9 4l1.5 2M15 4l-1.5 2"/></svg>`,
  gear: html`<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M5.3 18.7l2.1-2.1M16.6 7.4l2.1-2.1"/></svg>`,
};

function howHtml(ctx) {
  const m = ctx.meta;
  const hhmm = metaMod.runTime(m);
  const name = me(ctx);
  const test = m.test_mode !== false;
  return html`<section class="ui-card hp-card" aria-labelledby="hp-how-h"><h2 class="hp-h" id="hp-how-h">How this CRM works</h2>
<ol class="hp-how">
<li>Do your work here: every change saves at once.</li>
<li>The Google Sheet updates itself each weekday morning (${hhmm}), and changes made directly in the sheet show here the next weekday morning.</li>
<li>${test ? "Outreach is in test mode: nothing is sent from this site." : "This site never sends email or Slack messages itself."}</li>
</ol>
<p class="hp-signed">${name
    ? html`Edits are signed with the name you picked: <span class="hp-me">${avatar(name, { size: "xs" })}<b>${name}</b></span>. <button type="button" class="ui-linkbtn" data-hp-act="me" data-hp-focus="me">Change name</button>`
    : html`Edits are signed with the name you picked. <button type="button" class="ui-linkbtn" data-hp-act="me" data-hp-focus="me">Pick your name</button>`}</p>
<p class="hp-links">${m.sheet_url ? html`<a class="ui-btn is-sm" href="${m.sheet_url}" target="_blank" rel="noopener">Open the Google Sheet<span aria-hidden="true"> ↗</span><span class="sr-only"> (opens in a new tab)</span></a>` : ""}<a class="ui-btn is-sm" href="${ctx.href("history")}">See Edit history</a></p>
</section>`;
}

function stagesHtml(ctx) {
  const m = ctx.meta;
  const dnc = !!(m.features && m.features.dnc);
  const list = (m.stages || []).filter((s) => s && s.name && (s.name !== DNC || dnc));
  return html`<section class="ui-card hp-card" aria-labelledby="hp-stages-h"><h2 class="hp-h" id="hp-stages-h">Stages</h2>
<dl class="hp-dl hp-stages">${list.map((s) => html`<div class="hp-dl-row"><dt>${stageDot(s.name)}<span>${s.name}</span></dt><dd>${s.desc || ""}</dd></div>`)}</dl>
<p class="hp-muted">New and Researching together are “Not contacted”. A site moves on when you log what happened.</p>
</section>`;
}

function todayHtml(ctx) {
  return html`<section class="ui-card hp-card" aria-labelledby="hp-today-h"><h2 class="hp-h" id="hp-today-h">Today</h2>
<dl class="hp-dl">${BLOCKS.map((b) => html`<div class="hp-dl-row is-block"><dt>${b.name}</dt><dd>${b.text}</dd></div>`)}</dl>
<h3 class="hp-h3">The labels on Do now rows</h3>
<dl class="hp-dl hp-chips">${chips(ctx.meta).map((c) => html`<div class="hp-dl-row"><dt>${c.nodate
    ? html`<span class="ui-chip is-nodate">${c.chip}</span>`
    : reasonChip({ reason: c.reason, chip: c.chip })}</dt><dd>${c.text}</dd></div>`)}</dl>
</section>`;
}

function keysHtml() {
  const combo = (parts) => html`<span class="hp-combo">${parts.map((k, i) => html`${i ? html`<span aria-hidden="true">+</span>` : ""}<kbd>${k}</kbd>`)}</span>`;
  return html`<section class="ui-card hp-card" aria-labelledby="hp-keys-h"><h2 class="hp-h" id="hp-keys-h">Keyboard shortcuts</h2>
<dl class="hp-dl hp-keys">${SHORTCUTS.map((s) => html`<div class="hp-dl-row"><dt>${s.keys.map((c, i) => html`${i ? html`<span class="hp-or">or</span>` : ""}${combo(c)}`)}</dt><dd>${s.text}</dd></div>`)}</dl>
<p class="hp-muted">Shortcuts don't work while you type in a field, except Esc and Ctrl K.</p>
</section>`;
}

function clientsHtml(ctx) {
  const m = ctx.meta;
  const list = (m.clients || []).filter((c) => c && c.name);
  const past = (m.past_clients || []).filter((c) => c && c.name);
  return html`<section class="ui-card hp-card" aria-labelledby="hp-cl-h"><h2 class="hp-h" id="hp-cl-h">Who manages which client</h2>
${list.length ? html`<div class="hp-tablewrap"><table class="hp-table"><thead><tr><th scope="col">Client</th><th scope="col">Managers</th><th scope="col" class="hp-c-markets">Markets</th></tr></thead><tbody>${list.map((c) => html`<tr><th scope="row"><a href="${ctx.href("clients", {}, c.slug || c.k)}">${c.name}</a>${has(c.what) ? html`<span class="hp-sub">${c.what}</span>` : ""}</th><td>${(c.managers || []).length ? (c.managers || []).join(", ") : html`<span class="ui-faint">—</span>`}</td><td class="hp-c-markets">${has(c.markets) ? c.markets : html`<span class="ui-faint">—</span>`}</td></tr>`)}</tbody></table></div>` : html`<p class="hp-muted">Not available yet.</p>`}
${past.length ? html`<p class="hp-muted">Past clients: ${past.map((c) => c.name).join(", ")}.</p>` : ""}
${isAdmin(ctx) ? "" : html`<p class="hp-muted">${adminNames(ctx)} can change the team and client lists.</p>`}
</section>`;
}

function scheduleHtml(ctx) {
  const rows = (ctx.meta.schedule || []).filter((r) => r && r.name);
  let fresh = null;
  try { fresh = freshnessLine(); } catch (e) { fresh = null; }
  return html`<section class="ui-card hp-card" aria-labelledby="hp-sched-h"><h2 class="hp-h" id="hp-sched-h">Automatic jobs <span class="hp-h-note">Vilnius time</span></h2>
${rows.length ? html`<dl class="hp-dl hp-sched">${rows.map((r) => {
    const j = jobOf(r);
    return html`<div class="hp-dl-row"><dt><b>${j.name}</b><span class="hp-when">${r.when || ""}</span></dt>${j.text ? html`<dd>${j.text}</dd>` : ""}</div>`;
  })}</dl>` : html`<p class="hp-muted">Not available yet.</p>`}
${fresh ? html`<p class="hp-muted${fresh.warn ? " is-warn" : ""}">${fresh.text}.</p>` : ""}
</section>`;
}

function reportHtml() {
  return html`<section class="ui-card hp-card" aria-labelledby="hp-rep-h"><h2 class="hp-h" id="hp-rep-h">Report a problem</h2>
<p>Something not working? Copy the details and paste them into a message to Jonas. They hold the version, your browser and the last error, never any site data.</p>
<p class="hp-links"><button type="button" class="ui-btn is-sm" data-hp-act="report" data-hp-focus="report">${ICON.bug}Copy problem details</button></p>
</section>`;
}

// ---------- Settings ----------

function teamList(ctx) {
  return (ctx.meta.team || []).filter((m) => m && has(m.name)).map((m) => ({ name: String(m.name), home: m.home === "team" ? "team" : undefined, active: m.active !== false }));
}

function sendTeam(list) {
  return list.map((m) => {
    const e = { name: m.name };
    if (m.home === "team" || m.home === "today") e.home = m.home;
    e.active = m.active !== false;
    return e;
  });
}

function storedClients() {
  const d = st && st.set && st.set.data;
  return d && Array.isArray(d.clients) ? d.clients.map((c) => Object.assign({}, c)) : [];
}

function busyAttr(part) {
  return st.set.busy === part ? html` disabled aria-busy="true"` : st.set.busy ? html` disabled` : "";
}

function errHtml(part) {
  const msg = st.set.err && st.set.err[part];
  return html`<p class="ui-error hp-err" id="${"hp-" + part + "-err"}" role="alert" data-hp-err="${part}"${msg ? "" : html` hidden`}>${msg || ""}</p>`;
}

function teamBlock(ctx, ro) {
  const team = teamList(ctx);
  const active = team.filter((m) => m.active);
  const past = team.filter((m) => !m.active);
  const dis = ro ? html` disabled title="${readOnlyText()}"` : busyAttr("team");
  return html`<div class="hp-set-block" data-hp-block="team"><h3 class="hp-h3" id="hp-team-h">Team</h3>
<p class="hp-muted">The names in the owner menus and on the sign-in page. Removing someone keeps their sites; they show as a past owner.</p>
<div class="hp-tablewrap"><table class="hp-table hp-team" aria-labelledby="hp-team-h"><thead><tr><th scope="col">Name</th><th scope="col">Lands on</th><th scope="col"><span class="sr-only">Remove</span></th></tr></thead><tbody>${active.map((m) => html`<tr><th scope="row"><span class="hp-person">${avatar(m.name, { size: "xs" })}${m.name}</span></th><td class="hp-c-home"><label class="hp-home"><span class="hp-home-l" aria-hidden="true">Lands on</span><select class="ui-input hp-select" data-hp-home="${m.name}" data-hp-focus="${"home:" + m.name}" aria-label="${"Landing page for " + m.name}"${dis}><option value="today"${m.home !== "team" ? html` selected` : ""}>Today</option><option value="team"${m.home === "team" ? html` selected` : ""}>Team overview</option></select></label></td><td class="hp-c-act"><button type="button" class="ui-btn is-sm is-ghost" data-hp-remove="${m.name}" data-hp-focus="${"remove:" + m.name}" aria-label="${"Remove " + m.name + " from the team"}"${dis}>Remove</button></td></tr>`)}</tbody></table></div>
<form class="hp-add" data-hp-addperson novalidate><label class="ui-field"><span class="ui-label">Add a person</span><input class="ui-input" name="name" type="text" maxlength="40" autocomplete="off" placeholder="First name" data-hp-focus="addperson"${dis}></label><button type="submit" class="ui-btn"${dis}>Add</button></form>
${errHtml("team")}
${past.length ? html`<div class="hp-past"><p class="hp-muted">Past team members (their sites show them as past owner):</p><ul class="hp-pastlist">${past.map((m) => html`<li><span>${m.name}</span> <button type="button" class="ui-linkbtn" data-hp-addback="${m.name}" data-hp-focus="${"addback:" + m.name}"${dis}>Add back</button></li>`)}</ul></div>` : ""}
</div>`;
}

function clientsBlock(ctx, ro) {
  const cur = (ctx.meta.clients || []).filter((c) => c && c.k);
  const past = (ctx.meta.past_clients || []).filter((c) => c && c.k);
  const dis = ro ? html` disabled title="${readOnlyText()}"` : busyAttr("clients");
  return html`<div class="hp-set-block" data-hp-block="clients"><h3 class="hp-h3" id="hp-clients-h">Clients</h3>
<p class="hp-muted">The clients in the menus and on the Clients page. Marking one as past keeps its sites and their client tags.</p>
<div class="hp-tablewrap"><table class="hp-table" aria-labelledby="hp-clients-h"><thead><tr><th scope="col">Client</th><th scope="col">Managers</th><th scope="col"><span class="sr-only">Mark as past</span></th></tr></thead><tbody>${cur.map((c) => html`<tr><th scope="row">${c.name}${has(c.what) ? html`<span class="hp-sub">${c.what}</span>` : ""}</th><td>${(c.managers || []).join(", ") || html`<span class="ui-faint">—</span>`}</td><td class="hp-c-act"><button type="button" class="ui-btn is-sm is-ghost" data-hp-past="${c.k}" data-hp-focus="${"past:" + c.k}" aria-label="${"Mark " + c.name + " as a past client"}"${dis}>Mark as past</button></td></tr>`)}</tbody></table></div>
<p class="hp-row"><button type="button" class="ui-btn" data-hp-addclient data-hp-focus="addclient"${dis}>+ Add client</button></p>
${errHtml("clients")}
${past.length ? html`<div class="hp-past"><p class="hp-muted">Past clients:</p><ul class="hp-pastlist">${past.map((c) => html`<li><span>${c.name}</span> <button type="button" class="ui-linkbtn" data-hp-current="${c.k}" data-hp-focus="${"current:" + c.k}"${dis}>Make current</button></li>`)}</ul></div>` : ""}
</div>`;
}

function dncBlock(ctx, ro) {
  const on = !!(st.set.data && st.set.data.allow_dnc);
  const dis = ro ? html` disabled title="${readOnlyText()}"` : busyAttr("dnc");
  return html`<div class="hp-set-block" data-hp-block="dnc"><h3 class="hp-h3">Allow “Do not contact”</h3>
<label class="hp-switch"><input type="checkbox" role="switch" data-hp-dnc data-hp-focus="dnc"${on ? html` checked` : ""}${dis} aria-describedby="hp-dnc-help"><span class="hp-switch-track" aria-hidden="true"></span><span>${on ? "On: “Do not contact” is in the stage menus" : "Off"}</span></label>
<p class="hp-muted" id="hp-dnc-help">${DNC_HELP}</p>
${errHtml("dnc")}
</div>`;
}

function settingsHtml(ctx) {
  if (!isAdmin(ctx)) return html``;
  const s = st.set;
  const ro = !!ctx.meta.read_only;
  let body;
  if (s.state === "loading" || s.state === "idle") body = html`<p class="hp-muted" aria-busy="true">Loading…</p>`;
  else if (s.state === "na") body = html`<p class="hp-muted">Not available yet.</p>`;
  else if (s.state === "error") body = html`<p class="hp-muted">${s.error || "Couldn't load the settings."} <button type="button" class="ui-linkbtn" data-hp-act="reload-settings">Try again</button></p>`;
  else body = html`${ro ? html`<p class="hp-note">${readOnlyText()}</p>` : ""}<div class="hp-set-grid">${teamBlock(ctx, ro)}${clientsBlock(ctx, ro)}${dncBlock(ctx, ro)}</div>`;
  return html`<section class="ui-card hp-card hp-settings" aria-labelledby="hp-set-h" data-hp-settings><h2 class="hp-h" id="hp-set-h" tabindex="-1">Settings</h2>
<p class="hp-muted">Only ${adminNames(ctx)} see this. Settings are saved on this site only, never in the Google Sheet. Everyone sees a change on their next page load.</p>
${body}</section>`;
}

// ---------- drawing ----------

function pageHtml(ctx) {
  const admin = isAdmin(ctx);
  return html`<div class="hp-page"><header class="hp-head"><div class="hp-titles"><h1 tabindex="-1">Help</h1><p class="hp-lead">How the CRM works, what the labels mean, and who to ask.</p></div>
<div class="hp-acts"><button type="button" class="ui-btn" data-hp-act="whatsnew" data-hp-focus="whatsnew">${ICON.news}What's new</button>${admin ? html`<button type="button" class="ui-btn" data-hp-act="settings" data-hp-focus="gosettings">${ICON.gear}Settings</button>` : ""}</div></header>
<div class="hp-grid"><div class="hp-col">${howHtml(ctx)}${todayHtml(ctx)}${stagesHtml(ctx)}</div><div class="hp-col">${keysHtml()}${clientsHtml(ctx)}${scheduleHtml(ctx)}${reportHtml()}</div></div>
<div data-hp-set-slot>${settingsHtml(ctx)}</div></div>`;
}

function focusKey() {
  const a = typeof document !== "undefined" ? document.activeElement : null;
  if (!a || !st || !st.root.contains(a)) return null;
  const el = a.closest("[data-hp-focus]");
  return el ? el.getAttribute("data-hp-focus") : null;
}

function refocus(key, fallback) {
  if (!st) return;
  const esc = (v) => (typeof CSS !== "undefined" && CSS.escape ? CSS.escape(v) : String(v).replace(/"/g, '\\"'));
  let el = key ? st.root.querySelector('[data-hp-focus="' + esc(key) + '"]') : null;
  if (el && el.disabled) el = null;
  if (!el && fallback) el = st.root.querySelector(fallback);
  if (el) el.focus({ preventScroll: true });
}

function draw() {
  if (!st) return;
  const key = focusKey();
  render(st.root, pageHtml(st.ctx));
  if (key) refocus(key);
}

function drawSettings({ focus, fallback } = {}) {
  if (!st) return;
  const slot = st.root.querySelector("[data-hp-set-slot]");
  if (!slot) return;
  const key = focus !== undefined ? focus : focusKey();
  const typed = slot.querySelector("[data-hp-addperson] input");
  const keepTyped = typed ? typed.value : "";
  render(slot, settingsHtml(st.ctx));
  const again = slot.querySelector("[data-hp-addperson] input");
  if (again && keepTyped) again.value = keepTyped;
  if (key) refocus(key, fallback);
}

// ---------- settings data ----------

async function loadSettings() {
  if (!st || !isAdmin(st.ctx)) return;
  const my = st;
  my.set.state = "loading";
  drawSettings();
  let r;
  try {
    r = await my.ctx.api.settings();
  } catch (e) {
    if (st !== my) return;
    my.set.state = "error";
    my.set.error = (e && (e.friendly || e.message)) || "Couldn't load the settings.";
    drawSettings();
    return;
  }
  if (st !== my) return;
  if (!r) {
    my.set.state = "na";
  } else {
    my.set.state = "ready";
    my.set.data = { team: r.team || null, clients: r.clients || null, allow_dnc: !!r.allow_dnc };
  }
  drawSettings();
}

// PUT /api/settings with one part, then re-read /api/meta. undo: the patch that puts it back.
async function save(part, patch, { undo, focus, fallback, message = SAVED } = {}) {
  if (!st || st.set.busy) return false;
  const my = st;
  my.set.busy = part;
  my.set.err = {};
  const key = focus !== undefined ? focus : focusKey();
  drawSettings({ focus: null });
  let r = null;
  let error = null;
  try {
    r = await my.ctx.api.saveSettings(patch);
    if (!r) error = "Not available yet. Nothing was saved.";
  } catch (e) {
    error = (e && (e.friendly || e.message)) || "Couldn't save. Try again.";
    if (e && e.status === 401) error = null;
  }
  if (st !== my) return !error;
  if (r) my.set.data = { team: r.team || null, clients: r.clients || null, allow_dnc: !!r.allow_dnc };
  if (!error && r) {
    try { await metaMod.refresh(); } catch (e) { /* menus follow on the next load */ }
  }
  if (st !== my) return !error;
  my.set.busy = null;
  if (error) my.set.err = { [part]: error };
  drawSettings({ focus: key, fallback: fallback || '[data-hp-block="' + part + '"] .hp-h3' });
  if (error) return false;
  toast(message, { kind: "success", undo: typeof undo === "function" ? undo : undefined });
  return true;
}

function setHome(name, home) {
  const team = teamList(st.ctx).map((m) => (m.name === name ? Object.assign({}, m, { home: home === "team" ? "team" : "today" }) : m));
  return save("team", { team: sendTeam(team) }, { focus: "home:" + name });
}

function removePerson(name) {
  const before = teamList(st.ctx);
  if (before.filter((m) => m.active).length <= 1) {
    st.set.err = { team: "Keep at least one person on the team." };
    drawSettings();
    return;
  }
  const team = before.map((m) => (m.name === name ? Object.assign({}, m, { active: false }) : m));
  save("team", { team: sendTeam(team) }, {
    focus: null,
    fallback: "[data-hp-addperson] input",
    message: name + " was removed from the team. Everyone sees it on their next page load.",
    undo: () => save("team", { team: sendTeam(before) }, { focus: "remove:" + name }),
  });
}

function addBack(name) {
  const team = teamList(st.ctx).map((m) => (m.name === name ? Object.assign({}, m, { active: true }) : m));
  save("team", { team: sendTeam(team) }, { focus: "remove:" + name, message: name + " is back on the team. Everyone sees it on their next page load." });
}

async function addPerson(form) {
  const input = form.querySelector("input[name=name]");
  const typed = input ? input.value : "";
  const name = cleanTypedName(typed);
  const fail = (msg) => {
    st.set.err = { team: msg };
    drawSettings({ focus: "addperson" });
    const again = st.root.querySelector("[data-hp-addperson] input");
    if (again) {
      again.value = typed;
      again.setAttribute("aria-invalid", "true");
      again.setAttribute("aria-describedby", "hp-team-err");
    }
  };
  if (!name) return fail("Type a name of 2–40 letters (spaces, ' and - are fine).");
  const team = teamList(st.ctx);
  const hit = team.find((m) => lower(m.name) === lower(name));
  if (hit && hit.active) return fail(hit.name + " is already on the team.");
  const next = hit ? team.map((m) => (m === hit ? Object.assign({}, m, { active: true }) : m)) : team.concat([{ name, active: true }]);
  if (input) input.value = "";
  const ok = await save("team", { team: sendTeam(next) }, { focus: "addperson", message: (hit ? hit.name : name) + " was added to the team. Everyone sees it on their next page load." });
  if (!ok && st) {
    const again = st.root.querySelector("[data-hp-addperson] input");
    if (again && !again.value) again.value = typed;
  }
}

function setClientPast(k, past) {
  const all = (st.ctx.meta.clients || []).concat(st.ctx.meta.past_clients || []);
  const c = all.find((x) => x.k === k);
  if (!c) return;
  const before = storedClients();
  const next = before.map((x) => Object.assign({}, x));
  const i = next.findIndex((x) => x.k === k);
  if (i >= 0) next[i] = Object.assign({}, next[i], { past });
  else next.push({ k, name: c.name, past });
  save("clients", { clients: next }, {
    focus: past ? "current:" + k : "past:" + k,
    fallback: "[data-hp-addclient]",
    message: c.name + (past ? " is now a past client." : " is a current client again.") + " Everyone sees it on their next page load.",
    undo: () => save("clients", { clients: before }, { focus: past ? "past:" + k : "current:" + k }),
  });
}

// The Add client form (a modal). Resolves when it closes.
function addClientForm() {
  const ctx = st.ctx;
  const names = teamList(ctx).filter((m) => m.active).map((m) => m.name).sort((a, b) => a.localeCompare(b));
  const mine = me(ctx);
  const body = html`<div class="ui-form hp-clientform">
<label class="ui-field"><span class="ui-label">Client name</span><input class="ui-input" name="name" type="text" maxlength="60" autocomplete="off" required aria-describedby="hp-cf-err"></label>
<label class="ui-field"><span class="ui-label">What they sell (optional)</span><input class="ui-input" name="what" type="text" maxlength="200" autocomplete="off" placeholder="Email marketing"></label>
<fieldset class="ui-fieldset"><legend class="ui-label">Managers</legend><div class="hp-checks">${names.map((n) => html`<label class="ui-check"><input type="checkbox" name="managers" value="${n}"${n === mine ? html` checked` : ""}><span>${n}</span></label>`)}</div></fieldset>
<label class="ui-field"><span class="ui-label">Markets (optional)</span><input class="ui-input" name="markets" type="text" maxlength="100" autocomplete="off" placeholder="US · GB"></label>
<p class="ui-error" id="hp-cf-err" role="alert" hidden></p>
</div>`;
  const read = (el) => {
    const f = (n) => el.querySelector('[name="' + n + '"]');
    return {
      name: String(f("name").value || "").replace(/\s+/g, " ").trim(),
      what: String(f("what").value || "").replace(/\s+/g, " ").trim(),
      markets: String(f("markets").value || "").replace(/\s+/g, " ").trim(),
      managers: Array.from(el.querySelectorAll('[name="managers"]:checked')).map((x) => x.value),
    };
  };
  const m = openModal({
    title: "Add client",
    body,
    size: "sm",
    className: "hp-cf-modal",
    actions: [
      { label: "Cancel", kind: "ghost", value: null },
      {
        label: "Add client",
        kind: "primary",
        onClick: async (modal) => {
          const v = read(modal.el);
          const err = modal.el.querySelector("#hp-cf-err");
          const nameEl = modal.el.querySelector('[name="name"]');
          const fail = (msg) => {
            err.textContent = msg;
            err.hidden = false;
            nameEl.setAttribute("aria-invalid", "true");
            nameEl.focus();
            return false;
          };
          if (v.name.length < 2 || v.name.length > 60) return fail("Type the client's name (2–60 characters).");
          if (/[,/;]/.test(v.name)) return fail("A client name can't contain , / or ;.");
          const all = (ctx.meta.clients || []).concat(ctx.meta.past_clients || []);
          const dupe = all.find((c) => [c.k, c.name, c.slug].some((x) => x && compact(x) === compact(v.name)));
          if (dupe) return fail(dupe.name + " is already a client" + ((ctx.meta.past_clients || []).includes(dupe) ? " (a past one: use Make current)." : "."));
          const entry = { name: v.name };
          if (v.what) entry.what = v.what;
          entry.managers = v.managers;
          if (v.markets) entry.markets = v.markets;
          const ok = await save("clients", { clients: storedClients().concat([entry]) }, {
            focus: "addclient",
            message: v.name + " was added. Everyone sees it on their next page load.",
          });
          if (!ok) {
            const e2 = st && st.set.err && st.set.err.clients;
            if (e2) return fail(e2);
          }
          return ok ? undefined : false;
        },
      },
    ],
    canClose: async () => {
      const v = read(m.el);
      if (!v.name && !v.what && !v.markets) return true;
      return confirm({ title: "Discard this client?", body: "What you typed will be lost.", confirmLabel: "Discard", cancelLabel: "Keep editing", danger: true });
    },
  });
  // Typing again clears the last error.
  on(m.el, "input", '[name="name"]', (e, input) => {
    if (input.getAttribute("aria-invalid") !== "true") return;
    input.removeAttribute("aria-invalid");
    const err = m.el.querySelector("#hp-cf-err");
    if (err) err.hidden = true;
  });
  return m.result;
}

async function setDnc(box) {
  const want = !!box.checked;
  if (want) {
    const ok = await confirm({
      title: "Allow “Do not contact”?",
      body: DNC_HELP + " Once on, everyone can pick it in the stage menus.",
      confirmLabel: "Turn on",
    });
    if (!ok) {
      box.checked = false;
      return;
    }
  }
  save("dnc", { allow_dnc: want }, {
    focus: "dnc",
    message: (want ? "“Do not contact” is on." : "“Do not contact” is off.") + " Everyone sees it on their next page load.",
    undo: () => save("dnc", { allow_dnc: !want }, { focus: "dnc" }),
  });
}

// ---------- actions ----------

async function changeName(btn) {
  try {
    const picked = await openMePicker(btn);
    if (typeof picked === "string" && picked && picked !== me(st.ctx)) st.ctx.me.set(picked);
  } catch (e) { /* closed */ }
}

async function reportProblem() {
  const text = errorDetails();
  const ok = await copyText(text);
  if (ok) {
    toast("Copied. Paste it into a message to Jonas.", { kind: "success" });
    return;
  }
  openModal({
    title: "Problem details",
    description: "Copy this text and paste it into a message to Jonas.",
    body: html`<textarea class="ui-input hp-report" readonly rows="9" aria-label="Problem details">${text}</textarea>`,
    actions: [{ label: "Close", kind: "primary" }],
  });
}

function goSettings() {
  const sec = st.root.querySelector("[data-hp-settings]");
  if (!sec) return;
  sec.scrollIntoView({ block: "start", behavior: "smooth" });
  const h = sec.querySelector("#hp-set-h");
  if (h) h.focus({ preventScroll: true });
}

function bind() {
  const root = st.root;
  st.offs.push(on(root, "click", "[data-hp-act]", (e, b) => {
    const a = b.getAttribute("data-hp-act");
    if (a === "whatsnew") openWhatsNew();
    else if (a === "report") reportProblem();
    else if (a === "me") changeName(b);
    else if (a === "settings") goSettings();
    else if (a === "reload-settings") loadSettings();
  }));
  st.offs.push(on(root, "change", "[data-hp-home]", (e, sel) => setHome(sel.getAttribute("data-hp-home"), sel.value)));
  st.offs.push(on(root, "click", "[data-hp-remove]", (e, b) => removePerson(b.getAttribute("data-hp-remove"))));
  st.offs.push(on(root, "click", "[data-hp-addback]", (e, b) => addBack(b.getAttribute("data-hp-addback"))));
  st.offs.push(on(root, "submit", "[data-hp-addperson]", (e, f) => {
    e.preventDefault();
    addPerson(f);
  }));
  st.offs.push(on(root, "input", "[data-hp-addperson] input", (e, i) => {
    if (i.getAttribute("aria-invalid") === "true") {
      i.removeAttribute("aria-invalid");
      const err = root.querySelector('[data-hp-err="team"]');
      if (err) err.hidden = true;
    }
  }));
  st.offs.push(on(root, "click", "[data-hp-past]", (e, b) => setClientPast(b.getAttribute("data-hp-past"), true)));
  st.offs.push(on(root, "click", "[data-hp-current]", (e, b) => setClientPast(b.getAttribute("data-hp-current"), false)));
  st.offs.push(on(root, "click", "[data-hp-addclient]", () => addClientForm()));
  st.offs.push(on(root, "change", "[data-hp-dnc]", (e, box) => setDnc(box)));
}

export default {
  id: "help",
  title,
  mount(root, ctx) {
    if (st) this.unmount();
    st = { root, ctx, offs: [], set: { state: "idle", data: null, busy: null, err: {}, error: "" }, admin: isAdmin(ctx) };
    render(root, pageHtml(ctx));
    bind();
    if (st.admin) loadSettings();
  },
  update(ctx, change) {
    if (!st) return;
    st.ctx = ctx;
    const kind = change && change.kind;
    if (kind === "meta" || kind === "me") {
      const admin = isAdmin(ctx);
      draw();
      if (admin && !st.admin) loadSettings();
      st.admin = admin;
    }
  },
  unmount() {
    if (!st) return;
    for (const off of st.offs) {
      try { off(); } catch (e) { /* already gone */ }
    }
    st = null;
  },
};
