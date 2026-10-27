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
  /** Where it was paid: "Table 4", a table's own name, or the pickup name. Staff think in tables. */
  tableLabels: string[];
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
    .select("payment_id, orders!inner(order_number, table_id, pickup_name)")
    .in(
      "payment_id",
      payments.map((p) => p.id),
    );
  type LinkedOrder = {
    order_number: number;
    table_id: string | null;
    pickup_name: string | null;
  };
  const linked = new Map<string, LinkedOrder[]>();
  for (const link of (links ?? []) as unknown as {
    payment_id: string;
    orders: LinkedOrder | LinkedOrder[];
  }[]) {
    const orders = Array.isArray(link.orders) ? link.orders : [link.orders];
    linked.set(link.payment_id, [
      ...(linked.get(link.payment_id) ?? []),
      ...orders,
    ]);
  }

  const tableIds = [
    ...new Set(
      [...linked.values()]
        .flat()
        .map((o) => o.table_id)
        .filter((id): id is string => Boolean(id)),
    ),
  ];
  const { data: tables } =
    tableIds.length > 0
      ? await supabase
          .from("tables")
          .select("id, table_number, display_name")
          .in("id", tableIds)
      : { data: [] };
  const tableName = new Map(
    (
      (tables ?? []) as {
        id: string;
        table_number: string;
        display_name: string | null;
      }[]
    ).map((t) => [t.id, t.display_name || `Table ${t.table_number}`]),
  );
  // As Settle up labels a bill: a pickup by its name, else the table.
  const label = (o: LinkedOrder) =>
    o.pickup_name
      ? `Pickup: ${o.pickup_name}`
      : ((o.table_id && tableName.get(o.table_id)) ?? null);

  return payments.map((p) => {
    const orders = linked.get(p.id) ?? [];
    const orderNumbers = orders
      .map((o) => o.order_number)
      .sort((a, b) => a - b);
    const tableLabels = [
      ...new Set(orders.map(label).filter((l): l is string => Boolean(l))),
    ];
    return {
      id: p.id,
      method: p.method,
      cardPresent: p.card_present,
      total: Number(p.total_amount),
      currency: p.currency,
      paidAt: p.paid_at,
      orderNumbers,
      tableLabels,
      splitPart: p.split_id !== null && orderNumbers.length === 0,
    };
  });
}
