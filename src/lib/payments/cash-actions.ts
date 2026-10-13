"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { formatMoney } from "@/lib/orders/format";
import { parsePaymentError } from "./errors";
import { parseOrderIds, parseReversalReason } from "./cash";
import { parseTip } from "./tip";
import type { InPersonMethod } from "./method";
import { reportError } from "@/lib/observability/report";

/**
 * Recording cash (and payments on the restaurant's own card machine), and
 * un-recording them.
 *
 * Unlike a card payment there is no Stripe call here, and so no multi-step
 * dance to make crash-safe: cash has already changed hands at the table by
 * the time anyone touches this screen, so the database write is the whole
 * operation. That single call is also where every rule lives — membership,
 * whether the restaurant takes cash at all, mixed restaurants, mixed
 * currencies, and orders that are already paid.
 *
 * Note what is NOT sent: the amount. record_cash_payment() sums it from
 * the orders, so a tampered form cannot record £5 against a £50 tab. The
 * tip is the only figure a person supplies, because it is the only one
 * that isn't already known.
 */

export interface CashState {
  error?: string;
  success?: string;
}

export async function recordCashPayment(
  prevState: CashState,
  formData: FormData,
): Promise<CashState> {
  return recordInPersonPayment("cash", prevState, formData);
}

/**
 * A payment taken on the restaurant's own card machine at the register.
 * To Tableside it is a record exactly like cash — nothing goes through
 * Stripe — so it takes the same path with a different method, and its own
 * setting (accept_card_terminal) is checked by the database.
 */
export async function recordCardTerminalPayment(
  prevState: CashState,
  formData: FormData,
): Promise<CashState> {
  return recordInPersonPayment("card_terminal", prevState, formData);
}

async function recordInPersonPayment(
  method: InPersonMethod,
  _prevState: CashState,
  formData: FormData,
): Promise<CashState> {
  const orderIds = parseOrderIds(formData.getAll("orderIds"));
  if (!orderIds.ok) return { error: orderIds.message };

  const tip = parseTip(formData.get("tip"));
  if (!tip.ok) return { error: tip.message };

  const supabase = await createClient();

  const { data, error } = await supabase.rpc("record_in_person_payment", {
    p_order_ids: orderIds.value,
    p_method: method,
    p_tip_amount: tip.value,
  });

  if (error) {
    reportError(error, {
      scope: "payments.cash.record",
      extra: { orderCount: orderIds.value.length, method },
    });
    return { error: parsePaymentError(error.message) };
  }
  if (!data)
    return { error: "Couldn't record that payment. Please try again." };

  revalidatePath("/dashboard/checkout");
  revalidatePath("/dashboard/reports");

  const what = method === "cash" ? "Cash" : "Card-machine payment";
  const count = orderIds.value.length;
  return {
    success:
      count === 1
        ? `${what} recorded.`
        : `${what} recorded for ${count} orders.`,
  };
}

/**
 * Reversing a mistakenly recorded cash payment. Owner/manager only —
 * enforced by reverse_cash_payment(), not here.
 *
 * The row survives: a reversal keeps the amount and the paid_at and gains
 * who reversed it and why. That matters more than tidiness, because the
 * evidence that money was once recorded as received is the first thing
 * anyone wants when a till does not balance.
 */
export async function reverseCashPayment(
  paymentId: string,
  amountLabel: { amount: string; currency: string },
  _prevState: CashState,
  formData: FormData,
): Promise<CashState> {
  const reason = parseReversalReason(formData.get("reason"));
  if (!reason.ok) return { error: reason.message };

  const supabase = await createClient();

  const { error } = await supabase.rpc("reverse_cash_payment", {
    p_payment_id: paymentId,
    p_reason: reason.value,
  });

  if (error) {
    reportError(error, {
      scope: "payments.cash.reverse",
      extra: { paymentId },
    });
    return { error: parsePaymentError(error.message) };
  }

  revalidatePath("/dashboard/reports");
  revalidatePath("/dashboard/checkout");

  const formatted = formatMoney(
    Number(amountLabel.amount),
    amountLabel.currency,
  );

  // Says what it did to the books, not just that it worked: the order goes
  // back to unpaid and will reappear on the settle-up screen, which is the
  // part a reader needs to act on.
  return {
    success: `Reversed ${formatted}. Those orders are unpaid again.`,
  };
}
