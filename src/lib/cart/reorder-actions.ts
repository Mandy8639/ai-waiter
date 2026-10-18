"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import {
  requireActiveCustomerSession,
  touchCustomerSession,
} from "@/lib/customer/session";
import { getPublicOrderSettings } from "@/lib/customer/restaurant";
import { validateAndPriceSelection } from "./validate";
import { getOrCreateCartId, insertCartLine } from "./add-line";
import {
  planReorder,
  reorderMessage,
  type PastOrderLine,
} from "./reorder-core";

export interface ReorderResult {
  error?: string;
  /** "Added 3 items to your order." */
  added?: string;
  /** "Not available right now, so not added: Lamb curry." */
  notAdded?: string;
}

/**
 * "Order another round": puts one of this diner's own orders back in their
 * cart, line by line, through the same check and pricing as adding a dish
 * by hand (validateAndPriceSelection) — today's prices, and nothing that's
 * sold out or off the menu right now. Those are left out and named. The
 * diner then reviews the cart and orders as usual; nothing is ordered here.
 */
export async function reorderToCart(orderId: string): Promise<ReorderResult> {
  const sessionResult = await requireActiveCustomerSession();
  if (!sessionResult.ok) return { error: sessionResult.error };
  const { session } = sessionResult;
  if (!z.uuid().safeParse(orderId).success) {
    return { error: "That order wasn't found." };
  }

  const supabase = await createClient();
  // Only this session's own orders, whatever id is sent.
  const { data: order } = await supabase
    .from("orders")
    .select("id")
    .eq("id", orderId)
    .eq("customer_session_id", session.id)
    .eq("restaurant_id", session.restaurantId)
    .maybeSingle();
  if (!order) return { error: "That order wasn't found." };

  const { data: items } = await supabase
    .from("order_items")
    .select("id, menu_item_id, item_name, quantity, spice_preference, notes")
    .eq("order_id", order.id)
    .order("created_at", { ascending: true });
  const itemIds = (items ?? []).map((i) => i.id);
  const { data: modifiers } =
    itemIds.length > 0
      ? await supabase
          .from("order_item_modifiers")
          .select("order_item_id, modifier_option_id")
          .in("order_item_id", itemIds)
      : {
          data: [] as {
            order_item_id: string;
            modifier_option_id: string | null;
          }[],
        };

  const past: PastOrderLine[] = (items ?? []).map((i) => ({
    menuItemId: i.menu_item_id,
    itemName: i.item_name,
    quantity: i.quantity,
    spicePreference: i.spice_preference,
    notes: i.notes,
    optionIds: (modifiers ?? [])
      .filter((m) => m.order_item_id === i.id)
      .map((m) => m.modifier_option_id),
  }));
  const plan = planReorder(past);

  const cartId = await getOrCreateCartId(
    supabase,
    session.restaurantId,
    session.id,
  );
  if (!cartId) return { error: "Could not open your cart. Please try again." };

  // Notes follow the restaurant's setting today, as in addToCart.
  const allowNotes =
    plan.lines.some((l) => l.notes) &&
    (await getPublicOrderSettings(session.restaurantId)).allowCustomerNotes;

  let addedItems = 0;
  const notAdded = [...plan.gone];
  for (const line of plan.lines) {
    const validation = await validateAndPriceSelection(
      supabase,
      session.restaurantId,
      line.menuItemId,
      line.optionIds,
    );
    if (!validation.ok) {
      notAdded.push(line.itemName);
      continue;
    }
    const inserted = await insertCartLine(supabase, {
      cartId,
      restaurantId: session.restaurantId,
      menuItemId: line.menuItemId,
      quantity: line.quantity,
      priced: validation.priced,
      spicePreference: line.spicePreference,
      notes: allowNotes ? line.notes : null,
    });
    if (inserted.error) notAdded.push(line.itemName);
    else addedItems += line.quantity;
  }

  if (addedItems > 0) {
    await touchCustomerSession(session.id);
    revalidatePath("/r/[restaurantSlug]", "layout");
  }
  const message = reorderMessage({ addedItems, notAdded });
  return {
    added: message.added ?? undefined,
    notAdded: message.notAdded ?? undefined,
  };
}
