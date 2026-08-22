export type ParsedEvent = {
  summary: string;
  description: string;
  start: string; // ISO
  end: string; // ISO
  allDay: boolean;
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
};
