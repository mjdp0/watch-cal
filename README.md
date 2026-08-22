# WatchCal

Paste a **public page or PDF URL** that changes (school term list, fixture PDF, municipal notice). Get **one stable webcal / https .ics subscribe URL** that Apple Calendar and Google Calendar already poll.

WatchCal re-fetches the source and updates **the same feed**. A one-shot `.ics` download is a free extra — the product is the hosted poll URL, not a paste box.

No login. Free path: **one watch**. This is **not billed SaaS** (no Polar / Stripe / Lemon in this repo).

## How to subscribe

1. Open the app and paste a public `https://` URL.
2. Copy the **webcal** link (or the https `.ics` link).
3. In Apple Calendar: File → New Calendar Subscription… and paste the webcal URL.
4. In Google Calendar: Settings → Add calendar → From URL → paste the https `.ics` URL.

Calendars poll on their own schedule. WatchCal refreshes the source when the feed is read (see below).

## Refresh policy

**Primary: on-read refresh.**  
`GET /api/feed/{id}.ics` re-fetches the source when the watch is stale (default 15 minutes, override with `WATCHCAL_REFRESH_MS`). The feed URL stays stable; the `VCALENDAR` body changes when the source changes.

**Optional cron:** `GET /api/cron` refreshes every watch (wired in `vercel.json` hourly). If `CRON_SECRET` is set, send `Authorization: Bearer <CRON_SECRET>`.

**Force refresh:** `POST /api/refresh/{id}`.

## Run locally

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

```bash
npm test
npm run build
```

Watches persist to `data/watches.json` locally (gitignored). On Vercel, the store uses `/tmp/watchcal-watches.json` unless you set `WATCHCAL_DATA_PATH` to a durable location.

## API (web + MCP-shaped)

Controller shape: `{ success, message, payload }`.

| Call | HTTP | Result |
|------|------|--------|
| `watch(url)` | `POST /api/watches` `{ "url": "…" }` | `payload.webcal_url`, `payload.https_url`, `payload.id` |
| `refresh(id)` | `POST /api/refresh/{id}` | updated hash + event count |
| feed | `GET /api/feed/{id}.ics` | `text/calendar` |

MCP-shaped helpers are documented in `lib/watch.ts`; the browser path does not depend on MCP.

## Deploy

Normal Next.js app on Vercel Hobby (or any Node host). No Vercel GitHub App required.

```bash
npm run build && npm start
```

Optional env:

- `WATCHCAL_DATA_PATH` — JSON store path
- `WATCHCAL_REFRESH_MS` — on-read staleness (ms)
- `CRON_SECRET` — protect `/api/cron`

## License

MIT
