import { NextRequest, NextResponse } from "next/server";
import { feedPaths, refreshWatch } from "@/lib/watch";

type Ctx = { params: Promise<{ id: string }> };

function originFrom(req: NextRequest): string {
  const proto = req.headers.get("x-forwarded-proto") || "http";
  const host = req.headers.get("x-forwarded-host") || req.headers.get("host") || "localhost:3000";
  return `${proto}://${host}`;
}

/**
 * POST /api/refresh/[id]
 * MCP-shaped: refresh(id) → updated watch metadata + feed URLs.
 */
export async function POST(req: NextRequest, ctx: Ctx) {
  const { id: raw } = await ctx.params;
  const id = raw.replace(/\.ics$/i, "");
  try {
    const watch = await refreshWatch(id, { force: true });
    const urls = feedPaths(watch.id, originFrom(req));
    return NextResponse.json({
      success: true,
      message: "Watch refreshed",
      payload: {
        ...urls,
        updated: true,
        event_count: watch.events.length,
        source_hash: watch.sourceHash,
        title: watch.title,
      },
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Refresh failed";
    const status = message === "Watch not found" ? 404 : 500;
    return NextResponse.json(
      { success: false, message, payload: {} },
      { status }
    );
  }
}
