import { describe, expect, it } from "vitest";
import {
  resolveWaiterModels,
  waiterSourceLabel,
} from "@/lib/ai/waiter-models-core";
import {
  gradeWaiter,
  sampleToolOutcome,
  type TestMenu,
} from "@/lib/admin/model-test-core";

/** Admin Phase 7: which waiter a restaurant gets, and the Test on its own menu. */

const platform = { models: ["free/a:free"], source: "saved" as const };

describe("resolveWaiterModels", () => {
  it("restaurant first, then its plan, then everyone", () => {
    expect(
      resolveWaiterModels({
        restaurant: ["paid/r"],
        plan: ["paid/p"],
        platform,
        overridesApply: true,
      }),
    ).toEqual({ models: ["paid/r"], source: "restaurant" });
    expect(
      resolveWaiterModels({
        restaurant: undefined,
        plan: ["paid/p"],
        platform,
        overridesApply: true,
      }),
    ).toEqual({ models: ["paid/p"], source: "plan" });
    expect(
      resolveWaiterModels({
        restaurant: [],
        plan: undefined,
        platform,
        overridesApply: true,
      }),
    ).toEqual({ models: ["free/a:free"], source: "saved" });
  });

  it("ignores overrides when they can't apply (the waiter on Anthropic)", () => {
    expect(
      resolveWaiterModels({
        restaurant: ["paid/r"],
        plan: ["paid/p"],
        platform,
        overridesApply: false,
      }).source,
    ).toBe("saved");
  });

  it("leaves out models that went wrong in real conversations", () => {
    const bad = "poolside/laguna-s-2.1:free";
    expect(
      resolveWaiterModels({
        restaurant: [bad, "free/b:free"],
        plan: undefined,
        platform,
        overridesApply: true,
      }),
    ).toEqual({ models: ["free/b:free"], source: "restaurant" });
    // A list of nothing but bad ones falls through to the next list...
    expect(
      resolveWaiterModels({
        restaurant: [bad],
        plan: undefined,
        platform,
        overridesApply: true,
      }),
    ).toEqual({ models: ["free/a:free"], source: "saved" });
    // ...and a platform list of nothing but bad ones is kept: some waiter
    // beats none.
    expect(
      resolveWaiterModels({
        restaurant: undefined,
        plan: undefined,
        platform: { models: [bad], source: "saved" },
        overridesApply: true,
      }).models,
    ).toEqual([bad]);
  });

  it("says where a choice came from", () => {
    expect(waiterSourceLabel("restaurant")).toBe("Set for this restaurant");
    expect(waiterSourceLabel("plan")).toBe("Its plan's default");
    expect(waiterSourceLabel("default")).toBe("Same as everyone");
  });
});

describe("the waiter Test on a restaurant's own menu", () => {
  const menu: TestMenu = {
    restaurantName: "Desi Test",
    categories: ["Curries"],
    dishes: [
      {
        id: "11111111-1111-4111-8111-111111111111",
        name: "Butter Chicken",
        description: "",
        price: 18,
        category: "Curries",
        isVegetarian: false,
        isSpicy: false,
      },
      {
        id: "22222222-2222-4222-8222-222222222222",
        name: "Dal Tadka",
        description: "Yellow lentils",
        price: 16,
        category: "Curries",
        isVegetarian: true,
        isSpicy: false,
      },
    ],
  };

  it("answers the menu tools from that menu, and refuses to change anything", () => {
    const search = sampleToolOutcome("search_menu", { query: "dal" }, menu);
    expect(JSON.stringify(search.result)).toContain("Dal Tadka");
    expect(
      sampleToolOutcome("get_restaurant_info", {}, menu).result.data,
    ).toMatchObject({ name: "Desi Test", categories: ["Curries"] });
    expect(sampleToolOutcome("add_to_cart", {}, menu).result.ok).toBe(false);
  });

  const reply = (finalText: string) => ({
    toolOutcomes: [sampleToolOutcome("search_menu", { query: "" }, menu)],
    finalText,
    refused: false,
    guardCorrectionExhausted: false,
  });

  it("grades vegetarian answers against that menu", () => {
    const ok = gradeWaiter(reply("Try the Dal Tadka."), menu.dishes);
    expect(ok.every((c) => c.ok)).toBe(true);
    const wrong = gradeWaiter(
      reply("Butter Chicken and Dal Tadka are both vegetarian."),
      menu.dishes,
    );
    expect(wrong.some((c) => !c.ok)).toBe(true);
  });

  it("on a menu with no vegetarian dish, passes only an answer that names none", () => {
    const meatOnly = menu.dishes.filter((d) => !d.isVegetarian);
    expect(
      gradeWaiter(reply("Sorry, nothing here is vegetarian."), meatOnly).every(
        (c) => c.ok,
      ),
    ).toBe(true);
    expect(
      gradeWaiter(reply("The Butter Chicken is vegetarian."), meatOnly).some(
        (c) => !c.ok,
      ),
    ).toBe(true);
  });
});
