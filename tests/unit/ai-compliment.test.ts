import { describe, expect, it } from "vitest";
import { complimentReply, isOnlyCompliment } from "@/lib/ai/compliment-core";

/**
 * 2026-10-20: "I like the food here" after an order got the menu pitched
 * back. A message that is only kind gets a fixed reply; anything that asks
 * for something or isn't wholly happy still goes to the waiter model.
 */
describe("isOnlyCompliment", () => {
  it.each([
    "I like the food here",
    "that was delicious, thanks!",
    "Thanks",
    "thank you so much",
    "Loved it 😊",
    "great food",
    "khana bahut accha tha",
    "धन्यवाद",
    "खाना बहुत स्वादिष्ट था",
    "¡Muy rico, gracias!",
  ])("takes %j as a compliment", (m) => {
    expect(isOnlyCompliment(m)).toBe(true);
  });

  it.each([
    "loved the naan, can we get two more?",
    "thanks, the bill please",
    "the food was good but cold",
    "not great tbh",
    "no thanks",
    "what's good here?",
    "I like spicy food, what do you recommend",
    "thanks! add a mango lassi",
    "great, is there anything vegan?",
    "khana accha tha lekin thanda tha",
    // Orders that use "like" (found by evals/: the first was swallowed).
    "I'd like the chicken biryani",
    "I’d like the paneer tikka",
    "I'll have the dosa, I love dosa",
    "id like a mango lassi",
    "I would like the lamb",
    "I'd love two chai",
    "hello",
    "",
    "Thanks for everything, the dinner was wonderful and the staff were so kind to my mother on her birthday tonight",
  ])("leaves %j to the waiter model", (m) => {
    expect(isOnlyCompliment(m)).toBe(false);
  });
});

describe("complimentReply", () => {
  it("thanks the diner and offers the bill or staff, never food", () => {
    for (const lang of ["en", "hi", "es"] as const) {
      const reply = complimentReply(lang);
      expect(reply.length).toBeGreaterThan(0);
      expect(reply).not.toMatch(/drink|dessert|menu|order/i);
    }
    expect(complimentReply("en")).toMatch(/bill/);
  });
});
