import { paymentMethodLabel } from "@/lib/payments/method";

/**
 * The closing report (20261116090000, day_close_summary()) as the page
 * and the printer read it. No `server-only`, per the extract-the-core
 * convention. Amounts arrive as JSON numbers.
 */

export interface DayCloseLine {
  count: number;
  amount: number;
}

export interface DayCloseMethod {
  /** A payment method, or card_in_person for a card on a Terminal or Tap to Pay. */
  method: string;
  count: number;
  sales: number;
  tips: number;
  refunds: number;
  net: number;
}

export interface DayCloseSummary {
  from: string;
  to: string;
  currency: string;
  payments: {
    count: number;
    sales: number;
    tips: number;
    gross: number;
    refunds: number;
    net: number;
  };
  by_method: DayCloseMethod[];
  cash: { taken: number; refunded: number };
  adjustments: {
    void: DayCloseLine;
    comp: DayCloseLine;
    discount: DayCloseLine;
  };
  reversed: DayCloseLine;
  orders: number;
  staff: { email: string; count: number; cash: number; total: number }[];
}

export interface DayClose {
  id: string;
  periodStart: string;
  periodEnd: string;
  openingFloat: number;
  countedCash: number;
  expectedCash: number;
  overShort: number;
  note: string | null;
  summary: DayCloseSummary;
}

export function dayCloseMethodLabel(method: string): string {
  return method === "card_in_person"
    ? "Card (in person)"
    : paymentMethodLabel(method);
}

/** What should be in the drawer: the float, plus cash taken, less cash handed back. */
export function expectedCash(float: number, summary: DayCloseSummary): number {
  return (
    Math.round((float + summary.cash.taken - summary.cash.refunded) * 100) / 100
  );
}

/** "Over $2.00", "Short $1.50" or "Even". */
export function overShortLabel(
  diff: number,
  money: (v: number) => string,
): string {
  const cents = Math.round(diff * 100);
  if (cents === 0) return "Even";
  return cents > 0
    ? `Over ${money(cents / 100)}`
    : `Short ${money(-cents / 100)}`;
}

/** Typed numbers, or null if a value is missing or negative. */
export function parseCash(value: string): number | null {
  const text = value.trim();
  if (text === "") return null;
  const n = Number(text);
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) / 100 : null;
}
