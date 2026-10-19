import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ReservationForm } from "@/components/reservations/reservation-form";
import { createClient } from "@/lib/supabase/server";
import { requireCurrentRestaurant } from "@/lib/restaurants/require-current-restaurant";
import { createReservation } from "@/lib/reservations/actions";

export const metadata = {
  title: "New reservation — Tableside",
};

export default async function NewReservationPage() {
  const { restaurant } = await requireCurrentRestaurant();
  const supabase = await createClient();

  const { data: tables } = await supabase
    .from("tables")
    // kind: 20261022090000, newer than database.types.ts.
    .select(
      "id, table_number, display_name, kind" as "id, table_number, display_name",
    )
    .eq("restaurant_id", restaurant.id)
    .eq("is_active", true)
    .order("table_number");

  return (
    <div className="mx-auto flex max-w-xl flex-col gap-6">
      <h1 className="text-2xl font-semibold tracking-tight">New reservation</h1>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Booking details</CardTitle>
        </CardHeader>
        <CardContent>
          <ReservationForm
            action={createReservation.bind(null, restaurant.id)}
            timeZone={restaurant.timezone}
            // A pickup counter can't be reserved.
            tables={(tables ?? [])
              .filter((t) => (t as { kind?: string }).kind !== "counter")
              .map((t) => ({
                id: t.id,
                label: t.display_name || `Table ${t.table_number}`,
              }))}
            submitLabel="Book table"
          />
        </CardContent>
      </Card>
    </div>
  );
}
