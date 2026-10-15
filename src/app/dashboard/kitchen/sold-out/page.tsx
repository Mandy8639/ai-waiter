import { SoldOutBoard } from "@/components/kitchen/sold-out-board";
import { requireCurrentRestaurant } from "@/lib/restaurants/require-current-restaurant";
import { createClient } from "@/lib/supabase/server";
import { buildSoldOutMenu } from "@/lib/menu/sold-out-core";

export const metadata = {
  title: "Sold out — Tableside",
};

/**
 * The kitchen's sold-out switches: every dish and every add-on, one tap to
 * take it off the menu and one to bring it back. Open to owner, manager
 * and kitchen (src/components/dashboard/nav-items.ts); the switch itself
 * is set_menu_item_availability() / set_modifier_option_availability(),
 * which change nothing but availability.
 */
export default async function SoldOutPage() {
  const { restaurant } = await requireCurrentRestaurant();
  const supabase = await createClient();

  const [categories, dishes, groups] = await Promise.all([
    supabase
      .from("categories")
      .select("id, name, display_order")
      .eq("restaurant_id", restaurant.id)
      .eq("is_active", true),
    supabase
      .from("menu_items")
      .select("id, name, category_id, is_available, display_order")
      .eq("restaurant_id", restaurant.id),
    supabase
      .from("menu_item_modifiers")
      .select("id, menu_item_id, name, display_order")
      .eq("restaurant_id", restaurant.id),
  ]);

  const groupIds = (groups.data ?? []).map((g) => g.id);
  const options =
    groupIds.length > 0
      ? await supabase
          .from("modifier_options")
          .select("id, modifier_id, name, is_available, display_order")
          .in("modifier_id", groupIds)
      : { data: [] };

  const menu = buildSoldOutMenu({
    categories: categories.data ?? [],
    dishes: dishes.data ?? [],
    groups: groups.data ?? [],
    options: options.data ?? [],
  });

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Sold out</h1>
        <p className="text-muted-foreground text-sm">
          Ran out of something? Tap it. Diners stop seeing it straight away, and
          it can&apos;t be ordered until you tap it back.
        </p>
      </div>
      <SoldOutBoard restaurantId={restaurant.id} menu={menu} />
    </div>
  );
}
