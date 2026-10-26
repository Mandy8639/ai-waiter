"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { authorizeRestaurantAction } from "@/lib/restaurants/authorize";
import { reportError } from "@/lib/observability/report";
import {
  adjustSchema,
  adjustmentErrorMessage,
  type AdjustInput,
} from "./adjustment-core";

/**
 * Settle up → Adjust. Owners and managers only; adjust_order() and
 * remove_order_adjustment() check the role again (with two-step
 * verification, via current_restaurant_role()), and refuse an order a
 * payment has started on.
 */

export type AdjustResult = { ok: true } | { ok: false; error: string };

const MANAGERS = ["owner", "manager"] as const;

type Rpc = (
  fn: string,
  args: Record<string, unknown>,
) => Promise<{ data: unknown; error: { message: string } | null }>;

function refresh() {
  revalidatePath("/dashboard/checkout");
  revalidatePath("/dashboard/reports");
}

export async function adjustOrder(input: AdjustInput): Promise<AdjustResult> {
  const parsed = adjustSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? "Check the details.",
    };
  }
  const p = parsed.data;
  if (p.kind === "discount" && (p.percent === null) === (p.amount === null)) {
    return { ok: false, error: "Give a percentage or an amount." };
  }

  const auth = await authorizeRestaurantAction(p.restaurantId, [...MANAGERS]);
  if (!auth.ok) return { ok: false, error: auth.error };
  const rpc = auth.context.supabase.rpc.bind(
    auth.context.supabase,
  ) as unknown as Rpc;

  const { error } = await rpc("adjust_order", {
    p_order_id: p.orderId,
    p_kind: p.kind,
    p_reason: p.reason,
    p_order_item_id: p.kind === "discount" ? null : p.itemId,
    p_quantity: p.kind === "discount" ? null : p.quantity,
    p_percent: p.kind === "discount" ? p.percent : null,
    p_amount: p.kind === "discount" ? p.amount : null,
  });
  if (error) {
    if (!/^ADJUST_/.test(error.message))
      reportError(error, { scope: "payments.adjust", extra: { kind: p.kind } });
    return { ok: false, error: adjustmentErrorMessage(error.message) };
  }
  refresh();
  return { ok: true };
}

export async function removeAdjustment(
  restaurantId: string,
  adjustmentId: string,
): Promise<AdjustResult> {
  if (!z.uuid().safeParse(adjustmentId).success)
    return { ok: false, error: "That change wasn't found." };
  const auth = await authorizeRestaurantAction(restaurantId, [...MANAGERS]);
  if (!auth.ok) return { ok: false, error: auth.error };
  const rpc = auth.context.supabase.rpc.bind(
    auth.context.supabase,
  ) as unknown as Rpc;

  const { error } = await rpc("remove_order_adjustment", {
    p_adjustment_id: adjustmentId,
  });
  if (error) {
    if (!/^ADJUST_/.test(error.message))
      reportError(error, { scope: "payments.adjust.remove" });
    return { ok: false, error: adjustmentErrorMessage(error.message) };
  }
  refresh();
  return { ok: true };
}
