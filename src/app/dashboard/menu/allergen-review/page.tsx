import {
  AllergenConfirmList,
  type PendingItem,
} from "@/components/dashboard/allergen-confirm-list";
import { createClient } from "@/lib/supabase/server";
import { requireCurrentRestaurant } from "@/lib/restaurants/require-current-restaurant";
import { ALLERGEN_VOCABULARY } from "@/lib/menu-import/suggestions";
import { FindAllergensButton } from "@/components/dashboard/find-allergens-button";
import { suggestAllergensFromMenu } from "@/lib/menu-graph/actions";

export const metadata = {
  title: "Confirm allergens — Tableside",
};

export default async function AllergenReviewPage() {
  const { restaurant } = await requireCurrentRestaurant();
  const supabase = await createClient();

  // Unconfirmed rows only — these are the suggestions awaiting a human.
  // suggestion_reason: why the menu knowledge graph suggested it
  // (20261123090000), newer than database.types.ts.
  const { data: rawLinks } = await supabase
    .from("menu_item_allergens")
    .select(
      "menu_item_id, allergen_id, suggestion_reason" as "menu_item_id, allergen_id",
    )
    .eq("restaurant_id", restaurant.id)
    .is("confirmed_at", null);
  const links = (rawLinks ?? []) as unknown as {
    menu_item_id: string;
    allergen_id: string;
    suggestion_reason: string | null;
  }[];

  const itemIds = [...new Set(links.map((l) => l.menu_item_id))];
  const allergenIds = [...new Set(links.map((l) => l.allergen_id))];

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

  // Every allergen in the vocabulary is offered for every dish, with the
  // model's suggestions pre-ticked. Showing only what was suggested would
  // let a reviewer remove but never add — and the suggestion prompt tells
  // the model to leave an allergen out when unsure, so it under-suggests by
  // design. A kitchen that knows its dahi vada is finished with a
  // wheat-based sev must be able to say so here.
  const pending: PendingItem[] = itemIds.map((id) => {
    const reasons = new Map<string, string | null>();
    for (const l of links.filter((l) => l.menu_item_id === id)) {
      const name = allergenName.get(l.allergen_id);
      if (name) reasons.set(name, l.suggestion_reason);
    }
    return {
      menuItemId: id,
      itemName: itemName.get(id) ?? "Unknown dish",
      options: ALLERGEN_VOCABULARY.map((name) => ({
        name,
        suggested: reasons.has(name),
        reason: reasons.get(name) ?? undefined,
      })),
    };
  });

  return (
    <div className="flex max-w-2xl flex-1 flex-col gap-5">
      <div className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold tracking-tight">
          Confirm allergens
        </h1>
        <p className="text-muted-foreground text-sm">
          Nothing here is shown to a diner until you confirm it. Mark each dish
          reviewed as you check it, then confirm the reviewed ones together.
        </p>
      </div>

      <FindAllergensButton
        action={suggestAllergensFromMenu.bind(null, restaurant.id)}
      />

      <AllergenConfirmList restaurantId={restaurant.id} items={pending} />
    </div>
  );
}
