import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";

/**
 * Settle up's "Paid recently": the last payments taken, so a waiter can
 * print or email a receipt after the table has left the list (a paid table
 * leaves Settle up at once, and Reports is for managers). Read through the
 * member's own access (order_payments_select_own_or_staff).
 */

const HOURS = 12;
const LIMIT = 10;

export interface RecentPayment {
  id: string;
  method: string;
  cardPresent: boolean;
  total: number;
  currency: string;
  paidAt: string;
  orderNumbers: number[];
  /** Part of a split bill that isn't fully paid yet: it covers no orders. */
  splitPart: boolean;
}

export async function getRecentPayments(
  restaurantId: string,
): Promise<RecentPayment[]> {
  // split_id and card_present are newer than database.types.ts.
  const supabase = (await createClient()) as unknown as SupabaseClient;
  const { data, error } = await supabase
    .from("order_payments")
    .select(
      "id, method, card_present, total_amount, currency, paid_at, split_id",
    )
    .eq("restaurant_id", restaurantId)
    .eq("status", "succeeded")
    .neq("method", "comp")
    .gt("paid_at", new Date(Date.now() - HOURS * 3_600_000).toISOString())
    .order("paid_at", { ascending: false })
    .limit(LIMIT);
  if (error) throw error;
  const payments = (data ?? []) as {
    id: string;
    method: string;
    card_present: boolean;
    total_amount: number | string;
    currency: string;
    paid_at: string;
    split_id: string | null;
  }[];
  if (payments.length === 0) return [];

  const { data: links } = await supabase
    .from("payment_orders")
    .select("payment_id, orders!inner(order_number)")
    .in(
      "payment_id",
      payments.map((p) => p.id),
    );
  const numbers = new Map<string, number[]>();
  for (const link of (links ?? []) as unknown as {
    payment_id: string;
    orders: { order_number: number } | { order_number: number }[];
  }[]) {
    const orders = Array.isArray(link.orders) ? link.orders : [link.orders];
    const list = numbers.get(link.payment_id) ?? [];
    list.push(...orders.map((o) => o.order_number));
    numbers.set(link.payment_id, list);
  }

  return payments.map((p) => {
    const orderNumbers = (numbers.get(p.id) ?? []).sort((a, b) => a - b);
    return {
      id: p.id,
      method: p.method,
      cardPresent: p.card_present,
      total: Number(p.total_amount),
      currency: p.currency,
      paidAt: p.paid_at,
      orderNumbers,
      splitPart: p.split_id !== null && orderNumbers.length === 0,
    };
  });
}
