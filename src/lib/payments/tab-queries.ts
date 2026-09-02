import "server-only";

import { createClient } from "@/lib/supabase/server";
import { deriveTab, type TabCoverageInput, type TabOrderLine } from "./tab";

/**
 * What the diner's order list needs to decide whether to offer "pay for
 * everything", and for how much.
 *
 * Reads only. The rule for what a tab still owes lives in ./tab.ts, where
 * it can be tested without a database — see the note there on why that
 * rule exists in two places at all.
 *
 * Errors are surfaced rather than swallowed, matching
 * src/lib/payments/queries.ts: showing a diner "nothing left to pay"
 * because a query failed is how a table walks out unpaid.
 */

export interface TabPaymentState {
  /** Every live order in this session, newest first, each marked paid or not. */
  orders: TabOrderLine[];
  /** Orders still owed for. A tab is only worth offering at 2 or more — one order is what the order page already does. */
  unpaidCount: number;
  unpaidTotal: number;
  currency: string;
  canTakeCard: boolean;
  tippingEnabled: boolean;
  /**
   * A tab payment already open at Stripe. start_tab_payment() reuses it,
   * but only when the tip matches — so the panel defaults the tip to this
   * rather than letting a diner hit PAYMENT_IN_PROGRESS for changing a
   * number the page invited them to change.
   */
  pendingTip: number | null;
  /** A session spanning two currencies, which no single charge can cover. */
  mixedCurrency: boolean;
}

export async function getTabPaymentState(
  customerSessionId: string,
  restaurantId: string,
): Promise<TabPaymentState> {
  const supabase = await createClient();

  const [settingsResult, ordersResult] = await Promise.all([
    supabase.rpc("get_public_payment_settings", {
      target_restaurant_id: restaurantId,
    }),
    supabase
      .from("orders")
      .select("id, order_number, status, total, currency")
      .eq("customer_session_id", customerSessionId)
      .order("created_at", { ascending: false }),
  ]);

  if (settingsResult.error) throw settingsResult.error;
  if (ordersResult.error) throw ordersResult.error;

  const settings = settingsResult.data?.[0];
  const canTakeCard = settings?.can_take_card ?? false;
  const tippingEnabled = settings?.tipping_enabled ?? false;

  const orders = (ordersResult.data ?? []).map((o) => ({
    id: o.id,
    orderNumber: o.order_number,
    status: o.status,
    total: Number(o.total),
    currency: o.currency,
  }));

  if (orders.length === 0) {
    return {
      orders: [],
      unpaidCount: 0,
      unpaidTotal: 0,
      currency: "USD",
      canTakeCard,
      tippingEnabled,
      pendingTip: null,
      mixedCurrency: false,
    };
  }

  // Coverage and in-flight payments in one read: every payment touching
  // any of this session's orders, with its status and tip.
  const { data: coverage, error: coverageError } = await supabase
    .from("payment_orders")
    .select("order_id, order_payments!inner(status, tip_amount)")
    .in(
      "order_id",
      orders.map((o) => o.id),
    );

  if (coverageError) throw coverageError;

  const rows: TabCoverageInput[] = (coverage ?? []).map((row) => {
    // PostgREST types an embedded to-one relation as an array; at runtime
    // an !inner join on a to-one gives the object itself.
    const payment = row.order_payments as unknown as {
      status: string;
      tip_amount: string | number;
    };
    return {
      orderId: row.order_id,
      status: payment.status,
      tipAmount: Number(payment.tip_amount),
    };
  });

  return { ...deriveTab(orders, rows), canTakeCard, tippingEnabled };
}
