import { describe, it, expect } from "vitest";
import {
  stripeKeyMode,
  isUnusableWithThisKey,
} from "@/lib/payments/stripe-mode";

describe("stripeKeyMode", () => {
  it.each([
    ["sk_live_abc123", "live"],
    ["rk_live_abc123", "live"],
    ["sk_test_abc123", "test"],
    ["rk_test_abc123", "test"],
  ])("reads the mode out of %s", (key, expected) => {
    expect(stripeKeyMode(key)).toBe(expected);
  });

  it.each(["", "sk_abc123", "pk_live_abc", "whsec_abc", "not-a-key"])(
    "reports unknown rather than guessing for %s",
    (key) => {
      // A wrong guess here would tell an operator they're in test mode
      // while real money moves.
      expect(stripeKeyMode(key)).toBe("unknown");
    },
  );

  it("does not treat a publishable live key as a live secret key", () => {
    expect(stripeKeyMode("pk_live_abc123")).toBe("unknown");
  });
});

describe("isUnusableWithThisKey", () => {
  it("recognises the v1 shape: 404 resource_missing", () => {
    // Verified against the real API: prices and subscriptions return this
    // for an id that doesn't exist for the current key.
    expect(
      isUnusableWithThisKey({
        code: "resource_missing",
        statusCode: 404,
        type: "StripeInvalidRequestError",
      }),
    ).toBe(true);
  });

  it("recognises the v2 accounts shape: 403 forbidden, NOT a 404", () => {
    // The case that matters most at cutover. Verified against the real
    // API: stripe.v2.core.accounts.retrieve on a nonexistent account
    // returns 403 forbidden. Treating this as a hard error would report
    // the single most consequential mismatch — the Connect account — as a
    // script bug instead of as the finding it is.
    expect(
      isUnusableWithThisKey({
        code: "forbidden",
        statusCode: 403,
        type: "StripePermissionError",
      }),
    ).toBe(true);
  });

  it("matches on status code alone when no code is present", () => {
    expect(isUnusableWithThisKey({ statusCode: 404 })).toBe(true);
    expect(isUnusableWithThisKey({ statusCode: 403 })).toBe(true);
  });

  it.each([
    ["rate limiting", { code: "rate_limit", statusCode: 429 }],
    ["a Stripe outage", { statusCode: 503 }],
    ["a bad request", { code: "parameter_invalid_empty", statusCode: 400 }],
    ["an auth failure", { code: "api_key_expired", statusCode: 401 }],
  ])("does not swallow %s", (_label, error) => {
    // These must surface. Treating a transient failure as "absent" would
    // make the setup script create a duplicate product.
    expect(isUnusableWithThisKey(error)).toBe(false);
  });

  it("handles null and undefined without throwing", () => {
    expect(isUnusableWithThisKey(null)).toBe(false);
    expect(isUnusableWithThisKey(undefined)).toBe(false);
  });

  it("handles a plain Error with no Stripe fields", () => {
    expect(isUnusableWithThisKey(new Error("socket hang up"))).toBe(false);
  });
});
