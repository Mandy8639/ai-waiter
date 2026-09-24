import { describe, expect, it } from "vitest";
import { menuItemSchema } from "@/lib/menu/schema";

const valid = {
  name: "Chicken Tikka",
  slug: "chicken-tikka",
  categoryId: "00000000-0000-0000-0000-000000000001",
  price: 12.99,
  isAvailable: true,
  isVegetarian: false,
  isVegan: false,
  isSpicy: true,
  // Required rather than defaulted, so a form that forgets a claim field
  // fails loudly instead of quietly recording "not stated".
  isHalal: false,
  isKosher: false,
  containsNuts: false,
  containsDairy: true,
  containsGluten: false,
  displayOrder: 0,
};

describe("menuItemSchema", () => {
  it("accepts a valid menu item", () => {
    expect(menuItemSchema.safeParse(valid).success).toBe(true);
  });

  it("rejects a negative price", () => {
    const result = menuItemSchema.safeParse({ ...valid, price: -1 });
    expect(result.success).toBe(false);
  });

  it("rejects a negative preparation time", () => {
    const result = menuItemSchema.safeParse({ ...valid, preparationTime: -5 });
    expect(result.success).toBe(false);
  });

  it("rejects a negative display order", () => {
    const result = menuItemSchema.safeParse({ ...valid, displayOrder: -1 });
    expect(result.success).toBe(false);
  });

  it("rejects a blank name", () => {
    expect(menuItemSchema.safeParse({ ...valid, name: "  " }).success).toBe(
      false,
    );
  });

  it("rejects an invalid slug (uppercase, spaces)", () => {
    expect(
      menuItemSchema.safeParse({ ...valid, slug: "Chicken Tikka" }).success,
    ).toBe(false);
  });

  it("rejects a missing category", () => {
    expect(menuItemSchema.safeParse({ ...valid, categoryId: "" }).success).toBe(
      false,
    );
  });

  it("accepts an optional preparationTime when omitted", () => {
    expect(menuItemSchema.safeParse(valid).success).toBe(true);
  });

  it("rejects a portion note longer than the database allows", () => {
    // 200 characters, matching menu_items_portion_note_length. Caught in
    // the form rather than as a constraint violation on save.
    const result = menuItemSchema.safeParse({
      ...valid,
      portionNote: "a".repeat(201),
    });
    expect(result.success).toBe(false);
  });

  it("accepts a portion note written as a sentence", () => {
    expect(
      menuItemSchema.safeParse({
        ...valid,
        portionNote: "Generous for one, or two can share it with a roti.",
      }).success,
    ).toBe(true);
  });

  it("rejects an invalid spiceLevel", () => {
    const result = menuItemSchema.safeParse({
      ...valid,
      spiceLevel: "nuclear",
    });
    expect(result.success).toBe(false);
  });

  it("accepts a valid spiceLevel", () => {
    expect(
      menuItemSchema.safeParse({ ...valid, spiceLevel: "hot" }).success,
    ).toBe(true);
  });
});

describe("dietary claims", () => {
  it("requires each claim to be stated explicitly", () => {
    // Omitting one is a form bug, and a form bug that silently recorded
    // "not stated" would be indistinguishable from a deliberate answer.
    const { isHalal: _omitted, ...withoutHalal } = valid;
    expect(menuItemSchema.safeParse(withoutHalal).success).toBe(false);
  });

  it("accepts a dish the restaurant states is halal", () => {
    const result = menuItemSchema.safeParse({ ...valid, isHalal: true });
    expect(result.success).toBe(true);
  });
});
