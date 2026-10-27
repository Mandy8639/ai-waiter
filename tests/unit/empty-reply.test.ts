import { describe, expect, it } from "vitest";
import {
  dishesForEmptyReply,
  MAX_EMPTY_REPLY_DISHES,
} from "@/lib/ai/empty-reply-core";
import { foundDishesText, isFallbackText } from "@/lib/ai/fallback-text";
import type { LoopToolOutcome } from "@/lib/ai/loop";

// When the model returns nothing after its lookups found dishes, the
// waiter offers those dishes instead of "didn't quite catch that"
// (busy-Saturday audit). Every dish and price comes from a tool result.

const outcome = (toolName: string, data: unknown, ok = true) =>
  ({
    toolName,
    result: ok ? { ok, data } : { ok, error: "x" },
  }) as unknown as LoopToolOutcome;

const searched = (n: number) =>
  outcome("search_menu", {
    currency: "USD",
    items: Array.from({ length: n }, (_, i) => ({
      id: `d${i}`,
      name: `Dish ${i}`,
      price: 10 + i,
    })),
  });

describe("dishes for an empty reply", () => {
  it("offers what the menu search found, in its order, at most five", () => {
    const { kind, dishes } = dishesForEmptyReply([searched(8)]);
    expect(kind).toBe("found");
    expect(dishes).toHaveLength(MAX_EMPTY_REPLY_DISHES);
    expect(dishes[0]).toEqual({ name: "Dish 0", price: 10, currency: "USD" });
  });

  it("prefers the restaurant's favorites and most-ordered dishes", () => {
    const { kind, dishes } = dishesForEmptyReply([
      outcome("get_restaurant_info", {
        currency: "USD",
        houseFavorites: [{ id: "f1", name: "Goat Biryani", price: 20 }],
        mostOrderedThisMonth: [
          { id: "f1", name: "Goat Biryani", price: 20 },
          { id: "m1", name: "Garlic Naan", price: 4 },
        ],
      }),
      searched(3),
    ]);
    expect(kind).toBe("favorites");
    expect(dishes.map((d) => d.name)).toEqual(["Goat Biryani", "Garlic Naan"]);
  });

  it("falls back to the search when the restaurant has no picks yet", () => {
    const { kind } = dishesForEmptyReply([
      outcome("get_restaurant_info", {
        houseFavorites: [],
        mostOrderedThisMonth: [],
      }),
      searched(2),
    ]);
    expect(kind).toBe("found");
  });

  it("offers nothing when no lookup found a dish", () => {
    expect(dishesForEmptyReply([]).dishes).toEqual([]);
    expect(
      dishesForEmptyReply([outcome("search_menu", {}, false)]).dishes,
    ).toEqual([]);
    expect(
      dishesForEmptyReply([outcome("search_menu", { items: [] })]).dishes,
    ).toEqual([]);
  });
});

describe("the words around them", () => {
  const list = ["Goat Biryani ($20.00)", "Garlic Naan ($4.00)"];

  it("names the dishes in the diner's language", () => {
    expect(foundDishesText(list, "found", "en")).toBe(
      "Here's what I found on the menu: Goat Biryani ($20.00), Garlic Naan ($4.00). Tap a dish to see more, or ask me about any of them.",
    );
    expect(foundDishesText(list, "favorites", "hi")).toContain(
      "Goat Biryani ($20.00), Garlic Naan ($4.00)",
    );
    expect(foundDishesText(list, "favorites", "es")).toMatch(
      /^Algunos favoritos/,
    );
  });

  it("isn't one of the apologetic fixed replies", () => {
    expect(isFallbackText(foundDishesText(list, "found", "en"))).toBe(false);
  });
});
