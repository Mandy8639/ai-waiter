import "server-only";

import { createClient } from "@/lib/supabase/server";
import { receiptState, netPaid, type ReceiptState } from "./receipt-status";

/**
 * Reading one payment as a receipt.
 *
 * ACCESS IS RLS, NOT AN ACTIVE SESSION. Every other customer page gates on
 * getActiveCustomerSession(), which returns null four hours after the QR
 * scan. A receipt that expires with the meal is not a receipt, so this
 * reads through order_payments_select_own_or_staff instead: the policy
 * matches on `cs.user_id = auth.uid()` and never looks at the session's
 * status or expiry, so the diner keeps access for as long as their browser
 * keeps its anonymous auth token. Staff at the restaurant can read it too,
 * by the same policy — which is what makes this usable at the table when a
 * customer asks for their bill.
 *
 * A stranger, or a diner from another table, gets null: indistinguishable
 * from a payment that does not exist, the same shape as getOrderById().
 *
 * REFUNDS COME FROM A FUNCTION, NOT THE TABLE. payment_refunds is
 * staff-only (payment_refunds_select_staff), so a plain join would return
 * nothing for the diner and the receipt would confidently show the full
 * amount for a payment that was half returned. payment_refunded_total() is
 * SECURITY DEFINER and already granted to `authenticated`, so it gives the
 * payer the figure they are entitled to — while `payment_refunds.reason`,
 * which is staff's internal audit note about what went wrong, stays where
 * it belongs.
 */

export interface ReceiptLine {
  id: string;
  itemName: string;
  quantity: number;
  lineTotal: number;
  modifiers: string[];
}

export interface ReceiptOrder {
  id: string;
  orderNumber: number;
  subtotal: number;
  tax: number;
  serviceCharge: number;
  total: number;
  lines: ReceiptLine[];
}

export interface Receipt {
  paymentId: string;
  state: ReceiptState;
  method: string;
  currency: string;
  /** The orders' combined total, before tip. */
  amount: number;
  tip: number;
  /** amount + tip: what was actually charged. */
  total: number;
  refunded: number;
  /** total less refunds, floored at zero; zero for a reversal. */
  net: number;
  paidAt: string | null;
  reversedAt: string | null;
  orders: ReceiptOrder[];
}

export async function getReceipt(paymentId: string): Promise<Receipt | null> {
  const supabase = await createClient();

  const { data: payment } = await supabase
    .from("order_payments")
    .select(
      "id, status, method, amount, tip_amount, total_amount, currency, paid_at, reversed_at",
    )
    .eq("id", paymentId)
    .maybeSingle();

  if (!payment) return null;

  const { data: coverage } = await supabase
    .from("payment_orders")
    .select("order_id")
    .eq("payment_id", paymentId);

  const orderIds = (coverage ?? []).map((row) => row.order_id);

  // Errors are thrown rather than swallowed for the refund figure
  // specifically: a failed call returning 0 would render a full-price
  // receipt for a refunded payment, which is the one falsehood this
  // document must never tell.
  const { data: refundedRaw, error: refundError } = await supabase.rpc(
    "payment_refunded_total",
    { p_payment_id: paymentId },
  );
  if (refundError) throw refundError;

  const total = Number(payment.total_amount);
  const refunded = Number(refundedRaw ?? 0);
  const amounts = { status: payment.status, total, refunded };

  const orders = orderIds.length > 0 ? await readOrders(orderIds) : [];

  return {
    paymentId: payment.id,
    state: receiptState(amounts),
    method: payment.method,
    currency: payment.currency,
    amount: Number(payment.amount),
    tip: Number(payment.tip_amount),
    total,
    refunded,
    net: netPaid(amounts),
    paidAt: payment.paid_at,
    reversedAt: payment.reversed_at,
    orders,
  };
}

/** Batched rather than per-order — the same N+1-avoiding shape as src/lib/orders/kitchen.ts. */
async function readOrders(orderIds: string[]): Promise<ReceiptOrder[]> {
  const supabase = await createClient();

  const [{ data: orders }, { data: items }] = await Promise.all([
    supabase
      .from("orders")
      .select("id, order_number, subtotal, tax, service_charge, total")
      .in("id", orderIds)
      .order("order_number", { ascending: true }),
    supabase
      .from("order_items")
      .select("id, order_id, item_name, quantity, line_total")
      .in("order_id", orderIds)
      .order("created_at", { ascending: true }),
  ]);

  const itemIds = (items ?? []).map((i) => i.id);
  const { data: modifiers } =
    itemIds.length > 0
      ? await supabase
          .from("order_item_modifiers")
          .select("order_item_id, modifier_option_name")
          .in("order_item_id", itemIds)
      : {
          data: [] as { order_item_id: string; modifier_option_name: string }[],
        };

  const modifiersByItemId = new Map<string, string[]>();
  for (const m of modifiers ?? []) {
    const list = modifiersByItemId.get(m.order_item_id) ?? [];
    list.push(m.modifier_option_name);
    modifiersByItemId.set(m.order_item_id, list);
  }

  const linesByOrderId = new Map<string, ReceiptLine[]>();
  for (const item of items ?? []) {
    const list = linesByOrderId.get(item.order_id) ?? [];
    list.push({
      id: item.id,
      itemName: item.item_name,
      quantity: item.quantity,
      lineTotal: Number(item.line_total),
      modifiers: modifiersByItemId.get(item.id) ?? [],
    });
    linesByOrderId.set(item.order_id, list);
  }

  return (orders ?? []).map((o) => ({
    id: o.id,
    orderNumber: o.order_number,
    subtotal: Number(o.subtotal),
    tax: Number(o.tax),
    serviceCharge: Number(o.service_charge),
    total: Number(o.total),
    lines: linesByOrderId.get(o.id) ?? [],
  }));
}
