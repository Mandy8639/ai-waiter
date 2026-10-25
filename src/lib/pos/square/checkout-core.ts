import { toMinorUnits } from "@/lib/payments/money";

/**
 * A Tableside bill turned into Square's CreatePaymentLink request. Pure
 * and unit-tested (tests/unit/square-payments.test.ts); checkout.ts does
 * the I/O.
 *
 * What the diner pays is decided in the database (start_order_payment /
 * start_tab_payment); this only describes it to Square, itemised, so the
 * sale reads properly in the restaurant's Square reports:
 * - one line per dish, at the price the diner was charged (order_items are
 *   immutable, so a menu change since doesn't leak in);
 * - whatever the orders add on top of the dishes (tax, the restaurant's
 *   service charge) as one "Tax & charges" line, or a discount if negative;
 * - the tip as a service charge named "Tip", because Square's guidance for
 *   tips taken outside its own tip screen is a service charge, and it keeps
 *   the tip out of item sales;
 * - Tableside's fee as app_fee_money, on the bill without the tip (the tip
 *   belongs to the staff; the Stripe path makes the same choice).
 * It refuses to build a request whose total doesn't equal what the
 * database said to charge.
 */

export interface BillLine {
  order_id: string;
  item_name: string;
  options: string | null;
  quantity: number;
  unit_amount: string | number;
  line_total: string | number;
  order_total: string | number;
}

export interface SquareCheckoutInput {
  paymentId: string;
  locationId: string;
  currency: string;
  /** What the orders cost, before tip (order_payments.amount). */
  amount: string | number;
  tipAmount: string | number;
  lines: BillLine[];
  appFeeMinorUnits: number;
  redirectUrl: string;
  /** Shown on Square's checkout and receipt, e.g. "Table 4 at Saffron & Sage". */
  note: string;
}

interface SquareMoney {
  amount: number;
  currency: string;
}

export interface SquarePaymentLinkRequest {
  idempotency_key: string;
  order: {
    location_id: string;
    reference_id: string;
    line_items: {
      name: string;
      quantity: string;
      base_price_money: SquareMoney;
    }[];
    service_charges?: {
      name: string;
      amount_money: SquareMoney;
      calculation_phase: "TOTAL_PHASE";
    }[];
    discounts?: {
      uid: string;
      name: string;
      amount_money: SquareMoney;
      scope: "ORDER";
    }[];
  };
  checkout_options: {
    redirect_url: string;
    allow_tipping: false;
    ask_for_shipping_address: false;
    app_fee_money?: SquareMoney;
  };
  payment_note: string;
}

export class BillMismatchError extends Error {}

const lineName = (line: BillLine) =>
  (line.options ? `${line.item_name} (${line.options})` : line.item_name).slice(
    0,
    500,
  );

export function buildSquarePaymentLink(
  input: SquareCheckoutInput,
): SquarePaymentLinkRequest {
  const currency = input.currency.toUpperCase();
  const money = (minor: number): SquareMoney => ({ amount: minor, currency });
  const amountMinor = toMinorUnits(String(input.amount), currency);
  const tipMinor = toMinorUnits(String(input.tipAmount), currency);

  if (input.lines.length === 0) {
    throw new BillMismatchError("A bill with no dishes can't be paid.");
  }

  // The orders this payment covers, each counted once, must add up to the
  // amount the database froze. If they don't, the bill and the charge
  // disagree, and that must stop the checkout rather than be papered over.
  const orderTotals = new Map<string, number>();
  for (const line of input.lines) {
    orderTotals.set(
      line.order_id,
      toMinorUnits(String(line.order_total), currency),
    );
  }
  const ordersMinor = [...orderTotals.values()].reduce((a, b) => a + b, 0);
  if (ordersMinor !== amountMinor) {
    throw new BillMismatchError(
      `Orders add up to ${ordersMinor}, payment is for ${amountMinor}.`,
    );
  }

  const line_items = input.lines.map((line) => ({
    name: lineName(line),
    quantity: String(line.quantity),
    base_price_money: money(toMinorUnits(String(line.unit_amount), currency)),
  }));
  const dishesMinor = line_items.reduce(
    (sum, l) => sum + l.base_price_money.amount * Number(l.quantity),
    0,
  );

  // Tax, the restaurant's service charge, or a discount: whatever the
  // orders charged beyond the dishes themselves.
  const extraMinor = amountMinor - dishesMinor;
  if (extraMinor > 0) {
    line_items.push({
      name: "Tax & charges",
      quantity: "1",
      base_price_money: money(extraMinor),
    });
  }

  if (input.appFeeMinorUnits < 0 || input.appFeeMinorUnits > amountMinor) {
    throw new BillMismatchError("Tableside's fee can't exceed the bill.");
  }

  return {
    // Square de-duplicates on this, so a double-tapped Pay button reuses
    // the same checkout instead of opening a second one.
    idempotency_key: `tableside-${input.paymentId}`,
    order: {
      location_id: input.locationId,
      // Square caps reference_id at 40 characters; a UUID is 36.
      reference_id: input.paymentId,
      line_items,
      ...(tipMinor > 0
        ? {
            service_charges: [
              {
                name: "Tip",
                amount_money: money(tipMinor),
                calculation_phase: "TOTAL_PHASE" as const,
              },
            ],
          }
        : {}),
      ...(extraMinor < 0
        ? {
            discounts: [
              {
                uid: "tableside-adjustment",
                name: "Discount",
                amount_money: money(-extraMinor),
                scope: "ORDER" as const,
              },
            ],
          }
        : {}),
    },
    checkout_options: {
      redirect_url: input.redirectUrl,
      // The diner already chose a tip in Tableside; Square asking again
      // would double it.
      allow_tipping: false,
      ask_for_shipping_address: false,
      ...(input.appFeeMinorUnits > 0
        ? { app_fee_money: money(input.appFeeMinorUnits) }
        : {}),
    },
    payment_note: input.note.slice(0, 500),
  };
}

/** What Square will charge for a request built above: dishes, extras, tip, less any discount. */
export function requestTotalMinorUnits(
  request: SquarePaymentLinkRequest,
): number {
  const lines = request.order.line_items.reduce(
    (sum, l) => sum + l.base_price_money.amount * Number(l.quantity),
    0,
  );
  const charges = (request.order.service_charges ?? []).reduce(
    (sum, c) => sum + c.amount_money.amount,
    0,
  );
  const discounts = (request.order.discounts ?? []).reduce(
    (sum, d) => sum + d.amount_money.amount,
    0,
  );
  return lines + charges - discounts;
}
