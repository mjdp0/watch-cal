"use client";

import { FormEvent, useEffect, useState } from "react";

type WatchPayload = {
  id: string;
  title: string;
  event_count: number;
  https_url: string;
  webcal_url: string;
  download_url: string;
  source_url: string;
};

/** Browser-only last-watch key — not a shareable product URL. */
const LAST_WATCH_KEY = "watchcal:lastWatch";

/** Live Western Cape feed id only — do not invent other feed ids. */
const WESTERN_CAPE_FEED_ID =
  "aHR0cHM6Ly93d3cud2VzdGVybmNhcGUuZ292LnphL2VkdWNhdGlvbi9zY2hvb2wtY2FsZW5kYXI";

const EXAMPLES: {
  label: string;
  url: string;
  feedId?: string;
}[] = [
  {
    label: "School terms (Western Cape)",
    url: "https://www.westerncape.gov.za/education/school-calendar",
    feedId: WESTERN_CAPE_FEED_ID,
  },
  {
    label: "School calendar (St Stithians)",
    url: "https://www.stithian.com/uploads/files/St_Stithians_College_Calendar_2026_-_Approved_March_2025.pdf",
  },
  {
    label: "NSC exams 2026",
    url: "https://www.education.gov.za/LinkClick.aspx?fileticket=312B9JSmyzQ%3D&mid=4149&portalid=0&tabid=338",
  },
];

type LastWatchStored = {
  id: string;
  title: string;
  event_count: number;
  source_url: string;
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
  };
  localStorage.setItem(LAST_WATCH_KEY, JSON.stringify(stored));
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
        setError(data.message);
        if (res.status === 402 || res.status === 403) {
          setNeedsExtraWatch(true);
          if (data.payload?.checkout_message) {
            setCheckoutHint(data.payload.checkout_message);
          }
        }
        return;
      }
      rememberWatch(data.payload);
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

  function useExample(example: (typeof EXAMPLES)[number]) {
    setUrl(example.url);
    // First/free example may create a watch. Extra examples only fill the
    // field — auto-POST would 402 and look like a failed parse.
    if (example.feedId) {
      void createWatch(example.url);
      return;
    }
    setWatch(null);
    setError(null);
    setNeedsExtraWatch(false);
    setCheckoutHint(null);
    setCopied(null);
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
        Enter a public https link (page or PDF URL) that changes. Get one
        stable calendar subscribe URL that Apple and Google already know how
        to poll.
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
            disabled={busy}
          />
          <button type="submit" disabled={busy}>
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
                  disabled={busy}
                  onClick={() => useExample(example)}
                >
                  {example.label}
                </button>
                {feedLinks && (
                  <p className="example-feed">
                    Already live:{" "}
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

      {needsExtraWatch && (
        <div className="pay-once">
          <p>
            One free watch is already on this instance. Pay once for one extra
            watched URL — not a recurring plan.
          </p>
          <button
            type="button"
            onClick={startExtraWatchCheckout}
            disabled={checkoutBusy}
          >
            {checkoutBusy ? "Opening checkout…" : "Pay once for one extra watch"}
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
            {watch.event_count === 1 ? "" : "s"} · id {watch.id}
          </p>
        </section>
      )}

      <p className="note">
        First watch is free. Extra watches are pay-once Polar ($5), one credit
        per URL — not billed SaaS.
      </p>
    </main>
  );
}
