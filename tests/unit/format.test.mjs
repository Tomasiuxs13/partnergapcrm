// Unit tests for js/core/format.js (spec 5.4, Appendix B "days", Appendix C dates). Owner G1-D.
// Only behaviour the spec fixes is asserted strictly; where it leaves the exact words open (ago, due
// texts, plural with or without the number) the checks accept any reasonable wording.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import * as F from "../../crm/dashboard/js/core/format.js";
import { cleanDomain } from "../../lib/crm.js";

const FORMAT_URL = new URL("../../crm/dashboard/js/core/format.js", import.meta.url).href;

test("num, money and pct", () => {
  assert.equal(F.num(7403), "7,403");
  assert.equal(F.num(1234567), "1,234,567");
  assert.equal(F.num(0), "0");
  assert.equal(F.num(42), "42");
  assert.equal(F.num(null), "");
  assert.equal(F.num(""), "");
  assert.equal(F.money(1200), "$1,200");
  assert.equal(F.money(350), "$350");
  assert.equal(F.money(2500.55), "$2,500.55");
  assert.equal(F.money(null), "");
  assert.equal(F.money(""), "");
  assert.equal(F.pct(30), "30%");
  assert.equal(F.pct(12.5), "12.5%");
  assert.equal(F.pct(null), "");
});

test("date: 'Thu 22 Oct' by default (Appendix C), long style for the Today subtitle", () => {
  assert.equal(F.date("2026-10-22"), "Thu 22 Oct");
  assert.equal(F.date("2026-10-22", "short"), "Thu 22 Oct");
  assert.equal(F.date("2026-10-19"), "Mon 19 Oct");
  assert.equal(F.date("2027-01-01"), "Fri 1 Jan");
  assert.equal(F.date("2026-10-19", "long"), "Monday 19 October");
  // A timestamp shows its local calendar day (noon UTC is the same day from UTC-11 to UTC+11).
  assert.equal(F.date("2026-10-22T12:00:00Z"), "Thu 22 Oct");
  assert.equal(F.date(""), "");
  assert.equal(F.date(null), "");
  assert.equal(F.date(undefined), "");
  assert.equal(F.date("not a date"), "");
});

test("daysBetween(a, b) counts calendar days from a to b", () => {
  assert.equal(F.daysBetween("2026-10-20", "2026-10-22"), 2);
  assert.equal(F.daysBetween("2026-10-22", "2026-10-20"), -2);
  assert.equal(F.daysBetween("2026-10-22", "2026-10-22"), 0);
  assert.equal(F.daysBetween("2026-09-30", "2026-10-22"), 22);
  assert.equal(F.daysBetween("2026-12-31", "2027-01-01"), 1);
  assert.equal(F.daysBetween("2028-02-28", "2028-03-01"), 2, "leap year");
  // Across the end of summer time (25 Oct 2026 in Europe): still whole days.
  assert.equal(F.daysBetween("2026-10-24", "2026-10-26"), 2);
  assert.equal(F.daysBetween("2026-03-28", "2026-03-30"), 2);
  assert.equal(F.daysBetween(null, "2026-10-22"), null);
  assert.equal(F.daysBetween("2026-10-22", null), null);
  assert.equal(F.daysBetween("", ""), null);
});

test("ago(iso, today)", () => {
  assert.match(F.ago("2026-10-10", "2026-10-22"), /\b12\s*d/);
  assert.match(F.ago("2026-10-22", "2026-10-22"), /today/i);
  assert.equal(F.ago(null, "2026-10-22"), "");
  assert.equal(F.ago("", "2026-10-22"), "");
});

test("addDays: calendar days with month, year and leap-day rollover", () => {
  assert.equal(F.addDays("2026-10-30", 7), "2026-11-06");
  assert.equal(F.addDays("2026-10-31", 1), "2026-11-01");
  assert.equal(F.addDays("2026-12-31", 1), "2027-01-01");
  assert.equal(F.addDays("2028-02-28", 1), "2028-02-29");
  assert.equal(F.addDays("2026-03-01", -1), "2026-02-28");
  assert.equal(F.addDays("2026-10-24", 2), "2026-10-26", "across the end of summer time");
  assert.equal(F.addDays("2026-10-30", 30), "2026-11-29");
});

test("addWorkingDays skips Saturdays and Sundays", () => {
  assert.equal(F.addWorkingDays("2026-10-30", 3), "2026-11-04", "Fri + 3 = Wed (the T3 / golden Interested date)");
  assert.equal(F.addWorkingDays("2026-10-30", 1), "2026-11-02", "Fri + 1 = Mon");
  assert.equal(F.addWorkingDays("2026-10-31", 1), "2026-11-02", "Sat + 1 = Mon");
  assert.equal(F.addWorkingDays("2026-11-01", 1), "2026-11-02", "Sun + 1 = Mon");
  assert.equal(F.addWorkingDays("2026-10-22", 2), "2026-10-26", "Thu + 2 = Mon");
  assert.equal(F.addWorkingDays("2026-10-19", 3), "2026-10-22", "Mon + 3 = Thu");
  assert.equal(F.addWorkingDays("2026-12-31", 1), "2027-01-01", "Thu + 1 = Fri across the year");
});

test("nextMonday is the first Monday after the date", () => {
  assert.equal(F.nextMonday("2026-10-22"), "2026-10-26", "Thu");
  assert.equal(F.nextMonday("2026-10-24"), "2026-10-26", "Sat");
  assert.equal(F.nextMonday("2026-10-25"), "2026-10-26", "Sun");
  assert.equal(F.nextMonday("2026-10-26"), "2026-11-02", "a Monday gives the Monday after");
  assert.equal(F.nextMonday("2026-12-30"), "2027-01-04");
});

test("dueLabel tones", () => {
  const today = "2026-10-22";
  const over = F.dueLabel("2026-10-19", today);
  assert.equal(over.tone, "overdue");
  assert.match(over.text, /3/);
  const now = F.dueLabel(today, today);
  assert.equal(now.tone, "today");
  assert.match(now.text, /today/i);
  assert.equal(F.dueLabel("2026-10-23", today).tone, "soon");
  assert.equal(F.dueLabel("2026-12-21", today).tone, "later");
  assert.equal(F.dueLabel(null, today).text, "");
});

test("initials", () => {
  assert.equal(F.initials("Jonas Vik"), "JV");
  assert.equal(F.initials("ann smith"), "AS");
  assert.equal(F.initials("Kamile"), "K");
  assert.equal(F.initials("mashable.com"), "M");
  assert.equal(F.initials("Mr. Money Matters").length, 2);
});

test("normDomain follows lib/crm.js cleanDomain", () => {
  const cases = [
    ["https://www.dupe.example.test/a/b?x=1", "dupe.example.test"],
    ["dupe.example.test", "dupe.example.test"],
    ["HTTP://M.Dupe.Example.Test", "dupe.example.test"],
    ["  sub.x.example.test  ", "sub.x.example.test"],
    ["x.example.test#contact", "x.example.test"],
    ["http://x.example.test?utm=1", "x.example.test"],
    ["https://youtube.com/@pgfixture-channel/videos", "youtube.com/@pgfixture-channel"],
    ["https://www.youtube.com/channel/UCabc123/featured", "youtube.com/channel/ucabc123"],
    ["https://www.instagram.com/someone/", "instagram.com/someone"],
    ["https://youtube.com", "youtube.com"],
    ["rob@x.example.test", ""],
    ["not a domain", ""],
    ["", ""],
  ];
  for (const [input, want] of cases) {
    assert.equal(F.normDomain(input), want, JSON.stringify(input));
    assert.equal(F.normDomain(input), cleanDomain(input), "same as cleanDomain for " + JSON.stringify(input));
  }
  assert.equal(F.normDomain(null), "");
});

test("normName: lower-case, punctuation removed, spaces collapsed", () => {
  assert.equal(F.normName("Mr. Money Matters"), "mr money matters");
  assert.equal(F.normName("  THE   Hub  "), "the hub");
  assert.equal(F.normName("Melograno - Trafft"), "melograno trafft");
  assert.equal(F.normName("hub.example.test"), "hub example test");
  assert.equal(F.normName(null), "");
  assert.ok(F.normName("Mr. Money Matters").includes(F.normName("mr money")), "T10: 'mr money' finds Mr. Money Matters");
});

test("plural picks the word by count", () => {
  const one = F.plural(1, "site", "sites");
  const many = F.plural(2, "site", "sites");
  const none = F.plural(0, "site", "sites");
  assert.ok(one.endsWith("site") && !one.endsWith("sites"), one);
  assert.ok(many.endsWith("sites"), many);
  assert.ok(none.endsWith("sites"), none);
});

test("todayIso is the local calendar date", () => {
  const p = (n) => String(n).padStart(2, "0");
  const local = (d) => d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate());
  const before = local(new Date());
  const got = F.todayIso();
  const after = local(new Date());
  assert.match(got, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(got === before || got === after, got);
});

// The date helpers must not depend on the machine's time zone. Run them in two zones with summer
// time (Vilnius ends it on 25 Oct, Los Angeles on 1 Nov) and in a far-east zone.
test("date helpers give the same answers in other time zones", () => {
  const code = `
    import * as F from ${JSON.stringify(FORMAT_URL)};
    const out = {
      d1: F.daysBetween("2026-10-24", "2026-10-26"), d2: F.daysBetween("2026-10-31", "2026-11-02"),
      d3: F.daysBetween("2026-03-28", "2026-03-30"),
      a1: F.addDays("2026-10-24", 2), a2: F.addDays("2026-10-31", 2), a3: F.addDays("2026-10-30", 30),
      w1: F.addWorkingDays("2026-10-30", 3), w2: F.addWorkingDays("2026-10-23", 1),
      m1: F.nextMonday("2026-10-24"), m2: F.nextMonday("2026-10-31"),
      s1: F.date("2026-10-25"), s2: F.date("2026-11-01"),
      t1: F.dueLabel("2026-10-26", "2026-10-24").tone,
    };
    process.stdout.write(JSON.stringify(out));`;
  const want = { d1: 2, d2: 2, d3: 2, a1: "2026-10-26", a2: "2026-11-02", a3: "2026-11-29", w1: "2026-11-04", w2: "2026-10-26",
    m1: "2026-10-26", m2: "2026-11-02", s1: "Sun 25 Oct", s2: "Sun 1 Nov", t1: "soon" };
  for (const tz of ["Europe/Vilnius", "America/Los_Angeles", "Pacific/Kiritimati"]) {
    const r = spawnSync(process.execPath, ["--input-type=module", "-e", code], {
      env: { ...process.env, TZ: tz }, encoding: "utf8", cwd: fileURLToPath(new URL(".", import.meta.url)),
    });
    assert.equal(r.status, 0, tz + ": " + r.stderr);
    assert.deepEqual(JSON.parse(r.stdout), want, tz);
  }
});
