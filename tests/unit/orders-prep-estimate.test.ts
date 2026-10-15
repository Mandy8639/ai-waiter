import { describe, expect, it } from "vitest";
import { estimateOrderPrep, etaSentence } from "@/lib/orders/prep-estimate";

const placedAt = "2026-09-05T17:00:00.000Z";
const at = (mins: number) => new Date(Date.parse(placedAt) + mins * 60_000);

describe("estimateOrderPrep", () => {
  it("takes the longest dish, not the sum", () => {
    // A kitchen cooks in parallel. A 3-minute lassi beside a 15-minute
    // thali is a 15-minute order; summing would make every large table
    // look hours away.
    const e = estimateOrderPrep({
      itemPrepMinutes: [3, 15, 8],
      status: "preparing",
      placedAt,
      now: at(0),
    });
    expect(e.totalMinutes).toBe(15);
  });

  it("counts down from when the order was placed", () => {
    const e = estimateOrderPrep({
      itemPrepMinutes: [15],
      status: "preparing",
      placedAt,
      now: at(10),
    });
    expect(e.minutesRemaining).toBe(5);
  });

  it("never reports a negative wait", () => {
    // An order that has run over is "any moment now", not "minus four".
    const e = estimateOrderPrep({
      itemPrepMinutes: [15],
      status: "preparing",
      placedAt,
      now: at(19),
    });
    expect(e.minutesRemaining).toBe(0);
  });

  it("distinguishes 'we don't know' from 'it's instant'", () => {
    // The real failure this guards: null must not become 0, or the waiter
    // tells a diner their food is ready when nobody said so.
    const e = estimateOrderPrep({
      itemPrepMinutes: [null, null],
      status: "preparing",
      placedAt,
      now: at(2),
    });
    expect(e.totalMinutes).toBeNull();
    expect(e.minutesRemaining).toBeNull();
  });

  it("ignores dishes with no recorded time but uses the ones that have it", () => {
    const e = estimateOrderPrep({
      itemPrepMinutes: [null, 12, null],
      status: "preparing",
      placedAt,
      now: at(0),
    });
    expect(e.totalMinutes).toBe(12);
  });

  it("widens the estimate when other tables are already waiting", () => {
    // The case a real kitchen has and a per-order estimate misses: Table 1
    // orders a 15-minute thali, Table 2 orders one a minute later, and
    // both were being told fifteen minutes. Table 2 is not eating in
    // fifteen minutes.
    const e = estimateOrderPrep({
      itemPrepMinutes: [15],
      status: "preparing",
      placedAt,
      queueMinutesAhead: 15,
      ordersAhead: 1,
      now: at(0),
    });
    expect(e.minutesRemaining).toBe(15);
    expect(e.minutesRemainingAtWorst).toBe(30);
    expect(e.ordersAhead).toBe(1);
  });

  it("gives one number, not a range, when the kitchen is clear", () => {
    const e = estimateOrderPrep({
      itemPrepMinutes: [15],
      status: "preparing",
      placedAt,
      queueMinutesAhead: 0,
      now: at(0),
    });
    expect(e.minutesRemaining).toBe(e.minutesRemainingAtWorst);
  });

  it("does not shrink the queue as this order waits", () => {
    // The orders ahead are cooking during the same minutes, so their work
    // does not go away just because this one has been sitting there.
    const e = estimateOrderPrep({
      itemPrepMinutes: [15],
      status: "preparing",
      placedAt,
      queueMinutesAhead: 15,
      now: at(10),
    });
    expect(e.minutesRemaining).toBe(5);
    expect(e.minutesRemainingAtWorst).toBe(20);
  });

  it("stops estimating once the kitchen says it is ready", () => {
    const e = estimateOrderPrep({
      itemPrepMinutes: [15],
      status: "ready",
      placedAt,
      now: at(3),
    });
    expect(e.finished).toBe(true);
    expect(e.minutesRemaining).toBeNull();
  });

  it("still reports the total when the timestamp is unreadable", () => {
    const e = estimateOrderPrep({
      itemPrepMinutes: [10],
      status: "preparing",
      placedAt: "not a date",
    });
    expect(e.totalMinutes).toBe(10);
    expect(e.minutesRemaining).toBeNull();
  });
});

describe("etaSentence", () => {
  it("says nothing at all when the kitchen never recorded a time", () => {
    // Null rather than a cheerful placeholder: a diner told "about 20
    // minutes" by a kitchen that never gave one has been handed a number
    // the restaurant never stood behind.

    expect(
      etaSentence({
        totalMinutes: null,
        minutesRemaining: null,
        minutesRemainingAtWorst: null,
        ordersAhead: 0,
        finished: false,
      }),
    ).toBeNull();
  });

  it("gives one number when the kitchen is clear, a range when it is not", () => {
    expect(
      etaSentence({
        totalMinutes: 15,
        minutesRemaining: 12,
        minutesRemainingAtWorst: 12,
        ordersAhead: 0,
        finished: false,
      }),
    ).toBe("About 12 more minutes.");
    expect(
      etaSentence({
        totalMinutes: 15,
        minutesRemaining: 12,
        minutesRemainingAtWorst: 27,
        ordersAhead: 1,
        finished: false,
      }),
    ).toBe("About 12–27 more minutes.");
  });

  it("stops estimating once the food is ready", () => {
    expect(
      etaSentence({
        totalMinutes: 15,
        minutesRemaining: null,
        minutesRemainingAtWorst: null,
        ordersAhead: 0,
        finished: true,
      }),
    ).toBeNull();
  });
});

describe("kitchen busy mode in the estimate", () => {
  it("adds the kitchen's extra wait to both ends of the range", () => {
    const e = estimateOrderPrep({
      itemPrepMinutes: [15],
      status: "preparing",
      placedAt,
      queueMinutesAhead: 10,
      busyExtraMinutes: 20,
      now: at(10),
    });
    // 5 left, +20 busy; the queue adds its 10 on top for the worst case.
    expect(e.minutesRemaining).toBe(25);
    expect(e.minutesRemainingAtWorst).toBe(35);
  });

  it("says nothing extra once the food is ready", () => {
    const e = estimateOrderPrep({
      itemPrepMinutes: [15],
      status: "ready",
      placedAt,
      busyExtraMinutes: 20,
      now: at(10),
    });
    expect(e.minutesRemaining).toBeNull();
  });
});
