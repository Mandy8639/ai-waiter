import { describe, expect, it } from "vitest";
import {
  billingNotice,
  daysUntil,
  PLANS_PATH,
  stripeTrialEnd,
  type RestaurantBilling,
} from "@/lib/billing/trial-core";

/**
 * What a restaurant's staff are told about the free month and their plan.
 * The rules (fee, grace, pause) are tested against Postgres in
 * tests/integration/db/billing-free-month.test.ts.
 */

const NOW = new Date("2026-11-01T12:00:00Z");
const day = (n: number) => new Date(NOW.getTime() + n * 86_400_000);
const owner = { canManage: true, canSell: true, timeZone: "America/New_York" };
const kitchen = {
  canManage: false,
  canSell: true,
  timeZone: "America/New_York",
};
const ownerInApp = {
  canManage: true,
  canSell: false,
  timeZone: "America/New_York",
};

const billing = (b: Partial<RestaurantBilling>): RestaurantBilling => ({
  state: "trial",
  trialEndsAt: day(20),
  graceEndsAt: day(27),
  ...b,
});

describe("billingNotice", () => {
  it("says nothing to exempt or subscribed restaurants", () => {
    expect(billingNotice(billing({ state: "exempt" }), owner, NOW)).toBeNull();
    expect(
      billingNotice(billing({ state: "subscribed" }), owner, NOW),
    ).toBeNull();
    expect(billingNotice(null, owner, NOW)).toBeNull();
  });

  it("tells the owner about the free month, quietly at first", () => {
    const n = billingNotice(billing({}), owner, NOW)!;
    expect(n.tone).toBe("info");
    expect(n.title).toBe("Your first month is free");
    expect(n.body).toContain("November 21");
    expect(n.body).toContain("$19/month plus 1%");
    expect(n.action).toEqual({ href: PLANS_PATH, label: "Choose a plan" });
  });

  it("gets louder in the last week of the free month", () => {
    const n = billingNotice(billing({ trialEndsAt: day(3) }), owner, NOW)!;
    expect(n.tone).toBe("warning");
    expect(n.title).toBe("Your free month ends in 3 days");
  });

  it("doesn't bother kitchen staff about the free month", () => {
    expect(billingNotice(billing({}), kitchen, NOW)).toBeNull();
  });

  it("warns during grace, with the date ordering would pause", () => {
    const n = billingNotice(
      billing({ state: "grace", trialEndsAt: day(-2), graceEndsAt: day(5) }),
      owner,
      NOW,
    )!;
    expect(n.tone).toBe("warning");
    expect(n.body).toContain("November 6");
    const staff = billingNotice(
      billing({ state: "grace", graceEndsAt: day(5) }),
      kitchen,
      NOW,
    )!;
    expect(staff.body).toContain("Ask the owner");
    expect(staff.action).toBeUndefined();
  });

  it("is loud once ordering has paused, for everyone", () => {
    const n = billingNotice(billing({ state: "lapsed" }), owner, NOW)!;
    expect(n.tone).toBe("danger");
    expect(n.title).toBe("QR ordering is paused");
    expect(n.body).toContain("can still see your menu");
    expect(
      billingNotice(billing({ state: "lapsed" }), kitchen, NOW)!.body,
    ).toContain("Ask the owner");
  });

  it("reassures on a failed card rather than alarming", () => {
    const n = billingNotice(billing({ state: "past_due" }), owner, NOW)!;
    expect(n.body).toContain("online ordering stays on");
  });

  it("offers no price and no link inside the store apps", () => {
    for (const state of ["trial", "grace", "lapsed", "past_due"] as const) {
      const n = billingNotice(billing({ state }), ownerInApp, NOW);
      if (!n) continue;
      expect(n.action, state).toBeUndefined();
      expect(n.body, state).not.toMatch(/\$\d/);
    }
  });
});

describe("daysUntil", () => {
  it("rounds up and never goes negative", () => {
    expect(daysUntil(day(2.2), NOW)).toBe(3);
    expect(daysUntil(day(-1), NOW)).toBe(0);
  });
});

describe("stripeTrialEnd", () => {
  it("carries the free month's end into Stripe", () => {
    expect(stripeTrialEnd(day(10), NOW)).toBe(
      Math.floor(day(10).getTime() / 1000),
    );
  });

  it("starts billing now when the month ends within Stripe's 48-hour minimum", () => {
    expect(stripeTrialEnd(day(1.5), NOW)).toBeUndefined();
    expect(stripeTrialEnd(null, NOW)).toBeUndefined();
  });
});
