import { createHash } from "crypto";
import { mkdir, open, readFile, unlink, writeFile } from "fs/promises";
import path from "path";
import type { WatchRecord, WatchStoreFile } from "./types";

/** Max watches on the free (no-login) path. */
export const FREE_WATCH_LIMIT = 1;

/** In-process mutex per data file so concurrent POSTs cannot race the quota check. */
const storeChains = new Map<string, Promise<unknown>>();

function defaultDataPath(): string {
  if (process.env.WATCHCAL_DATA_PATH) return process.env.WATCHCAL_DATA_PATH;
  // Vercel serverless FS is read-only except /tmp — cache only; ids encode the source URL
  if (process.env.VERCEL) return "/tmp/watchcal-watches.json";
  return path.join(process.cwd(), "data", "watches.json");
}

async function ensureParent(filePath: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
}

async function readStore(filePath: string): Promise<WatchStoreFile> {
  try {
    const raw = await readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as WatchStoreFile;
    if (!parsed || !Array.isArray(parsed.watches)) {
      return { watches: [], extraWatchCredits: 0, grantedEventIds: [] };
    }
    return {
      watches: parsed.watches,
      extraWatchCredits: Number(parsed.extraWatchCredits) || 0,
      grantedEventIds: Array.isArray(parsed.grantedEventIds)
        ? parsed.grantedEventIds
        : [],
    };
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT") {
      return { watches: [], extraWatchCredits: 0, grantedEventIds: [] };
    }
    throw err;
  }
}

async function writeStore(filePath: string, store: WatchStoreFile): Promise<void> {
  await ensureParent(filePath);
  await writeFile(filePath, JSON.stringify(store, null, 2) + "\n", "utf8");
}

/**
 * Serialize store mutations (in-process queue + exclusive lockfile).
 * Prevents TOCTOU where two POSTs both pass canCreateWatch then both save.
 */
async function withStoreLock<T>(
  filePath: string,
  fn: () => Promise<T>
): Promise<T> {
  const prev = storeChains.get(filePath) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const chained = prev.then(
    () => gate,
    () => gate
  );
  storeChains.set(filePath, chained);

  await prev.catch(() => {});

  const lockPath = `${filePath}.lock`;
  await ensureParent(filePath);
  let lockHandle: Awaited<ReturnType<typeof open>> | null = null;
  const started = Date.now();
  while (!lockHandle) {
    try {
      lockHandle = await open(lockPath, "wx");
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code !== "EEXIST") throw err;
      if (Date.now() - started > 10_000) {
        throw new Error("Timed out waiting for watch store lock");
      }
      await new Promise((r) => setTimeout(r, 5));
    }
  }

  try {
    return await fn();
  } finally {
    await lockHandle.close().catch(() => {});
    await unlink(lockPath).catch(() => {});
    release();
    if (storeChains.get(filePath) === chained) storeChains.delete(filePath);
  }
}

/**
 * Deterministic watch id from source URL (base64url).
 * Feed GET can decode the id and rebuild after a cold /tmp wipe — no Blob/KV.
 */
export function watchIdFromSourceUrl(sourceUrl: string): string {
  const normalized = new URL(sourceUrl.trim()).toString();
  return Buffer.from(normalized, "utf8").toString("base64url");
}

/** Decode source URL from a watch id, or null if not a valid encoded URL. */
export function sourceUrlFromWatchId(id: string): string | null {
  try {
    const clean = id.replace(/\.ics$/i, "");
    const decoded = Buffer.from(clean, "base64url").toString("utf8");
    const url = new URL(decoded);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.toString();
  } catch {
    return null;
  }
}

export function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

export async function listWatches(
  dataPath: string = defaultDataPath()
): Promise<WatchRecord[]> {
  const store = await readStore(dataPath);
  return store.watches;
}

export async function getWatch(
  id: string,
  dataPath: string = defaultDataPath()
): Promise<WatchRecord | null> {
  const store = await readStore(dataPath);
  return store.watches.find((w) => w.id === id) ?? null;
}

export async function findWatchBySourceUrl(
  sourceUrl: string,
  dataPath: string = defaultDataPath()
): Promise<WatchRecord | null> {
  const normalized = new URL(sourceUrl.trim()).toString();
  const byId = await getWatch(watchIdFromSourceUrl(normalized), dataPath);
  if (byId) return byId;
  const store = await readStore(dataPath);
  return store.watches.find((w) => w.sourceUrl === normalized || w.sourceUrl === sourceUrl) ?? null;
}

export async function saveWatch(
  watch: WatchRecord,
  dataPath: string = defaultDataPath()
): Promise<WatchRecord> {
  return withStoreLock(dataPath, async () => {
    const store = await readStore(dataPath);
    const idx = store.watches.findIndex((w) => w.id === watch.id);
    if (idx >= 0) store.watches[idx] = watch;
    else store.watches.push(watch);
    await writeStore(dataPath, store);
    return watch;
  });
}

export async function getExtraWatchCredits(
  dataPath: string = defaultDataPath()
): Promise<number> {
  const store = await readStore(dataPath);
  return store.extraWatchCredits ?? 0;
}

export async function maxWatchSlots(
  dataPath: string = defaultDataPath()
): Promise<number> {
  return FREE_WATCH_LIMIT + (await getExtraWatchCredits(dataPath));
}

function quotaBlockedReason(): string {
  return `This URL needs a pay-once extra watch. Free path allows ${FREE_WATCH_LIMIT} watch — pay once ($1) for one extra watched URL, or reuse the existing feed.`;
}

/**
 * Grant one pay-once extra-watch credit (idempotent per eventId).
 */
export async function grantExtraWatchCredit(
  eventId: string,
  dataPath: string = defaultDataPath()
): Promise<{ granted: boolean; credits: number }> {
  return withStoreLock(dataPath, async () => {
    const store = await readStore(dataPath);
    const grantedIds = store.grantedEventIds ?? [];
    if (eventId && grantedIds.includes(eventId)) {
      return { granted: false, credits: store.extraWatchCredits ?? 0 };
    }
    if (eventId) grantedIds.push(eventId);
    const credits = (store.extraWatchCredits ?? 0) + 1;
    store.extraWatchCredits = credits;
    store.grantedEventIds = grantedIds;
    await writeStore(dataPath, store);
    return { granted: true, credits };
  });
}

export async function canCreateWatch(
  sourceUrl: string,
  dataPath: string = defaultDataPath()
): Promise<{ ok: true } | { ok: false; reason: string; existing?: WatchRecord }> {
  const existingSame = await findWatchBySourceUrl(sourceUrl, dataPath);
  if (existingSame) return { ok: true };

  const all = await listWatches(dataPath);
  const max = await maxWatchSlots(dataPath);
  if (all.length >= max) {
    return {
      ok: false,
      reason: quotaBlockedReason(),
      existing: all[0],
    };
  }
  return { ok: true };
}

export type CreateWatchResult =
  | { ok: true; watch: WatchRecord }
  | { ok: false; reason: string; existing?: WatchRecord };

/**
 * Insert a new watch under lock: re-check quota in the same critical section as write.
 * Same-id upserts are allowed (refresh / rebuild). Over-quota new URLs are rejected.
 */
export async function createWatchAtomic(
  watch: WatchRecord,
  dataPath: string = defaultDataPath()
): Promise<CreateWatchResult> {
  return withStoreLock(dataPath, async () => {
    const store = await readStore(dataPath);
    const idx = store.watches.findIndex((w) => w.id === watch.id);
    if (idx >= 0) {
      store.watches[idx] = watch;
      await writeStore(dataPath, store);
      return { ok: true, watch };
    }

    const max = FREE_WATCH_LIMIT + (Number(store.extraWatchCredits) || 0);
    if (store.watches.length >= max) {
      return {
        ok: false,
        reason: quotaBlockedReason(),
        existing: store.watches[0],
      };
    }

    store.watches.push(watch);
    await writeStore(dataPath, store);
    return { ok: true, watch };
  });
}

export { defaultDataPath };
