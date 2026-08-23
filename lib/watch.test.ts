import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
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

describe("watch feed lifecycle", { concurrency: false }, () => {
  let dataPath = "";
  let sourceBody = "";
  let sourceStatus = 200;
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
      headers: { "content-type": "text/html; charset=utf-8" },
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
      assert.match(e.message, /1 watch|one watch|extra watched URL/i);
    }
    assert.equal(threw, true);
  });
});
