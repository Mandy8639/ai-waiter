import { describe, expect, it } from "vitest";
import {
  ADJUSTMENT_REASONS,
  OTHER_REASON,
  adjustSchema,
  adjustmentErrorMessage,
  chosenReason,
  parsePositive,
} from "@/lib/payments/adjustment-core";

const ids = {
  restaurantId: "11111111-1111-4111-8111-111111111111",
  orderId: "22222222-2222-4222-8222-222222222222",
  itemId: "33333333-3333-4333-8333-333333333333",
};

describe("Settle up adjustments", () => {
  it("offers Other for every kind, and Walked out as a discount", () => {
    for (const reasons of Object.values(ADJUSTMENT_REASONS))
      expect(reasons.at(-1)).toBe(OTHER_REASON);
    expect(ADJUSTMENT_REASONS.discount).toContain("Walked out");
  });

  it("takes a preset reason, or what was typed for Other", () => {
    expect(chosenReason("Long wait", "ignored")).toBe("Long wait");
    expect(chosenReason(OTHER_REASON, "  Birthday  ")).toBe("Birthday");
    expect(chosenReason(OTHER_REASON, "   ")).toBeNull();
  });

  it("reads typed numbers, refusing zero and nonsense", () => {
    expect(parsePositive("12.5")).toBe(12.5);
    expect(parsePositive(" 10 ")).toBe(10);
    expect(parsePositive("0")).toBeNull();
    expect(parsePositive("-3")).toBeNull();
    expect(parsePositive("abc")).toBeNull();
  });

  it("accepts a void of some units, and a discount by percent or amount", () => {
    expect(
      adjustSchema.safeParse({
        kind: "void",
        ...ids,
        quantity: 2,
        reason: "Entered by mistake",
      }).success,
    ).toBe(true);
    expect(
      adjustSchema.safeParse({
        kind: "discount",
        ...ids,
        percent: 10,
        amount: null,
        reason: "Regular guest",
      }).success,
    ).toBe(true);
    expect(
      adjustSchema.safeParse({
        kind: "comp",
        ...ids,
        quantity: 0,
        reason: "Quality issue",
      }).success,
    ).toBe(false);
    expect(
      adjustSchema.safeParse({
        kind: "discount",
        ...ids,
        percent: 120,
        amount: null,
        reason: "Promotion",
      }).success,
    ).toBe(false);
  });

  it("says the database's refusals in plain words", () => {
    expect(
      adjustmentErrorMessage(
        "ADJUST_PAYMENT_STARTED: a payment for this order has started or finished",
      ),
    ).toMatch(/already started/);
    expect(
      adjustmentErrorMessage(
        "ADJUST_INVALID: only 2 of that dish left to change",
      ),
    ).toBe("Only 2 of that dish left to change.");
    expect(adjustmentErrorMessage("connection reset")).toBe(
      "Couldn't change the bill. Try again.",
    );
  });
});
