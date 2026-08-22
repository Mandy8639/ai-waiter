import { notFound } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { MenuItemForm } from "@/components/menu/menu-item-form";
import { createClient } from "@/lib/supabase/server";
import { requireCurrentRestaurant } from "@/lib/restaurants/require-current-restaurant";
import { updateMenuItem } from "@/lib/menu/actions";

export const metadata = {
  title: "Edit menu item — AI Waiter",
};

export default async function EditMenuItemPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const { restaurant } = await requireCurrentRestaurant();
  const supabase = await createClient();

  const [{ data: item }, { data: categories }] = await Promise.all([
    supabase
      .from("menu_items")
      .select(
        "id, name, slug, category_id, description, price, image_url, is_available, is_vegetarian, is_vegan, is_spicy, spice_level, contains_nuts, contains_dairy, contains_gluten, preparation_time, display_order",
      )
      .eq("id", id)
      .eq("restaurant_id", restaurant.id)
      .maybeSingle(),
    supabase
      .from("categories")
      .select("id, name")
      .eq("restaurant_id", restaurant.id)
      .order("display_order"),
  ]);

  if (!item) {
    notFound();
  }

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-6">
      <h1 className="text-2xl font-semibold tracking-tight">Edit menu item</h1>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Item details</CardTitle>
        </CardHeader>
        <CardContent>
          <MenuItemForm
            action={updateMenuItem.bind(null, restaurant.id, item.id)}
            categories={categories ?? []}
            defaultValues={{
              name: item.name,
              slug: item.slug,
              categoryId: item.category_id,
              description: item.description,
              price: Number(item.price),
              imageUrl: item.image_url,
              isAvailable: item.is_available,
              isVegetarian: item.is_vegetarian,
              isVegan: item.is_vegan,
              isSpicy: item.is_spicy,
              spiceLevel: item.spice_level,
              containsNuts: item.contains_nuts,
              containsDairy: item.contains_dairy,
              containsGluten: item.contains_gluten,
              preparationTime: item.preparation_time,
              displayOrder: item.display_order,
            }}
            submitLabel="Save changes"
            pendingLabel="Saving…"
          />
        </CardContent>
      </Card>
    </div>
  );
}
