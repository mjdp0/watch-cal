/**
 * WatchCal core operations.
 *
 * MCP-shaped surface (optional; web path does not depend on MCP):
 *   watch(url)    → { id, webcal_url, https_url }
 *   refresh(id)   → { id, updated, event_count, source_hash }
 *
 * Refresh policy: on-read (feed GET) re-fetches when stale, plus optional
 * /api/cron and /api/refresh/[id]. Documented in README.
 */

import { eventsToIcs } from "./ics";
import { fetchSource } from "./fetchSource";
import { parseSourceText } from "./parseSource";
import {
  canCreateWatch,
  findWatchBySourceUrl,
  getWatch,
  hashContent,
  listWatches,
  newWatchId,
  saveWatch,
} from "./store";
import type { WatchRecord } from "./types";

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
  const watch = await getWatch(id, opts.dataPath);
  if (!watch) throw new Error("Watch not found");
  if (!opts.force && !isStale(watch, now)) return watch;

  const fetched = await fetchSource(watch.sourceUrl, opts.fetcher);
  const sourceHash = hashContent(fetched.text);
  const { title, events } = parseSourceText(fetched.text, now);
  const calName = fetched.title || title || "WatchCal";
  const ics = eventsToIcs(watch.id, calName, events, now, watch.sourceUrl);

  const updated: WatchRecord = {
    ...watch,
    title: calName,
    events,
    ics,
    sourceHash,
    lastFetchedAt: now.toISOString(),
    updatedAt: now.toISOString(),
  };
  return saveWatch(updated, opts.dataPath);
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
  const existing = await findWatchBySourceUrl(sourceUrl, opts.dataPath);
  if (existing) {
    const refreshed = await refreshWatch(existing.id, {
      ...opts,
      force: true,
    });
    return { watch: refreshed, urls: feedPaths(refreshed.id, origin) };
  }

  const gate = await canCreateWatch(sourceUrl, opts.dataPath);
  if (!gate.ok) {
    const err = new Error(gate.reason) as Error & { status?: number; existing?: WatchRecord };
    err.status = 403;
    err.existing = gate.existing;
    throw err;
  }

  const now = opts.now ?? new Date();
  const id = newWatchId();
  const stub: WatchRecord = {
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
  await saveWatch(stub, opts.dataPath);
  const watch = await refreshWatch(id, { ...opts, force: true, now });
  return { watch, urls: feedPaths(watch.id, origin) };
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
  // Strip optional .ics suffix from id
  const cleanId = id.replace(/\.ics$/i, "");
  let watch = await getWatch(cleanId, opts.dataPath);
  if (!watch) throw new Error("Watch not found");

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
