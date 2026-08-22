import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { createClient } from "@/lib/supabase/server";
import { requireCurrentRestaurant } from "@/lib/restaurants/require-current-restaurant";

export const metadata = {
  title: "Dashboard — AI Waiter",
};

export default async function DashboardOverviewPage() {
  const { restaurant } = await requireCurrentRestaurant();
  const supabase = await createClient();

  const [menuItems, categories, tables, restaurantRow] = await Promise.all([
    supabase
      .from("menu_items")
      .select("*", { count: "exact", head: true })
      .eq("restaurant_id", restaurant.id),
    supabase
      .from("categories")
      .select("*", { count: "exact", head: true })
      .eq("restaurant_id", restaurant.id),
    supabase
      .from("tables")
      .select("*", { count: "exact", head: true })
      .eq("restaurant_id", restaurant.id),
    supabase
      .from("restaurants")
      .select("is_active")
      .eq("id", restaurant.id)
      .single(),
  ]);

  const isActive = restaurantRow.data?.is_active ?? false;

  const stats = [
    { label: "Menu items", value: menuItems.count ?? 0 },
    { label: "Categories", value: categories.count ?? 0 },
    { label: "Tables", value: tables.count ?? 0 },
  ];

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">
          {restaurant.name}
        </h1>
        <p className="text-muted-foreground text-sm">
          Overview of your restaurant.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {stats.map((s) => (
          <Card key={s.label}>
            <CardHeader className="pb-2">
              <CardTitle className="text-muted-foreground text-sm font-medium">
                {s.label}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-3xl font-semibold">{s.value}</p>
            </CardContent>
          </Card>
        ))}

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-muted-foreground text-sm font-medium">
              Status
            </CardTitle>
          </CardHeader>
          <CardContent>
            <Badge variant={isActive ? "secondary" : "destructive"}>
              {isActive ? "Active" : "Inactive"}
            </Badge>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
