"use server";

import { createClient } from "@/lib/supabase/server";
import { requireActiveCustomerSession } from "@/lib/customer/session";
import { pickupChoiceSchema, submitOrderSchema } from "./schemas";
import { parseOrderError } from "./errors";
import { isOrderSubmissionRateLimited } from "./rate-limit";
import { scheduleOrderPush } from "@/lib/push/dispatch";
import { scheduleCloverDelivery } from "@/lib/pos/clover/deliver";
import { pickupRpc } from "@/lib/pickup/queries";

export interface SubmitOrderResult {
  error?: string;
  orderId?: string;
}

/**
 * Thin application-layer wrapper around the `submit_order` Postgres
 * function (supabase/migrations/20260823100600_submit_order_function.sql)
 * — validation of the two client-supplied fields happens here; every
 * business rule (availability, pricing, tax, idempotency, transactional
 * writes) happens in the database function. Uses the per-request,
 * RLS-respecting server client — never the admin client — so the RPC runs
 * as the signed-in (anonymous-auth) customer and auth.uid() inside the
 * function resolves to them (docs/security.md#order-submission).
 *
 * Deliberately does not accept a restaurantId/tableId/cartId — those are
 * derived entirely server-side from the caller's own active session, the
 * same guarantee requireActiveCustomerSession() already gives every other
 * cart mutation in this codebase.
 *
 * `pickup` is the diner's choice at a pickup counter. It is saved on the
 * cart first (set_cart_pickup()), and the order trigger reads it from
 * there, so a caller that passes none (the AI waiter) still places the
 * time the diner picked in the cart.
 */
export async function submitOrder(
  idempotencyKey: string,
  customerNote?: string,
  pickup?: { at: string; name: string },
): Promise<SubmitOrderResult> {
  const sessionResult = await requireActiveCustomerSession();
  if (!sessionResult.ok) return { error: sessionResult.error };

  const parsed = submitOrderSchema.safeParse({
    idempotencyKey,
    customerNote: customerNote || undefined,
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid order." };
  }

  // Counts actual created orders, not attempts — a retry of the same
  // idempotency key never adds to this count (see
  // src/lib/orders/rate-limit.ts), so this never punishes a legitimate
  // double-click/network-retry/refresh, only many genuinely distinct
  // orders from one session in a short window.
  if (await isOrderSubmissionRateLimited(sessionResult.session.id)) {
    return {
      error:
        "You've placed several orders in a short time. Please wait a few minutes before placing another.",
    };
  }

  const supabase = await createClient();

  if (pickup) {
    const choice = pickupChoiceSchema.safeParse(pickup);
    if (!choice.success) {
      return { error: choice.error.issues[0]?.message ?? "Invalid pickup." };
    }
    const rpc = await pickupRpc();
    const { error: pickupError } = await rpc("set_cart_pickup", {
      p_pickup_at: choice.data.at,
      p_pickup_name: choice.data.name,
    });
    if (pickupError) {
      // A retry of an order that already went through must still land on
      // that order, even if its slot has filled since: submit_order()'s
      // replay would return it, but it never gets the chance if this
      // returns first. Anything else is the diner's to fix.
      const { data: placed } = await supabase
        .from("orders")
        .select("id")
        .eq("customer_session_id", sessionResult.session.id)
        .eq("idempotency_key", parsed.data.idempotencyKey)
        .maybeSingle();
      if (placed) return { orderId: placed.id };
      return { error: parseOrderError(pickupError.message ?? "") };
    }
  }

  const { data, error } = await supabase.rpc("submit_order", {
    p_idempotency_key: parsed.data.idempotencyKey,
    p_customer_note: parsed.data.customerNote ?? null,
  });

  if (error) return { error: parseOrderError(error.message) };
  if (!data) {
    return {
      error: "Something went wrong placing your order. Please try again.",
    };
  }

  // Tell the kitchen's devices, after this response has gone (phase F).
  // Both ordering paths — the diner's own button and the AI waiter's
  // submit_order tool — come through here, so this is the one hook. The
  // id is the one the database just returned, never a client value, and a
  // retry of the same idempotency key returns the same id, which the
  // sender recognises and skips.
  scheduleOrderPush(data.id);
  // A Clover restaurant's register gets it too (20261121090000).
  scheduleCloverDelivery(data.id);

  return { orderId: data.id };
}
