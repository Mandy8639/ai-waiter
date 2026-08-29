"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { requireUser } from "@/lib/auth/session";
import { parseTicketGroupError } from "./errors";
import type { OrderStatus } from "./status";

export interface TicketGroupResult {
  error?: string;
}

/**
 * Thin application-layer wrappers around
 * transition_ticket_group_status()/split_order_into_tickets()/
 * merge_orders_into_ticket()
 * (supabase/migrations/20260829100000_order_ticket_groups.sql) — every
 * business rule (role permission, state machine legality, tenant
 * isolation, the merge/split v1 restrictions) lives in the database
 * functions, exactly like transition.ts's own wrapper around
 * transition_order_status(). Uses the per-request, RLS-respecting server
 * client — never the admin client — so auth.uid() inside the functions
 * resolves to the signed-in staff member.
 */
function toTicketGroupResult(message: string): TicketGroupResult {
  return { error: parseTicketGroupError(message) };
}

export async function transitionTicketGroupStatus(
  ticketGroupId: string,
  targetStatus: OrderStatus,
): Promise<TicketGroupResult> {
  await requireUser();
  const supabase = await createClient();

  const { error } = await supabase.rpc("transition_ticket_group_status", {
    p_ticket_group_id: ticketGroupId,
    p_target_status: targetStatus,
  });

  if (error) return toTicketGroupResult(error.message);

  revalidatePath("/dashboard/kitchen");
  return {};
}

const splitGroupsSchema = z
  .array(
    z.object({
      label: z.string().trim().max(100).optional(),
      itemIds: z.array(z.uuid()).min(1),
    }),
  )
  .min(2);

export async function splitOrderIntoTickets(
  orderId: string,
  groups: { label?: string; itemIds: string[] }[],
): Promise<TicketGroupResult> {
  await requireUser();

  const parsed = splitGroupsSchema.safeParse(groups);
  if (!parsed.success) {
    return { error: "Every group needs at least one item." };
  }

  const supabase = await createClient();
  const { error } = await supabase.rpc("split_order_into_tickets", {
    p_order_id: orderId,
    p_groups: parsed.data.map((g) => ({
      label: g.label ?? null,
      item_ids: g.itemIds,
    })),
  });

  if (error) return toTicketGroupResult(error.message);

  revalidatePath("/dashboard/kitchen");
  return {};
}

const mergeOrderIdsSchema = z.array(z.uuid()).min(2);

export async function mergeOrdersIntoTicket(
  orderIds: string[],
  label: string | null,
): Promise<TicketGroupResult> {
  await requireUser();

  const parsed = mergeOrderIdsSchema.safeParse(orderIds);
  if (!parsed.success) {
    return { error: "Select at least two orders to merge." };
  }

  const supabase = await createClient();
  const { error } = await supabase.rpc("merge_orders_into_ticket", {
    p_order_ids: parsed.data,
    p_label: label && label.trim().length > 0 ? label.trim() : null,
  });

  if (error) return toTicketGroupResult(error.message);

  revalidatePath("/dashboard/kitchen");
  return {};
}
