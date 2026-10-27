import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";

/**
 * Settle up's view of guests paying on their phones (20261120090000): who
 * paid for a bill that was already settled, and which tables have a phone
 * payment under way right now. Both read as the signed-in member, through
 * RLS. payment_conflicts is newer than database.types.ts.
 */

/** A phone payment started (or reopened) this recently is probably still being paid. */
const PAYING_NOW_MINUTES = 15;

export interface PaymentConflict {
  id: string;
  provider: "stripe" | "square";
  amount: number;
  currency: string;
  refundStatus: "pending" | "refunded" | "failed";
  orderNumbers: number[];
  detectedAt: string;
}

interface ConflictRow {
  id: string;
  provider: "stripe" | "square";
  amount: string | number;
  currency: string;
  refund_status: PaymentConflict["refundStatus"];
  detected_at: string;
  order_payments: {
    payment_orders: { orders: { order_number: number } | null }[];
  } | null;
}

/** Not yet acknowledged by an owner or manager, newest first. */
export async function getOpenPaymentConflicts(
  restaurantId: string,
): Promise<PaymentConflict[]> {
  const supabase = (await createClient()) as unknown as SupabaseClient;
  const { data } = await supabase
    .from("payment_conflicts")
    .select(
      "id, provider, amount, currency, refund_status, detected_at, order_payments(payment_orders(orders(order_number)))",
    )
    .eq("restaurant_id", restaurantId)
    .is("acknowledged_at", null)
    .order("detected_at", { ascending: false })
    .limit(20);
  return ((data ?? []) as unknown as ConflictRow[]).map((row) => ({
    id: row.id,
    provider: row.provider,
    amount: Number(row.amount),
    currency: row.currency,
    refundStatus: row.refund_status,
    orderNumbers: (row.order_payments?.payment_orders ?? [])
      .map((po) => po.orders?.order_number)
      .filter((n): n is number => typeof n === "number")
      .sort((a, b) => a - b),
    detectedAt: row.detected_at,
  }));
}

/**
 * Orders a guest is paying for on their phone right now: a Stripe
 * Checkout or Square online payment still pending. Staff-started card
 * payments (a Square Terminal, Tap to Pay) aren't phone payments: the
 * person at the table already knows about those.
 */
export async function getOrdersPayingOnPhone(
  restaurantId: string,
  now: Date = new Date(),
): Promise<Set<string>> {
  const supabase = (await createClient()) as unknown as SupabaseClient;
  const since = new Date(
    now.getTime() - PAYING_NOW_MINUTES * 60_000,
  ).toISOString();
  const { data } = await supabase
    .from("order_payments")
    .select("id, payment_orders(order_id)")
    .eq("restaurant_id", restaurantId)
    .eq("status", "pending")
    .eq("method", "card")
    .is("square_terminal_checkout_id", null)
    .or("stripe_checkout_session_id.not.is.null,square_order_id.not.is.null")
    .gte("updated_at", since);
  const ids = new Set<string>();
  for (const payment of (data ?? []) as {
    payment_orders: { order_id: string }[];
  }[]) {
    for (const po of payment.payment_orders ?? []) ids.add(po.order_id);
  }
  return ids;
}
