"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { scheduleOrderHandledPush } from "@/lib/push/dispatch";
import { reorderToCart, type ReorderResult } from "@/lib/cart/reorder-actions";
import { customerCancelMessage } from "./customer-cancel-core";

type UntypedRpc = (
  fn: string,
  args: Record<string, unknown>,
) => Promise<{ data: unknown; error: { message: string } | null }>;

/**
 * A diner cancels their own order while the kitchen hasn't accepted it yet.
 * Every rule (their order, still waiting, not paid) is in
 * customer_cancel_order(); this runs it as the diner (RLS client, so
 * auth.uid() is them) and words the refusal.
 */
export async function cancelMyOrder(
  orderId: string,
): Promise<{ ok: boolean; error?: string }> {
  if (!z.uuid().safeParse(orderId).success) {
    return {
      ok: false,
      error: customerCancelMessage("ORDER_CANCEL_NOT_FOUND"),
    };
  }
  const supabase = await createClient();
  // database.types.ts predates this function (20261104090000).
  const rpc = supabase.rpc.bind(supabase) as unknown as UntypedRpc;
  const { error } = await rpc("customer_cancel_order", {
    p_order_id: orderId,
  });
  if (error) return { ok: false, error: customerCancelMessage(error.message) };

  // Kitchen phones still ringing for this order go quiet.
  scheduleOrderHandledPush(orderId);
  revalidatePath("/r/[restaurantSlug]", "layout");
  revalidatePath("/dashboard/kitchen");
  return { ok: true };
}

/**
 * "Change order": cancels it, then puts the same dishes back in the cart
 * (the "Order again" path, at today's prices) for the diner to edit and
 * send again. Nothing is put back if the cancel didn't go through.
 */
export async function changeMyOrder(
  orderId: string,
): Promise<ReorderResult & { ok: boolean }> {
  const cancelled = await cancelMyOrder(orderId);
  if (!cancelled.ok) return { ok: false, error: cancelled.error };
  const result = await reorderToCart(orderId);
  return { ok: !result.error, ...result };
}
