import Link from "next/link";
import { notFound } from "next/navigation";
import { ChevronLeft } from "lucide-react";
import { StationsManager } from "@/components/kitchen/stations-manager";
import { getKitchenStations } from "@/lib/orders/kitchen";
import { createClient } from "@/lib/supabase/server";
import { requireCurrentRestaurant } from "@/lib/restaurants/require-current-restaurant";

export const metadata = {
  title: "Kitchen stations — Tableside",
};

/**
 * Phase I: name the kitchen's stations and send each dish to one. Owners
 * and managers only — kitchen_stations' RLS enforces it; this page simply
 * doesn't exist for anyone else.
 */
export default async function KitchenStationsPage() {
  const { restaurant } = await requireCurrentRestaurant();
  if (restaurant.role !== "owner" && restaurant.role !== "manager") {
    notFound();
  }

  const supabase = await createClient();
  const [stations, { data: items }, { data: categories }] = await Promise.all([
    getKitchenStations(restaurant.id),
    supabase
      .from("menu_items")
      // station_id: 20261001090000, newer than database.types.ts.
      .select("id, name, category_id, station_id" as "id, name, category_id")
      .eq("restaurant_id", restaurant.id)
      .order("name", { ascending: true }),
    supabase
      .from("categories")
      .select("id, name")
      .eq("restaurant_id", restaurant.id),
  ]);

  const categoryName = new Map((categories ?? []).map((c) => [c.id, c.name]));
  const dishes = (items ?? []).map((item) => ({
    id: item.id,
    name: item.name,
    categoryName: item.category_id
      ? (categoryName.get(item.category_id) ?? null)
      : null,
    stationId:
      (item as unknown as { station_id?: string | null }).station_id ?? null,
  }));

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-6">
      <div className="flex flex-col gap-2">
        <Link
          href="/dashboard/kitchen"
          className="text-muted-foreground hover:text-foreground inline-flex w-fit items-center gap-1 text-sm"
        >
          <ChevronLeft className="size-4" aria-hidden="true" />
          Kitchen
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight">
          Kitchen stations
        </h1>
        <p className="text-muted-foreground text-sm">
          Split the kitchen board by station: each station&apos;s screen shows
          only the dishes it makes, and each station marks its own part of an
          order done.
        </p>
      </div>
      <StationsManager
        restaurantId={restaurant.id}
        stations={stations}
        dishes={dishes}
      />
    </div>
  );
}
