// Phone layouts and accessibility (spec 4.12, 4.13, 3; test T27 and the keyboard side of F1-F9). Owner G3-3.
// Run: bash tests/e2e/run.sh tests/e2e/95-mobile-a11y.test.mjs   (screenshots: SHOTS_DIR, default /tmp/shots-g33)
//
// 1. The sweep, one test per width (320, 390, 820, 1440), each in light and dark: every route (Today, the
//    four Sites tabs, Deals, Clients, a client page, Team overview with its charts open, Edit history,
//    Help) and every layer (Search with results, Add site, a deal's record panel, the report, the More
//    sheet, the filters, a row menu). On each: axe-core with 0 serious or critical issues on the whole
//    document; no sideways page scroll; no text cut off by an overflow box (an ellipsis or a line clamp is
//    deliberate and allowed); no word broken across lines; no text over other text; and on the touch
//    widths (320/390/820 emulate a touch screen) 44 x 44 px targets and inputs of at least 16 px (spec
//    4.12). A viewport screenshot of each view goes to SHOTS_DIR.
//    Touch target exceptions (WCAG 2.5.8): a link inside a sentence, and the Test badge (a tooltip, not
//    an action). A checkbox's target is its label; a stretched link's target is the box it covers.
// 2. Keyboard only: the test presses keys and never clicks or calls element.focus(). The skip link; the
//    h1 focus and the announcement on a route change; a visible focus indicator on every Tab stop (an
//    outline or box-shadow on the element, an outline on an ancestor that holds the focus, or the caret
//    of a text field), never hidden under the top bar or the bottom tabs; Esc closes every dialog, sheet
//    and menu and focus returns to what opened it; and the flows F1-F9 of spec 3.
// 3. T27 on a phone (390 and 320): bottom tabs, cards, the full-screen panel with its sticky footer, the
//    More sheet, and Sign out clicked (the session cookie and the cached list are gone afterwards).
//
// Writes (F1, F2, F3, F4, F7, F9): before() keeps the full rows of the sites they touch; after() puts them
// back and deletes the contacts and activity rows they added, the site F4 added, the edits rows written
// since before() and the kv marks a write moves (as 70-search-add does).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { baseUrl, signedInPage, closeBrowser, d1, fixture, tools, maxEditN, applyBefore } from "./lib.mjs";

const BASE = baseUrl();
const SHOTS = process.env.SHOTS_DIR || "/tmp/shots-g33";
const fx = fixture();
const K = fx.intended.Kamile;
const DESKTOP = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };
const TOUCH = { hasTouch: true, isMobile: true };
const CLIP = { permissions: ["clipboard-read", "clipboard-write"] };
const P = "#layer-panel ";
const PROS = '[data-block="prospects"]';
const ADDED = "Added. It reaches the Google Sheet on the next weekday morning.";
const MENU_OPEN = ".ui-menu:popover-open, .ui-pop:popover-open";

const one = (tag) => {
  const ids = fx.groups[tag];
  assert.ok(ids && ids.length, "fixture group " + tag);
  return ids[0];
};
const site = (id) => {
  const p = fx.partners.find((x) => x.id === id);
  assert.ok(p, "fixture site " + id);
  return p;
};

// The sites the flows use.
const ID = {
  queueFirst: K.doNow.overdue[0], // F1: the first site of Kamile's Do now (Active: no follow-up button)
  queueSecond: K.doNow.overdue[1], // F1: the second, Contacted: J moves to it, then Sent a follow-up
  reply: K.doNow.reply[1], // F2: a Replied site of Kamile's
  pill: fx.groups["kamile-new"][19], // F3: a New site of Kamile's
  owned: one("gaby-contacted"), // F4 and F5: a known site owned by someone else
  deal: one("J-neg-1"), // F7: a Negotiating Soro deal with terms
  prospect: K.newProspects.newIds[0], // F9: a new prospect without a contact
};
// A person at the deal's site, for the contact page (Tomas, 2026-10-23).
const CONTACT = (fx.contacts.find((c) => c.account_id === ID.deal) || fx.contacts[0]).id;
const TOUCHED = [ID.queueSecond, ID.reply, ID.pill, ID.deal, ID.prospect];
const F4_DOMAIN = "f4-keyboard.example.test";
const KV_KEYS = ["new_site_n", "sheet_sig", "last_sheet_change"];

let rows0 = {}; // id -> the full partners row before the tests
let contacts0 = [];
let activity0 = 0;
let edits0 = 0;
let newIds0 = [];
let kv0 = [];
let hasKv = false;
let axeSrc = "";

// ---------- helpers ----------

async function retry(fn, tries = 6) {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (e) {
      if (i >= tries || !/SQLITE_BUSY|database is locked/i.test(String(e && e.message))) throw e;
      await new Promise((r) => setTimeout(r, 400 * (i + 1)));
    }
  }
}
const q = (v) => (v == null ? "NULL" : "'" + String(v).replace(/'/g, "''") + "'");
const inList = (ids) => "(" + ids.map(q).join(",") + ")";

async function waitFor(fn, what, ms = 15000) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    last = await fn();
    if (last) return last;
    await new Promise((r) => setTimeout(r, 250));
  }
  assert.fail("timed out waiting for " + what);
}

async function readFull(ids) {
  const cols = (await retry(() => d1("PRAGMA table_info(partners)"))).map((c) => c.name).filter((c) => c !== "id");
  const obj = "json_object('id', id, " + cols.map((c) => "'" + c + "', " + c).join(", ") + ")";
  const rows = await retry(() => d1("SELECT " + obj + " AS j FROM partners WHERE id IN " + inList(ids), { rawNulls: true }));
  const out = {};
  for (const r of rows) {
    const o = JSON.parse(r.j);
    const id = o.id;
    delete o.id;
    out[id] = o;
  }
  return out;
}
const column = async (id, col) => ((await retry(() => d1("SELECT " + col + " AS v FROM partners WHERE id = " + q(id))))[0] || {}).v;

// The route has rendered: main not busy, no visible skeleton, no finite animation running.
async function settle(page) {
  await page.waitForFunction(() => {
    const m = document.querySelector("main");
    if (!m || m.getAttribute("aria-busy") === "true") return false;
    const sk = document.querySelectorAll("main .ui-skeleton, dialog[open] .ui-skeleton, #layer-panel .ui-skeleton");
    if (Array.from(sk).some((e) => e.getClientRects().length)) return false;
    return document.getAnimations().every((a) => a.playState !== "running" || (a.effect && a.effect.getComputedTiming().iterations === Infinity));
  }, null, { timeout: 20000 });
  await page.waitForTimeout(250);
}

// The viewport only: a full-page screenshot resets the touch emulation of the context.
const shot = (page, name) => page.screenshot({ path: path.join(SHOTS, name + ".png") });

async function openPage({ name = "Kamile", viewport = DESKTOP, colorScheme = "light", hash = "#today", contextOptions = {} } = {}) {
  const touch = viewport.width < 1024;
  const s = await signedInPage({ name, viewport, colorScheme, contextOptions: { ...(touch ? TOUCH : {}), ...contextOptions } });
  await s.page.goto(BASE + "/" + hash);
  await s.page.waitForSelector("main h1", { timeout: 20000 });
  await settle(s.page);
  return s;
}

async function go(page, hash) {
  await page.goto("about:blank");
  await page.goto(BASE + "/" + hash);
  await page.waitForSelector("main h1", { timeout: 20000 });
  await settle(page);
}

async function toastWith(page, text) {
  const t = page.locator("#toasts .ui-toast", { hasText: text }).last();
  await t.waitFor({ state: "visible", timeout: 10000 });
  return t;
}

async function axe(page) {
  if (!(await page.evaluate(() => !!window.axe))) await page.evaluate(axeSrc);
  return page.evaluate(async () => {
    const r = await window.axe.run(document, { resultTypes: ["violations"] });
    return r.violations.filter((v) => v.impact === "serious" || v.impact === "critical")
      .map((v) => v.id + ": " + v.help + " -> " + v.nodes.slice(0, 4).map((n) => n.target.join(" ")).join(" | "));
  });
}

// ---------- in-page probes ----------

// Layout checks of one view (runs in the page): {hscroll, clipped, broken, overlaps, small, smallText}.
const PROBE = ({ width, touch }) => {
  const out = { hscroll: Math.max(0, document.documentElement.scrollWidth - width, innerWidth - width), clipped: [], broken: [], overlaps: [], small: [], smallText: [] };
  const cssOf = (e) => getComputedStyle(e);
  const hiddenBySelf = (e, cs) => cs.display === "none" || cs.visibility === "hidden" || cs.visibility === "collapse" ||
    Number(cs.opacity) === 0 || (cs.clip && cs.clip !== "auto") || /inset\((49|50|100)%/.test(cs.clipPath || "") ||
    e.classList.contains("sr-only");
  const shown = (el) => {
    for (let e = el; e && e.nodeType === 1; e = e.parentElement) if (hiddenBySelf(e, cssOf(e))) return false;
    return true;
  };
  const name = (el) => {
    const own = el.tagName.toLowerCase() + (el.classList.length ? "." + Array.from(el.classList).slice(0, 2).join(".") : "");
    const p = el.parentElement;
    return (p ? p.tagName.toLowerCase() + (p.classList.length ? "." + p.classList[0] : "") + " > " : "") + own;
  };
  // The layer a node paints in: a fixed or sticky box, an open dialog or popover, or the page.
  const layerOf = (el) => {
    for (let e = el; e; e = e.parentElement) {
      const cs = cssOf(e);
      if (cs.position === "fixed" || cs.position === "sticky") return e;
      if ((e.tagName === "DIALOG" && e.open) || (e.matches && e.matches(":popover-open"))) return e;
    }
    return document.body;
  };
  const cut = (r, c) => ({ left: Math.max(r.left, c.left), right: Math.min(r.right, c.right), top: Math.max(r.top, c.top), bottom: Math.min(r.bottom, c.bottom) });
  const area = (r) => Math.max(0, r.right - r.left) * Math.max(0, r.bottom - r.top);
  const texts = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const t = n.textContent;
    if (!t.trim()) continue;
    const el = n.parentElement;
    if (!el || /^(SCRIPT|STYLE|TEMPLATE|OPTION|NOSCRIPT)$/.test(el.tagName) || !shown(el)) continue;
    const range = document.createRange();
    range.selectNodeContents(n);
    let rects = Array.from(range.getClientRects()).filter((r) => r.width > 0.5 && r.height > 0.5);
    if (!rects.length) continue;
    // Clip boxes up to the layer: overflow hidden or clip may cut text off (an ellipsis or a line clamp is
    // a deliberate cut); auto and scroll only hide what is scrolled away.
    let partlyCut = null;
    for (let a = el; a && a !== document.body; a = a.parentElement) {
      const cs = cssOf(a);
      const ox = cs.overflowX, oy = cs.overflowY;
      if (ox !== "visible" || oy !== "visible") {
        const ar = a.getBoundingClientRect();
        const box = { left: ox === "visible" ? -1e9 : ar.left, right: ox === "visible" ? 1e9 : ar.right, top: oy === "visible" ? -1e9 : ar.top, bottom: oy === "visible" ? 1e9 : ar.bottom };
        const before = rects.reduce((s, r) => s + area(r), 0);
        const kept = rects.map((r) => cut(r, box)).filter((r) => r.right - r.left > 0.5 && r.bottom - r.top > 0.5);
        const after = kept.reduce((s, r) => s + area(r), 0);
        const scroller = /auto|scroll/.test(ox) || /auto|scroll/.test(oy);
        const deliberate = cssOf(el).textOverflow === "ellipsis" || cs.textOverflow === "ellipsis" || (cs.webkitLineClamp && cs.webkitLineClamp !== "none");
        if (!scroller && !deliberate && after > 0 && after < before - 2 && !partlyCut) partlyCut = name(a);
        rects = kept;
        if (!rects.length) break;
      }
      if (layerOf(a) === a) break;
    }
    if (!rects.length) continue;
    if (partlyCut) out.clipped.push({ text: t.trim().slice(0, 50), el: name(el), by: partlyCut });
    texts.push({ n, el, rects, layer: layerOf(el) });
    // A word broken across lines (letters only: domains, emails and links may break anywhere by design).
    if (rects.length > 1 && cssOf(el).overflowWrap !== "anywhere" && cssOf(el).wordBreak !== "break-all") {
      const re = /[A-Za-zÀ-ž’']{2,}/g;
      let m;
      while ((m = re.exec(t))) {
        const b = t[m.index - 1], a = t[m.index + m[0].length];
        if ((b && !/[\s(“"]/.test(b)) || (a && !/[\s.,:;!?)”"…·]/.test(a))) continue;
        const wr = document.createRange();
        wr.setStart(n, m.index);
        wr.setEnd(n, m.index + m[0].length);
        const tops = new Set(Array.from(wr.getClientRects()).filter((r) => r.width > 0.5).map((r) => Math.round(r.top)));
        if (tops.size > 1) out.broken.push({ word: m[0], el: name(el) });
      }
    }
  }
  // Text over text in the same layer.
  const items = [];
  for (const x of texts) for (const r of x.rects) items.push({ x, r });
  items.sort((a, b) => a.r.top - b.r.top);
  const seen = new Set();
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      const A = items[i], B = items[j];
      if (B.r.top >= A.r.bottom - 2) break;
      if (A.x === B.x || A.x.layer !== B.x.layer) continue;
      const w = Math.min(A.r.right, B.r.right) - Math.max(A.r.left, B.r.left);
      const h = Math.min(A.r.bottom, B.r.bottom) - Math.max(A.r.top, B.r.top);
      if (w > 2 && h > 3) {
        const k = name(A.x.el) + " / " + name(B.x.el);
        if (seen.has(k)) continue;
        seen.add(k);
        out.overlaps.push({ a: A.x.n.textContent.trim().slice(0, 30), b: B.x.n.textContent.trim().slice(0, 30), where: k });
      }
    }
  }
  if (touch) {
    // 44 x 44 px targets on a touch screen (spec 4.1, 4.12).
    const sel = "a[href], button, input:not([type=hidden]), select, textarea, summary, [role=button], [tabindex='0'], label.ui-selbox";
    for (const el of document.querySelectorAll(sel)) {
      if (!shown(el) || el.closest("[inert]") || el.disabled) continue;
      if (el.matches(".sh-test")) continue; // the Test badge: a tooltip, not an action
      let box = el;
      if (el.matches("input[type=checkbox], input[type=radio]") && el.closest("label")) box = el.closest("label");
      const aft = getComputedStyle(el, "::after");
      if (aft.content !== "none" && aft.position === "absolute") box = cssOf(el).position !== "static" ? el : (el.offsetParent || el);
      const r = box.getBoundingClientRect();
      if (r.width < 0.5 || r.height < 0.5) continue;
      if (r.bottom < 0 && el.matches(".sh-skip")) continue; // off screen until focused
      const inline = el.tagName === "A" && cssOf(el).display === "inline" && el.parentElement &&
        el.parentElement.textContent.replace(/\s+/g, " ").trim().length > el.textContent.trim().length + 2;
      if (inline) continue;
      if (r.width < 43.5 || r.height < 43.5) {
        out.small.push({ el: name(box), text: (el.getAttribute("aria-label") || el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 30), w: Math.round(r.width), h: Math.round(r.height) });
      }
    }
    // Inputs of at least 16 px, so iOS Safari doesn't zoom in on focus.
    for (const el of document.querySelectorAll("input:not([type=hidden]):not([type=checkbox]):not([type=radio]), select, textarea")) {
      if (!shown(el) || el.closest("[inert]")) continue;
      const px = parseFloat(cssOf(el).fontSize);
      if (px < 16) out.smallText.push({ el: name(el), px });
    }
  }
  return out;
};

// Does the focused element show its focus? (runs in the page)
const FOCUS_SHOWN = () => {
  const el = document.activeElement;
  if (!el || el === document.body || el === document.documentElement) return { ok: false, what: "nothing", why: "nothing has focus" };
  const what = el.tagName.toLowerCase() + (typeof el.className === "string" && el.className.trim() ? "." + el.className.trim().split(/\s+/).slice(0, 2).join(".") : "") +
    " '" + (el.getAttribute("aria-label") || el.textContent || el.value || "").replace(/\s+/g, " ").trim().slice(0, 30) + "'";
  const ring = (e, pseudo) => {
    const cs = getComputedStyle(e, pseudo);
    const outline = cs.outlineStyle !== "none" && parseFloat(cs.outlineWidth) >= 1 && !/transparent|rgba\([^)]*,\s*0\)/.test(cs.outlineColor);
    return outline || (!!cs.boxShadow && cs.boxShadow !== "none");
  };
  if (ring(el)) return { ok: true, what, how: "own" };
  // A text field shows its caret.
  if (el.matches("textarea, input:not([type]), input[type=text], input[type=search], input[type=email], input[type=url], input[type=tel], input[type=number], [contenteditable=true]")) return { ok: true, what, how: "caret" };
  for (let p = el.parentElement, i = 0; p && i < 4; p = p.parentElement, i++) {
    const cs = getComputedStyle(p);
    if (p.matches(":focus-within") && cs.outlineStyle !== "none" && parseFloat(cs.outlineWidth) >= 1) return { ok: true, what, how: "ancestor" };
  }
  return { ok: false, what, why: "no outline or box-shadow on it, and no outline on an ancestor" };
};

// Is the focused element on screen and not under a fixed or sticky bar? (runs in the page)
const FOCUS_IN_VIEW = () => {
  const el = document.activeElement;
  if (!el || el === document.body) return { ok: false, why: "nothing has focus" };
  const r = el.getBoundingClientRect();
  if (r.width < 1 && r.height < 1) return { ok: true };
  if (r.bottom <= 0 || r.top >= innerHeight || r.right <= 0 || r.left >= innerWidth) return { ok: false, why: "off screen at " + Math.round(r.left) + "," + Math.round(r.top) };
  const x = Math.min(Math.max(r.left + r.width / 2, 1), innerWidth - 1);
  const y = Math.min(Math.max(r.top + Math.min(r.height / 2, 12), 1), innerHeight - 1);
  const hit = document.elementFromPoint(x, y);
  if (!hit || hit === el || el.contains(hit) || hit.contains(el)) return { ok: true };
  if (el.labels && Array.from(el.labels).some((l) => l.contains(hit))) return { ok: true };
  for (let e = hit; e && e !== document.body; e = e.parentElement) {
    if (e.contains(el)) return { ok: true };
    const pos = getComputedStyle(e).position;
    if (pos === "fixed" || pos === "sticky") return { ok: false, why: "under " + e.tagName.toLowerCase() + "." + String(e.className || "").split(" ")[0] };
  }
  return { ok: true };
};

async function focusShown(page, where) {
  const r = await page.evaluate(FOCUS_SHOWN);
  assert.ok(r.ok, where + ": visible focus on " + r.what + " (" + (r.why || "") + ")");
  const v = await page.evaluate(FOCUS_IN_VIEW);
  assert.ok(v.ok, where + ": the focused " + r.what + " is in view (" + (v.why || "") + ")");
  return r;
}

const active = (page) => page.evaluate(() => {
  const el = document.activeElement;
  if (!el) return "";
  const cls = typeof el.className === "string" && el.className.trim() ? "." + el.className.trim().split(/\s+/).join(".") : "";
  return el.tagName.toLowerCase() + (el.id ? "#" + el.id : "") + cls + " '" + (el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 30) + "'";
});
const isActive = (page, sel, text) => page.evaluate(([s, t]) => {
  const el = document.activeElement;
  return !!el && el.matches(s) && (t == null || el.textContent.replace(/\s+/g, " ").trim() === t);
}, [sel, text == null ? null : text]);

// Presses Tab (or Shift+Tab) until the focused element matches sel (and has the text, when given); fails
// after max presses. Returns the number of presses (0 when it already has focus).
async function tabTo(page, sel, { text, max = 120, back = false, where = "" } = {}) {
  if (await isActive(page, sel, text)) return 0;
  for (let i = 1; i <= max; i++) {
    await page.keyboard.press(back ? "Shift+Tab" : "Tab");
    if (await isActive(page, sel, text)) return i;
  }
  assert.fail((where ? where + ": " : "") + "Tab never reached " + sel + (text ? " '" + text + "'" : "") + " (focus is on " + (await active(page)) + ")");
}

// The arrow keys in an open menu until the focused item's text starts with `label`, then Enter.
async function menuPick(page, label) {
  for (let i = 0; i < 16; i++) {
    const t = await page.evaluate(() => (document.activeElement ? document.activeElement.textContent.replace(/\s+/g, " ").trim() : ""));
    if (t.startsWith(label)) {
      await page.keyboard.press("Enter");
      return;
    }
    await page.keyboard.press("ArrowDown");
  }
  assert.fail("the arrow keys never reached the menu item " + label);
}

// ---------- setup / teardown ----------

before(async () => {
  assert.ok(BASE, "BASE_URL is set (run through tests/e2e/run.sh)");
  assert.ok(!/:8788\b/.test(BASE), "never the main dev server");
  fs.mkdirSync(SHOTS, { recursive: true });
  axeSrc = fs.readFileSync(tools().axe, "utf8");
  rows0 = await readFull(TOUCHED);
  for (const id of TOUCHED) assert.ok(rows0[id], "fixture row " + id);
  contacts0 = (await retry(() => d1("SELECT id FROM contacts WHERE account_id IN " + inList(TOUCHED)))).map((r) => r.id);
  activity0 = Number((await retry(() => d1("SELECT COALESCE(MAX(n), 0) AS n FROM activity")))[0].n);
  edits0 = Number(await retry(() => maxEditN()));
  newIds0 = (await retry(() => d1("SELECT id FROM partners WHERE id LIKE 'NEW-%'"))).map((r) => r.id);
  hasKv = (await retry(() => d1("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'kv_meta'"))).length > 0;
  if (hasKv) kv0 = await retry(() => d1("SELECT k, v, at, by_whom FROM kv_meta WHERE k IN " + inList(KV_KEYS), { rawNulls: true }));
});

after(async () => {
  try {
    await retry(() => d1("DELETE FROM contacts WHERE account_id IN " + inList(TOUCHED) + (contacts0.length ? " AND id NOT IN " + inList(contacts0) : "")));
    await retry(() => d1("DELETE FROM activity WHERE n > " + activity0));
    await retry(() => applyBefore(rows0));
    const added = (await retry(() => d1("SELECT id FROM partners WHERE id LIKE 'NEW-%'" + (newIds0.length ? " AND id NOT IN " + inList(newIds0) : "")))).map((r) => r.id);
    if (added.length) {
      await retry(() => d1("DELETE FROM contacts WHERE account_id IN " + inList(added)));
      await retry(() => d1("DELETE FROM partners WHERE id IN " + inList(added)));
    }
    await retry(() => d1("DELETE FROM edits WHERE n > " + edits0));
    if (hasKv) {
      await retry(() => d1("DELETE FROM kv_meta WHERE k IN " + inList(KV_KEYS)));
      for (const r of kv0) await retry(() => d1("INSERT INTO kv_meta (k, v, at, by_whom) VALUES (" + [r.k, r.v, r.at, r.by_whom].map(q).join(", ") + ")"));
    }
  } finally {
    await closeBrowser();
  }
});

// ---------- 1. The sweep ----------

// Every route and layer. open: what to do once the route has rendered; only: the widths it exists at.
const VIEWS = [
  { id: "today", hash: "#today" },
  { id: "sites-mine", hash: "#sites?tab=mine" },
  { id: "sites-unowned", hash: "#sites?tab=unowned" },
  { id: "sites-waiting", hash: "#sites?tab=waiting" },
  { id: "sites-all", hash: "#sites?tab=all" },
  { id: "deals", hash: "#deals" },
  { id: "clients", hash: "#clients" },
  { id: "client", hash: "#clients/soro" },
  { id: "partners", hash: "#partners", open: "rows" },
  { id: "contacts", hash: "#contacts", open: "rows" },
  { id: "contact", hash: "#contact/" + CONTACT, open: "record-page" },
  { id: "team", hash: "#team", open: "charts" },
  { id: "history", hash: "#history" },
  { id: "help", hash: "#help" },
  { id: "search", hash: "#today", open: "search" },
  { id: "add", hash: "#today", open: "add" },
  { id: "panel", hash: "#deals?rec=" + ID.deal, open: "panel" },
  { id: "panel-new", hash: "#sites?tab=all&rec=" + K.newProspects.withSuggestions[4], open: "panel" },
  { id: "report", hash: "#clients", open: "report" },
  { id: "more", hash: "#today", open: "more", only: (w) => w < 1024 },
  { id: "filters", hash: "#sites?tab=all", open: "filters" },
  { id: "menu", hash: "#sites?tab=all", open: "menu" },
];

async function openLayer(page, v) {
  switch (v.open) {
    case "charts":
      await page.click("[data-tm-charts] > summary");
      await page.waitForSelector("[data-tm-charts][open] .ui-bars");
      await page.evaluate(() => document.querySelector("[data-tm-charts]").scrollIntoView());
      return;
    case "search":
      await page.keyboard.press("Control+k");
      await page.waitForSelector(".se-dialog[open]");
      await page.fill(".se-input", "example");
      await page.waitForSelector(".se-dialog .se-row");
      return;
    case "add":
      await page.keyboard.press("n");
      await page.waitForSelector(".se-addmodal[open]");
      return;
    case "panel":
      await page.waitForSelector(P + ".ui-panel[data-panel]");
      return;
    case "rows":
      await page.waitForSelector("main .pt-list tbody tr");
      return;
    case "record-page":
      await page.waitForSelector("main .rv-cols");
      return;
    case "report":
      await page.click('[data-cl-report="soro"]');
      await page.waitForSelector(".rp-modal[open] .rp-doc");
      return;
    case "more":
      await page.click("[data-more]");
      await page.waitForSelector(".sh-more[open]");
      return;
    case "filters": {
      const sheet = page.locator("main [data-fsheet]:visible");
      if (await sheet.count()) {
        await sheet.first().click();
        await page.waitForSelector("dialog.is-sheet[open]");
      } else {
        await page.locator("main [data-ffield]:visible").first().click();
        await page.waitForSelector(MENU_OPEN);
      }
      return;
    }
    case "menu": {
      const more = page.locator("main .ui-row-more:visible");
      if (await more.count()) await more.first().click();
      else await page.locator('main [data-edit="stage"]:visible').first().click();
      await page.waitForSelector(MENU_OPEN);
      return;
    }
    default:
  }
}

async function sweep(width) {
  const touch = width < 1024;
  const height = width < 640 ? 760 : width < 1024 ? 1100 : 900;
  const problems = [];
  for (const colorScheme of ["light", "dark"]) {
    const s = await signedInPage({ name: "Kamile", viewport: { width, height }, colorScheme, contextOptions: touch ? TOUCH : {} });
    try {
      for (const v of VIEWS) {
        if (v.only && !v.only(width)) continue;
        const key = v.id + "-" + width + "-" + colorScheme;
        await go(s.page, v.hash);
        if (v.open) {
          await openLayer(s.page, v);
          await settle(s.page);
        }
        const r = await s.page.evaluate(PROBE, { width, touch });
        const ax = await axe(s.page);
        await shot(s.page, key);
        const say = (what, list) => { if (list.length) problems.push(key + " " + what + ": " + JSON.stringify(list.slice(0, 6))); };
        if (r.hscroll > 0) problems.push(key + " scrolls sideways by " + r.hscroll + " px");
        say("axe", ax);
        say("text cut off", r.clipped);
        say("word broken across lines", r.broken);
        say("text over text", r.overlaps);
        say("touch targets under 44 px", r.small);
        say("inputs under 16 px", r.smallText);
      }
      assert.deepEqual(s.watch.pageErrors, [], width + " " + colorScheme + ": no page errors");
    } finally {
      await s.close();
    }
  }
  assert.deepEqual(problems, [], width + " px: every route and layer, light and dark");
}

for (const w of [320, 390, 820, 1440]) {
  test("Sweep at " + w + " px, light and dark: axe, no sideways scroll, no cut, broken or overlapping text" +
    (w < 1024 ? ", 44 px targets, 16 px inputs" : ""), async () => {
    await sweep(w);
  });
}

// ---------- 2. Keyboard ----------

test("Skip link: the first Tab shows it and Enter moves focus to the main content (1440 and 390)", async () => {
  for (const viewport of [DESKTOP, PHONE]) {
    const { page, close } = await openPage({ viewport });
    try {
      await page.keyboard.press("Tab");
      assert.ok(await isActive(page, "a.sh-skip"), viewport.width + ": the first Tab stop is the skip link");
      const r = await page.$eval("a.sh-skip", (a) => { const b = a.getBoundingClientRect(); return { top: b.top, h: b.height, text: a.textContent.trim() }; });
      assert.ok(r.top >= 0 && r.h > 0, viewport.width + ": the skip link is on screen when focused (" + JSON.stringify(r) + ")");
      assert.equal(r.text, "Skip to main content");
      await focusShown(page, viewport.width + " skip link");
      await page.keyboard.press("Enter");
      assert.ok(await isActive(page, "main#main"), viewport.width + ": Enter focuses #main");
      await page.keyboard.press("Tab");
      assert.ok(await page.evaluate(() => document.querySelector("main").contains(document.activeElement)), viewport.width + ": the next Tab stop is inside main");
    } finally {
      await close();
    }
  }
});

// From the page's h1, Shift+Tab goes back through the top bar to the sidebar (desktop) or wraps around to
// the bottom tabs (phone).
async function enterRoute(page, link, h1, where) {
  await tabTo(page, link, { where, back: true });
  await focusShown(page, where + " link");
  await page.keyboard.press("Enter");
  await page.waitForFunction((t) => document.activeElement && document.activeElement.matches("main h1") && document.activeElement.textContent.trim() === t, h1, { timeout: 15000 })
    .catch(async () => assert.fail(where + ": the h1 '" + h1 + "' gets focus (focus is on " + (await active(page)) + ")"));
  await page.waitForFunction(() => document.querySelector("[data-announce]").textContent.trim() !== "");
  const said = await page.$eval("[data-announce]", (e) => e.textContent.trim());
  await settle(page);
  return said;
}

test("Route change by keyboard: the page h1 gets focus and a polite announcement (sidebar at 1440, bottom tabs at 390)", async () => {
  {
    const { page, close } = await openPage();
    try {
      assert.equal(await page.$eval("[data-announce]", (e) => e.getAttribute("aria-live")), "polite");
      const routes = [["sites", "Sites", /^Sites, [\d,]+ sites?$/], ["deals", "Deals", /^Deals/], ["clients", "Clients", /^Clients/],
        ["team", "Team overview", /^Team overview/], ["history", "Edit history", /^Edit history/], ["help", "Help", /^Help/], ["today", "Today", /^Today/]];
      for (const [nav, h1, said] of routes) {
        // Edit history isn't in the sidebar: the sync line under it opens it.
        const link = nav === "history" ? ".sh-side a[data-sync]" : '.sh-side a[data-nav="' + nav + '"]';
        assert.match(await enterRoute(page, link, h1, "1440 " + nav), said, nav + ": the announcement");
      }
    } finally {
      await close();
    }
  }
  {
    const { page, close } = await openPage({ viewport: PHONE });
    try {
      for (const [nav, h1] of [["sites", "Sites"], ["deals", "Deals"], ["today", "Today"]]) {
        await enterRoute(page, '.sh-tabs a[data-nav="' + nav + '"]', h1, "390 " + nav);
      }
    } finally {
      await close();
    }
  }
});

// Tabs through up to `max` stops (or through a layer until it wraps) and checks that each one shows its
// focus and isn't hidden under a bar. With `within`, focus must stay inside that layer.
async function walk(page, where, { max = 70, within } = {}) {
  const seen = [];
  let first = null;
  for (let i = 0; i < max; i++) {
    await page.keyboard.press("Tab");
    const id = await page.evaluate(() => {
      const el = document.activeElement;
      if (!el || el === document.body) return "";
      if (!el.dataset.kbWalk) el.dataset.kbWalk = String(Math.random()).slice(2);
      return el.dataset.kbWalk;
    });
    if (!id && !within) break; // past the last stop of the page: focus goes to the browser
    if (within) assert.ok(await page.evaluate((s) => !!document.activeElement.closest(s), within), where + ": Tab stays inside " + within + " (focus is on " + (await active(page)) + ")");
    if (first === id) break; // wrapped around the layer's focus trap
    if (!first) first = id;
    const r = await focusShown(page, where + ", Tab stop " + (i + 1));
    seen.push(r.what);
  }
  return seen;
}

test("Visible focus on every Tab stop of every route (1440) and of the phone pages (390), never under a bar", async () => {
  {
    const { page, close } = await openPage();
    try {
      for (const hash of ["#today", "#sites?tab=mine", "#sites?tab=all", "#deals", "#clients", "#clients/soro", "#team", "#history", "#help"]) {
        await go(page, hash);
        let max = 70;
        if (hash === "#team") {
          // The charts too: open them with the keyboard, then start again from the top.
          await tabTo(page, "[data-tm-charts] > summary", { max: 200, where: "team charts" });
          await page.keyboard.press("Enter");
          await page.waitForSelector("[data-tm-charts][open] .ui-bars");
          await page.keyboard.press("Shift+Tab");
          max = 160;
        }
        const seen = await walk(page, "1440 " + hash, { max });
        assert.ok(seen.length >= 10, hash + ": at least 10 Tab stops");
      }
    } finally {
      await close();
    }
  }
  {
    const { page, close } = await openPage({ viewport: PHONE });
    try {
      for (const hash of ["#today", "#sites?tab=all", "#deals", "#clients/soro"]) {
        await go(page, hash);
        await walk(page, "390 " + hash, { max: 50 });
      }
    } finally {
      await close();
    }
  }
});

test("Visible focus inside every layer, and Tab stays in it: Search, Add site, panel, report, More", async () => {
  const { page, close } = await openPage();
  try {
    await page.keyboard.press("Control+k");
    await page.waitForSelector(".se-dialog[open]");
    await page.keyboard.insertText("example");
    await page.waitForSelector(".se-dialog .se-row");
    await walk(page, "Search", { within: ".se-dialog", max: 40 });
    await page.keyboard.press("Escape");
    await page.waitForSelector(".se-dialog[open]", { state: "detached" });

    await page.keyboard.press("n");
    await page.waitForSelector(".se-addmodal[open]");
    await walk(page, "Add site", { within: ".se-addmodal", max: 60 });
    await page.keyboard.press("Escape");
    await page.waitForSelector(".se-addmodal", { state: "detached" });

    await go(page, "#deals?rec=" + ID.deal);
    await page.waitForSelector(P + '.ui-panel[data-panel="' + ID.deal + '"]');
    await settle(page);
    await walk(page, "Panel", { within: "#layer-panel", max: 120 });
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => !/[?&]rec=/.test(location.hash));

    await go(page, "#clients");
    await tabTo(page, '[data-cl-report="soro"]');
    await page.keyboard.press("Enter");
    await page.waitForSelector(".rp-modal[open] .rp-doc");
    await walk(page, "Report", { within: ".rp-modal", max: 60 });
    await page.keyboard.press("Escape");
    await page.waitForSelector(".rp-modal[open]", { state: "detached" });

    await go(page, "#help");
    await tabTo(page, '[data-hp-act="whatsnew"]');
    await page.keyboard.press("Enter");
    await page.waitForSelector("dialog.ui-modal[open]");
    await walk(page, "What's new", { within: "dialog.ui-modal[open]", max: 30 });
    await page.keyboard.press("Escape");
  } finally {
    await close();
  }
  const s = await openPage({ viewport: PHONE });
  try {
    await tabTo(s.page, "[data-more]");
    await s.page.keyboard.press("Enter");
    await s.page.waitForSelector(".sh-more[open]");
    await walk(s.page, "More", { within: ".sh-more", max: 30 });
    await tabTo(s.page, '.sh-more [data-act="me"]');
    await s.page.keyboard.press("Enter");
    await s.page.waitForSelector(".ui-modal[open]");
    await walk(s.page, "Me picker", { within: ".ui-modal[open]", max: 30 });
    await s.page.keyboard.press("Escape");
    await s.page.waitForSelector(".ui-modal[open]", { state: "detached" });
  } finally {
    await s.close();
  }
});

// Opens a layer with Enter on `opener` (reached with Tab), presses Esc, and checks that the layer closed
// and focus is back on the opener, visibly.
async function escReturns(page, { name, opener, open, closed, back = false }) {
  await tabTo(page, opener, { where: name, back });
  await page.keyboard.press("Enter");
  await page.waitForSelector(open, { timeout: 10000 }).catch(() => assert.fail(name + ": Enter on " + opener + " opens " + open));
  await page.waitForTimeout(150);
  assert.ok(!(await isActive(page, opener)), name + ": focus moved into the layer");
  await page.keyboard.press("Escape");
  if (closed) await page.waitForFunction(closed, null, { timeout: 10000 });
  else await page.waitForSelector(open, { state: "detached", timeout: 10000 });
  await page.waitForFunction((s) => document.activeElement && document.activeElement.matches(s), opener, { timeout: 5000 })
    .catch(async () => assert.fail(name + ": focus returns to " + opener + " (it is on " + (await active(page)) + ")"));
  await focusShown(page, name + ": the opener after Esc");
}

const menuClosed = () => !document.querySelector(".ui-menu:popover-open, .ui-pop:popover-open");
const panelClosed = () => !/[?&]rec=/.test(location.hash) && !document.querySelector("#layer-panel .ui-panel");
const noDialog = () => !document.querySelector("dialog[open]");

test("Esc closes every dialog and menu and focus returns to what opened it (1440)", async () => {
  const { page, close } = await openPage();
  try {
    await escReturns(page, { name: "Search", opener: ".sh-top .sh-search", open: ".se-dialog[open]" });
    await escReturns(page, { name: "Add site", opener: ".sh-top .sh-add", open: ".se-addmodal[open]" });
    await escReturns(page, { name: "Me picker", opener: '.sh-side [data-act="me"]', open: "dialog[open], " + MENU_OPEN,
      closed: () => !document.querySelector("dialog[open], .ui-menu:popover-open, .ui-pop:popover-open") });
    await escReturns(page, { name: "Panel from Today", opener: ".td-body a[data-open]", open: P + ".ui-panel", closed: panelClosed });

    await go(page, "#sites?tab=all");
    await escReturns(page, { name: "Stage menu", opener: '.si-list [data-edit="stage"]', open: MENU_OPEN, closed: menuClosed });
    await escReturns(page, { name: "Owner menu", opener: '.si-list [data-edit="owner"]', open: MENU_OPEN, closed: menuClosed });
    await escReturns(page, { name: "Filter menu", opener: '.si-filters [data-ffield="client"]', open: MENU_OPEN, closed: menuClosed, back: true });
    await escReturns(page, { name: "Panel from Sites", opener: ".si-list a[data-open]", open: P + ".ui-panel", closed: panelClosed });

    await go(page, "#clients");
    await escReturns(page, { name: "Report", opener: '[data-cl-report="soro"]', open: ".rp-modal[open]" });

    await go(page, "#help");
    await escReturns(page, { name: "What's new", opener: '[data-hp-act="whatsnew"]', open: "dialog[open]", closed: noDialog });

    // In the panel, Esc closes a menu first and the panel stays.
    await go(page, "#deals?rec=" + ID.deal);
    await page.waitForSelector(P + '.ui-panel[data-panel="' + ID.deal + '"]');
    await settle(page);
    await escReturns(page, { name: "Stage menu in the panel", opener: P + '[data-edit="stage"]', open: MENU_OPEN, closed: menuClosed });
    assert.ok(await page.$(P + ".ui-panel"), "the panel stays open after the menu's Esc");
  } finally {
    await close();
  }
});

test("Esc on a phone (390): More, Search, the filters sheet, a row menu, the full-screen panel", async () => {
  const { page, close } = await openPage({ viewport: PHONE });
  try {
    await escReturns(page, { name: "More", opener: "[data-more]", open: ".sh-more[open]", closed: noDialog });
    await escReturns(page, { name: "Search tab", opener: '.sh-tabs [data-act="search"]', open: ".se-dialog[open]" });
    await go(page, "#sites?tab=all");
    await escReturns(page, { name: "Filters sheet", opener: "main [data-fsheet]", open: "dialog.is-sheet[open]", closed: noDialog });
    await escReturns(page, { name: "Row menu", opener: "main .ui-row-more", open: MENU_OPEN, closed: menuClosed });
    await escReturns(page, { name: "Panel", opener: ".si-list a[data-open]", open: P + ".ui-panel", closed: panelClosed });
  } finally {
    await close();
  }
});

// ---------- F1-F9, keyboard only ----------

test("F1 by keyboard: Start opens the Do now queue, J moves on, one outcome saves and the next site opens", async () => {
  const { page, close } = await openPage();
  const queue = () => page.textContent(P + ".ui-queue-text").then((t) => t.replace(/\s+/g, " ").trim());
  try {
    await tabTo(page, "[data-td-start]", { where: "F1" });
    await focusShown(page, "F1 Start");
    await page.keyboard.press("Enter");
    await page.waitForSelector(P + '.ui-panel[data-panel="' + ID.queueFirst + '"]');
    await settle(page);
    assert.equal(await queue(), "1 of " + K.doNowCount + " · Do now");
    await page.keyboard.press("j");
    await page.waitForSelector(P + '.ui-panel[data-panel="' + ID.queueSecond + '"]');
    await settle(page);
    assert.equal(await queue(), "2 of " + K.doNowCount + " · Do now");
    await tabTo(page, P + '[data-outcome="followed_up"]', { where: "F1 outcome" });
    await focusShown(page, "F1 Sent a follow-up");
    await page.keyboard.press("Enter");
    await toastWith(page, "Follow-up");
    await page.waitForFunction((id) => { const p = document.querySelector("#layer-panel .ui-panel"); return p && p.getAttribute("data-panel") !== id; }, ID.queueSecond);
    assert.match(await queue(), /^\d+ of \d+ · Do now$/, "the next site opened");
    await waitFor(async () => (await column(ID.queueSecond, "next_due")) !== rows0[ID.queueSecond].next_due, "the follow-up date saved");
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => !document.querySelector("#layer-panel .ui-panel"));
  } finally {
    await close();
  }
});

test("F2 by keyboard: Ctrl+K, paste a link, Enter, Interested", async () => {
  const { page, close } = await openPage();
  try {
    await page.keyboard.press("Control+k");
    await page.waitForSelector(".se-dialog[open]");
    await page.keyboard.insertText("https://www." + site(ID.reply).domain + "/tech/article-123");
    await page.waitForFunction((id) => { const r = document.querySelector(".se-dialog .se-row.is-active"); return r && r.getAttribute("data-id") === id; }, ID.reply);
    await page.keyboard.press("Enter");
    await page.waitForSelector(P + '.ui-panel[data-panel="' + ID.reply + '"]');
    await settle(page);
    await tabTo(page, P + '[data-outcome="interested"]', { where: "F2" });
    await page.keyboard.press("Enter");
    await toastWith(page, "Moved to Negotiating");
    await waitFor(async () => (await column(ID.reply, "stage")) === "Negotiating", "stage Negotiating");
  } finally {
    await close();
  }
});

test("F3 by keyboard: a site's stage pill, then Contacted in its menu", async () => {
  const { page, close } = await openPage({ hash: "#sites?tab=mine" });
  try {
    await tabTo(page, ".si-filters [data-fq]", { where: "F3 list search" });
    await page.keyboard.insertText(site(ID.pill).name);
    await page.waitForFunction((id) => { const rows = document.querySelectorAll(".si-list tbody tr"); return rows.length <= 3 && !!document.querySelector('.si-list tr[data-key="' + id + '"]'); }, ID.pill);
    await tabTo(page, '.si-list tr[data-key="' + ID.pill + '"] [data-edit="stage"]', { where: "F3" });
    await focusShown(page, "F3 stage pill");
    await page.keyboard.press("Enter");
    await page.waitForSelector(MENU_OPEN);
    await menuPick(page, "Contacted");
    const t = await toastWith(page, "Contacted");
    assert.equal(await t.locator('[data-t="undo"]').count(), 1, "the toast offers Undo");
    await waitFor(async () => (await column(ID.pill, "stage")) === "Contacted", "stage Contacted");
  } finally {
    await close();
  }
});

test("F4 by keyboard: n, paste a known link (the duplicate and its owner), then a new one, a client chip, Add", async () => {
  const { page, close } = await openPage();
  try {
    await page.keyboard.press("n");
    await page.waitForSelector(".se-addmodal[open]");
    await tabTo(page, "#se-add-domain", { where: "F4" });
    await page.keyboard.insertText("https://www." + site(ID.owned).domain + "/some/post");
    await page.waitForSelector(".se-addmodal [data-dupe-box]");
    const box = (await page.textContent(".se-addmodal [data-dupe-box]")).replace(/\s+/g, " ");
    assert.match(box, /Already in the CRM/);
    assert.match(box, new RegExp("owned by " + site(ID.owned).owner), "the owner shows at once");
    await page.keyboard.press("Control+a");
    await page.keyboard.insertText("https://" + F4_DOMAIN + "/best-tools");
    await page.waitForSelector(".se-addmodal [data-dupe-box]", { state: "detached" });
    await tabTo(page, ".se-addmodal button.ui-chipbtn[aria-pressed]", { text: "Soro", where: "F4 client chip" });
    await focusShown(page, "F4 client chip");
    await page.keyboard.press("Space");
    await page.waitForFunction(() => document.activeElement.getAttribute("aria-pressed") === "true");
    await tabTo(page, ".se-addmodal .ui-modal-foot button.is-primary", { where: "F4 Add" });
    await page.keyboard.press("Enter");
    await toastWith(page, ADDED);
    await page.waitForFunction(() => /[?&]rec=NEW-\d{4}/.test(location.hash));
    const id = /rec=(NEW-\d{4})/.exec(await page.evaluate(() => location.hash))[1];
    const row = (await retry(() => d1("SELECT domain, clients FROM partners WHERE id = " + q(id))))[0];
    assert.deepEqual({ ...row }, { domain: F4_DOMAIN, clients: "Soro" });
  } finally {
    await close();
  }
});

test("F5 by keyboard: Ctrl+K and a pasted link show the site's owner in the result row; Esc closes", async () => {
  const { page, close } = await openPage();
  try {
    await page.keyboard.press("Control+k");
    await page.waitForSelector(".se-dialog[open]");
    await page.keyboard.insertText("https://" + site(ID.owned).domain + "/");
    await page.waitForFunction((id) => { const r = document.querySelector(".se-dialog .se-row.is-active"); return r && r.getAttribute("data-id") === id; }, ID.owned);
    const owner = await page.$eval(".se-dialog .se-row.is-active .se-owner", (o) => o.innerText.replace(/\s+/g, " ").trim());
    assert.match(owner, new RegExp(site(ID.owned).owner + "$"));
    await page.keyboard.press("Escape");
    await page.waitForSelector(".se-dialog[open]", { state: "detached" });
  } finally {
    await close();
  }
});

test("F6 by keyboard: Team overview, its charts, a bar's link (visible focus, nothing focusable under aria-hidden) opens Sites", async () => {
  const { page, close } = await openPage();
  try {
    await enterRoute(page, '.sh-side a[data-nav="team"]', "Team overview", "F6");
    await tabTo(page, "[data-tm-charts] > summary", { where: "F6 charts", max: 200 });
    await page.keyboard.press("Enter");
    await page.waitForSelector("[data-tm-charts][open] .ui-bars");
    // NEEDS F6 2: the visible bars are the accessible list.
    const s = await page.evaluate(() => {
      const root = document.querySelector("[data-tm-charts]");
      return {
        hiddenFocusable: root.querySelectorAll('[aria-hidden="true"] a, [aria-hidden="true"] button, [aria-hidden="true"] [tabindex]').length,
        links: Array.from(root.querySelectorAll("ul.ui-bars-list > li.ui-bar.is-link a")).map((a) => a.getAttribute("aria-label")),
        figures: Array.from(root.querySelectorAll("figure.ui-bars")).map((f) => [(f.querySelector("figcaption") || {}).textContent, f.getAttribute("aria-label")]),
      };
    });
    assert.equal(s.hiddenFocusable, 0, "nothing focusable inside aria-hidden");
    assert.ok(s.figures.length >= 3, "the charts are figures");
    for (const [title, label] of s.figures) assert.ok(label && label.startsWith(title + ": "), "a chart carries an aria-label (spec 4.13): " + label);
    assert.ok(s.links.length >= 3, "the bars are a list of links");
    for (const l of s.links) assert.match(l, /^.+, [\d,]+( \w+)?$/, "a bar link is named 'label, value'");
    assert.deepEqual(await axe(page), [], "axe on Team overview with the charts open");
    await tabTo(page, ".ui-bar.is-link a", { where: "F6 bar" });
    const r = await focusShown(page, "F6 bar link");
    assert.equal(r.how, "ancestor", "the bar's row shows the focus ring");
    const href = await page.evaluate(() => document.activeElement.getAttribute("href"));
    assert.match(href, /^#sites/);
    await page.keyboard.press("Enter");
    await page.waitForFunction((h) => location.hash === h, href);
    await page.waitForFunction(() => document.activeElement && document.activeElement.matches("main h1") && document.activeElement.textContent.trim() === "Sites");
  } finally {
    await close();
  }
});

test("F7 by keyboard: a deal from Deals, Approve offer; Esc returns to its row", async () => {
  const { page, close } = await openPage({ hash: "#deals" });
  try {
    const link = '.dl-body a[data-open="' + ID.deal + '"]';
    await tabTo(page, link, { where: "F7", max: 200 });
    await page.keyboard.press("Enter");
    await page.waitForSelector(P + '.ui-panel[data-panel="' + ID.deal + '"]');
    await settle(page);
    await tabTo(page, P + '[data-outcome="approve"]', { where: "F7 Approve" });
    await focusShown(page, "F7 Approve offer");
    await page.keyboard.press("Enter");
    await toastWith(page, "Follow-up");
    await waitFor(async () => (await column(ID.deal, "next_step")) === "Send agreement and brief", "the next step saved");
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => !document.querySelector("#layer-panel .ui-panel"));
    await page.waitForFunction((s) => document.activeElement && document.activeElement.matches(s), link, { timeout: 5000 })
      .catch(async () => assert.fail("F7: focus back on the row link (it is on " + (await active(page)) + ")"));
  } finally {
    await close();
  }
});

test("F8 by keyboard: Clients, Report, Copy as email; Esc returns to Report", async () => {
  const { page, close } = await openPage({ hash: "#clients", contextOptions: CLIP });
  try {
    await tabTo(page, '[data-cl-report="soro"]', { where: "F8" });
    await page.keyboard.press("Enter");
    await page.waitForSelector(".rp-modal[open] .rp-doc");
    await tabTo(page, ".rp-modal .ui-modal-foot button", { text: "Copy as email", where: "F8 copy" });
    await focusShown(page, "F8 Copy as email");
    await page.keyboard.press("Enter");
    await toastWith(page, "Report copied");
    assert.match(await page.evaluate(() => navigator.clipboard.readText()), /Soro/);
    await page.keyboard.press("Escape");
    await page.waitForSelector(".rp-modal[open]", { state: "detached" });
    assert.ok(await isActive(page, '[data-cl-report="soro"]'), "focus back on Report");
  } finally {
    await close();
  }
});

test("F9 by keyboard: a new prospect's Visit site, Add contact in the row, Add, Copy email, Sent first email", async () => {
  const { page, context, close } = await openPage({ contextOptions: CLIP });
  // Visit site opens the prospect's own site in a new tab; the fixture hosts don't resolve, so it gets
  // an empty page.
  await context.route((u) => !u.href.startsWith(BASE), (r) => r.fulfill({ status: 200, contentType: "text/html", body: "<title>site</title>" }));
  const row = PROS + ' [data-key="' + ID.prospect + '"]';
  const email = "pat.kb@" + site(ID.prospect).domain;
  try {
    await page.waitForSelector(row);
    await tabTo(page, row + ' [data-td-act="visit"]', { where: "F9 Visit site" });
    const [tab] = await Promise.all([context.waitForEvent("page"), page.keyboard.press("Enter")]);
    assert.match(tab.url(), new RegExp(site(ID.prospect).domain.replace(/\./g, "\\.")));
    await tab.close();
    await page.bringToFront();
    await tabTo(page, row + ' [data-td-act="add"]', { where: "F9 Add contact" });
    await page.keyboard.press("Enter");
    await page.waitForSelector(row + " form.td-add");
    assert.ok(await isActive(page, row + ' input[name="email"]'), "focus in Email");
    await page.keyboard.insertText(email);
    await tabTo(page, row + ' form.td-add button[type="submit"]', { where: "F9 Add" });
    await page.keyboard.press("Enter");
    await toastWith(page, "Contact added.");
    await page.waitForSelector(row + ' [data-td-act="copy"]');
    await tabTo(page, row + ' [data-td-act="copy"]', { where: "F9 Copy email" });
    await page.keyboard.press("Enter");
    await toastWith(page, "Copied " + email);
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), email);
    await tabTo(page, row + ' [data-td-act="emailed"]', { where: "F9 Sent first email" });
    await page.keyboard.press("Enter");
    await toastWith(page, "Moved to Contacted");
    await waitFor(async () => (await column(ID.prospect, "stage")) === "Contacted", "stage Contacted");
    assert.ok(!(await page.evaluate(() => document.activeElement === document.body)), "focus isn't dropped to <body> when the row leaves");
  } finally {
    await close();
  }
});

// ---------- 3. T27: phone ----------

const cachedList = (page) => page.evaluate(async () => (await caches.has("pgcrm")) && !!(await (await caches.open("pgcrm")).match("/api/partners?v=2")));

for (const width of [390, 320]) {
  test("T27 at " + width + " px: bottom tabs, cards, the full-screen panel with a sticky footer, the More sheet, Sign out", async () => {
    const { page, context, close } = await openPage({ viewport: { width, height: 760 } });
    try {
      const tabs = await page.$$eval(".sh-tabs > .sh-tab", (ts) => ts.filter((t) => t.offsetParent).map((t) => t.querySelector(".sh-label").textContent.trim()));
      assert.deepEqual(tabs, ["Today", "Sites", "Deals", "Search", "More"]);
      assert.equal(await page.$eval(".sh-side", (s) => getComputedStyle(s).display), "none", "no sidebar");

      // Lists are cards.
      await go(page, "#sites?tab=all");
      const card = await page.$eval(".si-list tbody tr", (tr) => ({ row: getComputedStyle(tr).display, head: getComputedStyle(tr.closest("table").querySelector("thead")).display }));
      assert.deepEqual(card, { row: "flex", head: "none" }, "rows render as cards");

      // The panel: full screen, sticky footer, the page under it doesn't scroll.
      await go(page, "#deals?rec=" + ID.deal);
      await page.waitForSelector(P + '.ui-panel[data-panel="' + ID.deal + '"]');
      await settle(page);
      const pnl = await page.evaluate(() => {
        const p = document.querySelector("#layer-panel .ui-panel").getBoundingClientRect();
        const f = document.querySelector("#layer-panel .rc-foot");
        return {
          box: [p.left, p.top, Math.round(p.width), Math.round(p.height)], screen: [0, 0, innerWidth, innerHeight],
          foot: f.getBoundingClientRect().bottom,
          btns: Array.from(f.querySelectorAll("button")).map((b) => b.getAttribute("aria-label") || b.textContent.replace(/[▾\s]+/g, " ").trim()),
          locked: getComputedStyle(document.documentElement).overflow === "hidden",
        };
      });
      assert.deepEqual(pnl.box, pnl.screen, "the panel fills the screen");
      assert.ok(Math.abs(pnl.foot - pnl.screen[3]) <= 1, "the footer sits at the bottom");
      assert.deepEqual(pnl.btns, ["Log what happened", "Follow up", "More actions"]);
      assert.ok(pnl.locked, "the page under the panel doesn't scroll");
      await page.evaluate(() => { const b = document.querySelector("#layer-panel .ui-panel-body"); b.scrollTop = b.scrollHeight; });
      await page.waitForTimeout(150);
      const foot2 = await page.$eval(P + ".rc-foot", (f) => f.getBoundingClientRect().bottom);
      assert.ok(Math.abs(foot2 - pnl.screen[3]) <= 1, "the footer stays put while the body scrolls");
      await shot(page, "t27-panel-" + width);
      await page.keyboard.press("Escape");
      await page.waitForFunction(() => !document.querySelector("#layer-panel .ui-panel"));

      // The More sheet: the other pages, who is signed in, the sync line, Refresh … Sign out.
      await page.click("[data-more]");
      await page.waitForSelector(".sh-more[open]");
      const more = await page.evaluate(() => {
        const d = document.querySelector(".sh-more");
        const t = (e) => e.textContent.replace(/\s+/g, " ").trim();
        return {
          pages: Array.from(d.querySelectorAll(".sh-more-nav a .sh-label")).map(t),
          me: t(d.querySelector(".sh-me")),
          sync: !!d.querySelector("[data-sync]"),
          acts: Array.from(d.querySelectorAll(".sh-foot-acts > *")).map(t),
        };
      });
      assert.deepEqual(more.pages, ["Clients", "Partners", "Contacts", "Team overview", "Help", "Edit history"]);
      assert.equal(more.me, "Signed in as Kamile · change");
      assert.ok(more.sync, "the sync line");
      assert.equal(more.acts[0], "Refresh");
      assert.equal(more.acts[more.acts.length - 1], "Sign out");
      await shot(page, "t27-more-" + width);
      assert.ok(await cachedList(page), "the list is cached before Sign out");
      await Promise.all([page.waitForURL(/\/login\?bye=1$/), page.click('.sh-more [data-act="signout"]')]);
      assert.match(await page.textContent("body"), /You're signed out\./);
      assert.equal((await context.cookies(BASE)).filter((c) => c.name === "pg_session").length, 0, "the session cookie is gone");
      assert.ok(!(await cachedList(page)), "the cached list is gone");
      await page.goto(BASE + "/#today");
      await page.waitForURL(/\/login/);
      assert.ok(await page.$('input[name="password"]'), "signed out: the sign-in form");
      await shot(page, "t27-signed-out-" + width);
    } finally {
      await close();
    }
  });
}
