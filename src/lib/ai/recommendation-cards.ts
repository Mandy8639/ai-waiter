import { env } from "@/lib/env";
import { resolveDinerImage, type DinerImage } from "@/lib/menu-images/resolve";
import {
  asRowsWithNewColumns,
  type MenuItemImageFields,
} from "@/lib/menu-images/menu-item-rows";
import "server-only";

import { createClient } from "@/lib/supabase/server";
import type { MentionedMenuItem } from "./recommendations";

/**
 * What a dish card under a waiter reply shows, beyond what the menu tool
 * already returned: the photo, the confirmed allergens, and whether the
 * dish can be added with one tap or needs its options chosen first.
 *
 * Read fresh here, through the diner's own RLS-scoped client, for the
 * handful of ids selectMentionedItems() picked — the same rows and the same
 * confirmed-only allergen rule as the menu page, so a card can never say
 * more than the menu does.
 */
export interface RecommendationCard extends MentionedMenuItem {
  /** Resolved on the server; null means the card renders text-only. */
  image: DinerImage | null;
  /** Confirmed allergens only — never import suggestions. */
  allergens: string[];
  /** True when a required option (size, spice…) must be chosen on the item page. */
  needsOptions: boolean;
}

export async function buildRecommendationCards(
  restaurantId: string,
  items: MentionedMenuItem[],
): Promise<RecommendationCard[]> {
  if (items.length === 0) return [];

  const ids = items.map((item) => item.id);
  const supabase = await createClient();

  const [{ data: rows }, { data: requiredGroups }, { data: allergenLinks }] =
    await Promise.all([
      supabase
        .from("menu_items")
        .select(
          "id, is_available, image_url, active_image_id, image_source, image_variants",
        )
        .eq("restaurant_id", restaurantId)
        .in("id", ids),
      supabase
        .from("menu_item_modifiers")
        .select("menu_item_id")
        .in("menu_item_id", ids)
        .eq("is_required", true),
      supabase
        .from("menu_item_allergens")
        .select("menu_item_id, allergen_id")
        .in("menu_item_id", ids)
        .not("confirmed_at", "is", null),
    ]);

  const allergenIds = [
    ...new Set((allergenLinks ?? []).map((l) => l.allergen_id)),
  ];
  const { data: allergenRows } = allergenIds.length
    ? await supabase.from("allergens").select("id, name").in("id", allergenIds)
    : { data: [] as { id: string; name: string }[] };
  const allergenName = new Map((allergenRows ?? []).map((a) => [a.id, a.name]));

  // database.types.ts predates phase 1, so the generated client cannot
  // describe the image columns. Asserted once here against the migration;
  // see src/lib/menu-images/menu-item-rows.ts.
  const imageRows = asRowsWithNewColumns<
    MenuItemImageFields & { id: string; is_available: boolean }
  >(rows);
  const rowById = new Map(imageRows.map((r) => [r.id, r]));
  const needsOptions = new Set(
    (requiredGroups ?? []).map((g) => g.menu_item_id),
  );

  return items.flatMap((item) => {
    const row = rowById.get(item.id);
    // Gone or unavailable since the tool ran: no card, rather than a card
    // whose "Add" button is guaranteed to fail.
    if (!row || !row.is_available) return [];
    return [
      {
        ...item,
        image: resolveDinerImage({
          activeImageId: row.active_image_id,
          imageSource: row.image_source,
          imageVariants: row.image_variants,
          legacyImageUrl: row.image_url,
          supabaseUrl: env.NEXT_PUBLIC_SUPABASE_URL,
        }),
        allergens: (allergenLinks ?? [])
          .filter((l) => l.menu_item_id === item.id)
          .map((l) => allergenName.get(l.allergen_id))
          .filter((name): name is string => Boolean(name)),
        needsOptions: needsOptions.has(item.id),
      },
    ];
  });
}
