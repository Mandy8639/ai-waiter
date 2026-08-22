import { describe, expect, it } from "vitest";
import {
  operationalSettingsSchema,
  restaurantProfileSchema,
} from "@/lib/settings/schema";

describe("restaurantProfileSchema", () => {
  const valid = {
    name: "Nashta",
    timezone: "America/New_York",
    currency: "USD",
    taxRate: 0.0825,
    serviceCharge: 0,
  };

  it("accepts valid profile data", () => {
    expect(restaurantProfileSchema.safeParse(valid).success).toBe(true);
  });

  it("rejects a tax rate above 1", () => {
    expect(
      restaurantProfileSchema.safeParse({ ...valid, taxRate: 1.5 }).success,
    ).toBe(false);
  });

  it("rejects a negative tax rate", () => {
    expect(
      restaurantProfileSchema.safeParse({ ...valid, taxRate: -0.01 }).success,
    ).toBe(false);
  });

  it("rejects an invalid currency code", () => {
    expect(
      restaurantProfileSchema.safeParse({ ...valid, currency: "US" }).success,
    ).toBe(false);
  });
});

describe("operationalSettingsSchema", () => {
  const valid = {
    acceptingOrders: true,
    allowCustomerNotes: true,
    allowAiRecommendations: true,
    allowUpselling: true,
    maxOrderItems: 50,
  };

  it("accepts valid settings", () => {
    expect(operationalSettingsSchema.safeParse(valid).success).toBe(true);
  });

  it("rejects zero max order items", () => {
    expect(
      operationalSettingsSchema.safeParse({ ...valid, maxOrderItems: 0 })
        .success,
    ).toBe(false);
  });

  it("rejects a negative max order items", () => {
    expect(
      operationalSettingsSchema.safeParse({ ...valid, maxOrderItems: -5 })
        .success,
    ).toBe(false);
  });
});
