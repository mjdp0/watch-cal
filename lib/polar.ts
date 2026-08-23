import { createHmac, timingSafeEqual } from "crypto";

const POLAR_API_BASE = "https://api.polar.sh/v1";

export type CheckoutResult =
  | { configured: true; checkout_url: string }
  | { configured: false; checkout_url: null; message: string };

export function polarConfigured(): boolean {
  return Boolean(
    process.env.POLAR_ACCESS_TOKEN?.trim() &&
      process.env.POLAR_PRODUCT_ID?.trim()
  );
}

/**
 * Create a Polar checkout session for one pay-once extra-watch product.
 * Official API: POST /v1/checkouts/ (not checkout.sessions).
 * https://polar.sh/docs/guides/create-checkout-session
 */
export async function createPolarCheckout(
  opts: { successUrl?: string; fetcher?: typeof fetch } = {}
): Promise<CheckoutResult> {
  const token = process.env.POLAR_ACCESS_TOKEN?.trim();
  const productId = process.env.POLAR_PRODUCT_ID?.trim();
  if (!token || !productId) {
    return {
      configured: false,
      checkout_url: null,
      message: "checkout not configured",
    };
  }

  const successUrl =
    opts.successUrl?.trim() || process.env.POLAR_SUCCESS_URL?.trim() || undefined;
  const body: { products: string[]; success_url?: string } = {
    products: [productId],
  };
  if (successUrl) body.success_url = successUrl;

  const fetcher = opts.fetcher ?? fetch;
  const res = await fetcher(`${POLAR_API_BASE}/checkouts/`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `Polar checkout failed (${res.status})${text ? `: ${text.slice(0, 200)}` : ""}`
    );
  }

  const data = (await res.json()) as { url?: string };
  if (!data.url || typeof data.url !== "string") {
    throw new Error("Polar checkout response missing url");
  }
  return { configured: true, checkout_url: data.url };
}

export class WebhookVerificationError extends Error {
  constructor(message = "Invalid webhook signature") {
    super(message);
    this.name = "WebhookVerificationError";
  }
}

/**
 * Verify Polar webhook (Standard Webhooks).
 * HMAC key = UTF-8 bytes of the configured secret.
 */
export function verifyPolarWebhook(
  rawBody: string | Buffer,
  headers: {
    "webhook-id"?: string | null;
    "webhook-timestamp"?: string | null;
    "webhook-signature"?: string | null;
  },
  secret: string
): { type: string; data: Record<string, unknown>; id?: string } {
  const id = headers["webhook-id"];
  const timestamp = headers["webhook-timestamp"];
  const signatureHeader = headers["webhook-signature"];
  if (!id || !timestamp || !signatureHeader) {
    throw new WebhookVerificationError("Missing webhook headers");
  }

  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(Date.now() / 1000 - ts) > 60 * 5) {
    throw new WebhookVerificationError("Webhook timestamp out of range");
  }

  const bodyStr = typeof rawBody === "string" ? rawBody : rawBody.toString("utf8");
  const signedContent = `${id}.${timestamp}.${bodyStr}`;
  const key = Buffer.from(Buffer.from(secret, "utf8").toString("base64"), "base64");
  const expected = createHmac("sha256", key).update(signedContent).digest();

  const candidates = signatureHeader.split(" ").flatMap((part) => {
    const [, sig] = part.split(",", 2);
    return sig ? [sig] : [];
  });

  let ok = false;
  for (const sig of candidates) {
    try {
      const got = Buffer.from(sig, "base64");
      if (got.length === expected.length && timingSafeEqual(got, expected)) {
        ok = true;
        break;
      }
    } catch {
      // ignore bad base64
    }
  }
  if (!ok) throw new WebhookVerificationError();

  const parsed = JSON.parse(bodyStr) as {
    type?: string;
    data?: Record<string, unknown>;
  };
  if (!parsed?.type || typeof parsed.type !== "string") {
    throw new WebhookVerificationError("Invalid webhook payload");
  }
  return {
    type: parsed.type,
    data: (parsed.data as Record<string, unknown>) || {},
    id,
  };
}

/** Whether this Polar event should grant +1 extra watch credit. */
export function shouldGrantCreditFromEvent(
  type: string,
  data: Record<string, unknown>
): boolean {
  if (type === "order.paid") return true;
  if (type === "checkout.updated" && data.status === "succeeded") return true;
  return false;
}
