import { createHash } from "crypto";
import { mkdir, readFile, writeFile } from "fs/promises";
import path from "path";
import type { WatchRecord, WatchStoreFile } from "./types";

/** Max watches on the free (no-login) path. */
export const FREE_WATCH_LIMIT = 1;

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
    if (!parsed || !Array.isArray(parsed.watches)) return { watches: [] };
    return parsed;
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT") return { watches: [] };
    throw err;
  }
}

async function writeStore(filePath: string, store: WatchStoreFile): Promise<void> {
  await ensureParent(filePath);
  await writeFile(filePath, JSON.stringify(store, null, 2) + "\n", "utf8");
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
  const store = await readStore(dataPath);
  const idx = store.watches.findIndex((w) => w.id === watch.id);
  if (idx >= 0) store.watches[idx] = watch;
  else store.watches.push(watch);
  await writeStore(dataPath, store);
  return watch;
}

export async function canCreateWatch(
  sourceUrl: string,
  dataPath: string = defaultDataPath()
): Promise<{ ok: true } | { ok: false; reason: string; existing?: WatchRecord }> {
  const existingSame = await findWatchBySourceUrl(sourceUrl, dataPath);
  if (existingSame) return { ok: true };

  const all = await listWatches(dataPath);
  if (all.length >= FREE_WATCH_LIMIT) {
    return {
      ok: false,
      reason: `Free path allows ${FREE_WATCH_LIMIT} watch. Refresh or reuse the existing feed.`,
      existing: all[0],
    };
  }
  return { ok: true };
}

export { defaultDataPath };
