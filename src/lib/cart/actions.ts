"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import {
  requireActiveCustomerSession,
  touchCustomerSession,
} from "@/lib/customer/session";
import { toFriendlyError } from "@/lib/errors/database-error";
import { getPublicOrderSettings } from "@/lib/customer/restaurant";
import { addToCartSchema, updateQuantitySchema } from "./schema";
import { validateAndPriceSelection } from "./validate";

export interface CartActionState {
  error?: string;
  success?: boolean;
  fieldErrors?: Record<string, string[] | undefined>;
}

async function getOrCreateCartId(
  restaurantId: string,
  customerSessionId: string,
): Promise<string | null> {
  const supabase = await createClient();

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

export async function addToCart(
  _prevState: CartActionState,
  formData: FormData,
): Promise<CartActionState> {
  const sessionResult = await requireActiveCustomerSession();
  if (!sessionResult.ok) return { error: sessionResult.error };
  const { session } = sessionResult;

  const spiceRaw = formData.get("spicePreference");
  const notesRaw = formData.get("notes");

  const parsed = addToCartSchema.safeParse({
    menuItemId: formData.get("menuItemId"),
    quantity: Number(formData.get("quantity") ?? 1),
    selectedOptionIds: formData.getAll("optionId").map(String),
    // "" is the "however you normally make it" choice in the form, and is
    // not the same as "none" — that would be a diner asking for no heat at
    // all in a dish the kitchen makes mild.
    spicePreference:
      typeof spiceRaw === "string" && spiceRaw ? spiceRaw : undefined,
    notes:
      typeof notesRaw === "string" && notesRaw.trim() ? notesRaw : undefined,
  });
  if (!parsed.success)
    return { fieldErrors: z.flattenError(parsed.error).fieldErrors };

  const supabase = await createClient();
  const validation = await validateAndPriceSelection(
    supabase,
    session.restaurantId,
    parsed.data.menuItemId,
    parsed.data.selectedOptionIds,
  );
  if (!validation.ok) return { error: validation.error };

  const cartId = await getOrCreateCartId(session.restaurantId, session.id);
  if (!cartId) return { error: "Could not open your cart. Please try again." };

  // A restaurant that has turned customer notes off has turned them off:
  // the per-line note is the same channel as the order-level one, which
  // submit_order already rejects on this setting, so honouring it in one
  // place and not the other would just move the loophole. Dropped rather
  // than rejected — the diner still gets their item, they just don't get
  // to send a message this kitchen has said it won't read.
  let notes = parsed.data.notes;
  if (notes) {
    // Through getPublicOrderSettings(), which goes via the SECURITY
    // DEFINER get_public_order_settings(). restaurant_settings is
    // member-only, so reading it directly from a diner's client returns
    // null — and a null read here fails closed, silently dropping every
    // note at a restaurant that allows them. Caught by adding a note in
    // the browser and finding it absent from the row.
    const settings = await getPublicOrderSettings(session.restaurantId);
    if (!settings.allowCustomerNotes) notes = undefined;
  }

  const { unitPrice, modifiersPrice, selectedOptions } = validation.priced;
  const lineTotal = Math.max(
    0,
    (unitPrice + modifiersPrice) * parsed.data.quantity,
  );

  const { data: cartItem, error: itemError } = await supabase
    .from("cart_items")
    .insert({
      cart_id: cartId,
      restaurant_id: session.restaurantId,
      menu_item_id: parsed.data.menuItemId,
      quantity: parsed.data.quantity,
      unit_price: unitPrice,
      modifiers_price: modifiersPrice,
      line_total: lineTotal,
      spice_preference: parsed.data.spicePreference ?? null,
      notes: notes ?? null,
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
          restaurant_id: session.restaurantId,
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

  await touchCustomerSession(session.id);
  revalidatePath("/r/[restaurantSlug]/cart", "page");
  revalidatePath("/r/[restaurantSlug]/menu", "page");
  return { success: true };
}

export async function updateCartItemQuantity(
  cartItemId: string,
  quantity: number,
): Promise<{ error?: string }> {
  const sessionResult = await requireActiveCustomerSession();
  if (!sessionResult.ok) return { error: sessionResult.error };

  const parsed = updateQuantitySchema.safeParse({ cartItemId, quantity });
  if (!parsed.success)
    return { error: parsed.error.issues[0]?.message ?? "Invalid quantity." };

  const supabase = await createClient();

  // Re-validate the item is still available/priced correctly before
  // recomputing the line total — an item can go unavailable between when
  // it was added and when the quantity changes (see docs/database.md#ai-readiness
  // style revalidation notes and spec's "menu availability" requirement).
  const { data: item } = await supabase
    .from("cart_items")
    .select("id, menu_item_id, restaurant_id, unit_price, modifiers_price")
    .eq("id", parsed.data.cartItemId)
    .maybeSingle();

  if (!item) return { error: "That item is no longer in your cart." };

  const { data: menuItem } = await supabase
    .from("menu_items")
    .select("is_available, price")
    .eq("id", item.menu_item_id)
    .maybeSingle();

  if (!menuItem || !menuItem.is_available) {
    return {
      error:
        "This item has become unavailable — please remove it from your cart.",
    };
  }

  const lineTotal = Math.max(
    0,
    (Number(menuItem.price) + Number(item.modifiers_price)) *
      parsed.data.quantity,
  );

  const { error } = await supabase
    .from("cart_items")
    .update({
      quantity: parsed.data.quantity,
      unit_price: menuItem.price,
      line_total: lineTotal,
    })
    .eq("id", item.id);

  if (error) return { error: toFriendlyError(error, "cart item") };

  await touchCustomerSession(sessionResult.session.id);
  revalidatePath("/r/[restaurantSlug]/cart", "page");
  return {};
}

export async function removeCartItem(
  cartItemId: string,
): Promise<{ error?: string }> {
  const sessionResult = await requireActiveCustomerSession();
  if (!sessionResult.ok) return { error: sessionResult.error };

  const supabase = await createClient();
  const { error } = await supabase
    .from("cart_items")
    .delete()
    .eq("id", cartItemId);

  if (error) return { error: toFriendlyError(error, "cart item") };

  await touchCustomerSession(sessionResult.session.id);
  revalidatePath("/r/[restaurantSlug]/cart", "page");
  return {};
}

export async function clearCart(): Promise<{ error?: string }> {
  const sessionResult = await requireActiveCustomerSession();
  if (!sessionResult.ok) return { error: sessionResult.error };

  const supabase = await createClient();
  const cartId = await getOrCreateCartId(
    sessionResult.session.restaurantId,
    sessionResult.session.id,
  );
  if (!cartId) return {};

  const { error } = await supabase
    .from("cart_items")
    .delete()
    .eq("cart_id", cartId);
  if (error) return { error: toFriendlyError(error, "cart") };

  await touchCustomerSession(sessionResult.session.id);
  revalidatePath("/r/[restaurantSlug]/cart", "page");
  return {};
}
