"use server";

import { revalidatePath } from "next/cache";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { authorizeRestaurantAction } from "@/lib/restaurants/authorize";
import { copyInPersonSaleToSquare } from "./in-person";
import { copyRefundToSquare } from "./refunds";

/**
 * Settings → Point of sale → "Not yet in Square": sends again every cash
 * and card-machine sale, and refund of one, that didn't reach Square's
 * reports (square_unsynced(), 20261118090000). Owners and managers; each
 * copy is keyed on our own row, so sending one twice records it once.
 */

export type SyncResult =
  { ok: true; sent: number; failed: number } | { ok: false; error: string };

/** Enough for a bad evening; more waits for the next press. */
const BATCH = 25;

export async function resendToSquare(
  restaurantId: string,
): Promise<SyncResult> {
  if (!z.uuid().safeParse(restaurantId).success)
    return { ok: false, error: "That restaurant wasn't found." };
  const auth = await authorizeRestaurantAction(restaurantId, [
    "owner",
    "manager",
  ]);
  if (!auth.ok) return { ok: false, error: auth.error };
  const supabase = auth.context.supabase as unknown as SupabaseClient;

  const { data, error } = await supabase.rpc("square_unsynced", {
    p_restaurant_id: restaurantId,
  });
  if (error) return { ok: false, error: "Couldn't check what's missing." };
  const unsynced = data as {
    payments: { id: string }[];
    refunds: { id: string }[];
  };

  let sent = 0;
  let failed = 0;
  for (const payment of unsynced.payments.slice(0, BATCH)) {
    if (await copyInPersonSaleToSquare({ supabase, paymentId: payment.id }))
      sent++;
    else failed++;
  }

  const refundIds = unsynced.refunds.slice(0, BATCH).map((r) => r.id);
  if (refundIds.length > 0) {
    const { data: rows } = await supabase
      .from("payment_refunds")
      .select(
        "id, amount, currency, reason, order_payments!inner(square_payment_id)",
      )
      .in("id", refundIds);
    for (const row of (rows ?? []) as unknown as {
      id: string;
      amount: number | string;
      currency: string;
      reason: string;
      order_payments:
        | { square_payment_id: string | null }
        | { square_payment_id: string | null }[];
    }[]) {
      const payment = Array.isArray(row.order_payments)
        ? row.order_payments[0]
        : row.order_payments;
      if (!payment?.square_payment_id) continue;
      const ok = await copyRefundToSquare({
        supabase,
        restaurantId,
        refundId: row.id,
        squarePaymentId: payment.square_payment_id,
        amount: row.amount,
        currency: row.currency,
        reason: row.reason,
      });
      if (ok) sent++;
      else failed++;
    }
  }

  revalidatePath("/dashboard/settings/pos");
  return { ok: true, sent, failed };
}
