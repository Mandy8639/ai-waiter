"use client";

import { useActionState, useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { NativeSelect } from "@/components/dashboard/native-select";
import type { ReservationFormState } from "@/lib/reservations/actions";
import type { TransitionReservationResult } from "@/lib/reservations/actions";

const initialState: ReservationFormState = {};

/**
 * Accepting a customer's booking request.
 *
 * The only decision staff make here is which table, because it is the one
 * fact the system cannot work out for itself — nothing in the schema knows
 * how many people a table seats, which is exactly why a person is asked.
 *
 * Declining reuses transition_reservation_status() rather than a second
 * bespoke function: turning down a request is a cancellation, and pending
 * -> cancelled is already a valid move.
 */
export function ConfirmRequestForm({
  tables,
  confirmAction,
  onDecline,
}: {
  tables: { id: string; label: string }[];
  confirmAction: (
    state: ReservationFormState,
    formData: FormData,
  ) => Promise<ReservationFormState>;
  onDecline: (targetStatus: string) => Promise<TransitionReservationResult>;
}) {
  const [state, submit, pending] = useActionState(confirmAction, initialState);
  const [declineError, setDeclineError] = useState<string | null>(null);
  const [declining, startDecline] = useTransition();

  function handleDecline() {
    setDeclineError(null);
    startDecline(async () => {
      const result = await onDecline("cancelled");
      if (result.error) setDeclineError(result.error);
    });
  }

  if (tables.length === 0) {
    // Better than a dropdown with nothing in it, which reads as a broken
    // page rather than as a restaurant with no active tables.
    return (
      <p className="text-muted-foreground text-right text-xs">
        Add an active table before accepting bookings.
      </p>
    );
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <form action={submit} className="flex flex-wrap justify-end gap-2">
        <NativeSelect
          name="tableId"
          aria-label="Table"
          disabled={pending || declining}
          className="h-9 text-sm"
        >
          {tables.map((table) => (
            <option key={table.id} value={table.id}>
              {table.label}
            </option>
          ))}
        </NativeSelect>
        <Button type="submit" size="sm" disabled={pending || declining}>
          {pending ? "Accepting…" : "Accept"}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="destructive"
          disabled={pending || declining}
          onClick={handleDecline}
        >
          {declining ? "Declining…" : "Decline"}
        </Button>
      </form>
      {state.error && <p className="text-destructive text-xs">{state.error}</p>}
      {state.fieldErrors?.tableId && (
        <p className="text-destructive text-xs">
          {state.fieldErrors.tableId[0]}
        </p>
      )}
      {declineError && (
        <p className="text-destructive text-xs">{declineError}</p>
      )}
    </div>
  );
}
