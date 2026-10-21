// Nothing disappears (spec 2.3, G4): one check per row of the capability map, at the place the map names
// (CHECKPOINT-G2 6.2 says where each lives). Each check opens that place and finds what the old page had;
// the deep behaviour is tested in the page files named on each row. Then every "See all N" link lands on a
// list of N sites (spec 7.3 G3-1). Owner G3-1.
// Read-only: menus and dialogs are opened and closed (Esc, Cancel, Discard); nothing is saved.
// Run: SHOTS_DIR=/tmp/shots-g31 bash tests/e2e/run.sh tests/e2e/97-capabilities.test.mjs
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { signedInPage, closeBrowser, fixture, HARNESS_ROOT } from "./lib.mjs";

const fx = fixture();
const TODAY = fx.today || process.env.FIXTURE_TODAY;
const CLOCK = TODAY + "T09:00:00Z";
const UTC = { timezoneId: "UTC" };
const DESKTOP = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };
const DEAL = "PG-00221"; // a Negotiating deal with contacts (fixture)

let jonas; // Jonas (an admin) at 1440: every row check runs on this page

// ---------- helpers ----------

// Same-page navigation; waits for the page and, when given, a selector on it.
async function nav(page, hash, sel) {
  const id = hash.replace(/^#/, "").split(/[/?]/)[0] || "today";
  await page.evaluate((h) => { location.hash = h; }, hash);
  await page.waitForSelector('[data-page="' + id + '"]', { timeout: 20000 });
  if (sel) await page.waitForSelector(sel, { timeout: 20000 });
}

const text = async (page, sel) => ((await page.textContent(sel)) || "").replace(/\s+/g, " ").trim();
const texts = (page, sel) => page.$$eval(sel, (els) => els.map((e) => e.textContent.replace(/\s+/g, " ").trim()));
const num = (s) => Number(String(s || "").replace(/[^\d]/g, ""));

async function sitesReady(page) {
  await page.waitForSelector(".si-page", { timeout: 20000 });
  await page.waitForFunction(() => {
    const n = document.querySelector('[data-si-tab="all"] [data-si-n]');
    return n && n.textContent.trim() !== "" && !document.querySelector(".si-list .ui-skeleton");
  }, null, { timeout: 20000 });
}

// The count a Sites list shows once it stops changing ("N sites").
async function sitesCount(page) {
  await sitesReady(page);
  let prev = null, same = 0;
  const end = Date.now() + 15000;
  while (Date.now() < end) {
    const t = await page.evaluate(() => {
      const el = document.querySelector('[data-page="sites"] [data-si-count]');
      return el ? el.textContent.trim() : null;
    });
    const m = t && /^([\d,]+) sites?$/.exec(t);
    const n = m ? Number(m[1].replace(/,/g, "")) : null;
    if (n != null && n === prev) {
      if (++same >= 2) return n;
    } else same = 0;
    prev = n;
    await new Promise((r) => setTimeout(r, 100));
  }
  return assert.fail("no count on " + await page.evaluate(() => location.hash) + " (last: " + prev + ")");
}

async function teamReady(page) {
  await nav(page, "#team", "[data-tm-overview]:not([hidden]):not([aria-busy]) .tm-table tbody tr");
}

async function menuLabels(page) {
  await page.waitForSelector(".ui-menu .ui-mi-label", { timeout: 5000 });
  return texts(page, ".ui-menu .ui-mi-label");
}

async function closeMenu(page) {
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => !document.querySelector(".ui-menu .ui-mi-label"), null, { timeout: 5000 });
}

async function dialogText(page) {
  await page.waitForSelector("dialog[open]", { timeout: 5000 });
  return page.evaluate(() => [...document.querySelectorAll("dialog[open]")].pop().innerText.replace(/\s+/g, " "));
}

async function noDialog(page) {
  await page.waitForFunction(() => !document.querySelector("dialog[open]"), null, { timeout: 5000 });
}

async function closePanel(page) {
  if (await page.$("#layer-panel [data-panel]")) {
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => !/[?&]rec=/.test(location.hash), null, { timeout: 5000 });
  }
}

before(async () => {
  jonas = await signedInPage({ name: "Jonas", clock: CLOCK, contextOptions: UTC, viewport: DESKTOP });
});

after(async () => {
  try {
    if (jonas) {
      assert.deepEqual(jonas.watch.pageErrors, [], "no page errors during the capability checks");
      await jonas.close();
    }
  } finally {
    await closeBrowser();
  }
});

// ---------- one check per row of 2.3 ----------

// [old capability, its new home (the e2e files that test it in depth), check(page)], in the order of 2.3.
const ROWS = [
  ["Home KPIs", "Clients totals row + Deals group totals + Team overview Stuck (50, 40, 60)", async (p) => {
    await nav(p, "#clients", "tfoot .cl-total");
    assert.match(await text(p, "tfoot .cl-total"), /^All clients/);
    for (const l of ["Prospects", "Emailed", "Deals in talks", "Live partners"]) {
      assert.match(await text(p, 'tfoot .cl-total [data-label="' + l + '"]'), /^\d[\d,]*$/, "totals: " + l);
    }
    await nav(p, "#deals", "[data-dl-group] h2");
    const heads = await texts(p, "[data-dl-group] h2");
    assert.ok(heads.some((h) => /^Negotiating \(\d+ · \$[\d,]+\)$/.test(h)), "Negotiating (N · $ total): " + heads.join(" | "));
    await teamReady(p);
    assert.equal(await p.locator("[data-tm-stuck]").count(), 5, "five Stuck tiles");
  }],
  ["Home Deals waiting on a decision", "Today Do now Your decision + Team overview Needs a decision (10, 60)", async (p) => {
    await nav(p, "#today", '[data-block="now"]');
    await p.click('[data-td-filter="deals"]');
    await p.waitForSelector('[data-block="now"] [data-reason="decision"]');
    assert.equal(await text(p, '[data-block="now"] [data-reason="decision"]'), "Your decision");
    await p.click('[data-td-filter="all"]');
    await teamReady(p);
    assert.ok(await p.locator("[data-tm-decision] [data-tm-group]").count() >= 1, "grouped by owner");
    assert.ok((await texts(p, "main h2")).some((h) => /^Needs a decision \(\d+\)$/.test(h)));
  }],
  ["Home Pipeline bars", "Team overview Charts + client page Pipeline (60, 50)", async (p) => {
    await teamReady(p);
    if ((await p.getAttribute("[data-tm-charts]", "open")) == null) await p.click("[data-tm-charts] summary");
    await p.waitForSelector("[data-tm-charts] figcaption");
    assert.ok((await texts(p, "[data-tm-charts] figcaption")).includes("Pipeline by stage"));
    await nav(p, "#clients/soro", "[data-cl-pipeline]");
    assert.ok((await texts(p, "main h2")).some((h) => /^Pipeline \(\d+\)$/.test(h)));
  }],
  ["Home to-dos (5 queues, Mine/Everyone)", "Today Do now (mine) + Team overview Stuck (everyone) (10, 60)", async (p) => {
    await nav(p, "#today", '[data-block="now"]');
    assert.ok(await p.locator('[data-block="now"] [data-reason]').count() > 0, "Do now has rows");
    await teamReady(p);
    for (const s of ["overdue", "unanswered", "quiet", "noreply", "unowned"]) {
      assert.match(await text(p, '[data-tm-stuck="' + s + '"]'), /^\d[\d,]*\D/, "Stuck tile " + s + " starts with its number");
    }
  }],
  ["Home Recently updated (team-wide)", "Sites › All › Recently active, linked from Team overview (60, 30)", async (p) => {
    await teamReady(p);
    assert.equal(await p.getAttribute("[data-tm-recent]", "href"), "#sites?tab=all&preset=activity");
    await p.click("[data-tm-recent]");
    await sitesReady(p);
    assert.equal(await p.getAttribute('[data-si-preset="activity"]', "aria-pressed"), "true");
  }],
  ["Home Clients at a glance", "Clients list (50)", async (p) => {
    await nav(p, "#clients", "tbody [data-cl-go]");
    const n = await p.locator("tbody [data-cl-go]").count();
    assert.ok(n >= 10, "a row per client (" + n + ")");
    assert.ok(await p.locator("[data-cl-report]").count() >= 10, "a Report button per client");
  }],
  ["Home Automations card", "Help (schedule) + Team overview morning run card (80, 60)", async (p) => {
    await nav(p, "#help", ".hp-card");
    assert.ok((await texts(p, "main h2")).some((h) => /^Automatic jobs/.test(h) && /Vilnius time/.test(h)));
    await teamReady(p);
    // The runs arrive with the side requests (team activity, suggestions, runs), after the table: wait for them.
    const run = await p.waitForSelector("[data-tm-run-card] [data-tm-run]", { timeout: 20000 }).catch(() => null);
    assert.ok(run, "the morning run card lists the runs");
  }],
  ["All sites (views, filters, sort, chips, CSV, bulk, pager)", "Sites › All (+ Last activity, Source, Has contact, big sites) (30)", async (p) => {
    await nav(p, "#sites?tab=all");
    await sitesReady(p);
    const fields = await p.$$eval(".si-filters [data-ffield]", (bs) => bs.map((b) => b.getAttribute("data-ffield")));
    for (const f of ["client", "owner", "stage", "type", "source", "has_contact", "big"]) assert.ok(fields.includes(f), "filter " + f);
    assert.ok((await texts(p, ".si-list thead th")).includes("Last activity"));
    assert.ok(await p.locator(".si-tools [data-si-sort]").count(), "sort");
    assert.ok(await p.locator("[data-si-csv]").count(), "CSV");
    assert.ok(await p.locator('.si-list tbody input[type="checkbox"]').count() > 0, "bulk select");
    assert.ok(await p.locator(".si-list [data-per]").count(), "pager");
  }],
  ["Prospecting (Found this month, No owner)", "Sites › Mine to contact, Unowned; newest first; Source filter (30)", async (p) => {
    await nav(p, "#sites?tab=mine");
    await sitesReady(p);
    assert.ok(await p.$('[data-si-tab="unowned"]'), "Unowned tab");
    const sorts = await p.$$eval(".si-tools [data-si-sort] option", (os) => os.map((o) => o.value + "=" + o.textContent.trim()));
    assert.ok(sorts.includes("newest:desc=Newest first"), sorts.join(", "));
    await nav(p, "#sites?tab=all");
    await sitesReady(p);
    await p.click('.si-filters [data-ffield="source"]');
    assert.ok((await menuLabels(p)).length >= 2, "Source filter lists the sources");
    await closeMenu(p);
  }],
  ["Tasks No reply in 14+ days", "Sites › Waiting for reply › No reply in 14+ days (bulk, Start) + Today Do now (30, 10)", async (p) => {
    await nav(p, "#sites?tab=waiting&quiet=14");
    await sitesReady(p);
    assert.match(await text(p, "[data-si-quiet]"), /^No reply in 14\+ days \(\d+\)$/);
    assert.equal(await p.getAttribute("[data-si-quiet]", "aria-pressed"), "true");
    assert.ok(await p.$("[data-si-start]"), "Start (queue mode)");
    assert.ok(await p.locator('.si-list tbody input[type="checkbox"]').count() > 0, "bulk select");
    await nav(p, "#today", '[data-block="now"]');
    if (await p.$('[data-td-more="now"]') && /^Show all/.test(await text(p, '[data-td-more="now"]'))) await p.click('[data-td-more="now"]');
    await p.waitForSelector('[data-block="now"] [data-reason="noreply"], [data-td-noreply]', { state: "attached" });
  }],
  ["Tasks other queues", "Today Do now + Team overview Stuck (10, 60)", async (p) => {
    await nav(p, "#today", '[data-block="now"]');
    const chips = await texts(p, "[data-td-filter]");
    for (const c of [/^All/, /^Replies/, /^Follow-ups/, /^Deals/]) assert.ok(chips.some((t) => c.test(t)), chips.join(" | "));
    await teamReady(p);
    assert.match(await text(p, '[data-tm-stuck="unanswered"]'), /Unanswered replies/);
  }],
  ["Partners page (All, Waiting to go live, Live, per client) + CSV with deal columns", "Deals groups + Client filter + client page Live placements + Deals CSV (40, 50)", async (p) => {
    await nav(p, "#deals", "[data-dl-group]");
    const heads = await texts(p, "[data-dl-group] h2");
    for (const g of [/^Negotiating/, /^Signed, not live/, /^Live/]) assert.ok(heads.some((h) => g.test(h)), "group " + g + " in " + heads.join(" | "));
    assert.ok(await p.$('[data-dl-filters] [data-ffield="client"]'), "Client filter");
    const [dl] = await Promise.all([p.waitForEvent("download"), p.click("[data-dl-csv]")]);
    const head = fs.readFileSync(await dl.path(), "utf8").replace(/^﻿/, "").split(/\r?\n/)[0];
    for (const c of ["Deal type", "Flat fee", "Commission %", "Deal value", "Placement", "Went live", "Tracking ID"]) assert.ok(head.includes(c), "CSV column " + c);
    await nav(p, "#clients/soro", '[data-cl-card="live"]');
    assert.ok((await texts(p, "main h2")).some((h) => /^Live placements \(\d+\)$/.test(h)));
  }],
  ["Deals board (drag, 3 columns) + table", "Deals grouped list + Log what happened + Stage ▾ on each row (40)", async (p) => {
    const row = '[data-dl-list="negotiating"] tr[data-key]';
    await nav(p, "#deals", row);
    assert.ok(await p.$(row + ' [data-row-act="log"]'), "Log what happened per row");
    await p.click(row + ' .dl-site button.ui-stage[data-edit="stage"]');
    const stages = await menuLabels(p);
    for (const s of ["Negotiating", "Active", "Lost"]) assert.ok(stages.some((l) => l.startsWith(s)), "the stage menu has " + s + ": " + stages.join(", "));
    await closeMenu(p);
    assert.equal(await p.$("#layer-panel [data-panel]"), null, "no panel opened");
  }],
  ["Clients cards (4 stats, managers, markets)", "Clients list + client page header (50)", async (p) => {
    await nav(p, "#clients", "tbody [data-cl-go]");
    const labels = await p.$$eval("tbody tr:first-child [data-label]", (tds) => tds.map((t) => t.getAttribute("data-label")));
    for (const l of ["Manager", "Prospects", "Emailed", "Deals in talks", "Live partners"]) assert.ok(labels.includes(l), "column " + l);
    await nav(p, "#clients/soro", "[data-cl-top]");
    assert.match(await text(p, "[data-cl-top]"), /Managed by /);
  }],
  ["Client page (KPIs, deals, pipeline, program edit, partners, best prospects)", "Client page + Waiting on client + Melograno products (50)", async (p) => {
    await nav(p, "#clients/soro", "[data-cl-card]");
    const cards = await p.$$eval("[data-cl-card]", (cs) => cs.map((c) => c.getAttribute("data-cl-card")));
    for (const c of ["waiting", "deals", "live", "prospects", "pipeline", "program"]) assert.ok(cards.includes(c), "card " + c);
    assert.ok(await p.$('[data-cl-act="prog-edit"]'), "the program can be edited");
    await nav(p, "#clients/melograno", "[data-cl-product]");
    const products = await p.$$eval("[data-cl-product]", (bs) => bs.map((b) => b.getAttribute("data-cl-product")).filter(Boolean));
    assert.ok(products.length >= 2, "Melograno product chips: " + products.join(", "));
  }],
  ["Monthly report (copy as text)", "Report modal: Copy as email + Print (50)", async (p) => {
    await nav(p, "#clients/soro", '[data-cl-act="report"]');
    await p.click('[data-cl-act="report"]');
    const t = await dialogText(p);
    assert.match(t, /Monthly report/);
    assert.match(t, /Copy as email/);
    assert.match(t, /Print/);
    await p.keyboard.press("Escape");
    await noDialog(p);
  }],
  ["Team cards (owned counts, N to follow up)", "Team overview Team table (60)", async (p) => {
    await teamReady(p);
    const th = await texts(p, "[data-tm-team] thead th");
    for (const c of ["Owns", "Prospects", "Emailed", "Negotiating", "Active", "Replies waiting", "Clients managed", "Overdue now", "Quiet deals now"]) {
      assert.ok(th.includes(c), "column " + c + " in " + th.join(" | "));
    }
  }],
  ["Campaigns table", "Client page numbers strip (50)", async (p) => {
    await nav(p, "#clients/soro", "[data-cl-tile]");
    const tiles = await p.$$eval("[data-cl-tile]", (ts) => ts.map((t) => t.getAttribute("data-cl-tile")));
    for (const t of ["prospects", "emailed", "replied", "rate", "talks", "active", "live"]) assert.ok(tiles.includes(t), "tile " + t);
  }],
  ["Reports (6 charts)", "Team overview › Charts (60)", async (p) => {
    await teamReady(p);
    if ((await p.getAttribute("[data-tm-charts]", "open")) == null) await p.click("[data-tm-charts] summary");
    await p.waitForSelector("[data-tm-charts] figcaption");
    assert.equal((await texts(p, "[data-tm-charts] figcaption")).length, 6);
  }],
  ["Change log (40 newest, Waiting/Synced)", "Edit history (paged, 3 states) + record timeline (80, 20)", async (p) => {
    await nav(p, "#history", "[data-hi-list]");
    const states = await p.$$eval("[data-hi-bar] [data-hi-state]", (bs) => bs.map((b) => b.getAttribute("data-hi-state")));
    for (const s of ["waiting", "copied", "not_copied"]) assert.ok(states.includes(s), "state " + s);
    await nav(p, "#deals?rec=" + DEAL, '#layer-panel [data-psec="timeline"]');
    await closePanel(p);
  }],
  ["Record drawer (About, facts, 13 fields, contacts, activity, timeline, Save, sheet, Visit, Copy link)", "Record panel; ⋯ › Show all fields (20)", async (p) => {
    await nav(p, "#deals?rec=" + DEAL, "#layer-panel [data-panel]");
    for (const s of ['[data-edit="stage"]', '[data-edit="owner"]', '[data-edit="clients"]', '[data-psec="log"]', '[data-psec="next"]',
      '[data-psec="contacts"] [data-padd="open"]', '[data-psec="deal"]', '[data-psec="timeline"]', '[data-psec="details"]', '[data-pact="visit"]']) {
      assert.ok(await p.$("#layer-panel " + s), "the panel has " + s);
    }
    await p.click('#layer-panel [data-pact="more"]');
    const items = await menuLabels(p);
    for (const i of ["Open in sheet", "Copy link", "Show all fields"]) assert.ok(items.includes(i), "⋯ has " + i + ": " + items.join(", "));
    await closeMenu(p);
    await closePanel(p);
  }],
  ["Per-contact open the sheet link", "Contact card Sheet ↗ (20)", async (p) => {
    await nav(p, "#deals?rec=" + DEAL, "#layer-panel a[data-psheet]");
    assert.equal(await text(p, "#layer-panel a[data-psheet]"), "Sheet ↗");
    assert.match(await p.getAttribute("#layer-panel a[data-psheet]", "href"), /^https:\/\//);
    await closePanel(p);
  }],
  ["Add site modal (dupe check, client chips, owner default, Add anyway)", "Add site (+ Melograno products, Other…, type list, discard guard) (70)", async (p) => {
    await nav(p, "#today", '[data-block="now"]');
    await p.click('[data-act="add"]');
    await p.waitForSelector("dialog[open] [data-add-submit]");
    for (const s of ["[data-chips] [data-chip]", '[data-group="melograno"]', "[data-other-toggle]", "select"]) assert.ok(await p.$("dialog[open] " + s), "Add site has " + s);
    assert.match(await dialogText(p), /Jonas \(me\)/, "the owner is me by default");
    await p.fill("dialog[open] input", "https://review-zone-221.example.test/a-page");
    await p.waitForFunction(() => /Already in the CRM/.test((document.querySelector("dialog[open] [data-dupes]") || {}).textContent || ""), null, { timeout: 10000 });
    assert.match(await text(p, "dialog[open] [data-dupes]"), /Add anyway/);
    await p.keyboard.press("Escape");
    await p.waitForFunction(() => /Discard this site\?/.test([...document.querySelectorAll("dialog[open]")].pop().textContent));
    await p.click('dialog[open] button:text-is("Discard")');
    await noDialog(p);
  }],
  ["Global search (sites, pages, clients, owners)", "Search: sites, contacts, Go to clients and people (70)", async (p) => {
    await nav(p, "#today", '[data-block="now"]');
    await p.keyboard.press("Control+k");
    await p.waitForSelector("dialog[open] .se-input");
    await p.fill("dialog[open] .se-input", "soro");
    await p.waitForSelector('dialog[open] [data-kind="client"]');
    assert.ok(await p.$('dialog[open] [data-kind="site"]'), "a site");
    await p.fill("dialog[open] .se-input", "Kamile");
    await p.waitForSelector('dialog[open] [data-kind="person"]', { timeout: 5000 });
    await p.fill("dialog[open] .se-input", "Yara Stone");
    await p.waitForSelector('dialog[open] [data-kind="contact"]', { timeout: 10000 });
    await p.keyboard.press("Escape");
    await noDialog(p);
  }],
  ["Who are you picker", "Sign-in name + footer change (05)", async (p) => {
    assert.match(await text(p, '[data-foot="side"]'), /Signed in as Jonas/);
    await p.click('[data-act="me"]');
    assert.match(await dialogText(p), /Change your name/);
    await p.click('dialog[open] button:text-is("Cancel")');
    await noDialog(p);
  }],
  ["Sync note + Change log badge", "Footer sync line + freshness line + banner (05, 80)", async (p) => {
    await nav(p, "#today", '[data-block="now"]');
    assert.match(await text(p, "a[data-sync]"), /\S/);
    assert.equal(await p.getAttribute("a[data-sync]", "href"), "#history");
    assert.match(await text(p, "p[data-fresh]"), /\S/);
    assert.ok(await p.$('[data-banners] [data-banner="fresh"]'), "the fixture's not-copied edits show the banner");
  }],
  ["Test mode badge, Open CRM sheet, Sign out", "Top bar badge; footer links; phone More (05; the phone check is below)", async (p) => {
    assert.match(await text(p, ".sh-test"), /Test mode/);
    const links = await p.$$eval("a.sh-link", (as) => as.map((a) => a.textContent.trim() + " " + a.getAttribute("href")));
    assert.ok(links.some((s) => /^Google Sheet ↗ https:\/\//.test(s)), links.join(" | "));
    assert.ok(await p.$('[data-foot="side"] a[data-act="signout"][href="/logout"]'), "Sign out in the footer");
  }],
  ["Keyboard: /, n, Esc, Enter on row", "Same + Ctrl/Cmd K, J/K in queue mode; Help lists them (80)", async (p) => {
    await nav(p, "#today", '[data-block="now"]');
    await p.keyboard.press("/");
    await p.waitForSelector("dialog[open] .se-input");
    await p.keyboard.press("Escape");
    await noDialog(p);
    await p.keyboard.press("n");
    await p.waitForSelector("dialog[open] [data-add-submit]");
    await p.keyboard.press("Escape");
    await noDialog(p);
    await p.click("[data-td-start]");
    await p.waitForSelector("#layer-panel .ui-queue-text");
    assert.match(await text(p, "#layer-panel .ui-queue-text"), /^1 of \d+/);
    await p.keyboard.press("j");
    await p.waitForFunction(() => /^2 of /.test(document.querySelector("#layer-panel .ui-queue-text").textContent));
    await p.keyboard.press("k");
    await p.waitForFunction(() => /^1 of /.test(document.querySelector("#layer-panel .ui-queue-text").textContent));
    await closePanel(p);
    await nav(p, "#sites?tab=all");
    await sitesReady(p);
    await p.focus(".si-list tbody tr[data-key] a[data-open]");
    await p.keyboard.press("Enter");
    await p.waitForSelector("#layer-panel [data-panel]");
    await closePanel(p);
    await nav(p, "#help", ".hp-keys");
    assert.equal(await p.locator(".hp-keys .hp-dl-row").count(), 5, "Help lists the five shortcuts");
  }],
  ["Filtered navigation (click owner, stage, tag)", "Filter by this in each pill menu: adds a chip, no page jump (05, 30)", async (p) => {
    await nav(p, "#sites?tab=all");
    await sitesReady(p);
    const pill = '.si-list tbody tr[data-key] button[data-edit="owner"]';
    await p.click(pill);
    const items = await menuLabels(p);
    assert.ok(items.some((l) => /^Filter by this/.test(l)), "Filter by this: " + items.join(", "));
    await p.click('.ui-menu .ui-mi-label:text-matches("^Filter by this")');
    await p.waitForFunction(() => /[?&]owner=/.test(location.hash));
    assert.ok((await texts(p, ".si-filters .ui-chiprow .ui-fchip")).some((c) => c.startsWith("Owner: ")), "an Owner chip");
    assert.ok(await p.evaluate(() => location.hash.startsWith("#sites?")), "still on Sites");
  }],
  ["localStorage table filters", "URL params, shareable and bookmarkable (30)", async (p) => {
    await nav(p, "#sites?tab=all&stage=Contacted&owner=Kamile");
    const n = await sitesCount(p);
    await p.reload();
    assert.equal(await sitesCount(p), n, "the same list after a reload");
    const chips = await texts(p, ".si-filters .ui-chiprow .ui-fchip");
    assert.ok(chips.some((c) => c.startsWith("Owner: Kamile")) && chips.some((c) => c.startsWith("Stage: Contacted")), chips.join(" | "));
  }],
  ["Export CSV on Prospecting, Partners, Tasks", "CSV on every list (30, 40, 80)", async (p) => {
    for (const [hash, sel] of [["#sites?tab=mine", "[data-si-csv]"], ["#sites?tab=waiting&quiet=14", "[data-si-csv]"], ["#deals", "[data-dl-csv]"], ["#history", "[data-hi-csv]"]]) {
      await nav(p, hash);
      await p.waitForSelector(sel, { state: "attached", timeout: 20000 });
      assert.ok(await p.locator(sel + ":visible").count() > 0, "a visible CSV button on " + hash);
    }
  }],
  ["Read-only snapshot mode (window.PARTNERS)", "crm/scripts/build_snapshot.mjs (96)", async () => {
    assert.ok(fs.existsSync(path.join(HARNESS_ROOT, "crm", "scripts", "build_snapshot.mjs")), "the builder");
    const t = fs.readFileSync(path.join(HARNESS_ROOT, "tests", "e2e", "96-snapshot.test.mjs"), "utf8");
    assert.ok(/\btest\(/.test(t) && !/test\.todo\(/.test(t), "96-snapshot tests it");
  }],
];

for (const [old, home, check] of ROWS) {
  test(old + " → " + home, async () => {
    await check(jonas.page);
  });
}

test("Sign out is in the phone's More sheet (2.3 Sign out; T27)", async () => {
  const s = await signedInPage({ name: "Jonas", clock: CLOCK, contextOptions: { ...UTC, hasTouch: true, isMobile: true }, viewport: PHONE });
  try {
    await s.page.waitForSelector('[data-page="today"]');
    await s.page.click('button[data-act="more"]');
    await s.page.waitForSelector('[data-foot="more"] a[data-act="signout"]', { state: "visible" });
    assert.equal(await s.page.getAttribute('[data-foot="more"] a[data-act="signout"]', "href"), "/logout");
    assert.deepEqual(s.watch.pageErrors, []);
  } finally {
    await s.close();
  }
});

// ---------- "See all N" lands on a list of N ----------

test("See all N: every such link lands on a list with N sites", async () => {
  const s = await signedInPage({ name: "Kamile", clock: CLOCK, contextOptions: UTC, viewport: DESKTOP });
  const p = s.page;
  try {
    // Today › New prospects: "See all N in Sites" → Mine to contact.
    const pros = '[data-block="prospects"] .td-bfoot a';
    await nav(p, "#today", pros);
    assert.match(await text(p, pros), /^See all \d+ in Sites$/);
    const nPros = num(await text(p, pros));
    assert.equal(await p.getAttribute(pros, "href"), "#sites?tab=mine");
    await p.click(pros);
    assert.equal(await sitesCount(p), nPros, "Mine to contact");
    // Today › Do now: the capped no-reply note "Showing 10 of N sites with no reply … See all in Sites".
    await nav(p, "#today", "[data-td-noreply]");
    const line = await p.$eval("[data-td-noreply]", (a) => a.parentElement.textContent.replace(/\s+/g, " "));
    const m = /of ([\d,]+) sites with no reply/.exec(line);
    assert.ok(m, "the note says how many: " + line);
    assert.equal(await p.getAttribute("[data-td-noreply]", "href"), "#sites?tab=waiting&quiet=14");
    await p.click("[data-td-noreply]");
    assert.equal(await sitesCount(p), num(m[1]), "No reply in 14+ days");
    // Client page: "See all N sites".
    const all = '[data-cl-key="act:all"]';
    await nav(p, "#clients/soro", all);
    const nClient = num(await text(p, all));
    await p.click(all);
    assert.equal(await sitesCount(p), nClient, "the client's sites");
    // Search: "See all N matching sites".
    await nav(p, "#today", '[data-block="now"]');
    await p.keyboard.press("Control+k");
    await p.waitForSelector("dialog[open] .se-input");
    await p.fill("dialog[open] .se-input", "money");
    await p.waitForSelector('dialog[open] [data-kind="more"]');
    const m2 = /See all ([\d,]+) matching sites/.exec(await text(p, 'dialog[open] [data-kind="more"]'));
    assert.ok(m2, "the search's See all row");
    await p.click('dialog[open] [data-kind="more"]');
    await noDialog(p);
    assert.equal(await sitesCount(p), num(m2[1]), "the search's sites");
    // Team overview: one of each kind of number (60-team opens every one and checks it against D1).
    for (const sel of ['[data-tm-person="Kamile"] [data-tm-cell="owns"] a', '[data-tm-person="Kamile"] [data-tm-cell="replies"] a', '[data-tm-stuck="overdue"]']) {
      await teamReady(p);
      const n = num((await p.$eval(sel, (a) => a.textContent)).match(/^\s*([\d,]+)/)[1]);
      await p.click(sel);
      assert.equal(await sitesCount(p), n, sel);
    }
    assert.deepEqual(s.watch.pageErrors, []);
  } finally {
    await s.close();
  }
});
