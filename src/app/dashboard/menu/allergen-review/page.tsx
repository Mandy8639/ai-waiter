import {
  AllergenConfirmList,
  type PendingItem,
} from "@/components/dashboard/allergen-confirm-list";
import { createClient } from "@/lib/supabase/server";
import { requireCurrentRestaurant } from "@/lib/restaurants/require-current-restaurant";

export const metadata = {
  title: "Confirm allergens — AI Waiter",
};

export default async function AllergenReviewPage() {
  const { restaurant } = await requireCurrentRestaurant();
  const supabase = await createClient();

  // Unconfirmed rows only — these are the suggestions awaiting a human.
  const { data: links } = await supabase
    .from("menu_item_allergens")
    .select("menu_item_id, allergen_id")
    .eq("restaurant_id", restaurant.id)
    .is("confirmed_at", null);

  const itemIds = [...new Set((links ?? []).map((l) => l.menu_item_id))];
  const allergenIds = [...new Set((links ?? []).map((l) => l.allergen_id))];

  const [{ data: menuItems }, { data: allergens }] = await Promise.all([
    itemIds.length
      ? supabase.from("menu_items").select("id, name").in("id", itemIds)
      : Promise.resolve({ data: [] as { id: string; name: string }[] }),
    allergenIds.length
      ? supabase.from("allergens").select("id, name").in("id", allergenIds)
      : Promise.resolve({ data: [] as { id: string; name: string }[] }),
  ]);

  const itemName = new Map((menuItems ?? []).map((i) => [i.id, i.name]));
  const allergenName = new Map((allergens ?? []).map((a) => [a.id, a.name]));

  const pending: PendingItem[] = itemIds.map((id) => ({
    menuItemId: id,
    itemName: itemName.get(id) ?? "Unknown dish",
    suggested: (links ?? [])
      .filter((l) => l.menu_item_id === id)
      .map((l) => ({
        allergenId: l.allergen_id,
        name: allergenName.get(l.allergen_id) ?? "Unknown",
      })),
  }));

  return (
    <div className="flex max-w-2xl flex-1 flex-col gap-5">
      <div className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold tracking-tight">
          Confirm allergens
        </h1>
        <p className="text-muted-foreground text-sm">
          Nothing here is shown to a diner until you confirm it, dish by dish.
        </p>
      </div>

      <AllergenConfirmList restaurantId={restaurant.id} items={pending} />
    </div>
  );
}
