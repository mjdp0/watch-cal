import { NextRequest, NextResponse } from "next/server";
import { getFeedIcs } from "@/lib/watch";

type Ctx = { params: Promise<{ id: string }> };

/**
 * GET /api/feed/[id] or /api/feed/[id].ics
 * On-read refresh: re-fetches the source when the watch is stale, then returns text/calendar.
 */
export async function GET(req: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params;
  try {
    const ics = await getFeedIcs(id);
    const download = req.nextUrl.searchParams.get("download") === "1";
    const headers: Record<string, string> = {
      "Content-Type": "text/calendar; charset=utf-8",
      "Cache-Control": "no-store",
    };
    if (download) {
      headers["Content-Disposition"] = `attachment; filename="watchcal-${id.replace(/\.ics$/i, "")}.ics"`;
    } else {
      headers["Content-Disposition"] = `inline; filename="watchcal-${id.replace(/\.ics$/i, "")}.ics"`;
    }
    return new NextResponse(ics, { status: 200, headers });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Not found";
    const status = message === "Watch not found" ? 404 : 500;
    return NextResponse.json(
      { success: false, message, payload: {} },
      { status }
    );
  }
}
