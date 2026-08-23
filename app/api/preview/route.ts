import { NextRequest, NextResponse } from "next/server";
import { assertPublicHttpUrl } from "@/lib/fetchSource";
import { previewUrl } from "@/lib/watch";

/**
 * POST /api/preview  { "url": "https://..." }
 * Dry-run fetch+parse — does not mint a watch or consume free quota.
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
    const preview = await previewUrl(body.url);
    return NextResponse.json({
      success: true,
      message: "Preview ok",
      payload: preview,
    });
  } catch (err: unknown) {
    const e = err as Error & { status?: number };
    const status = e.status || 400;
    return NextResponse.json(
      {
        success: false,
        message: e.message || "Failed to preview URL",
        payload: {},
      },
      { status }
    );
  }
}
