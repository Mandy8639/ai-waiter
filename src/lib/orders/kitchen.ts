import "server-only";
import { createClient } from "@/lib/supabase/server";
import { ACTIVE_KITCHEN_STATUSES, type OrderStatus } from "./status";

export interface KitchenOrderModifier {
  id: string;
  optionName: string;
}

export interface KitchenOrderItem {
  id: string;
  itemName: string;
  quantity: number;
  modifiers: KitchenOrderModifier[];
}

export interface KitchenOrder {
  id: string;
  orderNumber: number;
  status: OrderStatus;
  tableLabel: string;
  customerNote: string | null;
  createdAt: string;
  items: KitchenOrderItem[];
}

/** How long a served order stays visible on the board before it drops off — long enough to catch a mistake, short enough not to clutter the screen (spec: "recent served orders for a limited period"). */
const RECENT_SERVED_WINDOW_MINUTES = 30;
/** Upper bound on how far back the board looks at all — never load a whole shift's (or longer) history into a live display. */
const BOARD_LOOKBACK_HOURS = 12;

/**
 * The kitchen display's data source: every order at this restaurant that's
 * still active (pending/confirmed/preparing/ready), plus served orders
 * from the last 30 minutes — never cancelled orders (kept off the active
 * board entirely, per spec section 9), never anything older than 12 hours.
 * RLS (orders_select_own_or_staff) already scopes this to the caller's own
 * restaurant; the WHERE clause here is a display/performance concern, not
 * a security one — see docs/security.md#kds-data-access.
 *
 * Batched (order_items, then order_item_modifiers, then tables) rather
 * than joined/looped per order — the same N+1-avoiding shape as
 * src/lib/cart/get-cart.ts and src/lib/orders/queries.ts.
 */
export async function getActiveOrdersForRestaurant(
  restaurantId: string,
): Promise<KitchenOrder[]> {
  const supabase = await createClient();

  const { data: orders } = await supabase
    .from("orders")
    .select(
      "id, order_number, status, table_id, customer_note, created_at, updated_at",
    )
    .eq("restaurant_id", restaurantId)
    .gt(
      "created_at",
      new Date(Date.now() - BOARD_LOOKBACK_HOURS * 3_600_000).toISOString(),
    )
    .order("created_at", { ascending: true });

  if (!orders || orders.length === 0) return [];

  const servedCutoff = Date.now() - RECENT_SERVED_WINDOW_MINUTES * 60_000;
  const visible = orders.filter((o) => {
    if (o.status === "cancelled") return false;
    if (o.status === "served") {
      return new Date(o.updated_at).getTime() > servedCutoff;
    }
    return true;
  });

  if (visible.length === 0) return [];

  const orderIds = visible.map((o) => o.id);
  const tableIds = [...new Set(visible.map((o) => o.table_id))];

  const [{ data: items }, { data: tables }] = await Promise.all([
    supabase
      .from("order_items")
      .select("id, order_id, item_name, quantity")
      .in("order_id", orderIds)
      .order("created_at", { ascending: true }),
    supabase
      .from("tables")
      .select("id, table_number, display_name")
      .in("id", tableIds),
  ]);

  const itemIds = (items ?? []).map((i) => i.id);
  const { data: modifiers } =
    itemIds.length > 0
      ? await supabase
          .from("order_item_modifiers")
          .select("id, order_item_id, modifier_option_name")
          .in("order_item_id", itemIds)
      : {
          data: [] as {
            id: string;
            order_item_id: string;
            modifier_option_name: string;
          }[],
        };

  const tableById = new Map((tables ?? []).map((t) => [t.id, t]));
  const modifiersByItemId = new Map<string, KitchenOrderModifier[]>();
  for (const m of modifiers ?? []) {
    const list = modifiersByItemId.get(m.order_item_id) ?? [];
    list.push({ id: m.id, optionName: m.modifier_option_name });
    modifiersByItemId.set(m.order_item_id, list);
  }
  const itemsByOrderId = new Map<string, KitchenOrderItem[]>();
  for (const item of items ?? []) {
    const list = itemsByOrderId.get(item.order_id) ?? [];
    list.push({
      id: item.id,
      itemName: item.item_name,
      quantity: item.quantity,
      modifiers: modifiersByItemId.get(item.id) ?? [],
    });
    itemsByOrderId.set(item.order_id, list);
  }

  return visible.map((o) => {
    const table = tableById.get(o.table_id);
    return {
      id: o.id,
      orderNumber: o.order_number,
      status: o.status as OrderStatus,
      tableLabel:
        table?.display_name || (table ? `Table ${table.table_number}` : "—"),
      customerNote: o.customer_note,
      createdAt: o.created_at,
      items: itemsByOrderId.get(o.id) ?? [],
    };
  });
}

export interface OrderStatusHistoryEntry {
  id: string;
  previousStatus: OrderStatus | null;
  status: OrderStatus;
  actorType: string;
  createdAt: string;
}

/** Full audit trail for one order's detail panel — who did what, when (spec section 26). */
export async function getOrderStatusHistory(
  orderId: string,
): Promise<OrderStatusHistoryEntry[]> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("order_status_history")
    .select("id, previous_status, status, actor_type, created_at")
    .eq("order_id", orderId)
    .order("created_at", { ascending: true });

  return (data ?? []).map((h) => ({
    id: h.id,
    previousStatus: h.previous_status as OrderStatus | null,
    status: h.status as OrderStatus,
    actorType: h.actor_type,
    createdAt: h.created_at,
  }));
}

export { ACTIVE_KITCHEN_STATUSES };
