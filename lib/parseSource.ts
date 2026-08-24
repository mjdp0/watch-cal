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

    // School PDF style: "Term Commences Wednesday 14 January" /
    // "Half Term Thursday 19 February" — weekday + day + month, document year.
    // Require a non-weekday label before the weekday on the same line (or a
    // trailing label) so bare weekday crumbs are not invented as events.
    const weekdayDateRe = new RegExp(
      String.raw`\b(?:${WEEKDAY_ALT})\s+(\d{1,2})(?:st|nd|rd|th)?\s+(${MONTH_ALT})(?!\s+((?:19|20)\d{2})\b)`,
      "gi"
    );
    let wm: RegExpExecArray | null;
    while ((wm = weekdayDateRe.exec(text)) !== null) {
      if (isOutlineNumbering(text, wm.index)) continue;
      const end = wm.index + wm[0].length;
      if (overlapsExisting(hits, wm.index, end)) continue;
      const lineStart = text.lastIndexOf("\n", wm.index) + 1;
      const before = text.slice(lineStart, wm.index).replace(/\s+/g, " ").trim();
      const beforeClean = stripTrailingWeekday(before);
      if (beforeClean.length < 3 && !hasTrailingLabel(text, end)) continue;
      const month = MONTHS[wm[2].toLowerCase()];
      if (month == null) continue;
      const date = parseDateParts(Number(wm[1]), month, inheritYear);
      if (!date) continue;
      hits.push({
        index: wm.index,
        end,
        date,
        raw: wm[0],
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

const TERM_ORDINAL: Record<string, number> = {
  first: 1,
  second: 2,
  third: 3,
  fourth: 4,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
};

const WEEKDAY_ALT =
  "Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday";

const WEEKDAY_ONLY =
  /^(monday|tuesday|wednesday|thursday|friday|saturday|sunday)$/i;

/** Remove a weekday glued before a date — not weekdays inside names (Good Friday). */
function stripTrailingWeekday(s: string): string {
  return s
    .replace(new RegExp(String.raw`\b(?:${WEEKDAY_ALT})\s*$`, "i"), "")
    .replace(/\s+/g, " ")
    .replace(/^[\s,;:\-\u2013\u2014–—]+|[\s,;:\-\u2013\u2014–—]+$/gu, "")
    .trim();
}

/** Bare Opens/Closes, weekday crumbs, or footnote leftovers — never SUMMARY. */
function isJunkSummary(s: string): boolean {
  const t = s.trim();
  if (!t) return true;
  if (/^(opens|closes)$/i.test(t)) return true;
  // "(2)", "(1) | 14 January 2026 (2)", leftover pipe/footnote fragments
  if (/^\(\d+\)/.test(t)) return true;
  if (/^\(\d+\)\s*\|/.test(t)) return true;
  if (WEEKDAY_ONLY.test(t)) return true;
  // Table header crumbs: "TERM 2 May", "HOLIDAYS Dec"
  if (
    /^(terms?\s*\d+|holidays?|school\s*holidays?)\s+(jan|january|feb|february|mar|march|apr|april|may|jun|june|jul|july|aug|august|sep|sept|september|oct|october|nov|november|dec|december)\b/i.test(
      t
    )
  ) {
    return true;
  }
  // Bare section headers used as titles
  if (/^(terms?\s*\d+|holidays?|school\s*holidays?|hol\s*'?s)$/i.test(t)) {
    return true;
  }
  // Chopped multi-weekday / date-list fragments from festival rows
  const weekdayHits = t.match(new RegExp(String.raw`\b(?:${WEEKDAY_ALT})\b`, "gi"));
  if (weekdayHits && weekdayHits.length >= 2) return true;
  if (
    /^(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\s+\d{1,2}\b/i.test(
      t
    )
  ) {
    return true;
  }
  // Time / punctuation crumbs left after stripping a date
  if (/^[,;:\-–—/\s\d&)]+$/.test(t)) return true;
  if (/^\d{1,2}(,\s*\d{1,2})+(\s*(and|&)\s*\d{1,2})?/i.test(t)) return true;
  if (/,\s*\d{1,2}:\d{2}\b/.test(t) && !/half\s*terms?/i.test(t)) return true;
  // Audience / note parentheses alone — not an event title (ok as a join piece)
  if (/^\([^)]*\)\s*$/.test(t)) return true;
  if (/^term$/i.test(t)) return true;
  if (/\band\s*$/i.test(t)) return true;
  if (/\(\s*normal opening\b/i.test(t)) return true;
  if (/^\d{1,2},\s*/.test(t)) return true;
  // Truncated "Public Holiday: Good" after bad weekday strip (should not recur)
  if (/^public holidays?:\s*(good|easter|family|workers'?|freedom|human)?\s*$/i.test(t)) {
    return true;
  }
  return false;
}

/**
 * Western Cape dual open/close markers: "(1) for Educators" / "(2) for Learners".
 * Only used when (1)/(2) sits on the same Opens/Closes line after a date.
 */
function termAudienceLabel(text: string, hit: DateHit): string | null {
  const lineEndIdx = text.indexOf("\n", hit.end);
  const lineEnd = lineEndIdx === -1 ? text.length : lineEndIdx;
  const after = text.slice(hit.end, lineEnd);
  const mark = after.match(/^\s*\((\d+)\)/);
  if (!mark) return null;
  if (mark[1] === "1") return "staff"; // source: Educators
  if (mark[1] === "2") return "learners";
  return null;
}

/**
 * Western Cape–style lists: "First" / "Opens: 14 January 2026" / "Closes: …"
 * → "Term 1 opens". Dual (1)/(2) dates → "Term 1 opens (staff|learners)".
 * Looks only at a few preceding lines; does not reopen junk-parse.
 */
function termBoundSummary(text: string, hit: DateHit): string | null {
  const lineStart = text.lastIndexOf("\n", hit.index) + 1;
  const lineEndIdx = text.indexOf("\n", hit.end);
  const lineEnd = lineEndIdx === -1 ? text.length : lineEndIdx;
  const line = text.slice(lineStart, lineEnd).replace(/\s+/g, " ").trim();
  const verbMatch = line.match(/^(opens|closes)\b/i);
  if (!verbMatch) return null;
  const verb = verbMatch[1].toLowerCase() === "opens" ? "opens" : "closes";

  const before = text.slice(0, lineStart);
  const prev = before
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter((l) => l && !isChromeLine(l));
  let termN: number | null = null;
  for (let i = prev.length - 1; i >= Math.max(0, prev.length - 8); i--) {
    const t = prev[i];
    if (/^(opens|closes)\b/i.test(t)) continue;
    const ord = t.match(/^(first|second|third|fourth)\b/i);
    if (ord) {
      const n = TERM_ORDINAL[ord[1].toLowerCase()];
      if (n) {
        termN = n;
        break;
      }
    }
    const tm = t.match(/^terms?\s+(\d+|one|two|three|four)\b/i);
    if (tm) {
      const g = tm[1].toLowerCase();
      const n = /^\d+$/.test(g) ? Number(g) : TERM_ORDINAL[g];
      if (n && n >= 1 && n <= 4) {
        termN = n;
        break;
      }
    }
  }
  // Opens/Closes without a term heading — drop rather than emit bare verb.
  if (termN == null) return null;
  const audience = termAudienceLabel(text, hit);
  if (audience) return `Term ${termN} ${verb} (${audience})`;
  return `Term ${termN} ${verb}`;
}

/**
 * When the date sits on a weekday-only / empty line (common PDF table extract),
 * pull the nearest preceding event label — including a parenthetical audience
 * line like "(Prep Students)". Uses source words; does not invent Term N.
 */
function precedingEventLabel(text: string, hit: DateHit): string | null {
  const lineStart = text.lastIndexOf("\n", hit.index) + 1;
  const before = text.slice(0, lineStart);
  const prev = before
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter((l) => l && !isChromeLine(l));
  const picked: string[] = [];
  for (let i = prev.length - 1; i >= Math.max(0, prev.length - 6); i--) {
    const t = prev[i];
    if (/^\d{1,3}$/.test(t)) continue;
    if (/^[–—−-]$/.test(t)) continue;
    if (WEEKDAY_ONLY.test(t)) continue;
    // Parenthetical audience joins with the prior label — not junk by itself here
    if (/^\([^)]+\)$/.test(t)) {
      picked.unshift(t);
      continue;
    }
    if (isJunkSummary(t)) continue;
    // Skip pure month tokens from fragmented PDF columns
    if (MONTHS[t.toLowerCase()] != null) continue;
    if (/^\(?\d{2,4}\)?$/.test(t)) continue;
    picked.unshift(t);
    break;
  }
  if (!picked.length) return null;
  const joined = picked.join(" ").replace(/\s+/g, " ").trim();
  const cleaned = stripTrailingWeekday(joined);
  if (!cleaned || isJunkSummary(cleaned)) return null;
  return cleaned.slice(0, 120);
}

function finalizeSummary(raw: string | null): string | null {
  if (!raw) return null;
  // Do not strip weekdays here — "Good Friday" / "Easter Sunday" are titles.
  const cleaned = raw.replace(/\s+/g, " ").trim().slice(0, 120);
  if (!cleaned || isJunkSummary(cleaned)) return null;
  return cleaned;
}

/**
 * Build SUMMARY from the line containing the date (or nearest non-chrome line).
 * Returns null when nothing usable exists — caller drops the hit.
 * Prefer source row labels; never keep bare weekdays or table-header crumbs.
 */
function lineSummary(text: string, hit: DateHit): string | null {
  const lineStart = text.lastIndexOf("\n", hit.index) + 1;
  const lineEndIdx = text.indexOf("\n", hit.end);
  const lineEnd = lineEndIdx === -1 ? text.length : lineEndIdx;
  const line = text.slice(lineStart, lineEnd).replace(/\s+/g, " ").trim();

  // Term open/close rows: resolve before afterDate (which otherwise grabs "(2)").
  if (/^(opens|closes)\b/i.test(line)) {
    return termBoundSummary(text, hit);
  }

  // Range rows: keep written spans (DBE-style). Drop TERM/HOLIDAYS column
  // cells whose only neighbour is a section header (not the PDF a parent reads).
  if (hit.endDate) {
    const fromPrev = precedingEventLabel(text, hit);
    if (
      fromPrev &&
      /^(terms?\s*\d+|holidays?|school\s*holidays?|hol\s*'?s)$/i.test(fromPrev)
    ) {
      return null;
    }
    const beforeRange = stripTrailingWeekday(
      line.slice(0, Math.max(0, hit.index - lineStart)).replace(/\s+/g, " ")
    ).trim();
    const fromBefore = finalizeSummary(beforeRange);
    if (fromBefore) return fromBefore;
    if (fromPrev) return fromPrev;
    const raw = hit.raw.replace(/\s+/g, " ").trim().slice(0, 120);
    return raw || null;
  }

  // Same-line label before the date beats afterDate crumbs (", 12:00").
  // Cut at an earlier weekday+day on multi-date lines ("… Monday 12 and Tuesday 13").
  const beforeRaw = text.slice(lineStart, hit.index).replace(/\s+/g, " ").trim();
  const beforeCut = beforeRaw.replace(
    new RegExp(String.raw`\s+(?:${WEEKDAY_ALT})\s+\d{1,2}\b.*$`, "i"),
    ""
  );
  const beforeDate = stripTrailingWeekday(beforeCut);
  const fromBeforeDate = finalizeSummary(beforeDate);
  if (fromBeforeDate) return fromBeforeDate;

  // Prefer text after the date on the same line (typical "15 March 2026 Home vs North")
  const afterDate = text
    .slice(hit.end, lineEnd)
    .replace(/^[\s,;:\-\u2013\u2014–—]+/u, "")
    .trim();
  if (
    afterDate.length >= 3 &&
    !isChromeLine(afterDate) &&
    !/^\d{2,}/.test(afterDate) &&
    !isJunkSummary(afterDate)
  ) {
    const fromAfter = finalizeSummary(afterDate);
    if (fromAfter) return fromAfter;
  }

  // Else use the line with the raw date stripped; drop a weekday glued to the date only.
  const withoutDate = stripTrailingWeekday(
    line
      .replace(hit.raw, " ")
      .replace(/\s+/g, " ")
      .replace(/^[\s,;:\-\u2013\u2014–—]+|[\s,;:\-\u2013\u2014–—]+$/gu, "")
      .trim()
  );
  const withoutDateFinal = finalizeSummary(withoutDate);
  if (withoutDateFinal) return withoutDateFinal;

  const fromPrev = precedingEventLabel(text, hit);
  if (fromPrev) return fromPrev;

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
    const cand = finalizeSummary(lines[j].trim());
    if (cand && cand.length >= 3 && cand.length <= 120) {
      return cand;
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

/** Live Western Cape school-calendar page (terms + holidays; planning PDF linked). */
export const WESTERN_CAPE_SCHOOL_CALENDAR_URL =
  "https://www.westerncape.gov.za/education/school-calendar";

/** English Planning Calendar PDF linked from that page (decode &amp;). */
export const WESTERN_CAPE_PLANNING_PDF_URL =
  "https://www.westerncape.gov.za/education/files/wcg-blob-files?file=2025-12/circ28_25-2026-planning-calendar-for-schools.pdf&type=file";

/**
 * Grade 12 / NSC / exam nav pages linked from the school-calendar chrome
 * (other pages — not dates on the school-calendar HTML itself), including
 * Second Chance Matric Programme when it states a tutoring registration day.
 * Afrikaans/IsiXhosa planning PDFs are the same calendar as English (no
 * extra parent day-dates); exam pages carry proven day-level dates the
 * English planning PDF left month-only or TBC.
 */
export const WESTERN_CAPE_EXAM_PAGE_URLS = [
  "https://www.westerncape.gov.za/education/exams",
  "https://www.westerncape.gov.za/education/national-senior-certificate-nsc-exams",
  "https://www.westerncape.gov.za/education/national-senior-certificate-nsc-exams-june",
  "https://www.westerncape.gov.za/education/senior-certificate-sc-exams-mayjune",
  "https://www.westerncape.gov.za/education/matric-awards",
  "https://www.westerncape.gov.za/education/second-chance-matric-programme",
] as const;

/**
 * Final Oct/Nov 2026 NSC examination timetable (Annexure A) linked from the
 * exam-nav “November exam timetable” control on /exams and related pages.
 */
export const WESTERN_CAPE_NOV_NSC_TIMETABLE_PDF_URL =
  "https://www.westerncape.gov.za/education/files/wcg-blob-files?file=2026-05/Annexure%20A_1.pdf&type=file";

/**
 * November 2026 NSC registration form linked from the June NSC page.
 * Form body proves the closing day only — not the June-page “7–21 August 2027” typo.
 */
export const WESTERN_CAPE_NOV_NSC_REG_FORM_PDF_URL =
  "https://www.westerncape.gov.za/education/files/wcg-blob-files?file=2026-08/nsc-november-2026-registration-form_7-21-august-2026.pdf&type=file";

export function isWesternCapeSchoolCalendarUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return (
      /(^|\.)westerncape\.gov\.za$/i.test(u.hostname) &&
      /\/education\/school-calendar\/?$/i.test(u.pathname)
    );
  } catch {
    return false;
  }
}

export function looksLikeWesternCapeSchoolCalendar(text: string): boolean {
  return (
    /Terms \(All Provinces\)/i.test(text) &&
    /\bOpens:\s*\d{1,2}\s+\w+\s+20\d{2}/i.test(text) &&
    /\bCloses:\s*\d{1,2}\s+\w+\s+20\d{2}/i.test(text) &&
    /\(1\)\s*for Educators/i.test(text)
  );
}

type WcBound = { date: Date; mark: 1 | 2 | null };

function parseWcBounds(line: string): WcBound[] {
  const out: WcBound[] = [];
  const re = new RegExp(
    String.raw`(\d{1,2})\s+(${MONTH_ALT})\s+(20\d{2})(?:\s*\((\d+)\))?`,
    "gi"
  );
  let m: RegExpExecArray | null;
  while ((m = re.exec(line)) !== null) {
    const month = MONTHS[m[2].toLowerCase()];
    if (month == null) continue;
    const date = parseDateParts(Number(m[1]), month, Number(m[3]));
    if (!date) continue;
    const markRaw = m[4] ? Number(m[4]) : null;
    const mark = markRaw === 1 || markRaw === 2 ? (markRaw as 1 | 2) : null;
    out.push({ date, mark });
  }
  return out;
}

function allDaySpan(
  summary: string,
  description: string,
  open: Date,
  close: Date
): ParsedEvent {
  const start = new Date(open.getFullYear(), open.getMonth(), open.getDate());
  const last = new Date(close.getFullYear(), close.getMonth(), close.getDate());
  const end = new Date(last);
  end.setDate(end.getDate() + 1);
  return {
    summary,
    description,
    start: start.toISOString(),
    end: end.toISOString(),
    allDay: true,
  };
}

function allDayDay(
  summary: string,
  description: string,
  day: Date
): ParsedEvent {
  return allDaySpan(summary, description, day, day);
}

/** Timed span in an Olson zone. Wall clock → ISO via fixed SAST offset when zone is Johannesburg. */
function timedSpanInZone(
  summary: string,
  description: string,
  year: number,
  monthIndex: number,
  day: number,
  startHour: number,
  startMinute: number,
  endHour: number,
  endMinute: number,
  timeZone: string
): ParsedEvent {
  // Africa/Johannesburg is UTC+2 year-round (no DST). Other zones not used yet.
  const offsetHours = timeZone === "Africa/Johannesburg" ? 2 : 0;
  const start = new Date(
    Date.UTC(year, monthIndex, day, startHour - offsetHours, startMinute, 0)
  );
  const end = new Date(
    Date.UTC(year, monthIndex, day, endHour - offsetHours, endMinute, 0)
  );
  return {
    summary,
    description,
    start: start.toISOString(),
    end: end.toISOString(),
    allDay: false,
    timeZone,
  };
}

function pickBound(bounds: WcBound[], mark: 1 | 2): Date | null {
  const hit = bounds.find((b) => b.mark === mark);
  if (hit) return hit.date;
  const single = bounds.find((b) => b.mark == null);
  return single ? single.date : null;
}

function termSpansForYear(
  termN: number,
  year: number,
  opensLine: string,
  closesLine: string
): ParsedEvent[] {
  const opens = parseWcBounds(opensLine);
  const closes = parseWcBounds(closesLine);
  if (!opens.length || !closes.length) return [];

  const dual =
    (opens.some((b) => b.mark === 1) || closes.some((b) => b.mark === 1)) &&
    (opens.some((b) => b.mark === 2) || closes.some((b) => b.mark === 2));

  if (dual) {
    const openStaff = pickBound(opens, 1);
    const openLearn = pickBound(opens, 2);
    const closeStaff = pickBound(closes, 1);
    const closeLearn = pickBound(closes, 2);
    if (!openStaff || !openLearn || !closeStaff || !closeLearn) return [];
    const same =
      openStaff.getTime() === openLearn.getTime() &&
      closeStaff.getTime() === closeLearn.getTime();
    if (!same) {
      return [
        allDaySpan(
          `Term ${termN} ${year} (staff)`,
          opensLine + " / " + closesLine,
          openStaff,
          closeStaff
        ),
        allDaySpan(
          `Term ${termN} ${year} (learners)`,
          opensLine + " / " + closesLine,
          openLearn,
          closeLearn
        ),
      ];
    }
  }

  const open = opens[0]?.date;
  const close = closes[closes.length - 1]?.date;
  if (!open || !close) return [];
  return [
    allDaySpan(
      `Term ${termN} ${year}`,
      opensLine + " / " + closesLine,
      open,
      close
    ),
  ];
}

/**
 * Western Cape school-calendar HTML: term Opens/Closes → one dated SPAN per
 * term (DTSTART=opens, DTEND exclusive = day after closes), titled Term N YYYY.
 * Dual staff/learner bounds → two spans. Holidays stay named all-day days with year.
 */
export function parseWesternCapeSchoolCalendarHtml(
  text: string
): { title: string; events: ParsedEvent[] } {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  const events: ParsedEvent[] = [];
  let year: number | null = null;
  let termN: number | null = null;
  let opensLine: string | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    const yearHead = line.match(/\b(20\d{2})\s+School Calendar\b/i);
    if (yearHead) {
      year = Number(yearHead[1]);
      termN = null;
      opensLine = null;
      continue;
    }
    const holHead = line.match(/\b(20\d{2})\s+Public Holidays\b/i);
    if (holHead) {
      year = Number(holHead[1]);
      termN = null;
      opensLine = null;
      continue;
    }

    const ord = line.match(/^(First|Second|Third|Fourth)\b/i);
    if (ord && year != null) {
      termN = TERM_ORDINAL[ord[1].toLowerCase()] ?? null;
      opensLine = null;
      continue;
    }

    if (termN != null && year != null && /^Opens:/i.test(line)) {
      opensLine = line;
      continue;
    }
    if (
      termN != null &&
      year != null &&
      opensLine &&
      /^Closes:/i.test(line)
    ) {
      events.push(...termSpansForYear(termN, year, opensLine, line));
      opensLine = null;
      termN = null;
      continue;
    }

    // "1 January 2026 – New Year's Day"
    const hol = line.match(
      new RegExp(
        String.raw`^(\d{1,2})\s+(${MONTH_ALT})\s+(20\d{2})\s*[–—−-]\s*(.+)$`,
        "i"
      )
    );
    if (hol) {
      const month = MONTHS[hol[2].toLowerCase()];
      const y = Number(hol[3]);
      const date = month == null ? null : parseDateParts(Number(hol[1]), month, y);
      const name = hol[4].replace(/\s+/g, " ").trim();
      if (date && name.length >= 3 && !isJunkSummary(name)) {
        events.push(
          allDayDay(`${name} ${y}`, line, date)
        );
      }
    }
  }

  return {
    title: "School Calendar | Western Cape Government",
    events,
  };
}

/**
 * Parent-facing numbered rows from the English planning PDF (PDF wording).
 * Dates are read from each row’s due-date column — never hardcoded.
 * Month-only cells (e.g. #138 “May and June 2026”, #209 “August 2026”) are
 * dropped; no invented days. Skips CEMIS/sign-off/QMS/LTSM admin mush.
 * Does not invent absent items 102–117.
 */
const WC_PLANNING_PARENT_ROWS: Array<{
  item: number;
  /** Must match the activity title for that numbered row. */
  titleRe: RegExp;
  summary: string;
}> = [
  {
    item: 35,
    titleRe: /School\s+admissions\s+open\s+for\s+Grades\s+R,\s*1\s+and\s+8/i,
    summary: "School admissions open for Grades R, 1 and 8",
  },
  {
    item: 119,
    titleRe: /School\s+admissions\s+close\s+for\s+Grades\s+R,\s*1\s+and\s+8/i,
    summary: "School admissions close for Grades R, 1 and 8",
  },
  {
    item: 124,
    titleRe:
      /Parents\s+informed\s+of\s+the\s+outcome\s+of\s+online\s+admission\s+applications/i,
    summary: "Parents informed of the outcome of online admission applications",
  },
  {
    item: 125,
    titleRe:
      /Parents\s+confirm\s+acceptance\s+of\s+Grades\s+R,\s*1\s+and\s+8\s+placements/i,
    summary: "Parents confirm acceptance of Grades R, 1 and 8 placements",
  },
  {
    item: 194,
    titleRe: /School\s+admissions\s+open\s+for\s+transfer\s+requests/i,
    summary: "School admissions open for transfer requests",
  },
  {
    item: 195,
    titleRe: /School\s+admissions\s+close\s+for\s+transfer\s+requests/i,
    summary: "School admissions close for transfer requests",
  },
  {
    item: 200,
    titleRe: /Parents\s+are\s+informed\s+of\s+the\s+outcome\s+per\s+email\/SMS/i,
    summary: "Parents are informed of the outcome per email/SMS",
  },
  {
    item: 201,
    titleRe:
      /Parents\s+confirm\s+acceptance\s+of\s+transfer\s+placements/i,
    summary: "Parents confirm acceptance of transfer placements",
  },
  {
    item: 36,
    titleRe:
      /Release\s+of\s+the\s+2025\s+National\s+Senior\s+Certificate\s+\(NSC\)\s+examination\s+results/i,
    summary:
      "Release of the 2025 National Senior Certificate (NSC) examination results",
  },
  {
    item: 37,
    titleRe:
      /Submit\s+applications\s+for\s+NSC\s+examination\s+re-marks\s+and\s+rechecks/i,
    summary: "Submit applications for NSC examination re-marks and rechecks",
  },
  {
    item: 42,
    titleRe:
      /Closing\s+date\s+for\s+registrations\s+for\s+May\/June\s+2026\s+NSC\/Senior\s+Certificate\s+\(SC\)\s+examinations/i,
    summary:
      "Closing date for registrations for May/June 2026 NSC/Senior Certificate (SC) examinations",
  },
  {
    item: 52,
    titleRe:
      /Closing\s+date\s+for\s+registrations\s+for\s+November\s+2026\s+NSC\s+examinations\s+[–—−-]\s*full-time\s+candidates/i,
    summary:
      "Closing date for registrations for November 2026 NSC examinations – full-time candidates",
  },
  {
    item: 212,
    titleRe:
      /Grade\s+12\s+September\s+trial\s+examinations\s+earliest\s+start\s+date/i,
    summary: "Grade 12 September trial examinations earliest start date",
  },
  {
    item: 218,
    titleRe: /Grade\s+12\s+September\s+trial\s+examinations\s+end\s+date/i,
    summary: "Grade 12 September trial examinations end date",
  },
  {
    item: 38,
    titleRe:
      /Closing\s+date\s+for\s+parents\s+to\s+appeal\s+the\s+progression\/promotion\s+results\s+of\s+their\s+children/i,
    summary:
      "Closing date for parents to appeal the progression/promotion results of their children",
  },
  {
    item: 39,
    titleRe:
      /Principals\s+communicate\s+outcomes\s+of\s+progression\/promotion\s+appeals\s+to\s+parents\s+in\s+writing/i,
    summary:
      "Principals communicate outcomes of progression/promotion appeals to parents in writing",
  },
  {
    item: 45,
    titleRe:
      /Closing\s+date\s+for\s+parents\s+dissatisfied\s+with\s+the\s+outcome\s+of\s+their\s+progression\/promotion\s+appeals,\s+to\s+appeal\s+to\s+district\s+directors/i,
    summary:
      "Closing date for parents dissatisfied with the outcome of their progression/promotion appeals, to appeal to district directors",
  },
  {
    item: 41,
    titleRe:
      /Submit\s+assessment\s+accommodation\s+appeals\s+for\s+Grade\s+12/i,
    summary: "Submit assessment accommodation appeals for Grade 12",
  },
  {
    item: 47,
    titleRe:
      /All\s+appeals\s+\(for\s+progression\s+and\s+promotion\s+results\s+for\s+Grades\s+1[–—−-]11\s+of\s+2025\)\s+finalised/i,
    summary:
      "All appeals (for progression and promotion results for Grades 1–11 of 2025) finalised",
  },
  {
    item: 58,
    titleRe:
      /Grade\s+11\s+subject\s+change\s+applications\s+by\s+parents/i,
    summary: "Grade 11 subject change applications by parents",
  },
  {
    item: 64,
    titleRe:
      /Election\s+of\s+Representative\s+Councils\s+of\s+Learners\s+\(RCLs\)/i,
    summary: "Election of Representative Councils of Learners (RCLs)",
  },
  {
    item: 65,
    titleRe: /Induction\s+of\s+new\s+RCLs/i,
    summary: "Induction of new RCLs",
  },
  {
    item: 66,
    titleRe:
      /Election\s+of\s+RCL\s+office-bearers\s+and\s+governing\s+body\s+learner\s+representatives/i,
    summary:
      "Election of RCL office-bearers and governing body learner representatives",
  },
  {
    item: 67,
    titleRe:
      /Election\s+of\s+District\s+and\s+Provincial\s+Council\s+of\s+Learners\s+Forums/i,
    summary: "Election of District and Provincial Council of Learners Forums",
  },
  {
    item: 68,
    titleRe:
      /South\s+African\s+Schools\s+Choral\s+Eisteddfod\s+\(SASCE\)\s*[–—−-]\s*registration/i,
    summary:
      "South African Schools Choral Eisteddfod (SASCE) – registration",
  },
  {
    item: 69,
    titleRe: /Safe\s+Schools\s+Holiday\s+Programme/i,
    summary: "Safe Schools Holiday Programme",
  },
  {
    // Later same-title holiday programmes — each numbered row keeps its own due dates
    item: 157,
    titleRe: /Safe\s+Schools\s+Holiday\s+Programme/i,
    summary: "Safe Schools Holiday Programme",
  },
  {
    item: 227,
    titleRe: /Safe\s+Schools\s+Holiday\s+Programme/i,
    summary: "Safe Schools Holiday Programme",
  },
  {
    item: 289,
    titleRe: /Safe\s+Schools\s+Holiday\s+Programme/i,
    summary: "Safe Schools Holiday Programme",
  },
  {
    item: 63,
    titleRe: /Safe\s+Schools[''\u2019]\s+Back\s+to\s+School\s+Drive/i,
    summary: "Safe Schools' Back to School Drive",
  },
  {
    item: 123,
    titleRe:
      /System\s+displays\s+the\s+outcome\s+of\s+Grades\s+R,\s*1\s+and\s+8\s+online\s+admission\s+applications/i,
    summary:
      "System displays the outcome of Grades R, 1 and 8 online admission applications",
  },
  {
    item: 145,
    titleRe:
      /Closing\s+date\s+for\s+applications\s+for\s+the\s+provincial\s+skills\s+competition/i,
    summary: "Closing date for applications for the provincial skills competition",
  },
  {
    item: 147,
    titleRe:
      /Grade\s+10\s+subject\s+change\s+applications\s+by\s+parents/i,
    summary: "Grade 10 subject change applications by parents",
  },
  {
    item: 149,
    titleRe: /Schools\s+Democracy\s+Month/i,
    summary: "Schools Democracy Month",
  },
  {
    item: 150,
    titleRe:
      /National\s+Schools\s+MOOT\s+Court\s+\(Grades\s+9[–—−-]10\)\s*[–—−-]\s*registration/i,
    summary: "National Schools MOOT Court (Grades 9–10) – registration",
  },
  {
    item: 151,
    titleRe:
      /MOOT\s+Court\s*[–—−-]\s*workshop\s+on\s+essay\s+writing\s+\(virtual\)/i,
    summary: "MOOT Court – workshop on essay writing (virtual)",
  },
  {
    item: 152,
    titleRe:
      /Youth\s+Citizen\s+Action\s+Programme\s+\(YCAP\)\s*[–—−-]\s*registration/i,
    summary: "Youth Citizen Action Programme (YCAP) – registration",
  },
  {
    item: 153,
    titleRe: /School\s+Safety\s+Summit/i,
    summary: "School Safety Summit",
  },
  {
    item: 154,
    titleRe: /YCAP\s*[–—−-]\s*provincial\s+workshop\s+\(virtual\)/i,
    summary: "YCAP – provincial workshop (virtual)",
  },
  {
    item: 155,
    titleRe: /RCL\s*[–—−-]\s*conference/i,
    summary: "RCL – conference",
  },
  {
    item: 156,
    titleRe: /SASCE\s*[–—−-]\s*provincial\s+round/i,
    summary: "SASCE – provincial round",
  },
  {
    item: 158,
    titleRe: /SASCE\s*[–—−-]\s*national\s+championship/i,
    summary: "SASCE – national championship",
  },
  {
    item: 199,
    titleRe:
      /System\s+displays\s+the\s+outcome\s+of\s+transfer\s+requests/i,
    summary: "System displays the outcome of transfer requests",
  },
  {
    item: 220,
    titleRe:
      /INkosi\s+Albert\s+Luthuli\s*[–—−-]\s*provincial\s+competition/i,
    summary: "INkosi Albert Luthuli – provincial competition",
  },
  {
    item: 221,
    titleRe: /YCAP\s*[–—−-]\s*provincial\s+workshop\s+\(virtual\)/i,
    summary: "YCAP – provincial workshop (virtual)",
  },
  {
    item: 222,
    titleRe:
      /Heritage\s+Education\s+Schools\s+Outreach\s+Programme\s*[–—−-]\s*provincial\s+competition/i,
    summary:
      "Heritage Education Schools Outreach Programme – provincial competition",
  },
  {
    item: 223,
    titleRe: /School\s+Safety\s+Round\s+Table\s*[–—−-]\s*rural/i,
    summary: "School Safety Round Table – rural",
  },
  {
    item: 224,
    titleRe: /School\s+Safety\s+Round\s+Table\s*[–—−-]\s*urban/i,
    summary: "School Safety Round Table – urban",
  },
  {
    item: 225,
    titleRe:
      /National\s+Schools\s+MOOT\s+Court\s+Competition\s*[–—−-]\s*provincial\s+oral\s+round/i,
    summary:
      "National Schools MOOT Court Competition – provincial oral round",
  },
  {
    item: 226,
    titleRe: /YCAP\s*[–—−-]\s*provincial\s+competition/i,
    summary: "YCAP – provincial competition",
  },
  {
    item: 238,
    titleRe:
      /Administration\s+of\s+WCED\s+Systemic\s+Tests\s+for\s+Grades\s+3,\s*6\s+and\s+9/i,
    summary: "Administration of WCED Systemic Tests for Grades 3, 6 and 9",
  },
  {
    item: 267,
    titleRe:
      /Applications\s+for\s+assessment\s+accommodations\s+for\s+Grades\s+R[–—−-]11\s+close/i,
    summary: "Applications for assessment accommodations for Grades R–11 close",
  },
  {
    item: 271,
    titleRe:
      /Submit\s+assessment\s+accommodations\s+appeals\s+for\s+Grades\s+10[–—−-]11/i,
    summary: "Submit assessment accommodations appeals for Grades 10–11",
  },
  {
    item: 280,
    titleRe:
      /Subject\s+change\s+applications\s+by\s+parents\s+of\s+Grade\s+11\s+learners/i,
    summary:
      "Subject change applications by parents of Grade 11 learners – for Grade 12 year",
  },
  {
    item: 286,
    titleRe: /Appeals\s+for\s+Grades\s+10[–—−-]11/i,
    summary: "Appeals for Grades 10–11",
  },
];

/**
 * Slice text for numbered activity `N.` through the next activity / section.
 * Stops at the next item marker even when pdftotext glues it on the same line
 * (so #43’s date cannot land inside #42’s block).
 */
function numberedActivityBlock(text: string, item: number): string | null {
  const startRe = new RegExp(String.raw`(^|\n)\s*${item}\.\s+`, "m");
  const sm = startRe.exec(text);
  if (!sm) return null;
  const start = sm.index + sm[0].length;
  const rest = text.slice(start);

  /** Index of the digit that starts the next `N.` marker, or null. */
  function nextMarkerIndex(re: RegExp): number | null {
    const m = re.exec(rest);
    if (!m) return null;
    const dig = rest.slice(m.index).match(/\d+\./);
    if (!dig || dig.index == null) return null;
    return m.index + dig.index;
  }

  // Prefer immediate next item (42 → 43), including glued same-line markers.
  const nextExact = nextMarkerIndex(
    new RegExp(String.raw`(^|\n|\s)${item + 1}\.\s+(?=[A-Za-z(])`, "m")
  );
  // Any other activity "N. Title" (not this item, not section "3.1.2")
  let nextAny: number | null = null;
  const anyM = /(?:^|\n|\s)(\d+)\.\s+(?=[A-Za-z(])/m.exec(rest);
  if (anyM && Number(anyM[1]) !== item) {
    nextAny = nextMarkerIndex(
      new RegExp(
        String.raw`(^|\n|\s)${anyM[1]}\.\s+(?=[A-Za-z(])`,
        "m"
      )
    );
  }
  const nextSec = /(?:^|\n)\s*\d+\.\d+/.exec(rest);

  let end = rest.length;
  if (nextExact != null) end = Math.min(end, nextExact);
  else if (nextAny != null) end = Math.min(end, nextAny);
  if (nextSec) end = Math.min(end, nextSec.index);
  return rest.slice(0, end);
}

/**
 * Parse due-date column bounds from an activity block.
 * Prefers the first due-date cell after the title (not the last date in a
 * leaked blob — e.g. #43’s 29 Jan must not override #42’s 27 Jan).
 * Returns null for empty cells, TBC, month-only ("May and June 2026"), etc.
 */
function parsePlanningDueDate(
  block: string
): { start: Date; end: Date } | null {
  const flat = block.replace(/\s+/g, " ").trim();
  if (!flat) return null;
  if (
    /to\s+be\s+confirmed|^\s*ongoing\b/i.test(flat) &&
    !/\d{1,2}\s+\w+\s+20\d{2}/i.test(flat)
  ) {
    return null;
  }

  // Find the earliest due-date expression in the cell (title comes first in PDF).
  type Hit = { index: number; start: Date; end: Date };
  const hits: Hit[] = [];

  const crossRe = new RegExp(
    String.raw`(\d{1,2})\s+(${MONTH_ALT})\s*(?:to|[–—−-])\s*(\d{1,2})\s+(${MONTH_ALT})\s+(20\d{2})\b`,
    "gi"
  );
  let m: RegExpExecArray | null;
  while ((m = crossRe.exec(flat)) !== null) {
    const m1 = MONTHS[m[2].toLowerCase()];
    const m2 = MONTHS[m[4].toLowerCase()];
    const y = Number(m[5]);
    if (m1 == null || m2 == null) continue;
    const start = parseDateParts(Number(m[1]), m1, y);
    const end = parseDateParts(Number(m[3]), m2, y);
    if (start && end) hits.push({ index: m.index, start, end });
  }

  const sameRe = new RegExp(
    String.raw`(\d{1,2})\s+to\s+(\d{1,2})\s+(${MONTH_ALT})\s+(20\d{2})\b`,
    "gi"
  );
  while ((m = sameRe.exec(flat)) !== null) {
    const month = MONTHS[m[3].toLowerCase()];
    const y = Number(m[4]);
    if (month == null) continue;
    const start = parseDateParts(Number(m[1]), month, y);
    const end = parseDateParts(Number(m[2]), month, y);
    if (start && end) hits.push({ index: m.index, start, end });
  }

  const dayRe = new RegExp(
    String.raw`(\d{1,2})\s+(${MONTH_ALT})\s+(20\d{2})\b`,
    "gi"
  );
  while ((m = dayRe.exec(flat)) !== null) {
    const month = MONTHS[m[2].toLowerCase()];
    if (month == null) continue;
    const day = parseDateParts(Number(m[1]), month, Number(m[3]));
    if (day) hits.push({ index: m.index, start: day, end: day });
  }

  if (!hits.length) return null;
  hits.sort((a, b) => a.index - b.index);
  // Prefer the earliest due-date cell (title/date column), not a later leaked date.
  return { start: hits[0].start, end: hits[0].end };
}

/**
 * Parent-usable day-dated rows from WCED Grade 12 / NSC / exam nav HTML
 * (source wording). Only patterns with an explicit day; skips the
 * August-2027 typo on Nov manual registration; does not invent month bounds.
 */
export function parseWesternCapeExamPage(text: string): ParsedEvent[] {
  const cleaned = text.replace(/\u00a0/g, " ");
  const flat = cleaned.replace(/\s+/g, " ").trim();
  const events: ParsedEvent[] = [];
  const seen = new Set<string>();

  function push(summary: string, start: Date, end?: Date) {
    const s = summary.replace(/\s+/g, " ").trim().slice(0, 160);
    if (!s) return;
    const first = new Date(start.getFullYear(), start.getMonth(), start.getDate());
    const last = end
      ? new Date(end.getFullYear(), end.getMonth(), end.getDate())
      : first;
    const key = `${s}|${first.toISOString()}|${last.toISOString()}`;
    if (seen.has(key)) return;
    seen.add(key);
    events.push(allDaySpan(s, s, first, last));
  }

  function day(d: number, monthName: string, y: number): Date | null {
    const month = MONTHS[monthName.toLowerCase()];
    if (month == null) return null;
    return parseDateParts(d, month, y);
  }

  // NSC May/June exam: commence + conclude (not planning #138 month-only)
  const nscSpan = flat.match(
    new RegExp(
      String.raw`NSC\s+May\/June\s+2026\s+exam\s+commences\s+on:\s*(\d{1,2})\s+(${MONTH_ALT})\s+(20\d{2})[\s\S]{0,240}?exam\s+concludes\s+on\s+(\d{1,2})\s+(${MONTH_ALT})\s+(20\d{2})`,
      "i"
    )
  );
  if (nscSpan) {
    const a = day(Number(nscSpan[1]), nscSpan[2], Number(nscSpan[3]));
    const b = day(Number(nscSpan[4]), nscSpan[5], Number(nscSpan[6]));
    if (a && b) push("NSC May/June 2026 exam", a, b);
  }

  // SC FAQ corroboration (same span; deduped if NSC already emitted)
  const scSpan = flat.match(
    new RegExp(
      String.raw`Date\s+of\s+June\s+2026\s+SC\s+Exam:\s*(\d{1,2})\s+(${MONTH_ALT})\s*[–—−-]\s*(\d{1,2})\s+(${MONTH_ALT})\s+(20\d{2})`,
      "i"
    )
  );
  if (scSpan) {
    const a = day(Number(scSpan[1]), scSpan[2], Number(scSpan[5]));
    const b = day(Number(scSpan[3]), scSpan[4], Number(scSpan[5]));
    if (a && b) push("June 2026 SC Exam", a, b);
  }

  // Results day from exam pages (planning #209 is month-only / empty)
  const results = flat.match(
    new RegExp(
      String.raw`Release\s+of\s+the\s+May\/June\s+2026\s+NSC\/SC\s+examination\s+results:\s*(\d{1,2})\s+(${MONTH_ALT})\s+(20\d{2})`,
      "i"
    )
  );
  if (results) {
    const d = day(Number(results[1]), results[2], Number(results[3]));
    if (d) {
      push(
        "Release of the May/June 2026 NSC/SC examination results",
        d
      );
    }
  }

  // Nov 2026 script remark window stated on Nov NSC page
  const remark = flat.match(
    new RegExp(
      String.raw`Remarking\|rechecking\s+applications:\s*(\d{1,2})\s*[–—−-]\s*(\d{1,2})\s+(${MONTH_ALT})\s+(20\d{2})`,
      "i"
    )
  );
  if (remark) {
    const a = day(Number(remark[1]), remark[3], Number(remark[4]));
    const b = day(Number(remark[2]), remark[3], Number(remark[4]));
    if (a && b) push("Remarking|rechecking applications", a, b);
  }

  // June 2027 NSC|SC registration windows (day bounds from source; skip Aug-2027 typo)
  const juneRegBlock = new RegExp(
    String.raw`Registration:\s*June\s+2027\s+NSC\|SC\s+examination\s+(Online\s+Registration:[\s\S]{0,220}?Manual\s+Registration:\s*\d{1,2}\s+\w+\s+20\d{2}\s*[–—−-]\s*\d{1,2}\s+\w+\s+20\d{2})`,
    "gi"
  );
  let blockM: RegExpExecArray | null;
  while ((blockM = juneRegBlock.exec(flat)) !== null) {
    const block = blockM[1];
    const online = block.match(
      new RegExp(
        String.raw`Online\s+Registration:\s*(\d{1,2})\s+(${MONTH_ALT})\s+(20\d{2})\s*[–—−-]\s*(\d{1,2})\s+(${MONTH_ALT})\s+(20\d{2})`,
        "i"
      )
    );
    if (online) {
      const a = day(Number(online[1]), online[2], Number(online[3]));
      const b = day(Number(online[4]), online[5], Number(online[6]));
      if (a && b) {
        push("Online Registration for June 2027 NSC|SC examination", a, b);
      }
    }
    const manual = block.match(
      new RegExp(
        String.raw`Manual\s+Registration:\s*(\d{1,2})\s+(${MONTH_ALT})\s+(20\d{2})\s*[–—−-]\s*(\d{1,2})\s+(${MONTH_ALT})\s+(20\d{2})`,
        "i"
      )
    );
    if (manual) {
      const a = day(Number(manual[1]), manual[2], Number(manual[3]));
      const b = day(Number(manual[4]), manual[5], Number(manual[6]));
      // Drop the Nov-2026 form window mistyped as August 2027 on the June page
      if (a && b && !(a.getMonth() === 7 && a.getFullYear() === 2027)) {
        push("Manual Registration for June 2027 NSC|SC examination", a, b);
      }
    }
  }

  // Matric 2025 awards only (confirmed on awards page; planning #43 is TBC)
  for (const kind of ["Schools", "Candidates"] as const) {
    const re = new RegExp(
      String.raw`Matric\s+2025\s+Awards\s+to\s+${kind}\s*\|\s*(\d{1,2})\s+(${MONTH_ALT})\s+(20\d{2})`,
      "i"
    );
    const m = flat.match(re);
    if (!m) continue;
    const d = day(Number(m[1]), m[2], Number(m[3]));
    if (d) push(`Matric 2025 Awards to ${kind}`, d);
  }

  // Second Chance Matric Programme page (linked from /exams): tutoring registration
  // window 09h00–14h00 on the stated Saturday (Africa/Johannesburg), not all-day.
  const scmp = flat.match(
    new RegExp(
      String.raw`Registration\s+to\s+attend\s+the\s+second\s+chance\s+tutoring\s+classes\s+will\s+take\s+place\s+from\s+(\d{1,2})h(\d{2})\s+to\s+(\d{1,2})h(\d{2})\s+on\s+Saturday,\s+(\d{1,2})\s+(${MONTH_ALT})\s+(20\d{2})`,
      "i"
    )
  );
  if (scmp) {
    const month = MONTHS[scmp[6].toLowerCase()];
    const y = Number(scmp[7]);
    const d = Number(scmp[5]);
    if (month != null && d >= 1 && d <= 31) {
      const summary =
        "Registration to attend the second chance tutoring classes";
      const ev = timedSpanInZone(
        summary,
        summary,
        y,
        month,
        d,
        Number(scmp[1]),
        Number(scmp[2]),
        Number(scmp[3]),
        Number(scmp[4]),
        "Africa/Johannesburg"
      );
      const key = `${ev.summary}|${ev.start}|${ev.end}`;
      if (!seen.has(key)) {
        seen.add(key);
        events.push(ev);
      }
    }
  }

  return events;
}

/**
 * Merge exam-nav page parses into one VEVENT per parent fact
 * (summary + DTSTART + DTEND). Same results/registration wording on
 * /exams + nsc-june + sc-mayjune must not triple the calendar.
 * Distinct titles stay distinct (NSC exam vs SC Exam; awards Schools vs Candidates).
 */
export function mergeWesternCapeExamEvents(
  batches: ParsedEvent[][]
): ParsedEvent[] {
  const seen = new Set<string>();
  const out: ParsedEvent[] = [];
  for (const batch of batches) {
    for (const e of batch) {
      const key = `${e.summary}|${e.start}|${e.end}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(e);
    }
  }
  return out;
}

/** Parse several exam-nav extracts and emit each parent fact once. */
export function parseWesternCapeExamPages(texts: string[]): ParsedEvent[] {
  return mergeWesternCapeExamEvents(texts.map(parseWesternCapeExamPage));
}

/**
 * Oct/Nov 2026 NSC final timetable PDF: one parent span from first→last
 * sitting ISO day (not per-subject dump; not the signature DATE line).
 */
export function parseWesternCapeNovNscTimetablePdf(
  text: string
): ParsedEvent[] {
  const cleaned = text.replace(/\u00a0/g, " ");
  if (
    !/FINAL\s+EXAMINATION\s+TIMETABLE/i.test(cleaned) ||
    !/NATIONAL\s+SENIOR\s+CERTIFICATE\s+\(NSC\)\s+EXAMINATION/i.test(cleaned) ||
    !/EXAMINATION\s+DATE:\s*OCTOBER\/NOVEMBER\s+2026/i.test(cleaned)
  ) {
    return [];
  }
  const days: Date[] = [];
  const re = /\b(2026)-(10|11)-(\d{2})\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(cleaned)) !== null) {
    const y = Number(m[1]);
    const month = Number(m[2]) - 1;
    const d = Number(m[3]);
    const date = parseDateParts(d, month, y);
    if (date) days.push(date);
  }
  if (!days.length) return [];
  days.sort((a, b) => a.getTime() - b.getTime());
  const first = days[0];
  const last = days[days.length - 1];
  return [
    allDaySpan(
      "NSC October/November 2026 exam",
      "NSC October/November 2026 exam",
      first,
      last
    ),
  ];
}

/**
 * November 2026 NSC registration form PDF: closing day only (form wording).
 * Does not invent a 7 August open from the filename or the June HTML typo.
 */
export function parseWesternCapeNovNscRegFormPdf(text: string): ParsedEvent[] {
  const cleaned = text.replace(/\u00a0/g, " ");
  const flat = cleaned.replace(/\s+/g, " ").trim();
  if (
    !/NATIONAL\s+SENIOR\s+CERTIFICATE\s+\(NSC\)\s+NOVEMBER\s+REGISTRATION\s+FORM/i.test(
      flat
    )
  ) {
    return [];
  }
  const close = flat.match(
    new RegExp(
      String.raw`CLOSING\s+DATE:\s*(\d{1,2})\s+(${MONTH_ALT})\s+(20\d{2})`,
      "i"
    )
  );
  if (!close) return [];
  const month = MONTHS[close[2].toLowerCase()];
  if (month == null) return [];
  const d = parseDateParts(Number(close[1]), month, Number(close[3]));
  if (!d) return [];
  // Refuse the known June-page typo year if it ever appears on a form extract
  if (d.getFullYear() === 2027 && d.getMonth() === 7) return [];
  return [
    allDayDay(
      "Closing date for November 2026 NSC examination registration",
      "Closing date for November 2026 NSC examination registration",
      d
    ),
  ];
}

/**
 * English WCED planning PDF: religious observances + curated parent-facing
 * admission/NSC rows (PDF wording). Untitled CEMIS/sign-off/QMS/LTSM admin mush
 * is dropped. Grade 12 / NSC exam nav URLs are parsed separately.
 */
export function parseWesternCapePlanningPdf(text: string): ParsedEvent[] {
  const cleaned = text.replace(/\u00a0/g, " ");
  const events: ParsedEvent[] = [];
  const seen = new Set<string>();

  function push(summary: string, day: Date, endDay?: Date) {
    const s = summary.replace(/\s+/g, " ").trim().slice(0, 160);
    if (!s || isJunkSummary(s) || WEEKDAY_ONLY.test(s)) return;
    if (/\b(sunset)\b/i.test(s) && !/^sukkot\b/i.test(s)) {
      // keep "Sukkot" without glued "(sunset)" noise when we can
    }
    const start = new Date(day.getFullYear(), day.getMonth(), day.getDate());
    const last = endDay
      ? new Date(endDay.getFullYear(), endDay.getMonth(), endDay.getDate())
      : start;
    const key = `${s}|${start.toISOString()}|${last.toISOString()}`;
    if (seen.has(key)) return;
    seen.add(key);
    events.push(allDaySpan(s, s, start, last));
  }

  function isObservanceLabel(label: string): boolean {
    return /(eid|passover|ascension|shavuot|rosh\s*hashana|yom\s*kippur|sukkot|shemini|simchat|diwali)/i.test(
      label
    );
  }

  // Same-line observances (weekday may be glued: "Ascension DayThursday14 May 2026")
  const namedDay = new RegExp(
    String.raw`((?:Eid ul Fitr|Eid ul Adha|Passover|Ascension Day|Shavuot|Rosh Hashana|Yom Kippur|Sukkot|Shemini Atzeret and Simchat Torah|Diwali)(?:\s*\(date may vary\))?)\s*(?:${WEEKDAY_ALT})?\s*(?:\(?sunset\)?)?\s*(\d{1,2})\s+(${MONTH_ALT})\s+(20\d{2})\b`,
    "gi"
  );
  let m: RegExpExecArray | null;
  while ((m = namedDay.exec(cleaned)) !== null) {
    const label = m[1].replace(/\s+/g, " ").trim();
    const month = MONTHS[m[3].toLowerCase()];
    if (month == null) continue;
    const date = parseDateParts(Number(m[2]), month, Number(m[4]));
    if (!date) continue;
    push(label, date);
  }

  // Multi-line religious blocks: label then date lines
  const lines = cleaned.split(/\r?\n/).map((l) => l.replace(/\s+/g, " ").trim());
  for (let i = 0; i < lines.length; i++) {
    let name = lines[i];
    if (/^Shemini Atzeret and Simchat$/i.test(name) && /torah/i.test(lines[i + 1] || "")) {
      name = "Shemini Atzeret and Simchat Torah";
    }
    if (!isObservanceLabel(name)) continue;
    if (/^(Eid ul Fitr|Eid ul Adha|Ascension Day|Yom Kippur|Sukkot|Diwali)\b/i.test(name)) {
      // Usually handled by same-line pattern; still allow multi-line dates below
    }
    const dates: Date[] = [];
    for (let j = i + 1; j < Math.min(i + 8, lines.length); j++) {
      const dm = lines[j].match(
        new RegExp(String.raw`^(\d{1,2})\s+(${MONTH_ALT})\s+(20\d{2})$`, "i")
      );
      if (dm) {
        const month = MONTHS[dm[2].toLowerCase()];
        if (month == null) continue;
        const d = parseDateParts(Number(dm[1]), month, Number(dm[3]));
        if (d) dates.push(d);
        continue;
      }
      if (WEEKDAY_ONLY.test(lines[j])) continue;
      if (/^\(?sunset\)?$/i.test(lines[j])) continue;
      if (/^Torah$/i.test(lines[j])) continue;
      if (dates.length) break;
      if (/^[A-Za-z]/.test(lines[j]) && !WEEKDAY_ONLY.test(lines[j])) break;
    }
    for (const d of dates) push(name, d);
  }

  // Curated parent-facing rows: title match + due-date parsed from that numbered row
  for (const row of WC_PLANNING_PARENT_ROWS) {
    const block = numberedActivityBlock(cleaned, row.item);
    if (!block) continue;
    if (!row.titleRe.test(block.replace(/\s+/g, " "))) continue;
    const bounds = parsePlanningDueDate(block);
    if (!bounds) continue; // empty / TBC / month-only — drop, do not invent days
    push(row.summary, bounds.start, bounds.end);
  }

  return events;
}

/**
 * Independent-school term pages with year-stamped START:/CLOSE: under Term N
 * (e.g. Ridgewood College). Emit Term N YYYY spans, then that term’s half-term
 * CLOSE→RETURN and named Public Holiday lines using the term year (dates only
 * from the same row/block — never invent bounds or steal the next row’s day).
 */
export function looksLikeTermStartCloseCalendar(text: string): boolean {
  return (
    /\bTerm\s+[1234]\s*\(/i.test(text) &&
    /\bSTART:\s*[^\n]*\b20\d{2}\b/i.test(text) &&
    /\bCLOSE:\s*[^\n]*\b20\d{2}\b/i.test(text)
  );
}

function ymdOnLine(line: string): Date | null {
  const m = line.match(
    new RegExp(
      String.raw`(\d{1,2})(?:st|nd|rd|th)?\s+(${MONTH_ALT})\s+(20\d{2})\b`,
      "i"
    )
  );
  if (!m) return null;
  const month = MONTHS[m[2].toLowerCase()];
  if (month == null) return null;
  return parseDateParts(Number(m[1]), month, Number(m[3]));
}

/** Day+month on a line; optional (12h00) clock — year inherited from the term. */
function mdOnLine(
  line: string,
  year: number
): { date: Date; hour: number | null; minute: number } | null {
  const m = line.match(
    new RegExp(
      String.raw`(\d{1,2})(?:st|nd|rd|th)?\s+(${MONTH_ALT})\b(?:\s*\((\d{1,2})h(\d{2})\))?`,
      "i"
    )
  );
  if (!m) return null;
  const month = MONTHS[m[2].toLowerCase()];
  if (month == null) return null;
  const date = parseDateParts(Number(m[1]), month, year);
  if (!date) return null;
  let hour: number | null = null;
  let minute = 0;
  if (m[3] != null && m[4] != null) {
    hour = Number(m[3]);
    minute = Number(m[4]);
    if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
      hour = null;
      minute = 0;
    }
  }
  return { date, hour, minute };
}

function normalizeDashEntities(s: string): string {
  return s.replace(/&#8211;/gi, "–").replace(/&#8212;/gi, "—");
}

/** Half-term break: CLOSE day → day before RETURN (RETURN = school resumes). */
function halfTermBreakEvent(
  summary: string,
  description: string,
  close: { date: Date; hour: number | null; minute: number },
  returnDate: Date
): ParsedEvent | null {
  if (returnDate.getTime() <= close.date.getTime()) return null;
  if (close.hour != null) {
    const y = close.date.getFullYear();
    const mo = close.date.getMonth();
    const d = close.date.getDate();
    const start = timedSpanInZone(
      summary,
      description,
      y,
      mo,
      d,
      close.hour,
      close.minute,
      close.hour,
      close.minute,
      "Africa/Johannesburg"
    );
    // Exclusive end = midnight at start of RETURN (Africa/Johannesburg = UTC+2).
    const end = new Date(
      Date.UTC(
        returnDate.getFullYear(),
        returnDate.getMonth(),
        returnDate.getDate(),
        -2,
        0,
        0
      )
    );
    if (end.getTime() <= new Date(start.start).getTime()) return null;
    return { ...start, end: end.toISOString() };
  }
  const last = new Date(
    returnDate.getFullYear(),
    returnDate.getMonth(),
    returnDate.getDate() - 1
  );
  if (last.getTime() < close.date.getTime()) return null;
  return allDaySpan(summary, description, close.date, last);
}

/** Named holiday / range lines under Public Holidays (same term year). */
function parseTermPublicHolidayLine(
  line: string,
  year: number
): ParsedEvent | null {
  const raw = normalizeDashEntities(line);

  // "Easter Weekend (29 March – 1 April)"
  const namedRange = raw.match(
    new RegExp(
      String.raw`^(.+?)\s*\(\s*(\d{1,2})(?:st|nd|rd|th)?\s+(${MONTH_ALT})\s*[–—−-]\s*(\d{1,2})(?:st|nd|rd|th)?\s+(${MONTH_ALT})\s*\)\s*$`,
      "i"
    )
  );
  if (namedRange) {
    const name = namedRange[1].replace(/\s+/g, " ").trim();
    const m1 = MONTHS[namedRange[3].toLowerCase()];
    const m2 = MONTHS[namedRange[5].toLowerCase()];
    if (name.length >= 3 && m1 != null && m2 != null) {
      const a = parseDateParts(Number(namedRange[2]), m1, year);
      const b = parseDateParts(Number(namedRange[4]), m2, year);
      if (a && b && b.getTime() >= a.getTime()) {
        return allDaySpan(name, raw, a, b);
      }
    }
  }

  // "Friday, 3 April – Monday, 6 April (Easter)"
  const rangeNamed = raw.match(
    new RegExp(
      String.raw`^(?:${WEEKDAY_ALT})?,?\s*(\d{1,2})(?:st|nd|rd|th)?\s+(${MONTH_ALT})\s*[–—−-]\s*(?:${WEEKDAY_ALT})?,?\s*(\d{1,2})(?:st|nd|rd|th)?\s+(${MONTH_ALT})\s*\(([^)]+)\)\s*$`,
      "i"
    )
  );
  if (rangeNamed) {
    const m1 = MONTHS[rangeNamed[2].toLowerCase()];
    const m2 = MONTHS[rangeNamed[4].toLowerCase()];
    const name = rangeNamed[5].replace(/\s+/g, " ").trim();
    if (name.length >= 3 && m1 != null && m2 != null) {
      const a = parseDateParts(Number(rangeNamed[1]), m1, year);
      const b = parseDateParts(Number(rangeNamed[3]), m2, year);
      if (a && b && b.getTime() >= a.getTime()) {
        return allDaySpan(name, raw, a, b);
      }
    }
  }

  // "Friday 22 March (School Holiday)" / "Saturday, 21 March (Human Rights Day)"
  const dayNamed = raw.match(
    new RegExp(
      String.raw`^(?:${WEEKDAY_ALT})?,?\s*(\d{1,2})(?:st|nd|rd|th)?\s+(${MONTH_ALT})\s*\(([^)]+)\)\s*$`,
      "i"
    )
  );
  if (dayNamed) {
    const month = MONTHS[dayNamed[2].toLowerCase()];
    const name = dayNamed[3].replace(/\s+/g, " ").trim();
    // Reject clock crumbs mistaken as labels
    if (/^\d{1,2}h\d{2}$/i.test(name)) return null;
    if (month == null || name.length < 3) return null;
    const d = parseDateParts(Number(dayNamed[1]), month, year);
    if (!d) return null;
    return allDayDay(name, raw, d);
  }

  return null;
}

export function parseTermStartCloseCalendar(
  text: string
): { title: string; events: ParsedEvent[] } {
  const lines = text
    .split(/\r?\n/)
    .map((l) => normalizeDashEntities(l.replace(/\s+/g, " ").trim()))
    .filter(Boolean);
  const events: ParsedEvent[] = [];
  let termN: number | null = null;
  let termYear: number | null = null;
  let start: Date | null = null;
  let inHalfTerm = false;
  let halfClose: {
    date: Date;
    hour: number | null;
    minute: number;
    line: string;
  } | null = null;
  let inHolidays = false;

  for (const line of lines) {
    const tm = line.match(/^Term\s+([1234])\b/i);
    if (tm) {
      termN = Number(tm[1]);
      start = null;
      termYear = null;
      inHalfTerm = false;
      halfClose = null;
      inHolidays = false;
      continue;
    }
    if (termN == null) continue;

    if (/^START:/i.test(line)) {
      const d = ymdOnLine(line);
      if (d) {
        start = d;
        termYear = d.getFullYear();
      }
      continue;
    }

    if (/^Half\s+Term\b/i.test(line)) {
      inHalfTerm = true;
      halfClose = null;
      inHolidays = false;
      continue;
    }

    if (/^Public\s+Holidays\b/i.test(line)) {
      inHalfTerm = false;
      halfClose = null;
      inHolidays = true;
      continue;
    }

    if (inHalfTerm && termYear != null && /^CLOSE:/i.test(line)) {
      // Half-term CLOSE is yearless on the page — inherit term year only.
      if (ymdOnLine(line)) continue;
      const md = mdOnLine(line, termYear);
      if (md) halfClose = { ...md, line };
      continue;
    }

    if (inHalfTerm && termYear != null && /^RETURN:/i.test(line) && halfClose) {
      const md = mdOnLine(line, termYear);
      if (md) {
        const ev = halfTermBreakEvent(
          "Half Term (Mid-Term Break)",
          `${halfClose.line}; ${line}`,
          halfClose,
          md.date
        );
        if (ev) events.push(ev);
      }
      halfClose = null;
      inHalfTerm = false;
      continue;
    }

    if (/^CLOSE:/i.test(line) && start) {
      const d = ymdOnLine(line);
      // Yearless half-term CLOSE outside Half Term block — ignore; wait for term CLOSE.
      if (!d) continue;
      const y = start.getFullYear();
      termYear = y;
      events.push(allDaySpan(`Term ${termN} ${y}`, `${line}`, start, d));
      start = null;
      // Keep termN + termYear for following half-term / holiday lines.
      continue;
    }

    if (inHolidays && termYear != null) {
      const hol = parseTermPublicHolidayLine(line, termYear);
      if (hol) events.push(hol);
    }
  }

  const titleLine =
    lines.find((l) => /term dates/i.test(l)) || "Term dates";
  return {
    title: titleLine.replace(/&#8211;/g, "–").slice(0, 120),
    events,
  };
}

/** Live Brescia-hosted ISASA/SAHISA Central Region 2026 guideline PDF. */
export const ISASA_CENTRAL_REGION_2026_PDF_URL =
  "https://www.brescia.co.za/uploads/files/Calendars/ISASA.and.SAHISA.Central.Region.Calendar.2026.pdf";

export function isIsasaCentralRegionCalendarUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return (
      /(^|\.)brescia\.co\.za$/i.test(u.hostname) &&
      /ISASA\.and\.SAHISA\.Central\.Region\.Calendar\.2026\.pdf$/i.test(
        u.pathname
      )
    );
  } catch {
    return false;
  }
}

/**
 * ISASA / SAHISA Central Region guideline PDF (4-term + 3-term columns).
 * Do not treat the isasa.org download HTML page as this calendar.
 */
export function looksLikeIsasaCentralRegionCalendar(text: string): boolean {
  return (
    /ISASA\s*\/\s*SAHISA\s+Central\s+Region/i.test(text) &&
    /only a guideline/i.test(text) &&
    /4\s+TERM\s+CALENDAR/i.test(text) &&
    /3\s+TERM\s+CALENDAR/i.test(text)
  );
}

/** Join PDF line-breaks for known Central Region headers / half-term clock. */
function normalizeCentralRegionLines(text: string): string[] {
  const raw = normalizeDashEntities(text.replace(/\u00a0/g, " "))
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  const out: string[] = [];
  for (let i = 0; i < raw.length; i++) {
    let line = raw[i];
    // "Public" / "and" / "School" / "Holidays" or "Public" / "Holidays"
    if (/^Public$/i.test(line)) {
      const parts = [line];
      let j = i + 1;
      while (
        j < raw.length &&
        /^(and|School|Holidays)$/i.test(raw[j]) &&
        parts.length < 4
      ) {
        parts.push(raw[j]);
        j++;
      }
      if (/^Holidays$/i.test(parts[parts.length - 1])) {
        out.push(parts.join(" "));
        i = j - 1;
        continue;
      }
    }
    // "CLOSE Thursday 22 October" + "(12h00)" on the next line
    if (
      /^CLOSE\b/i.test(line) &&
      i + 1 < raw.length &&
      /^\(\d{1,2}h\d{2}\)$/i.test(raw[i + 1])
    ) {
      line = `${line} ${raw[i + 1]}`;
      i++;
    }
    out.push(line);
  }
  return out;
}

/**
 * Holiday / mid-term rows from one Central Region column (year inherited).
 * Same-month ranges like "28 – 30 April (Mid-Term)"; parenthetical date-only
 * rows keep the written day (no invented holiday name from the other column).
 */
function parseCentralRegionHolidayLine(
  line: string,
  year: number
): ParsedEvent | null {
  const raw = normalizeDashEntities(line).replace(/['\u2019]/g, "'");

  // "28 – 30 April (Mid-Term)"
  const sameMonth = raw.match(
    new RegExp(
      String.raw`^(\d{1,2})(?:st|nd|rd|th)?\s*[–—−-]\s*(\d{1,2})(?:st|nd|rd|th)?\s+(${MONTH_ALT})\s*\(([^)]+)\)\s*$`,
      "i"
    )
  );
  if (sameMonth) {
    const month = MONTHS[sameMonth[3].toLowerCase()];
    const name = sameMonth[4].replace(/\s+/g, " ").trim();
    if (month != null && name.length >= 3 && !/^\d{1,2}h\d{2}$/i.test(name)) {
      const a = parseDateParts(Number(sameMonth[1]), month, year);
      const b = parseDateParts(Number(sameMonth[2]), month, year);
      if (a && b && b.getTime() >= a.getTime()) {
        return allDaySpan(name, raw, a, b);
      }
    }
  }

  const named = parseTermPublicHolidayLine(raw, year);
  if (named) return named;

  // "(Monday 15 June)" / "(Friday 25 September)" — date only, no label
  const parenOnly = raw.match(
    new RegExp(
      String.raw`^\((?:${WEEKDAY_ALT})\s+(\d{1,2})(?:st|nd|rd|th)?\s+(${MONTH_ALT})\)$`,
      "i"
    )
  );
  if (parenOnly) {
    const month = MONTHS[parenOnly[2].toLowerCase()];
    if (month == null) return null;
    const d = parseDateParts(Number(parenOnly[1]), month, year);
    if (!d) return null;
    const monthName =
      parenOnly[2].charAt(0).toUpperCase() + parenOnly[2].slice(1).toLowerCase();
    // Title is the written day + document year — do not steal "School Holiday"
    // from the other column.
    return allDayDay(`${Number(parenOnly[1])} ${monthName} ${year}`, raw, d);
  }

  return null;
}

/**
 * One column (4-term or 3-term) of the Central Region guideline PDF.
 * Start/Close term spans; Half Term CLOSE→RETURN; in-term holiday rows only.
 */
function parseCentralRegionSystem(
  lines: string[],
  year: number,
  system: "4-term" | "3-term"
): ParsedEvent[] {
  const events: ParsedEvent[] = [];
  let termN: number | null = null;
  let start: Date | null = null;
  let inHalfTerm = false;
  let halfClose: {
    date: Date;
    hour: number | null;
    minute: number;
    line: string;
  } | null = null;
  let inHolidays = false;

  for (const line of lines) {
    if (/^\d\s+TERM\s+CALENDAR$/i.test(line) || /^Total\b/i.test(line)) {
      continue;
    }

    const tm = line.match(/^Term\s+([1234])\b/i);
    if (tm) {
      termN = Number(tm[1]);
      start = null;
      inHalfTerm = false;
      halfClose = null;
      inHolidays = false;
      continue;
    }
    if (termN == null) continue;

    if (/^Start\b/i.test(line)) {
      const md = mdOnLine(line, year);
      if (md) start = md.date;
      inHalfTerm = false;
      halfClose = null;
      inHolidays = false;
      continue;
    }

    if (/^Half\s+Term\b/i.test(line)) {
      inHalfTerm = true;
      halfClose = null;
      inHolidays = false;
      continue;
    }

    if (/^Public\b/i.test(line) && /Holidays$/i.test(line)) {
      inHalfTerm = false;
      halfClose = null;
      inHolidays = true;
      continue;
    }

    // Half-term CLOSE/RETURN (uppercase in PDF) — not term Close
    if (inHalfTerm && /^CLOSE\b/.test(line)) {
      const md = mdOnLine(line, year);
      if (md) halfClose = { ...md, line };
      continue;
    }

    if (inHalfTerm && /^RETURN\b/.test(line) && halfClose) {
      const md = mdOnLine(line, year);
      if (md) {
        const ev = halfTermBreakEvent(
          `${system} Half Term`,
          `${halfClose.line}; ${line}`,
          halfClose,
          md.date
        );
        if (ev) events.push(ev);
      }
      halfClose = null;
      inHalfTerm = false;
      continue;
    }

    if (/^Close\b/.test(line) && start) {
      const md = mdOnLine(line, year);
      if (!md) continue;
      events.push(
        allDaySpan(
          `${system} Term ${termN} ${year}`,
          line,
          start,
          md.date
        )
      );
      start = null;
      continue;
    }

    if (inHolidays) {
      const hol = parseCentralRegionHolidayLine(line, year);
      if (hol) {
        // Prefix Mid-Term / keep public-holiday names; system only on terms + half
        if (/^Mid-Term$/i.test(hol.summary)) {
          events.push({ ...hol, summary: `${system} Mid-Term` });
        } else {
          events.push(hol);
        }
      }
    }
  }

  return events;
}

/**
 * ISASA / SAHISA Central Region 2026 GUIDELINE PDF: emit both 4-term and
 * 3-term Start/Close spans plus that column’s in-term holidays / half terms.
 * Columns are parsed separately — never mix days across systems.
 */
export function parseIsasaCentralRegionCalendar(
  text: string,
  opts?: ParseSourceOptions
): { title: string; events: ParsedEvent[] } {
  const cleaned = text.replace(/\u00a0/g, " ");
  const year =
    inferDocumentYear(cleaned, opts) ||
    (() => {
      const m = cleaned.match(/\b(20\d{2})\s+Calendar\b/i);
      return m ? Number(m[1]) : null;
    })();
  if (year == null) {
    return {
      title: "ISASA / SAHISA Central Region GUIDELINE",
      events: [],
    };
  }

  const fourMark = cleaned.search(/4\s+TERM\s+CALENDAR/i);
  const threeMark = cleaned.search(/3\s+TERM\s+CALENDAR/i);
  if (fourMark < 0 || threeMark < 0) {
    return {
      title: "ISASA / SAHISA Central Region 2026 GUIDELINE",
      events: [],
    };
  }

  const fourText =
    fourMark < threeMark
      ? cleaned.slice(fourMark, threeMark)
      : cleaned.slice(fourMark);
  const threeText =
    threeMark < fourMark
      ? cleaned.slice(threeMark, fourMark)
      : cleaned.slice(threeMark);

  const events = [
    ...parseCentralRegionSystem(
      normalizeCentralRegionLines(fourText),
      year,
      "4-term"
    ),
    ...parseCentralRegionSystem(
      normalizeCentralRegionLines(threeText),
      year,
      "3-term"
    ),
  ];

  return {
    title: "ISASA / SAHISA Central Region 2026 GUIDELINE",
    events,
  };
}

/**
 * Conservative dated-event extractor for HTML/PDF plain text.
 * Year is required on the line, or inherited only for written date ranges and
 * holiday lines when a document-level year is known (title, filename, or a
 * clear calendar year already on the page). Never invents days from outline
 * numbers; never uses SUMMARY "Watched event". Returns [] when none found.
 *
 * Western Cape school-calendar HTML is a special case: terms become year-titled
 * SPANS (not yearless open/close dots); holidays keep the year in the name.
 * Independent START:/CLOSE: term pages (year-stamped) become Term N spans plus
 * that page’s half-term CLOSE→RETURN and named Public Holiday lines.
 * ISASA/SAHISA Central Region guideline PDF: 4-term + 3-term columns separately.
 */
export function parseSourceText(
  text: string,
  _now: Date = new Date(),
  opts?: ParseSourceOptions
): { title: string; events: ParsedEvent[] } {
  const cleaned = dropChromeLines(text.replace(/\u00a0/g, " ").trim());
  const title = pageTitle(cleaned);
  if (!cleaned) return { title: "WatchCal feed", events: [] };

  if (
    looksLikeWesternCapeSchoolCalendar(cleaned) ||
    (opts?.sourceUrl && isWesternCapeSchoolCalendarUrl(opts.sourceUrl))
  ) {
    if (looksLikeWesternCapeSchoolCalendar(cleaned)) {
      return parseWesternCapeSchoolCalendarHtml(cleaned);
    }
  }

  if (
    looksLikeIsasaCentralRegionCalendar(cleaned) ||
    (opts?.sourceUrl && isIsasaCentralRegionCalendarUrl(opts.sourceUrl))
  ) {
    return parseIsasaCentralRegionCalendar(cleaned, opts);
  }

  if (looksLikeTermStartCloseCalendar(cleaned)) {
    return parseTermStartCloseCalendar(cleaned);
  }

  const inheritYear = inferDocumentYear(cleaned, opts);
  const dates = findDates(cleaned, inheritYear);
  if (!dates.length) return { title, events: [] };

  const events: ParsedEvent[] = [];
  // No hard event cap — school calendars with two years of holidays exceed 40.
  for (const hit of dates) {
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
