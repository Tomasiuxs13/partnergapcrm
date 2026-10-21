// Golden capture for the frozen `edits` contract (spec 6.4, 7.1 G1-D (1)). Owner G1-D.
//
//   node tests/e2e/golden/capture.mjs --root <checkout at d5e91d9> [--out tests/e2e/golden]
//
// Serves the given checkout (the live code) with this repo's harness and synthetic fixture
// (tests/e2e/lib.mjs startServer: free port, own inspector port, mktemp -d persist dir, local D1 only),
// calls every write path, and writes one JSON file per write path: the request, the partners state
// before it, the response, and the `edits` rows it wrote minus `n` and `at`, with run-dependent values
// replaced by tokens (see README.md). Run it only against d5e91d9; the files are the contract.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { startServer, apiClient, editsAfter, stripEdit, sqlLit } from "../lib.mjs";
import { buildFixture, FIXTURE_VERSION } from "../../fixtures/make-seed.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EDITABLE = ["stage", "owner", "clients", "type", "next_step", "next_due", "deal_model", "deal_flat", "deal_pct", "deal_value",
  "content_url", "live_date", "tracking_id"];
const BEFORE_COLS = [...EDITABLE, "last_touch"];
const BY = "Kamile";

function args(argv) {
  const o = { out: HERE };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--root") o.root = argv[++i];
    else if (argv[i] === "--out") o.out = path.resolve(argv[++i]);
    else throw new Error("capture: unknown argument " + argv[i]);
  }
  if (!o.root) throw new Error("capture: --root <checkout of the live code> is required");
  return o;
}

const utcToday = () => new Date().toISOString().slice(0, 10);
const ISO_AT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

/** Replaces run-dependent values with tokens. ctx: {today, activityN, newAccountId, newContactId}. */
function tokenize(value, ctx, key) {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map((v) => tokenize(v, ctx));
  if (typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = tokenize(v, ctx, k);
    return out;
  }
  if (typeof value === "number") {
    if (ctx.activityN != null && key === "n" && value === ctx.activityN) return "{{activity_n}}";
    return value;
  }
  if (typeof value !== "string") return value;
  if (ctx.newAccountId && value === ctx.newAccountId) return "{{new_account_id}}";
  if (ctx.newContactId && value === ctx.newContactId) return "{{new_contact_id}}";
  if (value === ctx.today) return "{{today}}";
  if (ISO_AT.test(value)) return "{{at}}";
  if (ctx.activityN != null && key === "field" && value === String(ctx.activityN)) return "{{activity_n}}";
  // JSON in edits.new: the server's date sits in "date" (activity) and "added" (create_account).
  return value.replace(new RegExp('"(date|added)":"' + ctx.today + '"', "g"), '"$1":"{{today}}"');
}

async function main() {
  const o = args(process.argv.slice(2));
  const root = path.resolve(o.root);
  const commit = execFileSync("git", ["-C", root, "rev-parse", "HEAD"]).toString().trim();
  const dirty = execFileSync("git", ["-C", root, "status", "--porcelain", "--untracked-files=no"]).toString().trim();
  if (dirty) throw new Error("capture: " + root + " has local changes; capture from a clean checkout");
  const fx = buildFixture();
  const tag = (t) => fx.groups[t][0];
  const contactOf = (t) => fx.contacts.find((c) => c.account_id === tag(t)).id;
  const server = await startServer({ root, extra: false });
  const files = {};
  try {
    const client = await apiClient(server.baseUrl);

    // One wrangler call before the request (setup, state, max n) and one after (the new edits rows).
    async function prepare(setup, ids) {
      const stmts = [];
      for (const [id, cols] of Object.entries(setup || {})) {
        const set = Object.entries(cols).map(([k, v]) => k + " = " + sqlLit(v));
        if (set.length) stmts.push("UPDATE partners SET " + set.join(", ") + " WHERE id = " + sqlLit(id));
      }
      const obj = "json_object('id', id, " + BEFORE_COLS.map((c) => "'" + c + "', " + c).join(", ") + ")";
      if (ids.length) stmts.push("SELECT " + obj + " AS j FROM partners WHERE id IN (" + ids.map(sqlLit).join(", ") + ")");
      stmts.push("SELECT COALESCE(MAX(n), 0) AS n FROM edits");
      const res = await server.d1All(stmts.join(";\n") + ";", { rawNulls: true });
      const maxN = res[res.length - 1].results[0].n;
      const rows = ids.length ? res[res.length - 2].results.map((r) => JSON.parse(r.j)) : [];
      const before = {};
      for (const id of ids) {
        const r = rows.find((x) => x.id === id);
        if (!r) throw new Error("capture: no partner " + id);
        before[id] = {};
        for (const col of BEFORE_COLS) before[id][col] = r[col] === undefined ? null : r[col];
      }
      return { before, maxN };
    }

    async function run(file, c) {
      const ids = Object.keys(c.setup || {}).concat(c.ids || []).filter((v, i, a) => a.indexOf(v) === i);
      const { before, maxN } = await prepare(c.setup, ids);
      const day0 = utcToday();
      const res = await client.call(c.method, c.url, c.body);
      const day1 = utcToday();
      if (day0 !== day1) throw new Error("capture: the UTC date changed during a request; run again");
      const rows = (await editsAfter(maxN, { persistDir: server.persistDir, root })).map(stripEdit);
      if (c.expectStatus && res.status !== c.expectStatus) {
        throw new Error("capture: " + file + "#" + c.name + " returned " + res.status + " (expected " + c.expectStatus + "): " + res.text);
      }
      const body = res.json;
      const ctx = { today: day0 };
      if (body && body.activity && typeof body.activity.n === "number") ctx.activityN = body.activity.n;
      if (body && Array.isArray(body.row) && /^NEW-\d{4}$/.test(body.row[0])) ctx.newAccountId = body.row[0];
      if (body && body.contact && /^NEWC-\d{4}$/.test(body.contact.id)) ctx.newContactId = body.contact.id;
      const entry = {
        name: c.name,
        about: c.about,
        before,
        request: { method: c.method, url: c.url, body: c.body },
        status: res.status,
        response: tokenize(body === undefined ? res.text : body, ctx),
        edits: rows.map((r) => tokenize(r, ctx)),
      };
      (files[file] ||= []).push(entry);
      console.error("capture: " + file + "#" + c.name + " -> " + res.status + ", " + rows.length + " edits rows");
    }

    const lt = "2026-10-14"; // a fixed last_touch so responses do not depend on the run day
    const P = (t) => "/api/partner/" + tag(t);

    // ---- PATCH /api/partner/:id (kind update). Fields are listed in EDITABLE order. ----
    await run("patch-partner", { name: "interested", method: "PATCH", url: P("c-interested"),
      about: "Replied -> Negotiating with a next step and a date: the field half of the Interested outcome (3 update rows).",
      setup: { [tag("c-interested")]: { stage: "Replied", owner: "Tomas", next_step: "Answer their reply", next_due: null, last_touch: lt } },
      body: { by: BY, fields: { stage: "Negotiating", next_step: "Agree terms", next_due: "2026-11-04" } }, expectStatus: 200 });
    await run("patch-partner", { name: "deal-terms", method: "PATCH", url: P("c-deal"),
      about: "Deal terms and placement: numbers are cleaned ($ , % and spaces), rounded to cents and stored as text in edits.",
      setup: { [tag("c-deal")]: { deal_model: null, deal_flat: null, deal_pct: null, deal_value: null, content_url: null, live_date: null,
        tracking_id: null, last_touch: lt } },
      body: { by: BY, fields: { deal_model: "Flat fee + commission", deal_flat: "$1,200", deal_pct: "12.5%", deal_value: "2,500.555",
        content_url: "https://c-deal.contract.example.test/post", live_date: "2026-11-15", tracking_id: "EF-2001" } }, expectStatus: 200 });
    await run("patch-partner", { name: "lost-clears-next", method: "PATCH", url: P("c-lost"),
      about: "Not interested: stage Lost and the next step and date cleared (new = null).",
      setup: { [tag("c-lost")]: { stage: "Contacted", next_step: "Follow up if no reply", next_due: "2026-11-02", last_touch: lt } },
      body: { by: BY, fields: { stage: "Lost", next_step: "", next_due: "" } }, expectStatus: 200 });
    await run("patch-partner", { name: "assign-owner-clients-type", method: "PATCH", url: P("c-assign"),
      about: "Owner from empty, clients re-joined with \", \" (stored tokens otherwise kept), type set.",
      setup: { [tag("c-assign")]: { owner: null, clients: "Weglot ,Soro", type: "Uncategorized", last_touch: null } },
      body: { by: BY, fields: { owner: "Kamile", clients: "Weglot ,Soro, UltaHost", type: "Review" } }, expectStatus: 200 });
    await run("patch-partner", { name: "waiting-on-client", method: "PATCH", url: P("c-waiting"),
      about: "Ask the client: next_step gets the \"Waiting on client: \" prefix, with a date.",
      setup: { [tag("c-waiting")]: { stage: "Negotiating", next_step: "Agree terms", next_due: null, last_touch: lt } },
      body: { by: BY, fields: { next_step: "Waiting on client: decision on the offer", next_due: "2026-11-06" } }, expectStatus: 200 });
    await run("patch-partner", { name: "clear-owner-and-type", method: "PATCH", url: P("c-spare-2"),
      about: "Empty values clear a field (new = null).",
      setup: { [tag("c-spare-2")]: { owner: "Tomas", type: "Review", last_touch: lt } },
      body: { by: BY, fields: { owner: "", type: "" } }, expectStatus: 200 });
    await run("patch-partner", { name: "no-change", method: "PATCH", url: P("c-nochange"),
      about: "Values equal to the stored ones write nothing (changed = {}).",
      setup: { [tag("c-nochange")]: { stage: "Contacted", next_step: "Follow up if no reply", last_touch: lt } },
      body: { by: BY, fields: { stage: "Contacted", next_step: "Follow up if no reply" } }, expectStatus: 200 });
    await run("patch-partner", { name: "ignores-non-editable", method: "PATCH", url: P("c-spare-3"),
      about: "Fields outside EDITABLE are ignored silently; the editable one is saved.",
      setup: { [tag("c-spare-3")]: { stage: "Replied", last_touch: lt } },
      body: { by: BY, fields: { name: "Renamed", dr: 99, stage: "Negotiating" } }, expectStatus: 200 });
    await run("patch-partner", { name: "error-bad-stage", method: "PATCH", url: P("c-spare-1"),
      about: "Validation error: nothing is written.", setup: { [tag("c-spare-1")]: { stage: "New", last_touch: null } },
      body: { by: BY, fields: { stage: "Bogus" } }, expectStatus: 400 });
    await run("patch-partner", { name: "error-bad-date", method: "PATCH", url: P("c-spare-1"),
      about: "Validation error: nothing is written.", setup: { [tag("c-spare-1")]: { next_due: null, last_touch: null } },
      body: { by: BY, fields: { next_step: "Call them", next_due: "31/10/2026" } }, expectStatus: 400 });
    await run("patch-partner", { name: "error-not-found", method: "PATCH", url: "/api/partner/PG-99999",
      about: "Unknown id.", body: { by: BY, fields: { stage: "Contacted" } }, expectStatus: 404 });

    // ---- POST /api/partner/:id/activity (kind activity) ----
    await run("activity-log", { name: "interested", method: "POST", url: P("c-interested") + "/activity",
      about: "The activity half of the Interested outcome, on the row patch-partner#interested leaves. Email also sets partners.last_touch (no edits row for that).",
      setup: { [tag("c-interested")]: { stage: "Negotiating", owner: "Tomas", next_step: "Agree terms", next_due: "2026-11-04", last_touch: lt } },
      body: { by: BY, type: "Email", summary: "Interested. Wants the media kit.", client: "Soro" }, expectStatus: 201 });
    await run("activity-log", { name: "note-with-contact", method: "POST", url: P("c-note") + "/activity",
      about: "A note about one contact: contact_id is kept on the activity and the edits row. Note does not touch last_touch.",
      setup: { [tag("c-note")]: { last_touch: lt } },
      body: { by: BY, type: "Note", summary: "Asked for rates.", contact_id: contactOf("c-note"), client: "MailerLite" }, expectStatus: 201 });
    await run("activity-log", { name: "deal-update-no-client", method: "POST", url: P("c-deal") + "/activity",
      about: "No client in the request: client is null in the activity and in the JSON.",
      setup: { [tag("c-deal")]: { last_touch: lt } },
      body: { by: BY, type: "Deal update", summary: "Countered: Flat fee $1,200." }, expectStatus: 201 });
    await run("activity-log", { name: "content-live", method: "POST", url: P("c-live") + "/activity",
      about: "Placement is live: the summary is the link.", setup: { [tag("c-live")]: { last_touch: lt } },
      body: { by: BY, type: "Content live", summary: "https://c-live.contract.example.test/post", client: "Soro" }, expectStatus: 201 });
    await run("activity-log", { name: "call-sets-last-touch", method: "POST", url: P("c-spare-4") + "/activity",
      about: "Call (like Email and Meeting) sets partners.last_touch to the server's date.", setup: { [tag("c-spare-4")]: { last_touch: lt } },
      body: { by: BY, type: "Call", summary: "Talked about next year.", client: "" }, expectStatus: 201 });
    await run("activity-log", { name: "error-bad-type", method: "POST", url: P("c-spare-4") + "/activity",
      about: "Validation error: nothing is written.", body: { by: BY, type: "Tweet", summary: "x" }, expectStatus: 400 });
    await run("activity-log", { name: "error-empty-summary", method: "POST", url: P("c-spare-4") + "/activity",
      about: "Validation error: nothing is written.", body: { by: BY, type: "Note", summary: "  " }, expectStatus: 400 });
    await run("activity-log", { name: "error-not-found", method: "POST", url: "/api/partner/PG-99999/activity",
      about: "Unknown id.", body: { by: BY, type: "Note", summary: "x" }, expectStatus: 404 });

    // ---- POST /api/bulk (kind update) ----
    const bulkIds = ["c-bulk-a", "c-bulk-b", "c-bulk-c"].map(tag);
    const bulkSetup = {
      [tag("c-bulk-a")]: { stage: "New", owner: "Mantvydas", clients: "Weglot, Ultahost", next_due: null, last_touch: null },
      [tag("c-bulk-b")]: { stage: "New", owner: null, clients: null, next_due: null, last_touch: null },
      [tag("c-bulk-c")]: { stage: "Contacted", owner: "Gaby", clients: "soro", next_due: null, last_touch: lt },
    };
    await run("bulk-update", { name: "owner-and-stage", method: "POST", url: "/api/bulk", ids: bulkIds, setup: bulkSetup,
      about: "Owner and stage on 3 sites; the third already has both, so it writes nothing (changed = 2).",
      body: { by: BY, ids: bulkIds, fields: { owner: "Gaby", stage: "Contacted" } }, expectStatus: 200 });
    await run("bulk-update", { name: "add-client", method: "POST", url: "/api/bulk", ids: bulkIds, setup: bulkSetup,
      about: "Add client Soro: appended with \", \"; a site that already has it (any case) is unchanged. No slash values here: the d5e91d9 rewrite of \"a/b\" to \"a, b\" is a known bug the redesign fixes (T12).",
      body: { by: BY, ids: bulkIds, fields: { add_client: "Soro" } }, expectStatus: 200 });
    const dueIds = ["c-bulk-e", "c-bulk-f"].map(tag);
    await run("bulk-update", { name: "next-due", method: "POST", url: "/api/bulk", ids: dueIds,
      setup: { [dueIds[0]]: { next_due: "2026-11-01", last_touch: lt }, [dueIds[1]]: { next_due: null, last_touch: lt } },
      about: "A follow-up date on 2 sites.", body: { by: BY, ids: dueIds, fields: { next_due: "2026-11-09" } }, expectStatus: 200 });
    await run("bulk-update", { name: "nothing-changes", method: "POST", url: "/api/bulk", ids: [tag("c-bulk-d")],
      setup: { [tag("c-bulk-d")]: { stage: "Researching", last_touch: null } },
      about: "Same stage: no rows, changed = 0.", body: { by: BY, ids: [tag("c-bulk-d")], fields: { stage: "Researching" } }, expectStatus: 200 });
    await run("bulk-update", { name: "error-no-ids", method: "POST", url: "/api/bulk",
      about: "Validation error.", body: { by: BY, ids: [], fields: { owner: "Gaby" } }, expectStatus: 400 });
    await run("bulk-update", { name: "error-nothing-to-change", method: "POST", url: "/api/bulk",
      about: "Validation error.", body: { by: BY, ids: [tag("c-bulk-d")], fields: {} }, expectStatus: 400 });
    await run("bulk-update", { name: "error-bad-stage", method: "POST", url: "/api/bulk", ids: [tag("c-bulk-d")],
      about: "Validation error: nothing is written.", body: { by: BY, ids: [tag("c-bulk-d")], fields: { stage: "Bogus" } }, expectStatus: 400 });

    // ---- POST /api/partners (Add site, kind create_account) ----
    await run("add-site", { name: "full", method: "POST", url: "/api/partners",
      about: "Every field: the URL is cleaned to the host, clients re-joined, the edits JSON keeps the key order domain, name, stage, owner, clients, type, next_step, next_due, notes, added.",
      body: { by: BY, domain: "https://www.Golden-Full.example.test/path?x=1", name: "Golden Full Site", owner: "Kamile", stage: "Contacted",
        clients: "Soro,UltaHost", type: "Review", next_step: "Follow up if no reply", next_due: "2026-11-05", notes: "Met at a meetup." }, expectStatus: 201 });
    await run("add-site", { name: "name-only", method: "POST", url: "/api/partners",
      about: "A creator with only a name: domain is \"\" in the JSON and NULL in partners; owner defaults to by; stage New; notes \"\".",
      body: { by: BY, name: "Golden Creator" }, expectStatus: 201 });
    await run("add-site", { name: "duplicate", method: "POST", url: "/api/partners",
      about: "The site is already in the CRM: 409 with the duplicates, nothing written.",
      body: { by: BY, domain: "https://www.dupe.example.test/a/b?x=1", name: "Dupe Again" }, expectStatus: 409 });
    await run("add-site", { name: "duplicate-forced", method: "POST", url: "/api/partners",
      about: "Add anyway (force): written like any other new site.",
      body: { by: BY, domain: "dupe.example.test", name: "Dupe Again", force: true }, expectStatus: 201 });
    await run("add-site", { name: "error-bad-domain", method: "POST", url: "/api/partners",
      about: "Validation error.", body: { by: BY, domain: "not a domain", name: "X" }, expectStatus: 400 });
    await run("add-site", { name: "error-empty", method: "POST", url: "/api/partners",
      about: "Validation error.", body: { by: BY }, expectStatus: 400 });

    // ---- POST /api/partner/:id/contacts (Add contact, kind create_contact) ----
    await run("add-contact", { name: "full", method: "POST", url: P("c-contact-2") + "/contacts",
      about: "Every field: the email is lower-cased; the edits JSON keeps the key order first_name, last_name, title, email, linkedin, client.",
      body: { by: BY, first_name: "Gil", last_name: "Golden", title: "Editor", email: "Gil.Golden@C-Contact-2.contract.example.test",
        linkedin: "https://linkedin.example.test/in/gil-golden", client: "Soro" }, expectStatus: 201 });
    await run("add-contact", { name: "name-only", method: "POST", url: P("c-contact-2") + "/contacts",
      about: "Only a first name: last_name, email and linkedin are \"\" in the JSON, title and client null.",
      body: { by: BY, first_name: "Nameonly" }, expectStatus: 201 });
    await run("add-contact", { name: "duplicate", method: "POST", url: P("c-contact") + "/contacts",
      about: "The exact address is already a contact: 409 with the duplicate, nothing written.",
      body: { by: BY, first_name: "Dupe", email: "dupe-contact@contract.example.test" }, expectStatus: 409 });
    await run("add-contact", { name: "duplicate-forced", method: "POST", url: P("c-contact") + "/contacts",
      about: "Add anyway (force): written like any other new contact.",
      body: { by: BY, first_name: "Dupe", email: "dupe-contact@contract.example.test", force: true }, expectStatus: 201 });
    await run("add-contact", { name: "error-bad-email", method: "POST", url: P("c-contact") + "/contacts",
      about: "Validation error.", body: { by: BY, email: "not-an-email" }, expectStatus: 400 });
    await run("add-contact", { name: "error-empty", method: "POST", url: P("c-contact") + "/contacts",
      about: "Validation error.", body: { by: BY, title: "Editor" }, expectStatus: 400 });
    await run("add-contact", { name: "error-bad-linkedin", method: "POST", url: P("c-contact") + "/contacts",
      about: "Validation error.", body: { by: BY, first_name: "Lin", linkedin: "linkedin.example.test/in/lin" }, expectStatus: 400 });
    await run("add-contact", { name: "error-not-found", method: "POST", url: "/api/partner/PG-99999/contacts",
      about: "Unknown id.", body: { by: BY, first_name: "Nobody" }, expectStatus: 404 });

    // ---- PUT /api/clients/:k (kind client_program) ----
    await run("client-program", { name: "soro-full", method: "PUT", url: "/api/clients/soro",
      about: "Every field. Full replace; the edits JSON keeps the key order network, commission, payout_terms, signup_url, brief, cookie_days (a number).",
      body: { by: BY, network: "Impact", commission: "30% recurring for 12 months", cookie_days: "60", payout_terms: "Monthly, net 30",
        signup_url: "https://soro.example.test/partners", brief: "AI SEO content platform." }, expectStatus: 200 });
    await run("client-program", { name: "partial", method: "PUT", url: "/api/clients/soro",
      about: "Omitted fields become null (full replace); an empty cookie length is null.",
      body: { by: BY, network: "ShareASale", cookie_days: "" }, expectStatus: 200 });
    await run("client-program", { name: "key-with-space-d5e91d9-bug", method: "PUT", url: "/api/clients/botanical%20synthesis",
      about: "KNOWN BUG on d5e91d9, not a contract: the route receives the raw \"botanical%20synthesis\" (encodeURIComponent, as the old page sends it) and answers 400 \"Unknown client.\", so no program with a space in its key can be saved. T23 needs the redesign to decode the key; the row it must then write is client-program#partial with field \"botanical synthesis\" (see README).",
      body: { by: BY, network: "ShareASale", cookie_days: "" }, expectStatus: 400 });
    await run("client-program", { name: "error-bad-link", method: "PUT", url: "/api/clients/soro",
      about: "Validation error.", body: { by: BY, signup_url: "soro.example.test" }, expectStatus: 400 });
    await run("client-program", { name: "error-bad-cookie", method: "PUT", url: "/api/clients/soro",
      about: "Validation error.", body: { by: BY, cookie_days: "forever" }, expectStatus: 400 });
    await run("client-program", { name: "error-bad-key", method: "PUT", url: "/api/clients/so!ro",
      about: "Validation error.", body: { by: BY, network: "X" }, expectStatus: 400 });
  } finally {
    await server.stop();
  }

  const meta = {
    "patch-partner": { write_path: "PATCH /api/partner/:id", kind: "update", row_order: "request" },
    "activity-log": { write_path: "POST /api/partner/:id/activity", kind: "activity", row_order: "request" },
    "bulk-update": { write_path: "POST /api/bulk", kind: "update", row_order: "any (compare after sortEdits: account_id, then field)" },
    "add-site": { write_path: "POST /api/partners", kind: "create_account", row_order: "request" },
    "add-contact": { write_path: "POST /api/partner/:id/contacts", kind: "create_contact", row_order: "request" },
    "client-program": { write_path: "PUT /api/clients/:k", kind: "client_program", row_order: "request" },
  };
  fs.mkdirSync(o.out, { recursive: true });
  for (const [name, cases] of Object.entries(files)) {
    const doc = { ...meta[name], captured_from: commit.slice(0, 7), captured_commit: commit, fixture: "tests/fixtures/make-seed.mjs v" + FIXTURE_VERSION,
      by: BY, cases };
    fs.writeFileSync(path.join(o.out, name + ".json"), JSON.stringify(doc, null, 1) + "\n");
    console.error("capture: wrote " + path.join(o.out, name + ".json"));
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
