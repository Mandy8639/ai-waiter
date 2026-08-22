import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { buttonVariants } from "@/components/ui/button";
import { EmptyState } from "@/components/dashboard/empty-state";
import { MenuItemForm } from "@/components/menu/menu-item-form";
import { createClient } from "@/lib/supabase/server";
import { requireCurrentRestaurant } from "@/lib/restaurants/require-current-restaurant";
import { createMenuItem } from "@/lib/menu/actions";

export const metadata = {
  title: "New menu item — AI Waiter",
};

export default async function NewMenuItemPage() {
  const { restaurant } = await requireCurrentRestaurant();
  const supabase = await createClient();

  const { data: categories } = await supabase
    .from("categories")
    .select("id, name")
    .eq("restaurant_id", restaurant.id)
    .order("display_order", { ascending: true });

  if (!categories || categories.length === 0) {
    return (
      <div className="mx-auto max-w-xl">
        <EmptyState
          title="Create a category first"
          description="Menu items belong to a category — add one before creating your first dish."
          actionHref="/dashboard/categories/new"
          actionLabel="New category"
        />
      </div>
    );
  }

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">New menu item</h1>
        <Link
          href="/dashboard/menu"
          className={buttonVariants({ variant: "outline", size: "sm" })}
        >
          Back to menu
        </Link>
      </div>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Item details</CardTitle>
        </CardHeader>
        <CardContent>
          <MenuItemForm
            action={createMenuItem.bind(null, restaurant.id)}
            categories={categories}
            submitLabel="Create menu item"
            pendingLabel="Creating…"
          />
        </CardContent>
      </Card>
    </div>
  );
}
