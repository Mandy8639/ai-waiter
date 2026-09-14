import "server-only";

import { createClient } from "@/lib/supabase/server";
import { rangeBounds } from "@/lib/reports/range";
import {
  HISTORY_PAGE_SIZE,
  escapeLikePattern,
  parseOrderNumber,
  type HistoryFilters,
} from "./history-filters";

/**
 * The order history page's data source.
 *
 * Read through the ordinary RLS-respecting client rather than a reporting
 * RPC. The reporting functions are gated by assert_can_view_reports()
 * (owner/manager only, because takings are commercial), but "what did
 * table 6 order on Tuesday?" is a floor question — a waiter settling a
 * dispute needs it as much as an owner does. orders_select_own_or_staff
 * already scopes every row to the caller's own restaurant, so the filters
 * below are a display concern, not a security one.
 *
 * Errors are thrown rather than swallowed, for the same reason
 * src/lib/reports/queries.ts throws: an empty history caused by a failed
 * query looks exactly like a restaurant that served nobody, and this page
 * exists to answer questions about money that has already moved.
 */

/**
 * How many matching item rows a text search will consider. A restaurant
 * with years of history could match tens of thousands of lines for a
 * common word like "chicken"; this caps the id list handed back to the
 * orders query rather than letting one search build an unbounded IN list.
 */
const ITEM_MATCH_LIMIT = 2000;

export interface HistoryOrder {
  id: string;
  orderNumber: number;
  status: string;
  total: number;
  currency: string;
  createdAt: string;
  tableLabel: string;
  itemSummary: string;
  itemCount: number;
}

export interface HistoryPage {
  orders: HistoryOrder[];
  /** True when another page exists — from fetching one row beyond the page. */
  hasMore: boolean;
}

export async function getOrderHistory(
  restaurantId: string,
  timeZone: string,
  filters: HistoryFilters,
): Promise<HistoryPage> {
  const supabase = await createClient();

  let query = supabase
    .from("orders")
    .select("id, order_number, status, total, currency, created_at, table_id")
    .eq("restaurant_id", restaurantId);

  if (filters.range !== "all") {
    const bounds = rangeBounds(filters.range, timeZone);
    query = query.gte("created_at", bounds.from).lt("created_at", bounds.to);
  }

  if (filters.status) {
    query = query.eq("status", filters.status);
  }

  // A number is treated as an order number and nothing else: someone
  // holding a receipt wants that order, not every dish whose name happens
  // to contain those digits.
  const orderNumber = filters.search ? parseOrderNumber(filters.search) : null;
  if (orderNumber !== null) {
    query = query.eq("order_number", orderNumber);
  } else if (filters.search) {
    // Text searches dish names, which live on order_items. Resolved to a
    // set of order ids first so the filter runs in the database across the
    // whole history — filtering the fetched page instead would mean
    // searching only the newest 25 orders and calling it a search.
    //
    // RLS (order_items_select_own_or_staff) already scopes this to the
    // caller's restaurant; the explicit restaurant_id is belt and braces
    // and lets the index do the work.
    const { data: matches, error: matchError } = await supabase
      .from("order_items")
      .select("order_id")
      .eq("restaurant_id", restaurantId)
      .ilike("item_name", `%${escapeLikePattern(filters.search)}%`)
      .limit(ITEM_MATCH_LIMIT);

    if (matchError) throw matchError;

    const matchedOrderIds = [
      ...new Set((matches ?? []).map((m) => m.order_id)),
    ];
    if (matchedOrderIds.length === 0) return { orders: [], hasMore: false };
    query = query.in("id", matchedOrderIds);
  }

  // One row beyond the page, so "is there a next page?" costs no extra
  // query and never lies the way a count estimate can.
  const from = filters.page * HISTORY_PAGE_SIZE;
  const { data: rows, error } = await query
    .order("created_at", { ascending: false })
    .range(from, from + HISTORY_PAGE_SIZE);

  if (error) throw error;

  const orders = rows ?? [];
  const orderIds = orders.map((o) => o.id);

  // Items are fetched for every candidate order in one go (the same
  // N+1-avoiding shape as the kitchen board), because the list shows what
  // was ordered — a history of numbers alone answers nothing.
  const [{ data: items }, { data: tables }] = await Promise.all([
    orderIds.length
      ? supabase
          .from("order_items")
          .select("order_id, item_name, quantity")
          .in("order_id", orderIds)
          .order("created_at", { ascending: true })
      : Promise.resolve({ data: [] as OrderItemRow[] }),
    orderIds.length
      ? supabase
          .from("tables")
          .select("id, table_number, display_name")
          .in("id", [...new Set(orders.map((o) => o.table_id))])
      : Promise.resolve({ data: [] as TableRow[] }),
  ]);

  const itemsByOrder = new Map<string, OrderItemRow[]>();
  for (const item of items ?? []) {
    const list = itemsByOrder.get(item.order_id) ?? [];
    list.push(item);
    itemsByOrder.set(item.order_id, list);
  }

  const hasMore = (rows ?? []).length > HISTORY_PAGE_SIZE;
  const visible = orders.slice(0, HISTORY_PAGE_SIZE);

  const tableById = new Map((tables ?? []).map((t) => [t.id, t] as const));

  return {
    hasMore,
    orders: visible.map((o) => {
      const table = tableById.get(o.table_id);
      const orderItems = itemsByOrder.get(o.id) ?? [];
      return {
        id: o.id,
        orderNumber: o.order_number,
        status: o.status,
        total: Number(o.total),
        currency: o.currency,
        createdAt: o.created_at,
        tableLabel:
          table?.display_name || (table ? `Table ${table.table_number}` : "—"),
        itemSummary: orderItems
          .map((i) =>
            i.quantity > 1 ? `${i.quantity}× ${i.item_name}` : i.item_name,
          )
          .join(", "),
        itemCount: orderItems.reduce((sum, i) => sum + i.quantity, 0),
      };
    }),
  };
}

interface OrderItemRow {
  order_id: string;
  item_name: string;
  quantity: number;
}

interface TableRow {
  id: string;
  table_number: string;
  display_name: string | null;
}
