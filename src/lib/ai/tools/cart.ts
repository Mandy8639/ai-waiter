import "server-only";
import type { z } from "zod";
import { getCart } from "@/lib/cart/get-cart";
import {
  addToCart,
  updateCartItemQuantity,
  removeCartItem,
  clearCart,
} from "@/lib/cart/actions";
import type { ToolContext, ToolDefinition, ToolResult } from "./types";
import {
  getCartSchema,
  addItemToCartSchema,
  updateCartItemSchema,
  removeCartItemSchema,
  clearCartSchema,
} from "./schemas";

/**
 * Every mutation here calls straight into the existing Batch 4 cart
 * boundary (`src/lib/cart/actions.ts`) — the exact same functions the
 * customer-facing cart UI calls, including their full server-side
 * re-validation (item availability, modifier legality, price computed
 * fresh from menu_items/modifier_options). None of these tools accept a
 * price, a unit_price, a modifier_price, or a total from the model — the
 * schemas (src/lib/ai/tools/schemas.ts) have no such field, and the
 * underlying functions would ignore it even if one were somehow smuggled
 * through. See src/lib/cart/validate.ts and docs/security.md#price-validation.
 */

function cartSummary(summary: Awaited<ReturnType<typeof getCart>>) {
  return {
    lines: summary.lines.map((line) => ({
      cartItemId: line.id,
      name: line.menuItemName,
      quantity: line.quantity,
      unitPrice: line.unitPrice,
      modifiersPrice: line.modifiersPrice,
      lineTotal: line.lineTotal,
      modifiers: line.modifiers.map((m) => m.name),
      stillAvailable: line.stillAvailable,
    })),
    subtotal: summary.subtotal,
    taxAmount: summary.taxAmount,
    total: summary.total,
    hasUnavailableItems: summary.hasUnavailableItems,
  };
}

async function getCartTool(
  _args: z.infer<typeof getCartSchema>,
  context: ToolContext,
): Promise<ToolResult> {
  const summary = await getCart(
    context.restaurantId,
    context.customerSessionId,
  );
  return { ok: true, data: cartSummary(summary) };
}

async function addItemToCart(
  args: z.infer<typeof addItemToCartSchema>,
): Promise<ToolResult> {
  // requireActiveCustomerSession() inside addToCart() re-derives the
  // session server-side — context.customerSessionId isn't even passed
  // through; this call is identical to what the customer-facing "Add to
  // cart" button does.
  const formData = new FormData();
  formData.set("menuItemId", args.menuItemId);
  formData.set("quantity", String(args.quantity));
  for (const optionId of args.selectedOptionIds) {
    formData.append("optionId", optionId);
  }
  if (args.spicePreference) {
    formData.set("spicePreference", args.spicePreference);
  }
  if (args.notes) formData.set("notes", args.notes);

  const result = await addToCart({}, formData);
  if (result.error) return { ok: false, error: result.error };
  if (result.fieldErrors) {
    const firstError = Object.values(result.fieldErrors).flat().find(Boolean);
    return {
      ok: false,
      error: firstError ?? "Couldn't add that item to the cart.",
    };
  }
  return { ok: true, data: { added: true } };
}

async function updateCartItem(
  args: z.infer<typeof updateCartItemSchema>,
): Promise<ToolResult> {
  const result = await updateCartItemQuantity(args.cartItemId, args.quantity);
  if (result.error) return { ok: false, error: result.error };
  return { ok: true, data: { updated: true } };
}

async function removeCartItemTool(
  args: z.infer<typeof removeCartItemSchema>,
): Promise<ToolResult> {
  const result = await removeCartItem(args.cartItemId);
  if (result.error) return { ok: false, error: result.error };
  return { ok: true, data: { removed: true } };
}

async function clearCartTool(): Promise<ToolResult> {
  const result = await clearCart();
  if (result.error) return { ok: false, error: result.error };
  return { ok: true, data: { cleared: true } };
}

export const cartTools: ToolDefinition[] = [
  {
    name: "get_cart",
    description:
      "Read the customer's current cart — items, quantities, modifiers, and totals, all computed server-side. Call this whenever you need to know what's already in the cart, e.g. before confirming an order or answering 'what's in my cart?'.",
    schema: getCartSchema,
    execute: getCartTool as ToolDefinition["execute"],
  },
  {
    name: "add_item_to_cart",
    description:
      'Add a menu item (with any selected modifier option ids) to the customer\'s cart. The server re-validates availability and modifier rules and computes the price — you never supply a price. Only call this once you have all required modifier selections for the item. If the customer said how they want this one cooked ("can I get that spicy?") pass spicePreference, and pass notes for any other short request they made for this line — both reach the kitchen ticket.',
    schema: addItemToCartSchema,
    execute: addItemToCart as ToolDefinition["execute"],
  },
  {
    name: "update_cart_item",
    description:
      "Change the quantity of an existing cart line (identified by cartItemId from get_cart).",
    schema: updateCartItemSchema,
    execute: updateCartItem as ToolDefinition["execute"],
  },
  {
    name: "remove_cart_item",
    description:
      "Remove one line from the cart (identified by cartItemId from get_cart).",
    schema: removeCartItemSchema,
    execute: removeCartItemTool as ToolDefinition["execute"],
  },
  {
    name: "clear_cart",
    description: "Remove everything from the customer's cart.",
    schema: clearCartSchema,
    execute: clearCartTool as ToolDefinition["execute"],
  },
];
