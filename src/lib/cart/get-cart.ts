import "server-only";
import { createClient } from "@/lib/supabase/server";
import { getPublicMenus } from "@/lib/menus/queries";
import { onNowFilter } from "@/lib/menus/core";

export interface CartLineModifier {
  id: string;
  name: string;
  priceAdjustment: number;
}

export interface CartLine {
  id: string;
  menuItemId: string;
  menuItemName: string;
  menuItemImageUrl: string | null;
  quantity: number;
  unitPrice: number;
  modifiersPrice: number;
  lineTotal: number;
  modifiers: CartLineModifier[];
  /** How this diner asked for THIS line to be cooked, or null for as-normal. */
  spicePreference: string | null;
  /** This line's free-text kitchen request, or null. */
  notes: string | null;
  /** False if the menu item has gone unavailable since this was added — see docs/database.md#menu-availability-revalidation. */
  stillAvailable: boolean;
}

export interface CartSummary {
  lines: CartLine[];
  subtotal: number;
  taxRate: number;
  taxAmount: number;
  total: number;
  hasUnavailableItems: boolean;
}

/** Lightweight count for the persistent cart badge — avoids the full joined read on every page. */
export async function getCartItemCount(
  customerSessionId: string,
): Promise<number> {
  const supabase = await createClient();

  const { data: cart } = await supabase
    .from("carts")
    .select("id")
    .eq("customer_session_id", customerSessionId)
    .maybeSingle();

  if (!cart) return 0;

  const { data: items } = await supabase
    .from("cart_items")
    .select("quantity")
    .eq("cart_id", cart.id);
  return (items ?? []).reduce((sum, item) => sum + item.quantity, 0);
}

/**
 * Reads the customer's own cart (RLS-scoped, never trusts a client-passed
 * cart id) with a fresh live join to menu_items for name/image/current
 * availability — this is the "next cart mutation/revalidation must detect
 * this" requirement for items that went unavailable after being added.
 */
export async function getCart(
  restaurantId: string,
  customerSessionId: string,
): Promise<CartSummary> {
  const supabase = await createClient();

  const { data: cart } = await supabase
    .from("carts")
    .select("id")
    .eq("customer_session_id", customerSessionId)
    .maybeSingle();

  const empty: CartSummary = {
    lines: [],
    subtotal: 0,
    taxRate: 0,
    taxAmount: 0,
    total: 0,
    hasUnavailableItems: false,
  };

  const { data: restaurant } = await supabase
    .from("restaurants")
    .select("tax_rate")
    .eq("id", restaurantId)
    .maybeSingle();
  const taxRate = restaurant ? Number(restaurant.tax_rate) : 0;

  if (!cart) return { ...empty, taxRate };

  const { data: items } = await supabase
    .from("cart_items")
    .select(
      "id, menu_item_id, quantity, unit_price, modifiers_price, line_total, spice_preference, notes",
    )
    .eq("cart_id", cart.id)
    .order("created_at", { ascending: true });

  if (!items || items.length === 0) return { ...empty, taxRate };

  const menuInfo = await getLineMenuInfo(
    restaurantId,
    items.map((i) => i.menu_item_id),
    supabase,
  );

  const itemIds = items.map((i) => i.id);
  const { data: modifiers } =
    itemIds.length > 0
      ? await supabase
          .from("cart_item_modifiers")
          .select("id, cart_item_id, name, price_adjustment")
          .in("cart_item_id", itemIds)
      : {
          data: [] as {
            id: string;
            cart_item_id: string;
            name: string;
            price_adjustment: number;
          }[],
        };

  const modifiersByCartItemId = new Map<string, CartLineModifier[]>();
  for (const modifier of modifiers ?? []) {
    const list = modifiersByCartItemId.get(modifier.cart_item_id) ?? [];
    list.push({
      id: modifier.id,
      name: modifier.name,
      priceAdjustment: Number(modifier.price_adjustment),
    });
    modifiersByCartItemId.set(modifier.cart_item_id, list);
  }

  const lines: CartLine[] = items.map((item) => {
    const info = menuInfo.get(item.menu_item_id);
    return {
      id: item.id,
      menuItemId: item.menu_item_id,
      menuItemName: info?.name ?? "Item no longer available",
      menuItemImageUrl: info?.imageUrl ?? null,
      quantity: item.quantity,
      unitPrice: Number(item.unit_price),
      modifiersPrice: Number(item.modifiers_price),
      lineTotal: Number(item.line_total),
      modifiers: modifiersByCartItemId.get(item.id) ?? [],
      spicePreference: item.spice_preference,
      notes: item.notes,
      stillAvailable: info?.stillAvailable ?? false,
    };
  });

  const subtotal = lines.reduce((sum, line) => sum + line.lineTotal, 0);
  const taxAmount = subtotal * taxRate;
  const total = subtotal + taxAmount;
  const hasUnavailableItems = lines.some((line) => !line.stillAvailable);

  return { lines, subtotal, taxRate, taxAmount, total, hasUnavailableItems };
}

export interface LineMenuInfo {
  name: string;
  imageUrl: string | null;
  /** Off the menu right now counts as unavailable: the order would be refused (ORDER_ITEM_NOT_SERVED_NOW), so the cart says so first. */
  stillAvailable: boolean;
}

/**
 * Name, photo and current availability for the dishes in a cart, read
 * fresh — shared by the diner's own cart and the table's shared one
 * (src/lib/table-groups/queries.ts).
 */
export async function getLineMenuInfo(
  restaurantId: string,
  menuItemIds: string[],
  supabase: Awaited<ReturnType<typeof createClient>>,
): Promise<Map<string, LineMenuInfo>> {
  const ids = [...new Set(menuItemIds)];
  if (ids.length === 0) return new Map();
  const [{ data: menuItems }, menusResult] = await Promise.all([
    supabase
      .from("menu_items")
      .select("id, name, image_url, is_available, category_id")
      .in("id", ids),
    // Phase L: a dish added while its menu was on may not be served now.
    getPublicMenus(restaurantId, supabase),
  ]);
  const onNow = onNowFilter(menusResult);
  return new Map(
    (menuItems ?? []).map((m) => [
      m.id,
      {
        name: m.name,
        imageUrl: m.image_url,
        stillAvailable: m.is_available && (!onNow || onNow.has(m.category_id)),
      },
    ]),
  );
}
