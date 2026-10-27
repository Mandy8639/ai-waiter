import "server-only";
import { after } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createAdminClient } from "@/lib/supabase/admin";
import { reportError } from "@/lib/observability/report";
import { afterAttempt } from "../outbox-core";
import {
  CloverError,
  cloverConfig,
  createCloverAtomicOrder,
  listCloverOrderTypes,
} from "./api";
import {
  buildCloverOrder,
  pickOrderType,
  type CloverOrderInput,
} from "./order-core";

/**
 * Sends a restaurant's placed orders to its Clover register
 * (20261121090000): claims the due pos_outbox rows, creates each order in
 * Clover with the atomic order endpoint, and records what happened with
 * outbox-core's retry rules. Runs with the service key, for one
 * restaurant's own orders only. Never throws: it runs after the order was
 * placed (next/server `after`), and a Clover outage must never surface as
 * a failed order — the outbox retries it.
 */
export async function deliverCloverOrders(restaurantId: string): Promise<void> {
  if (!cloverConfig()) return;
  const admin = createAdminClient() as unknown as SupabaseClient;

  const { data: integration } = await admin
    .from("restaurant_pos_integrations")
    .select("provider, is_enabled")
    .eq("restaurant_id", restaurantId)
    .maybeSingle<{ provider: string; is_enabled: boolean }>();
  if (integration?.provider !== "clover" || !integration.is_enabled) return;

  const { data: claimed, error } = await admin.rpc("claim_pos_outbox", {
    p_restaurant_id: restaurantId,
    p_limit: 20,
  });
  if (error) {
    reportError(error, {
      scope: "clover.outbox.claim",
      extra: { restaurantId },
    });
    return;
  }
  const rows = (claimed ?? []) as {
    id: string;
    order_id: string;
    attempts: number;
  }[];
  if (rows.length === 0) return;

  let orderTypeId: string | null | undefined;
  for (const row of rows) {
    let ok = false;
    let externalId: string | null = null;
    let failure: string | undefined;
    try {
      if (orderTypeId === undefined) {
        orderTypeId = pickOrderType(await listCloverOrderTypes(restaurantId));
      }
      const input = await loadOrder(admin, row.order_id, orderTypeId);
      externalId = (
        await createCloverAtomicOrder(restaurantId, buildCloverOrder(input))
      ).id;
      ok = true;
    } catch (e) {
      failure =
        e instanceof CloverError
          ? `${e.message} ${e.detail ?? ""}`.trim()
          : e instanceof Error
            ? e.message
            : String(e);
      reportError(e, {
        scope: "clover.outbox.deliver",
        extra: {
          restaurantId,
          orderId: row.order_id,
          attempt: row.attempts + 1,
        },
      });
    }

    const outcome = afterAttempt({
      ok,
      attemptsBefore: row.attempts,
      error: failure,
    });
    await admin
      .from("pos_outbox")
      .update({
        status: outcome.status,
        attempts: outcome.attempts,
        last_error: outcome.lastError,
        ...(outcome.nextAttemptAt
          ? { next_attempt_at: outcome.nextAttemptAt }
          : {}),
        ...(ok
          ? { external_id: externalId, delivered_at: new Date().toISOString() }
          : {}),
      })
      .eq("id", row.id);
  }
}

async function loadOrder(
  admin: SupabaseClient,
  orderId: string,
  orderTypeId: string | null,
): Promise<CloverOrderInput> {
  const { data: order, error } = await admin
    .from("orders")
    .select("id, order_number, customer_note, table_id, pickup_name")
    .eq("id", orderId)
    .single<{
      id: string;
      order_number: number;
      customer_note: string | null;
      table_id: string | null;
      pickup_name: string | null;
    }>();
  if (error || !order) throw new Error("The order to send wasn't found");

  const [{ data: items }, { data: table }] = await Promise.all([
    admin
      .from("order_items")
      .select(
        "id, item_name, quantity, unit_price, menu_items(external_id), order_item_modifiers(modifier_option_name, price_adjustment, modifier_options(external_id))",
      )
      .eq("order_id", orderId)
      .order("created_at"),
    order.table_id
      ? admin
          .from("tables")
          .select("table_number, display_name")
          .eq("id", order.table_id)
          .maybeSingle<{ table_number: string; display_name: string | null }>()
      : Promise.resolve({ data: null }),
  ]);

  type Row = {
    item_name: string;
    quantity: number;
    unit_price: number | string;
    menu_items: { external_id: string | null } | null;
    order_item_modifiers: {
      modifier_option_name: string;
      price_adjustment: number | string;
      modifier_options: { external_id: string | null } | null;
    }[];
  };
  return {
    orderNumber: order.order_number,
    tableLabel: order.pickup_name
      ? `Pickup: ${order.pickup_name}`
      : table
        ? table.display_name || `Table ${table.table_number}`
        : null,
    customerNote: order.customer_note,
    orderTypeId,
    lines: ((items ?? []) as unknown as Row[]).map((item) => ({
      name: item.item_name,
      cloverItemId: item.menu_items?.external_id ?? null,
      unitPrice: Number(item.unit_price),
      quantity: item.quantity,
      options: (item.order_item_modifiers ?? []).map((m) => ({
        name: m.modifier_option_name,
        cloverModifierId: m.modifier_options?.external_id ?? null,
        priceAdjustment: Number(m.price_adjustment),
      })),
    })),
  };
}

/**
 * Called by both ordering paths (submitOrder and the POS's
 * staff_place_order) with the id the database just returned, next to the
 * kitchen push. After the response has gone: delivers that restaurant's
 * due orders, this one included, and any earlier ones still retrying.
 */
export function scheduleCloverDelivery(orderId: string): void {
  if (!cloverConfig()) return;
  after(async () => {
    try {
      const admin = createAdminClient() as unknown as SupabaseClient;
      const { data } = await admin
        .from("orders")
        .select("restaurant_id")
        .eq("id", orderId)
        .maybeSingle<{ restaurant_id: string }>();
      if (data) await deliverCloverOrders(data.restaurant_id);
    } catch (e) {
      reportError(e, { scope: "clover.outbox.schedule", extra: { orderId } });
    }
  });
}
