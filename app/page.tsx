"use client";

import { FormEvent, useState } from "react";

type WatchPayload = {
  id: string;
  title: string;
  event_count: number;
  https_url: string;
  webcal_url: string;
  download_url: string;
  source_url: string;
};

export default function HomePage() {
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [watch, setWatch] = useState<WatchPayload | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [needsExtraWatch, setNeedsExtraWatch] = useState(false);
  const [checkoutBusy, setCheckoutBusy] = useState(false);
  const [checkoutHint, setCheckoutHint] = useState<string | null>(null);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
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
        body: JSON.stringify({ url }),
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
        if (data.payload?.https_url) {
          setWatch({
            id: data.payload.existing_id || data.payload.id,
            title: "Existing watch",
            event_count: 0,
            https_url: data.payload.https_url,
            webcal_url: data.payload.webcal_url,
            download_url: data.payload.download_url,
            source_url: url,
          });
        }
        setError(data.message);
        if (res.status === 402 || res.status === 403) {
          setNeedsExtraWatch(true);
          if (data.payload?.checkout_message) {
            setCheckoutHint(data.payload.checkout_message);
          }
        }
        return;
      }
      setWatch(data.payload);
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
        Paste a public page or PDF that changes. Get one stable calendar
        subscribe URL that Apple and Google already know how to poll.
      </p>

      <form className="form" onSubmit={onSubmit}>
        <label htmlFor="source">Public URL</label>
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
        Free path: <strong>1 free watch</strong>, no login. Extra watched URLs
        are pay-once Polar credits (one credit = one extra URL), not billed
        SaaS. Refresh happens when calendars poll the feed (and via optional
        daily cron). Not a paste-box demo — the product is the hosted poll URL.
      </p>
    </main>
  );
}
