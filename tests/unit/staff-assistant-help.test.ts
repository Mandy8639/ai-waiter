import { describe, expect, it } from "vitest";
import { helpText, pickExampleDishes } from "@/lib/staff-assistant/plan-core";

/**
 * The Waiter's examples use the restaurant's own dishes: on 2026-10-20 a
 * restaurant with no salmon was told to "86 the salmon".
 */
describe("staff Waiter examples", () => {
  it("prefers short dish names, in menu order", () => {
    expect(
      pickExampleDishes([
        "Hyderabadi Chicken Dum Biryani Family Pack",
        "Chilli Baby Corn",
        "Masala Chai",
      ]),
    ).toEqual(["Chilli Baby Corn", "Masala Chai"]);
    expect(pickExampleDishes(["  ", ""])).toEqual([]);
  });

  it("words the help list with this menu's dishes and add-ons", () => {
    const text = helpText({
      dishes: [
        {
          id: "1",
          name: "Chilli Baby Corn",
          price: 6,
          available: true,
          backAt: null,
        },
        {
          id: "2",
          name: "Masala Chai",
          price: 3,
          available: true,
          backAt: null,
        },
      ],
      options: [
        {
          id: "o",
          name: "Oat milk",
          groupName: "Milk",
          dishName: "Masala Chai",
          available: true,
        },
      ],
    });
    expect(text).toContain("86 the Chilli Baby Corn");
    expect(text).toContain("The Oat milk is out");
    expect(text).toContain("Make the Masala Chai $3.50");
    expect(text).not.toMatch(/salmon|mango lassi/i);
  });

  it("falls back to a placeholder for an empty menu", () => {
    const text = helpText({ dishes: [], options: [] });
    expect(text).toContain("86 the [dish]");
    expect(text).not.toMatch(/salmon/i);
  });
});
