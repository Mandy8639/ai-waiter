import { notFound } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ReservationForm } from "@/components/reservations/reservation-form";
import { createClient } from "@/lib/supabase/server";
import { requireCurrentRestaurant } from "@/lib/restaurants/require-current-restaurant";
import { updateReservationDetails } from "@/lib/reservations/actions";

export const metadata = {
  title: "Edit reservation — AI Waiter",
};

export default async function EditReservationPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const { restaurant } = await requireCurrentRestaurant();
  const supabase = await createClient();

  const { data: reservation } = await supabase
    .from("reservations")
    .select(
      "id, customer_name, customer_phone, customer_email, party_size, notes",
    )
    .eq("id", id)
    .eq("restaurant_id", restaurant.id)
    .maybeSingle();

  if (!reservation) {
    notFound();
  }

  return (
    <div className="mx-auto flex max-w-xl flex-col gap-6">
      <h1 className="text-2xl font-semibold tracking-tight">
        Edit reservation
      </h1>
      <p className="text-muted-foreground -mt-4 text-sm">
        Table and date/time can&apos;t be changed here — cancel and create a new
        reservation to reschedule.
      </p>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Customer details</CardTitle>
        </CardHeader>
        <CardContent>
          <ReservationForm
            action={updateReservationDetails.bind(
              null,
              restaurant.id,
              reservation.id,
            )}
            defaultValues={{
              customerName: reservation.customer_name,
              customerPhone: reservation.customer_phone,
              customerEmail: reservation.customer_email ?? undefined,
              partySize: reservation.party_size,
              notes: reservation.notes ?? undefined,
            }}
            submitLabel="Save changes"
          />
        </CardContent>
      </Card>
    </div>
  );
}
