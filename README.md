# WatchCal

Enter a **public https link** (page or PDF URL) that changes (school term list, fixture PDF, municipal notice). Get **one stable webcal / https .ics subscribe URL** that Apple Calendar and Google Calendar already poll.

WatchCal re-fetches the source and updates **the same feed**. A one-shot `.ics` download is a free extra — the product is the hosted poll URL, not a file upload or screenshot paste.

No login. Free path: **one watch**. Need another watched URL on the same instance? Buy a **pay-once Polar credit** (one credit = one extra URL) — not a subscription and not billed SaaS.

## How to subscribe

1. Open the app and enter a public `https://` page or PDF URL.
2. Copy the **webcal** link (or the https `.ics` link).
3. In Apple Calendar: File → New Calendar Subscription… and paste the webcal URL.
4. In Google Calendar: Settings → Add calendar → From URL → paste the https `.ics` URL.

Calendars poll on their own schedule. WatchCal refreshes the source when the feed is read (see below).

## Refresh policy

**Primary: on-read refresh.**  
`GET /api/feed/{id}.ics` re-fetches the source when the watch is stale (default 15 minutes, override with `WATCHCAL_REFRESH_MS`). The feed URL stays stable; the `VCALENDAR` body changes when the source changes.

**Optional cron:** `GET /api/cron` refreshes every watch currently in the cache (wired in `vercel.json` once daily — Hobby max). If `CRON_SECRET` is set, send `Authorization: Bearer <CRON_SECRET>`. Freshness does not depend on cron.

**Force refresh:** `POST /api/refresh/[id]`.

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

Watch ids are **deterministic** (`base64url` of the source URL). The JSON file under `data/watches.json` (local) or `/tmp/watchcal-watches.json` (Vercel) is only a cache: after a cold start empties `/tmp`, `GET /api/feed/{id}.ics` decodes the id, re-fetches the source, and serves `text/calendar` again — no Blob/KV.

## API (web + MCP-shaped)

Controller shape: `{ success, message, payload }`.

| Call | HTTP | Result |
|------|------|--------|
| `watch(url)` | `POST /api/watches` `{ "url": "…" }` | `payload.webcal_url`, `payload.https_url`, `payload.id` |
| `preview(url)` | `POST /api/preview` `{ "url": "…" }` | dry-run `payload.title` + `payload.event_count` (no mint, no quota) |
| `refresh(id)` | `POST /api/refresh/{id}` | updated hash + event count |
| feed | `GET /api/feed/{id}.ics` | `text/calendar` |
| Polar checkout | `POST /api/polar/checkout` | `payload.checkout_url` (or “checkout not configured”) |
| Polar webhook | `POST /api/polar/webhook` | grants +1 extra watch credit on paid checkout |

When the free watch cap is hit, `POST /api/watches` returns **402** with `payload.checkout_url` when Polar is configured.

MCP-shaped helpers are documented in `lib/watch.ts`; the browser path does not depend on MCP.

## Deploy

Normal Next.js app on Vercel Hobby (or any Node host). No Vercel GitHub App required.

```bash
npm run build && npm start
```

Optional env:

- `WATCHCAL_DATA_PATH` — JSON cache path
- `WATCHCAL_REFRESH_MS` — on-read staleness (ms)
- `CRON_SECRET` — protect `/api/cron`

**Polar pay-once extra URL** (secrets only via env — never hardcode): set `POLAR_ACCESS_TOKEN`, `POLAR_PRODUCT_ID`, `POLAR_WEBHOOK_SECRET`, and optional `POLAR_SUCCESS_URL`. Create a one-time Polar product (not a recurring plan), point a webhook at `/api/polar/webhook`, and subscribe to `order.paid` (and optionally `checkout.updated`). Checkout uses Polar’s official `POST /v1/checkouts/` session API. If those keys are missing, the pay button still appears but returns clear `checkout not configured` JSON — it never fakes a paid watch.

## License

MIT
