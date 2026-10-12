"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { requireUser } from "@/lib/auth/session";
import { scheduleOrderHandledPush } from "@/lib/push/dispatch";
import { parseTransitionError } from "./errors";
import type { OrderStatus } from "./status";

export interface TransitionResult {
  error?: string;
}

/**
 * Thin application-layer wrapper around the `transition_order_status`
 * Postgres function
 * (supabase/migrations/20260824090200_transition_order_status_function.sql)
 * — every business rule (restaurant membership, role permission, state
 * machine legality, concurrency safety) lives in the database function.
 * Uses the per-request, RLS-respecting server client — never the admin
 * client — so the RPC runs as the signed-in staff member and auth.uid()
 * inside the function resolves to them, exactly like submit_order() and
 * create_restaurant() before it.
 *
 * Deliberately takes no restaurantId/role/currentStatus — those are all
 * derived server-side from the order's own row and the caller's real
 * restaurant_users membership (see docs/security.md#order-status-transitions).
 */
export async function transitionOrderStatus(
  orderId: string,
  targetStatus: OrderStatus,
): Promise<TransitionResult> {
  await requireUser();
  const supabase = await createClient();

  const { error } = await supabase.rpc("transition_order_status", {
    p_order_id: orderId,
    p_target_status: targetStatus,
  });

  if (error) return { error: parseTransitionError(error.message) };

  // Accepted or cancelled: the Android phones ringing for this order go
  // quiet now (the order-ring round would catch it within 30 seconds).
  if (targetStatus === "confirmed" || targetStatus === "cancelled") {
    scheduleOrderHandledPush(orderId);
  }

  revalidatePath("/dashboard/kitchen");
  return {};
}
