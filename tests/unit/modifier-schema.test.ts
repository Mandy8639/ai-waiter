import { describe, expect, it } from "vitest";
import {
  modifierGroupSchema,
  modifierOptionSchema,
} from "@/lib/modifiers/schema";

describe("modifierGroupSchema", () => {
  const valid = {
    menuItemId: "00000000-0000-0000-0000-000000000001",
    name: "Size",
    isRequired: true,
    minSelections: 1,
    maxSelections: 1,
    displayOrder: 0,
  };

  it("accepts a valid group", () => {
    expect(modifierGroupSchema.safeParse(valid).success).toBe(true);
  });

  it("rejects max < min", () => {
    const result = modifierGroupSchema.safeParse({
      ...valid,
      minSelections: 3,
      maxSelections: 1,
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].path).toContain("maxSelections");
    }
  });

  it("accepts max === min", () => {
    expect(
      modifierGroupSchema.safeParse({
        ...valid,
        minSelections: 2,
        maxSelections: 2,
      }).success,
    ).toBe(true);
  });

  it("rejects a negative minSelections", () => {
    expect(
      modifierGroupSchema.safeParse({ ...valid, minSelections: -1 }).success,
    ).toBe(false);
  });

  it("rejects a missing menu item", () => {
    expect(
      modifierGroupSchema.safeParse({ ...valid, menuItemId: "" }).success,
    ).toBe(false);
  });
});

describe("modifierOptionSchema", () => {
  const valid = {
    name: "Large",
    priceAdjustment: 1.5,
    isAvailable: true,
    displayOrder: 0,
  };

  it("accepts a valid option", () => {
    expect(modifierOptionSchema.safeParse(valid).success).toBe(true);
  });

  it("allows a negative price adjustment (discount)", () => {
    expect(
      modifierOptionSchema.safeParse({ ...valid, priceAdjustment: -2 }).success,
    ).toBe(true);
  });

  it("rejects a blank name", () => {
    expect(modifierOptionSchema.safeParse({ ...valid, name: "" }).success).toBe(
      false,
    );
  });

  it("rejects a negative display order", () => {
    expect(
      modifierOptionSchema.safeParse({ ...valid, displayOrder: -1 }).success,
    ).toBe(false);
  });
});
