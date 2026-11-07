import { describe, expect, it } from "vitest";
import {
  IDLE_AFTER_MS,
  attentionSummary,
  floorTile,
  floorTiles,
  type FloorRow,
} from "@/lib/floor/core";

const NOW = new Date("2026-11-07T19:00:00Z");
const minutesAgo = (m: number) =>
  new Date(NOW.getTime() - m * 60_000).toISOString();

function row(overrides: Partial<FloorRow> = {}): FloorRow {
  return {
    table_id: "t1",
    table_number: "1",
    display_name: null,
    seated_since: null,
    open_requests: [],
    active_orders: 0,
    oldest_active_at: null,
    active_status: null,
    ready_orders: 0,
    ready_since: null,
    served_orders: 0,
    last_order_change_at: null,
    unpaid_orders: 0,
    unpaid_total: 0,
    currency: "USD",
    ...overrides,
  };
}

const basic = { basicMode: true, now: NOW };
const full = { basicMode: false, now: NOW };

describe("floorTile", () => {
  it("is free with nothing happening", () => {
    const tile = floorTile(row(), basic);
    expect(tile.state).toBe("free");
    expect(tile.occupied).toBe(false);
    expect(tile.label).toBe("Table 1");
  });

  it("is seated when a guest scanned but hasn't ordered", () => {
    const tile = floorTile(row({ seated_since: minutesAgo(4) }), basic);
    expect(tile.state).toBe("seated");
    expect(tile.since).toBe(minutesAgo(4));
  });

  it("shows the least advanced stage while orders are in the kitchen", () => {
    const tile = floorTile(
      row({
        active_orders: 2,
        active_status: "pending",
        oldest_active_at: minutesAgo(12),
      }),
      basic,
    );
    expect(tile.state).toBe("ordered");
    expect(tile.detail).toBe("New · 2 orders");
    expect(tile.since).toBe(minutesAgo(12));
  });

  it("puts ready food ahead of food still cooking", () => {
    const tile = floorTile(
      row({
        active_orders: 1,
        active_status: "preparing",
        ready_orders: 1,
        ready_since: minutesAgo(2),
      }),
      basic,
    );
    expect(tile.state).toBe("food_ready");
    expect(tile.detail).toBe("1 order to take out");
  });

  it("puts a call for a waiter ahead of everything", () => {
    const tile = floorTile(
      row({
        ready_orders: 1,
        open_requests: [
          { id: "r2", kind: "bill", note: null, created_at: minutesAgo(1) },
          {
            id: "r1",
            kind: "waiter",
            note: "Need water",
            created_at: minutesAgo(6),
          },
        ],
      }),
      basic,
    );
    expect(tile.state).toBe("needs_waiter");
    expect(tile.detail).toBe("Need water");
    expect(tile.since).toBe(minutesAgo(6));
    expect(tile.requests).toHaveLength(2);
  });

  it("shows a bill request with what's owed when payments are on", () => {
    const tile = floorTile(
      row({
        served_orders: 1,
        unpaid_orders: 1,
        unpaid_total: "42.50",
        open_requests: [
          { id: "r", kind: "bill", note: null, created_at: minutesAgo(1) },
        ],
      }),
      full,
    );
    expect(tile.state).toBe("wants_bill");
    expect(tile.detail).toBe("$42.50 to pay");
  });

  it("ignores malformed requests", () => {
    const tile = floorTile(
      row({ open_requests: [{ id: 1, kind: "dance" }, null, "x"] }),
      basic,
    );
    expect(tile.state).toBe("free");
    expect(tile.requests).toEqual([]);
  });

  describe("after everything is served", () => {
    it("is eating in basic mode, without mentioning money", () => {
      const tile = floorTile(
        row({
          served_orders: 2,
          last_order_change_at: minutesAgo(20),
          unpaid_orders: 2,
          unpaid_total: 30,
        }),
        basic,
      );
      expect(tile.state).toBe("eating");
      expect(tile.detail).toBe("2 orders served");
      expect(tile.owed).toBeNull();
    });

    it("is eating with the amount owed when payments are on", () => {
      const tile = floorTile(
        row({
          served_orders: 1,
          last_order_change_at: minutesAgo(20),
          unpaid_orders: 1,
          unpaid_total: 18,
        }),
        full,
      );
      expect(tile.state).toBe("eating");
      expect(tile.detail).toBe("$18.00 to pay");
    });

    it("is paid when payments are on and nothing is owed", () => {
      const tile = floorTile(
        row({ served_orders: 1, last_order_change_at: minutesAgo(5) }),
        full,
      );
      expect(tile.state).toBe("paid");
    });

    it("goes free once nothing has happened for a while", () => {
      const tile = floorTile(
        row({
          served_orders: 1,
          last_order_change_at: new Date(
            NOW.getTime() - IDLE_AFTER_MS,
          ).toISOString(),
        }),
        basic,
      );
      expect(tile.state).toBe("free");
    });

    it("never goes idle while money is owed", () => {
      const tile = floorTile(
        row({
          served_orders: 1,
          last_order_change_at: minutesAgo(600),
          unpaid_orders: 1,
          unpaid_total: 25,
        }),
        full,
      );
      expect(tile.state).toBe("eating");
    });
  });
});

describe("floorTiles", () => {
  it("orders tables the way staff number them", () => {
    const tiles = floorTiles(
      [
        row({ table_id: "a", table_number: "10" }),
        row({ table_id: "b", table_number: "2" }),
        row({ table_id: "c", table_number: "1" }),
      ],
      basic,
    );
    expect(tiles.map((t) => t.label)).toEqual([
      "Table 1",
      "Table 2",
      "Table 10",
    ]);
  });
});

describe("attentionSummary", () => {
  it("counts the tables someone has to walk to", () => {
    const tiles = floorTiles(
      [
        row({ table_id: "a", ready_orders: 1 }),
        row({
          table_id: "b",
          open_requests: [
            { id: "r", kind: "waiter", note: null, created_at: minutesAgo(1) },
          ],
        }),
        row({ table_id: "c", active_orders: 1 }),
      ],
      basic,
    );
    expect(attentionSummary(tiles)).toBe("2 tables need someone");
    expect(attentionSummary([])).toBe("Nobody's waiting");
  });
});
