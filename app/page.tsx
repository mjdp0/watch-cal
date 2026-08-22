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

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setWatch(null);
    try {
      const res = await fetch("/api/watches", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url }),
      });
      const data = (await res.json()) as {
        success: boolean;
        message: string;
        payload: WatchPayload & { existing_id?: string };
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
        return;
      }
      setWatch(data.payload);
    } catch {
      setError("Could not create watch");
    } finally {
      setBusy(false);
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

      {watch && (
        <section className="result" aria-live="polite">
          <h2>Subscribe to this feed</h2>
          <p>
            Add the webcal link in Apple Calendar or Google Calendar. The same
            URL updates when the source page changes.
          </p>
          <div className="links">
            <div>
              <strong>webcal</strong>
              <code>{watch.webcal_url}</code>
            </div>
            <div>
              <strong>https .ics</strong>
              <code>{watch.https_url}</code>
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
        Free path: one watch, no login, not billed SaaS. Refresh happens when
        calendars poll the feed (and via optional cron). Not a paste-box demo —
        the product is the hosted poll URL.
      </p>
    </main>
  );
}
