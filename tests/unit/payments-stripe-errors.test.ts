import Stripe from "stripe";
import { describe, expect, it } from "vitest";
import {
  STRIPE_ERROR_COPY,
  describeStripeError,
  stripeErrorDetails,
} from "@/lib/payments/stripe-errors";

/**
 * Before this existed, any Stripe refusal on the Payments page escaped the
 * server action and replaced the whole page with "Something went wrong".
 * During the live cutover on 2026-09-11 that hid three separate unfinished
 * Stripe setup steps, each one findable only in Stripe's own request log.
 *
 * These tests build real SDK error objects rather than plain fakes, so they
 * break if the SDK's error shape changes underneath the mapping.
 */

describe("describeStripeError", () => {
  it("explains the platform-setup refusal production hit on 2026-09-11", () => {
    // The exact response to POST /v2/core/accounts, request
    // req_v2sQ55xGGhoj0Wfzz.
    const error = new Stripe.errors.StripeInvalidRequestError({
      type: "invalid_request_error",
      code: "account_create_activation_required",
      statusCode: 400,
      message:
        "Your account must be activated in order to create accounts. You can activate your accounts at https://dashboard.stripe.com/account/onboarding.",
    });

    const message = describeStripeError(error);
    expect(message).toContain(STRIPE_ERROR_COPY.platformNotReady);
    expect(message).toContain("account_create_activation_required");
  });

  it.each([
    "account_create_activation_required",
    "accounts_v2_access_blocked",
    "cannot_create_connected_account",
    "cannot_create_new_account_rejected",
    "connect_identity_not_verified",
    "connect_profile_not_submitted",
    "non_connect_platform_accounts_v2_access_blocked",
    "platform_registration_required",
  ])("treats %s as the platform not being ready", (code) => {
    const error = new Stripe.errors.StripeInvalidRequestError({
      code,
      statusCode: 400,
      message: "irrelevant",
    });
    expect(describeStripeError(error)).toContain(
      STRIPE_ERROR_COPY.platformNotReady,
    );
  });

  it("explains a stored account the key can't see, without leaking the key", () => {
    // The 403 from GET /v2/core/accounts/acct_1UEZ4zPBjaphVRvC after the
    // key was corrected: the stored row belonged to another Stripe account.
    const error = new Stripe.errors.StripePermissionError({
      statusCode: 403,
      message:
        "Permission denied. API Key does not have permission to access account acct_1U**********VRvC. The provided key 'sk_live_***SWYRh1' does not have access.",
    });

    const message = describeStripeError(error);
    expect(message).toBe(STRIPE_ERROR_COPY.accountUnreachable);
    expect(message).not.toMatch(/sk_live|acct_|Permission denied/);
  });

  it("treats a deleted account the same as an unreachable one", () => {
    const error = new Stripe.errors.StripeInvalidRequestError({
      code: "resource_missing",
      statusCode: 404,
      message: "No such account",
    });
    expect(describeStripeError(error)).toBe(
      STRIPE_ERROR_COPY.accountUnreachable,
    );
  });

  it("says the site is misconfigured when the key itself is rejected", () => {
    const error = new Stripe.errors.StripeAuthenticationError({
      statusCode: 401,
      message: "Invalid API Key provided: sk_live_***",
    });
    expect(describeStripeError(error)).toBe(STRIPE_ERROR_COPY.misconfigured);
  });

  it.each([
    ["a connection failure", new Stripe.errors.StripeConnectionError({})],
    [
      "a rate limit",
      new Stripe.errors.StripeRateLimitError({ statusCode: 429 }),
    ],
    ["a Stripe outage", new Stripe.errors.StripeAPIError({ statusCode: 500 })],
  ])("asks for a retry on %s", (_label, error) => {
    expect(describeStripeError(error)).toBe(STRIPE_ERROR_COPY.unavailable);
  });

  it("falls back to a generic Stripe refusal that still names the code", () => {
    const error = new Stripe.errors.StripeInvalidRequestError({
      code: "url_invalid",
      statusCode: 400,
      message: "URL is invalid.",
    });
    const message = describeStripeError(error);
    expect(message).toContain(STRIPE_ERROR_COPY.rejected);
    expect(message).toContain("url_invalid");
    expect(message).not.toContain("URL is invalid.");
  });

  it("does not blame Stripe for an error that isn't Stripe's", () => {
    expect(describeStripeError(new TypeError("fetch failed"))).toBe(
      STRIPE_ERROR_COPY.unexpected,
    );
    expect(describeStripeError("boom")).toBe(STRIPE_ERROR_COPY.unexpected);
    expect(describeStripeError(null)).toBe(STRIPE_ERROR_COPY.unexpected);
  });
});

describe("stripeErrorDetails", () => {
  it("keeps the fields support needs and drops the message", () => {
    const error = new Stripe.errors.StripeInvalidRequestError({
      code: "account_create_activation_required",
      statusCode: 400,
      requestId: "req_v2sQ55xGGhoj0Wfzz",
      message: "The provided key 'sk_live_***SWYRh1' …",
    });

    const details = stripeErrorDetails(error);
    expect(details).toEqual({
      stripeType: "StripeInvalidRequestError",
      stripeCode: "account_create_activation_required",
      stripeStatus: 400,
      stripeRequestId: "req_v2sQ55xGGhoj0Wfzz",
    });
    expect(JSON.stringify(details)).not.toContain("sk_live");
  });

  it("returns nothing for an error that isn't Stripe's", () => {
    expect(stripeErrorDetails(new Error("nope"))).toEqual({});
  });
});
