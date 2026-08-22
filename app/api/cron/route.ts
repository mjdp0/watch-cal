import { NextRequest, NextResponse } from "next/server";
import { refreshAllWatches } from "@/lib/watch";

/**
 * GET /api/cron — optional scheduled refresh of all watches.
 * Protect with CRON_SECRET when set (Vercel Cron sends Authorization: Bearer …).
 * Primary refresh path is still on-read at /api/feed/[id].
 */
export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = req.headers.get("authorization") || "";
    if (auth !== `Bearer ${secret}`) {
      return NextResponse.json(
        { success: false, message: "Unauthorized", payload: {} },
        { status: 401 }
      );
    }
  }

  try {
    const result = await refreshAllWatches();
    return NextResponse.json({
      success: true,
      message: "Cron refresh complete",
      payload: result,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Cron failed";
    return NextResponse.json(
      { success: false, message, payload: {} },
      { status: 500 }
    );
  }
}
