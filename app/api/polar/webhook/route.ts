import { NextRequest, NextResponse } from "next/server";
import {
  shouldGrantCreditFromEvent,
  verifyPolarWebhook,
  WebhookVerificationError,
} from "@/lib/polar";
import { grantExtraWatchCredit } from "@/lib/store";

/**
 * POST /api/polar/webhook
 * On successful pay-once checkout (order.paid / checkout.updated succeeded),
 * grant +1 extra watch credit in the JSON store.
 */
export async function POST(req: NextRequest) {
  const secret = process.env.POLAR_WEBHOOK_SECRET?.trim();
  if (!secret) {
    return NextResponse.json(
      { success: false, message: "checkout not configured", payload: {} },
      { status: 503 }
    );
  }

  const rawBody = await req.text();
  try {
    const event = verifyPolarWebhook(
      rawBody,
      {
        "webhook-id": req.headers.get("webhook-id"),
        "webhook-timestamp": req.headers.get("webhook-timestamp"),
        "webhook-signature": req.headers.get("webhook-signature"),
      },
      secret
    );

    if (shouldGrantCreditFromEvent(event.type, event.data)) {
      const eventKey =
        event.id ||
        (typeof event.data.id === "string"
          ? event.data.id
          : `${event.type}:${rawBody.slice(0, 64)}`);
      const { granted, credits } = await grantExtraWatchCredit(eventKey);
      return NextResponse.json(
        {
          success: true,
          message: granted ? "Extra watch credit granted" : "Already granted",
          payload: { credits, granted },
        },
        { status: 202 }
      );
    }

    return NextResponse.json(
      { success: true, message: "Ignored", payload: {} },
      { status: 202 }
    );
  } catch (err: unknown) {
    if (err instanceof WebhookVerificationError) {
      return NextResponse.json(
        { success: false, message: err.message, payload: {} },
        { status: 403 }
      );
    }
    throw err;
  }
}
