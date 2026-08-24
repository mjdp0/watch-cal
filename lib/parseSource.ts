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
 * English WCED planning PDF — parent-facing dated rows with source wording:
 * §2.1 religious observances, admissions windows, NSC/parent result dates,
 * Grade 12 trial exam start/end. Untitled or day-less rows are dropped.
 * Full ~295 admin deadline rows are NOT all emitted.
 */
export function parseWesternCapePlanningPdf(text: string): ParsedEvent[] {
  const cleaned = text.replace(/\u00a0/g, " ");
  const events: ParsedEvent[] = [];
  const seen = new Set<string>();

  function push(summary: string, day: Date, endDay?: Date) {
    const s = summary.replace(/\s+/g, " ").trim().slice(0, 120);
    if (!s || isJunkSummary(s) || WEEKDAY_ONLY.test(s)) return;
    const start = new Date(day.getFullYear(), day.getMonth(), day.getDate());
    const last = endDay
      ? new Date(endDay.getFullYear(), endDay.getMonth(), endDay.getDate())
      : start;
    if (last.getTime() < start.getTime()) return;
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

  /** Parent-facing numbered activities — not the full admin deadline list. */
  function isParentFacingActivity(label: string): boolean {
    if (
      /school admissions?\s+(open|close)/i.test(label) ||
      /admissions?\s+open for transfer/i.test(label) ||
      /admissions?\s+close for transfer/i.test(label)
    ) {
      return true;
    }
    if (
      /parents?\s+(are\s+)?informed of the outcome/i.test(label) ||
      /parents?\s+confirm acceptance/i.test(label) ||
      /parents?\s+to appeal/i.test(label) ||
      /appeal the\s+progression\/promotion results/i.test(label)
    ) {
      return true;
    }
    if (
      /Release of the 2025 National Senior Certificate/i.test(label) ||
      /NSC examination re-marks/i.test(label) ||
      /Release of May\/June NSC\/SC examination results/i.test(label) ||
      /Grade\s*12\s+September trial examinations/i.test(label)
    ) {
      return true;
    }
    return false;
  }

  type DateSpan = { start: Date; end?: Date };

  function parseDatedSpans(blob: string): DateSpan[] {
    const out: DateSpan[] = [];
    const add = (start: Date | null, end?: Date | null) => {
      if (!start) return;
      out.push(end ? { start, end } : { start });
    };
    // "15 April to 18 May 2026" / "28 May to 10 June 2026"
    const crossMonth = new RegExp(
      String.raw`(\d{1,2})\s+(${MONTH_ALT})\s+to\s+(\d{1,2})\s+(${MONTH_ALT})\s+(20\d{2})`,
      "gi"
    );
    let m: RegExpExecArray | null;
    while ((m = crossMonth.exec(blob)) !== null) {
      const m1 = MONTHS[m[2].toLowerCase()];
      const m2 = MONTHS[m[4].toLowerCase()];
      const y = Number(m[5]);
      if (m1 == null || m2 == null) continue;
      add(parseDateParts(Number(m[1]), m1, y), parseDateParts(Number(m[3]), m2, y));
    }
    // "13 to 27 January 2026"
    const sameMonth = new RegExp(
      String.raw`(\d{1,2})\s+to\s+(\d{1,2})\s+(${MONTH_ALT})\s+(20\d{2})`,
      "gi"
    );
    while ((m = sameMonth.exec(blob)) !== null) {
      const month = MONTHS[m[3].toLowerCase()];
      const y = Number(m[4]);
      if (month == null) continue;
      add(
        parseDateParts(Number(m[1]), month, y),
        parseDateParts(Number(m[2]), month, y)
      );
    }
    // Single "13 January 2026" — skip if already inside a range match span of text
    const single = new RegExp(
      String.raw`(^|[^0-9])(\d{1,2})\s+(${MONTH_ALT})\s+(20\d{2})\b`,
      "gi"
    );
    while ((m = single.exec(blob)) !== null) {
      const idx = m.index + m[1].length;
      // Skip if this day is the start/end of a "N to M Month" already captured nearby
      const around = blob.slice(Math.max(0, idx - 8), idx + m[0].length + 8);
      if (/\d{1,2}\s+to\s+\d{1,2}\s+\w+\s+20\d{2}/i.test(around)) continue;
      if (
        /\d{1,2}\s+\w+\s+to\s+\d{1,2}\s+\w+\s+20\d{2}/i.test(
          blob.slice(Math.max(0, idx - 20), idx + 40)
        )
      ) {
        continue;
      }
      const month = MONTHS[m[3].toLowerCase()];
      if (month == null) continue;
      add(parseDateParts(Number(m[2]), month, Number(m[4])));
    }
    return out;
  }

  function labelWithoutDates(blob: string): string {
    return blob
      .replace(
        new RegExp(
          String.raw`\s*\d{1,2}\s+to\s+\d{1,2}\s+(?:${MONTH_ALT})\s+20\d{2}`,
          "gi"
        ),
        ""
      )
      .replace(
        new RegExp(
          String.raw`\s*\d{1,2}\s+(?:${MONTH_ALT})\s+to\s+\d{1,2}\s+(?:${MONTH_ALT})\s+20\d{2}`,
          "gi"
        ),
        ""
      )
      .replace(
        new RegExp(String.raw`\s*\d{1,2}\s+(?:${MONTH_ALT})\s+20\d{2}`, "gi"),
        ""
      )
      .replace(/\s*\(to be confirmed\)/gi, "")
      .replace(/\s+/g, " ")
      .replace(/^[\s\-–—:]+|[\s\-–—:]+$/g, "")
      .trim();
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

  const lines = cleaned.split(/\r?\n/).map((l) => l.replace(/\s+/g, " ").trim());

  // Multi-line religious blocks: label then date lines
  for (let i = 0; i < lines.length; i++) {
    let name = lines[i];
    if (
      /^Shemini Atzeret and Simchat$/i.test(name) &&
      /torah/i.test(lines[i + 1] || "")
    ) {
      name = "Shemini Atzeret and Simchat Torah";
    }
    if (!isObservanceLabel(name)) continue;
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

  // Numbered activities: "35. School admissions open …" + date on same/next lines
  type NumItem = { lines: string[] };
  const items: NumItem[] = [];
  let cur: NumItem | null = null;
  for (const line of lines) {
    const start = line.match(/^(\d+)\.\s+(.*)$/);
    if (start) {
      if (cur) items.push(cur);
      cur = { lines: [start[2]] };
      continue;
    }
    if (cur) {
      // Stop collecting at section headers
      if (/^3\.\d/.test(line) || /^Activity Due date$/i.test(line)) {
        items.push(cur);
        cur = null;
        continue;
      }
      cur.lines.push(line);
    }
  }
  if (cur) items.push(cur);

  for (const item of items) {
    const blob = item.lines.join(" ").replace(/\s+/g, " ").trim();
    if (!isParentFacingActivity(blob)) continue;
    // Month-only / TBC without a day — drop (do not invent)
    if (
      !/\d{1,2}\s+(?:to\s+\d{1,2}\s+)?(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)/i.test(
        blob
      ) &&
      !/\d{1,2}\s+(?:January|February|March|April|May|June|July|August|September|October|November|December)/i.test(
        blob
      )
    ) {
      continue;
    }
    const spans = parseDatedSpans(blob);
    if (!spans.length) continue;
    let label = labelWithoutDates(blob);
    // Prefer a stable short source title for known rows
    if (/Release of the 2025 National Senior Certificate/i.test(blob)) {
      label = "Release of the 2025 National Senior Certificate (NSC) examination results";
    } else if (/NSC examination re-marks/i.test(blob)) {
      label = "Submit applications for NSC examination re-marks and rechecks";
    } else if (/parents?\s+to appeal the\s+progression/i.test(blob)) {
      label =
        "Closing date for parents to appeal the progression/promotion results of their children";
    } else if (/trial examinations?\s+earliest\s+start/i.test(blob)) {
      label = "Grade 12 September trial examinations earliest start date";
    } else if (/trial examinations?\s+end date/i.test(blob)) {
      label = "Grade 12 September trial examinations end date";
    } else if (/admissions?\s+open for Grades R/i.test(blob)) {
      label = "School admissions open for Grades R, 1 and 8 (all ordinary public schools)";
    } else if (/admissions?\s+close for Grades R/i.test(blob)) {
      label = "School admissions close for Grades R, 1 and 8 (all ordinary public schools)";
    } else if (/admissions?\s+open for transfer/i.test(blob)) {
      label = "School admissions open for transfer requests (all ordinary public schools)";
    } else if (/admissions?\s+close for transfer/i.test(blob)) {
      label = "School admissions close for transfer requests (all ordinary public schools)";
    } else if (/Parents informed of the outcome of online admission/i.test(blob)) {
      label = "Parents informed of the outcome of online admission applications per email/SMS";
    } else if (/Parents\s+confirm acceptance of Grades R/i.test(blob)) {
      label = "Parents confirm acceptance of Grades R, 1 and 8 placements";
    } else if (/Parents are informed of the outcome per email\/SMS/i.test(blob)) {
      label = "Parents are informed of the outcome per email/SMS";
    } else if (/Parents confirm acceptance of transfer placements/i.test(blob)) {
      label = "Parents confirm acceptance of transfer placements";
    } else if (/Release of May\/June NSC\/SC examination results/i.test(blob)) {
      // Often month-only in the PDF — only emit if a day span was parsed
      label = "Release of May/June NSC/SC examination results";
    }
    if (!label || label.length < 8) continue;
    for (const span of spans) {
      push(label, span.start, span.end);
    }
  }

  return events;
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
