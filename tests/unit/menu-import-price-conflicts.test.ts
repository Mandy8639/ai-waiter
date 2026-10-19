import { describe, it, expect } from "vitest";
import {
  findPriceConflicts,
  type PriceConflictRow,
} from "@/lib/menu-import/price-conflicts";

function row(
  id: string,
  categoryName: string,
  name: string,
  price: number | null,
  include = true,
): PriceConflictRow {
  return { id, categoryName, name, price, include };
}

describe("findPriceConflicts", () => {
  it("flags both rows of a dish listed twice in one section at two prices", () => {
    const conflicts = findPriceConflicts([
      row("a", "Chicken Entrees", "Chicken Tikka Masala", 18),
      row("b", "Chicken Entrees", "chicken  tikka masala ", 19),
      row("c", "Chicken Entrees", "Butter Chicken", 18),
    ]);
    expect(conflicts.get("a")).toEqual([19]);
    expect(conflicts.get("b")).toEqual([18]);
    expect(conflicts.has("c")).toBe(false);
  });

  it("does not flag the same name in two different sections", () => {
    const conflicts = findPriceConflicts([
      row("a", "Veg Appetizers", "Chilli Paneer", 7),
      row("b", "Veg Entrees", "Chilli Paneer", 17),
    ]);
    expect(conflicts.size).toBe(0);
  });

  it("clears once one row is unticked", () => {
    const conflicts = findPriceConflicts([
      row("a", "Curries", "Natu Kodi Curry", 20),
      row("b", "Curries", "Natu Kodi Curry", 21, false),
    ]);
    expect(conflicts.size).toBe(0);
  });

  it("clears once one row is renamed or the prices agree", () => {
    expect(
      findPriceConflicts([
        row("a", "Curries", "Natu Kodi Curry", 20),
        row("b", "Curries", "Natu Kodi Curry (Family)", 21),
      ]).size,
    ).toBe(0);
    expect(
      findPriceConflicts([
        row("a", "Curries", "Natu Kodi Curry", 20),
        row("b", "Curries", "Natu Kodi Curry", 20),
      ]).size,
    ).toBe(0);
  });

  it("ignores an unpriced row, which is blocked for its own reason", () => {
    const conflicts = findPriceConflicts([
      row("a", "Sweets", "Gulab Jamun", 5),
      row("b", "Sweets", "Gulab Jamun", null),
    ]);
    expect(conflicts.size).toBe(0);
  });

  it("lists every other price when a dish appears three times", () => {
    const conflicts = findPriceConflicts([
      row("a", "Biryani", "Goat Biryani", 19),
      row("b", "Biryani", "Goat Biryani", 17),
      row("c", "Biryani", "Goat Biryani", 21),
    ]);
    expect(conflicts.get("a")).toEqual([17, 21]);
  });
});
