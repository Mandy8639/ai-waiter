"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { authorizeRestaurantAction } from "@/lib/restaurants/authorize";
import { parseOrderError } from "@/lib/orders/errors";
import { scheduleOrderPush } from "@/lib/push/dispatch";
import { scheduleCloverDelivery } from "@/lib/pos/clover/deliver";
import { reportError } from "@/lib/observability/report";

/**
 * Sending a ticket from the POS screen. Every rule (who may, prices,
 * add-ons, tax, menu hours, retries) is staff_place_order()'s
 * (20261107090000); this checks the shape, calls it once and tells the
 * kitchen's devices, the same hook a diner's order uses.
 */

/** Front of house, as on Settle up. Not the kitchen screen. */
const RINGERS = ["owner", "manager", "staff"] as const;

const lineSchema = z.object({
  menu_item_id: z.uuid(),
  quantity: z.number().int().min(1).max(99),
  modifier_option_ids: z.array(z.uuid()).max(30),
  notes: z.string().max(200).nullable(),
});

const sendSchema = z.object({
  restaurantId: z.uuid(),
  tableId: z.uuid(),
  idempotencyKey: z.string().min(1).max(100),
  lines: z.array(lineSchema).min(1, "Add at least one dish.").max(100),
  note: z.string().max(500).optional(),
  pickupName: z.string().max(60).optional(),
});

export type SendTicketInput = z.input<typeof sendSchema>;

export type SendTicketResult =
  | {
      ok: true;
      order: {
        id: string;
        orderNumber: number;
        status: string;
        total: number;
        currency: string;
        createdAt: string;
      };
    }
  | { ok: false; error: string };

type Rpc = (
  fn: string,
  args: Record<string, unknown>,
) => Promise<{ data: unknown; error: { message: string } | null }>;

interface PlacedRow {
  id: string;
  order_number: number;
  status: string;
  total: number | string;
  currency: string;
  created_at: string;
}

export async function sendTicket(
  input: SendTicketInput,
): Promise<SendTicketResult> {
  const parsed = sendSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? "That order isn't valid.",
    };
  }
  const { restaurantId, tableId, idempotencyKey, lines, note, pickupName } =
    parsed.data;

  const auth = await authorizeRestaurantAction(restaurantId, [...RINGERS]);
  if (!auth.ok) return { ok: false, error: auth.error };

  // database.types.ts predates staff_place_order().
  const rpc = auth.context.supabase.rpc.bind(
    auth.context.supabase,
  ) as unknown as Rpc;
  const { data, error } = await rpc("staff_place_order", {
    p_restaurant_id: restaurantId,
    p_table_id: tableId,
    p_lines: lines,
    p_idempotency_key: idempotencyKey,
    p_note: note?.trim() || null,
    p_pickup_name: pickupName?.trim() || null,
  });

  if (error) {
    const message = error.message ?? "";
    if (message.startsWith("ORDER_TABLE_UNAVAILABLE")) {
      return { ok: false, error: "That table isn't available any more." };
    }
    if (message.startsWith("ORDER_STAFF_FORBIDDEN")) {
      return { ok: false, error: "Your account can't ring up orders." };
    }
    if (!/^ORDER_[A-Z_]+:/.test(message)) {
      reportError(error, { scope: "pos.send", extra: { lines: lines.length } });
    }
    return { ok: false, error: parseOrderError(message) };
  }

  const row = data as PlacedRow | null;
  if (!row?.id) {
    return { ok: false, error: "Something went wrong. Please try again." };
  }

  // Same hook as a diner's order; a retry returns the same id, which the
  // sender recognises and skips.
  scheduleOrderPush(row.id);
  // A Clover restaurant's register gets it too (20261121090000).
  scheduleCloverDelivery(row.id);
  revalidatePath("/dashboard/checkout");

  return {
    ok: true,
    order: {
      id: row.id,
      orderNumber: row.order_number,
      status: row.status,
      total: Number(row.total),
      currency: row.currency,
      createdAt: row.created_at,
    },
  };
}
