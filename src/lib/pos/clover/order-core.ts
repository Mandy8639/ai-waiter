/**
 * A Tableside order as Clover's atomic order request
 * (POST /v3/merchants/{mId}/atomic_order/orders). Pure and unit-tested
 * (tests/unit/clover-connection.test.ts); deliver.ts sends it.
 *
 * - A dish imported from Clover points at its Clover item, and each
 *   option at its Clover modifier, so the register shows it as its own
 *   inventory item. Its price is sent too: what the diner was charged is
 *   what Tableside recorded, even if the register's price has changed.
 * - A dish added in Tableside (no Clover id) goes as a custom line, named
 *   and priced, with its options in the line's note.
 * - Clover lines are single units: a quantity of 3 is three lines.
 * - The order carries a note naming the Tableside order and table, so
 *   staff can match the ticket.
 *
 * Amounts are cents.
 */

export interface CloverOrderLineInput {
  name: string;
  /** The Clover item id, when the dish was imported from Clover. */
  cloverItemId: string | null;
  /** One unit, without options. */
  unitPrice: number;
  quantity: number;
  options: {
    name: string;
    /** The Clover modifier id, when the option was imported from Clover. */
    cloverModifierId: string | null;
    priceAdjustment: number;
  }[];
}

export interface CloverOrderInput {
  orderNumber: number;
  tableLabel: string | null;
  customerNote: string | null;
  orderTypeId: string | null;
  lines: CloverOrderLineInput[];
}

interface CloverLineItem {
  item?: { id: string };
  name?: string;
  price: number;
  note?: string;
  modifications?: { modifier: { id: string } }[];
}

export interface CloverAtomicOrder {
  orderCart: {
    lineItems: CloverLineItem[];
    note: string;
    orderType?: { id: string };
  };
}

/** Clover's limit on a single atomic order. */
export const CLOVER_MAX_LINE_ITEMS = 3000;

const cents = (amount: number) => Math.round(amount * 100);

export function buildCloverOrder(input: CloverOrderInput): CloverAtomicOrder {
  const lineItems: CloverLineItem[] = [];
  for (const line of input.lines) {
    const linked = line.options.filter((o) => o.cloverModifierId);
    const unlinked = line.options.filter((o) => !o.cloverModifierId);
    const optionsTotal = line.options.reduce(
      (sum, o) => sum + o.priceAdjustment,
      0,
    );
    const base: CloverLineItem = line.cloverItemId
      ? {
          item: { id: line.cloverItemId },
          // Options Clover knows are priced by their modifiers; any it
          // doesn't are folded into the line so the total still matches.
          price: cents(
            line.unitPrice +
              unlinked.reduce((sum, o) => sum + o.priceAdjustment, 0),
          ),
          ...(linked.length > 0
            ? {
                modifications: linked.map((o) => ({
                  modifier: { id: o.cloverModifierId! },
                })),
              }
            : {}),
        }
      : {
          name: line.name.slice(0, 127),
          price: cents(line.unitPrice + optionsTotal),
        };
    const note = (line.cloverItemId ? unlinked : line.options)
      .map((o) => o.name)
      .join(", ");
    if (note) base.note = note.slice(0, 255);
    for (let i = 0; i < Math.max(0, Math.floor(line.quantity)); i++) {
      lineItems.push({ ...base });
    }
  }
  if (lineItems.length === 0) {
    throw new Error("An order with no lines can't go to Clover");
  }
  if (lineItems.length > CLOVER_MAX_LINE_ITEMS) {
    throw new Error("Too many lines for one Clover order");
  }

  const where = input.tableLabel ? ` · ${input.tableLabel}` : "";
  const guestNote = input.customerNote?.trim()
    ? ` · Note: ${input.customerNote.trim()}`
    : "";
  return {
    orderCart: {
      lineItems,
      note: `Tableside #${input.orderNumber}${where}${guestNote}`.slice(0, 255),
      ...(input.orderTypeId ? { orderType: { id: input.orderTypeId } } : {}),
    },
  };
}

/**
 * Which of the merchant's order types a Tableside order goes in: one that
 * reads as dine-in if there is one, else the first. Clover requires one
 * on an atomic order.
 */
export function pickOrderType(
  types: { id: string; label?: string; deleted?: boolean }[],
): string | null {
  const live = types.filter((t) => !t.deleted);
  return (
    live.find((t) => /dine|table|here/i.test(t.label ?? ""))?.id ??
    live[0]?.id ??
    null
  );
}
