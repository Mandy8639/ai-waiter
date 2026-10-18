import "server-only";
import type { createClient } from "@/lib/supabase/server";
import { toFriendlyError } from "@/lib/errors/database-error";
import type { PricedSelection } from "./validate";
import type { SpiceLevel } from "./reorder-core";

type Client = Awaited<ReturnType<typeof createClient>>;

/**
 * Writing one priced line into a diner's cart, shared by add-to-cart and
 * "order another round" so both write exactly the same rows. Price and
 * availability are decided before this, by validateAndPriceSelection();
 * this only stores its answer.
 */

export async function getOrCreateCartId(
  supabase: Client,
  restaurantId: string,
  customerSessionId: string,
): Promise<string | null> {
  const { data: existing } = await supabase
    .from("carts")
    .select("id")
    .eq("customer_session_id", customerSessionId)
    .maybeSingle();

  if (existing) return existing.id;

  const { data: created } = await supabase
    .from("carts")
    .insert({
      customer_session_id: customerSessionId,
      restaurant_id: restaurantId,
    })
    .select("id")
    .single();

  return created?.id ?? null;
}

export async function insertCartLine(
  supabase: Client,
  line: {
    cartId: string;
    restaurantId: string;
    menuItemId: string;
    quantity: number;
    priced: PricedSelection;
    spicePreference: SpiceLevel | null;
    notes: string | null;
  },
): Promise<{ error?: string }> {
  const { unitPrice, modifiersPrice, selectedOptions } = line.priced;
  const lineTotal = Math.max(0, (unitPrice + modifiersPrice) * line.quantity);

  const { data: cartItem, error: itemError } = await supabase
    .from("cart_items")
    .insert({
      cart_id: line.cartId,
      restaurant_id: line.restaurantId,
      menu_item_id: line.menuItemId,
      quantity: line.quantity,
      unit_price: unitPrice,
      modifiers_price: modifiersPrice,
      line_total: lineTotal,
      spice_preference: line.spicePreference,
      notes: line.notes,
    })
    .select("id")
    .single();

  if (itemError || !cartItem) {
    return { error: toFriendlyError(itemError!, "cart item") };
  }

  if (selectedOptions.length > 0) {
    const { error: modifiersError } = await supabase
      .from("cart_item_modifiers")
      .insert(
        selectedOptions.map((option) => ({
          cart_item_id: cartItem.id,
          restaurant_id: line.restaurantId,
          modifier_id: option.modifierId,
          modifier_option_id: option.id,
          name: option.name,
          price_adjustment: option.priceAdjustment,
        })),
      );
    if (modifiersError) {
      // Roll back the orphaned line rather than leaving a cart item with no
      // (or partial) modifiers silently mismatched from what the customer picked.
      await supabase.from("cart_items").delete().eq("id", cartItem.id);
      return { error: toFriendlyError(modifiersError, "cart item") };
    }
  }
  return {};
}
