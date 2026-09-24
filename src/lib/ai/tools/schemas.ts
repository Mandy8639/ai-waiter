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
    query: z
      .string()
      .trim()
      .max(200)
      .optional()
      .describe(
        "Free-text keyword search over item name/description only (e.g. a dish name, ingredient, or cuisine) — this is a plain substring match, not a semantic search. Leave this empty when the customer's request is already fully covered by `dietary`/`spicyOnly` (e.g. for 'what vegetarian dishes do you have', set dietary: 'vegetarian' and leave query empty — do NOT also pass query: 'vegetarian' or 'vegetarian dishes', since that text won't literally appear in most item names/descriptions and combining it with the filter can incorrectly return zero results even when matching items exist).",
      ),
    dietary: z
      .enum(["vegetarian", "vegan", "halal", "kosher", "high_protein"])
      .optional()
      .describe(
        "Filter to items the restaurant has stated are vegetarian, vegan, halal, kosher or high in protein. Use this for dietary requests instead of putting the word into `query`. IMPORTANT for halal and kosher: this returns only the dishes the restaurant has explicitly marked. A dish missing from the results has NOT been declared unsuitable — the restaurant simply has not said. Never tell a customer a dish is not halal or not kosher on the strength of it being absent here; say the menu doesn't specify and suggest they ask staff.",
      ),
    spicyOnly: z
      .boolean()
      .optional()
      .describe(
        "Filter to only items flagged spicy. Use this for spice-related requests instead of putting a spice-related word into `query`.",
      ),
    category: z
      .string()
      .trim()
      .max(100)
      .optional()
      .describe(
        "Filter to one of this restaurant's menu categories, matched by name (case-insensitive, exact). Call get_restaurant_info first to see which categories exist — they differ per restaurant. Use this for any request about a KIND of food rather than a specific dish: 'something light', 'a snack', 'a proper meal', 'just a drink'. A category name will almost never appear in an item's own name or description, so putting it in `query` returns nothing — a menu of 22 snacks contains one item with the word 'snack' in it.",
      ),
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
    spicePreference: z
      .enum(["none", "mild", "medium", "hot", "very_hot"])
      .optional()
      .describe(
        "How the customer asked for THIS line to be cooked, when they said something about heat. Leave it out unless they actually asked — omitting it means 'however the kitchen normally makes it', which is the right default and keeps the kitchen ticket clean. This is not the dish's own spice level from get_menu_item; that is what the dish IS, this is what this person wants.",
      ),
    notes: z
      .string()
      .trim()
      .max(200)
      .optional()
      .describe(
        "A short kitchen request the customer made for this line, in their own words (e.g. 'no onions'). Only what they actually asked for — never your own summary of the dish, and never a note they did not ask you to pass on. The restaurant may have customer notes switched off, in which case it is silently dropped.",
      ),
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

/**
 * The only two things a table can ask a person for. An enum, not free
 * text: the staff-facing surface is a queue somebody glances at during
 * service, and a model that could invent a `kind` would turn that queue
 * into a chat nobody is watching.
 *
 * There is deliberately no table or restaurant field here — as with every
 * other tool, the context comes from the authenticated customer session
 * (see tools/types.ts), so there is nothing for the model to tamper with.
 */
export const requestServiceSchema = z
  .object({
    kind: z
      .enum(["waiter", "bill"])
      .describe(
        "What the customer is asking for: 'waiter' when they want someone to come to the table, 'bill' when they want to pay. Use this only when the customer actually asks for a person or for the bill — not to answer a question you can answer yourself.",
      ),
    note: z
      .string()
      .trim()
      .max(200)
      .optional()
      .describe(
        "One short line of context for the staff member who will walk over, in the customer's own terms (e.g. 'asked about the spice level', 'wants to split the bill'). Omit it when there is nothing useful to add; never invent a reason.",
      ),
  })
  .strict();
