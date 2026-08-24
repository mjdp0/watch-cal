/**
 * WatchCal core operations.
 *
 * MCP-shaped surface (optional; web path does not depend on MCP):
 *   watch(url)    → { id, webcal_url, https_url }
 *   preview(url)  → { title, event_count } (no mint, no quota)
 *   refresh(id)   → { id, updated, event_count, source_hash }
 *
 * Refresh policy: on-read (feed GET) re-fetches when stale, plus optional
 * /api/cron and /api/refresh/[id]. Documented in README.
 *
 * Watch ids are base64url(sourceUrl). After a Vercel cold start empties /tmp,
 * feed GET / refresh decode the id and rebuild — no Blob/KV required.
 */

import { eventsToIcs } from "./ics";
import { assertPublicHttpUrl, fetchSource } from "./fetchSource";
import {
  isWesternCapeSchoolCalendarUrl,
  mergeWesternCapeExamEvents,
  parseSourceText,
  parseWesternCapeExamPage,
  parseWesternCapePlanningPdf,
  WESTERN_CAPE_EXAM_PAGE_URLS,
  WESTERN_CAPE_PLANNING_PDF_URL,
} from "./parseSource";
import {
  createWatchAtomic,
  findWatchBySourceUrl,
  getWatch,
  hashContent,
  listWatches,
  saveWatch,
  sourceUrlFromWatchId,
  watchIdFromSourceUrl,
} from "./store";
import type { ParsedEvent, WatchRecord } from "./types";

/** Default staleness before on-read refresh (15 minutes). */
export const REFRESH_INTERVAL_MS = Number(
  process.env.WATCHCAL_REFRESH_MS || 15 * 60 * 1000
);

export type WatchUrls = {
  id: string;
  https_url: string;
  webcal_url: string;
  download_url: string;
};

export function feedPaths(id: string, origin: string): WatchUrls {
  const base = origin.replace(/\/$/, "");
  const https_url = `${base}/api/feed/${id}.ics`;
  const webcal_url = https_url.replace(/^https:/i, "webcal:").replace(/^http:/i, "webcal:");
  return {
    id,
    https_url,
    webcal_url,
    download_url: `${base}/api/feed/${id}.ics?download=1`,
  };
}

function isStale(watch: WatchRecord, now: Date): boolean {
  if (!watch.lastFetchedAt) return true;
  const last = new Date(watch.lastFetchedAt).getTime();
  return now.getTime() - last >= REFRESH_INTERVAL_MS;
}

/**
 * Parse primary source; for the Western Cape school-calendar page also ingest
 * the English planning PDF and Grade 12 / NSC exam nav pages linked from that
 * site into the same watch.
 */
async function parseWatchSource(
  sourceUrl: string,
  fetchedText: string,
  fetchedTitle: string,
  now: Date,
  fetcher: typeof fetch
): Promise<{ title: string; events: ParsedEvent[]; hashMaterial: string }> {
  const { title, events } = parseSourceText(fetchedText, now, {
    sourceTitle: fetchedTitle,
    sourceUrl,
  });
  let all = events;
  let hashMaterial = fetchedText;
  if (isWesternCapeSchoolCalendarUrl(sourceUrl)) {
    try {
      const pdf = await fetchSource(WESTERN_CAPE_PLANNING_PDF_URL, fetcher);
      const planning = parseWesternCapePlanningPdf(pdf.text);
      all = [...all, ...planning];
      hashMaterial = hashMaterial + "\n" + pdf.text;
    } catch {
      // Terms + holidays from the HTML still ship; planning may be 0.
    }
    const examBatches: ParsedEvent[][] = [];
    for (const examUrl of WESTERN_CAPE_EXAM_PAGE_URLS) {
      try {
        const page = await fetchSource(examUrl, fetcher);
        examBatches.push(parseWesternCapeExamPage(page.text));
        hashMaterial = hashMaterial + "\n" + page.text;
      } catch {
        // Optional enrichment — school-calendar HTML + planning still ship.
      }
    }
    all = [...all, ...mergeWesternCapeExamEvents(examBatches)];
  }
  return {
    title: fetchedTitle || title || "WatchCal",
    events: all,
    hashMaterial,
  };
}

function stubWatch(id: string, sourceUrl: string, now: Date): WatchRecord {
  return {
    id,
    sourceUrl,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    lastFetchedAt: null,
    sourceHash: null,
    title: "WatchCal",
    events: [],
    ics: eventsToIcs(id, "WatchCal", [], now, sourceUrl),
  };
}

/**
 * Load watch from cache, or rebuild from deterministic id (encoded source URL).
 */
export async function loadOrRebuildWatch(
  id: string,
  opts: {
    dataPath?: string;
    now?: Date;
  } = {}
): Promise<WatchRecord> {
  const cleanId = id.replace(/\.ics$/i, "");
  const existing = await getWatch(cleanId, opts.dataPath);
  if (existing) return existing;

  const sourceUrl = sourceUrlFromWatchId(cleanId);
  if (!sourceUrl) throw new Error("Watch not found");
  try {
    assertPublicHttpUrl(sourceUrl);
  } catch {
    throw new Error("Watch not found");
  }

  const now = opts.now ?? new Date();
  const expectedId = watchIdFromSourceUrl(sourceUrl);
  if (expectedId !== cleanId) throw new Error("Watch not found");

  const stub = stubWatch(cleanId, sourceUrl, now);
  return saveWatch(stub, opts.dataPath);
}

export async function refreshWatch(
  id: string,
  opts: {
    dataPath?: string;
    fetcher?: typeof fetch;
    now?: Date;
    force?: boolean;
  } = {}
): Promise<WatchRecord> {
  const now = opts.now ?? new Date();
  const cleanId = id.replace(/\.ics$/i, "");
  const watch = await loadOrRebuildWatch(cleanId, {
    dataPath: opts.dataPath,
    now,
  });
  if (!opts.force && !isStale(watch, now)) return watch;

  const fetched = await fetchSource(watch.sourceUrl, opts.fetcher);
  const parsed = await parseWatchSource(
    watch.sourceUrl,
    fetched.text,
    fetched.title,
    now,
    opts.fetcher ?? fetch
  );
  const sourceHash = hashContent(parsed.hashMaterial);
  const calName = parsed.title;
  const ics = eventsToIcs(
    watch.id,
    calName,
    parsed.events,
    now,
    watch.sourceUrl
  );

  const contentChanged =
    watch.sourceHash == null || watch.sourceHash !== sourceHash;
  const updated: WatchRecord = {
    ...watch,
    title: calName,
    events: parsed.events,
    ics,
    sourceHash,
    lastFetchedAt: now.toISOString(),
    // Only bump when the school page body actually changed.
    updatedAt: contentChanged ? now.toISOString() : watch.updatedAt,
  };
  return saveWatch(updated, opts.dataPath);
}

export type PreviewResult = {
  source_url: string;
  title: string;
  event_count: number;
};

/**
 * preview(url) — dry-run fetch+parse. Does not create a watch or consume quota.
 */
export async function previewUrl(
  sourceUrl: string,
  opts: {
    fetcher?: typeof fetch;
    now?: Date;
  } = {}
): Promise<PreviewResult> {
  const normalized = assertPublicHttpUrl(sourceUrl).toString();
  const now = opts.now ?? new Date();
  const fetched = await fetchSource(normalized, opts.fetcher);
  const parsed = await parseWatchSource(
    normalized,
    fetched.text,
    fetched.title,
    now,
    opts.fetcher ?? fetch
  );
  return {
    source_url: normalized,
    title: parsed.title,
    event_count: parsed.events.length,
  };
}

/**
 * watch(url) — create (or return existing) free-tier watch and return feed URLs.
 */
export async function watchUrl(
  sourceUrl: string,
  origin: string,
  opts: {
    dataPath?: string;
    fetcher?: typeof fetch;
    now?: Date;
  } = {}
): Promise<{ watch: WatchRecord; urls: WatchUrls }> {
  const normalized = assertPublicHttpUrl(sourceUrl).toString();
  const existing = await findWatchBySourceUrl(normalized, opts.dataPath);
  if (existing) {
    const refreshed = await refreshWatch(existing.id, {
      ...opts,
      force: true,
    });
    return { watch: refreshed, urls: feedPaths(refreshed.id, origin) };
  }

  // Fetch before free-tier gate so dead hosts return a fetch error, not the 1-watch cap.
  const now = opts.now ?? new Date();
  const fetched = await fetchSource(normalized, opts.fetcher);

  const id = watchIdFromSourceUrl(normalized);
  const parsed = await parseWatchSource(
    normalized,
    fetched.text,
    fetched.title,
    now,
    opts.fetcher ?? fetch
  );
  const sourceHash = hashContent(parsed.hashMaterial);
  const calName = parsed.title;
  const ics = eventsToIcs(id, calName, parsed.events, now, normalized);
  const created = await createWatchAtomic(
    {
      id,
      sourceUrl: normalized,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      lastFetchedAt: now.toISOString(),
      sourceHash,
      title: calName,
      events: parsed.events,
      ics,
    },
    opts.dataPath
  );
  if (!created.ok) {
    const err = new Error(created.reason) as Error & {
      status?: number;
      existing?: WatchRecord;
      needsPayment?: boolean;
    };
    err.status = 402;
    err.existing = created.existing;
    err.needsPayment = true;
    throw err;
  }
  return { watch: created.watch, urls: feedPaths(created.watch.id, origin) };
}

export async function getFeedIcs(
  id: string,
  opts: {
    dataPath?: string;
    fetcher?: typeof fetch;
    now?: Date;
    refresh?: boolean;
  } = {}
): Promise<string> {
  const cleanId = id.replace(/\.ics$/i, "");
  // Rebuild from encoded URL if /tmp (or local) cache is empty — cold start safe
  let watch = await loadOrRebuildWatch(cleanId, {
    dataPath: opts.dataPath,
    now: opts.now,
  });

  if (opts.refresh !== false) {
    try {
      watch = await refreshWatch(cleanId, {
        dataPath: opts.dataPath,
        fetcher: opts.fetcher,
        now: opts.now,
        force: false,
      });
    } catch {
      // Serve last known good ICS if refresh fails
      watch = (await getWatch(cleanId, opts.dataPath)) ?? watch;
    }
  }
  return watch.ics;
}

export async function refreshAllWatches(
  opts: {
    dataPath?: string;
    fetcher?: typeof fetch;
    now?: Date;
  } = {}
): Promise<{ refreshed: number; failed: number }> {
  const all = await listWatches(opts.dataPath);
  let refreshed = 0;
  let failed = 0;
  for (const w of all) {
    try {
      await refreshWatch(w.id, { ...opts, force: true });
      refreshed += 1;
    } catch {
      failed += 1;
    }
  }
  return { refreshed, failed };
}
