import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { EmptyState } from "@/components/dashboard/empty-state";
import { ReservationStatusActions } from "@/components/reservations/reservation-status-actions";
import { createClient } from "@/lib/supabase/server";
import { requireCurrentRestaurant } from "@/lib/restaurants/require-current-restaurant";
import { transitionReservationStatus } from "@/lib/reservations/actions";
import { formatReservationTime } from "@/lib/reservations/timezone";

export const metadata = {
  title: "Reservations — AI Waiter",
};

const STATUS_LABELS: Record<string, string> = {
  confirmed: "Confirmed",
  seated: "Seated",
  completed: "Completed",
  cancelled: "Cancelled",
  no_show: "No-show",
};

const STATUS_BADGE_VARIANT: Record<
  string,
  "secondary" | "destructive" | "outline"
> = {
  confirmed: "secondary",
  seated: "secondary",
  completed: "outline",
  cancelled: "destructive",
  no_show: "destructive",
};

/**
 * Reservations is front-of-house only (owner/manager/staff) — kitchen
 * role has no RLS visibility into this table at all (see
 * docs/security.md#reservations), so a kitchen viewer sees this whole
 * page as empty rather than a permission error, matching how the rest of
 * the dashboard handles role-scoped emptiness elsewhere.
 */
export default async function ReservationsPage() {
  const { restaurant } = await requireCurrentRestaurant();
  const supabase = await createClient();

  const canManage = ["owner", "manager", "staff"].includes(restaurant.role);

  const { data: reservations } = await supabase
    .from("reservations")
    .select(
      "id, table_id, customer_name, customer_phone, party_size, reservation_time, status, notes",
    )
    .eq("restaurant_id", restaurant.id)
    .neq("status", "cancelled")
    .neq("status", "completed")
    .neq("status", "no_show")
    .order("reservation_time", { ascending: true });

  const tableIds = [...new Set((reservations ?? []).map((r) => r.table_id))];
  const { data: tables } =
    tableIds.length > 0
      ? await supabase
          .from("tables")
          .select("id, table_number, display_name")
          .in("id", tableIds)
      : {
          data: [] as {
            id: string;
            table_number: string;
            display_name: string | null;
          }[],
        };
  const tableById = new Map((tables ?? []).map((t) => [t.id, t]));

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            Reservations
          </h1>
          <p className="text-muted-foreground text-sm">
            Upcoming bookings for {restaurant.name}.
          </p>
        </div>
        {canManage && (
          <Link
            href="/dashboard/reservations/new"
            className={buttonVariants({ variant: "default" })}
          >
            New reservation
          </Link>
        )}
      </div>

      {(reservations ?? []).length === 0 ? (
        <EmptyState
          title="No upcoming reservations"
          description="Bookings you add will show up here."
          actionHref={canManage ? "/dashboard/reservations/new" : undefined}
          actionLabel={canManage ? "New reservation" : undefined}
        />
      ) : (
        <div className="flex flex-col gap-3">
          {(reservations ?? []).map((reservation) => {
            const table = tableById.get(reservation.table_id);
            return (
              <Card key={reservation.id}>
                <CardContent className="flex flex-wrap items-start justify-between gap-3 py-4">
                  <div className="flex flex-col gap-1">
                    <div className="flex items-center gap-2">
                      <p className="font-medium">{reservation.customer_name}</p>
                      <Badge variant={STATUS_BADGE_VARIANT[reservation.status]}>
                        {STATUS_LABELS[reservation.status] ??
                          reservation.status}
                      </Badge>
                    </div>
                    <p className="text-muted-foreground text-sm">
                      {formatReservationTime(
                        reservation.reservation_time,
                        restaurant.timezone,
                      )}{" "}
                      ·{" "}
                      {table?.display_name ||
                        `Table ${table?.table_number ?? "?"}`}{" "}
                      · {reservation.party_size}{" "}
                      {reservation.party_size === 1 ? "guest" : "guests"}
                    </p>
                    <p className="text-muted-foreground text-sm">
                      {reservation.customer_phone}
                    </p>
                    {reservation.notes && (
                      <p className="text-muted-foreground text-sm italic">
                        {reservation.notes}
                      </p>
                    )}
                  </div>
                  {canManage && (
                    <div className="flex flex-col items-end gap-2">
                      <Link
                        href={`/dashboard/reservations/${reservation.id}/edit`}
                        className="text-sm underline underline-offset-4"
                      >
                        Edit details
                      </Link>
                      <ReservationStatusActions
                        status={reservation.status}
                        onTransition={transitionReservationStatus.bind(
                          null,
                          restaurant.id,
                          reservation.id,
                        )}
                      />
                    </div>
                  )}
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
