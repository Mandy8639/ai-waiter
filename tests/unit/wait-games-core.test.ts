import { describe, expect, it } from "vitest";
import {
  MATCH_PAIRS,
  buildMatchDeck,
  buildQuiz,
  showWaitGames,
  type GameDish,
} from "@/lib/wait-games/core";

function dish(id: string, over: Partial<GameDish> = {}): GameDish {
  return {
    id,
    name: `Dish ${id}`,
    category: "Mains",
    isVegan: false,
    isVegetarian: false,
    spiceLevel: null,
    prepMinutes: null,
    photoUrl: `https://img.test/${id}.webp`,
    ...over,
  };
}

// A menu shaped like Lantern Table's.
const MENU: GameDish[] = [
  dish("soup", {
    category: "Small plates",
    isVegan: true,
    isVegetarian: true,
    spiceLevel: "none",
    prepMinutes: 5,
  }),
  dish("wings", {
    category: "Small plates",
    spiceLevel: "hot",
    prepMinutes: 14,
  }),
  dish("ribs", { category: "Mains", spiceLevel: "none", prepMinutes: 15 }),
  dish("curry", {
    category: "Mains",
    isVegetarian: true,
    spiceLevel: "medium",
    prepMinutes: 15,
  }),
  dish("veg-curry", {
    category: "Mains",
    isVegan: true,
    isVegetarian: true,
    spiceLevel: "mild",
    prepMinutes: 12,
  }),
  dish("salmon", { category: "Mains", spiceLevel: "none", prepMinutes: 16 }),
  dish("sorbet", {
    category: "Desserts",
    isVegan: true,
    isVegetarian: true,
    spiceLevel: "none",
    prepMinutes: 2,
  }),
  dish("lassi", {
    category: "Drinks",
    isVegetarian: true,
    spiceLevel: "none",
    prepMinutes: 3,
  }),
];
const byId = new Map(MENU.map((d) => [d.id, d]));
const RANK: Record<string, number> = { none: 0, mild: 1, medium: 2, hot: 3 };

describe("buildQuiz", () => {
  it("asks three questions with three options and one right answer each", () => {
    const quiz = buildQuiz(MENU, "order-1");
    expect(quiz).toHaveLength(3);
    for (const q of quiz) {
      expect(q.options).toHaveLength(3);
      expect(new Set(q.options.map((o) => o.id)).size).toBe(3);
      expect(q.options.some((o) => o.id === q.answerId)).toBe(true);
    }
  });

  it("is the same quiz on every reload of the same order", () => {
    expect(buildQuiz(MENU, "order-1")).toEqual(buildQuiz(MENU, "order-1"));
  });

  it("always gives answers that are true of the menu", () => {
    for (let i = 0; i < 50; i++) {
      for (const q of buildQuiz(MENU, `order-${i}`)) {
        const answer = byId.get(q.answerId)!;
        const others = q.options
          .filter((o) => o.id !== q.answerId)
          .map((o) => byId.get(o.id)!);
        if (q.id === "vegan") {
          expect(answer.isVegan).toBe(true);
          for (const o of others) expect(o.isVegetarian).toBe(false);
        }
        if (q.id === "spiciest") {
          for (const o of others)
            expect(RANK[answer.spiceLevel!]).toBeGreaterThan(
              RANK[o.spiceLevel!],
            );
        }
        if (q.id === "fastest") {
          for (const o of others)
            expect(answer.prepMinutes!).toBeLessThan(o.prepMinutes!);
        }
        if (q.id === "section") {
          const category = q.question.match(/under (.+)\?$/)![1];
          expect(answer.category).toBe(category);
          for (const o of others) expect(o.category).not.toBe(category);
        }
      }
    }
  });

  it("asks fewer questions when the menu can't support them, never wrong ones", () => {
    const tiny = [dish("a"), dish("b")];
    expect(buildQuiz(tiny, "x")).toEqual([]);
  });

  it("never asks about allergens", () => {
    for (let i = 0; i < 20; i++) {
      for (const q of buildQuiz(MENU, `o${i}`)) {
        expect(q.question).not.toMatch(/allerg|nut|milk|gluten|dairy/i);
      }
    }
  });
});

describe("buildMatchDeck", () => {
  it("deals each dish twice, shuffled", () => {
    const deck = buildMatchDeck(MENU, "order-1")!;
    expect(deck).toHaveLength(MATCH_PAIRS * 2);
    const counts = new Map<string, number>();
    for (const c of deck) counts.set(c.dishId, (counts.get(c.dishId) ?? 0) + 1);
    expect([...counts.values()].every((n) => n === 2)).toBe(true);
    expect(new Set(deck.map((c) => c.key)).size).toBe(deck.length);
  });

  it("needs enough photos", () => {
    const fewPhotos = MENU.map((d, i) =>
      i < 3 ? d : { ...d, photoUrl: null },
    );
    expect(buildMatchDeck(fewPhotos, "x")).toBeNull();
  });
});

describe("showWaitGames", () => {
  it("shows from ordering until the food is served", () => {
    for (const s of ["pending", "confirmed", "preparing", "ready"])
      expect(showWaitGames(s)).toBe(true);
    for (const s of ["served", "cancelled"])
      expect(showWaitGames(s)).toBe(false);
  });
});
