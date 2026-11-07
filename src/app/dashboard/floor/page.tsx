import { FloorBoard } from "@/components/floor/floor-board";
import { loadFloor } from "@/lib/floor/actions";
import { requireCurrentRestaurant } from "@/lib/restaurants/require-current-restaurant";

export const metadata = {
  title: "Floor — Tableside",
};

/**
 * Every table at a glance, for whoever is working the room: who needs
 * someone, whose food is waiting at the pass, who is eating, which tables
 * are free. Server-rendered first so the room shows immediately, then
 * FloorBoard keeps it live.
 */
export default async function FloorPage() {
  const { restaurant } = await requireCurrentRestaurant();
  const rows = (await loadFloor(restaurant.id)) ?? [];

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Floor</h1>
        <p className="text-muted-foreground text-sm">
          Every table, live. The most urgent thing at each table shows first.
        </p>
      </div>
      <FloorBoard
        restaurantId={restaurant.id}
        basicMode={restaurant.basicMode}
        initial={rows}
      />
    </div>
  );
}
