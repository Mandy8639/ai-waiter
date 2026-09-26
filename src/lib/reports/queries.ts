import "server-only";

import { createClient } from "@/lib/supabase/server";
import type { ReportRange } from "./range";
import { toDishFunnelRows, type DishFunnelRow } from "./funnel";

/**
 * Reads for the reports page.
 *
 * Errors are thrown, never swallowed. Elsewhere this codebase often reads
 * `const { data } = await supabase...` and lets a failure look like an
 * empty result; for takings that would render a confident £0 when the
 * query actually failed, which is the single worst thing a money report
 * can do. A page that fails to load is recoverable; a page that quietly
 * reports zero is not.
 */

export interface TakingsSummary {
  gross: string;
  refunded: string;
  refundsPending: string;
  net: string;
  tips: string;
  paymentCount: number;
  orderCount: number;
  averageOrderValue: string;
}

export interface MethodRow {
  method: string;
  paymentCount: number;
  gross: string;
  refunded: string;
  net: string;
}

export interface PaymentRow {
  paymentId: string;
  createdAt: string;
  paidAt: string | null;
  status: string;
  method: string;
  totalAmount: string;
  tipAmount: string;
  refunded: string;
  currency: string;
  orderNumbers: number[];
  reversedAt: string | null;
}

export interface ItemRow {
  itemName: string;
  quantitySold: string;
  revenue: string;
  orderCount: number;
}

export interface ReportData {
  summary: TakingsSummary;
  byMethod: MethodRow[];
  payments: PaymentRow[];
  items: ItemRow[];
}

export async function getReportData(
  restaurantId: string,
  range: ReportRange,
): Promise<ReportData> {
  const supabase = await createClient();
  const args = {
    target_restaurant_id: restaurantId,
    p_from: range.from,
    p_to: range.to,
  };

  const [summaryResult, methodResult, paymentsResult, itemsResult] =
    await Promise.all([
      supabase.rpc("get_takings_summary", args),
      supabase.rpc("get_takings_by_method", args),
      supabase.rpc("get_payment_history", { ...args, p_limit: 100 }),
      supabase.rpc("get_best_selling_items", { ...args, p_limit: 10 }),
    ]);

  if (summaryResult.error) throw summaryResult.error;
  if (methodResult.error) throw methodResult.error;
  if (paymentsResult.error) throw paymentsResult.error;
  if (itemsResult.error) throw itemsResult.error;

  // get_takings_summary always returns exactly one row, including for a
  // restaurant with no takings — see the migration's note on why an
  // aggregate with GROUP BY would have returned none.
  const s = summaryResult.data?.[0];

  return {
    summary: {
      gross: s?.gross ?? "0",
      refunded: s?.refunded ?? "0",
      refundsPending: s?.refunds_pending ?? "0",
      net: s?.net ?? "0",
      tips: s?.tips ?? "0",
      paymentCount: s?.payment_count ?? 0,
      orderCount: s?.order_count ?? 0,
      averageOrderValue: s?.average_order_value ?? "0",
    },
    byMethod: (methodResult.data ?? []).map((r) => ({
      method: r.method,
      paymentCount: r.payment_count,
      gross: r.gross,
      refunded: r.refunded,
      net: r.net,
    })),
    payments: (paymentsResult.data ?? []).map((r) => ({
      paymentId: r.payment_id,
      createdAt: r.created_at,
      paidAt: r.paid_at,
      status: r.status,
      method: r.method,
      totalAmount: r.total_amount,
      tipAmount: r.tip_amount,
      refunded: r.refunded,
      currency: r.currency,
      orderNumbers: r.order_numbers ?? [],
      reversedAt: r.reversed_at,
    })),
    items: (itemsResult.data ?? []).map((r) => ({
      itemName: r.item_name,
      quantitySold: r.quantity_sold,
      revenue: r.revenue,
      orderCount: r.order_count,
    })),
  };
}

/**
 * The dish funnel for a period (phase H). A separate call from
 * getReportData so a problem here can never take the takings down with it.
 */
export async function getDishFunnel(
  restaurantId: string,
  range: ReportRange,
): Promise<DishFunnelRow[]> {
  const supabase = await createClient();
  // database.types.ts predates 20260930090000.
  const rpc = supabase.rpc.bind(supabase) as unknown as (
    fn: string,
    args: Record<string, unknown>,
  ) => Promise<{ data: unknown; error: { message: string } | null }>;
  const { data, error } = await rpc("get_dish_funnel", {
    target_restaurant_id: restaurantId,
    p_from: range.from,
    p_to: range.to,
    p_limit: 50,
  });
  if (error) throw new Error(error.message);
  return toDishFunnelRows(data);
}
