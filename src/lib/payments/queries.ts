import "server-only";

import { createClient } from "@/lib/supabase/server";

export type PaymentStatus = "pending" | "succeeded" | "failed" | "cancelled";

export interface OrderPaymentState {
  /** Whether a card could actually be charged right now. */
  canTakeCard: boolean;
  tippingEnabled: boolean;
  /** The settled payment, if this order has already been paid. The id is carried so the page can link to its receipt. */
  paid: {
    paymentId: string;
    totalAmount: string;
    tipAmount: string;
    paidAt: string;
    /** Phase J: more than one when the order was paid as part of a split bill, by several people. */
    payerCount: number;
  } | null;
  /** True if an earlier attempt failed or was abandoned — the diner may retry. */
  hasFailedAttempt: boolean;
}

/**
 * What the order page needs to decide between "Pay", "Try again" and
 * "Paid".
 *
 * Errors are surfaced rather than swallowed. Much of this codebase reads
 * `const { data } = await supabase...` and lets a failure look like an
 * empty result; for payment state that would silently show an unpaid
 * screen for a paid order, or the reverse, so a failure here is loud.
 */
export async function getOrderPaymentState(
  orderId: string,
  restaurantId: string,
): Promise<OrderPaymentState> {
  const supabase = await createClient();

  const [settingsResult, paymentsResult] = await Promise.all([
    supabase.rpc("get_public_payment_settings", {
      target_restaurant_id: restaurantId,
    }),
    // Coverage lives in payment_orders since phase 3 — one payment may
    // settle several orders (a tab), so this is an inner join through the
    // coverage table rather than a column on the payment itself.
    supabase
      .from("order_payments")
      .select(
        "id, status, total_amount, tip_amount, paid_at, payment_orders!inner(order_id)",
      )
      .eq("payment_orders.order_id", orderId),
  ]);

  if (settingsResult.error) throw settingsResult.error;
  if (paymentsResult.error) throw paymentsResult.error;

  const settings = settingsResult.data?.[0];
  const payments = paymentsResult.data ?? [];
  const succeeded = payments.filter((p) => p.status === "succeeded");
  const settled = succeeded[0];

  return {
    canTakeCard: settings?.can_take_card ?? false,
    tippingEnabled: settings?.tipping_enabled ?? false,
    paid: settled
      ? {
          paymentId: settled.id,
          totalAmount: settled.total_amount,
          tipAmount: settled.tip_amount,
          paidAt: settled.paid_at as string,
          payerCount: succeeded.length,
        }
      : null,
    hasFailedAttempt: payments.some(
      (p) => p.status === "failed" || p.status === "cancelled",
    ),
  };
}
