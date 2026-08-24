import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { assertPublicHttpUrl } from "./fetchSource";
import { eventUid, eventsToIcs, isValidVCalendar } from "./ics";
import { htmlToText, parseSourceText } from "./parseSource";
import {
  FREE_WATCH_LIMIT,
  getWatch,
  sourceUrlFromWatchId,
  watchIdFromSourceUrl,
} from "./store";
import { feedPaths, getFeedIcs, previewUrl, refreshWatch, watchUrl } from "./watch";
import type { ParsedEvent } from "./types";

describe("assertPublicHttpUrl", () => {
  it("rejects image/screenshot URLs with a clear 400 (no empty feed)", () => {
    const images = [
      "https://cdn.example.com/shot.png",
      "https://cdn.example.com/photo.JPG",
      "https://cdn.example.com/a.jpeg",
      "https://cdn.example.com/x.gif",
      "https://cdn.example.com/y.webp?w=800",
    ];
    for (const href of images) {
      let threw = false;
      try {
        assertPublicHttpUrl(href);
      } catch (err: unknown) {
        threw = true;
        const e = err as Error & { status?: number };
        assert.equal(e.status, 400);
        assert.match(e.message, /Image URLs are not supported/i);
        assert.match(e.message, /page or PDF/i);
        assert.doesNotMatch(e.message, /No dated events|0 event/i);
      }
      assert.equal(threw, true, href);
    }
  });

  it("still allows page and PDF URLs", () => {
    assert.equal(
      assertPublicHttpUrl("https://example.com/school-calendar").href,
      "https://example.com/school-calendar"
    );
    assert.equal(
      assertPublicHttpUrl(
        "https://example.com/uploads/Calendar_2026.pdf"
      ).pathname,
      "/uploads/Calendar_2026.pdf"
    );
  });

  it("keeps rejecting data: and non-http schemes", () => {
    assert.throws(() => assertPublicHttpUrl("data:image/png;base64,aaa"), /http/i);
    assert.throws(() => assertPublicHttpUrl("file:///tmp/x.pdf"), /http/i);
    assert.throws(() => assertPublicHttpUrl("ftp://example.com/a.pdf"), /http/i);
  });
});

describe("homepage examples and copy", () => {
  it("extra examples preview via /api/preview; free example may create a watch", async () => {
    const page = await readFile(
      path.join(process.cwd(), "app/page.tsx"),
      "utf8"
    );
    assert.match(page, /feedId\?/);
    assert.match(page, /if \(example\.feedId\)/);
    assert.match(page, /void createWatch\(example\.url\)/);
    assert.match(page, /void previewExample\(example\.url\)/);
    assert.match(page, /\/api\/preview/);
    // Extra tiles must not POST /api/watches — that 402 + existing feed looked like a parse fail
    assert.match(
      page,
      /never POST \/api\/watches|Extra examples preview/i
    );
    // 402 must not hydrate the free watch under the new URL
    assert.doesNotMatch(
      page,
      /rememberWatch\(\{\s*id: data\.payload\.existing_id/
    );
    assert.match(
      page,
      /Do not hydrate the free watch|looks like a failed parse/
    );
    // 402 error must use parent pay-once words, not engineer jargon
    assert.match(page, /First calendar free\. Another school is \$5 once/);
    assert.match(
      page,
      /if \(res\.status === 402 \|\| res\.status === 403\) \{\s*setNeedsExtraWatch\(true\);\s*setError\(/
    );
  });

  it("WC tile is terms + planning (partial); Stithians Extra stays hidden", async () => {
    const page = await readFile(
      path.join(process.cwd(), "app/page.tsx"),
      "utf8"
    );
    // Extra / $5 label wiring — Ridgewood ships; Stithians stays omitted
    assert.match(
      page,
      /!example\.feedId && \(\s*<span className="example-extra"> Extra \/ \$5<\/span>/
    );
    assert.match(page, /Ridgewood College terms \+ holidays 2026/);
    assert.match(page, /ridgewoodcollege\.co\.za\/term-dates\//);
    assert.doesNotMatch(page, /Ridgewood College terms 2026(?!\s*\+)/);
    // Stithians PDF is not the calendar a parent would read yet — tile omitted
    assert.doesNotMatch(page, /School calendar \(St /);
    assert.doesNotMatch(
      page,
      /stithian\.com\/uploads\/files\/St_Stithians_College_Calendar_2026/
    );
    // NSC exam URLs are other pages — not tiled on the homepage (scraped into WC watch)
    assert.doesNotMatch(page, /NSC exams/);
    assert.doesNotMatch(
      page,
      /url:\s*"https:\/\/www\.education\.gov\.za/
    );
    assert.doesNotMatch(page, /wikipedia\.org/i);
    assert.match(page, /feedId: WESTERN_CAPE_FEED_ID/);
    assert.match(page, /Western Cape terms \+ planning \(partial\)/);
    assert.doesNotMatch(page, /Western Cape calendar/i);
    assert.doesNotMatch(page, /term open\/close \(partial\)/);
  });

  it("copy invites a public https link; dates land in the phone calendar", async () => {
    const page = await readFile(
      path.join(process.cwd(), "app/page.tsx"),
      "utf8"
    );
    const layout = await readFile(
      path.join(process.cwd(), "app/layout.tsx"),
      "utf8"
    );
    assert.match(page, /public https link \(page or PDF URL\)/i);
    assert.match(page, /Public https link/);
    assert.match(page, /dates land in your phone\s*calendar/i);
    assert.match(page, /stay updated/i);
    assert.doesNotMatch(page, /\bpoll\b/i);
    assert.doesNotMatch(page, /Paste a public page or PDF(?! URL)/i);
    assert.doesNotMatch(page, /photo OCR|type=["']file["']/i);
    assert.match(page, /onPaste=\{onUrlPaste\}/);
    assert.match(
      page,
      /Use a public https link to a page or PDF — not a screenshot or photo/
    );
    assert.match(layout, /public https link \(page or PDF URL\)/i);
    assert.match(layout, /dates land in your phone calendar/i);
    // Single URL text field only
    assert.equal((page.match(/type="url"/g) || []).length, 1);
    assert.doesNotMatch(page, /type=["']file["']/);
  });

  it("Add to phone keeps webcal/https hrefs; footer is parent $5 once (not Polar SaaS)", async () => {
    const page = await readFile(
      path.join(process.cwd(), "app/page.tsx"),
      "utf8"
    );
    assert.match(page, /Add to phone:/);
    assert.match(page, /href=\{feedLinks\.webcal_url\}/);
    assert.match(page, /href=\{feedLinks\.https_url\}/);
    assert.doesNotMatch(page, /Already live:/);
    assert.match(page, /First calendar free\. Another school is \$5 once\./);
    assert.doesNotMatch(page, /billed SaaS|pay-once Polar/i);
    assert.doesNotMatch(page, /Dry-run preview|quota untouched|this instance/i);
    assert.doesNotMatch(page, /· id \{watch\.id\}/);
  });

  it("after extra preview, shows pay-once checkout CTA (no dead-end)", async () => {
    const page = await readFile(
      path.join(process.cwd(), "app/page.tsx"),
      "utf8"
    );
    assert.match(page, /setPreview\(data\.payload\)/);
    assert.match(page, /setNeedsExtraWatch\(true\)/);
    assert.match(
      page,
      /preview-checkout|preview && \([\s\S]*Pay \$5 once for another school/
    );
    assert.match(page, /First calendar free/);
    assert.match(page, /\$5 once/);
    assert.match(page, /startExtraWatchCheckout/);
    assert.match(page, /\/api\/polar\/checkout/);
    // Preview path must not mint a watch
    assert.match(
      page,
      /never POST \/api\/watches|Extra examples preview/i
    );
  });

  it("successful watch shows parent-facing checked / last-changed freshness", async () => {
    const page = await readFile(
      path.join(process.cwd(), "app/page.tsx"),
      "utf8"
    );
    assert.match(page, /last_fetched_at/);
    assert.match(page, /last_changed_at/);
    assert.match(page, /Checked just now/);
    assert.match(page, /Updated when the school page last changed/);
    assert.match(page, /parentRelativeTime|freshness/);
  });
});

describe("ics", () => {
  it("emits a valid VCALENDAR with stable UIDs", () => {
    const events: ParsedEvent[] = [
      {
        summary: "Term starts",
        description: "First day",
        start: "2026-01-15T00:00:00.000Z",
        end: "2026-01-16T00:00:00.000Z",
        allDay: true,
      },
    ];
    const ics = eventsToIcs("abc123", "School terms", events, new Date("2026-01-01T12:00:00Z"));
    assert.equal(isValidVCalendar(ics), true);
    assert.match(ics, /BEGIN:VCALENDAR/);
    assert.match(ics, /VERSION:2\.0/);
    assert.match(ics, /PRODID:-\/\/WatchCal\/\/EN/);
    assert.match(ics, /BEGIN:VEVENT/);
    assert.match(ics, /END:VCALENDAR/);

    const uid = eventUid("abc123", events[0], 0);
    assert.equal(eventUid("abc123", events[0], 0), uid);
    assert.match(ics, new RegExp(`UID:${uid}`));
  });

  it("still emits a valid calendar when parse is thin", () => {
    const ics = eventsToIcs("thin1", "Empty page", [], new Date("2026-02-01T00:00:00Z"));
    assert.equal(isValidVCalendar(ics), true);
    assert.match(ics, /No dated events found yet/);
  });
});

describe("parseSource", () => {
  it("extracts real dates and titles from fixture HTML", () => {
    const html = `
      <html><head><title>Fixtures 2026</title></head>
      <body>
        <h1>Club fixtures</h1>
        <p>15 March 2026 Home vs North</p>
        <p>22 March 2026 Away vs South</p>
        <p>2026-04-01 Season opener</p>
      </body></html>
    `;
    const { title, text } = htmlToText(html);
    assert.equal(title, "Fixtures 2026");
    const { events } = parseSourceText(text, new Date("2026-01-10T00:00:00Z"));
    assert.ok(events.length >= 3);
    assert.ok(events.some((e) => /Home vs North/i.test(e.summary)));
    assert.ok(events.some((e) => /Away vs South/i.test(e.summary)));
    assert.ok(events.some((e) => /Season opener/i.test(e.summary)));
    assert.ok(events.every((e) => e.summary !== "Watched event"));
    const march15 = events.find((e) => /Home vs North/i.test(e.summary));
    assert.ok(march15);
    assert.match(march15!.start, /^2026-03-15/);
  });

  it("does not invent 2027-01-01 from ToC outline headings like 1.1 January", () => {
    const html = `
      <html><head><title>2026 - Encyclopedia</title></head>
      <body>
        <nav>
          <h2>Contents</h2>
          <button>move to sidebar</button>
          <ul>
            <li>1 Events</li>
            <li>1.1 January</li>
            <li>1.2 February</li>
            <li>1.3 March</li>
          </ul>
        </nav>
        <p>Log in</p>
        <h1>2026</h1>
        <h2>1.1 January</h2>
        <p>Overview of the year with no calendar dates.</p>
        <h2>1.2 February</h2>
      </body></html>
    `;
    const { text } = htmlToText(html);
    const { events } = parseSourceText(text, new Date("2026-08-22T00:00:00Z"));
    assert.equal(events.length, 0);
    assert.ok(events.every((e) => !e.start.startsWith("2027-01-01")));
    assert.doesNotMatch(text + events.map((e) => e.summary).join(""), /Watched event/);
  });

  it("never emits SUMMARY Watched event for dated fixtures", () => {
    const text = [
      "School calendar",
      "Term A starts 10 April 2026",
      "Log in",
      "Contents",
      "move to sidebar",
      "Break begins 20 December 2026",
    ].join("\n");
    const { events } = parseSourceText(text, new Date("2026-01-01T00:00:00Z"));
    assert.ok(events.length >= 2);
    for (const e of events) {
      assert.notEqual(e.summary, "Watched event");
      assert.doesNotMatch(e.description, /^(Log in|Contents|move to sidebar)/i);
    }
  });

  it("inherits document year for DBE-style ranges and holiday lines", () => {
    const text = [
      "SUMMARY OF 2026 CALENDAR FOR PUBLIC SCHOOLS",
      "Public and School Holidays 2026",
      "01 JanuaryNew Year's Day",
      "21 MarchHuman Rights Day",
      "03 AprilGood Friday",
      "1(12) 14 January – 27 March1153 (55)053 (55)",
      "208 April – 26 June12583+154",
      "406 October – 09 (11) December 1047 (49)047(49)",
    ].join("\n");
    const { events } = parseSourceText(text, new Date("2026-01-10T00:00:00Z"), {
      sourceTitle: "Published 2026 School Calendar.pdf",
      sourceUrl:
        "https://www.education.gov.za/portals/0/documents/publications/2025/Published%202026%20School%20Calendar.pdf",
    });
    assert.ok(events.length >= 5, `expected several events, got ${events.length}`);
    assert.ok(events.every((e) => e.summary !== "Watched event"));

    const nye = events.find((e) => /New Year/i.test(e.summary));
    assert.ok(nye, "New Year's Day");
    assert.match(nye!.start, /^2026-01-01/);

    const humanRights = events.find((e) => /Human Rights/i.test(e.summary));
    assert.ok(humanRights);
    assert.match(humanRights!.start, /^2026-03-21/);

    const term1 = events.find(
      (e) =>
        e.start.startsWith("2026-01-14") &&
        (e.end.startsWith("2026-03-28") || e.end.startsWith("2026-03-27"))
    );
    assert.ok(term1, "Term range 14 January – 27 March 2026");
    // all-day exclusive end = day after 27 March
    assert.match(term1!.end, /^2026-03-28/);

    const term2 = events.find((e) => e.start.startsWith("2026-04-08"));
    assert.ok(term2, "Term range 08 April – 26 June");
    assert.match(term2!.end, /^2026-06-27/);

    const term4 = events.find((e) => e.start.startsWith("2026-10-06"));
    assert.ok(term4, "Term range 06 October – 09 December");
    assert.match(term4!.end, /^2026-12-10/);
  });

  it("still requires a year somehow — bare day+month without document year yields nothing", () => {
    const text = ["Club notes", "15 March Home vs North", "22 March Away"].join(
      "\n"
    );
    const { events } = parseSourceText(text, new Date("2026-01-10T00:00:00Z"));
    assert.equal(events.length, 0);
  });

  it("titles Western Cape Opens/Closes as Term N YYYY spans (not yearless open/close dots)", async () => {
    // Recorded htmlToText extract of https://www.westerncape.gov.za/education/school-calendar
    const text = await readFile(
      path.join(
        process.cwd(),
        "lib/fixtures/western-cape-school-calendar-extract.txt"
      ),
      "utf8"
    );
    const { events } = parseSourceText(text, new Date("2026-08-24T00:00:00Z"), {
      sourceTitle: "School Calendar | Western Cape Government",
      sourceUrl: "https://www.westerncape.gov.za/education/school-calendar",
    });

    // No yearless open/close rewrite
    for (const e of events) {
      assert.doesNotMatch(e.summary, /^Term \d+ opens/i);
      assert.doesNotMatch(e.summary, /^Term \d+ closes/i);
    }

    const t1Staff = events.find((e) => e.summary === "Term 1 2026 (staff)");
    const t1Learn = events.find((e) => e.summary === "Term 1 2026 (learners)");
    assert.ok(t1Staff, "Term 1 2026 staff span");
    assert.ok(t1Learn, "Term 1 2026 learners span");
    assert.match(t1Staff!.start, /^2026-01-12/);
    assert.match(t1Staff!.end, /^2026-03-28/); // exclusive day after 27 March
    assert.match(t1Learn!.start, /^2026-01-14/);
    assert.match(t1Learn!.end, /^2026-03-28/);

    const t2 = events.find((e) => e.summary === "Term 2 2026");
    assert.ok(t2);
    assert.match(t2!.start, /^2026-04-08/);
    assert.match(t2!.end, /^2026-06-27/);

    const t4Staff = events.find((e) => e.summary === "Term 4 2026 (staff)");
    const t4Learn = events.find((e) => e.summary === "Term 4 2026 (learners)");
    assert.ok(t4Staff);
    assert.ok(t4Learn);
    assert.match(t4Staff!.start, /^2026-10-06/);
    assert.match(t4Staff!.end, /^2026-12-12/); // day after 11 Dec
    assert.match(t4Learn!.end, /^2026-12-10/); // day after 9 Dec

    // 2026 vs 2027 do not collapse
    assert.ok(events.some((e) => e.summary === "Term 1 2027 (staff)"));
    assert.ok(events.some((e) => e.summary === "Term 2 2027"));
    assert.equal(
      events.filter((e) => e.summary === "Term 1 2026 (staff)").length,
      1
    );
    assert.equal(
      events.filter((e) => e.summary === "Term 1 2027 (staff)").length,
      1
    );

    const nye2026 = events.find((e) => e.summary === "New Year’s Day 2026");
    const nye2027 = events.find((e) => e.summary === "New Year’s Day 2027");
    assert.ok(nye2026, "holiday keeps 2026");
    assert.ok(nye2027, "holiday keeps 2027");
    assert.match(nye2026!.start, /^2026-01-01/);
    assert.match(nye2027!.start, /^2027-01-01/);
    assert.ok(events.some((e) => e.summary === "Good Friday 2026"));
    assert.ok(events.some((e) => e.summary === "Good Friday 2027"));
  });

  it("Western Cape planning PDF fixture emits titled observances (source wording)", async () => {
    const { parseWesternCapePlanningPdf } = await import("./parseSource");
    const extract = await readFile(
      path.join(
        process.cwd(),
        "lib/fixtures/western-cape-planning-2026-extract.txt"
      ),
      "utf8"
    );
    const events = parseWesternCapePlanningPdf(extract);
    assert.ok(events.length > 0, "planning observances emit");
    assert.ok(events.some((e) => /Eid ul Fitr/i.test(e.summary)));
    assert.ok(events.some((e) => e.summary === "Passover"));
    assert.ok(events.some((e) => e.summary === "Diwali"));
    assert.ok(events.some((e) => e.summary === "Ascension Day"));
    for (const e of events) {
      assert.doesNotMatch(
        e.summary,
        /^(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)$/i
      );
      assert.match(e.start, /^2026-/);
    }
    // Not the full admin deadline calendar — only titled observances + parent rows
    assert.doesNotMatch(
      events.map((e) => e.summary).join("\n"),
      /Snap Survey|job descriptions|CEMIS|QMS|LTSM|sign off/i
    );
  });

  it("Western Cape school-calendar URL: HTML terms/holidays + planning parent MUST rows", async () => {
    const {
      parseWesternCapePlanningPdf,
      parseWesternCapeSchoolCalendarHtml,
      parseSourceText,
    } = await import("./parseSource");
    const html = await readFile(
      path.join(
        process.cwd(),
        "lib/fixtures/western-cape-school-calendar-extract.txt"
      ),
      "utf8"
    );
    const planning = await readFile(
      path.join(
        process.cwd(),
        "lib/fixtures/western-cape-planning-2026-extract.txt"
      ),
      "utf8"
    );
    const { events: fromHtml } = parseSourceText(html, new Date("2026-08-24T00:00:00Z"), {
      sourceTitle: "School Calendar | Western Cape Government",
      sourceUrl: "https://www.westerncape.gov.za/education/school-calendar",
    });
    // Same special-case path (terms as year spans)
    const { events: htmlDirect } = parseWesternCapeSchoolCalendarHtml(html);
    assert.equal(fromHtml.length, htmlDirect.length);

    const fromPlan = parseWesternCapePlanningPdf(planning);
    const events = [...fromHtml, ...fromPlan];

    // Keep term spans + full HTML holidays both years (no 40-cap truncation)
    assert.ok(events.some((e) => e.summary === "Term 1 2026 (learners)"));
    assert.ok(events.some((e) => e.summary === "Term 4 2027 (staff)"));
    assert.ok(events.some((e) => e.summary === "New Year’s Day 2026"));
    assert.ok(events.some((e) => e.summary === "New Year’s Day 2027"));
    assert.ok(events.some((e) => e.summary === "Day of Goodwill 2027"));
    assert.ok(events.some((e) => e.summary === "Public holiday 2027"));
    const holidays2027 = events.filter(
      (e) => /2027/.test(e.summary) && !/^Term\s/.test(e.summary)
    );
    assert.ok(
      holidays2027.length >= 14,
      `2027 holidays truncated? got ${holidays2027.length}`
    );

    // 14 religious observances from planning PDF
    const religious = fromPlan.filter((e) =>
      /(eid|passover|ascension|shavuot|rosh\s*hashana|yom\s*kippur|sukkot|shemini|diwali)/i.test(
        e.summary
      )
    );
    assert.equal(religious.length, 14, `expected 14 religious, got ${religious.length}`);

    function must(
      summaryRe: RegExp,
      startYmd: string,
      endYmd: string,
      label: string
    ) {
      const hit = events.find(
        (e) =>
          summaryRe.test(e.summary) &&
          e.start.startsWith(startYmd) &&
          e.end.startsWith(endYmd)
      );
      assert.ok(
        hit,
        `MUST missing: ${label} SUMMARY~${summaryRe} DTSTART ${startYmd} DTEND ${endYmd}`
      );
      return hit!;
    }

    // Parent-facing MUST rows (PDF wording / dates from English planning fixture)
    must(
      /^School admissions open for Grades R, 1 and 8$/,
      "2026-03-10",
      "2026-03-11",
      "admissions open R/1/8"
    );
    must(
      /^School admissions close for Grades R, 1 and 8$/,
      "2026-04-14",
      "2026-04-15",
      "admissions close R/1/8"
    );
    must(
      /^Parents informed of the outcome of online admission applications$/,
      "2026-05-28",
      "2026-06-11",
      "parents informed admissions"
    );
    must(
      /^Parents confirm acceptance of Grades R, 1 and 8 placements$/,
      "2026-05-28",
      "2026-06-16",
      "parents confirm placements"
    );
    must(
      /^School admissions open for transfer requests$/,
      "2026-08-03",
      "2026-08-04",
      "transfer open"
    );
    must(
      /^School admissions close for transfer requests$/,
      "2026-08-17",
      "2026-08-18",
      "transfer close"
    );
    must(
      /^Parents are informed of the outcome per email\/SMS$/,
      "2026-09-16",
      "2026-09-19",
      "parents informed transfers"
    );
    must(
      /^Release of the 2025 National Senior Certificate \(NSC\) examination results$/,
      "2026-01-13",
      "2026-01-14",
      "NSC 2025 results"
    );
    must(
      /^Closing date for registrations for May\/June 2026 NSC\/Senior Certificate \(SC\) examinations$/,
      "2026-01-27",
      "2026-01-28",
      "May/June NSC/SC reg close"
    );
    must(
      /^Closing date for registrations for November 2026 NSC examinations [–—−-] full-time candidates$/,
      "2026-03-13",
      "2026-03-14",
      "Nov NSC full-time reg close"
    );
    // #138 PDF is month-only ("May and June 2026") — must NOT invent 1 May–30 Jun
    const mayJune = events.filter((e) =>
      /May\/June NSC and SC examinations/i.test(e.summary)
    );
    for (const e of mayJune) {
      assert.notEqual(
        e.start.slice(0, 10),
        "2026-05-01",
        "May/June must not invent DTSTART 1 May"
      );
      assert.notEqual(
        e.end.slice(0, 10),
        "2026-07-01",
        "May/June must not invent DTEND 1 Jul"
      );
      assert.ok(
        /no exact days|month.?only|May and June 2026/i.test(e.summary),
        "if May/June emits, title must say PDF has no exact days"
      );
    }
    // Dropped (preferred): no calendar span without exact days
    assert.equal(
      mayJune.length,
      0,
      "May/June NSC/SC exams dropped — PDF has no exact days"
    );
    must(
      /^Grade 12 September trial examinations earliest start date$/,
      "2026-08-26",
      "2026-08-27",
      "trial earliest start"
    );
    must(
      /^Grade 12 September trial examinations end date$/,
      "2026-09-23",
      "2026-09-24",
      "trial end"
    );
    must(
      /^Closing date for parents to appeal the progression\/promotion results of their children$/,
      "2026-01-16",
      "2026-01-17",
      "progression appeal close"
    );

    // Next parent-usable batch (PDF wording / due-date column)
    must(
      /^Submit applications for NSC examination re-marks and rechecks$/,
      "2026-01-13",
      "2026-01-28",
      "#37 NSC re-mark/recheck window"
    );
    must(
      /^Principals communicate outcomes of progression\/promotion appeals to parents in writing$/,
      "2026-01-23",
      "2026-01-24",
      "#39 principals communicate appeal outcomes"
    );
    must(
      /^Closing date for parents dissatisfied with the outcome of their progression\/promotion appeals, to appeal to district directors$/,
      "2026-01-30",
      "2026-01-31",
      "#45 parent appeal to district directors"
    );
    must(
      /^Parents confirm acceptance of transfer placements$/,
      "2026-09-16",
      "2026-10-01",
      "#201 parents confirm transfer placements"
    );
    must(
      /^Grade 11 subject change applications by parents$/,
      "2026-03-27",
      "2026-03-28",
      "#58 Grade 11 subject change by parents"
    );
    must(
      /^Grade 10 subject change applications by parents$/,
      "2026-06-26",
      "2026-06-27",
      "#147 Grade 10 subject change by parents"
    );
    must(
      /^Subject change applications by parents of Grade 11 learners [–—−-] for Grade 12 year$/,
      "2026-12-11",
      "2026-12-12",
      "#280 Grade 11→12 subject change by parents"
    );

    // Next parent-usable batch (appeal / accommodation closes with real days)
    must(
      /^Submit assessment accommodation appeals for Grade 12$/,
      "2026-01-26",
      "2026-01-27",
      "#41 Grade 12 assessment accommodation appeals"
    );
    must(
      /^All appeals \(for progression and promotion results for Grades 1[–—−-]11 of 2025\) finalised$/,
      "2026-02-13",
      "2026-02-14",
      "#47 progression/promotion appeals finalised"
    );
    must(
      /^Applications for assessment accommodations for Grades R[–—−-]11 close$/,
      "2026-10-03",
      "2026-10-04",
      "#267 assessment accommodations applications close"
    );
    must(
      /^Submit assessment accommodations appeals for Grades 10[–—−-]11$/,
      "2026-11-06",
      "2026-11-07",
      "#271 Grades 10–11 assessment accommodations appeals"
    );
    must(
      /^Appeals for Grades 10[–—−-]11$/,
      "2026-11-06",
      "2026-11-07",
      "#286 Grades 10–11 appeals"
    );

    // Next parent-usable batch (system displays / systemic tests / enrichment deadlines)
    must(
      /^System displays the outcome of Grades R, 1 and 8 online admission applications$/,
      "2026-05-28",
      "2026-05-29",
      "#123 system displays R/1/8 admission outcomes"
    );
    must(
      /^System displays the outcome of transfer requests$/,
      "2026-09-16",
      "2026-09-17",
      "#199 system displays transfer outcomes"
    );
    must(
      /^Administration of WCED Systemic Tests for Grades 3, 6 and 9$/,
      "2026-10-12",
      "2026-10-28",
      "#238 WCED Systemic Tests Grades 3/6/9"
    );
    must(
      /^Election of Representative Councils of Learners \(RCLs\)$/,
      "2026-02-27",
      "2026-02-28",
      "#64 RCL elections"
    );
    must(
      /^South African Schools Choral Eisteddfod \(SASCE\) [–—−-] registration$/,
      "2026-03-27",
      "2026-03-28",
      "#68 SASCE registration"
    );
    must(
      /^Safe Schools Holiday Programme$/,
      "2026-03-30",
      "2026-04-03",
      "#69 Safe Schools Holiday Programme"
    );
    must(
      /^Safe Schools Holiday Programme$/,
      "2026-06-29",
      "2026-07-18",
      "#157 Safe Schools Holiday Programme"
    );
    must(
      /^Safe Schools Holiday Programme$/,
      "2026-09-25",
      "2026-10-03",
      "#227 Safe Schools Holiday Programme"
    );
    must(
      /^Safe Schools Holiday Programme$/,
      "2026-12-10",
      "2026-12-16",
      "#289 Safe Schools Holiday Programme"
    );
    must(
      /^Safe Schools' Back to School Drive$/,
      "2026-02-02",
      "2026-02-07",
      "#63 Safe Schools Back to School Drive"
    );
    must(
      /^MOOT Court [–—−-] workshop on essay writing \(virtual\)$/,
      "2026-04-20",
      "2026-04-21",
      "#151 MOOT Court essay workshop"
    );
    must(
      /^YCAP [–—−-] provincial workshop \(virtual\)$/,
      "2026-05-15",
      "2026-05-16",
      "#154 YCAP provincial workshop"
    );
    must(
      /^SASCE [–—−-] provincial round$/,
      "2026-05-28",
      "2026-06-01",
      "#156 SASCE provincial round"
    );
    must(
      /^SASCE [–—−-] national championship$/,
      "2026-06-30",
      "2026-07-04",
      "#158 SASCE national championship"
    );
    must(
      /^YCAP [–—−-] provincial workshop \(virtual\)$/,
      "2026-08-14",
      "2026-08-15",
      "#221 YCAP provincial workshop"
    );
    must(
      /^National Schools MOOT Court Competition [–—−-] provincial oral round$/,
      "2026-08-29",
      "2026-08-30",
      "#225 MOOT Court provincial oral round"
    );
    must(
      /^YCAP [–—−-] provincial competition$/,
      "2026-09-05",
      "2026-09-06",
      "#226 YCAP provincial competition"
    );
    must(
      /^National Schools MOOT Court \(Grades 9[–—−-]10\) [–—−-] registration$/,
      "2026-04-17",
      "2026-04-18",
      "#150 MOOT Court registration"
    );
    must(
      /^Youth Citizen Action Programme \(YCAP\) [–—−-] registration$/,
      "2026-05-08",
      "2026-05-09",
      "#152 YCAP registration"
    );

    // Next parent-usable batch (RCL / enrichment / School Safety — PDF due-date cells)
    must(
      /^Induction of new RCLs$/,
      "2026-03-02",
      "2026-03-28",
      "#65 Induction of new RCLs"
    );
    must(
      /^Election of RCL office-bearers and governing body learner representatives$/,
      "2026-03-06",
      "2026-03-07",
      "#66 RCL office-bearers election"
    );
    must(
      /^Election of District and Provincial Council of Learners Forums$/,
      "2026-03-09",
      "2026-03-24",
      "#67 District and Provincial Council of Learners Forums"
    );
    must(
      /^Closing date for applications for the provincial skills competition$/,
      "2026-06-19",
      "2026-06-20",
      "#145 provincial skills competition applications close"
    );
    must(
      /^Schools Democracy Month$/,
      "2026-04-08",
      "2026-05-01",
      "#149 Schools Democracy Month"
    );
    must(
      /^School Safety Summit$/,
      "2026-05-09",
      "2026-05-10",
      "#153 School Safety Summit"
    );
    must(
      /^RCL [–—−-] conference$/,
      "2026-05-23",
      "2026-05-24",
      "#155 RCL conference"
    );
    must(
      /^INkosi Albert Luthuli [–—−-] provincial competition$/,
      "2026-08-01",
      "2026-08-02",
      "#220 INkosi Albert Luthuli provincial competition"
    );
    must(
      /^Heritage Education Schools Outreach Programme [–—−-] provincial competition$/,
      "2026-08-15",
      "2026-08-16",
      "#222 Heritage Education provincial competition"
    );
    must(
      /^School Safety Round Table [–—−-] rural$/,
      "2026-08-15",
      "2026-08-16",
      "#223 School Safety Round Table rural"
    );
    must(
      /^School Safety Round Table [–—−-] urban$/,
      "2026-08-22",
      "2026-08-23",
      "#224 School Safety Round Table urban"
    );

    // #209 PDF is month-only ("August 2026") — must NOT invent 31 Jul or 1–31 Aug
    const mayJuneResults = events.filter((e) =>
      /Release of May\/June NSC\/SC examination results/i.test(e.summary)
    );
    assert.equal(
      mayJuneResults.length,
      0,
      "#209 May/June results dropped — PDF cell is month-only August 2026"
    );
    for (const e of mayJuneResults) {
      assert.notEqual(e.start.slice(0, 10), "2026-07-31", "do not invent 31 Jul");
      assert.notEqual(e.start.slice(0, 10), "2026-08-01", "do not invent 1 Aug");
    }

    // Do not dump untitled admin mush; do not invent absent 102–117
    assert.doesNotMatch(
      events.map((e) => e.summary).join("\n"),
      /Snap Survey|job descriptions|Quality Management System|\bLTSM\b|WCED 043/i
    );
    assert.ok(
      !events.some((e) => /\b102\b|\b117\b/.test(e.summary)),
      "do not invent absent items 102–117"
    );
  });

  it("Western Cape planning parent dates are parsed from the numbered due-date column", async () => {
    const { parseWesternCapePlanningPdf } = await import("./parseSource");
    const extract = await readFile(
      path.join(
        process.cwd(),
        "lib/fixtures/western-cape-planning-2026-extract.txt"
      ),
      "utf8"
    );
    // Same title, moved due date — parser must follow the extract, not a hardcoded day
    const moved = extract.replace(
      /(35\.\s+School admissions open for Grades R, 1 and 8[\s\S]*?)10 March 2026/,
      "$111 March 2026"
    );
    assert.match(moved, /35\.[\s\S]*?11 March 2026/);
    const events = parseWesternCapePlanningPdf(moved);
    const open = events.find(
      (e) => e.summary === "School admissions open for Grades R, 1 and 8"
    );
    assert.ok(open);
    assert.match(open!.start, /^2026-03-11/);
    assert.match(open!.end, /^2026-03-12/);
    assert.doesNotMatch(open!.start, /^2026-03-10/);

    // New parent rows also follow the due-date cell, not a hardcoded day
    const moved37 = extract.replace(
      /(37\.\s+Submit applications for NSC examination re-marks and[\s\S]*?)13 to 27 January 2026/,
      "$114 to 28 January 2026"
    );
    assert.match(moved37, /37\.[\s\S]*?14 to 28 January 2026/);
    const events37 = parseWesternCapePlanningPdf(moved37);
    const remark = events37.find(
      (e) =>
        e.summary ===
        "Submit applications for NSC examination re-marks and rechecks"
    );
    assert.ok(remark);
    assert.match(remark!.start, /^2026-01-14/);
    assert.match(remark!.end, /^2026-01-29/);
    assert.doesNotMatch(remark!.start, /^2026-01-13/);

    const moved201 = extract.replace(
      /(201\.\s+Parents confirm acceptance of transfer placements\s+)16 to 30 September 2026/,
      "$117 to 29 September 2026"
    );
    assert.match(moved201, /201\.[\s\S]*?17 to 29 September 2026/);
    const events201 = parseWesternCapePlanningPdf(moved201);
    const transferConfirm = events201.find(
      (e) => e.summary === "Parents confirm acceptance of transfer placements"
    );
    assert.ok(transferConfirm);
    assert.match(transferConfirm!.start, /^2026-09-17/);
    assert.match(transferConfirm!.end, /^2026-09-30/);
    assert.doesNotMatch(transferConfirm!.start, /^2026-09-16/);

    // Batch-3 parent rows also follow the due-date cell
    const moved47 = extract.replace(
      /(47\.\s+All\s+appeals[\s\S]*?)13 February 2026/,
      "$114 February 2026"
    );
    assert.match(moved47, /47\.[\s\S]*?14 February 2026/);
    const events47 = parseWesternCapePlanningPdf(moved47);
    const appealsFinal = events47.find(
      (e) =>
        e.summary ===
        "All appeals (for progression and promotion results for Grades 1–11 of 2025) finalised"
    );
    assert.ok(appealsFinal);
    assert.match(appealsFinal!.start, /^2026-02-14/);
    assert.match(appealsFinal!.end, /^2026-02-15/);
    assert.doesNotMatch(appealsFinal!.start, /^2026-02-13/);

    const moved267 = extract.replace(
      /(267\.\s+Applications\s+for\s+assessment\s+accommodations[\s\S]*?)03 October 2026/,
      "$104 October 2026"
    );
    assert.match(moved267, /267\.[\s\S]*?04 October 2026/);
    const events267 = parseWesternCapePlanningPdf(moved267);
    const accomClose = events267.find(
      (e) =>
        e.summary ===
        "Applications for assessment accommodations for Grades R–11 close"
    );
    assert.ok(accomClose);
    assert.match(accomClose!.start, /^2026-10-04/);
    assert.match(accomClose!.end, /^2026-10-05/);
    assert.doesNotMatch(accomClose!.start, /^2026-10-03/);

    // Batch-4 parent rows also follow the due-date cell
    const moved123 = extract.replace(
      /(123\.\s+System\s+displays\s+the\s+outcome\s+of\s+Grades\s+R,\s*1\s+and\s+8[\s\S]*?)28 May 2026/,
      "$129 May 2026"
    );
    assert.match(moved123, /123\.[\s\S]*?29 May 2026/);
    const events123 = parseWesternCapePlanningPdf(moved123);
    const sysDisplay = events123.find(
      (e) =>
        e.summary ===
        "System displays the outcome of Grades R, 1 and 8 online admission applications"
    );
    assert.ok(sysDisplay);
    assert.match(sysDisplay!.start, /^2026-05-29/);
    assert.match(sysDisplay!.end, /^2026-05-30/);
    assert.doesNotMatch(sysDisplay!.start, /^2026-05-28/);

    const moved238 = extract.replace(
      /(238\.\s+Administration\s+of\s+WCED\s+Systemic\s+Tests[\s\S]*?)12 to 27 October 2026/,
      "$113 to 28 October 2026"
    );
    assert.match(moved238, /238\.[\s\S]*?13 to 28 October 2026/);
    const events238 = parseWesternCapePlanningPdf(moved238);
    const systemic = events238.find(
      (e) =>
        e.summary ===
        "Administration of WCED Systemic Tests for Grades 3, 6 and 9"
    );
    assert.ok(systemic);
    assert.match(systemic!.start, /^2026-10-13/);
    assert.match(systemic!.end, /^2026-10-29/);
    assert.doesNotMatch(systemic!.start, /^2026-10-12/);

    // Batch-5: holiday programmes / enrichment stages follow their own due-date cells
    const moved157 = extract.replace(
      /(157\.\s+Safe\s+Schools\s+Holiday\s+Programme\s+)29 June to 17 July 2026/,
      "$130 June to 18 July 2026"
    );
    assert.match(moved157, /157\.[\s\S]*?30 June to 18 July 2026/);
    const events157 = parseWesternCapePlanningPdf(moved157);
    const hp157 = events157.find(
      (e) =>
        e.summary === "Safe Schools Holiday Programme" &&
        e.start.startsWith("2026-06-30")
    );
    assert.ok(hp157, "#157 must follow moved June/July cell");
    assert.match(hp157!.end, /^2026-07-19/);
    // #69 must NOT become #157’s dates when #157 moves
    const hp69still = events157.find(
      (e) =>
        e.summary === "Safe Schools Holiday Programme" &&
        e.start.startsWith("2026-03-30")
    );
    assert.ok(hp69still, "#69 must stay 30 Mar–2 Apr when #157 dates move");
    assert.match(hp69still!.end, /^2026-04-03/);
    assert.ok(
      !events157.some(
        (e) =>
          e.summary === "Safe Schools Holiday Programme" &&
          e.start.startsWith("2026-06-29")
      ),
      "#69 must not keep old #157 span after #157 cell moves"
    );

    const moved227 = extract.replace(
      /(227\.\s+Safe\s+Schools\s+Holiday\s+Programme[\s\S]*?)25 September to\s+02 October 2026/,
      "$126 September to 03 October 2026"
    );
    assert.match(moved227, /227\.[\s\S]*?26 September to 03 October 2026/);
    const events227 = parseWesternCapePlanningPdf(moved227);
    const hp227 = events227.find(
      (e) =>
        e.summary === "Safe Schools Holiday Programme" &&
        e.start.startsWith("2026-09-26")
    );
    assert.ok(hp227, "#227 must follow moved Sep/Oct cell");
    assert.match(hp227!.end, /^2026-10-04/);

    // Batch-6: Analyst enrichment / RCL rows follow their due-date cells
    const moved65 = extract.replace(
      /(65\.\s+Induction\s+of\s+new\s+RCLs\s+)02 to 27 March 2026/,
      "$103 to 28 March 2026"
    );
    assert.match(moved65, /65\.[\s\S]*?03 to 28 March 2026/);
    const events65 = parseWesternCapePlanningPdf(moved65);
    const induction = events65.find((e) => e.summary === "Induction of new RCLs");
    assert.ok(induction, "#65 must emit after cell move");
    assert.match(induction!.start, /^2026-03-03/);
    assert.match(induction!.end, /^2026-03-29/);
    assert.doesNotMatch(induction!.start, /^2026-03-02/);

    const moved153 = extract.replace(
      /(153\.\s+School\s+Safety\s+Summit\s+)09 May 2026/,
      "$110 May 2026"
    );
    assert.match(moved153, /153\.[\s\S]*?10 May 2026/);
    const events153 = parseWesternCapePlanningPdf(moved153);
    const summit = events153.find((e) => e.summary === "School Safety Summit");
    assert.ok(summit, "#153 must follow moved May cell");
    assert.match(summit!.start, /^2026-05-10/);
    assert.match(summit!.end, /^2026-05-11/);
    assert.doesNotMatch(summit!.start, /^2026-05-09/);

    const moved220 = extract.replace(
      /(220\.\s+INkosi\s+Albert\s+Luthuli\s*[–—−-]\s*provincial\s+competition\s+)01 August 2026/,
      "$102 August 2026"
    );
    assert.match(moved220, /220\.[\s\S]*?02 August 2026/);
    const events220 = parseWesternCapePlanningPdf(moved220);
    const luthuli = events220.find(
      (e) => e.summary === "INkosi Albert Luthuli – provincial competition"
    );
    assert.ok(luthuli, "#220 must follow moved August cell");
    assert.match(luthuli!.start, /^2026-08-02/);
    assert.match(luthuli!.end, /^2026-08-03/);
    assert.doesNotMatch(luthuli!.start, /^2026-08-01/);

    // Neighbour #154 must not steal #153’s summit day when #153 moves
    const ycap154 = events153.find(
      (e) =>
        e.summary === "YCAP – provincial workshop (virtual)" &&
        e.start.startsWith("2026-05-15")
    );
    assert.ok(ycap154, "#154 must keep 15 May when #153 moves");
    assert.doesNotMatch(ycap154!.start, /^2026-05-10/);
  });

  it("Safe Schools Holiday Programme rows keep distinct due-date spans", async () => {
    const { parseWesternCapePlanningPdf } = await import("./parseSource");
    const extract = await readFile(
      path.join(
        process.cwd(),
        "lib/fixtures/western-cape-planning-2026-extract.txt"
      ),
      "utf8"
    );
    const events = parseWesternCapePlanningPdf(extract);
    const programmes = events.filter(
      (e) => e.summary === "Safe Schools Holiday Programme"
    );
    assert.equal(
      programmes.length,
      4,
      `expected 4 holiday programmes (#69/#157/#227/#289), got ${programmes.length}`
    );
    const spans = programmes
      .map((e) => `${e.start.slice(0, 10)}..${e.end.slice(0, 10)}`)
      .sort();
    assert.deepEqual(spans, [
      "2026-03-30..2026-04-03",
      "2026-06-29..2026-07-18",
      "2026-09-25..2026-10-03",
      "2026-12-10..2026-12-16",
    ]);

    // Fail if #69 collapses into #157’s dates
    const row69 = programmes.find((e) => e.start.startsWith("2026-03-30"));
    assert.ok(row69);
    assert.doesNotMatch(row69!.start, /^2026-06-29/);
    assert.doesNotMatch(row69!.end, /^2026-07-18/);

    // #227 PDF cell is 25 Sep–2 Oct — not Term 4 header (06 Oct–11 Dec)
    const row227 = programmes.find((e) => e.start.startsWith("2026-09-25"));
    assert.ok(row227, "#227 must emit 25 Sep start");
    assert.match(row227!.end, /^2026-10-03/);
    assert.doesNotMatch(row227!.start, /^2026-10-06/);
    assert.doesNotMatch(row227!.end, /^2026-12-12/);

    // Neighbour #158 must not steal #157’s holiday span
    const sasceNational = events.find(
      (e) => e.summary === "SASCE – national championship"
    );
    assert.ok(sasceNational);
    assert.match(sasceNational!.start, /^2026-06-30/);
    assert.match(sasceNational!.end, /^2026-07-04/);
    assert.doesNotMatch(sasceNational!.start, /^2026-06-29/);
  });

  it("item #42 due date stays 27 Jan when 29 Jan sits before 43. in the extract", async () => {
    const { parseWesternCapePlanningPdf } = await import("./parseSource");
    // Live pdftotext risk: #43’s 29 Jan still appears in the #42 column blob
    // before the "43." marker — must not become #42’s DTSTART.
    const extract = [
      "2026 SCHOOL PLANNING CALENDAR",
      "42. Closing date for registrations for May/June 2026",
      "NSC/Senior Certificate (SC) examinations",
      "27 January 2026",
      "29 January 2026",
      "43. NSC Awards Ceremony",
      "29 January 2026",
      "(To be confirmed)",
      "44. Grade 12 subject changes processed on CEMIS 30 January 2026",
    ].join("\n");
    const events = parseWesternCapePlanningPdf(extract);
    const row42 = events.find(
      (e) =>
        e.summary ===
        "Closing date for registrations for May/June 2026 NSC/Senior Certificate (SC) examinations"
    );
    assert.ok(row42, "#42 must emit");
    assert.match(row42!.start, /^2026-01-27/, "#42 DTSTART must be 27 Jan not 29");
    assert.match(row42!.end, /^2026-01-28/);
    assert.doesNotMatch(row42!.start, /^2026-01-29/);

    // Fixture truth: #42 is 27 January 2026 (not 29)
    const fixture = await readFile(
      path.join(
        process.cwd(),
        "lib/fixtures/western-cape-planning-2026-extract.txt"
      ),
      "utf8"
    );
    const fixtureEvents = parseWesternCapePlanningPdf(fixture);
    const fixture42 = fixtureEvents.find(
      (e) =>
        e.summary ===
        "Closing date for registrations for May/June 2026 NSC/Senior Certificate (SC) examinations"
    );
    assert.ok(fixture42, "#42 must emit from fixture");
    assert.match(
      fixture42!.start,
      /^2026-01-27/,
      "#42 fixture DTSTART must be 27 Jan not 29"
    );
    assert.doesNotMatch(fixture42!.start, /^2026-01-29/);

    // Glued same-line next marker must also cut the block
    const glued = [
      "42. Closing date for registrations for May/June 2026 NSC/Senior Certificate (SC) examinations 27 January 2026 29 January 2026 43. NSC Awards Ceremony 29 January 2026",
    ].join("\n");
    const gluedEvents = parseWesternCapePlanningPdf(glued);
    const glued42 = gluedEvents.find(
      (e) =>
        e.summary ===
        "Closing date for registrations for May/June 2026 NSC/Senior Certificate (SC) examinations"
    );
    assert.ok(glued42, "#42 must emit from glued extract");
    assert.match(glued42!.start, /^2026-01-27/);
    assert.doesNotMatch(glued42!.start, /^2026-01-29/);
  });

  it("month-only planning cells do not invent day bounds (#138, #209)", async () => {
    const { parseWesternCapePlanningPdf } = await import("./parseSource");
    const invent = [
      "2026 SCHOOL PLANNING CALENDAR",
      "138. May/June NSC and SC examinations May and June 2026",
      "209. Release of May/June NSC/SC examination results August 2026",
      "210. Release of May/June NSC/SC re-mark/recheck results September 2026",
    ].join("\n");
    const events = parseWesternCapePlanningPdf(invent);
    assert.equal(
      events.filter((e) => /May\/June NSC and SC examinations/i.test(e.summary))
        .length,
      0,
      "#138 must not invent 1 May–30 Jun"
    );
    assert.equal(
      events.filter((e) =>
        /Release of May\/June NSC\/SC examination results/i.test(e.summary)
      ).length,
      0,
      "#209 must not invent August day bounds"
    );
    assert.ok(
      !events.some(
        (e) =>
          e.start.startsWith("2026-05-01") && e.end.startsWith("2026-07-01")
      ),
      "no invented May–June month span"
    );
  });

  it("WC exam nav pages emit proven parent day-dates (not planning #138/#209 invent)", async () => {
    const {
      parseWesternCapeExamPages,
      parseWesternCapePlanningPdf,
    } = await import("./parseSource");
    const { eventUid, eventsToIcs } = await import("./ics");

    const nsc = await readFile(
      path.join(process.cwd(), "lib/fixtures/western-cape-nsc-exams-extract.txt"),
      "utf8"
    );
    const nscJune = await readFile(
      path.join(
        process.cwd(),
        "lib/fixtures/western-cape-nsc-exams-june-extract.txt"
      ),
      "utf8"
    );
    const sc = await readFile(
      path.join(
        process.cwd(),
        "lib/fixtures/western-cape-sc-exams-mayjune-extract.txt"
      ),
      "utf8"
    );
    const examsHub = await readFile(
      path.join(process.cwd(), "lib/fixtures/western-cape-exams-extract.txt"),
      "utf8"
    );
    const awards = await readFile(
      path.join(
        process.cwd(),
        "lib/fixtures/western-cape-matric-awards-extract.txt"
      ),
      "utf8"
    );
    const secondChance = await readFile(
      path.join(
        process.cwd(),
        "lib/fixtures/western-cape-second-chance-extract.txt"
      ),
      "utf8"
    );

    // Cross-page merge: /exams + nsc-june + sc-mayjune share results/registration
    const fromExam = parseWesternCapeExamPages([
      nsc,
      nscJune,
      sc,
      examsHub,
      awards,
      secondChance,
    ]);

    function must(
      summaryRe: RegExp,
      startYmd: string,
      endYmd: string,
      label: string
    ) {
      const hit = fromExam.find(
        (e) =>
          summaryRe.test(e.summary) &&
          e.start.startsWith(startYmd) &&
          e.end.startsWith(endYmd)
      );
      assert.ok(
        hit,
        `exam MUST missing: ${label} SUMMARY~${summaryRe} ${startYmd}→${endYmd}`
      );
      return hit!;
    }

    function countFact(summary: string, startYmd: string): number {
      return fromExam.filter(
        (e) => e.summary === summary && e.start.startsWith(startYmd)
      ).length;
    }

    // NSC page: commence 11 May / conclude 24 June (timetable last paper day)
    must(
      /^NSC May\/June 2026 exam$/,
      "2026-05-11",
      "2026-06-25",
      "NSC May/June exam span"
    );
    // SC FAQ same span, distinct title — two sittings/labels stay two
    must(
      /^June 2026 SC Exam$/,
      "2026-05-11",
      "2026-06-25",
      "SC June exam span"
    );
    assert.equal(
      countFact("NSC May/June 2026 exam", "2026-05-11"),
      1,
      "NSC exam span once"
    );
    assert.equal(
      countFact("June 2026 SC Exam", "2026-05-11"),
      1,
      "SC exam span once"
    );

    // Exam hub / June pages: results day (not planning #209 month-only)
    must(
      /^Release of the May\/June 2026 NSC\/SC examination results$/,
      "2026-08-07",
      "2026-08-08",
      "May/June results 7 Aug"
    );
    assert.equal(
      countFact(
        "Release of the May/June 2026 NSC/SC examination results",
        "2026-08-07"
      ),
      1,
      "results 7 Aug once across /exams + nsc-june + sc-mayjune"
    );
    must(
      /^Remarking\|rechecking applications$/,
      "2027-01-12",
      "2027-01-26",
      "remark window 12–25 Jan 2027"
    );
    must(
      /^Online Registration for June 2027 NSC\|SC examination$/,
      "2026-10-01",
      "2027-02-06",
      "June 2027 online registration"
    );
    assert.equal(
      countFact(
        "Online Registration for June 2027 NSC|SC examination",
        "2026-10-01"
      ),
      1,
      "online registration once across nsc-june + sc"
    );
    must(
      /^Manual Registration for June 2027 NSC\|SC examination$/,
      "2026-11-02",
      "2027-02-06",
      "June 2027 manual registration"
    );
    assert.equal(
      countFact(
        "Manual Registration for June 2027 NSC|SC examination",
        "2026-11-02"
      ),
      1,
      "manual registration once across nsc-june + sc"
    );
    must(
      /^Matric 2025 Awards to Schools$/,
      "2026-01-29",
      "2026-01-30",
      "Matric 2025 awards schools"
    );
    must(
      /^Matric 2025 Awards to Candidates$/,
      "2026-01-29",
      "2026-01-30",
      "Matric 2025 awards candidates"
    );
    assert.equal(
      countFact("Matric 2025 Awards to Schools", "2026-01-29"),
      1
    );
    assert.equal(
      countFact("Matric 2025 Awards to Candidates", "2026-01-29"),
      1
    );
    // Second Chance page (linked from /exams): tutoring registration 09:00–14:00 SAST
    const scmp = fromExam.find(
      (e) =>
        e.summary ===
        "Registration to attend the second chance tutoring classes"
    );
    assert.ok(scmp, "Second Chance tutoring registration present");
    assert.equal(scmp!.allDay, false, "Second Chance is timed, not all-day");
    assert.equal(scmp!.timeZone, "Africa/Johannesburg");
    assert.equal(
      scmp!.start,
      "2026-08-22T07:00:00.000Z",
      "09:00 Africa/Johannesburg"
    );
    assert.equal(
      scmp!.end,
      "2026-08-22T12:00:00.000Z",
      "14:00 Africa/Johannesburg"
    );
    assert.equal(
      countFact(
        "Registration to attend the second chance tutoring classes",
        "2026-08-22"
      ),
      1,
      "Second Chance registration once"
    );

    // Same summary+dtstart fact → one UID in the ICS (no triplicate VEVENTs)
    const ics = eventsToIcs(
      "wc-exam-dedupe",
      "WC exam",
      fromExam,
      new Date("2026-08-24T00:00:00Z"),
      "https://www.westerncape.gov.za/education/school-calendar"
    );
    assert.match(
      ics,
      /DTSTART;TZID=Africa\/Johannesburg:20260822T090000/,
      "Second Chance DTSTART 09:00 SAST"
    );
    assert.match(
      ics,
      /DTEND;TZID=Africa\/Johannesburg:20260822T140000/,
      "Second Chance DTEND 14:00 SAST"
    );
    assert.doesNotMatch(
      ics,
      /SUMMARY:Registration to attend the second chance tutoring classes[\s\S]*?DTSTART;VALUE=DATE:20260822/,
      "Second Chance must not be all-day DATE"
    );
    const resultsIdx = fromExam.findIndex(
      (e) =>
        e.summary ===
        "Release of the May/June 2026 NSC/SC examination results"
    );
    assert.ok(resultsIdx >= 0, "results event present");
    const resultsUid = eventUid(
      "wc-exam-dedupe",
      fromExam[resultsIdx],
      resultsIdx
    );
    const uidHits = ics.match(new RegExp(`UID:${resultsUid}`, "g")) || [];
    assert.equal(uidHits.length, 1, "results fact emits one UID/VEVENT");
    const summaryHits =
      ics.match(
        /SUMMARY:Release of the May\/June 2026 NSC\/SC examination results/g
      ) || [];
    assert.equal(
      summaryHits.length,
      1,
      "results SUMMARY appears once in ICS"
    );
    const onlineHits =
      ics.match(
        /SUMMARY:Online Registration for June 2027 NSC\|SC examination/g
      ) || [];
    const manualHits =
      ics.match(
        /SUMMARY:Manual Registration for June 2027 NSC\|SC examination/g
      ) || [];
    assert.equal(onlineHits.length, 1, "online registration SUMMARY once");
    assert.equal(manualHits.length, 1, "manual registration SUMMARY once");

    // Do not emit historical award ceremonies or the Aug-2027 registration typo
    assert.ok(
      !fromExam.some((e) => /Matric 2024 Awards/i.test(e.summary)),
      "historical Matric 2024 awards not emitted"
    );
    assert.ok(
      !fromExam.some(
        (e) =>
          /Manual Registration/i.test(e.summary) &&
          e.start.startsWith("2027-08-07")
      ),
      "do not ship Manual Registration 7 Aug 2027 typo"
    );

    // Planning PDF alone still must not invent #138/#209 day bounds
    const planning = await readFile(
      path.join(
        process.cwd(),
        "lib/fixtures/western-cape-planning-2026-extract.txt"
      ),
      "utf8"
    );
    const fromPlan = parseWesternCapePlanningPdf(planning);
    assert.equal(
      fromPlan.filter((e) =>
        /May\/June NSC and SC examinations/i.test(e.summary)
      ).length,
      0,
      "planning still drops #138 month-only"
    );
    assert.equal(
      fromPlan.filter((e) =>
        /^Release of May\/June NSC\/SC examination results$/i.test(e.summary)
      ).length,
      0,
      "planning still drops #209 month-only"
    );
    // Exam-page results title includes "the" + "2026" — distinct from #209 wording
    assert.ok(
      fromExam.some((e) =>
        /^Release of the May\/June 2026 NSC\/SC examination results$/.test(
          e.summary
        )
      )
    );
  });

  it("Nov NSC timetable + reg-form PDFs emit proven parent days (not subject dump / not Aug-2027 typo)", async () => {
    const {
      parseWesternCapeNovNscTimetablePdf,
      parseWesternCapeNovNscRegFormPdf,
      parseWesternCapeExamPage,
      mergeWesternCapeExamEvents,
    } = await import("./parseSource");

    const timetable = await readFile(
      path.join(
        process.cwd(),
        "lib/fixtures/western-cape-nov-nsc-timetable-2026-extract.txt"
      ),
      "utf8"
    );
    const regForm = await readFile(
      path.join(
        process.cwd(),
        "lib/fixtures/western-cape-nov-nsc-reg-form-2026-extract.txt"
      ),
      "utf8"
    );
    const nscJune = await readFile(
      path.join(
        process.cwd(),
        "lib/fixtures/western-cape-nsc-exams-june-extract.txt"
      ),
      "utf8"
    );

    assert.match(timetable, /FINAL EXAMINATION TIMETABLE/i);
    assert.match(timetable, /EXAMINATION DATE: OCTOBER\/NOVEMBER 2026/i);
    assert.match(timetable, /2026-10-13/);
    assert.match(timetable, /2026-11-26/);
    assert.match(regForm, /CLOSING DATE: 21 AUGUST 2026/i);

    const fromTt = parseWesternCapeNovNscTimetablePdf(timetable);
    assert.equal(fromTt.length, 1, "one exam span — not per-sitting / per-subject dump");
    assert.equal(fromTt[0].summary, "NSC October/November 2026 exam");
    assert.match(fromTt[0].start, /^2026-10-13/);
    assert.match(fromTt[0].end, /^2026-11-27/); // exclusive end after 26 Nov
    assert.ok(
      !fromTt.some((e) => e.start.startsWith("2026-05-08")),
      "signature DATE 2026-05-08 is not a sitting day"
    );

    const fromReg = parseWesternCapeNovNscRegFormPdf(regForm);
    assert.equal(fromReg.length, 1, "closing day once");
    assert.equal(
      fromReg[0].summary,
      "Closing date for November 2026 NSC examination registration"
    );
    assert.match(fromReg[0].start, /^2026-08-21/);
    assert.match(fromReg[0].end, /^2026-08-22/);

    // June HTML typo must still not emit; form closing day is separate
    const fromJuneHtml = parseWesternCapeExamPage(nscJune);
    assert.ok(
      !fromJuneHtml.some(
        (e) =>
          /Registration/i.test(e.summary) && e.start.startsWith("2027-08-07")
      ),
      "June-page 7–21 August 2027 typo still dropped"
    );
    assert.ok(
      !fromJuneHtml.some((e) =>
        /November 2026 NSC examination registration/i.test(e.summary)
      ),
      "Nov reg closing comes from form PDF, not June HTML"
    );

    const merged = mergeWesternCapeExamEvents([
      fromJuneHtml,
      fromTt,
      fromReg,
      fromTt,
      fromReg,
    ]);
    assert.equal(
      merged.filter((e) => e.summary === "NSC October/November 2026 exam")
        .length,
      1,
      "timetable span deduped"
    );
    assert.equal(
      merged.filter(
        (e) =>
          e.summary ===
          "Closing date for November 2026 NSC examination registration"
      ).length,
      1,
      "reg closing deduped"
    );
  });

  it("Ridgewood term-dates fixture: terms + half terms + named holidays from page", async () => {
    const { parseSourceText, looksLikeTermStartCloseCalendar } = await import(
      "./parseSource"
    );
    const { eventsToIcs } = await import("./ics");
    const extract = await readFile(
      path.join(
        process.cwd(),
        "lib/fixtures/ridgewood-term-dates-2026-extract.txt"
      ),
      "utf8"
    );
    assert.ok(
      looksLikeTermStartCloseCalendar(extract),
      "fixture must look like START:/CLOSE: term calendar"
    );
    // Holiday Club 2021 PDF must stay unread — not a 2026 parent calendar
    assert.doesNotMatch(extract, /Holiday Club|PREP-2021|\.pdf/i);
    const { events, title } = parseSourceText(extract, new Date("2026-08-24"), {
      sourceTitle: "Term Dates – Ridgewood College",
      sourceUrl: "https://ridgewoodcollege.co.za/term-dates/",
    });
    assert.match(title, /Ridgewood|Term Dates/i);
    function mustSpan(
      summary: string,
      startYmd: string,
      endExclusiveYmd: string,
      allDay = true
    ) {
      const hit = events.find(
        (e) =>
          e.summary === summary &&
          e.start.startsWith(startYmd) &&
          e.end.startsWith(endExclusiveYmd) &&
          e.allDay === allDay
      );
      assert.ok(
        hit,
        `missing ${summary} ${startYmd}→${endExclusiveYmd} allDay=${allDay}; got ${events
          .map(
            (e) =>
              `${e.summary}|${e.start}|${e.end}|allDay=${e.allDay}`
          )
          .join("; ")}`
      );
      return hit!;
    }
    // Three term spans from year-stamped START:/CLOSE:
    mustSpan("Term 1 2026", "2026-01-14", "2026-04-11");
    mustSpan("Term 2 2026", "2026-05-06", "2026-08-08");
    mustSpan("Term 3 2026", "2026-09-09", "2026-12-05");

    // Half terms: CLOSE→RETURN from the same block (term year inherited)
    const ht1 = events.find(
      (e) =>
        e.summary === "Half Term (Mid-Term Break)" &&
        e.start.startsWith("2026-02-19")
    );
    assert.ok(ht1, "T1 half term from CLOSE 19 Feb");
    assert.equal(ht1!.allDay, false, "12h00 close is timed SAST");
    assert.equal(ht1!.timeZone, "Africa/Johannesburg");
    assert.match(ht1!.start, /T10:00:00\.000Z$/, "12:00 SAST = 10:00Z");
    assert.match(ht1!.end, /^2026-02-23T22:00:00\.000Z$/, "RETURN Tue 24 Feb 00:00 SAST");

    mustSpan("Half Term (Mid-Term Break)", "2026-06-26", "2026-07-06", true);
    const ht3 = events.find(
      (e) =>
        e.summary === "Half Term (Mid-Term Break)" &&
        e.start.startsWith("2026-10-22")
    );
    assert.ok(ht3, "T3 half term from CLOSE 22 Oct");
    assert.equal(ht3!.allDay, false);
    assert.equal(ht3!.timeZone, "Africa/Johannesburg");
    assert.match(ht3!.start, /T10:00:00\.000Z$/);
    assert.match(ht3!.end, /^2026-10-26T22:00:00\.000Z$/);

    // Named school/public holidays from the page rows
    mustSpan("Human Rights Day", "2026-03-21", "2026-03-22");
    mustSpan("School Holiday", "2026-03-22", "2026-03-23");
    mustSpan("Easter Weekend", "2026-03-29", "2026-04-02");
    mustSpan("Easter", "2026-04-03", "2026-04-07");
    mustSpan("Holiday", "2026-06-15", "2026-06-16");
    mustSpan("Youth Day", "2026-06-16", "2026-06-17");
    mustSpan("Heritage Day", "2026-09-24", "2026-09-25");
    mustSpan("Holiday", "2026-09-25", "2026-09-26");

    assert.equal(events.length, 14, `expected 3 terms + 3 half + 8 holidays; got ${events.length}`);
    assert.ok(!events.some((e) => /^START:|^CLOSE:|^RETURN:/i.test(e.summary)));
    // Do not invent bounds from neighbouring rows (e.g. term CLOSE as half-term end)
    assert.ok(
      !events.some(
        (e) =>
          e.summary === "Half Term (Mid-Term Break)" &&
          e.end.startsWith("2026-04-11")
      )
    );

    const ics = eventsToIcs(
      "ridgewood-test",
      title,
      events,
      new Date("2026-08-24T12:00:00Z"),
      "https://ridgewoodcollege.co.za/term-dates/"
    );
    assert.match(
      ics,
      /DTSTART;TZID=Africa\/Johannesburg:20260219T120000[\s\S]*?DTEND;TZID=Africa\/Johannesburg:20260224T000000[\s\S]*?SUMMARY:Half Term \(Mid-Term Break\)/
    );
    assert.match(ics, /SUMMARY:Human Rights Day/);
    assert.match(ics, /DTSTART;VALUE=DATE:20260321/);
  });

  it("St Stithians 2026 PDF fixture: no bare weekday crumbs; still not the PDF a parent reads", async () => {
    // Recorded pdf-parse extract of
    // St_Stithians_College_Calendar_2026_-_Approved_March_2025.pdf — not a live fetch.
    const extract = await readFile(
      path.join(process.cwd(), "lib/fixtures/st-stithians-2026-extract.txt"),
      "utf8"
    );
    assert.match(extract, /Term Commences Wednesday 14 January/);
    assert.match(extract, /School Closes for the Holidays/);
    assert.match(extract, /Half Term/);

    const { events } = parseSourceText(extract, new Date("2026-08-24T00:00:00Z"), {
      sourceTitle: "St_Stithians_College_Calendar_2026_-_Approved_March_2025.pdf",
      sourceUrl:
        "https://www.stithian.com/uploads/files/St_Stithians_College_Calendar_2026_-_Approved_March_2025.pdf",
    });

    // Honesty: emit source labels, not weekday-only crumbs. This is still an
    // incomplete reshape of the PDF (term/holiday column ranges, multi-day
    // festivals, half-term spans, staff notes) — not shippable as Extra.
    for (const e of events) {
      assert.doesNotMatch(
        e.summary,
        /^(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)$/i,
        `weekday crumb: ${e.summary}`
      );
      assert.doesNotMatch(
        e.summary,
        /^TERM\s*\d*\s*(May|January|April|August|September)?$/i,
        `term-header crumb: ${e.summary}`
      );
    }
    assert.ok(
      events.some((e) => e.summary === "Term Commences"),
      "PDF wording Term Commences kept when present"
    );
    assert.ok(
      events.some((e) => /School Closes for the Holidays/i.test(e.summary)),
      "PDF wording School Closes kept when present"
    );
    assert.ok(
      events.some((e) => /^Half Term$/i.test(e.summary)),
      "PDF wording Half Term kept when present"
    );

    // Tile must stay hidden — incomplete parse is incomplete (count is not progress)
    const page = await readFile(
      path.join(process.cwd(), "app/page.tsx"),
      "utf8"
    );
    assert.doesNotMatch(
      page,
      /stithian\.com\/uploads\/files\/St_Stithians_College_Calendar_2026/
    );
    assert.doesNotMatch(page, /School calendar \(St /);
  });
});

describe("deterministic watch ids", () => {
  it("round-trips source URL through the id", () => {
    const url = "https://example.com/terms?year=2026";
    const id = watchIdFromSourceUrl(url);
    assert.equal(watchIdFromSourceUrl(url), id);
    assert.equal(sourceUrlFromWatchId(id), new URL(url).toString());
    assert.equal(sourceUrlFromWatchId(id + ".ics"), new URL(url).toString());
  });
});

describe("last watch browser restore", () => {
  it("rebuilds clickable webcal + https hrefs from a stored id", () => {
    const source_url = "https://school.example/terms";
    const id = watchIdFromSourceUrl(source_url);
    const stored = {
      id,
      title: "School terms",
      event_count: 2,
      source_url,
    };
    // Same hydrate path the homepage uses after localStorage read
    const restored = { ...stored, ...feedPaths(stored.id, "https://watch-cal.vercel.app") };
    assert.equal(
      restored.https_url,
      `https://watch-cal.vercel.app/api/feed/${id}.ics`
    );
    assert.equal(
      restored.webcal_url,
      `webcal://watch-cal.vercel.app/api/feed/${id}.ics`
    );
    assert.equal(
      restored.download_url,
      `https://watch-cal.vercel.app/api/feed/${id}.ics?download=1`
    );
    assert.match(restored.webcal_url, /^webcal:/);
    assert.match(restored.https_url, /^https:.*\.ics$/);
  });

  it("homepage persists last watch in localStorage only (no share query)", async () => {
    const page = await readFile(
      path.join(process.cwd(), "app/page.tsx"),
      "utf8"
    );
    assert.match(page, /watchcal:lastWatch/);
    assert.match(page, /localStorage\.setItem/);
    assert.match(page, /localStorage\.getItem/);
    assert.match(page, /rememberWatch/);
    assert.match(page, /href=\{watch\.webcal_url\}/);
    assert.match(page, /href=\{watch\.https_url\}/);
    assert.doesNotMatch(page, /URLSearchParams|searchParams|\?id=/);
  });
});

describe("watch feed lifecycle", { concurrency: false }, () => {
  let dataPath = "";
  let sourceBody = "";
  let sourceStatus = 200;
  let sourceContentType = "text/html; charset=utf-8";
  let failNetwork = false;

  const fetcher: typeof fetch = async (input) => {
    if (failNetwork) {
      throw new TypeError("fetch failed");
    }
    const href = typeof input === "string" ? input : input.toString();
    if (sourceStatus >= 400) {
      return new Response("gone", {
        status: sourceStatus,
        headers: { "content-type": "text/plain" },
      });
    }
    if (href.includes("dead.invalid") || href.includes("unreachable.example")) {
      return new Response("not found", { status: 404 });
    }
    return new Response(sourceBody, {
      status: 200,
      headers: { "content-type": sourceContentType },
    });
  };

  before(async () => {
    dataPath = await mkdtemp(path.join(tmpdir(), "watchcal-"));
    dataPath = path.join(dataPath, "watches.json");
  });

  after(async () => {
    await rm(path.dirname(dataPath), { recursive: true, force: true });
  });

  it("creates a watch with stable feed path and updates ICS when source changes", async () => {
    sourceStatus = 200;
    failNetwork = false;
    sourceContentType = "text/html; charset=utf-8";
    sourceBody = `<html><title>Terms v1</title><body><p>Term A 10 April 2026</p></body></html>`;
    const origin = "https://watchcal.example";
    const sourceUrl = "https://example.com/terms";
    const { watch, urls } = await watchUrl(sourceUrl, origin, {
      dataPath,
      fetcher,
      now: new Date("2026-01-05T00:00:00Z"),
    });

    assert.equal(FREE_WATCH_LIMIT, 1);
    assert.equal(watch.id, watchIdFromSourceUrl(sourceUrl));
    assert.equal(urls.https_url, `${origin}/api/feed/${watch.id}.ics`);
    assert.equal(urls.webcal_url, `webcal://watchcal.example/api/feed/${watch.id}.ics`);
    assert.equal(feedPaths(watch.id, origin).https_url, urls.https_url);

    const firstIcs = await getFeedIcs(watch.id, {
      dataPath,
      fetcher,
      now: new Date("2026-01-05T00:01:00Z"),
      refresh: false,
    });
    assert.equal(isValidVCalendar(firstIcs), true);
    assert.match(firstIcs, /Term A|10 April|April/);

    const stored = await getWatch(watch.id, dataPath);
    assert.ok(stored);
    const hash1 = stored!.sourceHash;

    // Same URL again returns the same watch id (stable feed path)
    const again = await watchUrl(sourceUrl, origin, {
      dataPath,
      fetcher,
      now: new Date("2026-01-05T00:02:00Z"),
    });
    assert.equal(again.watch.id, watch.id);

    // Source change → feed content and hash change after forced refresh
    sourceBody = `<html><title>Terms v2</title><body><p>Term B 12 May 2026</p><p>Term C 20 May 2026</p></body></html>`;
    const refreshed = await refreshWatch(watch.id, {
      dataPath,
      fetcher,
      force: true,
      now: new Date("2026-01-06T00:00:00Z"),
    });
    assert.notEqual(refreshed.sourceHash, hash1);
    assert.ok(refreshed.events.length >= 1);
    assert.match(refreshed.ics, /Term B|May 2026|12 May/);
    assert.doesNotMatch(refreshed.ics, /Term A 10 April/);

    // Unchanged source: lastFetchedAt moves, last-changed (updatedAt) does not.
    const changedAt = refreshed.updatedAt;
    const fetchedAgain = await refreshWatch(watch.id, {
      dataPath,
      fetcher,
      force: true,
      now: new Date("2026-01-06T01:00:00Z"),
    });
    assert.equal(fetchedAgain.sourceHash, refreshed.sourceHash);
    assert.equal(fetchedAgain.updatedAt, changedAt);
    assert.equal(fetchedAgain.lastFetchedAt, "2026-01-06T01:00:00.000Z");
  });

  it("serves text/calendar after the store is wiped (cold start)", async () => {
    sourceStatus = 200;
    failNetwork = false;
    sourceContentType = "text/html; charset=utf-8";
    sourceBody = `<html><title>Cold</title><body><p>Match day 18 June 2026</p></body></html>`;
    const sourceUrl = "https://example.com/terms";
    const id = watchIdFromSourceUrl(sourceUrl);

    // Simulate Vercel cold start: empty /tmp cache
    await writeFile(dataPath, JSON.stringify({ watches: [] }) + "\n", "utf8");
    assert.equal(await getWatch(id, dataPath), null);

    const ics = await getFeedIcs(id, {
      dataPath,
      fetcher,
      now: new Date("2026-01-07T00:00:00Z"),
    });
    assert.equal(isValidVCalendar(ics), true);
    assert.match(ics, /Match day|18 June|June 2026/);
    assert.match(ics, /BEGIN:VCALENDAR/);

    // Cache repopulated from decoded id
    const restored = await getWatch(id, dataPath);
    assert.ok(restored);
    assert.equal(restored!.sourceUrl, new URL(sourceUrl).toString());
  });

  it("errors on dead URL instead of blaming the 1-watch free cap", async () => {
    sourceStatus = 200;
    failNetwork = false;
    // Store already has one watch from earlier tests — dead URL must still be a fetch error.
    let threw = false;
    try {
      await watchUrl("https://dead.invalid/missing", "https://watchcal.example", {
        dataPath,
        fetcher,
      });
    } catch (err: unknown) {
      threw = true;
      const e = err as Error & { status?: number };
      assert.equal(e.status, 422);
      assert.match(e.message, /Source fetch failed/i);
      assert.doesNotMatch(e.message, /1 watch|Free path/i);
    }
    assert.equal(threw, true);
  });

  it("errors when the host cannot be reached", async () => {
    failNetwork = true;
    let threw = false;
    try {
      await watchUrl("https://unreachable.example/page", "https://watchcal.example", {
        dataPath,
        fetcher,
      });
    } catch (err: unknown) {
      threw = true;
      const e = err as Error & { status?: number };
      assert.equal(e.status, 422);
      assert.match(e.message, /Source fetch failed|could not reach/i);
      assert.doesNotMatch(e.message, /1 watch|Free path/i);
    }
    assert.equal(threw, true);
    failNetwork = false;
  });

  it("enforces the free one-watch limit for a different reachable URL", async () => {
    sourceStatus = 200;
    failNetwork = false;
    sourceContentType = "text/html; charset=utf-8";
    sourceBody = `<html><title>Other</title><body><p>Event 1 July 2026</p></body></html>`;
    let threw = false;
    try {
      await watchUrl("https://example.com/other", "https://watchcal.example", {
        dataPath,
        fetcher,
      });
    } catch (err: unknown) {
      threw = true;
      const e = err as Error & { status?: number };
      assert.equal(e.status, 402);
      assert.equal(e.needsPayment, true);
      assert.match(e.message, /pay-once extra watch/i);
      assert.match(e.message, /1 watch|one watch|extra watched URL/i);
      assert.doesNotMatch(e.message, /No dated events|parse/i);
    }
    assert.equal(threw, true);
  });

  it("rejects image URLs before minting a watch (no 0-event feed)", async () => {
    sourceStatus = 200;
    failNetwork = false;
    sourceContentType = "text/html; charset=utf-8";
    sourceBody = "fake image bytes";
    let threw = false;
    try {
      await watchUrl(
        "https://cdn.example.com/screenshot.png",
        "https://watchcal.example",
        { dataPath, fetcher }
      );
    } catch (err: unknown) {
      threw = true;
      const e = err as Error & { status?: number };
      assert.equal(e.status, 400);
      assert.match(e.message, /Image URLs are not supported/i);
    }
    assert.equal(threw, true);
    assert.equal(
      await getWatch(
        watchIdFromSourceUrl("https://cdn.example.com/screenshot.png"),
        dataPath
      ),
      null
    );
  });

  it("rejects Content-Type image/* with no image extension (no empty feed)", async () => {
    sourceStatus = 200;
    failNetwork = false;
    sourceContentType = "image/png";
    sourceBody = "\x89PNG\r\nfake";
    const sourceUrl = "https://cdn.example.com/media/abc123";
    let threw = false;
    try {
      await watchUrl(sourceUrl, "https://watchcal.example", {
        dataPath,
        fetcher,
      });
    } catch (err: unknown) {
      threw = true;
      const e = err as Error & { status?: number };
      assert.equal(e.status, 400);
      assert.match(e.message, /Image URLs are not supported/i);
      assert.match(e.message, /page or PDF/i);
      assert.doesNotMatch(e.message, /No dated events|0 event/i);
    }
    assert.equal(threw, true);
    assert.equal(await getWatch(watchIdFromSourceUrl(sourceUrl), dataPath), null);
    sourceContentType = "text/html; charset=utf-8";
  });

  it("preview dry-run returns title + event_count without minting or consuming quota", async () => {
    sourceStatus = 200;
    failNetwork = false;
    sourceContentType = "text/html; charset=utf-8";
    sourceBody = `<html><title>Preview Page</title><body><p>Meet 3 August 2026</p><p>Final 10 August 2026</p></body></html>`;
    const previewSource = "https://example.com/preview-only";
    const before = await getWatch(watchIdFromSourceUrl(previewSource), dataPath);
    assert.equal(before, null);

    const result = await previewUrl(previewSource, { fetcher });
    assert.equal(result.source_url, new URL(previewSource).toString());
    assert.match(result.title, /Preview Page/);
    assert.ok(result.event_count >= 2);

    // No watch written — free quota untouched
    assert.equal(
      await getWatch(watchIdFromSourceUrl(previewSource), dataPath),
      null
    );

    // A second distinct URL still hits the free-tier gate (preview did not mint)
    sourceBody = `<html><title>Other</title><body><p>Event 1 July 2026</p></body></html>`;
    let threw = false;
    try {
      await watchUrl("https://example.com/still-capped", "https://watchcal.example", {
        dataPath,
        fetcher,
      });
    } catch (err: unknown) {
      threw = true;
      const e = err as Error & { status?: number; needsPayment?: boolean };
      assert.equal(e.status, 402);
      assert.equal(e.needsPayment, true);
    }
    assert.equal(threw, true);
  });

  it("preview rejects image URLs with 400 (no empty success)", async () => {
    let threw = false;
    try {
      await previewUrl("https://cdn.example.com/shot.png", { fetcher });
    } catch (err: unknown) {
      threw = true;
      const e = err as Error & { status?: number };
      assert.equal(e.status, 400);
      assert.match(e.message, /Image URLs are not supported/i);
    }
    assert.equal(threw, true);
  });

  it("preview rejects Content-Type image/* with 400 (no empty success)", async () => {
    sourceStatus = 200;
    failNetwork = false;
    sourceContentType = "image/jpeg";
    sourceBody = "\xff\xd8fake";
    const sourceUrl = "https://cdn.example.com/media/noext";
    let threw = false;
    try {
      await previewUrl(sourceUrl, { fetcher });
    } catch (err: unknown) {
      threw = true;
      const e = err as Error & { status?: number };
      assert.equal(e.status, 400);
      assert.match(e.message, /Image URLs are not supported/i);
      assert.doesNotMatch(e.message, /No dated events|0 event/i);
    }
    assert.equal(threw, true);
    assert.equal(await getWatch(watchIdFromSourceUrl(sourceUrl), dataPath), null);
    sourceContentType = "text/html; charset=utf-8";
  });
});
