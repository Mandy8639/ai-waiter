import { z } from "zod";

/**
 * Every AI tool's argument schema, in one file with no server-only
 * dependencies (unlike the tool implementation files, which import
 * `@/lib/supabase/server` and therefore `server-only`) — so these can be
 * unit-tested directly without a request context, mirroring the existing
 * src/lib/cart/schema.ts / src/lib/cart/actions.ts split.
 *
 * `.strict()` on every object schema rejects unknown fields outright
 * (spec section 5) — a model that tries to pass an extra field (e.g.
 * `restaurant_id`, `price`, `unit_price`) gets a validation error, not a
 * silently-ignored-and-therefore-maybe-trusted-elsewhere field.
 */

export const searchMenuSchema = z
  .object({
    query: z.string().trim().max(200).optional(),
    dietary: z.enum(["vegetarian", "vegan"]).optional(),
    spicyOnly: z.boolean().optional(),
  })
  .strict();

const menuItemIdField = z
  .uuid()
  .trim()
  .describe(
    "The exact menu item ID returned by a previous search_menu or get_menu_item result. Never use the item's name, description, or a guessed ID.",
  );

export const getMenuItemSchema = z
  .object({
    menuItemId: menuItemIdField,
  })
  .strict();

export const getRestaurantInfoSchema = z.object({}).strict();

export const getCartSchema = z.object({}).strict();

export const addItemToCartSchema = z
  .object({
    menuItemId: menuItemIdField,
    quantity: z.number().int().min(1).max(99),
    selectedOptionIds: z
      .array(z.string().trim().min(1).max(100))
      .max(20)
      .default([]),
  })
  .strict();

export const updateCartItemSchema = z
  .object({
    cartItemId: z.string().trim().min(1).max(100),
    quantity: z.number().int().min(1).max(99),
  })
  .strict();

export const removeCartItemSchema = z
  .object({
    cartItemId: z.string().trim().min(1).max(100),
  })
  .strict();

export const clearCartSchema = z.object({}).strict();

export const requestOrderConfirmationSchema = z.object({}).strict();

export const submitOrderSchema = z
  .object({
    customerNote: z.string().trim().max(500).optional(),
  })
  .strict();

export const getOrderStatusSchema = z.object({}).strict();

export const getCustomerOrderHistorySchema = z.object({}).strict();
