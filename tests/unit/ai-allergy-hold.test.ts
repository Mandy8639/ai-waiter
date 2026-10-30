import { describe, expect, it } from "vitest";
import {
  acceptsAllergyHold,
  addedToCart,
  allergyHoldResult,
  allergyHoldText,
  decideAllergyHold,
  holdsIn,
  statedAllergies,
} from "@/lib/ai/tools/allergy-hold";
import { buildMenuGraph } from "@/lib/menu-graph/core";

// The allergy hold (src/lib/ai/tools/allergy-hold.ts): a dish flagged for
// something the guest said they must avoid doesn't go in the cart until
// they've been told and said yes in a later message.

const dish = (id: string, name: string, flags: object = {}) => ({
  id,
  name,
  price: 15,
  sectionId: "mains",
  isVegetarian: false,
  isVegan: false,
  isHalal: false,
  isKosher: false,
  isSpicy: false,
  containsNuts: false,
  containsDairy: false,
  containsGluten: false,
  ...flags,
});

const graph = buildMenuGraph({
  currency: "USD",
  sections: [{ id: "mains", name: "Mains" }],
  dishes: [
    dish("butter", "Butter Chicken", { containsDairy: true }),
    dish("paneer", "Paneer Tikka"),
    dish("c65", "Chicken 65"),
  ],
  ingredients: [],
  allergens: [],
  pairings: [],
});

const decide = (
  menuItemId: string,
  userMessages: string[],
  guestAccepted = false,
  earlierCalls: { content: string; createdAt: string }[] = [],
  lastWaiterReply: string | null = null,
) =>
  decideAllergyHold({
    graph,
    userMessages,
    menuItemId,
    guestAccepted,
    earlierCalls,
    lastWaiterReply,
  });

const heldEarlier = (id: string) => {
  const hold = decide(id, ["I'm allergic to dairy"])!;
  return [
    {
      content: JSON.stringify({ ok: true, data: allergyHoldResult(hold) }),
      createdAt: "2026-10-30T12:00:00Z",
    },
  ];
};

describe("what counts as a stated allergy", () => {
  it.each([
    ["I'm allergic to dairy", ["dairy"]],
    ["my son has a peanut allergy", ["peanuts"]],
    ["I am lactose intolerant", ["dairy"]],
    ["I have celiac", ["gluten"]],
    ["I can't have milk or peanuts", ["dairy", "peanuts"]],
    ["no nuts please", ["nuts"]],
    ["I need dairy-free food", ["dairy"]],
    ["mujhe doodh se allergy hai", ["dairy"]],
    ["anda nahi khata", ["egg"]],
    ["मुझे मूंगफली से एलर्जी है", ["peanuts"]],
    ["No, I'm allergic to nuts", ["nuts"]],
    ["no I'm allergic to nuts", ["nuts"]],
    ["I can eat anything except I'm allergic to dairy", ["dairy"]],
  ])("%s", (message, groups) => {
    expect(statedAllergies([message])).toEqual(groups);
  });

  it.each([
    "Does this have nuts?",
    "what's in the butter chicken, is there dairy?",
    "I'll have the butter chicken",
    "I'm not allergic to anything",
    "I don't have any allergies",
    "I love dairy",
  ])("not a statement: %s", (message) => {
    expect(statedAllergies([message])).toEqual([]);
  });

  it("takes one back only when the guest plainly says so", () => {
    expect(
      statedAllergies([
        "I'm allergic to nuts",
        "actually I'm not allergic to nuts",
      ]),
    ).toEqual([]);
    expect(
      statedAllergies(["I'm allergic to nuts and dairy", "no nut allergy"]),
    ).toEqual(["dairy"]);
  });

  it("keeps the half that matters when a sentence says two things", () => {
    expect(
      statedAllergies(["I'm not allergic to dairy but I am allergic to nuts"]),
    ).toEqual(["nuts"]);
  });
});

describe("the hold", () => {
  it("holds a dish flagged for what the guest said, naming the allergen", () => {
    const hold = decide("butter", ["I'm allergic to dairy and shellfish"]);
    expect(hold).toMatchObject({
      menuItemId: "butter",
      dish: "Butter Chicken",
      groups: ["dairy"],
      allergens: ["Dairy"],
    });
    expect(hold!.reasons[0]).toMatch(/^Dairy:/);
  });

  it("holds on what a name suggests, not only what's marked", () => {
    expect(decide("paneer", ["I'm allergic to dairy"])).not.toBeNull();
  });

  it("reads an allergy from any earlier message", () => {
    expect(
      decide("butter", [
        "I'm allergic to dairy",
        "hi",
        "butter chicken please",
      ]),
    ).not.toBeNull();
  });

  it("leaves everything alone with no allergy, or a dish with no flag", () => {
    expect(decide("butter", ["butter chicken please"])).toBeNull();
    expect(decide("c65", ["I'm allergic to dairy"])).toBeNull();
    expect(decide("not-a-dish", ["I'm allergic to dairy"])).toBeNull();
  });

  it("refuses the guest's yes on the same turn as the first try", () => {
    expect(decide("butter", ["I'm allergic to dairy"], true)).not.toBeNull();
  });

  it("refuses a yes for a different dish's hold", () => {
    expect(
      decide("butter", ["I'm allergic to dairy"], true, heldEarlier("paneer")),
    ).not.toBeNull();
  });

  it("refuses an earlier hold unless the guest accepted", () => {
    expect(
      decide("butter", ["I'm allergic to dairy"], false, heldEarlier("butter")),
    ).not.toBeNull();
  });

  it("adds it once the same dish was held earlier and the guest said yes", () => {
    expect(
      decide("butter", ["I'm allergic to dairy"], true, heldEarlier("butter")),
    ).toBeNull();
  });

  it("finds that hold behind later calls for other dishes", () => {
    const later = {
      content: JSON.stringify({ ok: true, data: { added: true } }),
      createdAt: "2026-10-30T12:01:00Z",
    };
    expect(
      decide("butter", ["I'm allergic to dairy"], true, [
        later,
        ...heldEarlier("butter"),
        { content: "cut off mid-{", createdAt: "2026-10-30T11:00:00Z" },
      ]),
    ).toBeNull();
  });

  describe("when the waiter warned before the tool ever held it", () => {
    const yes = (reply: string, accepted = true) =>
      decide("butter", ["I'm allergic to dairy"], accepted, [], reply);

    it.each([
      "I'm sorry, but **Butter Chicken contains dairy**. Still want it?",
      "The Butter Chicken is made with cream and the restaurant marks it as dairy. Add it anyway?",
      "Butter Chicken में **दूध (dairy)** है। क्या आप फिर भी लेना चाहेंगे?",
    ])("counts: %s", (reply) => {
      expect(yes(reply)).toBeNull();
    });

    it("doesn't count a warning without the guest's yes", () => {
      expect(yes("Butter Chicken contains dairy.", false)).not.toBeNull();
    });

    it.each([
      // A list isn't a warning about the dish they just asked for.
      "Avoid these, they contain dairy:\n- Butter Chicken\n- Paneer Tikka",
      "Great choice, the Butter Chicken is popular.",
      "Paneer Tikka contains dairy.",
    ])("doesn't count: %s", (reply) => {
      expect(yes(reply)).not.toBeNull();
    });
  });

  describe("the guest's own words", () => {
    const after = (message: string, accepted = false) =>
      decide(
        "butter",
        ["I'm allergic to dairy", "butter chicken please", message],
        accepted,
        heldEarlier("butter"),
      );

    it.each([
      "yes",
      "Add it anyway please",
      "I understand, I still want it",
      "haan",
      "हाँ",
    ])("accepts without the model's flag: %s", (message) => {
      expect(after(message)).toBeNull();
    });

    it.each(["no thanks", "No", "never mind", "नहीं", "nahi"])(
      "a plain no beats the model's flag: %s",
      (message) => {
        expect(after(message, true)).not.toBeNull();
      },
    );

    it("a yes means nothing if they were never told", () => {
      expect(decide("butter", ["I'm allergic to dairy", "yes"])).not.toBeNull();
    });
  });

  it("logs as a success that says it wasn't added", () => {
    const result = allergyHoldResult(decide("butter", ["allergic to dairy"])!);
    expect(result).toMatchObject({ added: false, heldForAllergy: true });
    expect(result.instruction).toMatch(/NOT added/);
  });
});

describe("the reply on a turn with a hold", () => {
  const outcome = (id: string) => ({
    toolName: "add_item_to_cart",
    result: {
      ok: true,
      data: allergyHoldResult(decide(id, ["I'm allergic to dairy"])!),
    },
  });
  const held = [outcome("butter")];

  it.each([
    "The Butter Chicken has dairy. Do you still want it?",
    "Heads up: that one contains milk. Want something else?",
    "With your allergy I held off on that one. Still want it?",
    "I added the Naan, but the Butter Chicken has dairy, so I held off.",
    "बटर चिकन में दूध है। क्या आप फिर भी लेना चाहेंगे?",
  ])("accepts: %s", (reply) => {
    expect(acceptsAllergyHold(held, reply)).toBe(true);
  });

  it.each([
    "Great choice!",
    "I've added the Butter Chicken to your cart.",
    "I've added the Butter Chicken, though it has dairy.",
    "The Butter Chicken has dairy and is now in your cart.",
    "Butter Chicken add kar diya, it has dairy",
    "",
  ])("rejects: %s", (reply) => {
    expect(acceptsAllergyHold(held, reply)).toBe(false);
  });

  it("accepts anything on a turn with no hold", () => {
    expect(
      acceptsAllergyHold(
        [
          {
            toolName: "add_item_to_cart",
            result: { ok: true, data: { added: true } },
          },
        ],
        "Added!",
      ),
    ).toBe(true);
    expect(acceptsAllergyHold([], "Hello")).toBe(true);
  });

  it("has to cover every dish held", () => {
    const both = [outcome("butter"), outcome("paneer")];
    expect(holdsIn(both)).toHaveLength(2);
    expect(allergyHoldText(holdsIn(both), "en")).toMatch(
      /Butter Chicken, Paneer Tikka.*Dairy/,
    );
  });

  it("doesn't mistake a held dish for an added one", () => {
    expect(addedToCart(held)).toBe(false);
    expect(
      addedToCart([
        {
          toolName: "add_item_to_cart",
          result: { ok: true, data: { added: true } },
        },
      ]),
    ).toBe(true);
  });

  it("counts one dish held twice in a turn once", () => {
    expect(holdsIn([outcome("butter"), outcome("butter")])).toHaveLength(1);
  });

  it.each(["en", "hi", "es"] as const)(
    "the fixed reply in %s passes its own check",
    (language) => {
      const text = allergyHoldText(holdsIn(held), language);
      expect(text).toContain("Butter Chicken");
      expect(text).toContain("Dairy");
      expect(acceptsAllergyHold(held, text)).toBe(true);
    },
  );
});
