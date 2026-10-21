import { describe, expect, it } from "vitest";
import {
  isTestModeKey,
  tapOutcome,
  terminalLocationAddress,
} from "@/lib/payments/tap-to-pay-core";

/** Tap to Pay in the staff app (src/lib/payments/tap-to-pay.ts). */

describe("terminalLocationAddress", () => {
  const full = {
    address: "143 Newark Ave",
    city: "Jersey City",
    state: "NJ",
    postal_code: "07302",
    country: "USA",
  };

  it("builds Stripe's address, with a two-letter country", () => {
    expect(terminalLocationAddress(full)).toEqual({
      ok: true,
      address: {
        line1: "143 Newark Ave",
        city: "Jersey City",
        state: "NJ",
        postal_code: "07302",
        country: "US",
      },
    });
  });

  it("names what's missing, in words an owner uses", () => {
    expect(
      terminalLocationAddress({ ...full, address: " ", postal_code: null }),
    ).toEqual({ ok: false, missing: ["street address", "ZIP code"] });
  });
});

describe("tapOutcome", () => {
  it("counts only Stripe's succeeded as paid", () => {
    expect(tapOutcome("succeeded")).toBe("paid");
    expect(tapOutcome("canceled")).toBe("failed");
    // A declined card leaves the same intent ready for another tap.
    expect(tapOutcome("requires_payment_method")).toBe("waiting");
    expect(tapOutcome("processing")).toBe("waiting");
  });
});

describe("isTestModeKey", () => {
  it("uses a simulated reader only with test keys", () => {
    expect(isTestModeKey("sk_test_123")).toBe(true);
    expect(isTestModeKey("rk_test_123")).toBe(true);
    expect(isTestModeKey("sk_live_123")).toBe(false);
    expect(isTestModeKey(undefined)).toBe(false);
  });
});
