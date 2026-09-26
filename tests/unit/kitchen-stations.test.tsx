// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  canMarkStationDone,
  hasOwnLines,
  ordersForStation,
  stationMayTransition,
  stationProgress,
  viewForStation,
} from "@/lib/kitchen/stations-core";
import type { KitchenOrder, KitchenOrderItem } from "@/lib/orders/kitchen";
import { OrderCard } from "@/components/kitchen/order-card";

/**
 * Phase I: what each kitchen station sees. The database half (routing at
 * order time, permissions) is tests/integration/db/kitchen-stations.test.ts.
 */

const GRILL = "grill";
const FRY = "fry";
const stations = [
  { id: GRILL, name: "Grill" },
  { id: FRY, name: "Fry" },
];

function line(name: string, stationId: string | null): KitchenOrderItem {
  return {
    id: `${name}-line`,
    itemName: name,
    quantity: 1,
    modifiers: [],
    spicePreference: null,
    notes: null,
    ticketGroupId: null,
    stationId,
  };
}

function order(
  id: string,
  items: KitchenOrderItem[],
  over: Partial<KitchenOrder> = {},
): KitchenOrder {
  return {
    id,
    orderNumber: Number(id.replace(/\D/g, "")) || 1,
    status: "preparing",
    tableLabel: "Table 4",
    customerNote: null,
    createdAt: new Date().toISOString(),
    items,
    ticketGroups: [],
    mergedWithOrderIds: [],
    stationsDone: [],
    ...over,
  };
}

const mixed = order("o1", [
  line("Burger", GRILL),
  line("Fries", FRY),
  line("Water", null),
]);

describe("what a station sees", () => {
  it("shows its own lines and unassigned ones, never another station's", () => {
    const grill = viewForStation(mixed, GRILL)!;
    expect(grill.items.map((i) => i.itemName)).toEqual(["Burger", "Water"]);
  });

  it("leaves an order with nothing for the station off its screen", () => {
    const friesOnly = order("o2", [line("Fries", FRY)]);
    expect(viewForStation(friesOnly, GRILL)).toBeNull();
    expect(ordersForStation([friesOnly], GRILL)).toEqual([]);
  });

  it("shows an order with only unassigned dishes on every station", () => {
    const water = order("o3", [line("Water", null)]);
    expect(ordersForStation([water], GRILL)).toHaveLength(1);
    expect(ordersForStation([water], FRY)).toHaveLength(1);
    // ...but there is no part of it for either station to mark done.
    expect(hasOwnLines(water, GRILL)).toBe(false);
  });

  it("drops an order to the bottom once this station's part is done", () => {
    const done = order("o4", [line("Burger", GRILL)], {
      stationsDone: [GRILL],
    });
    const waiting = order("o5", [line("Steak", GRILL)]);
    expect(ordersForStation([done, waiting], GRILL).map((o) => o.id)).toEqual([
      "o5",
      "o4",
    ]);
  });
});

describe("the pass", () => {
  it("sees which stations an order needs, and which are done", () => {
    expect(
      stationProgress({ ...mixed, stationsDone: [FRY] }, stations),
    ).toEqual([
      { id: GRILL, name: "Grill", done: false },
      { id: FRY, name: "Fry", done: true },
    ]);
  });

  it("shows nothing for an order that needs no station", () => {
    expect(
      stationProgress(order("o6", [line("Water", null)]), stations),
    ).toEqual([]);
  });
});

describe("the rules", () => {
  it("lets a station accept and start an order, but not mark it ready or served", () => {
    expect(stationMayTransition("confirmed")).toBe(true);
    expect(stationMayTransition("preparing")).toBe(true);
    expect(stationMayTransition("ready")).toBe(false);
    expect(stationMayTransition("served")).toBe(false);
  });

  it("marks a station done only once the order is accepted", () => {
    expect(canMarkStationDone("pending")).toBe(false);
    expect(canMarkStationDone("confirmed")).toBe(true);
    expect(canMarkStationDone("preparing")).toBe(true);
    expect(canMarkStationDone("ready")).toBe(true);
    expect(canMarkStationDone("served")).toBe(false);
  });
});

describe("OrderCard on a station screen", () => {
  afterEach(cleanup);

  function renderCard(
    o: KitchenOrder,
    extra: Partial<Parameters<typeof OrderCard>[0]> = {},
  ) {
    const props = {
      order: o,
      role: "kitchen" as const,
      isPending: false,
      onTransition: vi.fn(),
      onCancel: vi.fn(),
      onOpenDetail: vi.fn(),
      onGroupTransition: vi.fn(),
      onOpenSplit: vi.fn(),
      onOpenMerge: vi.fn(),
      orderNumberById: new Map<string, number>(),
      ...extra,
    };
    render(<OrderCard {...props} />);
    return props;
  }

  it("offers the station's own Done instead of Mark ready", () => {
    const onToggle = vi.fn();
    renderCard(viewForStation(mixed, GRILL)!, {
      station: { name: "Grill", done: false, canMark: true, onToggle },
    });
    expect(screen.queryByRole("button", { name: /ready/i })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Grill done" }));
    expect(onToggle).toHaveBeenCalledWith(true);
    // The unassigned line is labelled so nobody assumes another station has it.
    expect(screen.getByText("(no station)")).toBeInTheDocument();
    expect(screen.queryByText(/Fries/)).toBeNull();
  });

  it("can undo a station's Done", () => {
    const onToggle = vi.fn();
    renderCard(viewForStation(mixed, GRILL)!, {
      station: { name: "Grill", done: true, canMark: true, onToggle },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Grill done ✓ · Undo" }),
    );
    expect(onToggle).toHaveBeenCalledWith(false);
  });

  it("still lets a station confirm a new order", () => {
    const props = renderCard(
      viewForStation({ ...mixed, status: "pending" }, GRILL)!,
      {
        station: {
          name: "Grill",
          done: false,
          canMark: true,
          onToggle: vi.fn(),
        },
      },
    );
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    expect(props.onTransition).toHaveBeenCalledWith("o1", "confirmed");
    // Not accepted yet: nothing to mark done.
    expect(screen.queryByRole("button", { name: "Grill done" })).toBeNull();
  });

  it("on the pass, keeps Mark ready and shows each station's progress", () => {
    renderCard(
      { ...mixed, stationsDone: [FRY] },
      {
        role: "owner",
        progress: stationProgress({ ...mixed, stationsDone: [FRY] }, stations),
      },
    );
    expect(
      screen.getByRole("button", { name: "Mark ready" }),
    ).toBeInTheDocument();
    expect(screen.getByText(/Grill …/)).toBeInTheDocument();
    expect(screen.getByText(/Fry ✓/)).toBeInTheDocument();
  });
});
