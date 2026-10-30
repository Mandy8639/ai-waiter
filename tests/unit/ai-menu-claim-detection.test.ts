// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { LoopToolOutcome } from "@/lib/ai/loop";
import {
  acceptsMenuClaims,
  cleanReplyForGuest,
  extractPriceAmounts,
  mentionsReligiousClaim,
  promisesSafety,
  quotesWrongCurrency,
} from "@/lib/ai/tools/menu-claim-detection";

/**
 * The reply-side menu-claim guard.
 *
 * Most of these are false-positive tests, and that balance is deliberate.
 * A false positive here is not harmless: it costs a corrective model call,
 * and if the model doesn't comply the customer gets "I wasn't able to pull
 * that up" in place of a perfectly good answer. So the question this file
 * asks most often is "does an ordinary waiter reply get through?".
 */

function ok(toolName: string, data: unknown): LoopToolOutcome {
  return { toolName, result: { ok: true, data } } as LoopToolOutcome;
}
function failed(toolName: string): LoopToolOutcome {
  return { toolName, result: { ok: false, error: "nope" } } as LoopToolOutcome;
}

const biryaniSearch = ok("search_menu", {
  currency: "USD",
  items: [
    { id: "b1", name: "Chicken biryani", price: 12.99, dietaryClaims: [] },
  ],
});

describe("finding prices in a reply", () => {
  it.each([
    ["The biryani is $12.99.", [12.99]],
    ["That's $ 8 each.", [8]],
    ["It comes to USD 9.99", [9.99]],
    ["It comes to 9.99 USD", [9.99]],
    ["₹150 for the thali", [150]],
    ["150 rupees", [150]],
    ["€7,50 please", [7.5]],
    ["Extra cheese is +$1.50", [1.5]],
    ["$12.99 and $3.50", [12.99, 3.5]],
  ])("finds the amount in %j", (text, expected) => {
    expect(extractPriceAmounts(text)).toEqual(expected);
  });

  it.each([
    "Two dosas coming up.",
    "It usually takes about 15 minutes.",
    "You're at table 4.",
    "That's 350 calories.",
    "We add an 18% service charge.",
    "Order #1042 is being prepared.",
    "It serves 2 people.",
  ])("ignores a number that is not a price: %j", (text) => {
    expect(extractPriceAmounts(text)).toEqual([]);
  });
});

describe("prices must be backed by a tool result from this turn", () => {
  it("accepts a reply with no price at all, with no tools", () => {
    expect(acceptsMenuClaims([], "Sure — what size would you like?")).toBe(
      true,
    );
  });

  it("accepts the price the search just returned", () => {
    expect(
      acceptsMenuClaims([biryaniSearch], "The chicken biryani is $12.99."),
    ).toBe(true);
  });

  it("refuses a price the search did NOT return, even though a search ran", () => {
    // The stale-note case: the menu says 12.99, the owner's note still says 1.
    expect(
      acceptsMenuClaims([biryaniSearch], "The biryani is only $1 today!"),
    ).toBe(false);
  });

  it("refuses a price with no tool at all", () => {
    expect(acceptsMenuClaims([], "Welcome! Our thali is only $12.")).toBe(
      false,
    );
  });

  it("refuses a price after a failed search", () => {
    expect(
      acceptsMenuClaims([failed("search_menu")], "The biryani is $12.99."),
    ).toBe(false);
  });

  it("refuses a price after only adding to the cart, which returns no price", () => {
    // add_item_to_cart returns { added: true } — it proves the add, not a
    // price. The price has to come from a read.
    expect(
      acceptsMenuClaims(
        [ok("add_item_to_cart", { added: true })],
        "Added — that's $12.99.",
      ),
    ).toBe(false);
  });

  it("accepts cart totals read back with get_cart", () => {
    const cart = ok("get_cart", {
      lines: [{ name: "Dosa", quantity: 2, unitPrice: 8.99, lineTotal: 17.98 }],
      subtotal: 17.98,
      taxAmount: 1.44,
      total: 19.42,
    });
    expect(
      acceptsMenuClaims(
        [cart],
        "Two dosas, $17.98, plus $1.44 tax: $19.42 in total.",
      ),
    ).toBe(true);
  });

  it("accepts a modifier's price adjustment", () => {
    const item = ok("get_menu_item", {
      price: 10,
      modifierGroups: [
        { options: [{ name: "Extra cheese", priceAdjustment: 1.5 }] },
      ],
    });
    expect(
      acceptsMenuClaims([item], "It's $10, or +$1.50 with extra cheese."),
    ).toBe(true);
  });

  it("accepts a price the tool returned as a numeric string", () => {
    expect(
      acceptsMenuClaims(
        [ok("get_menu_item", { price: "12.99" })],
        "It's $12.99.",
      ),
    ).toBe(true);
  });

  it("refuses arithmetic the model did itself", () => {
    // "Two would be $25.98" — no tool returned 25.98. A model's own sums
    // are exactly the kind of number that is confidently wrong.
    expect(
      acceptsMenuClaims([biryaniSearch], "Two biryanis would be $25.98."),
    ).toBe(false);
  });
});

describe("halal and kosher need a menu tool call this turn", () => {
  it("accepts the correct phase B answer, which contains the word", () => {
    // "Doesn't say" is right, and it says "halal". A wording check would
    // refuse it; the source check does not, because the model looked.
    const item = ok("get_menu_item", { name: "Lamb curry", dietaryClaims: [] });
    expect(
      acceptsMenuClaims(
        [item],
        "The menu doesn't say whether the lamb curry is halal — please check with staff.",
      ),
    ).toBe(true);
  });

  it("accepts an attributed claim after looking the dish up", () => {
    const item = ok("get_menu_item", {
      name: "Biryani",
      dietaryClaims: ["halal"],
    });
    expect(
      acceptsMenuClaims([item], "The restaurant says the biryani is halal."),
    ).toBe(true);
  });

  it("refuses 'everything here is halal' with no menu tool at all", () => {
    expect(acceptsMenuClaims([], "Welcome! Everything here is halal.")).toBe(
      false,
    );
    expect(acceptsMenuClaims([], "Yes, our kitchen is fully kosher.")).toBe(
      false,
    );
  });

  it("refuses the claim when only the cart was read", () => {
    expect(
      acceptsMenuClaims(
        [ok("get_cart", { lines: [] })],
        "Your order is all halal.",
      ),
    ).toBe(false);
  });

  it("refuses the claim after a failed menu call", () => {
    expect(acceptsMenuClaims([failed("get_menu_item")], "It's halal.")).toBe(
      false,
    );
  });

  it("matches the word, not substrings or case", () => {
    expect(mentionsReligiousClaim("HALAL")).toBe(true);
    expect(mentionsReligiousClaim("Kosher-style")).toBe(true);
    expect(mentionsReligiousClaim("We have vegetarian options.")).toBe(false);
  });

  it("leaves vegetarian and vegan to the other guards", () => {
    // Conventional labels, said constantly in ordinary chat. Flagging them
    // here would turn every greeting into a corrective round.
    expect(
      acceptsMenuClaims(
        [],
        "Welcome! We have lots of vegetarian and vegan dishes.",
      ),
    ).toBe(true);
  });
});

describe("both checks together", () => {
  it("needs both to pass", () => {
    const item = ok("get_menu_item", {
      price: 12.99,
      dietaryClaims: ["halal"],
    });
    expect(
      acceptsMenuClaims(
        [item],
        "The restaurant says it's halal, and it's $12.99.",
      ),
    ).toBe(true);
    expect(acceptsMenuClaims([item], "It's halal, and only $5!")).toBe(false);
  });
});

describe("the currency a reply quotes", () => {
  // A Hinglish guest at a USD restaurant was quoted ₹28.79 (2026-10-30).
  const cart = (currency = "USD") =>
    [
      {
        toolName: "get_cart",
        result: { ok: true, data: { currency, subtotal: 27, total: 28.79 } },
      },
    ] as unknown as LoopToolOutcome[];

  it("refuses rupees at a dollar restaurant, even with the right numbers", () => {
    expect(quotesWrongCurrency(cart(), "Total: ₹28.79")).toBe(true);
    expect(quotesWrongCurrency(cart(), "Total: Rs. 28.79")).toBe(true);
    expect(quotesWrongCurrency(cart(), "That's 28.79 rupees")).toBe(true);
    expect(acceptsMenuClaims(cart(), "Total: ₹28.79")).toBe(false);
  });

  it("accepts the restaurant's own currency", () => {
    expect(acceptsMenuClaims(cart(), "Total: $28.79")).toBe(true);
    expect(acceptsMenuClaims(cart("INR"), "Total: ₹28.79")).toBe(true);
    expect(acceptsMenuClaims(cart("CAD"), "Total: $28.79")).toBe(true);
  });

  it("finds a currency however deep the tool put it", () => {
    const nested = [
      {
        toolName: "search_menu",
        result: { ok: true, data: { items: [{ price: 5, currency: "USD" }] } },
      },
    ] as unknown as LoopToolOutcome[];
    expect(quotesWrongCurrency(nested, "It's €5")).toBe(true);
  });

  it("leaves a reply alone when no tool stated a currency, or no price is quoted", () => {
    expect(quotesWrongCurrency([], "Total: ₹28.79")).toBe(false);
    expect(
      quotesWrongCurrency(cart(), "Sorry, we only take dollars here."),
    ).toBe(false);
  });

  it("ignores a failed tool", () => {
    const failed = [
      { toolName: "get_cart", result: { ok: false, error: "x" } },
    ] as unknown as LoopToolOutcome[];
    expect(quotesWrongCurrency(failed, "Total: ₹28.79")).toBe(false);
  });
});

describe("the last clean-up before a guest reads a reply", () => {
  const id = "ef85e313-deb1-428a-a951-5a0f7f00ea3d";

  it.each([
    [
      `I found the Butter Chicken (ID: ${id}), but it has dairy.`,
      "I found the Butter Chicken, but it has dairy.",
    ],
    [`Your order is placed! Order ID: ${id}`, "Your order is placed!"],
    [`Removed item ${id} from your cart.`, "Removed item from your cart."],
    [
      "Order #1 (ID cf9ea6ca\u2011d40d\u20114d00\u20119315\u2011601745970e20) has been placed.",
      "Order #1 has been placed.",
    ],
  ])("removes raw ids: %s", (before, after) => {
    expect(cleanReplyForGuest(before)).toBe(after);
  });

  it.each([
    ["Tax (7.9%): $0.80", "Tax: $0.80"],
    ["Tax 7.9%: $0.80", "Tax: $0.80"],
    [
      "Subtotal: $12.00\nTax (6.625%) – $0.80\nTotal – $12.80",
      "Subtotal: $12.00\nTax – $0.80\nTotal – $12.80",
    ],
  ])("removes a tax percentage the model worked out: %s", (before, after) => {
    expect(cleanReplyForGuest(before)).toBe(after);
  });

  it("leaves normal replies alone, line breaks included", () => {
    const reply =
      "Here's your order:\n\n1 × Chicken 65 — $12.00\n\nOrder #12 is on its way.";
    expect(cleanReplyForGuest(reply)).toBe(reply);
    expect(
      cleanReplyForGuest("We add 20% off? No, there are no discounts."),
    ).toBe("We add 20% off? No, there are no discounts.");
  });
});

describe("telling a guest a dish is safe for them", () => {
  it.each([
    "I found several dishes that are safe for you to eat, plus some to be cautious about:",
    "These are safe to eat with a dairy allergy.",
    "The Samosa is safe for your dairy allergy.",
    "Chicken 65 is fine for you.",
  ])("refuses: %s", (reply) => {
    expect(promisesSafety(reply)).toBe(true);
    expect(acceptsMenuClaims([], reply)).toBe(false);
  });

  it.each([
    "I can't say whether it's safe for you, so please check with staff.",
    "The restaurant hasn't confirmed it's safe for you.",
    "If it's not safe for you, tell the staff.",
    "These aren't marked as containing dairy. Please confirm with staff before ordering.",
    "Is this still okay for you to order? It contains dairy.",
  ])("accepts: %s", (reply) => {
    expect(promisesSafety(reply)).toBe(false);
  });
});
