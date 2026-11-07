"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { requireActiveCustomerSession } from "@/lib/customer/session";
import { submitOrderSchema } from "@/lib/orders/schemas";
import { parseOrderError } from "@/lib/orders/errors";
import { isOrderSubmissionRateLimited } from "@/lib/orders/rate-limit";
import { scheduleOrderPush } from "@/lib/push/dispatch";
import { scheduleCloverDelivery } from "@/lib/pos/clover/deliver";
import { groupErrorMessage } from "./core";

/**
 * Server actions for ordering together. Thin, like the cart's: who may
 * join, what's sent and who sees it are decided in
 * 20261129090000_table_groups.sql. Nothing here takes a table, restaurant
 * or session id; each function derives them from the caller's own session.
 */

type UntypedRpc = (
  fn: string,
  args?: Record<string, unknown>,
) => Promise<{ data: unknown; error: { message: string } | null }>;

async function call(fn: string, args?: Record<string, unknown>) {
  const supabase = await createClient();
  return (supabase.rpc.bind(supabase) as unknown as UntypedRpc)(fn, args);
}

const nameSchema = z.string().trim().max(30).optional();

export interface GroupActionResult {
  ok: boolean;
  error?: string;
}

export async function startTableGroup(
  displayName?: string,
): Promise<GroupActionResult> {
  const session = await requireActiveCustomerSession();
  if (!session.ok) return { ok: false, error: session.error };
  const name = nameSchema.safeParse(displayName);

  const { error } = await call("start_table_group", {
    p_display_name: name.success ? name.data || null : null,
  });
  if (error) return { ok: false, error: groupErrorMessage(error.message) };
  revalidatePath("/r/[restaurantSlug]/cart", "page");
  return { ok: true };
}

export async function joinTableGroup(
  groupId: string,
  displayName?: string,
): Promise<GroupActionResult> {
  const session = await requireActiveCustomerSession();
  if (!session.ok) return { ok: false, error: session.error };
  if (!z.string().uuid().safeParse(groupId).success) {
    return { ok: false, error: groupErrorMessage("TABLE_GROUP_NOT_FOUND") };
  }
  const name = nameSchema.safeParse(displayName);

  const { error } = await call("join_table_group", {
    p_group_id: groupId,
    p_display_name: name.success ? name.data || null : null,
  });
  if (error) return { ok: false, error: groupErrorMessage(error.message) };
  revalidatePath("/r/[restaurantSlug]/cart", "page");
  return { ok: true };
}

export async function leaveTableGroup(): Promise<GroupActionResult> {
  const session = await requireActiveCustomerSession();
  if (!session.ok) return { ok: false, error: session.error };
  const { error } = await call("leave_table_group");
  if (error) return { ok: false, error: groupErrorMessage(error.message) };
  revalidatePath("/r/[restaurantSlug]/cart", "page");
  return { ok: true };
}

/**
 * Send the table's order. The same checks as submitOrder() (input, the
 * per-session rate limit) and the same after-effects (kitchen push,
 * Clover), around submit_table_group_order(), which sends everyone's
 * lines through submit_order() as one order.
 */
export async function submitTableGroupOrder(
  idempotencyKey: string,
  customerNote?: string,
): Promise<{ error?: string; orderId?: string }> {
  const sessionResult = await requireActiveCustomerSession();
  if (!sessionResult.ok) return { error: sessionResult.error };

  const parsed = submitOrderSchema.safeParse({
    idempotencyKey,
    customerNote: customerNote || undefined,
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid order." };
  }

  if (await isOrderSubmissionRateLimited(sessionResult.session.id)) {
    return {
      error:
        "You've placed several orders in a short time. Please wait a few minutes before placing another.",
    };
  }

  const { data, error } = await call("submit_table_group_order", {
    p_idempotency_key: parsed.data.idempotencyKey,
    p_customer_note: parsed.data.customerNote ?? null,
  });
  if (error) {
    return {
      error: error.message.includes("TABLE_GROUP_")
        ? groupErrorMessage(error.message)
        : parseOrderError(error.message),
    };
  }
  const order = data as { id?: string } | null;
  if (!order?.id) {
    return {
      error: "Something went wrong placing your order. Please try again.",
    };
  }

  // A second phone that tapped just after gets the same order back; the
  // senders recognise a repeat id and skip it.
  scheduleOrderPush(order.id);
  scheduleCloverDelivery(order.id);
  return { orderId: order.id };
}
