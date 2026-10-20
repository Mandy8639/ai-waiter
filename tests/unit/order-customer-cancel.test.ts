import { describe, expect, it } from "vitest";
import {
  canCustomerCancel,
  customerCancelMessage,
} from "@/lib/orders/customer-cancel-core";
import {
  checkCancelConfirmation,
  parsePendingCancellation,
} from "@/lib/ai/tools/cancel-confirmation";

/**
 * Diners cancel or change their own order before the kitchen accepts it
 * (2026-10-20). The rules live in customer_cancel_order(); these are the
 * words, and the waiter's confirm-first gate.
 */
describe("customer cancel messages", () => {
  it("explains each refusal in the diner's terms", () => {
    expect(customerCancelMessage("ORDER_CANCEL_TOO_LATE: ...")).toMatch(
      /kitchen has already accepted/,
    );
    expect(customerCancelMessage("ORDER_CANCEL_PAID: ...")).toMatch(/refund/);
    expect(customerCancelMessage("ORDER_IN_SPLIT: ...")).toMatch(/split/);
    expect(customerCancelMessage("ORDER_CANCEL_ALREADY")).toMatch(
      /already cancelled/,
    );
    expect(customerCancelMessage("something odd")).toMatch(/try again/);
  });

  it("offers the buttons only while the order is waiting and unpaid", () => {
    expect(canCustomerCancel({ status: "pending", paid: false })).toBe(true);
    expect(canCustomerCancel({ status: "pending", paid: true })).toBe(false);
    expect(canCustomerCancel({ status: "confirmed", paid: false })).toBe(false);
  });
});

describe("waiter cancel_order gate", () => {
  const asked = JSON.stringify({ ok: true, data: { orderId: "o1" } });

  it("cancels only after the customer answered in a new message", () => {
    const pending = parsePendingCancellation({
      content: asked,
      createdAt: "2026-10-20T18:00:00Z",
    });
    expect(
      checkCancelConfirmation({
        pending,
        currentOrderId: "o1",
        currentTurnUserMessageAt: "2026-10-20T18:00:30Z",
      }),
    ).toEqual({ confirmed: true });
  });

  it("refuses when it wasn't asked first, or in the same turn", () => {
    expect(
      checkCancelConfirmation({
        pending: null,
        currentOrderId: "o1",
        currentTurnUserMessageAt: "2026-10-20T18:00:30Z",
      }).confirmed,
    ).toBe(false);
    expect(
      checkCancelConfirmation({
        pending: { orderId: "o1", requestedAt: "2026-10-20T18:00:30Z" },
        currentOrderId: "o1",
        currentTurnUserMessageAt: "2026-10-20T18:00:30Z",
      }).confirmed,
    ).toBe(false);
  });

  it("refuses when a newer order was placed since asking", () => {
    expect(
      checkCancelConfirmation({
        pending: { orderId: "o1", requestedAt: "2026-10-20T18:00:00Z" },
        currentOrderId: "o2",
        currentTurnUserMessageAt: "2026-10-20T18:01:00Z",
      }),
    ).toMatchObject({
      confirmed: false,
      reason: expect.stringMatching(/newer/),
    });
  });

  it("treats an unreadable log entry as no confirmation", () => {
    expect(
      parsePendingCancellation({ content: "not json", createdAt: "x" }),
    ).toBeNull();
  });
});
