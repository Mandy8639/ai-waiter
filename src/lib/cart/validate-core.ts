import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";

type Client = SupabaseClient<Database>;

export interface PricedSelection {
  unitPrice: number;
  modifiersPrice: number;
  lineTotal: number;
  selectedOptions: {
    id: string;
    modifierId: string;
    name: string;
    priceAdjustment: number;
  }[];
}

export type ValidationResult =
  { ok: true; priced: PricedSelection } | { ok: false; error: string };

/**
 * The one place price and availability get decided. Never trusts
 * anything the client claims about a menu item, its modifiers, or their
 * prices — every value here is read fresh from the database and
 * recomputed, on every add-to-cart call (see docs/security.md#price-validation
 * and #cart-validation). Runs through the caller's own RLS-scoped client,
 * so it can only ever see what the public storefront policies expose —
 * an unavailable item is invisible here the same way it's invisible on
 * the menu page, not just "flagged."
 *
 * No `import "server-only"` here — the guard lives in validate.ts (the
 * production entry point every caller actually imports), so this file
 * stays directly unit-testable with a fake Supabase client, matching
 * loop.ts's and the provider `*-mapping.ts` files' split from their
 * server-only hosts.
 */
export async function validateAndPriceSelection(
  supabase: Client,
  restaurantId: string,
  menuItemId: string,
  selectedOptionIds: string[],
): Promise<ValidationResult> {
  const { data: menuItem } = await supabase
    .from("menu_items")
    .select("id, price, is_available, category_id, restaurant_id")
    .eq("id", menuItemId)
    .eq("restaurant_id", restaurantId)
    .maybeSingle();

  if (!menuItem) {
    return { ok: false, error: "This item is no longer on the menu." };
  }
  if (!menuItem.is_available) {
    return { ok: false, error: "This item is currently unavailable." };
  }

  const { data: category } = await supabase
    .from("categories")
    .select("is_active")
    .eq("id", menuItem.category_id)
    .maybeSingle();

  if (!category?.is_active) {
    return { ok: false, error: "This item is currently unavailable." };
  }

  // Phase L: only while one of its menus is on (database-decided, in the
  // restaurant's timezone). Covers the menu and the AI waiter's add-to-cart
  // alike; submit_order() refuses it again at order time.
  const rpc = supabase.rpc.bind(supabase) as unknown as (
    fn: string,
    args: Record<string, unknown>,
  ) => Promise<{ data: unknown; error: unknown }>;
  const { data: onNow, error: onNowError } = await rpc("category_on_now", {
    p_category_id: menuItem.category_id,
  });
  if (!onNowError && onNow === false) {
    return { ok: false, error: "This dish isn't being served right now." };
  }

  const { data: groups } = await supabase
    .from("menu_item_modifiers")
    .select("id, name, is_required, min_selections, max_selections")
    .eq("menu_item_id", menuItemId);

  const groupIds = (groups ?? []).map((g) => g.id);

  const { data: optionsForItem } =
    groupIds.length > 0
      ? await supabase
          .from("modifier_options")
          .select("id, modifier_id, name, price_adjustment, is_available")
          .in("modifier_id", groupIds)
      : {
          data: [] as {
            id: string;
            modifier_id: string;
            name: string;
            price_adjustment: number;
            is_available: boolean;
          }[],
        };

  const uniqueSelectedIds = [...new Set(selectedOptionIds)];
  const selectedOptions = (optionsForItem ?? []).filter((o) =>
    uniqueSelectedIds.includes(o.id),
  );

  // Every selected id must resolve to a real option that belongs to one of
  // THIS item's modifier groups — this is what stops a client from sending
  // another menu item's (or another restaurant's) option id.
  if (selectedOptions.length !== uniqueSelectedIds.length) {
    return {
      ok: false,
      error: "One of the selected options isn't valid for this item.",
    };
  }
  const unavailable = selectedOptions.find((o) => !o.is_available);
  if (unavailable) {
    return {
      ok: false,
      error: `"${unavailable.name}" is no longer available.`,
    };
  }

  for (const group of groups ?? []) {
    const countForGroup = selectedOptions.filter(
      (o) => o.modifier_id === group.id,
    ).length;
    const effectiveMin = group.is_required
      ? Math.max(1, group.min_selections)
      : group.min_selections;

    if (countForGroup < effectiveMin) {
      return {
        ok: false,
        error: group.is_required
          ? `Please make a selection for "${group.name}".`
          : `Choose at least ${effectiveMin} option(s) for "${group.name}".`,
      };
    }
    if (countForGroup > group.max_selections) {
      return {
        ok: false,
        error: `Choose at most ${group.max_selections} option(s) for "${group.name}".`,
      };
    }
  }

  const unitPrice = Number(menuItem.price);
  const modifiersPrice = selectedOptions.reduce(
    (sum, o) => sum + Number(o.price_adjustment),
    0,
  );

  return {
    ok: true,
    priced: {
      unitPrice,
      modifiersPrice,
      lineTotal: 0, // filled in by the caller once quantity is known
      selectedOptions: selectedOptions.map((o) => ({
        id: o.id,
        modifierId: o.modifier_id,
        name: o.name,
        priceAdjustment: Number(o.price_adjustment),
      })),
    },
  };
}
