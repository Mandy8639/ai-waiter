/**
 * "Order another round": the last order's lines, put back in the cart at
 * today's prices. This is the part with no database in it — which lines
 * can even be tried, and what to tell the diner afterwards. Every line
 * that is tried still goes through validateAndPriceSelection(), so a
 * sold-out dish, a menu that's off now or a changed price is decided
 * there, exactly as for a dish added by hand. No `server-only`, per the
 * extract-the-core convention.
 */

export const SPICE_LEVELS = [
  "none",
  "mild",
  "medium",
  "hot",
  "very_hot",
] as const;
export type SpiceLevel = (typeof SPICE_LEVELS)[number];

/** An order line as the database has it. */
export interface PastOrderLine {
  menuItemId: string | null;
  itemName: string;
  quantity: number;
  spicePreference: string | null;
  notes: string | null;
  /** One per add-on picked; null where that add-on has since been deleted. */
  optionIds: (string | null)[];
}

/** A line worth trying to add again. */
export interface ReorderLine {
  menuItemId: string;
  itemName: string;
  quantity: number;
  optionIds: string[];
  spicePreference: SpiceLevel | null;
  notes: string | null;
}

export interface ReorderPlan {
  lines: ReorderLine[];
  /** Names of lines that can't be tried at all: the dish or an add-on is gone. */
  gone: string[];
}

export function planReorder(past: PastOrderLine[]): ReorderPlan {
  const lines: ReorderLine[] = [];
  const gone: string[] = [];
  for (const line of past) {
    // A dish deleted from the menu leaves its order lines with no
    // menu_item_id; one of its add-ons deleted leaves a null option. The
    // diner asked for exactly that, so it isn't quietly re-added without.
    if (!line.menuItemId || line.optionIds.some((id) => id === null)) {
      gone.push(line.itemName);
      continue;
    }
    const spice = SPICE_LEVELS.find((s) => s === line.spicePreference);
    lines.push({
      menuItemId: line.menuItemId,
      itemName: line.itemName,
      quantity: Math.max(1, Math.min(99, Math.round(line.quantity))),
      optionIds: line.optionIds as string[],
      spicePreference: spice ?? null,
      // The cart's own limit (addToCartSchema).
      notes: line.notes?.trim().slice(0, 200) || null,
    });
  }
  return { lines, gone };
}

export interface ReorderOutcome {
  /** Items added, counting quantity: two naan and a curry is 3. */
  addedItems: number;
  /** Dishes not added, by name, for the diner. */
  notAdded: string[];
}

/** "Added 3 items to your order." and, separately, what wasn't. */
export function reorderMessage(outcome: ReorderOutcome): {
  added: string | null;
  notAdded: string | null;
} {
  const n = outcome.addedItems;
  const names = [...new Set(outcome.notAdded)];
  return {
    added:
      n > 0 ? `Added ${n} ${n === 1 ? "item" : "items"} to your order.` : null,
    notAdded:
      names.length > 0
        ? `Not available right now, so not added: ${names.join(", ")}.`
        : null,
  };
}
