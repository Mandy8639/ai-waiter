import { describe, expect, it } from "vitest";
import type { KitchenOrder } from "@/lib/orders/kitchen";
import { orderColumn, startsLater } from "@/lib/pickup/board-core";

const NOW = Date.parse("2026-10-19T16:00:00Z");

function order(
  id: string,
  status: KitchenOrder["status"],
  startAt: string | null,
): KitchenOrder {
  return {
    id,
    orderNumber: 1,
    status,
    tableLabel: "Pickup",
    customerNote: null,
    createdAt: "2026-10-19T15:00:00Z",
    items: [],
    ticketGroups: [],
    mergedWithOrderIds: [],
    stationsDone: [],
    pickup: startAt
      ? {
          at: startAt,
          time: "12:30",
          name: "Priya",
          startAt,
          startTime: "12:10",
          slotMinutes: 15,
        }
      : null,
  };
}

describe("startsLater", () => {
  it("is only an accepted pickup order whose start time is still ahead", () => {
    expect(
      startsLater(order("a", "confirmed", "2026-10-19T17:00:00Z"), NOW),
    ).toBe(true);
    expect(
      startsLater(order("b", "confirmed", "2026-10-19T15:59:00Z"), NOW),
    ).toBe(false);
    expect(
      startsLater(order("c", "pending", "2026-10-19T17:00:00Z"), NOW),
    ).toBe(false);
    expect(
      startsLater(order("d", "preparing", "2026-10-19T17:00:00Z"), NOW),
    ).toBe(false);
    expect(startsLater(order("e", "confirmed", null), NOW)).toBe(false);
  });
});

describe("orderColumn", () => {
  it("keeps due work in its order and lists later pickups by start time", () => {
    const column = orderColumn(
      [
        order("late-1", "confirmed", "2026-10-19T19:00:00Z"),
        order("table", "confirmed", null),
        order("late-2", "confirmed", "2026-10-19T17:00:00Z"),
        order("due", "confirmed", "2026-10-19T15:30:00Z"),
      ],
      NOW,
    );
    expect(column.map((o) => o.id)).toEqual([
      "table",
      "due",
      "late-2",
      "late-1",
    ]);
  });
});
