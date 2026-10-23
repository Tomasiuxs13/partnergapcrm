// The full pages of one contact (#contact/<id>) and one deal (#deal/<id>), Tomas, 2026-10-23: "like
// HubSpot". Shared by pages/contact.js and pages/deal.js; no side effects at import time.
//
// createRecordPage({id, noun, back, load, view}) returns a page module (spec 5.4). The page asks load(id)
// (GET /api/contact/:id or /api/deal/:id) once per mount and again after a save; view(data, ctx, page)
// returns {title, crumb, head, left, main, side} (SafeHtml) and bind(page) adds the page's own clicks.
// Layout: a header (breadcrumb, h1, one line of facts, buttons), then three columns at >= 1280 px (about
// on the left, what happened in the middle, the site and its people on the right), two below, one on a
// phone (css/pages/records.css). The snapshot has no profiles, so it says "Open the live site to see this."
import { html, render, on } from "../core/dom.js";
import { date as fmtDate, ago, num } from "../core/format.js";
import { skeletonRows } from "../ui/skeleton.js";
import { stagePill, ownerChip, clientTags, avatar } from "../ui/pills.js";
import { buildTimeline, itemHtml } from "./record/timeline.js";
import { setTitle } from "../shell/shell.js";
import { siteUrl, labelOf } from "./record/header.js";

const has = (v) => v != null && String(v).trim() !== "";
const snapshotMode = () => typeof window !== "undefined" && !!window.__SNAPSHOT__;
export const dash = html`<span class="ui-faint" aria-label="none">—</span>`;

/** A card: <section class="ui-card rv-card"><h2>title</h2>body</section>. */
export function card(id, title, body, { extra = "", count } = {}) {
  return html`<section class="ui-card rv-card" aria-labelledby="${"rv-h-" + id}" data-rv-card="${id}"><div class="rv-card-head"><h2 class="ui-card-title rv-card-title" id="${"rv-h-" + id}">${title}${count != null ? html` <span class="rv-count">(${num(count)})</span>` : ""}</h2>${extra}</div>${body}</section>`;
}

/** A definition list from [label, value] pairs; pairs without a value are left out. */
export function facts(pairs) {
  const rows = pairs.filter((p) => p && p[1] != null && p[1] !== "" && p[1] !== false);
  if (!rows.length) return html`<p class="ui-small rv-muted">Nothing here yet.</p>`;
  return html`<dl class="rv-dl">${rows.map(([k, v]) => html`<dt>${k}</dt><dd>${v}</dd>`)}</dl>`;
}

/** "Thu 22 Oct (3 days ago)" for a date, or "". */
export function whenOf(iso, today) {
  if (!has(iso)) return "";
  const d = String(iso).slice(0, 10);
  const style = today && d.slice(0, 4) !== String(today).slice(0, 4) ? "year" : "short";
  return fmtDate(d, style) + " (" + ago(d, today) + ")";
}

/**
 * "Show 3 items" that opens a hidden block below it (the rest of a site's activity). A button and a
 * hidden div, not <details>, so nothing of the closed block is laid out; the page keeps it open on a redraw.
 */
export function moreBlock(id, count, body) {
  const label = "Show " + (count === 1 ? "1 item" : num(count) + " items");
  return html`<div class="rv-more"><button type="button" class="ui-linkbtn rv-more-btn" data-rv-toggle="${id}" data-rv-show="${label}" aria-expanded="false" aria-controls="${"rv-more-" + id}">${label}</button><div class="rv-more-body" id="${"rv-more-" + id}" hidden>${body}</div></div>`;
}

/** A timeline list (features/record/timeline.js) from a profile-like object, newest first. */
export function timeline(profile, today, { empty = "Nothing logged yet." } = {}) {
  const items = buildTimeline(profile, { today });
  if (!items.length) return html`<p class="ui-small rv-muted">${empty}</p>`;
  return html`<ol class="rc-tl">${items.map((it) => itemHtml(it, today, null))}</ol>`;
}

/** The site card: name, domain ↗, stage, owner, clients, DR, and Open site (the record panel). */
export function siteCard(r, partner, ctx) {
  const site = r || partner;
  if (!site) return card("site", "Site", html`<p class="ui-small rv-muted">The site isn't in the CRM any more.</p>`);
  const id = String(site.id);
  const url = siteUrl(site);
  const label = labelOf(site);
  const rec = r || Object.assign({ cl: [] }, partner);
  const body = html`<div class="rv-site"><div class="rv-site-top">${avatar(label, { size: "sm" })}<div class="rv-site-name"><a class="rv-tap" href="${ctx.href(ctx.route.page, Object.assign({}, ctx.route.params, { rec: id }), ctx.route.sub)}" data-rv-site="${id}"><b>${label}</b></a>${url ? html`<a class="rv-sub rv-tap" href="${url}" target="_blank" rel="noopener noreferrer">${site.domain} <span aria-hidden="true">↗</span></a>` : ""}</div></div>
${facts([
    ["Stage", stagePill(rec, { edit: false })],
    ["Owner", ownerChip(rec, { edit: false })],
    ["Clients", r ? clientTags(r, { edit: false, max: 4, emptyText: "No client" }) : has(site.clients) ? html`${site.clients}` : ""],
    ["DR", site.dr != null ? html`<span class="num">${num(site.dr)}</span>` : ""],
    ["Type", has(site.type) ? html`${site.type}` : ""],
  ])}<button type="button" class="ui-btn is-sm" data-rv-site="${id}">Open site</button></div>`;
  return card("site", "Site", body);
}

/** One line per person at the site, each linking to their own page. */
export function peopleList(contacts, ctx, { current } = {}) {
  const list = (contacts || []).filter((c) => String(c.id) !== String(current || ""));
  if (!list.length) return html`<p class="ui-small rv-muted">No other contacts yet.</p>`;
  return html`<ul class="rv-list">${list.map((c) => {
    const name = [c.first_name, c.last_name].filter(has).join(" ") || String(c.id);
    const sub = [c.title, c.client].filter(has).join(" · ");
    return html`<li><a class="rv-tap" href="${ctx.href("contact", {}, c.id)}"><b>${name}</b></a>${Number(c.primary_contact) > 0 ? html` <span class="ui-chip">Main</span>` : ""}${sub ? html`<span class="rv-sub">${sub}</span>` : ""}${has(c.email) ? html`<span class="rv-sub rv-email">${c.email}</span>` : ""}</li>`;
  })}</ul>`;
}

/**
 * The page module. opts: {id: 'contact' | 'deal', noun ('contact'), back: {page, label}, load(api, id) ->
 * Promise, view(data, ctx, page) -> {title, crumb, head, left, main, side}, bind(page) -> [off]}.
 */
export function createRecordPage({ id, noun, back, load, view, bind }) {
  let st = null;

  function shell(inner) {
    return html`<div class="rv-page" data-rv-page="${id}"><nav class="rv-crumbs" aria-label="Breadcrumb"><a href="${st.ctx.href(back.page)}">${back.label}</a><span aria-hidden="true"> › </span><span data-rv-crumb aria-current="page">${st.crumb || ""}</span></nav>${inner}</div>`;
  }

  function note(title, body, action) {
    return shell(html`<h1 tabindex="-1">${title}</h1><p class="rv-muted">${body}</p>${action || ""}`);
  }

  function draw() {
    if (!st) return;
    const ctx = st.ctx;
    if (st.state === "loading") {
      render(st.root, shell(html`<h1 tabindex="-1" class="rv-loading-h">Loading…</h1><div aria-busy="true">${skeletonRows(6)}</div>`));
      return;
    }
    if (st.state === "snapshot") {
      render(st.root, note("Open the live site to see this.", "This copy of the CRM doesn't have " + noun + " pages."));
      return;
    }
    if (st.state === "missing") {
      render(st.root, note("That " + noun + " wasn't found.", "It may have been removed, or the link is wrong.", html`<a class="ui-btn" href="${ctx.href(back.page)}">Back to ${back.label}</a>`));
      return;
    }
    if (st.state === "error") {
      render(st.root, note("This " + noun + " didn't load.", "Check your connection and try again.", html`<button type="button" class="ui-btn" data-rv-retry>Try again</button>`));
      return;
    }
    const v = view(st.data, ctx, api);
    st.crumb = v.crumb;
    // Keep the focus where it was when a save redraws the page.
    const a = typeof document !== "undefined" ? document.activeElement : null;
    const keep = a && st.root.contains(a) ? Array.from(a.attributes).find((x) => x.name.startsWith("data-rv-")) : null;
    render(st.root, shell(html`<header class="rv-head">${v.head}</header><div class="rv-cols"><div class="rv-left">${v.left}</div><div class="rv-main">${v.main}</div><div class="rv-side">${v.side}</div></div>`));
    for (const t of st.open) {
      const b = st.root.querySelector('[data-rv-toggle="' + t + '"]');
      if (b) setMore(b, true);
    }
    if (keep) {
      const el = st.root.querySelector("[" + keep.name + '="' + String(keep.value).replace(/"/g, '\\"') + '"]');
      if (el) el.focus({ preventScroll: true });
    }
  }

  function setMore(b, open) {
    const body = st.root.querySelector("#rv-more-" + b.getAttribute("data-rv-toggle"));
    b.setAttribute("aria-expanded", String(open));
    b.textContent = open ? "Hide" : b.getAttribute("data-rv-show");
    if (body) body.hidden = !open;
  }

  // The page's helpers for view() and bind(): reload after a save, the site's record, the data.
  const api = {
    reload: () => fetchData(),
    get data() { return st ? st.data : null; },
    get ctx() { return st ? st.ctx : null; },
    get root() { return st ? st.root : null; },
    setData(d) { if (st) { st.data = d; draw(); } },
  };

  async function fetchData() {
    const mine = st;
    if (!mine) return;
    if (snapshotMode()) {
      mine.state = "snapshot";
      draw();
      return;
    }
    if (!mine.data) {
      mine.state = "loading";
      draw();
    }
    let data = null;
    let state = "ok";
    try {
      data = await load(mine.ctx.api, mine.sub);
      if (!data) state = "missing"; // GET /api/deal/:id before migration 006

    } catch (e) {
      if (e && e.status === 401) return;
      state = e && e.status === 404 ? "missing" : "error";
    }
    if (st !== mine) return;
    if (state === "ok") mine.data = data;
    mine.state = state === "ok" || !mine.data ? state : "ok";
    draw();
    if (!mine.announced && state === "ok") {
      // The tab and top bar title name the contact or deal once it is in (app.js set the noun at mount).
      const t = view(mine.data, mine.ctx, api).title;
      mine.announced = true;
      if (typeof document !== "undefined") document.title = t + " · PartnerGap CRM";
      setTitle(t);
      mine.ctx.announce(t);
    }
  }

  return {
    id,
    title: () => (st && st.data ? view(st.data, st.ctx, api).title : noun.charAt(0).toUpperCase() + noun.slice(1)),
    mount(root, ctx) {
      if (st) this.unmount();
      st = { root, ctx, sub: String((ctx.route && ctx.route.sub) || ""), data: null, state: "loading", crumb: "", offs: [], announced: false, open: new Set() };
      st.offs.push(on(root, "click", "[data-rv-retry]", () => fetchData()));
      st.offs.push(on(root, "click", "[data-rv-toggle]", (e, b) => {
        const t = b.getAttribute("data-rv-toggle");
        const open = b.getAttribute("aria-expanded") !== "true";
        if (open) st.open.add(t);
        else st.open.delete(t);
        setMore(b, open);
      }));
      st.offs.push(on(root, "click", "[data-rv-site]", (e, a) => {
        if (e.ctrlKey || e.metaKey || e.shiftKey || e.altKey || e.button === 1) return; // new tab
        e.preventDefault();
        st.ctx.openRecord(a.getAttribute("data-rv-site"), { focus: a.getAttribute("data-rv-focus") || undefined });
      }));
      if (typeof bind === "function") st.offs.push(...(bind(api) || []));
      fetchData();
      ctx.announce(noun.charAt(0).toUpperCase() + noun.slice(1));
    },
    update(ctx, change) {
      if (!st) return;
      st.ctx = ctx;
      const kind = change && change.kind;
      if (kind === "route") return; // the page shows no params
      if (st.state === "ok") draw(); // the site card follows the store, the rest is the page's data
    },
    unmount() {
      if (!st) return;
      for (const off of st.offs) {
        try { off(); } catch (e) { /* already gone */ }
      }
      st = null;
    },
  };
}
