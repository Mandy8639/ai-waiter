import { describe, expect, it } from "vitest";
import { isInPersonMethod, paymentMethodLabel } from "@/lib/payments/method";

describe("paymentMethodLabel", () => {
  it("names each stored method the way an owner would", () => {
    expect(paymentMethodLabel("card")).toBe("Card");
    expect(paymentMethodLabel("cash")).toBe("Cash");
    expect(paymentMethodLabel("card_terminal")).toBe("Card machine");
  });

  it("shows an unknown method as stored rather than hiding it", () => {
    expect(paymentMethodLabel("voucher")).toBe("voucher");
  });
});

describe("isInPersonMethod", () => {
  it("is true only for what staff record themselves", () => {
    expect(isInPersonMethod("cash")).toBe(true);
    expect(isInPersonMethod("card_terminal")).toBe(true);
    // A Stripe card payment is refunded, never reversed.
    expect(isInPersonMethod("card")).toBe(false);
  });
});
