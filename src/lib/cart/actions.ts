"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import {
  requireActiveCustomerSession,
  touchCustomerSession,
} from "@/lib/customer/session";
import { toFriendlyError } from "@/lib/errors/database-error";
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

  const parsed = addToCartSchema.safeParse({
    menuItemId: formData.get("menuItemId"),
    quantity: Number(formData.get("quantity") ?? 1),
    selectedOptionIds: formData.getAll("optionId").map(String),
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
