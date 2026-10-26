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

  it("shows a manager's discount as a discount, with the tax kept on its own line", () => {
    // $16 dish, $3 off, 10% tax on the $13 left: 13 + 1.30 = 14.30.
    const req = buildSquarePaymentLink(
      input({
        amount: "14.30",
        appFeeMinorUnits: 14,
        lines: [line({ order_total: "14.30", order_discount: "3.00" })],
      }),
    );
    expect(req.order.line_items.at(-1)).toEqual({
      name: "Tax & charges",
      quantity: "1",
      base_price_money: { amount: 130, currency: "USD" },
    });
    expect(req.order.discounts?.[0]).toMatchObject({
      amount_money: { amount: 300, currency: "USD" },
    });
    expect(requestTotalMinorUnits(req)).toBe(1430);
  });

  it("lists a comped dish at no charge", () => {
    const req = buildSquarePaymentLink(
      input({
        lines: [
          line(),
          line({
            item_name: "Mango Lassi (comped)",
            unit_amount: "0.00",
            line_total: "0.00",
          }),
        ],
      }),
    );
    expect(req.order.line_items[1]).toMatchObject({
      name: "Mango Lassi (comped)",
      base_price_money: { amount: 0, currency: "USD" },
    });
    expect(requestTotalMinorUnits(req)).toBe(1742);
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
      tipMinorUnits: 0,
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

describe("Square Terminal and cash (phase 3)", () => {
  const lines = [
    {
      order_id: "o1",
      item_name: "Mango Lassi",
      options: null,
      quantity: 2,
      unit_amount: "5.00",
      line_total: "10.00",
      order_total: "10.89",
    },
  ];

  it("sends an itemised order to the Terminal for exactly the bill, tip left to the device", async () => {
    const { buildTerminalRequests, orderTotalMinorUnits } =
      await import("@/lib/pos/square/checkout-core");
    const r = buildTerminalRequests({
      paymentId: "p1",
      locationId: "LOC1",
      currency: "usd",
      amount: "10.89",
      lines,
      deviceId: "DEV1",
      tippingEnabled: true,
      appFeeMinorUnits: 11,
      note: "Tableside: Demo",
    });
    expect(r.createOrder.order.service_charges).toBeUndefined();
    expect(orderTotalMinorUnits(r.createOrder.order)).toBe(1089);
    const c = r.checkout("SQORDER").checkout;
    expect(c.amount_money).toEqual({ amount: 1089, currency: "USD" });
    expect(c.order_id).toBe("SQORDER");
    expect(c.app_fee_money).toEqual({ amount: 11, currency: "USD" });
    expect(c.device_options).toEqual({
      device_id: "DEV1",
      show_itemized_cart: true,
      skip_receipt_screen: false,
      tip_settings: { allow_tipping: true },
    });
    expect(r.checkout("SQORDER").idempotency_key).toBe("terminal-p1");
  });

  it("turns Terminal tipping off when the restaurant doesn't take tips", async () => {
    const { buildTerminalRequests } =
      await import("@/lib/pos/square/checkout-core");
    const r = buildTerminalRequests({
      paymentId: "p1",
      locationId: "LOC1",
      currency: "USD",
      amount: "10.89",
      lines,
      deviceId: "DEV1",
      tippingEnabled: false,
      appFeeMinorUnits: 0,
      note: "n",
    });
    const c = r.checkout("O").checkout;
    expect(c.device_options.tip_settings.allow_tipping).toBe(false);
    expect(c.app_fee_money).toBeUndefined();
  });

  it("records cash as a CASH payment for the order total including the tip", async () => {
    const { buildCashSaleRequests } =
      await import("@/lib/pos/square/checkout-core");
    const r = buildCashSaleRequests({
      paymentId: "p2",
      locationId: "LOC1",
      currency: "USD",
      amount: "10.89",
      tipAmount: "2.00",
      lines,
    });
    expect(r.createOrder.order.service_charges?.[0].amount_money.amount).toBe(
      200,
    );
    const p = r.payment("SQORDER");
    expect(p.source_id).toBe("CASH");
    expect(p.amount_money).toEqual({ amount: 1289, currency: "USD" });
    expect(p.cash_details.buyer_supplied_money).toEqual({
      amount: 1289,
      currency: "USD",
    });
    expect(p.idempotency_key).toBe("cash-p2");
  });

  it("reads a Terminal tip off Square's payment, and treats a missing one as none", () => {
    const withTip = completedPaymentFrom({
      type: "payment.updated",
      data: {
        object: {
          payment: {
            id: "P",
            order_id: "O",
            status: "COMPLETED",
            total_money: { amount: 1307, currency: "USD" },
            tip_money: { amount: 218, currency: "USD" },
          },
        },
      },
    });
    expect(withTip?.tipMinorUnits).toBe(218);
    expect(
      completedPaymentFrom({
        type: "payment.updated",
        data: {
          object: {
            payment: {
              id: "P",
              order_id: "O",
              status: "COMPLETED",
              total_money: { amount: 5, currency: "USD" },
            },
          },
        },
      })?.tipMinorUnits,
    ).toBe(0);
  });

  it("knows which connections can pair a Terminal", async () => {
    const { canPairTerminals, SQUARE_SCOPES, SQUARE_TEST_TERMINALS } =
      await import("@/lib/pos/square/oauth-core");
    expect(canPairTerminals(SQUARE_SCOPES.join(" "))).toBe(true);
    expect(canPairTerminals("ITEMS_READ ORDERS_WRITE")).toBe(false);
    expect(canPairTerminals(null)).toBe(false);
    expect(SQUARE_TEST_TERMINALS.map((t) => t.deviceId)).toContain(
      "22cd266c-6246-4c06-9983-67f0c26346b0",
    );
  });
});

describe("Square idempotency key limits", () => {
  // Found live: a 51-character key made Square reject every cash copy
  // ("VALUE_TOO_LONG: Field must not be greater than 45 length").
  const uuid = "0e7b26e0-4629-4504-8cf0-c77b8a8fe3e2";
  const lines = [
    {
      order_id: "o1",
      item_name: "Samosa (2)",
      options: null,
      quantity: 1,
      unit_amount: "6.50",
      line_total: "6.50",
      order_total: "6.50",
    },
  ];

  it("keeps every key within Square's limit for its endpoint", async () => {
    const {
      buildCashSaleRequests,
      buildTerminalRequests,
      buildSquarePaymentLink,
    } = await import("@/lib/pos/square/checkout-core");
    const cash = buildCashSaleRequests({
      paymentId: uuid,
      locationId: "L",
      currency: "USD",
      amount: "6.50",
      tipAmount: "0",
      lines,
    });
    expect(cash.payment("O").idempotency_key.length).toBeLessThanOrEqual(45); // CreatePayment
    expect(cash.createOrder.idempotency_key.length).toBeLessThanOrEqual(192); // CreateOrder
    const terminal = buildTerminalRequests({
      paymentId: uuid,
      locationId: "L",
      currency: "USD",
      amount: "6.50",
      lines,
      deviceId: "D",
      tippingEnabled: true,
      appFeeMinorUnits: 0,
      note: "n",
    });
    expect(terminal.checkout("O").idempotency_key.length).toBeLessThanOrEqual(
      64,
    ); // CreateTerminalCheckout
    expect(terminal.createOrder.idempotency_key.length).toBeLessThanOrEqual(
      192,
    );
    const link = buildSquarePaymentLink({
      paymentId: uuid,
      locationId: "L",
      currency: "USD",
      amount: "6.50",
      tipAmount: "0",
      lines,
      appFeeMinorUnits: 0,
      redirectUrl: "https://x",
      note: "n",
    });
    expect(link.idempotency_key.length).toBeLessThanOrEqual(192); // CreatePaymentLink
    // reference_id is capped at 40 on orders and payments.
    expect(cash.payment("O").reference_id.length).toBeLessThanOrEqual(40);
  });
});
