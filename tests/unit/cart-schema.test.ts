import { describe, expect, it } from "vitest";
import { addToCartSchema, updateQuantitySchema } from "@/lib/cart/schema";

describe("addToCartSchema", () => {
  const valid = {
    menuItemId: "00000000-0000-0000-0000-000000000001",
    quantity: 1,
    selectedOptionIds: [] as string[],
  };

  it("accepts a valid add-to-cart request", () => {
    expect(addToCartSchema.safeParse(valid).success).toBe(true);
  });

  it("accepts selected option ids", () => {
    expect(
      addToCartSchema.safeParse({
        ...valid,
        selectedOptionIds: ["opt-1", "opt-2"],
      }).success,
    ).toBe(true);
  });

  it("rejects a zero quantity", () => {
    expect(addToCartSchema.safeParse({ ...valid, quantity: 0 }).success).toBe(
      false,
    );
  });

  it("rejects a negative quantity", () => {
    expect(addToCartSchema.safeParse({ ...valid, quantity: -1 }).success).toBe(
      false,
    );
  });

  it("rejects a quantity above 99", () => {
    expect(addToCartSchema.safeParse({ ...valid, quantity: 100 }).success).toBe(
      false,
    );
  });

  it("rejects a non-integer quantity", () => {
    expect(addToCartSchema.safeParse({ ...valid, quantity: 1.5 }).success).toBe(
      false,
    );
  });

  it("rejects a missing menu item id", () => {
    expect(
      addToCartSchema.safeParse({ ...valid, menuItemId: "" }).success,
    ).toBe(false);
  });
});

describe("updateQuantitySchema", () => {
  const valid = {
    cartItemId: "00000000-0000-0000-0000-000000000001",
    quantity: 3,
  };

  it("accepts a valid update", () => {
    expect(updateQuantitySchema.safeParse(valid).success).toBe(true);
  });

  it("rejects a zero quantity", () => {
    expect(
      updateQuantitySchema.safeParse({ ...valid, quantity: 0 }).success,
    ).toBe(false);
  });

  it("rejects a quantity above 99", () => {
    expect(
      updateQuantitySchema.safeParse({ ...valid, quantity: 100 }).success,
    ).toBe(false);
  });
});
