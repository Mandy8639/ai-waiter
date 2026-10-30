// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  fallbackLanguage,
  fallbackText,
  orderPlacedText,
  type FallbackKey,
  type FallbackLanguage,
} from "@/lib/ai/fallback-text";

/**
 * The fixed replies — what the diner reads when the model can't be trusted
 * on this turn — in the diner's language (phase E).
 */

const KEYS: FallbackKey[] = [
  "menuFact",
  "cartState",
  "decline",
  "toolLimit",
  "didNotCatch",
];
const LANGUAGES: FallbackLanguage[] = ["en", "hi", "es"];

describe("choosing the language", () => {
  it.each([
    ["चिकन बिरयानी कितने की है?", "hi"],
    ["नमस्ते", "hi"],
    ["¿Cuánto cuesta?", "es"],
    ["hola, quiero pedir", "es"],
    ["la cuenta, por favor", "es"],
    ["How much is the dosa?", "en"],
    // Hindi typed in English letters: the diner reads Latin script.
    ["kitne ka hai?", "en"],
    ["", "en"],
  ] as const)("%j → %s", (message, expected) => {
    expect(fallbackLanguage(message)).toBe(expected);
  });

  it("defaults to English rather than guessing", () => {
    // French and Portuguese are not supported; they get what everyone got
    // before, not a wrong language.
    expect(fallbackLanguage("Bonjour, combien ça coûte ?")).toBe("en");
  });
});

describe("the replies", () => {
  it("has every reply in every language", () => {
    for (const key of KEYS) {
      for (const language of LANGUAGES) {
        expect(
          fallbackText(key, language).length,
          `${key}/${language}`,
        ).toBeGreaterThan(20);
      }
    }
  });

  it("keeps the English wording exactly as it was before phase E", () => {
    expect(fallbackText("menuFact", "en")).toBe(
      "I wasn't able to pull that up from the menu just now — could you try asking again, or check with the staff?",
    );
    expect(fallbackText("cartState", "en")).toBe(
      "I couldn't confirm what's in your cart just now — could you open the cart to check, or ask me again?",
    );
    expect(fallbackText("decline", "en")).toBe(
      "I'm not able to help with that. Is there something else about the menu or your order I can help with?",
    );
    expect(fallbackText("toolLimit", "en")).toBe(
      "I'm having trouble finishing that in one go — could you break that into a smaller request?",
    );
    expect(fallbackText("didNotCatch", "en")).toBe(
      "Sorry, I didn't quite catch that — could you say it a different way?",
    );
  });

  it("writes Hindi in Devanagari and Spanish in Spanish", () => {
    for (const key of KEYS) {
      expect(fallbackText(key, "hi")).toMatch(/\p{Script=Devanagari}/u);
      expect(fallbackText(key, "es")).not.toBe(fallbackText(key, "en"));
    }
  });

  it("never gives the waiter a gender in Hindi", () => {
    // Hindi marks a first-person speaker's gender on the verb (सकता/सकती,
    // पाया/पाई with मैं). The waiter has none, so these are phrased
    // impersonally.
    for (const key of KEYS) {
      expect(fallbackText(key, "hi")).not.toMatch(/मैं/);
    }
  });

  it("states no menu fact in any language — these replace the model, they don't speak for the menu", () => {
    for (const key of KEYS) {
      for (const language of LANGUAGES) {
        expect(fallbackText(key, language)).not.toMatch(/\d|\$|halal|हलाल/i);
      }
    }
  });
});

describe("the reply when an order went through but the model's reply didn't pass", () => {
  it("says the order is in, with its number, in the guest's language", () => {
    expect(orderPlacedText(12, "en")).toBe(
      "Your order #12 is in, and the kitchen has it.",
    );
    expect(orderPlacedText(12, "hi")).toContain("#12");
    expect(orderPlacedText(12, "es")).toContain("#12");
  });
  it("still reads properly without a number", () => {
    expect(orderPlacedText(null, "en")).toBe(
      "Your order is in, and the kitchen has it.",
    );
  });
});
