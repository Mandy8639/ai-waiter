import { describe, expect, it } from "vitest";
import {
  looksLikeMenuFactQuestion,
  hasAuthoritativeMenuFactSource,
  AUTHORITATIVE_MENU_TOOL_NAMES,
} from "@/lib/ai/tools/menu-fact-detection";
import type { LoopToolOutcome } from "@/lib/ai/loop";

describe("looksLikeMenuFactQuestion — positives (must trigger the guard)", () => {
  it.each([
    "Can you recommend a vegetarian dish?",
    "What vegetarian options do you have?",
    "How much is the samosa?",
    "What's the price of Paneer Tikka?",
    "Is the dosa vegan?",
    "Does this contain dairy?",
    "What ingredients are in the samosa?",
    "What's available?",
    "Tell me about the menu",
    "What dishes do you recommend?",
    "Is anything gluten free?",
  ])("%s", (message) => {
    expect(looksLikeMenuFactQuestion(message)).toBe(true);
  });
});

describe("looksLikeMenuFactQuestion — preparation, timing and portion", () => {
  // Regression: these are the question shapes the waiter gained the
  // ability to answer, and the guard's keyword list predated them. Both
  // of the first two were answered live with ZERO tool calls, from the
  // model's general knowledge of the cuisine, because nothing matched.
  it.each([
    "How is the Halwa Puri Thali made, how long does it take, and is it enough for two of us?",
    "What about the Palak Paneer with 2 Paratha - how is it made, how long, and is it enough for two?",
    "how is the biryani cooked?",
    "How do you prepare the dosa?",
    "What's the cooking process for this?",
    "How long does the thali take?",
    "How many people does the biryani feed?",
    "Is that enough for two of us?",
    "How many does it serve?",
    "What's the portion like?",
  ])("%s", (message) => {
    expect(looksLikeMenuFactQuestion(message)).toBe(true);
  });
});

describe("looksLikeMenuFactQuestion — negatives (must NOT trigger the guard)", () => {
  it.each([
    "Hi",
    "Thanks",
    "Sounds good",
    "Yes",
    "Place the order",
    "Confirm the order",
    "What's in my cart?",
    "What's my total?",
    "Where is my order?",
    "Cancel that",
    // The widened patterns must not swallow ordinary ordering chat. "How
    // long" is anchored to timing questions, not to any sentence with
    // "long" in it, and cart/order talk stays out.
    "How long have you been open?",
    "Make it two please",
  ])("%s", (message) => {
    expect(looksLikeMenuFactQuestion(message)).toBe(false);
  });
});

function outcome(toolName: string, ok: boolean): LoopToolOutcome {
  return { toolName, result: { ok } };
}

describe("hasAuthoritativeMenuFactSource", () => {
  it("is false with no tool outcomes at all", () => {
    expect(hasAuthoritativeMenuFactSource([])).toBe(false);
  });

  it("is true when search_menu succeeded this turn", () => {
    expect(hasAuthoritativeMenuFactSource([outcome("search_menu", true)])).toBe(
      true,
    );
  });

  it("is true when get_menu_item succeeded this turn", () => {
    expect(
      hasAuthoritativeMenuFactSource([outcome("get_menu_item", true)]),
    ).toBe(true);
  });

  it("is true when get_restaurant_info succeeded this turn", () => {
    expect(
      hasAuthoritativeMenuFactSource([outcome("get_restaurant_info", true)]),
    ).toBe(true);
  });

  it("is false when the only tool call was unrelated (get_cart) — an unrelated tool never satisfies the guard", () => {
    expect(hasAuthoritativeMenuFactSource([outcome("get_cart", true)])).toBe(
      false,
    );
  });

  it("is false when the authoritative tool call FAILED — a failed call never counts as sourcing", () => {
    expect(
      hasAuthoritativeMenuFactSource([outcome("search_menu", false)]),
    ).toBe(false);
  });

  it("is true when an authoritative success is mixed in among other/failed calls", () => {
    expect(
      hasAuthoritativeMenuFactSource([
        outcome("get_cart", true),
        outcome("search_menu", false),
        outcome("get_menu_item", true),
      ]),
    ).toBe(true);
  });

  it("AUTHORITATIVE_MENU_TOOL_NAMES contains exactly the three authoritative tools", () => {
    expect([...AUTHORITATIVE_MENU_TOOL_NAMES].sort()).toEqual(
      ["get_menu_item", "get_restaurant_info", "search_menu"].sort(),
    );
  });

  it("accepts the order's own status for a wait-time question", () => {
    expect(
      hasAuthoritativeMenuFactSource([outcome("get_order_status", true)]),
    ).toBe(true);
    expect(
      hasAuthoritativeMenuFactSource([outcome("get_order_status", false)]),
    ).toBe(false);
    // ...without letting it back menu claims.
    expect(AUTHORITATIVE_MENU_TOOL_NAMES.has("get_order_status")).toBe(false);
  });
});
