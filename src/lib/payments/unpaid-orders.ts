import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import { pickupLabel } from "@/lib/pickup/format-core";

/**
 * What the settle-up screen needs: the orders at this restaurant that
 * money has not yet been taken for, with each one's dishes and any voids,
 * comps and discounts (for the Adjust dialog).
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

/** Today's bills: long enough to cover a service that ran late. */
const RECENT_HOURS = 24;
/** Unpaid orders older than a day are still shown, apart, for this long, so a walkout or a forgotten bill never quietly drops off. */
const OLDER_DAYS = 30;

export interface UnpaidOrder {
  id: string;
  orderNumber: number;
  status: string;
  /** numeric(10,2) in the database, after any voids, comps and discounts. */
  total: number;
  currency: string;
  createdAt: string;
}

export interface BillItem {
  id: string;
  name: string;
  options: string | null;
  quantity: number;
  /** One unit, add-ons included. */
  unitAmount: number;
  voided: number;
  comped: number;
}

export interface BillAdjustment {
  id: string;
  kind: "void" | "comp" | "discount";
  /** The dish, for a void or comp. */
  itemName: string | null;
  quantity: number | null;
  percent: number | null;
  amount: number;
  reason: string;
}

/** An unpaid order with what Settle up's Adjust dialog shows. */
export interface BillOrder extends UnpaidOrder {
  discountTotal: number;
  items: BillItem[];
  adjustments: BillAdjustment[];
}

export interface UnpaidTable {
  /** The table's id — or, at a pickup counter, the diner's session id (the order's own id when staff rang it up), since strangers share a counter but never a bill. */
  tableId: string;
  tableLabel: string;
  orders: BillOrder[];
  /** Sum of the table's outstanding orders — what a whole-tab settle would come to, before any tip. */
  total: number;
  currency: string;
}

export interface SplitPart {
  id: string;
  label: string;
  amount: number;
  status: "open" | "pending" | "paid";
}

/** A bill being paid in parts (20261002090000, 20261115090000). */
export interface OpenSplit {
  id: string;
  mode: "equal" | "by_dish";
  currency: string;
  total: number;
  paidTotal: number;
  /** Made by staff on Settle up, rather than by a diner on their phone. */
  byStaff: boolean;
  orderIds: string[];
  parts: SplitPart[];
}

export interface SettleUpData {
  /** Placed in the last day. */
  recent: UnpaidTable[];
  /** Placed one to 30 days ago and still unpaid. */
  older: UnpaidTable[];
  /** Every open split; its orders stay unpaid until the last part is. */
  splits: OpenSplit[];
}

interface OrderRow {
  id: string;
  order_number: number;
  status: string;
  total: number | string;
  discount_total: number | string;
  currency: string;
  table_id: string;
  customer_session_id: string | null;
  pickup_at: string | null;
  pickup_name: string | null;
  created_at: string;
}

type Rpc = (
  fn: string,
  args: Record<string, unknown>,
) => Promise<{ data: unknown; error: { message: string } | null }>;

export async function getUnpaidOrdersByTable(
  restaurantId: string,
): Promise<SettleUpData> {
  const supabase = await createClient();
  const rpc = supabase.rpc.bind(supabase) as unknown as Rpc;

  const now = Date.now();
  const recentSince = now - RECENT_HOURS * 3_600_000;

  // settle_up_orders() (20261113090000, newer than database.types.ts)
  // returns only orders no succeeded payment covers.
  const [{ data, error }, { data: splitData, error: splitError }] =
    await Promise.all([
      rpc("settle_up_orders", {
        p_restaurant_id: restaurantId,
        p_since: new Date(now - OLDER_DAYS * 86_400_000).toISOString(),
      }),
      rpc("settle_up_splits", { p_restaurant_id: restaurantId }),
    ]);
  if (error) throw error;
  if (splitError) throw splitError;
  const splits: OpenSplit[] = (
    (splitData ?? []) as {
      id: string;
      mode: OpenSplit["mode"];
      currency: string;
      total: number | string;
      paid_total: number | string;
      by_staff: boolean;
      order_ids: string[];
      units: {
        id: string;
        label: string;
        amount: number | string;
        status: SplitPart["status"];
      }[];
    }[]
  ).map((x) => ({
    id: x.id,
    mode: x.mode,
    currency: x.currency,
    total: Number(x.total),
    paidTotal: Number(x.paid_total),
    byStaff: x.by_staff,
    orderIds: x.order_ids,
    parts: x.units.map((u) => ({
      id: u.id,
      label: u.label,
      amount: Number(u.amount),
      status: u.status,
    })),
  }));
  const orders = (data ?? []) as OrderRow[];
  if (orders.length === 0) return { recent: [], older: [], splits };

  const orderIds = orders.map((o) => o.id);

  // Batched rather than per-order, the same N+1-avoiding shape as
  // src/lib/orders/kitchen.ts.
  // order_adjustments is newer than database.types.ts.
  const untyped = supabase as unknown as SupabaseClient;
  const [
    { data: tables, error: tablesError },
    { data: restaurantRow },
    { data: itemRows, error: itemsError },
    { data: adjustmentRows, error: adjustmentsError },
  ] = await Promise.all([
    supabase
      .from("tables")
      .select("id, table_number, display_name")
      .in("id", [...new Set(orders.map((o) => o.table_id))]),
    supabase
      .from("restaurants")
      .select("timezone")
      .eq("id", restaurantId)
      .maybeSingle(),
    supabase
      .from("order_items")
      .select(
        "id, order_id, item_name, quantity, unit_price, modifier_total, created_at",
      )
      .in("order_id", orderIds)
      .order("created_at"),
    untyped
      .from("order_adjustments")
      .select(
        "id, order_id, order_item_id, kind, quantity, percent, amount, reason",
      )
      .in("order_id", orderIds)
      .is("removed_at", null),
  ]);
  if (tablesError) throw tablesError;
  if (itemsError) throw itemsError;
  if (adjustmentsError) throw adjustmentsError;
  const timeZone = restaurantRow?.timezone ?? "UTC";

  const items = (itemRows ?? []) as {
    id: string;
    order_id: string;
    item_name: string;
    quantity: number;
    unit_price: number | string;
    modifier_total: number | string;
  }[];
  const adjustments = (adjustmentRows ?? []) as {
    id: string;
    order_id: string;
    order_item_id: string | null;
    kind: BillAdjustment["kind"];
    quantity: number | null;
    percent: number | string | null;
    amount: number | string;
    reason: string;
  }[];
  const { data: modifierRows } =
    items.length > 0
      ? await supabase
          .from("order_item_modifiers")
          .select("order_item_id, modifier_option_name")
          .in(
            "order_item_id",
            items.map((i) => i.id),
          )
      : { data: [] };
  const optionsByItem = new Map<string, string[]>();
  for (const m of modifierRows ?? []) {
    const list = optionsByItem.get(m.order_item_id) ?? [];
    list.push(m.modifier_option_name);
    optionsByItem.set(m.order_item_id, list);
  }
  const itemName = new Map(items.map((i) => [i.id, i.item_name]));
  const tableById = new Map((tables ?? []).map((t) => [t.id, t]));

  function billOrder(order: OrderRow): BillOrder {
    const own = adjustments.filter((a) => a.order_id === order.id);
    const units = (itemId: string, kind: "void" | "comp") =>
      own
        .filter((a) => a.order_item_id === itemId && a.kind === kind)
        .reduce((sum, a) => sum + (a.quantity ?? 0), 0);
    return {
      id: order.id,
      orderNumber: order.order_number,
      status: order.status,
      total: Number(order.total),
      discountTotal: Number(order.discount_total),
      currency: order.currency,
      createdAt: order.created_at,
      items: items
        .filter((i) => i.order_id === order.id)
        .map((i) => ({
          id: i.id,
          name: i.item_name,
          options: optionsByItem.get(i.id)?.join(", ") ?? null,
          quantity: i.quantity,
          unitAmount: Number(i.unit_price) + Number(i.modifier_total),
          voided: units(i.id, "void"),
          comped: units(i.id, "comp"),
        })),
      adjustments: own.map((a) => ({
        id: a.id,
        kind: a.kind,
        itemName: a.order_item_id
          ? (itemName.get(a.order_item_id) ?? null)
          : null,
        quantity: a.quantity,
        percent: a.percent === null ? null : Number(a.percent),
        amount: Number(a.amount),
        reason: a.reason,
      })),
    };
  }

  function group(rows: OrderRow[]): UnpaidTable[] {
    const byTable = new Map<string, UnpaidTable>();
    for (const order of rows) {
      const table = tableById.get(order.table_id);
      // A pickup order is grouped by the diner who placed it, never with
      // the other strangers at the same counter. One rung up by staff (no
      // diner session, 20261107090000) is its own bill.
      const pickup = Boolean(order.pickup_at && order.pickup_name);
      const key = pickup
        ? `pickup:${order.customer_session_id ?? order.id}`
        : order.table_id;
      const entry = byTable.get(key) ?? {
        tableId: key,
        tableLabel: pickup
          ? pickupLabel(order.pickup_at!, order.pickup_name!, timeZone)
          : table?.display_name ||
            (table ? `Table ${table.table_number}` : "—"),
        orders: [],
        total: 0,
        currency: order.currency,
      };
      const bill = billOrder(order);
      entry.orders.push(bill);
      entry.total = Math.round((entry.total + bill.total) * 100) / 100;
      byTable.set(key, entry);
    }
    return [...byTable.values()].sort((a, b) =>
      a.tableLabel.localeCompare(b.tableLabel, undefined, { numeric: true }),
    );
  }

  return {
    recent: group(
      orders.filter((o) => new Date(o.created_at).getTime() > recentSince),
    ),
    older: group(
      orders.filter((o) => new Date(o.created_at).getTime() <= recentSince),
    ),
    splits,
  };
}
