import { describe, expect, it } from "vitest";
import {
  isFeedbackState,
  parseFeedback,
  summarizeFeedback,
  tallyDishes,
} from "@/lib/feedback/core";

describe("parseFeedback", () => {
  const items = ["i1", "i2"];

  it("accepts a rating, trims the comment, and keeps votes for this order's dishes", () => {
    expect(
      parseFeedback(
        {
          rating: 4,
          comment: "  Great chutney  ",
          votes: { i1: true, i2: false },
        },
        items,
      ),
    ).toEqual({
      ok: true,
      value: {
        rating: 4,
        comment: "Great chutney",
        votes: { i1: true, i2: false },
      },
    });
  });

  it("treats a blank comment as none and skips non-boolean votes", () => {
    expect(
      parseFeedback({ rating: 5, comment: "   ", votes: { i1: "yes" } }, items),
    ).toEqual({ ok: true, value: { rating: 5, comment: null, votes: {} } });
  });

  it("refuses ratings outside 1–5, long comments and votes for other dishes", () => {
    for (const rating of [0, 6, 2.5, "x", null]) {
      expect(
        parseFeedback({ rating, comment: null, votes: {} }, items).ok,
      ).toBe(false);
    }
    expect(
      parseFeedback({ rating: 3, comment: "x".repeat(1001), votes: {} }, items)
        .ok,
    ).toBe(false);
    expect(
      parseFeedback({ rating: 3, comment: null, votes: { other: true } }, items)
        .ok,
    ).toBe(false);
  });
});

describe("isFeedbackState", () => {
  it("knows the five states and nothing else", () => {
    for (const s of ["not_yours", "not_yet", "open", "given", "closed"]) {
      expect(isFeedbackState(s)).toBe(true);
    }
    expect(isFeedbackState("pending")).toBe(false);
    expect(isFeedbackState(undefined)).toBe(false);
  });
});

describe("summarizeFeedback", () => {
  it("averages to one decimal, counts each star and the low ones", () => {
    const at = "2026-10-08T12:00:00Z";
    expect(
      summarizeFeedback(
        [5, 5, 4, 2, 1].map((rating) => ({ rating, createdAt: at })),
      ),
    ).toEqual({
      count: 5,
      average: 3.4,
      distribution: { 1: 1, 2: 1, 3: 0, 4: 1, 5: 2 },
      low: 2,
    });
  });

  it("has no average with no ratings", () => {
    expect(summarizeFeedback([]).average).toBeNull();
  });
});

describe("tallyDishes", () => {
  it("puts the most disliked dish first, and keeps removed dishes by name", () => {
    expect(
      tallyDishes([
        { menuItemId: "dosa", dishName: "Masala Dosa", liked: true },
        { menuItemId: "dosa", dishName: "Masala Dosa", liked: true },
        { menuItemId: "lassi", dishName: "Mango Lassi", liked: false },
        { menuItemId: "lassi", dishName: "Mango Lassi", liked: true },
        { menuItemId: null, dishName: "Old Special", liked: false },
        { menuItemId: null, dishName: "Old Special", liked: false },
      ]),
    ).toEqual([
      { dishName: "Old Special", up: 0, down: 2 },
      { dishName: "Mango Lassi", up: 1, down: 1 },
      { dishName: "Masala Dosa", up: 2, down: 0 },
    ]);
  });
});
