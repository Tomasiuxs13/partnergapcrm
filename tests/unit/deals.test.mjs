// Deals and file links (lib/deals.js, migration 006; Tomas asked on 2026-10-21): how a deal's stage moves
// its site, how a deal's client joins the site's clients, the checks on deal fields and file links, and
// the one-time seed in 006 (one deal per site at a deal stage or with deal terms). node:sqlite in memory.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { siteStageFor, clientsWith, dealFieldValue, fileInput } from "../../lib/deals.js";

const MIG = fileURLToPath(new URL("../../crm/scripts/migrations/", import.meta.url));
const sql = (f) => fs.readFileSync(path.join(MIG, f), "utf8");

test("siteStageFor: the best deal stage wins, and Do not contact is left alone", () => {
  assert.equal(siteStageFor("Replied", ["Negotiating"]), "Negotiating");
  assert.equal(siteStageFor("Negotiating", ["Lost", "Active"]), "Active");
  assert.equal(siteStageFor("Active", ["Lost", "Negotiating"]), "Negotiating");
  assert.equal(siteStageFor("Negotiating", ["Lost", "Lost"]), "Lost");
  assert.equal(siteStageFor("Negotiating", ["Negotiating"]), null, "already there");
  assert.equal(siteStageFor("Do not contact", ["Active"]), null);
  assert.equal(siteStageFor("Replied", []), null, "no deals");
  assert.equal(siteStageFor("Replied", ["Researching"]), null, "not a deal stage");
});

test("clientsWith: adds the deal's client once, keeping the site's own order", () => {
  assert.equal(clientsWith("Soro", "Fiverr"), "Soro, Fiverr");
  assert.equal(clientsWith("", "Soro"), "Soro");
  assert.equal(clientsWith(null, "Soro"), "Soro");
  assert.equal(clientsWith("Soro, Fiverr", "fiverr"), null, "already there, any case");
  assert.equal(clientsWith("Soro", ""), null);
});

test("dealFieldValue: one client, a stage from the list, numbers and dates as on a site", () => {
  assert.equal(dealFieldValue("client", " Soro "), "Soro");
  assert.equal(dealFieldValue("client", ""), null);
  assert.throws(() => dealFieldValue("client", "Soro, Fiverr"), /one client/);
  assert.throws(() => dealFieldValue("client", "Melograno / Amelia"), /one client/);
  assert.equal(dealFieldValue("stage", "Active"), "Active");
  assert.throws(() => dealFieldValue("stage", "Replied"), /deal stage/);
  assert.equal(dealFieldValue("notes", "  "), null);
  assert.throws(() => dealFieldValue("label", "x"), /can't be edited/);
});

test("fileInput: https links only, a type from the list, the type as the name when none is given", () => {
  assert.deepEqual(fileInput({ url: "https://drive.google.com/file/d/abc", kind: "Contract" }),
    { label: "Contract", kind: "Contract", url: "https://drive.google.com/file/d/abc", deal_id: null });
  assert.deepEqual(fileInput({ url: "https://x.test/p.pdf", label: "Prices 2026", deal_id: "D-00001" }),
    { label: "Prices 2026", kind: "Other", url: "https://x.test/p.pdf", deal_id: "D-00001" });
  assert.throws(() => fileInput({ url: "" }), /Paste the link/);
  assert.throws(() => fileInput({ url: "http://x.test/p.pdf" }), /https/);
  assert.throws(() => fileInput({ url: "https://x.test/a b.pdf" }), /https/);
  assert.throws(() => fileInput({ url: "https://x.test/p.pdf", kind: "Photo" }), /file type/);
});

test("migration 006 seeds one deal per site at a deal stage or with terms, once", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(sql("001_base.sql"));
  const add = db.prepare("INSERT INTO partners (id, domain, stage, clients, owner, deal_model, deal_flat, deal_pct, next_step, next_due, last_touch) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
  add.run("PG-00001", "a.test", "Negotiating", "Soro, Fiverr", "Jonas", null, null, null, "Agree terms", "2026-10-26", "2026-10-20");
  add.run("PG-00002", "b.test", "Active", "UltaHost", "Kamile", "Flat fee", 300, null, null, null, "2026-10-01");
  add.run("PG-00003", "c.test", "Lost", "Raibu", "Monica", null, null, null, "Old step", null, "2026-09-01");
  add.run("PG-00004", "d.test", "Lost", "Raibu", "Monica", "Commission", null, 15, "Old step", "2026-09-01", "2026-09-01");
  add.run("PG-00005", "e.test", "Do not contact", "Soro", "Jonas", "Flat fee", 500, null, null, null, null);
  add.run("PG-00006", "f.test", "Replied", "Soro", "Jonas", null, null, null, null, null, null);
  db.exec(sql("006_deals_files.sql"));
  const deals = db.prepare("SELECT id, account_id, client, stage, owner, deal_flat, deal_pct, next_step, next_due FROM deals ORDER BY id").all().map((r) => ({ ...r }));
  assert.deepEqual(deals, [
    { id: "D-00001", account_id: "PG-00001", client: "Soro", stage: "Negotiating", owner: "Jonas", deal_flat: null, deal_pct: null, next_step: "Agree terms", next_due: "2026-10-26" },
    { id: "D-00002", account_id: "PG-00002", client: "UltaHost", stage: "Active", owner: "Kamile", deal_flat: 300, deal_pct: null, next_step: null, next_due: null },
    { id: "D-00003", account_id: "PG-00004", client: "Raibu", stage: "Lost", owner: "Monica", deal_flat: null, deal_pct: 15, next_step: null, next_due: null },
  ]);
  db.exec(sql("006_deals_files.sql"));
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM deals").get().n, 3, "running it again adds nothing");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM files").get().n, 0);
});
