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

/** Nav / chrome lines that must never become SUMMARY or DESCRIPTION. */
const CHROME_LINE =
  /^(log in|sign in|create account|contents|move to sidebar|hide|show|toggle\b|main page|random article|about wikipedia|contact us|donate|tools|search|appearance|not logged in|talk|contributions|learn to edit|community portal|recent changes|upload file|special pages|help|\[edit\]|edit\b|references|external links|see also|navigation|personal tools|print\/export|\(top\))$/i;

function parseDateParts(
  day: number,
  month: number,
  year: number
): Date | null {
  if (day < 1 || day > 31 || month < 0 || month > 11) return null;
  let y = year;
  if (y < 100) y += 2000;
  if (y < 1900 || y > 2100) return null;
  const d = new Date(y, month, day);
  if (d.getMonth() !== month || d.getDate() !== day) return null;
  return d;
}

type DateHit = {
  index: number;
  date: Date;
  raw: string;
  end: number;
  /** Inclusive last day when this hit is a written date range. */
  endDate?: Date;
};

export type ParseSourceOptions = {
  /** PDF filename, HTML <title>, or similar — used for document-year inheritance. */
  sourceTitle?: string;
  sourceUrl?: string;
};

/**
 * True when the digit before a month name is outline numbering (e.g. "1.1 January"),
 * not a calendar day.
 */
function isOutlineNumbering(text: string, matchIndex: number): boolean {
  const before = text.slice(Math.max(0, matchIndex - 12), matchIndex);
  // "1.1 " or "1.1\n" immediately before the match, or match itself starts mid "1.1"
  if (/\d+\.\d+\s*$/.test(before)) return true;
  if (/\d+\.$/.test(before)) return true;
  return false;
}

function decodeHint(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

function yearsIn(s: string): number[] {
  const out: number[] = [];
  const re = /\b((?:19|20)\d{2})\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    const y = Number(m[1]);
    if (y >= 1900 && y <= 2100) out.push(y);
  }
  return out;
}

/**
 * Document-level calendar year from title/filename/URL, or a clear in-document
 * calendar label. Does not invent a year from a lone gazette date.
 */
function inferDocumentYear(
  text: string,
  opts?: ParseSourceOptions
): number | null {
  const hint = [opts?.sourceTitle, opts?.sourceUrl]
    .filter(Boolean)
    .map((s) => decodeHint(s as string))
    .join(" ");
  const fromHint = yearsIn(hint);
  if (fromHint.length) return fromHint[fromHint.length - 1];

  const head = text.slice(0, 1200);
  const labelled =
    head.match(/\b((?:19|20)\d{2})\s+calendar\b/i) ||
    head.match(/\bcalendar\b[^\n]{0,40}?\b((?:19|20)\d{2})\b/i) ||
    head.match(/\bholidays?\s+((?:19|20)\d{2})\b/i) ||
    head.match(/\b((?:19|20)\d{2})\s+holidays?\b/i) ||
    head.match(/\bschool\s+year\s+((?:19|20)\d{2})\b/i);
  if (labelled) {
    const y = Number(labelled[1]);
    if (y >= 1900 && y <= 2100) return y;
  }

  // Explicit years already on the page: only when one year clearly dominates
  // the header (avoids a single gazette date becoming the calendar year).
  const counts = new Map<number, number>();
  for (const y of yearsIn(head)) {
    counts.set(y, (counts.get(y) || 0) + 1);
  }
  let best: number | null = null;
  let bestN = 0;
  for (const [y, n] of counts) {
    if (n > bestN) {
      best = y;
      bestN = n;
    }
  }
  if (best != null && bestN >= 2) return best;
  return null;
}

/** Holiday / labelled day: month followed by a name (space optional: "JanuaryNew"). */
function hasTrailingLabel(text: string, afterMonth: number): boolean {
  return /^[A-Za-z]/.test(text.slice(afterMonth)) ||
    /^[\s\u00a0]+[A-Za-z]/.test(text.slice(afterMonth));
}

function overlapsExisting(hits: DateHit[], index: number, end: number): boolean {
  return hits.some((h) => index < h.end && end > h.index);
}

/** Day from "14" or term-glued "208" → 8; rejects years (4+ digits). */
function dayFromPossibleGlue(raw: string): number | null {
  if (!/^\d{1,3}$/.test(raw)) return null;
  const n = Number(raw);
  if (n >= 1 && n <= 31) return n;
  if (raw.length === 3) {
    const day = Number(raw.slice(1));
    if (day >= 1 && day <= 31) return day;
  }
  return null;
}

function findDates(text: string, inheritYear: number | null): DateHit[] {
  const hits: DateHit[] = [];
  const patterns: Array<{
    re: RegExp;
    pick: (m: RegExpExecArray) => Date | null;
  }> = [
    // "15 March 2026" / "15th March 2026" — year required (avoids ToC "1 January")
    {
      re: new RegExp(
        String.raw`\b(\d{1,2})(?:st|nd|rd|th)?\s+(${MONTH_ALT})\s+(\d{4}|\d{2})\b`,
        "gi"
      ),
      pick: (m) => {
        if (isOutlineNumbering(text, m.index)) return null;
        const month = MONTHS[m[2].toLowerCase()];
        if (month == null) return null;
        return parseDateParts(Number(m[1]), month, Number(m[3]));
      },
    },
    // "March 15, 2026" / "March 15 2026" — year required
    {
      re: new RegExp(
        String.raw`\b(${MONTH_ALT})\s+(\d{1,2})(?:st|nd|rd|th)?(?!\d),?\s+(\d{4}|\d{2})\b`,
        "gi"
      ),
      pick: (m) => {
        if (isOutlineNumbering(text, m.index)) return null;
        const month = MONTHS[m[1].toLowerCase()];
        if (month == null) return null;
        return parseDateParts(Number(m[2]), month, Number(m[3]));
      },
    },
    // Numeric with year: 15/03/2026 or 03-15-2026
    {
      re: /\b(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4}|\d{2})\b/g,
      pick: (m) => {
        const a = Number(m[1]);
        const b = Number(m[2]);
        const y = Number(m[3]);
        if (b >= 1 && b <= 12) return parseDateParts(a, b - 1, y);
        if (a >= 1 && a <= 12) return parseDateParts(b, a - 1, y);
        return null;
      },
    },
    // ISO: 2026-03-15
    {
      re: /\b(\d{4})-(\d{2})-(\d{2})\b/g,
      pick: (m) =>
        parseDateParts(Number(m[3]), Number(m[2]) - 1, Number(m[1])),
    },
  ];

  for (const { re, pick } of patterns) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const date = pick(m);
      if (!date) continue;
      hits.push({
        index: m.index,
        end: m.index + m[0].length,
        date,
        raw: m[0],
      });
    }
  }

  // Conservative year inheritance: written ranges + holiday lines only.
  if (inheritYear != null) {
    // "14 January – 27 March" / term-glued "208 April – 26 June" / "09 (11) December"
    const rangeRe = new RegExp(
      // (?![A-Za-z]) not \b: PDF glue like "March1153" has no word boundary before digits.
      // Only treat spaced 19xx/20xx as an on-line year (not glued stats like "December 1047").
      String.raw`(\d{1,3})(?:st|nd|rd|th)?\s+(${MONTH_ALT})\s*[–—−-]\s*(\d{1,2})(?:\s*\(\d{1,2}\))?(?:st|nd|rd|th)?\s+(${MONTH_ALT})(?![A-Za-z])(?!\s+((?:19|20)\d{2})\b)`,
      "gi"
    );
    let rm: RegExpExecArray | null;
    while ((rm = rangeRe.exec(text)) !== null) {
      const day1 = dayFromPossibleGlue(rm[1]);
      if (day1 == null) continue;
      // Align index to the day digits actually used (skip glued term index).
      const dayToken = String(day1).padStart(rm[1].length <= 2 ? rm[1].length : 2, "0");
      const dayOffset =
        rm[1].length > 2 && Number(rm[1]) > 31 ? rm[1].length - dayToken.length : 0;
      const index = rm.index + dayOffset;
      if (isOutlineNumbering(text, index)) continue;
      const end = rm.index + rm[0].length;
      if (overlapsExisting(hits, index, end)) continue;
      const m1 = MONTHS[rm[2].toLowerCase()];
      const m2 = MONTHS[rm[4].toLowerCase()];
      if (m1 == null || m2 == null) continue;
      const start = parseDateParts(day1, m1, inheritYear);
      const stop = parseDateParts(Number(rm[3]), m2, inheritYear);
      if (!start || !stop) continue;
      // Do not invent days; reject inverted ranges within the same year.
      if (stop.getTime() < start.getTime()) continue;
      const raw = text.slice(index, end);
      hits.push({
        index,
        end,
        date: start,
        endDate: stop,
        raw,
      });
    }

    // "01 January New Year's Day" / "01 JanuaryNew Year's Day" — day+month+label, no year
    const holidayRe = new RegExp(
      String.raw`\b(\d{1,2})(?:st|nd|rd|th)?\s+(${MONTH_ALT})(?!\s+((?:19|20)\d{2})\b)`,
      "gi"
    );
    let hm: RegExpExecArray | null;
    while ((hm = holidayRe.exec(text)) !== null) {
      if (isOutlineNumbering(text, hm.index)) continue;
      const end = hm.index + hm[0].length;
      if (overlapsExisting(hits, hm.index, end)) continue;
      if (!hasTrailingLabel(text, end)) continue;
      const month = MONTHS[hm[2].toLowerCase()];
      if (month == null) continue;
      const date = parseDateParts(Number(hm[1]), month, inheritYear);
      if (!date) continue;
      hits.push({
        index: hm.index,
        end,
        date,
        raw: hm[0],
      });
    }
  }

  hits.sort((a, b) => a.index - b.index);
  const out: DateHit[] = [];
  for (const h of hits) {
    const dup = out.find(
      (o) =>
        Math.abs(o.index - h.index) < 8 &&
        o.date.toDateString() === h.date.toDateString() &&
        (o.endDate?.toDateString() || "") === (h.endDate?.toDateString() || "")
    );
    if (!dup) out.push(h);
  }
  return out;
}

function isChromeLine(line: string): boolean {
  const t = line.trim();
  if (!t) return true;
  if (t.length <= 2) return true;
  if (CHROME_LINE.test(t)) return true;
  // Bare outline markers: "1.1", "1", "2.3.4"
  if (/^\d+(\.\d+)*\.?$/.test(t)) return true;
  return false;
}

/**
 * Build SUMMARY from the line containing the date (or nearest non-chrome line).
 * Returns null when nothing usable exists — caller drops the hit.
 */
function lineSummary(text: string, hit: DateHit): string | null {
  const lineStart = text.lastIndexOf("\n", hit.index) + 1;
  const lineEndIdx = text.indexOf("\n", hit.end);
  const lineEnd = lineEndIdx === -1 ? text.length : lineEndIdx;
  let line = text.slice(lineStart, lineEnd).replace(/\s+/g, " ").trim();

  // Prefer text after the date on the same line (typical "15 March 2026 Home vs North")
  const afterDate = text
    .slice(hit.end, lineEnd)
    .replace(/^[\s,;:\-\u2013\u2014–—]+/u, "")
    .trim();
  // Range rows often glue digits after the end date ("27 March1153"); prefer the range raw.
  if (hit.endDate && (!afterDate || /^\d/.test(afterDate))) {
    return hit.raw.replace(/\s+/g, " ").trim().slice(0, 120);
  }
  if (afterDate.length >= 3 && !isChromeLine(afterDate) && !/^\d{2,}/.test(afterDate)) {
    return afterDate.slice(0, 120);
  }

  // Else use the line with the raw date stripped
  const withoutDate = line
    .replace(hit.raw, " ")
    .replace(/\s+/g, " ")
    .replace(/^[\s,;:\-\u2013\u2014–—]+|[\s,;:\-\u2013\u2014–—]+$/gu, "")
    .trim();
  if (withoutDate.length >= 3 && !isChromeLine(withoutDate)) {
    return withoutDate.slice(0, 120);
  }

  // Walk nearby non-chrome lines for a title
  const lines = text.split(/\r?\n/);
  let at = 0;
  let lineIdx = 0;
  for (let i = 0; i < lines.length; i++) {
    const next = at + lines[i].length + 1;
    if (hit.index >= at && hit.index < next) {
      lineIdx = i;
      break;
    }
    at = next;
  }
  for (const j of [lineIdx - 1, lineIdx + 1, lineIdx - 2, lineIdx + 2]) {
    if (j < 0 || j >= lines.length) continue;
    const cand = lines[j].trim();
    if (!isChromeLine(cand) && cand.length >= 3 && cand.length <= 120) {
      return cand.slice(0, 120);
    }
  }
  return null;
}

function eventDescription(text: string, hit: DateHit): string {
  const lineStart = text.lastIndexOf("\n", hit.index) + 1;
  const lineEndIdx = text.indexOf("\n", hit.end);
  const lineEnd = lineEndIdx === -1 ? text.length : lineEndIdx;
  const line = text.slice(lineStart, lineEnd).replace(/\s+/g, " ").trim();
  if (line && !isChromeLine(line)) return line.slice(0, 500);

  const window = text
    .slice(Math.max(0, hit.index - 40), Math.min(text.length, hit.end + 160))
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !isChromeLine(l))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  return window.slice(0, 500);
}

function pageTitle(text: string): string {
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (t.length >= 3 && t.length <= 120 && !isChromeLine(t)) return t;
  }
  return "WatchCal feed";
}

function dropChromeLines(text: string): string {
  return text
    .split(/\r?\n/)
    .map((l) => l.replace(/[ \t]+/g, " ").trim())
    .filter((l) => l && !isChromeLine(l))
    .join("\n");
}

/**
 * Conservative dated-event extractor for HTML/PDF plain text.
 * Year is required on the line, or inherited only for written date ranges and
 * holiday lines when a document-level year is known (title, filename, or a
 * clear calendar year already on the page). Never invents days from outline
 * numbers; never uses SUMMARY "Watched event". Returns [] when none found.
 */
export function parseSourceText(
  text: string,
  _now: Date = new Date(),
  opts?: ParseSourceOptions
): { title: string; events: ParsedEvent[] } {
  const cleaned = dropChromeLines(text.replace(/\u00a0/g, " ").trim());
  const title = pageTitle(cleaned);
  if (!cleaned) return { title: "WatchCal feed", events: [] };

  const inheritYear = inferDocumentYear(cleaned, opts);
  const dates = findDates(cleaned, inheritYear);
  if (!dates.length) return { title, events: [] };

  const events: ParsedEvent[] = [];
  for (const hit of dates.slice(0, 40)) {
    const summary = lineSummary(cleaned, hit);
    if (!summary) continue;
    const start = new Date(
      hit.date.getFullYear(),
      hit.date.getMonth(),
      hit.date.getDate()
    );
    const last = hit.endDate
      ? new Date(
          hit.endDate.getFullYear(),
          hit.endDate.getMonth(),
          hit.endDate.getDate()
        )
      : start;
    const end = new Date(last);
    end.setDate(end.getDate() + 1);
    events.push({
      summary,
      description: eventDescription(cleaned, hit) || summary,
      start: start.toISOString(),
      end: end.toISOString(),
      allDay: true,
    });
  }

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
  // Drop common chrome regions before tag stripping
  body = body
    .replace(/<nav[\s\S]*?<\/nav>/gi, " ")
    .replace(/<header[\s\S]*?<\/header>/gi, " ")
    .replace(/<footer[\s\S]*?<\/footer>/gi, " ")
    .replace(/<aside[\s\S]*?<\/aside>/gi, " ")
    .replace(/<form[\s\S]*?<\/form>/gi, " ");
  body = body.replace(
    /<(?:div|section|ul|ol|table)[^>]*(?:id|class|role|aria-label)=["'][^"']*(?:nav|toc|sidebar|menu|mw-panel|vector-toc|vector-header|vector-main-menu|footer)[^"']*["'][^>]*>[\s\S]*?<\/(?:div|section|ul|ol|table)>/gi,
    " "
  );
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
  body = dropChromeLines(body);
  return { title: title || pageTitle(body), text: body };
}
