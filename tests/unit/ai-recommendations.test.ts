import { describe, expect, it } from "vitest";
import {
  collectToolMenuItems,
  MAX_RECOMMENDED_ITEMS,
  selectMentionedItems,
} from "@/lib/ai/recommendations";
import type { LoopToolOutcome } from "@/lib/ai/loop";

/**
 * Dish cards under a waiter reply must be real rows the server returned
 * this turn — never ids, prices or names read out of the model's prose.
 */

function search(
  items: Array<{ id: string; name: string; price: number }>,
  currency = "USD",
): LoopToolOutcome {
  return {
    toolName: "search_menu",
    result: {
      ok: true,
      data: {
        currency,
        items: items.map((i) => ({
          ...i,
          description: null,
          isVegetarian: true,
          isVegan: false,
          isSpicy: false,
          category: "South Indian",
        })),
      },
    },
  };
}

const dosas = search([
  { id: "a", name: "Masala Dosa", price: 9.99 },
  { id: "b", name: "Mysore Masala Dosa", price: 9.99 },
  { id: "c", name: "Paneer Masala Dosa", price: 10.99 },
  { id: "d", name: "Plain Dosa", price: 7.99 },
]);

describe("collectToolMenuItems", () => {
  it("takes items from successful search_menu and get_menu_item calls only", () => {
    const outcomes: LoopToolOutcome[] = [
      dosas,
      { toolName: "search_menu", result: { ok: false, error: "nope" } },
      {
        toolName: "get_menu_item",
        result: {
          ok: true,
          data: {
            currency: "EUR",
            id: "e",
            name: "Fafda",
            price: 14.99,
            isVegetarian: true,
          },
        },
      },
      // Not a menu source, even though it carries names and prices.
      {
        toolName: "get_cart",
        result: {
          ok: true,
          data: { lines: [{ id: "x", name: "Masala Dosa", price: 1 }] },
        },
      },
    ];
    const items = collectToolMenuItems(outcomes);
    expect(items.map((i) => i.id)).toEqual(["a", "b", "c", "d", "e"]);
    expect(items.find((i) => i.id === "e")?.currency).toBe("EUR");
  });

  it("skips malformed rows rather than inventing values", () => {
    const items = collectToolMenuItems([
      search([{ id: "ok", name: "Soup", price: 5 }]),
      {
        toolName: "search_menu",
        result: {
          ok: true,
          data: {
            items: [
              { id: 1, name: "Bad" },
              { id: "p", name: "No price" },
            ],
          },
        },
      },
    ]);
    expect(items.map((i) => i.id)).toEqual(["ok"]);
  });
});

describe("selectMentionedItems", () => {
  it("returns the dishes the reply names, in the order it names them", () => {
    const reply =
      "Try the **Plain Dosa** ($7.99) — or, if you want filling, the Paneer Masala Dosa.";
    expect(selectMentionedItems(reply, [dosas]).map((i) => i.id)).toEqual([
      "d",
      "c",
    ]);
  });

  it("does not count a name that only appears inside a longer one", () => {
    const reply = "The Mysore Masala Dosa is the spicier choice.";
    expect(selectMentionedItems(reply, [dosas]).map((i) => i.id)).toEqual([
      "b",
    ]);
  });

  it("counts the shorter name when it also appears on its own", () => {
    const reply = "Masala Dosa is classic; Mysore Masala Dosa is hotter.";
    expect(selectMentionedItems(reply, [dosas]).map((i) => i.id)).toEqual([
      "a",
      "b",
    ]);
  });

  it("matches whole phrases only", () => {
    const soup = search([{ id: "t", name: "Tea", price: 2 }]);
    expect(selectMentionedItems("A teacake would be nice", [soup])).toEqual([]);
    expect(
      selectMentionedItems("Ginger tea, then?", [soup]).map((i) => i.id),
    ).toEqual(["t"]);
  });

  it("caps the number of cards", () => {
    const many = search(
      Array.from({ length: 8 }, (_, n) => ({
        id: `i${n}`,
        name: `Dish ${n}`,
        price: n,
      })),
    );
    const reply = Array.from({ length: 8 }, (_, n) => `Dish ${n}`).join(", ");
    expect(selectMentionedItems(reply, [many])).toHaveLength(
      MAX_RECOMMENDED_ITEMS,
    );
  });

  it("returns nothing when the reply names no returned dish", () => {
    expect(
      selectMentionedItems("What are you in the mood for?", [dosas]),
    ).toEqual([]);
    expect(selectMentionedItems("Masala Dosa sounds good", [])).toEqual([]);
  });
});
