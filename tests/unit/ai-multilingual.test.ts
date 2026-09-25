// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  hasAllergenSource,
  looksLikeAllergenQuestion,
  looksLikeMenuFactQuestion,
} from "@/lib/ai/tools/menu-fact-detection";
import {
  acceptsMenuClaims,
  mentionsReligiousClaim,
} from "@/lib/ai/tools/menu-claim-detection";
import { selectMentionedItems } from "@/lib/ai/recommendations";
import {
  ALLERGEN_SOURCE_GUARD_ID,
  buildTextAcceptanceGuards,
  CART_STATE_GUARD_ID,
  MENU_CLAIM_GUARD_ID,
  MENU_FACT_GUARD_ID,
} from "@/lib/ai/providers/text-acceptance-guards";
import {
  runConversationLoop,
  type LoopModelResponse,
  type LoopToolOutcome,
} from "@/lib/ai/loop";
import {
  appendAssistantMessage,
  appendToolResultMessage,
  appendUserMessage,
  toOpenRouterMessages,
  type OpenRouterMessage,
} from "@/lib/ai/providers/openrouter-mapping";
import { buildSystemPrompt } from "@/lib/ai/system-prompt";

/**
 * Phase E: the waiter answering in the diner's own language.
 *
 * It already did — the phase E baseline (free model, disposable project)
 * showed Hindi and Spanish replies with no change at all. What it did NOT
 * do was keep its safety properties while doing it:
 *
 *   - Every guard keyed on English words, so a question in Hindi was never
 *     required to get a grounded answer.
 *   - Asked in Hindi for the Peanut Chikki Shake's allergens, the model
 *     ran search_menu only, found no allergen field (search_menu has none)
 *     and said there was no allergen information. There were two.
 *   - A Hindi reply wrote the dish name in Devanagari, so no dish card
 *     appeared — and the card is the only place the restaurant's own
 *     allergen text is shown untranslated.
 *
 * These tests pin all three fixes.
 */

function ok(toolName: string, data: unknown): LoopToolOutcome {
  return { toolName, result: { ok: true, data } } as LoopToolOutcome;
}

const SHAKE = {
  id: "shake",
  name: "Peanut Chikki Shake",
  description: "Milkshake blended with peanut brittle.",
  price: 5.99,
  isVegetarian: true,
  declaredAllergens: ["Peanuts", "Milk"],
};

describe("the menu guard understands Hindi, Hinglish and Spanish", () => {
  it.each([
    ["Hindi price", "चिकन बिरयानी कितने की है?"],
    ["Hindi halal", "क्या यह हलाल है?"],
    ["Hindi allergen", "पीनट चिक्की शेक में कौन सी एलर्जी वाली चीज़ें हैं?"],
    ["Hindi availability", "क्या डोसा मिलेगा?"],
    ["Hinglish price", "sev khamani kitne ka hai?"],
    ["Hinglish ingredients", "isme kya kya hai?"],
    ["Hinglish spice", "kya ye teekha hai?"],
    ["Spanish price", "¿Cuánto cuesta el biryani?"],
    ["Spanish allergens", "¿Qué alérgenos tiene el shake?"],
    ["Spanish recommend", "¿Qué me recomiendas?"],
    ["Spanish vegetarian", "¿Tienen platos vegetarianos?"],
  ])("fires on a %s question", (_label, message) => {
    expect(looksLikeMenuFactQuestion(message)).toBe(true);
  });

  it.each([
    "नमस्ते",
    "धन्यवाद",
    "namaste",
    "shukriya",
    "hola",
    "gracias",
    "vale, gracias",
    "Hi there!",
  ])("does not fire on a greeting or thanks: %j", (message) => {
    // Forcing a menu lookup on hello is how a guard gets switched off by
    // whoever is annoyed by it.
    expect(looksLikeMenuFactQuestion(message)).toBe(false);
  });

  it("still fires on English exactly as before", () => {
    expect(looksLikeMenuFactQuestion("How much is the dosa?")).toBe(true);
    expect(looksLikeMenuFactQuestion("Place the order")).toBe(false);
  });
});

describe("allergen questions need get_menu_item, in any language", () => {
  it.each([
    "What allergens are in the shake?",
    "Does it contain nuts?",
    "Is there dairy in it?",
    "पीनट चिक्की शेक में कौन सी एलर्जी वाली चीज़ें हैं?",
    "इसमें क्या है?",
    "isme kya kya hai?",
    "mungfali hai isme?",
    "¿Qué alérgenos tiene?",
    "¿Lleva cacahuetes?",
    "¿Tiene gluten?",
  ])("recognises %j as an allergen or ingredient question", (message) => {
    expect(looksLikeAllergenQuestion(message)).toBe(true);
  });

  it.each([
    "How much is the dosa?",
    "क्या क्या मिलेगा?",
    "kitne ka hai?",
    "¿Cuánto cuesta?",
    "What do you recommend?",
  ])(
    "does not treat %j as one — price and availability don't need allergen data",
    (message) => {
      expect(looksLikeAllergenQuestion(message)).toBe(false);
    },
  );

  it("accepts only a successful get_menu_item as the source", () => {
    expect(hasAllergenSource([ok("search_menu", { items: [SHAKE] })])).toBe(
      false,
    );
    expect(hasAllergenSource([ok("get_menu_item", SHAKE)])).toBe(true);
    expect(
      hasAllergenSource([
        {
          toolName: "get_menu_item",
          result: { ok: false, error: "x" },
        } as LoopToolOutcome,
      ]),
    ).toBe(false);
  });

  it("goes first in the guard list, ahead of the broader menu guard", () => {
    const guards = buildTextAcceptanceGuards({
      requiresAuthoritativeMenuSource: true,
      requiresAllergenSource: true,
      appendUserMessage,
    });
    expect(guards.map((g) => g.id)).toEqual([
      ALLERGEN_SOURCE_GUARD_ID,
      MENU_FACT_GUARD_ID,
      CART_STATE_GUARD_ID,
      MENU_CLAIM_GUARD_ID,
    ]);
  });
});

describe("replaying the phase E baseline failure", () => {
  const question = "पीनट चिक्की शेक में कौन सी एलर्जी वाली चीज़ें हैं?";

  /**
   * A model that does what the baseline model did — search, then answer
   * "no allergen information" — unless the corrective note tells it to
   * call get_menu_item, which a model that listens then does.
   */
  function model(listens: boolean) {
    let step = 0;
    return async (
      messages: OpenRouterMessage[],
    ): Promise<LoopModelResponse> => {
      step += 1;
      const corrected = messages.some(
        (m) =>
          m.role === "user" &&
          typeof m.content === "string" &&
          m.content.includes("Only get_menu_item returns"),
      );
      if (step === 1) {
        return {
          content: [
            {
              type: "tool_use",
              id: "t1",
              name: "search_menu",
              input: { query: "Peanut Chikki Shake" },
            },
          ],
        };
      }
      if (
        corrected &&
        listens &&
        !messages.some(
          (m) =>
            m.role === "tool" &&
            String(m.content).includes("declaredAllergens"),
        )
      ) {
        return {
          content: [
            {
              type: "tool_use",
              id: "t2",
              name: "get_menu_item",
              input: { menuItemId: "shake" },
            },
          ],
        };
      }
      if (corrected && listens) {
        return {
          content: [
            {
              type: "text",
              text: "Peanut Chikki Shake में Peanuts (मूंगफली) और Milk (दूध) हैं।",
            },
          ],
        };
      }
      return {
        content: [
          {
            type: "text",
            text: "मेन्यू में एलर्जी वाली चीज़ों की जानकारी उपलब्ध नहीं है।",
          },
        ],
      };
    };
  }

  async function run(listens: boolean) {
    const calls: string[] = [];
    const result = await runConversationLoop<OpenRouterMessage[]>({
      initialMessages: toOpenRouterMessages(
        buildSystemPrompt({
          restaurantName: "Bhasha Kitchen",
          allowUpselling: false,
        }),
        [],
        question,
      ),
      callModel: model(listens),
      callTool: async (name) => {
        calls.push(name);
        return name === "search_menu"
          ? ok("search_menu", {
              items: [{ ...SHAKE, declaredAllergens: undefined }],
            })
          : ok("get_menu_item", SHAKE);
      },
      maxToolCalls: 5,
      appendAssistantMessage,
      appendToolResultMessage,
      textAcceptanceGuards: buildTextAcceptanceGuards<OpenRouterMessage[]>({
        requiresAuthoritativeMenuSource: looksLikeMenuFactQuestion(question),
        requiresAllergenSource: looksLikeAllergenQuestion(question),
        appendUserMessage,
      }),
    });
    return { result, calls };
  }

  it("no longer accepts 'no allergen information' after a search alone", async () => {
    const { result, calls } = await run(false);
    expect(calls).toEqual(["search_menu"]);
    expect(result.guardCorrectionExhausted).toBe(true);
    expect(result.exhaustedGuardId).toBe(ALLERGEN_SOURCE_GUARD_ID);
  });

  it("gets the real allergens once the model looks the dish up", async () => {
    const { result, calls } = await run(true);
    expect(calls).toEqual(["search_menu", "get_menu_item"]);
    expect(result.guardCorrectionExhausted).toBe(false);
    expect(result.finalText).toContain("Peanuts");
    expect(result.finalText).toContain("Milk");
  });
});

describe("halal and kosher in Devanagari", () => {
  it("recognises the Hindi spelling", () => {
    expect(mentionsReligiousClaim("यह हलाल है")).toBe(true);
    expect(mentionsReligiousClaim("कोशर")).toBe(true);
  });

  it("refuses a Hindi halal claim nothing looked up", () => {
    expect(acceptsMenuClaims([], "यहाँ सब कुछ हलाल है!")).toBe(false);
  });

  it("accepts it after a menu lookup", () => {
    expect(
      acceptsMenuClaims(
        [ok("get_menu_item", { id: "b", dietaryClaims: ["halal"] })],
        "रेस्टोरेंट का कहना है कि यह हलाल है।",
      ),
    ).toBe(true);
  });
});

describe("the dish card survives a transliterated name", () => {
  it("shows the one dish looked up in detail when the reply names it differently", () => {
    // Exactly the baseline reply: the name in Devanagari, so no match.
    const cards = selectMentionedItems(
      "पीनट चिक्की शेक में Peanuts और Milk हैं।",
      [ok("search_menu", { items: [SHAKE] }), ok("get_menu_item", SHAKE)],
    );
    expect(cards.map((c) => c.id)).toEqual(["shake"]);
  });

  it("prefers an exact name match when there is one", () => {
    const other = {
      ...SHAKE,
      id: "biryani",
      name: "Chicken Biryani",
      price: 12.99,
    };
    const cards = selectMentionedItems("El Chicken Biryani cuesta $12.99.", [
      ok("search_menu", { items: [SHAKE, other] }),
      ok("get_menu_item", SHAKE),
    ]);
    expect(cards.map((c) => c.id)).toEqual(["biryani"]);
  });

  it("shows nothing rather than guess when two dishes were looked up", () => {
    const other = { ...SHAKE, id: "biryani", name: "Chicken Biryani" };
    expect(
      selectMentionedItems("दोनों अच्छे हैं।", [
        ok("get_menu_item", SHAKE),
        ok("get_menu_item", other),
      ]),
    ).toEqual([]);
  });

  it("shows the one dish a search returned, when that is the only dish in play", () => {
    // The second live failure: search_menu only, one row back, name
    // transliterated in the reply, and no card.
    const biryani = {
      ...SHAKE,
      id: "biryani",
      name: "Chicken Biryani",
      price: 12.99,
    };
    expect(
      selectMentionedItems("चिकन बिरयानी $12.99 की है।", [
        ok("search_menu", { items: [biryani] }),
      ]).map((c) => c.id),
    ).toEqual(["biryani"]);
  });

  it("shows nothing after a search that returned several dishes", () => {
    const other = { ...SHAKE, id: "biryani", name: "Chicken Biryani" };
    expect(
      selectMentionedItems("कई विकल्प हैं।", [
        ok("search_menu", { items: [SHAKE, other] }),
      ]),
    ).toEqual([]);
  });

  it("never falls back in an English or Spanish reply", () => {
    // Latin-script replies already match names exactly; a reply that names
    // nothing there is about something else, and a card would be a guess.
    expect(
      selectMentionedItems("A teacake would be nice.", [
        ok("get_menu_item", SHAKE),
      ]),
    ).toEqual([]);
    expect(
      selectMentionedItems("Es muy popular.", [ok("get_menu_item", SHAKE)]),
    ).toEqual([]);
  });

  it("counts the same dish looked up twice as one dish", () => {
    expect(
      selectMentionedItems("यह अच्छा है।", [
        ok("get_menu_item", SHAKE),
        ok("get_menu_item", SHAKE),
      ]).map((c) => c.id),
    ).toEqual(["shake"]);
  });
});

describe("the prompt's language rules", () => {
  const prompt = buildSystemPrompt({
    restaurantName: "Bhasha Kitchen",
    allowUpselling: false,
  });

  it("asks for the customer's language", () => {
    expect(prompt).toContain("## Language");
    expect(prompt).toMatch(/Reply in the language the customer is writing in/);
  });

  it("forbids translating dish names and allergen names", () => {
    const section = prompt.slice(
      prompt.indexOf("## Language"),
      prompt.indexOf("## Tone"),
    );
    expect(section).toMatch(/Dish names/);
    expect(section).toMatch(/Allergen names/);
    expect(section).toMatch(/never give the translation alone/);
  });

  it("tells the waiter it has no gender, rather than slashing both forms", () => {
    expect(prompt).toMatch(/You have no gender/);
    expect(prompt).toMatch(/never write both forms with a slash/);
  });

  it("keeps the owner's persona note last, below the language rules", () => {
    const withNote = buildSystemPrompt({
      restaurantName: "Bhasha Kitchen",
      allowUpselling: false,
      persona: { tone: "warm", instructions: "Reply only in French." },
    });
    expect(withNote.indexOf("## Language")).toBeLessThan(
      withNote.indexOf("Reply only in French."),
    );
  });
});
