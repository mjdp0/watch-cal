import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import {
  createPolarCheckout,
  shouldGrantCreditFromEvent,
  verifyPolarWebhook,
  WebhookVerificationError,
} from "./polar";
import {
  FREE_WATCH_LIMIT,
  getExtraWatchCredits,
  grantExtraWatchCredit,
} from "./store";
import { watchUrl } from "./watch";

describe("polar pay-once credits", { concurrency: false }, () => {
  let dataPath = "";
  let sourceBody = "";

  const fetcher: typeof fetch = async () =>
    new Response(sourceBody, {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8" },
    });

  before(async () => {
    dataPath = path.join(
      await mkdtemp(path.join(tmpdir(), "watchcal-polar-")),
      "watches.json"
    );
  });

  after(async () => {
    await rm(path.dirname(dataPath), { recursive: true, force: true });
  });

  it("allows the free first watch", async () => {
    sourceBody =
      "<html><title>First</title><body><p>Day 10 April 2026</p></body></html>";
    const { watch } = await watchUrl(
      "https://example.com/first",
      "https://watchcal.example",
      {
        dataPath,
        fetcher,
        now: new Date("2026-01-05T00:00:00Z"),
      }
    );
    assert.equal(FREE_WATCH_LIMIT, 1);
    assert.ok(watch.id);
    assert.equal(await getExtraWatchCredits(dataPath), 0);
  });

  it("blocks a second watch without credit", async () => {
    sourceBody =
      "<html><title>Second</title><body><p>Day 11 May 2026</p></body></html>";
    let threw = false;
    try {
      await watchUrl("https://example.com/second", "https://watchcal.example", {
        dataPath,
        fetcher,
      });
    } catch (err: unknown) {
      threw = true;
      const e = err as Error & { status?: number; needsPayment?: boolean };
      assert.equal(e.status, 402);
      assert.equal(e.needsPayment, true);
    }
    assert.equal(threw, true);
  });

  it("webhook grant adds a credit and unlocks another watch", async () => {
    const { granted, credits } = await grantExtraWatchCredit(
      "evt_order_paid_1",
      dataPath
    );
    assert.equal(granted, true);
    assert.equal(credits, 1);
    assert.equal(await getExtraWatchCredits(dataPath), 1);

    const again = await grantExtraWatchCredit("evt_order_paid_1", dataPath);
    assert.equal(again.granted, false);
    assert.equal(again.credits, 1);

    sourceBody =
      "<html><title>Second</title><body><p>Day 11 May 2026</p></body></html>";
    const { watch } = await watchUrl(
      "https://example.com/second",
      "https://watchcal.example",
      {
        dataPath,
        fetcher,
        now: new Date("2026-01-06T00:00:00Z"),
      }
    );
    assert.ok(watch.id);
  });

  it("rejects parallel second watches without a credit (no TOCTOU 200s)", async () => {
    const racePath = path.join(
      await mkdtemp(path.join(tmpdir(), "watchcal-race-")),
      "watches.json"
    );
    sourceBody =
      "<html><title>Race</title><body><p>Day 12 June 2026</p></body></html>";
    const urls = [
      "https://example.com/race-a",
      "https://example.com/race-b",
      "https://example.com/race-c",
      "https://example.com/race-d",
    ];
    const results = await Promise.all(
      urls.map(async (url) => {
        try {
          const { watch } = await watchUrl(url, "https://watchcal.example", {
            dataPath: racePath,
            fetcher,
            now: new Date("2026-01-07T00:00:00Z"),
          });
          return { ok: true as const, id: watch.id };
        } catch (err: unknown) {
          const e = err as Error & { status?: number; needsPayment?: boolean };
          return {
            ok: false as const,
            status: e.status,
            needsPayment: e.needsPayment,
          };
        }
      })
    );
    const created = results.filter((r) => r.ok);
    const blocked = results.filter((r) => !r.ok);
    assert.equal(created.length, 1, "only the free slot may succeed");
    assert.equal(blocked.length, urls.length - 1);
    for (const b of blocked) {
      assert.equal(b.status, 402);
      assert.equal(b.needsPayment, true);
    }
    await rm(path.dirname(racePath), { recursive: true, force: true });
  });
});

describe("polar checkout + webhook helpers", () => {
  it("returns checkout not configured when env keys are missing", async () => {
    const prevToken = process.env.POLAR_ACCESS_TOKEN;
    const prevProduct = process.env.POLAR_PRODUCT_ID;
    delete process.env.POLAR_ACCESS_TOKEN;
    delete process.env.POLAR_PRODUCT_ID;
    try {
      const result = await createPolarCheckout();
      assert.equal(result.configured, false);
      assert.equal(result.checkout_url, null);
      if (!result.configured) {
        assert.match(result.message, /checkout not configured/i);
      }
    } finally {
      if (prevToken !== undefined) process.env.POLAR_ACCESS_TOKEN = prevToken;
      else delete process.env.POLAR_ACCESS_TOKEN;
      if (prevProduct !== undefined) process.env.POLAR_PRODUCT_ID = prevProduct;
      else delete process.env.POLAR_PRODUCT_ID;
    }
  });

  it("creates checkout via POST /v1/checkouts/", async () => {
    process.env.POLAR_ACCESS_TOKEN = "test_token";
    process.env.POLAR_PRODUCT_ID = "prod_123";
    process.env.POLAR_SUCCESS_URL = "https://watchcal.example/";
    try {
      let calledUrl = "";
      let calledBody: unknown = null;
      const fakeFetch: typeof fetch = async (input, init) => {
        calledUrl = String(input);
        calledBody = JSON.parse(String(init?.body || "{}"));
        return new Response(
          JSON.stringify({ url: "https://buy.polar.sh/polar_c_test" }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      };
      const result = await createPolarCheckout({ fetcher: fakeFetch });
      assert.equal(result.configured, true);
      assert.equal(result.checkout_url, "https://buy.polar.sh/polar_c_test");
      assert.match(calledUrl, /\/v1\/checkouts\/?$/);
      assert.deepEqual(calledBody, {
        products: ["prod_123"],
        success_url: "https://watchcal.example/",
      });
    } finally {
      delete process.env.POLAR_ACCESS_TOKEN;
      delete process.env.POLAR_PRODUCT_ID;
      delete process.env.POLAR_SUCCESS_URL;
    }
  });

  it("verifies signed webhooks and grants on order.paid", () => {
    const secret = "polar_whs_test_secret";
    const body = JSON.stringify({
      type: "order.paid",
      data: { id: "order_1", status: "paid" },
    });
    const webhookId = "msg_1";
    const timestamp = String(Math.floor(Date.now() / 1000));
    const key = Buffer.from(
      Buffer.from(secret, "utf8").toString("base64"),
      "base64"
    );
    const sig = createHmac("sha256", key)
      .update(`${webhookId}.${timestamp}.${body}`)
      .digest("base64");

    const event = verifyPolarWebhook(
      body,
      {
        "webhook-id": webhookId,
        "webhook-timestamp": timestamp,
        "webhook-signature": `v1,${sig}`,
      },
      secret
    );
    assert.equal(event.type, "order.paid");
    assert.equal(shouldGrantCreditFromEvent(event.type, event.data), true);
    assert.equal(
      shouldGrantCreditFromEvent("checkout.updated", { status: "succeeded" }),
      true
    );
    assert.equal(
      shouldGrantCreditFromEvent("checkout.updated", { status: "open" }),
      false
    );

    assert.throws(
      () =>
        verifyPolarWebhook(
          body,
          {
            "webhook-id": webhookId,
            "webhook-timestamp": timestamp,
            "webhook-signature":
              "v1,AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
          },
          secret
        ),
      WebhookVerificationError
    );
  });
});

describe("UI copy is pay-once not monthly", () => {
  it("landing page avoids monthly/subscription language", async () => {
    const page = await readFile(
      path.join(process.cwd(), "app/page.tsx"),
      "utf8"
    );
    assert.match(page, /Pay once for one extra watch/i);
    assert.match(page, /pay once|Pay once/i);
    assert.doesNotMatch(page, /\bmonthly\b/i);
    assert.doesNotMatch(page, /\bsubscription\b/i);
    assert.doesNotMatch(page, /\bSaaS plan\b/i);
  });
});
