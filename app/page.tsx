"use client";

import { ClipboardEvent, FormEvent, useEffect, useState } from "react";

type WatchPayload = {
  id: string;
  title: string;
  event_count: number;
  https_url: string;
  webcal_url: string;
  download_url: string;
  source_url: string;
  last_fetched_at?: string | null;
  last_changed_at?: string | null;
};

/** Browser-only last-watch key — not a shareable product URL. */
const LAST_WATCH_KEY = "watchcal:lastWatch";

/** Live Western Cape feed id only — do not invent other feed ids. */
const WESTERN_CAPE_FEED_ID =
  "aHR0cHM6Ly93d3cud2VzdGVybmNhcGUuZ292LnphL2VkdWNhdGlvbi9zY2hvb2wtY2FsZW5kYXI";

/**
 * Only ship example tiles whose feed matches what a parent would read on the
 * source. Western Cape watch: term SPANS + page holidays + planning observances
 * from the English PDF linked on that page — not Grade 12 / NSC exam URLs.
 * Stithians Extra stays hidden until PDF term/holiday PERIODS match.
 * Ridgewood Extra: Term N spans + page half terms + named holidays (not PDF).
 * ISASA/SAHISA Central Region Extra: 2026 GUIDELINE PDF (4-term + 3-term) —
 * not a specific school’s calendar; watch the Brescia PDF URL, not isasa.org HTML.
 * Extra tiles (no feedId) must preview via POST /api/preview — never auto-mint.
 */
const EXAMPLES: {
  label: string;
  url: string;
  feedId?: string;
}[] = [
  {
    label: "Western Cape terms + planning (partial)",
    url: "https://www.westerncape.gov.za/education/school-calendar",
    feedId: WESTERN_CAPE_FEED_ID,
  },
  {
    label: "Ridgewood College terms + holidays 2026",
    url: "https://ridgewoodcollege.co.za/term-dates/",
  },
  {
    label:
      "ISASA/SAHISA Central Region 2026 GUIDELINE (4-term + 3-term)",
    url: "https://www.brescia.co.za/uploads/files/Calendars/ISASA.and.SAHISA.Central.Region.Calendar.2026.pdf",
  },
];

type PreviewPayload = {
  source_url: string;
  title: string;
  event_count: number;
};

type LastWatchStored = {
  id: string;
  title: string;
  event_count: number;
  source_url: string;
  last_fetched_at?: string | null;
  last_changed_at?: string | null;
};

function linksForId(id: string, origin: string) {
  const base = origin.replace(/\/$/, "");
  const https_url = `${base}/api/feed/${id}.ics`;
  const webcal_url = https_url
    .replace(/^https:/i, "webcal:")
    .replace(/^http:/i, "webcal:");
  return {
    https_url,
    webcal_url,
    download_url: `${https_url}?download=1`,
  };
}

function hydrateLastWatch(
  stored: LastWatchStored,
  origin: string
): WatchPayload {
  return {
    id: stored.id,
    title: stored.title,
    event_count: stored.event_count,
    source_url: stored.source_url,
    last_fetched_at: stored.last_fetched_at ?? null,
    last_changed_at: stored.last_changed_at ?? null,
    ...linksForId(stored.id, origin),
  };
}

function readLastWatch(origin: string): WatchPayload | null {
  try {
    const raw = localStorage.getItem(LAST_WATCH_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw) as Partial<LastWatchStored>;
    if (!data.id || typeof data.id !== "string") return null;
    return hydrateLastWatch(
      {
        id: data.id,
        title: typeof data.title === "string" ? data.title : "WatchCal",
        event_count:
          typeof data.event_count === "number" ? data.event_count : 0,
        source_url: typeof data.source_url === "string" ? data.source_url : "",
        last_fetched_at:
          typeof data.last_fetched_at === "string"
            ? data.last_fetched_at
            : null,
        last_changed_at:
          typeof data.last_changed_at === "string"
            ? data.last_changed_at
            : null,
      },
      origin
    );
  } catch {
    return null;
  }
}

function writeLastWatch(watch: WatchPayload) {
  const stored: LastWatchStored = {
    id: watch.id,
    title: watch.title,
    event_count: watch.event_count,
    source_url: watch.source_url,
    last_fetched_at: watch.last_fetched_at ?? null,
    last_changed_at: watch.last_changed_at ?? null,
  };
  localStorage.setItem(LAST_WATCH_KEY, JSON.stringify(stored));
}

/** Parent-facing relative time for last check / last change. */
function parentRelativeTime(iso: string | null | undefined, kind: "checked" | "changed"): string {
  if (!iso) {
    return kind === "checked"
      ? "Not checked yet"
      : "Updated when the school page last changed";
  }
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0 || ms < 60_000) {
    return kind === "checked"
      ? "Checked just now"
      : "Updated when the school page last changed";
  }
  const mins = Math.floor(ms / 60_000);
  if (mins < 60) {
    return kind === "checked"
      ? `Checked ${mins} minute${mins === 1 ? "" : "s"} ago`
      : `Last changed ${mins} minute${mins === 1 ? "" : "s"} ago`;
  }
  const hours = Math.floor(mins / 60);
  if (hours < 48) {
    return kind === "checked"
      ? `Checked ${hours} hour${hours === 1 ? "" : "s"} ago`
      : `Last changed ${hours} hour${hours === 1 ? "" : "s"} ago`;
  }
  const days = Math.floor(hours / 24);
  return kind === "checked"
    ? `Checked ${days} day${days === 1 ? "" : "s"} ago`
    : `Last changed ${days} day${days === 1 ? "" : "s"} ago`;
}

export default function HomePage() {
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [watch, setWatch] = useState<WatchPayload | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [needsExtraWatch, setNeedsExtraWatch] = useState(false);
  const [checkoutBusy, setCheckoutBusy] = useState(false);
  const [checkoutHint, setCheckoutHint] = useState<string | null>(null);
  const [origin, setOrigin] = useState("https://watch-cal.vercel.app");
  const [previewBusy, setPreviewBusy] = useState(false);
  const [preview, setPreview] = useState<PreviewPayload | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);

  useEffect(() => {
    setOrigin(window.location.origin);
    const restored = readLastWatch(window.location.origin);
    if (!restored) return;
    setWatch(restored);
    if (restored.source_url) setUrl(restored.source_url);
  }, []);

  function rememberWatch(next: WatchPayload) {
    setWatch(next);
    writeLastWatch(next);
  }

  async function createWatch(sourceUrl: string) {
    setBusy(true);
    setError(null);
    setWatch(null);
    setCopied(null);
    setNeedsExtraWatch(false);
    setCheckoutHint(null);
    setPreview(null);
    setPreviewError(null);
    try {
      const res = await fetch("/api/watches", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: sourceUrl }),
      });
      const data = (await res.json()) as {
        success: boolean;
        message: string;
        payload: WatchPayload & {
          existing_id?: string;
          checkout_url?: string | null;
          checkout_message?: string;
        };
      };
      if (!data.success) {
        // Do not hydrate the free watch's feed under a different URL — that
        // looks like a failed parse of the example the user just tried.
        if (res.status === 402 || res.status === 403) {
          setNeedsExtraWatch(true);
          setError(
            data.message ||
              "First calendar free. Another school is $5 once."
          );
          if (data.payload?.checkout_message) {
            setCheckoutHint(data.payload.checkout_message);
          }
        } else {
          setError(data.message);
        }
        return;
      }
      rememberWatch({
        ...data.payload,
        last_fetched_at: data.payload.last_fetched_at ?? null,
        last_changed_at: data.payload.last_changed_at ?? null,
      });
      if (data.payload.event_count === 0) {
        setError(
          "No dated events found on that page. Feeds only include lines with a real calendar date (day, month, and year)."
        );
      }
    } catch {
      setError("Could not create watch");
    } finally {
      setBusy(false);
    }
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    await createWatch(url);
  }

  function onUrlPaste(e: ClipboardEvent<HTMLInputElement>) {
    const cd = e.clipboardData;
    if (!cd) return;
    for (const item of Array.from(cd.items)) {
      if (item.type.startsWith("image/")) {
        e.preventDefault();
        setError(
          "Use a public https link to a page or PDF — not a screenshot or photo."
        );
        setNeedsExtraWatch(false);
        setCheckoutHint(null);
        return;
      }
    }
    const text = (cd.getData("text") || "").trim();
    if (
      text.startsWith("data:") ||
      text.startsWith("blob:") ||
      (/^[a-z][a-z0-9+.-]*:/i.test(text) && !/^https?:\/\//i.test(text))
    ) {
      e.preventDefault();
      setError(
        "Use a public https link to a page or PDF — not a screenshot or photo."
      );
      setNeedsExtraWatch(false);
      setCheckoutHint(null);
    }
  }

  async function previewExample(sourceUrl: string) {
    setPreviewBusy(true);
    setPreview(null);
    setPreviewError(null);
    setWatch(null);
    setError(null);
    setNeedsExtraWatch(false);
    setCheckoutHint(null);
    setCopied(null);
    try {
      const res = await fetch("/api/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: sourceUrl }),
      });
      const data = (await res.json()) as {
        success: boolean;
        message: string;
        payload: PreviewPayload;
      };
      if (!data.success) {
        setPreviewError(data.message || "Preview failed");
        return;
      }
      setPreview(data.payload);
      // Extra preview succeeded — offer pay-once path (no mint yet).
      setNeedsExtraWatch(true);
    } catch {
      setPreviewError("Could not preview URL");
    } finally {
      setPreviewBusy(false);
    }
  }

  function useExample(example: (typeof EXAMPLES)[number]) {
    setUrl(example.url);
    // Partial WC feed may create a watch. Extra examples preview via
    // /api/preview — never POST /api/watches (would 402 / mint).
    if (example.feedId) {
      setPreview(null);
      setPreviewError(null);
      void createWatch(example.url);
      return;
    }
    void previewExample(example.url);
  }

  async function startExtraWatchCheckout() {
    setCheckoutBusy(true);
    setCheckoutHint(null);
    try {
      const res = await fetch("/api/polar/checkout", { method: "POST" });
      const data = (await res.json()) as {
        success: boolean;
        message: string;
        payload: { checkout_url: string | null };
      };
      if (!data.success || !data.payload?.checkout_url) {
        setCheckoutHint(data.message || "checkout not configured");
        return;
      }
      window.open(data.payload.checkout_url, "_blank", "noopener,noreferrer");
    } catch {
      setCheckoutHint("checkout not configured");
    } finally {
      setCheckoutBusy(false);
    }
  }

  async function copyLink(value: string, key: string) {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(key);
    } catch {
      setCopied(null);
    }
  }

  return (
    <main>
      <h1 className="brand">WatchCal</h1>
      <p className="lede">
        Enter a public https link (page or PDF URL). The dates land in your phone
        calendar and stay updated when the school page changes.
      </p>

      <form className="form" onSubmit={onSubmit}>
        <label htmlFor="source">Public https link</label>
        <div className="row">
          <input
            id="source"
            type="url"
            required
            placeholder="https://school.example/term-dates"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onPaste={onUrlPaste}
            disabled={busy || previewBusy}
          />
          <button type="submit" disabled={busy || previewBusy}>
            {busy ? "Watching…" : "Create watch"}
          </button>
        </div>
      </form>

      <div className="examples">
        <p className="examples-label">Examples</p>
        <ul className="example-list">
          {EXAMPLES.map((example) => {
            const feedLinks = example.feedId
              ? linksForId(example.feedId, origin)
              : null;
            return (
              <li key={example.url}>
                <button
                  type="button"
                  className="example"
                  disabled={busy || previewBusy}
                  onClick={() => useExample(example)}
                >
                  {example.label}
                  {!example.feedId && (
                    <span className="example-extra"> Extra / $5</span>
                  )}
                </button>
                {feedLinks && (
                  <p className="example-feed">
                    Add to phone:{" "}
                    <a href={feedLinks.webcal_url}>webcal</a>
                    {" · "}
                    <a href={feedLinks.https_url}>https .ics</a>
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      </div>

      {error && <p className="error">{error}</p>}

      {(previewBusy || preview || previewError) && (
        <section className="preview" aria-live="polite">
          <h2>Preview</h2>
          {previewBusy && <p className="meta">Checking dates… not subscribed yet</p>}
          {previewError && <p className="error">{previewError}</p>}
          {preview && (
            <p className="meta">
              {preview.title} · {preview.event_count} event
              {preview.event_count === 1 ? "" : "s"} · not subscribed yet
            </p>
          )}
          {preview && (
            <div className="pay-once preview-checkout">
              <p>
                First calendar free. Another school is $5 once — then tap Create
                watch to subscribe.
              </p>
              <button
                type="button"
                onClick={startExtraWatchCheckout}
                disabled={checkoutBusy}
              >
                {checkoutBusy
                  ? "Opening checkout…"
                  : "Pay $5 once for another school"}
              </button>
              {checkoutHint && <p className="error">{checkoutHint}</p>}
            </div>
          )}
        </section>
      )}

      {needsExtraWatch && !preview && (
        <div className="pay-once">
          <p>First calendar free. Another school is $5 once.</p>
          <button
            type="button"
            onClick={startExtraWatchCheckout}
            disabled={checkoutBusy}
          >
            {checkoutBusy ? "Opening checkout…" : "Pay $5 once for another school"}
          </button>
          {checkoutHint && <p className="error">{checkoutHint}</p>}
        </div>
      )}

      {watch && (
        <section className="result" aria-live="polite">
          <h2>Subscribe to this feed</h2>
          <p>
            Add the webcal link in Apple Calendar or Google Calendar. The same
            URL updates when the source page changes.
          </p>
          <div className="links">
            <div className="link-row">
              <strong>webcal</strong>
              <a className="feed-link" href={watch.webcal_url}>
                {watch.webcal_url}
              </a>
              <button
                type="button"
                className="copy"
                onClick={() => copyLink(watch.webcal_url, "webcal")}
              >
                {copied === "webcal" ? "Copied" : "Copy"}
              </button>
            </div>
            <div className="link-row">
              <strong>https .ics</strong>
              <a className="feed-link" href={watch.https_url}>
                {watch.https_url}
              </a>
              <button
                type="button"
                className="copy"
                onClick={() => copyLink(watch.https_url, "https")}
              >
                {copied === "https" ? "Copied" : "Copy"}
              </button>
            </div>
            <div>
              <a href={watch.download_url}>Download one-shot .ics</a>
            </div>
          </div>
          <p className="meta">
            {watch.title} · {watch.event_count} event
            {watch.event_count === 1 ? "" : "s"}
          </p>
          <p className="meta freshness">
            {parentRelativeTime(watch.last_fetched_at, "checked")}
            {" · "}
            {parentRelativeTime(watch.last_changed_at, "changed")}
          </p>
        </section>
      )}

      <p className="note">
        First calendar free. Another school is $5 once.
      </p>
    </main>
  );
}
