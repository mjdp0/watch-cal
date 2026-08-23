import { NextResponse } from "next/server";
import { createPolarCheckout } from "@/lib/polar";

/**
 * POST /api/polar/checkout
 * Creates a pay-once Polar checkout for one extra watched URL.
 * If Polar env keys are missing, returns clear "checkout not configured" JSON.
 */
export async function POST() {
  try {
    const result = await createPolarCheckout();
    if (!result.configured) {
      return NextResponse.json(
        {
          success: false,
          message: result.message,
          payload: { checkout_url: null },
        },
        { status: 503 }
      );
    }
    return NextResponse.json({
      success: true,
      message: "Checkout ready",
      payload: { checkout_url: result.checkout_url },
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Checkout failed";
    return NextResponse.json(
      { success: false, message, payload: { checkout_url: null } },
      { status: 502 }
    );
  }
}
