import { describe, expect, it } from "vitest";
import {
  planReorder,
  reorderMessage,
  type PastOrderLine,
} from "@/lib/cart/reorder-core";

/**
 * "Order another round": which of the last order's lines are even worth
 * trying again, and what the diner is told. Whether each one is available
 * and what it costs today is validateAndPriceSelection()'s job.
 */

const line = (patch: Partial<PastOrderLine>): PastOrderLine => ({
  menuItemId: "curry",
  itemName: "Butter chicken",
  quantity: 1,
  spicePreference: null,
  notes: null,
  optionIds: [],
  ...patch,
});

describe("planReorder", () => {
  it("keeps the dish, quantity, add-ons, spice and note", () => {
    const plan = planReorder([
      line({
        quantity: 2,
        optionIds: ["extra-naan"],
        spicePreference: "hot",
        notes: "  no onions ",
      }),
    ]);
    expect(plan).toEqual({
      lines: [
        {
          menuItemId: "curry",
          itemName: "Butter chicken",
          quantity: 2,
          optionIds: ["extra-naan"],
          spicePreference: "hot",
          notes: "no onions",
        },
      ],
      gone: [],
    });
  });

  it("names a dish since deleted from the menu, or one whose add-on was", () => {
    const plan = planReorder([
      line({ menuItemId: null, itemName: "Old special" }),
      line({ itemName: "Thali", optionIds: ["rice", null] }),
      line({ itemName: "Naan" }),
    ]);
    expect(plan.gone).toEqual(["Old special", "Thali"]);
    expect(plan.lines.map((l) => l.itemName)).toEqual(["Naan"]);
  });

  it("drops a spice level it doesn't know, and keeps quantities sane", () => {
    const [l] = planReorder([
      line({
        spicePreference: "volcanic",
        quantity: 500,
        notes: "x".repeat(300),
      }),
    ]).lines;
    expect(l.spicePreference).toBeNull();
    expect(l.quantity).toBe(99);
    expect(l.notes).toHaveLength(200);
  });
});

describe("reorderMessage", () => {
  it("counts items, not lines", () => {
    expect(reorderMessage({ addedItems: 3, notAdded: [] })).toEqual({
      added: "Added 3 items to your order.",
      notAdded: null,
    });
    expect(reorderMessage({ addedItems: 1, notAdded: [] }).added).toBe(
      "Added 1 item to your order.",
    );
  });

  it("names what wasn't added, once each", () => {
    expect(
      reorderMessage({
        addedItems: 0,
        notAdded: ["Lamb curry", "Lamb curry", "Lassi"],
      }),
    ).toEqual({
      added: null,
      notAdded: "Not available right now, so not added: Lamb curry, Lassi.",
    });
  });
});
