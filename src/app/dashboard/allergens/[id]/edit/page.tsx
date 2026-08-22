import { notFound } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { NameDescriptionForm } from "@/components/dashboard/name-description-form";
import { MenuItemLinksCard } from "@/components/dashboard/menu-item-links-card";
import { createClient } from "@/lib/supabase/server";
import { requireCurrentRestaurant } from "@/lib/restaurants/require-current-restaurant";
import {
  setAllergenMenuItemLink,
  updateAllergen,
} from "@/lib/allergens/actions";

export const metadata = {
  title: "Edit allergen — AI Waiter",
};

export default async function EditAllergenPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const { restaurant } = await requireCurrentRestaurant();
  const supabase = await createClient();

  const [{ data: allergen }, { data: menuItems }, { data: links }] =
    await Promise.all([
      supabase
        .from("allergens")
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
        .from("menu_item_allergens")
        .select("menu_item_id")
        .eq("allergen_id", id),
    ]);

  if (!allergen) {
    notFound();
  }

  const linkedMenuItemIds = new Set((links ?? []).map((l) => l.menu_item_id));

  return (
    <div className="mx-auto flex max-w-xl flex-col gap-6">
      <h1 className="text-2xl font-semibold tracking-tight">Edit allergen</h1>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Allergen details</CardTitle>
        </CardHeader>
        <CardContent>
          <NameDescriptionForm
            action={updateAllergen.bind(null, restaurant.id, allergen.id)}
            defaultValues={allergen}
            submitLabel="Save changes"
            pendingLabel="Saving…"
          />
        </CardContent>
      </Card>

      <MenuItemLinksCard
        title="Present in these menu items"
        menuItems={menuItems ?? []}
        linkedMenuItemIds={linkedMenuItemIds}
        onToggle={setAllergenMenuItemLink.bind(
          null,
          restaurant.id,
          allergen.id,
        )}
      />
    </div>
  );
}
