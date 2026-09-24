import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/dashboard/empty-state";
import { ModifierGroupForm } from "@/components/modifiers/modifier-group-form";
import { createClient } from "@/lib/supabase/server";
import { requireCurrentRestaurant } from "@/lib/restaurants/require-current-restaurant";
import { createModifierGroup } from "@/lib/modifiers/actions";

export const metadata = {
  title: "New modifier group — Tableside",
};

export default async function NewModifierGroupPage() {
  const { restaurant } = await requireCurrentRestaurant();
  const supabase = await createClient();

  const { data: menuItems } = await supabase
    .from("menu_items")
    .select("id, name")
    .eq("restaurant_id", restaurant.id)
    .order("display_order");

  if (!menuItems || menuItems.length === 0) {
    return (
      <div className="mx-auto max-w-xl">
        <EmptyState
          title="Create a menu item first"
          description="Modifier groups belong to a menu item — add one before creating a group."
          actionHref="/dashboard/menu/new"
          actionLabel="New menu item"
        />
      </div>
    );
  }

  return (
    <div className="mx-auto flex max-w-xl flex-col gap-6">
      <h1 className="text-2xl font-semibold tracking-tight">
        New modifier group
      </h1>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Group details</CardTitle>
        </CardHeader>
        <CardContent>
          <ModifierGroupForm
            action={createModifierGroup.bind(null, restaurant.id)}
            menuItems={menuItems}
            submitLabel="Create group"
            pendingLabel="Creating…"
          />
        </CardContent>
      </Card>
    </div>
  );
}
