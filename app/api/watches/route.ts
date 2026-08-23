import { NextRequest, NextResponse } from "next/server";
import { assertPublicHttpUrl } from "@/lib/fetchSource";
import { createPolarCheckout } from "@/lib/polar";
import { feedPaths, watchUrl } from "@/lib/watch";

function originFrom(req: NextRequest): string {
  const proto = req.headers.get("x-forwarded-proto") || "http";
  const host = req.headers.get("x-forwarded-host") || req.headers.get("host") || "localhost:3000";
  return `${proto}://${host}`;
}

/**
 * POST /api/watches  { "url": "https://..." }
 * MCP-shaped: watch(url) → { success, message, payload: { id, webcal_url, https_url, ... } }
 */
export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as { url?: string };
    if (!body?.url || typeof body.url !== "string") {
      return NextResponse.json(
        { success: false, message: "url is required", payload: {} },
        { status: 400 }
      );
    }
    assertPublicHttpUrl(body.url);
    const origin = originFrom(req);
    const { watch, urls } = await watchUrl(body.url, origin);
    return NextResponse.json({
      success: true,
      message: "Watch created",
      payload: {
        ...urls,
        source_url: watch.sourceUrl,
        title: watch.title,
        event_count: watch.events.length,
        source_hash: watch.sourceHash,
        last_fetched_at: watch.lastFetchedAt,
        last_changed_at: watch.updatedAt,
      },
    });
  } catch (err: unknown) {
    const e = err as Error & {
      status?: number;
      existing?: { id: string };
      needsPayment?: boolean;
    };
    const status = e.status || 400;
    const origin = originFrom(req);
    const payload: Record<string, unknown> =
      e.existing != null
        ? { existing_id: e.existing.id, ...feedPaths(e.existing.id, origin) }
        : {};

    if (e.needsPayment || status === 402) {
      try {
        const checkout = await createPolarCheckout();
        payload.checkout_url = checkout.checkout_url;
        if (!checkout.configured) {
          payload.checkout_message = checkout.message;
        }
      } catch (checkoutErr: unknown) {
        payload.checkout_url = null;
        payload.checkout_message =
          checkoutErr instanceof Error
            ? checkoutErr.message
            : "checkout not configured";
      }
    }

    return NextResponse.json(
      { success: false, message: e.message || "Failed to create watch", payload },
      { status }
    );
  }
}
