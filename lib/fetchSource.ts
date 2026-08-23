import { htmlToText } from "./parseSource";

export type FetchedSource = {
  contentType: string;
  text: string;
  title: string;
  raw: Buffer;
};

const MAX_BYTES = 4 * 1024 * 1024;

const IMAGE_PATH_RE = /\.(png|jpe?g|gif|webp)$/i;

/** Shared client + API wording — public https link only, not a screenshot. */
export const IMAGE_SOURCE_REJECTED =
  "Image URLs are not supported. Use a public https link to a page or PDF — not a screenshot or photo.";

function rejectImageSource(): never {
  const err = new Error(IMAGE_SOURCE_REJECTED) as Error & { status?: number };
  err.status = 400;
  throw err;
}

export function assertPublicHttpUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new Error("Invalid URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Only http(s) URLs are supported");
  }
  if (IMAGE_PATH_RE.test(url.pathname)) {
    rejectImageSource();
  }
  const host = url.hostname.toLowerCase();
  if (
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "0.0.0.0" ||
    host === "::1" ||
    host.endsWith(".local") ||
    host.endsWith(".internal")
  ) {
    throw new Error("Local/private hosts are not allowed");
  }
  // Block obvious link-local / private IPv4
  if (/^(10\.|192\.168\.|169\.254\.|127\.)/.test(host)) {
    throw new Error("Private network hosts are not allowed");
  }
  const m = host.match(/^172\.(\d+)\./);
  if (m && Number(m[1]) >= 16 && Number(m[1]) <= 31) {
    throw new Error("Private network hosts are not allowed");
  }
  return url;
}

async function extractPdfText(buf: Buffer): Promise<string> {
  // pdf-parse is CJS; load dynamically for Next bundling.
  const pdfParse = (await import("pdf-parse")).default as (
    data: Buffer
  ) => Promise<{ text: string }>;
  const result = await pdfParse(buf);
  return (result.text || "").trim();
}

/**
 * Fetch a public page or PDF and return extractable text.
 */
export async function fetchSource(
  sourceUrl: string,
  fetcher: typeof fetch = fetch
): Promise<FetchedSource> {
  const url = assertPublicHttpUrl(sourceUrl);
  let res: Response;
  try {
    res = await fetcher(url.toString(), {
      redirect: "follow",
      headers: {
        "User-Agent": "WatchCal/0.1 (+https://github.com/mjdp0/watch-cal)",
        Accept:
          "text/html,application/xhtml+xml,application/pdf,text/plain;q=0.9,*/*;q=0.8",
      },
    });
  } catch {
    const err = new Error(
      `Source fetch failed: could not reach ${url.hostname}`
    ) as Error & { status?: number };
    err.status = 422;
    throw err;
  }
  if (!res.ok) {
    const err = new Error(
      `Source fetch failed (${res.status}): ${url.hostname} returned an error`
    ) as Error & { status?: number };
    err.status = 422;
    throw err;
  }
  const contentType = (res.headers.get("content-type") || "").toLowerCase();
  // Extension-less screenshot URLs still arrive as image/* — reject before minting.
  if (contentType.startsWith("image/")) {
    rejectImageSource();
  }
  const ab = await res.arrayBuffer();
  if (ab.byteLength > MAX_BYTES) {
    throw new Error("Source is larger than 4MB");
  }
  const raw = Buffer.from(ab);
  const looksPdf =
    contentType.includes("application/pdf") ||
    url.pathname.toLowerCase().endsWith(".pdf") ||
    raw.slice(0, 4).toString() === "%PDF";

  if (looksPdf) {
    const text = await extractPdfText(raw);
    let fileName = url.pathname.split("/").pop() || "PDF";
    try {
      fileName = decodeURIComponent(fileName);
    } catch {
      /* keep raw segment */
    }
    return {
      contentType: "application/pdf",
      text,
      title: fileName,
      raw,
    };
  }

  const html = raw.toString("utf8");
  if (
    contentType.includes("text/html") ||
    contentType.includes("application/xhtml") ||
    /<html[\s>]/i.test(html)
  ) {
    const { title, text } = htmlToText(html);
    return { contentType: "text/html", text, title, raw };
  }

  // Plain text or unknown → treat as text
  const text = html;
  return {
    contentType: contentType || "text/plain",
    text,
    title: url.hostname,
    raw,
  };
}
