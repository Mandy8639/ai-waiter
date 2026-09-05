import "server-only";
import { createClient } from "@/lib/supabase/server";

export interface OrderItemModifierView {
  id: string;
  groupName: string;
  optionName: string;
  priceAdjustment: number;
}

export interface OrderItemView {
  id: string;
  itemName: string;
  /** The dish's recorded preparation time, or null if it has none. */
  prepMinutes: number | null;
  quantity: number;
  unitPrice: number;
  modifierTotal: number;
  lineTotal: number;
  modifiers: OrderItemModifierView[];
}

export interface OrderView {
  id: string;
  orderNumber: number;
  status: string;
  subtotal: number;
  tax: number;
  serviceCharge: number;
  total: number;
  currency: string;
  customerNote: string | null;
  createdAt: string;
  restaurantName: string;
  restaurantId: string;
  restaurantSlug: string;
  tableLabel: string;
  items: OrderItemView[];
}

/**
 * Reads one order the caller is allowed to see. RLS
 * (orders_select_own_or_staff) scopes this to the caller's own customer
 * session or, for restaurant staff, their own restaurant — nothing here
 * re-checks ownership in TypeScript, because the database already made it
 * impossible to over-fetch: a mismatched or another customer's orderId
 * simply returns no row, indistinguishable from "doesn't exist" (see
 * docs/security.md#customer-order-access — never leak "exists but isn't
 * yours" via a different error).
 */
export async function getOrderById(orderId: string): Promise<OrderView | null> {
  const supabase = await createClient();

  const { data: order } = await supabase
    .from("orders")
    .select(
      "id, order_number, status, subtotal, tax, service_charge, total, currency, customer_note, created_at, restaurant_id, table_id",
    )
    .eq("id", orderId)
    .maybeSingle();

  if (!order) return null;

  const [{ data: restaurant }, { data: table }, { data: items }] =
    await Promise.all([
      supabase
        .from("restaurants")
        .select("name, slug")
        .eq("id", order.restaurant_id)
        .maybeSingle(),
      supabase
        .from("tables")
        .select("table_number, display_name")
        .eq("id", order.table_id)
        .maybeSingle(),
      supabase
        .from("order_items")
        .select(
          "id, menu_item_id, item_name, quantity, unit_price, modifier_total, line_total",
        )
        .eq("order_id", order.id)
        .order("created_at", { ascending: true }),
    ]);

  // Preparation times are read LIVE from menu_items rather than
  // snapshotted onto the order line. Deliberate: this estimate is only
  // meaningful while the food is being cooked, minutes after placement,
  // and a menu rarely changes in that window. For a historical order the
  // number is meaningless anyway, so snapshotting it would add a column
  // and a submit_order rewrite to buy accuracy nobody reads.
  const menuItemIds = [
    ...new Set(
      (items ?? [])
        .map((i) => i.menu_item_id)
        .filter((id): id is string => Boolean(id)),
    ),
  ];
  const { data: prepRows } =
    menuItemIds.length > 0
      ? await supabase
          .from("menu_items")
          .select("id, preparation_time")
          .in("id", menuItemIds)
      : { data: [] as { id: string; preparation_time: number | null }[] };
  const prepById = new Map(
    (prepRows ?? []).map((r) => [r.id, r.preparation_time]),
  );

  const itemIds = (items ?? []).map((i) => i.id);
  const { data: modifiers } =
    itemIds.length > 0
      ? await supabase
          .from("order_item_modifiers")
          .select(
            "id, order_item_id, modifier_group_name, modifier_option_name, price_adjustment",
          )
          .in("order_item_id", itemIds)
      : {
          data: [] as {
            id: string;
            order_item_id: string;
            modifier_group_name: string;
            modifier_option_name: string;
            price_adjustment: number;
          }[],
        };

  const modifiersByItemId = new Map<string, OrderItemModifierView[]>();
  for (const m of modifiers ?? []) {
    const list = modifiersByItemId.get(m.order_item_id) ?? [];
    list.push({
      id: m.id,
      groupName: m.modifier_group_name,
      optionName: m.modifier_option_name,
      priceAdjustment: Number(m.price_adjustment),
    });
    modifiersByItemId.set(m.order_item_id, list);
  }

  return {
    id: order.id,
    orderNumber: order.order_number,
    status: order.status,
    subtotal: Number(order.subtotal),
    tax: Number(order.tax),
    serviceCharge: Number(order.service_charge),
    total: Number(order.total),
    currency: order.currency,
    customerNote: order.customer_note,
    createdAt: order.created_at,
    restaurantName: restaurant?.name ?? "Restaurant",
    restaurantId: order.restaurant_id,
    restaurantSlug: restaurant?.slug ?? "",
    tableLabel:
      table?.display_name || (table ? `Table ${table.table_number}` : "—"),
    items: (items ?? []).map((i) => ({
      id: i.id,
      itemName: i.item_name,
      // null when the dish was deleted from the menu, or never had one.
      prepMinutes: i.menu_item_id
        ? (prepById.get(i.menu_item_id) ?? null)
        : null,
      quantity: i.quantity,
      unitPrice: Number(i.unit_price),
      modifierTotal: Number(i.modifier_total),
      lineTotal: Number(i.line_total),
      modifiers: modifiersByItemId.get(i.id) ?? [],
    })),
  };
}

export interface OrderSummary {
  id: string;
  orderNumber: number;
  status: string;
  total: number;
  currency: string;
  createdAt: string;
}

/**
 * Every order placed by the caller's own current customer session —
 * session-scoped history, not account-based (spec section 21: no
 * signup/account required, so there is no cross-session order history to
 * offer — a new QR scan starts a new session with an empty history, by
 * design).
 */
export async function getOrdersForSession(
  customerSessionId: string,
): Promise<OrderSummary[]> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("orders")
    .select("id, order_number, status, total, currency, created_at")
    .eq("customer_session_id", customerSessionId)
    .order("created_at", { ascending: false });

  return (data ?? []).map((o) => ({
    id: o.id,
    orderNumber: o.order_number,
    status: o.status,
    total: Number(o.total),
    currency: o.currency,
    createdAt: o.created_at,
  }));
}
