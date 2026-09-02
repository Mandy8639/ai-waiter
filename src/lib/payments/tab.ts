/**
 * Deriving what a tab still owes, kept out of the "use server" and
 * "server-only" modules so it is directly testable — the same
 * extract-the-core convention as src/lib/payments/tip.ts and
 * src/lib/payments/cash.ts.
 *
 * This is a restatement in TypeScript of how `start_tab_payment()` decides
 * what a tab covers: every order in the session that is not cancelled and
 * has no *succeeded* payment against it. Two implementations of one rule
 * is a liability, so it is isolated here and tested against the same cases
 * the SQL is tested against, rather than left inline in a query function
 * where it could only be exercised through the database.
 *
 * The duplication is survivable because this figure is never charged. It
 * decides what the page *offers*; the function recomputes the total
 * server-side and charges its own. A drift shows up as a surprising price
 * on screen, never as a wrong charge.
 */

export interface TabOrderInput {
  id: string;
  orderNumber: number;
  status: string;
  total: number;
  currency: string;
}

/** One payment's claim on one order, as read from payment_orders. */
export interface TabCoverageInput {
  orderId: string;
  status: string;
  tipAmount: number;
}

export interface TabOrderLine {
  id: string;
  orderNumber: number;
  total: number;
  paid: boolean;
}

export interface DerivedTab {
  orders: TabOrderLine[];
  unpaidCount: number;
  unpaidTotal: number;
  currency: string;
  pendingTip: number | null;
  mixedCurrency: boolean;
}

const EMPTY: DerivedTab = {
  orders: [],
  unpaidCount: 0,
  unpaidTotal: 0,
  currency: "USD",
  pendingTip: null,
  mixedCurrency: false,
};

export function deriveTab(
  allOrders: TabOrderInput[],
  coverage: TabCoverageInput[],
): DerivedTab {
  // Cancelled orders leave the tab entirely rather than showing as unpaid:
  // there is nothing to pay, and listing them as owed would inflate the
  // total the diner is asked to approve.
  const live = allOrders.filter((o) => o.status !== "cancelled");
  if (live.length === 0) return EMPTY;

  const liveIds = new Set(live.map((o) => o.id));
  const paidOrderIds = new Set<string>();
  let pendingTip: number | null = null;

  for (const row of coverage) {
    if (!liveIds.has(row.orderId)) continue;
    if (row.status === "succeeded") paidOrderIds.add(row.orderId);
    // Only a settled payment marks an order paid. A pending one is an
    // abandoned Checkout, and treating it as paid would let a table leave
    // without ever being charged.
    if (row.status === "pending" && pendingTip === null) {
      pendingTip = row.tipAmount;
    }
  }

  const unpaid = live.filter((o) => !paidOrderIds.has(o.id));

  return {
    orders: live.map((o) => ({
      id: o.id,
      orderNumber: o.orderNumber,
      total: o.total,
      paid: paidOrderIds.has(o.id),
    })),
    unpaidCount: unpaid.length,
    unpaidTotal: unpaid.reduce((sum, o) => sum + o.total, 0),
    currency: unpaid[0]?.currency ?? live[0].currency,
    pendingTip,
    mixedCurrency: new Set(unpaid.map((o) => o.currency)).size > 1,
  };
}
