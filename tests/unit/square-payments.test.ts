import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  BillMismatchError,
  buildSquarePaymentLink,
  requestTotalMinorUnits,
  type BillLine,
  type SquareCheckoutInput,
} from "@/lib/pos/square/checkout-core";
import {
  completedPaymentFrom,
  verifySquareSignature,
} from "@/lib/pos/square/webhook-core";
import { squareWebhookReady } from "@/lib/pos/square/oauth-core";

const line = (over: Partial<BillLine> = {}): BillLine => ({
  order_id: "o1",
  item_name: "Chicken Biryani",
  options: null,
  quantity: 1,
  unit_amount: "16.00",
  line_total: "16.00",
  order_total: "17.42",
  ...over,
});

const input = (
  over: Partial<SquareCheckoutInput> = {},
): SquareCheckoutInput => ({
  paymentId: "11111111-2222-4333-8444-555555555555",
  locationId: "LOC1",
  currency: "usd",
  amount: "17.42",
  tipAmount: "0.00",
  lines: [line()],
  appFeeMinorUnits: 17,
  redirectUrl: "https://tableside.menu/r/demo/orders?paid=1",
  note: "Tableside: Demo",
  ...over,
});

describe("Square checkout request", () => {
  it("itemises dishes, puts tax in one line, and totals exactly", () => {
    const req = buildSquarePaymentLink(input());
    expect(req.order.line_items).toEqual([
      {
        name: "Chicken Biryani",
        quantity: "1",
        base_price_money: { amount: 1600, currency: "USD" },
      },
      {
        name: "Tax & charges",
        quantity: "1",
        base_price_money: { amount: 142, currency: "USD" },
      },
    ]);
    expect(requestTotalMinorUnits(req)).toBe(1742);
    expect(req.order.reference_id).toBe("11111111-2222-4333-8444-555555555555");
    expect(req.idempotency_key).toBe(
      "tableside-11111111-2222-4333-8444-555555555555",
    );
  });

  it("names options, multiplies quantities and covers several orders of a tab", () => {
    const req = buildSquarePaymentLink(
      input({
        amount: "33.00",
        lines: [
          line({
            options: "Family",
            unit_amount: "25.00",
            line_total: "25.00",
            order_total: "25.00",
          }),
          line({
            order_id: "o2",
            item_name: "Mango Lassi",
            quantity: 2,
            unit_amount: "4.00",
            line_total: "8.00",
            order_total: "8.00",
          }),
        ],
      }),
    );
    expect(
      req.order.line_items.map((l) => [
        l.name,
        l.quantity,
        l.base_price_money.amount,
      ]),
    ).toEqual([
      ["Chicken Biryani (Family)", "1", 2500],
      ["Mango Lassi", "2", 400],
    ]);
    expect(requestTotalMinorUnits(req)).toBe(3300);
  });

  it("adds the tip as a service charge, keeps the fee off it, and never lets Square ask again", () => {
    const req = buildSquarePaymentLink(input({ tipAmount: "3.00" }));
    expect(req.order.service_charges).toEqual([
      {
        name: "Tip",
        amount_money: { amount: 300, currency: "USD" },
        calculation_phase: "TOTAL_PHASE",
      },
    ]);
    expect(requestTotalMinorUnits(req)).toBe(2042);
    expect(req.checkout_options.app_fee_money).toEqual({
      amount: 17,
      currency: "USD",
    });
    expect(req.checkout_options.allow_tipping).toBe(false);
  });

  it("leaves the fee out entirely during the free month", () => {
    expect(
      buildSquarePaymentLink(input({ appFeeMinorUnits: 0 })).checkout_options
        .app_fee_money,
    ).toBeUndefined();
  });

  it("turns a bill below the dishes' prices into a discount", () => {
    const req = buildSquarePaymentLink(
      input({ amount: "15.00", lines: [line({ order_total: "15.00" })] }),
    );
    expect(req.order.discounts?.[0]).toMatchObject({
      amount_money: { amount: 100, currency: "USD" },
      scope: "ORDER",
    });
    expect(requestTotalMinorUnits(req)).toBe(1500);
  });

  it("refuses a bill whose orders don't add up to the payment", () => {
    expect(() => buildSquarePaymentLink(input({ amount: "20.00" }))).toThrow(
      BillMismatchError,
    );
    expect(() => buildSquarePaymentLink(input({ lines: [] }))).toThrow(
      BillMismatchError,
    );
    expect(() =>
      buildSquarePaymentLink(input({ appFeeMinorUnits: 999999 })),
    ).toThrow(BillMismatchError);
  });
});

describe("Square webhook", () => {
  const key = "test-signature-key";
  const url = "https://tableside.menu/api/webhooks/square";
  const body = JSON.stringify({ type: "payment.updated" });
  const sign = (b: string, u = url, k = key) =>
    createHmac("sha256", k)
      .update(u + b)
      .digest("base64");

  it("accepts Square's signature and nothing else", () => {
    expect(
      verifySquareSignature({
        body,
        signature: sign(body),
        signatureKey: key,
        notificationUrl: url,
      }),
    ).toBe(true);
    expect(
      verifySquareSignature({
        body: body + " ",
        signature: sign(body),
        signatureKey: key,
        notificationUrl: url,
      }),
    ).toBe(false);
    // Signed for a different URL (e.g. the other domain): rejected.
    expect(
      verifySquareSignature({
        body,
        signature: sign(body, "https://evil.example/hook"),
        signatureKey: key,
        notificationUrl: url,
      }),
    ).toBe(false);
    expect(
      verifySquareSignature({
        body,
        signature: sign(body, url, "other"),
        signatureKey: key,
        notificationUrl: url,
      }),
    ).toBe(false);
    expect(
      verifySquareSignature({
        body,
        signature: null,
        signatureKey: key,
        notificationUrl: url,
      }),
    ).toBe(false);
  });

  const event = (status: string, type = "payment.updated") => ({
    type,
    data: {
      object: {
        payment: {
          id: "PAY1",
          order_id: "SQORDER1",
          status,
          total_money: { amount: 2042, currency: "USD" },
        },
      },
    },
  });

  it("acts only on completed payments that belong to an order", () => {
    expect(completedPaymentFrom(event("COMPLETED"))).toEqual({
      paymentId: "PAY1",
      orderId: "SQORDER1",
      totalMinorUnits: 2042,
      currency: "USD",
    });
    expect(
      completedPaymentFrom(event("COMPLETED", "payment.created"))?.orderId,
    ).toBe("SQORDER1");
    expect(completedPaymentFrom(event("APPROVED"))).toBeNull();
    expect(completedPaymentFrom(event("FAILED"))).toBeNull();
    expect(
      completedPaymentFrom(event("COMPLETED", "refund.updated")),
    ).toBeNull();
    expect(
      completedPaymentFrom({ type: "payment.updated", data: {} }),
    ).toBeNull();
  });

  it("is only ready with both the signature key and the URL", () => {
    expect(
      squareWebhookReady({
        SQUARE_WEBHOOK_SIGNATURE_KEY: "k",
        SQUARE_WEBHOOK_URL: url,
      }),
    ).toBe(true);
    expect(squareWebhookReady({ SQUARE_WEBHOOK_SIGNATURE_KEY: "k" })).toBe(
      false,
    );
  });
});
