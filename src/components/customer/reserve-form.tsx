"use client";

import { useActionState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import type { RequestReservationState } from "@/lib/reservations/request-actions";

const initialState: RequestReservationState = {};

type Action = (
  state: RequestReservationState,
  formData: FormData,
) => Promise<RequestReservationState>;

/**
 * A diner asking for a table.
 *
 * Deliberately not the staff ReservationForm with fields hidden. That one
 * requires a table, and no table exists to pick here — the restaurant
 * chooses one when it accepts. Reusing it would have meant passing an
 * empty `tables` list and hoping nothing downstream minded.
 *
 * The copy never says "booked". Until someone at the restaurant accepts
 * it, nothing is held, and a page that implied otherwise would send people
 * to a table that was never theirs.
 */
export function ReserveForm({
  action,
  restaurantName,
  timeZone,
}: {
  action: Action;
  restaurantName: string;
  /** Shown next to the time so a diner knows which clock they are typing in — theirs and the restaurant's may differ. */
  timeZone: string;
}) {
  const [state, submit, pending] = useActionState(action, initialState);
  const errors = state.fieldErrors ?? {};

  if (state.reservationId) {
    return (
      <div className="flex flex-col gap-3 rounded-lg border p-5 text-center">
        <h2 className="text-lg font-semibold">Request sent</h2>
        <p className="text-muted-foreground text-sm">
          {restaurantName} has your request and will confirm it shortly.{" "}
          <strong>Nothing is booked yet</strong> — they&apos;ll be in touch on
          the number you gave.
        </p>
      </div>
    );
  }

  return (
    <form action={submit} className="flex flex-col gap-4" noValidate>
      {state.error && (
        <Alert variant="destructive">
          <AlertDescription>{state.error}</AlertDescription>
        </Alert>
      )}

      <div className="flex flex-col gap-2">
        <Label htmlFor="customerName">Your name</Label>
        <Input id="customerName" name="customerName" disabled={pending} />
        {errors.customerName && (
          <p className="text-destructive text-sm">{errors.customerName[0]}</p>
        )}
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor="customerPhone">Phone</Label>
        <Input
          id="customerPhone"
          name="customerPhone"
          type="tel"
          inputMode="tel"
          disabled={pending}
        />
        {errors.customerPhone && (
          <p className="text-destructive text-sm">{errors.customerPhone[0]}</p>
        )}
        <p className="text-muted-foreground text-xs">
          How the restaurant confirms your table.
        </p>
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor="customerEmail">Email (optional)</Label>
        <Input
          id="customerEmail"
          name="customerEmail"
          type="email"
          disabled={pending}
        />
        {errors.customerEmail && (
          <p className="text-destructive text-sm">{errors.customerEmail[0]}</p>
        )}
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor="partySize">How many of you</Label>
        <Input
          id="partySize"
          name="partySize"
          type="number"
          inputMode="numeric"
          min={1}
          max={50}
          defaultValue={2}
          disabled={pending}
        />
        {errors.partySize && (
          <p className="text-destructive text-sm">{errors.partySize[0]}</p>
        )}
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor="reservationTime">When</Label>
        <Input
          id="reservationTime"
          name="reservationTime"
          type="datetime-local"
          disabled={pending}
        />
        {errors.reservationTime && (
          <p className="text-destructive text-sm">
            {errors.reservationTime[0]}
          </p>
        )}
        <p className="text-muted-foreground text-xs">
          {restaurantName}&apos;s local time ({timeZone.replace("_", " ")}).
        </p>
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor="notes">Anything they should know (optional)</Label>
        <Textarea
          id="notes"
          name="notes"
          rows={2}
          placeholder="Allergies, a birthday, a pushchair…"
          disabled={pending}
        />
        {errors.notes && (
          <p className="text-destructive text-sm">{errors.notes[0]}</p>
        )}
      </div>

      <Button type="submit" disabled={pending}>
        {pending ? "Sending…" : "Request a table"}
      </Button>
      <p className="text-muted-foreground text-center text-xs">
        This sends a request. {restaurantName} confirms it before your table is
        held.
      </p>
    </form>
  );
}
