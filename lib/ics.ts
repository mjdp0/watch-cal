import { createHash } from "crypto";
import type { ParsedEvent } from "./types";

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function foldLine(line: string): string {
  if (line.length <= 75) return line;
  const parts: string[] = [];
  let remaining = line;
  parts.push(remaining.slice(0, 75));
  remaining = remaining.slice(75);
  while (remaining.length > 0) {
    parts.push(" " + remaining.slice(0, 74));
    remaining = remaining.slice(74);
  }
  return parts.join("\r\n");
}

function escapeText(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/\n/g, "\\n")
    .replace(/,/g, "\\,")
    .replace(/;/g, "\\;");
}

function formatUtcStamp(d: Date): string {
  return (
    d.getUTCFullYear() +
    pad(d.getUTCMonth() + 1) +
    pad(d.getUTCDate()) +
    "T" +
    pad(d.getUTCHours()) +
    pad(d.getUTCMinutes()) +
    pad(d.getUTCSeconds()) +
    "Z"
  );
}

function formatLocalDate(iso: string): string {
  const d = new Date(iso);
  return d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate());
}

function formatLocalDateTime(iso: string): string {
  const d = new Date(iso);
  return (
    d.getFullYear() +
    pad(d.getMonth() + 1) +
    pad(d.getDate()) +
    "T" +
    pad(d.getHours()) +
    pad(d.getMinutes()) +
    pad(d.getSeconds())
  );
}

/** Stable UID for a watch event so calendar clients update in place. */
export function eventUid(watchId: string, event: ParsedEvent, index: number): string {
  const key = createHash("sha256")
    .update(
      [watchId, event.start, event.end, event.allDay ? "1" : "0", event.summary, String(index)].join(
        "|"
      )
    )
    .digest("hex")
    .slice(0, 24);
  return `${key}@watchcal`;
}

/**
 * Build a valid VCALENDAR body (CRLF). Always emits at least calendar headers;
 * empty event lists still produce a publishable calendar (thin parse path).
 */
export function eventsToIcs(
  watchId: string,
  calName: string,
  events: ParsedEvent[],
  now: Date = new Date(),
  sourceUrl?: string
): string {
  const lines: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//WatchCal//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    foldLine(`X-WR-CALNAME:${escapeText(calName || "WatchCal")}`),
  ];
  if (sourceUrl) {
    lines.push(foldLine(`X-WR-CALDESC:${escapeText("Watched source: " + sourceUrl)}`));
  }

  const stamp = formatUtcStamp(now);

  if (events.length === 0) {
    // Thin parse: one stable placeholder so clients still have a feed that
    // changes DTSTAMP / DESCRIPTION when the source hash changes upstream.
    lines.push("BEGIN:VEVENT");
    lines.push(`UID:${createHash("sha256").update(watchId + "|thin").digest("hex").slice(0, 24)}@watchcal`);
    lines.push(`DTSTAMP:${stamp}`);
    lines.push(`DTSTART;VALUE=DATE:${formatLocalDate(now.toISOString())}`);
    const end = new Date(now);
    end.setDate(end.getDate() + 1);
    lines.push(`DTEND;VALUE=DATE:${formatLocalDate(end.toISOString())}`);
    lines.push(foldLine(`SUMMARY:${escapeText(calName || "WatchCal feed")}`));
    lines.push(
      foldLine(
        `DESCRIPTION:${escapeText(
          "No dated events found yet. This feed updates when the source page changes."
        )}`
      )
    );
    lines.push("END:VEVENT");
  } else {
    events.forEach((event, index) => {
      lines.push("BEGIN:VEVENT");
      lines.push(`UID:${eventUid(watchId, event, index)}`);
      lines.push(`DTSTAMP:${stamp}`);
      if (event.allDay) {
        lines.push(`DTSTART;VALUE=DATE:${formatLocalDate(event.start)}`);
        lines.push(`DTEND;VALUE=DATE:${formatLocalDate(event.end)}`);
      } else {
        lines.push(`DTSTART:${formatLocalDateTime(event.start)}`);
        lines.push(`DTEND:${formatLocalDateTime(event.end)}`);
      }
      lines.push(foldLine(`SUMMARY:${escapeText(event.summary)}`));
      lines.push(foldLine(`DESCRIPTION:${escapeText(event.description)}`));
      if (sourceUrl) lines.push(foldLine(`URL:${sourceUrl}`));
      lines.push("END:VEVENT");
    });
  }

  lines.push("END:VCALENDAR");
  return lines.join("\r\n") + "\r\n";
}

export function isValidVCalendar(ics: string): boolean {
  return (
    ics.includes("BEGIN:VCALENDAR") &&
    ics.includes("VERSION:2.0") &&
    ics.includes("END:VCALENDAR") &&
    ics.includes("BEGIN:VEVENT")
  );
}
