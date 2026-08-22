import type { ParsedEvent } from "./types";

const MONTHS: Record<string, number> = {
  jan: 0,
  january: 0,
  feb: 1,
  february: 1,
  mar: 2,
  march: 2,
  apr: 3,
  april: 3,
  may: 4,
  jun: 5,
  june: 5,
  jul: 6,
  july: 6,
  aug: 7,
  august: 7,
  sep: 8,
  sept: 8,
  september: 8,
  oct: 9,
  october: 9,
  nov: 10,
  november: 10,
  dec: 11,
  december: 11,
};

const MONTH_ALT =
  "January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec";

function parseDateParts(
  day: number,
  month: number,
  year: number | null,
  now: Date
): Date | null {
  if (day < 1 || day > 31 || month < 0 || month > 11) return null;
  let y = year;
  if (y == null) {
    y = now.getFullYear();
    const candidate = new Date(y, month, day);
    const past = (now.getTime() - candidate.getTime()) / (1000 * 60 * 60 * 24);
    if (past > 60) y += 1;
  } else if (y < 100) {
    y += 2000;
  }
  const d = new Date(y, month, day);
  if (d.getMonth() !== month || d.getDate() !== day) return null;
  return d;
}

type DateHit = { index: number; date: Date; raw: string };

function findDates(text: string, now: Date): DateHit[] {
  const hits: DateHit[] = [];
  const patterns: Array<{
    re: RegExp;
    pick: (m: RegExpExecArray) => Date | null;
  }> = [
    {
      re: new RegExp(
        String.raw`\b(\d{1,2})(?:st|nd|rd|th)?\s+(${MONTH_ALT})(?:\s+(\d{4}|\d{2}))?\b`,
        "gi"
      ),
      pick: (m) => {
        const month = MONTHS[m[2].toLowerCase()];
        if (month == null) return null;
        return parseDateParts(Number(m[1]), month, m[3] ? Number(m[3]) : null, now);
      },
    },
    {
      re: new RegExp(
        String.raw`\b(${MONTH_ALT})\s+(\d{1,2})(?:st|nd|rd|th)?(?!\d)(?:,?\s+(\d{4}|\d{2}))?\b`,
        "gi"
      ),
      pick: (m) => {
        const month = MONTHS[m[1].toLowerCase()];
        if (month == null) return null;
        return parseDateParts(Number(m[2]), month, m[3] ? Number(m[3]) : null, now);
      },
    },
    {
      re: /\b(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4}|\d{2})\b/g,
      pick: (m) => {
        const a = Number(m[1]);
        const b = Number(m[2]);
        const y = Number(m[3]);
        if (b >= 1 && b <= 12) return parseDateParts(a, b - 1, y, now);
        if (a >= 1 && a <= 12) return parseDateParts(b, a - 1, y, now);
        return null;
      },
    },
    {
      re: /\b(\d{4})-(\d{2})-(\d{2})\b/g,
      pick: (m) =>
        parseDateParts(Number(m[3]), Number(m[2]) - 1, Number(m[1]), now),
    },
  ];

  for (const { re, pick } of patterns) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const date = pick(m);
      if (!date) continue;
      hits.push({ index: m.index, date, raw: m[0] });
    }
  }

  hits.sort((a, b) => a.index - b.index);
  const out: DateHit[] = [];
  for (const h of hits) {
    const dup = out.find(
      (o) =>
        Math.abs(o.index - h.index) < 8 &&
        o.date.toDateString() === h.date.toDateString()
    );
    if (!dup) out.push(h);
  }
  return out;
}

function lineSummary(text: string, hitIndex: number): string {
  const before = text.slice(Math.max(0, hitIndex - 160), hitIndex);
  const line = before.split(/\r?\n/).pop()?.trim() ?? "";
  const cleaned = line.replace(/[,;:\-\u2013\u2014\s]+$/u, "").trim();
  if (cleaned.length >= 3) return cleaned.slice(0, 120);
  const after = text.slice(hitIndex, hitIndex + 160);
  const afterLine = after.split(/\r?\n/)[0]?.replace(/^\S+\s*/, "").trim() ?? "";
  if (afterLine.length >= 3) return afterLine.slice(0, 120);
  return "Watched event";
}

function pageTitle(text: string): string {
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (t.length >= 3 && t.length <= 120) return t;
  }
  return "WatchCal feed";
}

/**
 * Conservative dated-event extractor for HTML/PDF plain text.
 * Returns [] when no dates are found (caller still emits a valid thin calendar).
 */
export function parseSourceText(
  text: string,
  now: Date = new Date()
): { title: string; events: ParsedEvent[] } {
  const cleaned = text.replace(/\u00a0/g, " ").trim();
  const title = pageTitle(cleaned);
  if (!cleaned) return { title: "WatchCal feed", events: [] };

  const dates = findDates(cleaned, now);
  if (!dates.length) return { title, events: [] };

  // Cap events so a noisy page cannot explode the feed.
  const limited = dates.slice(0, 40);
  const events: ParsedEvent[] = limited.map((hit) => {
    const start = new Date(
      hit.date.getFullYear(),
      hit.date.getMonth(),
      hit.date.getDate()
    );
    const end = new Date(start);
    end.setDate(end.getDate() + 1);
    const window = cleaned.slice(
      Math.max(0, hit.index - 80),
      Math.min(cleaned.length, hit.index + hit.raw.length + 120)
    );
    return {
      summary: lineSummary(cleaned, hit.index),
      description: window.trim().slice(0, 500),
      start: start.toISOString(),
      end: end.toISOString(),
      allDay: true,
    };
  });

  return { title, events };
}

/** Strip HTML to visible-ish text. Conservative, no DOM dependency. */
export function htmlToText(html: string): { title: string; text: string } {
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch
    ? titleMatch[1].replace(/\s+/g, " ").trim().slice(0, 120)
    : "";
  let body = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ");
  body = body.replace(/<\/(p|div|tr|li|h[1-6]|br|table|section|article)>/gi, "\n");
  body = body.replace(/<br\s*\/?>/gi, "\n");
  body = body.replace(/<[^>]+>/g, " ");
  body = body
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
  body = body
    .split(/\r?\n/)
    .map((l) => l.replace(/[ \t]+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
  return { title: title || pageTitle(body), text: body };
}
