import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  freePeriodPhrase,
  parseDollars,
  parsePercent,
  planNote,
  priceChangesAllowed,
  starterTermsLine,
  validFreeMonthDays,
} from "@/lib/admin/plan-admin-core";

vi.mock("server-only", () => ({}));
const stripe = {
  prices: { retrieve: vi.fn(), create: vi.fn() },
  products: { create: vi.fn() },
};
vi.mock("@/lib/payments/stripe", () => ({ getStripe: () => stripe }));

/** Admin Phase 8: changing plan prices, card fees and the free month. */

describe("reading what the admin typed", () => {
  it("reads dollars as whole cents", () => {
    expect(parseDollars("19")).toBe(1900);
    expect(parseDollars("$19.99")).toBe(1999);
    expect(parseDollars("1,000")).toBe(100000);
    expect(parseDollars("0")).toBe(0);
    for (const bad of ["", "abc", "19.999", "-5", "1001"]) {
      expect(parseDollars(bad), bad).toBeNull();
    }
  });

  it("reads percents as whole basis points, up to 10%", () => {
    expect(parsePercent("1")).toBe(100);
    expect(parsePercent("0.5%")).toBe(50);
    expect(parsePercent("0.25")).toBe(25);
    for (const bad of ["", "11", "0.255", "x"]) {
      expect(parsePercent(bad), bad).toBeNull();
    }
  });

  it("allows 0 to 90 whole days of free month", () => {
    expect(validFreeMonthDays(0)).toBe(true);
    expect(validFreeMonthDays(90)).toBe(true);
    expect(validFreeMonthDays(91)).toBe(false);
    expect(validFreeMonthDays(14.5)).toBe(false);
  });
});

describe("the live-Stripe lock", () => {
  it("allows test mode, and live only once approved", () => {
    expect(priceChangesAllowed("test", undefined)).toEqual({ ok: true });
    expect(priceChangesAllowed("live", "1")).toEqual({ ok: true });
    const locked = priceChangesAllowed("live", undefined);
    expect(locked.ok).toBe(false);
    if (!locked.ok)
      expect(locked.reason).toContain("ADMIN_LIVE_PRICE_CHANGES=1");
    expect(priceChangesAllowed("live", "yes").ok).toBe(false);
    expect(priceChangesAllowed("unknown", "1").ok).toBe(false);
  });
});

describe("what restaurants and the landing page are told", () => {
  it("words Starter from the real plan", () => {
    expect(
      starterTermsLine({
        monthlyPriceCents: 1900,
        feeBps: 100,
        currency: "USD",
      }),
    ).toBe("Starter is $19/month plus 1% of card payments.");
    expect(
      starterTermsLine({
        monthlyPriceCents: 2450,
        feeBps: 75,
        currency: "USD",
      }),
    ).toBe("Starter is $24.50/month plus 0.75% of card payments.");
    expect(
      starterTermsLine({ monthlyPriceCents: 0, feeBps: 100, currency: "USD" }),
    ).toBe("Starter is free, plus 1% of card payments.");
  });

  it("names the free period by its length", () => {
    expect(freePeriodPhrase(30)).toBe("Your first month is free");
    expect(freePeriodPhrase(14)).toBe("Your first 14 days are free");
    expect(freePeriodPhrase(1)).toBe("Your first 1 day is free");
    expect(freePeriodPhrase(0)).toBeNull();
  });

  it("works out where a dearer plan with a lower fee pays off", () => {
    const plans = [
      {
        slug: "starter",
        name: "Starter",
        monthlyPriceCents: 1900,
        currency: "USD",
        feeBps: 100,
      },
      {
        slug: "standard",
        name: "Standard",
        monthlyPriceCents: 4900,
        currency: "USD",
        feeBps: 50,
      },
    ];
    expect(planNote(plans, 0)).toBe(
      "Everything included. Cash payments are never charged.",
    );
    expect(planNote(plans, 1)).toBe(
      "Cheaper than Starter once card payments pass roughly $6,000 a month.",
    );
  });
});

describe("creating the Stripe price", () => {
  beforeEach(() => {
    stripe.prices.retrieve.mockReset();
    stripe.prices.create.mockReset().mockResolvedValue({ id: "price_new" });
    stripe.products.create.mockReset().mockResolvedValue({ id: "prod_new" });
  });

  const plan = {
    slug: "standard",
    name: "Standard",
    currency: "USD",
    monthlyPriceCents: 5900,
  };

  it("adds a new monthly price to the plan's existing product", async () => {
    const { createPlanPrice } = await import("@/lib/admin/plan-stripe");
    stripe.prices.retrieve.mockResolvedValue({ product: "prod_standard" });
    const id = await createPlanPrice({ ...plan, currentPriceId: "price_old" });
    expect(id).toBe("price_new");
    expect(stripe.products.create).not.toHaveBeenCalled();
    expect(stripe.prices.create).toHaveBeenCalledWith(
      expect.objectContaining({
        product: "prod_standard",
        currency: "usd",
        unit_amount: 5900,
        recurring: { interval: "month" },
      }),
    );
  });

  it("makes a product when the plan has none usable", async () => {
    const { createPlanPrice } = await import("@/lib/admin/plan-stripe");
    stripe.prices.retrieve.mockRejectedValue({ code: "resource_missing" });
    await createPlanPrice({ ...plan, currentPriceId: "price_other_mode" });
    expect(stripe.products.create).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Tableside — Standard" }),
    );
    expect(stripe.prices.create).toHaveBeenCalledWith(
      expect.objectContaining({ product: "prod_new" }),
    );
  });
});
