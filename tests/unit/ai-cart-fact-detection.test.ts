import { describe, it, expect } from "vitest";
import type { LoopToolOutcome } from "@/lib/ai/loop";
import {
  looksLikeCartStateClaim,
  hasAuthoritativeCartStateSource,
  acceptsCartStateClaim,
} from "@/lib/ai/tools/cart-fact-detection";

const ok = (toolName: string): LoopToolOutcome => ({
  toolName,
  result: { ok: true, data: {} },
});
const failed = (toolName: string): LoopToolOutcome => ({
  toolName,
  result: { ok: false, error: "nope" },
});

describe("looksLikeCartStateClaim", () => {
  it("flags the exact reply that motivated this guard", () => {
    // Observed in production: the cart held one item, not two. The model
    // was reasoning from an earlier turn's fabricated "Added…" message.
    expect(
      looksLikeCartStateClaim(
        "Done — you now have two chicken tikka masala in your order. Anything else?",
      ),
    ).toBe(true);
  });

  it.each([
    "Your total is $19.99.",
    "That brings your total to $24.98.",
    "Your cart has two dosas and a chai.",
    "You have 3 items in your cart.",
    "You'll have two of those in your order.",
    "There's a masala dosa in your cart already.",
  ])("flags aggregate cart-state claim: %s", (text) => {
    expect(looksLikeCartStateClaim(text)).toBe(true);
  });

  it.each([
    // Justified by add_item_to_cart succeeding — a claim about the action,
    // not about what the cart now holds.
    "Added one chicken tikka masala ($19.99) to your order.",
    "Done, I've added that for you.",
    // Ordinary waiter conversation a bare /you have/ pattern would break.
    "Do you have any allergies I should know about?",
    "Do you have a preference between the two?",
    "Sure — what size would you like?",
    "I couldn't find a papad on the menu. Want me to double-check?",
    "The chicken tikka masala is $19.99.",
  ])("does not flag: %s", (text) => {
    expect(looksLikeCartStateClaim(text)).toBe(false);
  });
});

describe("hasAuthoritativeCartStateSource", () => {
  it("accepts a successful get_cart", () => {
    expect(hasAuthoritativeCartStateSource([ok("get_cart")])).toBe(true);
  });

  it("rejects a failed get_cart", () => {
    expect(hasAuthoritativeCartStateSource([failed("get_cart")])).toBe(false);
  });

  it("rejects cart mutations — none of them return the resulting cart", () => {
    expect(
      hasAuthoritativeCartStateSource([
        ok("add_item_to_cart"),
        ok("update_cart_item"),
        ok("remove_cart_item"),
        ok("clear_cart"),
      ]),
    ).toBe(false);
  });

  it("rejects menu tools", () => {
    expect(
      hasAuthoritativeCartStateSource([ok("search_menu"), ok("get_menu_item")]),
    ).toBe(false);
  });
});

describe("acceptsCartStateClaim", () => {
  it("rejects the production failure: a count claim backed only by an add", () => {
    expect(
      acceptsCartStateClaim(
        [ok("search_menu"), ok("get_menu_item"), ok("add_item_to_cart")],
        "Done — you now have two chicken tikka masala in your order.",
      ),
    ).toBe(false);
  });

  it("accepts the same claim once get_cart has been read this turn", () => {
    expect(
      acceptsCartStateClaim(
        [ok("add_item_to_cart"), ok("get_cart")],
        "Done — you now have two chicken tikka masala in your order.",
      ),
    ).toBe(true);
  });

  it("accepts a reply making no cart-state claim, with no tools at all", () => {
    expect(acceptsCartStateClaim([], "Sure — what size would you like?")).toBe(
      true,
    );
  });

  it("accepts confirming an add without reading the cart back", () => {
    expect(
      acceptsCartStateClaim(
        [ok("add_item_to_cart")],
        "Added one chicken tikka masala ($19.99) to your order.",
      ),
    ).toBe(true);
  });
});
