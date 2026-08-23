import { describe, expect, it } from "vitest";
import {
  computeCartFingerprint,
  checkOrderConfirmation,
} from "@/lib/ai/tools/order-confirmation";
import type { CartLine } from "@/lib/cart/get-cart";

function line(overrides: Partial<CartLine> = {}): CartLine {
  return {
    id: "cart-item-1",
    menuItemId: "item-1",
    menuItemName: "Paneer Tikka",
    menuItemImageUrl: null,
    quantity: 1,
    unitPrice: 8.99,
    modifiersPrice: 0,
    lineTotal: 8.99,
    modifiers: [],
    stillAvailable: true,
    ...overrides,
  };
}

describe("computeCartFingerprint", () => {
  it("is content-based, not row-id-based — two carts with identical content fingerprint the same even with different cart_item ids", () => {
    const a = computeCartFingerprint([line({ id: "row-a" })]);
    const b = computeCartFingerprint([line({ id: "row-b" })]);
    expect(a).toBe(b);
  });

  it("changes when quantity changes", () => {
    const a = computeCartFingerprint([line({ quantity: 1 })]);
    const b = computeCartFingerprint([line({ quantity: 2 })]);
    expect(a).not.toBe(b);
  });

  it("changes when the modifier selection changes", () => {
    const a = computeCartFingerprint([
      line({ modifiers: [{ id: "m1", name: "Mild", priceAdjustment: 0 }] }),
    ]);
    const b = computeCartFingerprint([
      line({ modifiers: [{ id: "m2", name: "Hot", priceAdjustment: 0 }] }),
    ]);
    expect(a).not.toBe(b);
  });

  it("is independent of line order (two identical carts assembled in different orders still match)", () => {
    const itemA = line({ id: "row-a", menuItemId: "item-a" });
    const itemB = line({ id: "row-b", menuItemId: "item-b" });
    expect(computeCartFingerprint([itemA, itemB])).toBe(
      computeCartFingerprint([itemB, itemA]),
    );
  });

  it("changes when a different item is added", () => {
    const a = computeCartFingerprint([line()]);
    const b = computeCartFingerprint([
      line(),
      line({ id: "row-2", menuItemId: "item-2" }),
    ]);
    expect(a).not.toBe(b);
  });
});

describe("checkOrderConfirmation", () => {
  const fingerprint = computeCartFingerprint([line()]);

  it("rejects submit_order when no confirmation was ever requested (the ambiguous 'place the order' case)", () => {
    const result = checkOrderConfirmation({
      pending: null,
      currentFingerprint: fingerprint,
      currentTurnUserMessageAt: "2026-01-01T00:00:10.000Z",
    });
    expect(result.confirmed).toBe(false);
    expect(result.reason).toBeTruthy();
  });

  it("allows submit_order when a matching confirmation was requested in an earlier turn", () => {
    const result = checkOrderConfirmation({
      pending: {
        fingerprint,
        requestedAt: "2026-01-01T00:00:00.000Z",
      },
      currentFingerprint: fingerprint,
      currentTurnUserMessageAt: "2026-01-01T00:00:10.000Z",
    });
    expect(result.confirmed).toBe(true);
  });

  it("rejects reuse of a confirmation for an unrelated/changed cart (fingerprint mismatch)", () => {
    const result = checkOrderConfirmation({
      pending: {
        fingerprint: "some-other-cart-fingerprint",
        requestedAt: "2026-01-01T00:00:00.000Z",
      },
      currentFingerprint: fingerprint,
      currentTurnUserMessageAt: "2026-01-01T00:00:10.000Z",
    });
    expect(result.confirmed).toBe(false);
    expect(result.reason).toMatch(/changed/i);
  });

  it("rejects a same-turn propose-then-submit chain — confirmation requested at/after the current user message never counts", () => {
    const sameInstant = checkOrderConfirmation({
      pending: {
        fingerprint,
        requestedAt: "2026-01-01T00:00:10.000Z",
      },
      currentFingerprint: fingerprint,
      currentTurnUserMessageAt: "2026-01-01T00:00:10.000Z",
    });
    expect(sameInstant.confirmed).toBe(false);

    const confirmationAfterMessage = checkOrderConfirmation({
      pending: {
        fingerprint,
        requestedAt: "2026-01-01T00:00:11.000Z",
      },
      currentFingerprint: fingerprint,
      currentTurnUserMessageAt: "2026-01-01T00:00:10.000Z",
    });
    expect(confirmationAfterMessage.confirmed).toBe(false);
  });

  it("rejects when there's no current-turn user message to anchor against (defensive — shouldn't happen in practice)", () => {
    const result = checkOrderConfirmation({
      pending: { fingerprint, requestedAt: "2026-01-01T00:00:00.000Z" },
      currentFingerprint: fingerprint,
      currentTurnUserMessageAt: null,
    });
    expect(result.confirmed).toBe(false);
  });
});
