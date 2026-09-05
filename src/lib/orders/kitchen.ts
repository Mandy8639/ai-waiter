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
  /** The heat this diner asked for, or null for "as you normally make it". */
  spicePreference: string | null;
  /** The diner's free-text request for this line, or null. */
  notes: string | null;
  ticketGroupId: string | null;
}

/** A kitchen ticket group's own status is independent of the order's — see order_status_rank()/recompute_order_status_from_groups() in the migration for how the order's own status is derived from these. */
export interface KitchenTicketGroup {
  id: string;
  label: string | null;
  status: OrderStatus;
}

export interface KitchenOrder {
  id: string;
  orderNumber: number;
  status: OrderStatus;
  tableLabel: string;
  customerNote: string | null;
  createdAt: string;
  items: KitchenOrderItem[];
  /** Empty when this order has never been split/merged — every item's ticketGroupId is then null too, and the card renders exactly as it always has. */
  ticketGroups: KitchenTicketGroup[];
  /** Other order ids sharing at least one of this order's ticket groups (a merge) — empty unless merged. */
  mergedWithOrderIds: string[];
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
      .select(
        "id, order_id, item_name, quantity, ticket_group_id, spice_preference, notes",
      )
      .in("order_id", orderIds)
      .order("created_at", { ascending: true }),
    supabase
      .from("tables")
      .select("id, table_number, display_name")
      .in("id", tableIds),
  ]);

  const ticketGroupIdByItemId = new Map<string, string>();
  for (const item of items ?? []) {
    if (item.ticket_group_id) {
      ticketGroupIdByItemId.set(item.id, item.ticket_group_id);
    }
  }

  const ticketGroupIds = [...new Set(ticketGroupIdByItemId.values())];
  const { data: ticketGroupRows } =
    ticketGroupIds.length > 0
      ? await supabase
          .from("order_ticket_groups")
          .select("id, label, status")
          .in("id", ticketGroupIds)
      : { data: [] as { id: string; label: string | null; status: string }[] };
  const ticketGroupById = new Map(
    (ticketGroupRows ?? []).map((g) => [g.id, g]),
  );
  // Which orders each ticket group's items actually touch — the basis for
  // "merged with" detection: a group touching 2+ distinct orders is a merge.
  const orderIdsByTicketGroupId = new Map<string, Set<string>>();
  for (const item of items ?? []) {
    const ticketGroupId = ticketGroupIdByItemId.get(item.id);
    if (!ticketGroupId) continue;
    const set = orderIdsByTicketGroupId.get(ticketGroupId) ?? new Set();
    set.add(item.order_id);
    orderIdsByTicketGroupId.set(ticketGroupId, set);
  }

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
  const ticketGroupIdsByOrderId = new Map<string, Set<string>>();
  for (const item of items ?? []) {
    const ticketGroupId = ticketGroupIdByItemId.get(item.id) ?? null;
    const list = itemsByOrderId.get(item.order_id) ?? [];
    list.push({
      id: item.id,
      itemName: item.item_name,
      quantity: item.quantity,
      modifiers: modifiersByItemId.get(item.id) ?? [],
      spicePreference: item.spice_preference,
      notes: item.notes,
      ticketGroupId,
    });
    itemsByOrderId.set(item.order_id, list);

    if (ticketGroupId) {
      const set = ticketGroupIdsByOrderId.get(item.order_id) ?? new Set();
      set.add(ticketGroupId);
      ticketGroupIdsByOrderId.set(item.order_id, set);
    }
  }

  return visible.map((o) => {
    const table = tableById.get(o.table_id);
    const groupIds = [...(ticketGroupIdsByOrderId.get(o.id) ?? [])];
    const mergedWithOrderIds = new Set<string>();
    for (const groupId of groupIds) {
      for (const otherOrderId of orderIdsByTicketGroupId.get(groupId) ?? []) {
        if (otherOrderId !== o.id) mergedWithOrderIds.add(otherOrderId);
      }
    }

    return {
      id: o.id,
      orderNumber: o.order_number,
      status: o.status as OrderStatus,
      tableLabel:
        table?.display_name || (table ? `Table ${table.table_number}` : "—"),
      customerNote: o.customer_note,
      createdAt: o.created_at,
      items: itemsByOrderId.get(o.id) ?? [],
      ticketGroups: groupIds
        .map((id) => {
          const g = ticketGroupById.get(id);
          return g
            ? { id: g.id, label: g.label, status: g.status as OrderStatus }
            : null;
        })
        .filter((g): g is KitchenTicketGroup => g !== null),
      mergedWithOrderIds: [...mergedWithOrderIds],
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
