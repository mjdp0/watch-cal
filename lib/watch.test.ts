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
import { feedPaths, getFeedIcs, refreshWatch, watchUrl } from "./watch";
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
  it("extra examples only fill the URL; free example may create a watch", async () => {
    const page = await readFile(
      path.join(process.cwd(), "app/page.tsx"),
      "utf8"
    );
    assert.match(page, /feedId\?/);
    assert.match(page, /if \(example\.feedId\)/);
    assert.match(page, /void createWatch\(example\.url\)/);
    // Extra tiles must not auto-POST — that 402 + existing feed looked like a parse fail
    assert.match(
      page,
      /Extra examples only fill|only fill the\s*\n?\s*field|auto-POST would 402/i
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
    // 402 error must name pay-once extra watch, not parse failure
    assert.match(page, /This URL needs a pay-once extra watch/);
    assert.match(
      page,
      /if \(res\.status === 402 \|\| res\.status === 403\) \{\s*setNeedsExtraWatch\(true\);\s*setError\(/
    );
  });

  it("extra example tiles show Extra / $5 (no feedId)", async () => {
    const page = await readFile(
      path.join(process.cwd(), "app/page.tsx"),
      "utf8"
    );
    assert.match(
      page,
      /!example\.feedId && \(\s*<span className="example-extra"> Extra \/ \$5<\/span>/
    );
    assert.match(page, /St Stithians/);
    assert.match(page, /NSC exams/);
    // Free Western Cape tile keeps feedId — not labeled Extra / $5 in the EXAMPLES entry
    assert.match(page, /feedId: WESTERN_CAPE_FEED_ID/);
  });

  it("copy invites a public https link, not upload or screenshot paste", async () => {
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
    assert.doesNotMatch(page, /Paste a public page or PDF(?! URL)/i);
    assert.doesNotMatch(page, /photo OCR|type=["']file["']/i);
    assert.match(page, /onPaste=\{onUrlPaste\}/);
    assert.match(
      page,
      /Use a public https link to a page or PDF — not a screenshot or photo/
    );
    assert.match(layout, /public https link \(page or PDF URL\)/i);
    // Single URL text field only
    assert.equal((page.match(/type="url"/g) || []).length, 1);
    assert.doesNotMatch(page, /type=["']file["']/);
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

  it("titles Western Cape Opens/Closes rows as Term N opens/closes", () => {
    // Mirrors https://www.westerncape.gov.za/education/school-calendar structure:
    // ordinal heading + Opens/Closes list items (incl. dual (1)/(2) dates).
    const html = `
      <html><head><title>School Calendar | Western Cape Government</title></head>
      <body>
        <p><strong>Terms (All Provinces)</strong></p>
        <p><strong>First</strong></p>
        <ul>
          <li>Opens: 12 January 2026 <strong>(1)</strong> | 14 January 2026 <strong>(2)</strong></li>
          <li>Closes: 27 March 2026</li>
        </ul>
        <p><strong>Second</strong></p>
        <ul>
          <li>Opens: 8 April 2026</li>
          <li>Closes: 26 June 2026</li>
        </ul>
        <p><strong>Third</strong></p>
        <ul>
          <li>Opens: 21 July 2026</li>
          <li>Closes: 23 September 2026</li>
        </ul>
        <p><strong>Fourth</strong></p>
        <ul>
          <li>Opens: 6 October 2026</li>
          <li>Closes: 9 December 2026 <strong>(2)</strong> | 11 December 2026 <strong>(1)</strong></li>
        </ul>
        <h4>2026 Public Holidays (Including School Holidays)</h4>
        <p>1 January 2026 – New Year’s Day</p>
        <p>21 March 2026 – Human Rights Day</p>
        <p>3 April 2026 – Good Friday</p>
      </body></html>
    `;
    const { text } = htmlToText(html);
    const { events } = parseSourceText(text, new Date("2026-08-23T00:00:00Z"), {
      sourceTitle: "School Calendar | Western Cape Government",
      sourceUrl: "https://www.westerncape.gov.za/education/school-calendar",
    });

    for (const e of events) {
      assert.doesNotMatch(e.summary, /^(Opens|Closes)$/i);
      assert.doesNotMatch(e.summary, /^\(\d+\)/);
    }

    const term1Open = events.filter(
      (e) => e.summary === "Term 1 opens" && /^2026-01-(12|14)/.test(e.start)
    );
    assert.equal(term1Open.length, 2, "dual Term 1 open dates");

    const term1Close = events.find(
      (e) => e.summary === "Term 1 closes" && e.start.startsWith("2026-03-27")
    );
    assert.ok(term1Close);

    assert.ok(
      events.some(
        (e) => e.summary === "Term 2 opens" && e.start.startsWith("2026-04-08")
      )
    );
    assert.ok(
      events.some(
        (e) => e.summary === "Term 2 closes" && e.start.startsWith("2026-06-26")
      )
    );
    assert.ok(
      events.some(
        (e) => e.summary === "Term 3 opens" && e.start.startsWith("2026-07-21")
      )
    );
    assert.ok(
      events.some(
        (e) => e.summary === "Term 3 closes" && e.start.startsWith("2026-09-23")
      )
    );
    assert.ok(
      events.some(
        (e) => e.summary === "Term 4 opens" && e.start.startsWith("2026-10-06")
      )
    );
    const term4Close = events.filter(
      (e) =>
        e.summary === "Term 4 closes" && /^2026-12-(09|11)/.test(e.start)
    );
    assert.equal(term4Close.length, 2, "dual Term 4 close dates");

    const nye = events.find((e) => /New Year/i.test(e.summary));
    assert.ok(nye, "named public holidays stay named");
    assert.match(nye!.start, /^2026-01-01/);
    assert.ok(events.some((e) => /Human Rights/i.test(e.summary)));
    assert.ok(events.some((e) => /Good Friday/i.test(e.summary)));
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
});
