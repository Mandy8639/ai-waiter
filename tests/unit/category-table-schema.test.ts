import { describe, expect, it } from "vitest";
import { categorySchema } from "@/lib/categories/schema";
import { tableSchema } from "@/lib/tables/schema";
import { ingredientSchema } from "@/lib/ingredients/schema";
import { allergenSchema } from "@/lib/allergens/schema";

describe("categorySchema", () => {
  it("accepts a valid category", () => {
    expect(
      categorySchema.safeParse({
        name: "Starters",
        displayOrder: 0,
        isActive: true,
      }).success,
    ).toBe(true);
  });

  it("rejects a blank name", () => {
    expect(
      categorySchema.safeParse({ name: "  ", displayOrder: 0, isActive: true })
        .success,
    ).toBe(false);
  });

  it("rejects a negative display order", () => {
    expect(
      categorySchema.safeParse({
        name: "Starters",
        displayOrder: -1,
        isActive: true,
      }).success,
    ).toBe(false);
  });
});

describe("tableSchema", () => {
  it("accepts a valid table", () => {
    expect(
      tableSchema.safeParse({ tableNumber: "12", isActive: true }).success,
    ).toBe(true);
  });

  it("rejects a blank table number", () => {
    expect(
      tableSchema.safeParse({ tableNumber: "  ", isActive: true }).success,
    ).toBe(false);
  });
});

describe("ingredientSchema / allergenSchema", () => {
  it("accepts a valid ingredient", () => {
    expect(ingredientSchema.safeParse({ name: "Paneer" }).success).toBe(true);
  });

  it("rejects a blank ingredient name", () => {
    expect(ingredientSchema.safeParse({ name: "" }).success).toBe(false);
  });

  it("accepts a valid allergen", () => {
    expect(allergenSchema.safeParse({ name: "Dairy" }).success).toBe(true);
  });

  it("rejects a blank allergen name", () => {
    expect(allergenSchema.safeParse({ name: "" }).success).toBe(false);
  });
});
