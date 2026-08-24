export type ParsedEvent = {
  summary: string;
  description: string;
  start: string; // ISO
  end: string; // ISO
  allDay: boolean;
  /** Olson TZID for timed events (e.g. Africa/Johannesburg). Ignored when allDay. */
  timeZone?: string;
};

export type WatchRecord = {
  id: string;
  sourceUrl: string;
  createdAt: string;
  updatedAt: string;
  lastFetchedAt: string | null;
  sourceHash: string | null;
  title: string;
  events: ParsedEvent[];
  ics: string;
};

export type WatchStoreFile = {
  watches: WatchRecord[];
  /** Pay-once Polar credits: each credit allows one extra watched URL beyond FREE_WATCH_LIMIT. */
  extraWatchCredits?: number;
  /** Webhook event ids already granted (idempotency). */
  grantedEventIds?: string[];
};
