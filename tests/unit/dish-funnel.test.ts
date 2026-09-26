import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  formatRate,
  openToOrderRate,
  toDishFunnelRows,
  type DishFunnelRow,
} from "@/lib/reports/funnel";

/**
 * Phase H: how the dish funnel is shown. The counting itself is
 * tests/integration/db/dish-funnel.test.ts.
 */

const row = (over: Partial<DishFunnelRow>): DishFunnelRow => ({
  dishId: "d",
  dishName: "Dosa",
  opened: 0,
  added: 0,
  ordered: 0,
  orderedAfterOpen: 0,
  ...over,
});

describe("opened → ordered", () => {
  it("is the share of visits that opened the dish and went on to order it", () => {
    expect(openToOrderRate(row({ opened: 8, orderedAfterOpen: 2 }))).toBe(0.25);
    expect(formatRate(0.25)).toBe("25%");
    expect(formatRate(1 / 3)).toBe("33%");
  });

  it("has no rate for a dish nobody opened, rather than 0% or infinity", () => {
    // Ordered only through the AI waiter.
    expect(openToOrderRate(row({ opened: 0, ordered: 3 }))).toBeNull();
    expect(formatRate(null)).toBe("—");
  });

  it("never shows more than 100%", () => {
    expect(openToOrderRate(row({ opened: 1, orderedAfterOpen: 2 }))).toBe(1);
  });
});

describe("reading the database rows", () => {
  it("turns bigint strings into numbers", () => {
    expect(
      toDishFunnelRows([
        {
          dish_id: "a",
          dish_name: "Chai",
          opened_visits: "12",
          added_visits: "5",
          ordered_visits: "4",
          ordered_after_open_visits: "3",
        },
      ]),
    ).toEqual([
      {
        dishId: "a",
        dishName: "Chai",
        opened: 12,
        added: 5,
        ordered: 4,
        orderedAfterOpen: 3,
      },
    ]);
  });

  it("treats anything unexpected as no rows", () => {
    expect(toDishFunnelRows(null)).toEqual([]);
    expect(toDishFunnelRows({})).toEqual([]);
  });
});

describe("where a dish counts as opened", () => {
  it("is recorded from the browser on the dish page, not while it renders", () => {
    // A server-side record would also count link prefetches — a diner
    // scrolling past a dish, not opening it.
    const page = readFileSync(
      path.resolve("src/app/r/[restaurantSlug]/item/[id]/page.tsx"),
      "utf8",
    );
    expect(page).toContain("<DishViewBeacon menuItemId={item.id} />");
    expect(page).not.toContain("recordDishView");

    const beacon = readFileSync(
      path.resolve("src/components/customer/dish-view-beacon.tsx"),
      "utf8",
    );
    expect(beacon).toMatch(/^"use client";/);
    expect(beacon).toContain("useEffect");
  });
});
