// Guest insights' arithmetic and wording (src/lib/guests/insights-core.ts).
import { describe, expect, it } from "vitest";
import {
  aiSpendLift,
  average,
  busiestSlots,
  busyGrid,
  describeLift,
  hourLabel,
  parseInsights,
  percent,
} from "@/lib/guests/insights-core";

describe("parseInsights", () => {
  it("turns the function's numbers (some as strings) into numbers", () => {
    const parsed = parseInsights({
      visits: { visits: 10, orderingVisits: 8, spend: "240.50", orders: 9 },
      ai: { chatVisits: 4, questions: 7 },
      busy: [{ dow: 5, hour: 19, orders: 6 }],
      feedback: { count: 2, average: "4.5", byRating: [0, 0, 0, 1, 1] },
      bookings: { bookings: 3 },
      regulars: [{ name: "Sam", visits: 3, lastVisit: "2026-10-16T19:00:00Z" }],
    });
    expect(parsed.visits.spend).toBe(240.5);
    expect(parsed.ai.chatSpend).toBe(0);
    expect(parsed.feedback.average).toBe(4.5);
    expect(parsed.bookings.guests).toBe(0);
    expect(parsed.regulars[0].name).toBe("Sam");
  });

  it("is all zeros, not a crash, for nothing", () => {
    const parsed = parseInsights(null);
    expect(parsed.visits.visits).toBe(0);
    expect(parsed.feedback).toEqual({
      count: 0,
      average: null,
      byRating: [0, 0, 0, 0, 0],
    });
    expect(parsed.busy).toEqual([]);
  });
});

describe("averages and shares", () => {
  it("has no average or share of nothing", () => {
    expect(average(100, 4)).toBe(25);
    expect(average(0, 0)).toBeNull();
    expect(percent(1, 3)).toBe("33%");
    expect(percent(0, 0)).toBe("–");
  });
});

describe("the AI waiter's effect on spend", () => {
  const ai = {
    chatVisits: 5,
    chatOrderingVisits: 4,
    chatSpend: 120,
    otherOrderingVisits: 4,
    otherSpend: 100,
    questions: 9,
  };

  it("compares spend per ordering visit", () => {
    expect(aiSpendLift(ai)).toBeCloseTo(0.2);
    expect(describeLift(aiSpendLift(ai))).toBe("20% more than");
    expect(describeLift(-0.1)).toBe("10% less than");
    expect(describeLift(0.001)).toBe("about the same as");
  });

  it("says nothing until each side has three visits", () => {
    expect(aiSpendLift({ ...ai, chatOrderingVisits: 2 })).toBeNull();
    expect(describeLift(null)).toBeNull();
  });
});

describe("busy times", () => {
  const busy = [
    { dow: 5, hour: 19, orders: 12 },
    { dow: 6, hour: 20, orders: 15 },
    { dow: 1, hour: 12, orders: 3 },
  ];

  it("names hours the way people say them", () => {
    expect(hourLabel(0)).toBe("12am");
    expect(hourLabel(12)).toBe("12pm");
    expect(hourLabel(19)).toBe("7pm");
  });

  it("lists the busiest slots first", () => {
    expect(busiestSlots(busy, 2)).toEqual([
      { label: "Sat 8pm–9pm", orders: 15 },
      { label: "Fri 7pm–8pm", orders: 12 },
    ]);
  });

  it("spans the hours anything was ordered, shaded against the busiest", () => {
    const grid = busyGrid(busy);
    expect(grid.hours).toEqual([12, 13, 14, 15, 16, 17, 18, 19, 20]);
    expect(grid.rows).toHaveLength(7);
    expect(grid.rows[5].cells.at(-1)).toEqual({ orders: 15, level: 1 });
    expect(grid.rows[0].cells[0]).toEqual({ orders: 3, level: 0.2 });
    expect(busyGrid([])).toEqual({ hours: [], rows: [] });
  });
});
