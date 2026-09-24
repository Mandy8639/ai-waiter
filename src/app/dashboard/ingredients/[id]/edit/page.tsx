import { notFound } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { NameDescriptionForm } from "@/components/dashboard/name-description-form";
import { MenuItemLinksCard } from "@/components/dashboard/menu-item-links-card";
import { createClient } from "@/lib/supabase/server";
import { requireCurrentRestaurant } from "@/lib/restaurants/require-current-restaurant";
import {
  setIngredientMenuItemLink,
  updateIngredient,
} from "@/lib/ingredients/actions";

export const metadata = {
  title: "Edit ingredient — Tableside",
};

export default async function EditIngredientPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const { restaurant } = await requireCurrentRestaurant();
  const supabase = await createClient();

  const [{ data: ingredient }, { data: menuItems }, { data: links }] =
    await Promise.all([
      supabase
        .from("ingredients")
        .select("id, name, description")
        .eq("id", id)
        .eq("restaurant_id", restaurant.id)
        .maybeSingle(),
      supabase
        .from("menu_items")
        .select("id, name")
        .eq("restaurant_id", restaurant.id)
        .order("display_order"),
      supabase
        .from("menu_item_ingredients")
        .select("menu_item_id")
        .eq("ingredient_id", id),
    ]);

  if (!ingredient) {
    notFound();
  }

  const linkedMenuItemIds = new Set((links ?? []).map((l) => l.menu_item_id));

  return (
    <div className="mx-auto flex max-w-xl flex-col gap-6">
      <h1 className="text-2xl font-semibold tracking-tight">Edit ingredient</h1>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Ingredient details</CardTitle>
        </CardHeader>
        <CardContent>
          <NameDescriptionForm
            action={updateIngredient.bind(null, restaurant.id, ingredient.id)}
            defaultValues={ingredient}
            submitLabel="Save changes"
            pendingLabel="Saving…"
          />
        </CardContent>
      </Card>

      <MenuItemLinksCard
        title="Used in these menu items"
        menuItems={menuItems ?? []}
        linkedMenuItemIds={linkedMenuItemIds}
        onToggle={setIngredientMenuItemLink.bind(
          null,
          restaurant.id,
          ingredient.id,
        )}
      />
    </div>
  );
}
