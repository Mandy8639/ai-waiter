import "server-only";

import { createClient } from "@/lib/supabase/server";
import { pickupLabel } from "@/lib/pickup/format-core";

/**
 * What the settle-up screen needs: the orders at this restaurant that
 * money has not yet been taken for.
 *
 * "Unpaid" is defined the same way record_cash_payment() defines it — no
 * *succeeded* payment covering the order — rather than by an order column,
 * because there isn't one: payment state lives in order_payments, joined
 * through payment_orders since a single payment may settle a whole tab.
 * Defining it any other way here would let this screen disagree with the
 * function it feeds, and offer a button that then refuses.
 *
 * A failed or abandoned card attempt therefore leaves an order unpaid and
 * still listed, which is correct: the diner's card was declined and they
 * are now offering notes.
 *
 * Errors are thrown rather than swallowed, for the same reason they are in
 * src/lib/reports/queries.ts — an empty settle-up screen caused by a
 * failed query looks exactly like a restaurant with nothing outstanding,
 * and would have staff let a table walk out.
 */

/** How far back the screen looks. Long enough to cover a service that ran late, short enough that yesterday's unpaid orders don't pile up in front of tonight's. */
const LOOKBACK_HOURS = 24;

export interface UnpaidOrder {
  id: string;
  orderNumber: number;
  status: string;
  /** numeric(10,2) in the database; PostgREST hands it back as a number for a plain column select, unlike the RPC reads in src/lib/reports/queries.ts which return strings. */
  total: number;
  currency: string;
  createdAt: string;
}

export interface UnpaidTable {
  /** The table's id — or, at a pickup counter, the diner's session id, since strangers share a counter but never a bill. */
  tableId: string;
  tableLabel: string;
  orders: UnpaidOrder[];
  /** Sum of the table's outstanding orders — what a whole-tab settle would come to, before any tip. */
  total: number;
  currency: string;
}

export async function getUnpaidOrdersByTable(
  restaurantId: string,
): Promise<UnpaidTable[]> {
  const supabase = await createClient();

  const since = new Date(Date.now() - LOOKBACK_HOURS * 3_600_000).toISOString();

  const { data: orders, error } = await supabase
    .from("orders")
    // customer_session_id, pickup_*: grouping a pickup counter by diner
    // (20261022090000, newer than database.types.ts).
    .select(
      "id, order_number, status, total, currency, table_id, created_at, customer_session_id, pickup_at, pickup_name" as "id, order_number, status, total, currency, table_id, created_at",
    )
    .eq("restaurant_id", restaurantId)
    .neq("status", "cancelled")
    .gt("created_at", since)
    .order("created_at", { ascending: true });

  if (error) throw error;
  if (!orders || orders.length === 0) return [];

  const orderIds = orders.map((o) => o.id);

  // Which of those are already settled. Batched rather than per-order, the
  // same N+1-avoiding shape as src/lib/orders/kitchen.ts.
  const [
    { data: settled, error: settledError },
    { data: tables, error: tablesError },
    { data: restaurantRow },
  ] = await Promise.all([
    supabase
      .from("payment_orders")
      .select("order_id, order_payments!inner(status)")
      .in("order_id", orderIds)
      .eq("order_payments.status", "succeeded"),
    supabase
      .from("tables")
      .select("id, table_number, display_name")
      .in("id", [...new Set(orders.map((o) => o.table_id))]),
    supabase
      .from("restaurants")
      .select("timezone")
      .eq("id", restaurantId)
      .maybeSingle(),
  ]);
  const timeZone = restaurantRow?.timezone ?? "UTC";

  if (settledError) throw settledError;
  if (tablesError) throw tablesError;

  const paidOrderIds = new Set((settled ?? []).map((row) => row.order_id));
  const tableById = new Map((tables ?? []).map((t) => [t.id, t]));

  const byTable = new Map<string, UnpaidTable>();
  for (const order of orders) {
    if (paidOrderIds.has(order.id)) continue;

    const table = tableById.get(order.table_id);
    const pickup = order as unknown as {
      customer_session_id: string;
      pickup_at: string | null;
      pickup_name: string | null;
    };
    // A pickup order is grouped by the diner who placed it, never with the
    // other strangers at the same counter.
    const key =
      pickup.pickup_at && pickup.pickup_name
        ? `pickup:${pickup.customer_session_id}`
        : order.table_id;
    const group = byTable.get(key) ?? {
      tableId: key,
      tableLabel:
        pickup.pickup_at && pickup.pickup_name
          ? pickupLabel(pickup.pickup_at, pickup.pickup_name, timeZone)
          : table?.display_name ||
            (table ? `Table ${table.table_number}` : "—"),
      orders: [],
      total: 0,
      currency: order.currency,
    };

    group.orders.push({
      id: order.id,
      orderNumber: order.order_number,
      status: order.status,
      total: order.total,
      currency: order.currency,
      createdAt: order.created_at,
    });
    group.total += order.total;
    byTable.set(key, group);
  }

  return [...byTable.values()].sort((a, b) =>
    a.tableLabel.localeCompare(b.tableLabel, undefined, { numeric: true }),
  );
}
