import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { EmptyState } from "@/components/dashboard/empty-state";
import { ReservationStatusActions } from "@/components/reservations/reservation-status-actions";
import { ConfirmRequestForm } from "@/components/reservations/confirm-request-form";
import { createClient } from "@/lib/supabase/server";
import { requireCurrentRestaurant } from "@/lib/restaurants/require-current-restaurant";
import {
  confirmReservationRequest,
  transitionReservationStatus,
} from "@/lib/reservations/actions";
import { formatReservationTime } from "@/lib/reservations/timezone";

export const metadata = {
  title: "Reservations — AI Waiter",
};

const STATUS_LABELS: Record<string, string> = {
  pending: "Requested",
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
  pending: "outline",
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

  // Requests first, then everything else by time.
  //
  // The nav badge sends staff here specifically to deal with a request, so
  // burying it below next week's confirmed bookings would waste the trip.
  // Sorted in memory rather than in the query because "pending first, then
  // by time" is presentation, and this list is a single service's worth of
  // rows, not a page of thousands.
  const ordered = [...(reservations ?? [])].sort((a, b) => {
    const aPending = a.status === "pending" ? 0 : 1;
    const bPending = b.status === "pending" ? 0 : 1;
    if (aPending !== bPending) return aPending - bPending;
    return a.reservation_time.localeCompare(b.reservation_time);
  });

  // A pending request has no table yet, so this list is filtered rather
  // than mapped straight across.
  const tableIds = [
    ...new Set(
      ordered.map((r) => r.table_id).filter((id): id is string => id !== null),
    ),
  ];
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

  // Every active table, for assigning one to a request. Loaded only when
  // there is actually a request to accept — most of the time this page has
  // none and the query would be pure overhead.
  const hasRequests = ordered.some((r) => r.status === "pending");
  const { data: activeTables } = hasRequests
    ? await supabase
        .from("tables")
        .select("id, table_number, display_name")
        .eq("restaurant_id", restaurant.id)
        .eq("is_active", true)
        .order("table_number", { ascending: true })
    : {
        data: [] as {
          id: string;
          table_number: string;
          display_name: string | null;
        }[],
      };
  const allTables = (activeTables ?? []).map((t) => ({
    id: t.id,
    label: t.display_name || `Table ${t.table_number}`,
  }));

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

      {ordered.length === 0 ? (
        <EmptyState
          title="No upcoming reservations"
          description="Bookings you add will show up here."
          actionHref={canManage ? "/dashboard/reservations/new" : undefined}
          actionLabel={canManage ? "New reservation" : undefined}
        />
      ) : (
        <div className="flex flex-col gap-3">
          {ordered.map((reservation) => {
            const table = reservation.table_id
              ? tableById.get(reservation.table_id)
              : null;
            const isRequest = reservation.status === "pending";
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
                      {/* Saying "Table ?" for a request nobody has accepted
                          would read as a lookup failure rather than as the
                          truth, which is that no table has been chosen. */}
                      {table
                        ? table.display_name || `Table ${table.table_number}`
                        : "No table yet"}{" "}
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
                      {/* A request needs a table before it can be anything
                          else — seating someone requires knowing where. So
                          accepting it replaces the status actions until it
                          is confirmed. */}
                      {isRequest ? (
                        <ConfirmRequestForm
                          tables={allTables}
                          confirmAction={confirmReservationRequest.bind(
                            null,
                            restaurant.id,
                            reservation.id,
                          )}
                          onDecline={transitionReservationStatus.bind(
                            null,
                            restaurant.id,
                            reservation.id,
                          )}
                        />
                      ) : (
                        <ReservationStatusActions
                          status={reservation.status}
                          onTransition={transitionReservationStatus.bind(
                            null,
                            restaurant.id,
                            reservation.id,
                          )}
                        />
                      )}
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
