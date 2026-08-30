"use client";

import { useActionState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { NativeSelect } from "@/components/dashboard/native-select";
import { FormField } from "@/components/dashboard/form-field";
import type { ReservationFormState } from "@/lib/reservations/actions";

const initialState: ReservationFormState = {};

type Action = (
  prevState: ReservationFormState,
  formData: FormData,
) => Promise<ReservationFormState>;

/**
 * One form, two shapes: `tables` present -> full create form (picks a
 * table + time, both immutable afterward — see
 * enforce_reservation_immutable_fields() — so they're deliberately not
 * offered on the edit path at all, rather than shown disabled).
 */
export function ReservationForm({
  action,
  tables,
  defaultValues,
  submitLabel,
}: {
  action: Action;
  tables?: { id: string; label: string }[];
  defaultValues?: {
    customerName?: string;
    customerPhone?: string;
    customerEmail?: string;
    partySize?: number;
    notes?: string;
  };
  submitLabel: string;
}) {
  const [state, formAction, isPending] = useActionState(action, initialState);
  const errors = state.fieldErrors ?? {};

  return (
    <form action={formAction} className="flex flex-col gap-5" noValidate>
      {state.error && (
        <Alert variant="destructive">
          <AlertDescription>{state.error}</AlertDescription>
        </Alert>
      )}

      {tables && (
        <FormField id="tableId" label="Table" errors={errors.tableId}>
          <NativeSelect
            id="tableId"
            name="tableId"
            required
            disabled={isPending}
          >
            <option value="">Choose a table</option>
            {tables.map((t) => (
              <option key={t.id} value={t.id}>
                {t.label}
              </option>
            ))}
          </NativeSelect>
        </FormField>
      )}

      {tables && (
        <FormField
          id="reservationTime"
          label="Date & time"
          errors={errors.reservationTime}
          hint="Rejected if the table already has a reservation within 90 minutes of this time."
        >
          <Input
            id="reservationTime"
            name="reservationTime"
            type="datetime-local"
            required
            disabled={isPending}
          />
        </FormField>
      )}

      <FormField
        id="customerName"
        label="Customer name"
        errors={errors.customerName}
      >
        <Input
          id="customerName"
          name="customerName"
          required
          disabled={isPending}
          defaultValue={defaultValues?.customerName}
        />
      </FormField>

      <FormField id="customerPhone" label="Phone" errors={errors.customerPhone}>
        <Input
          id="customerPhone"
          name="customerPhone"
          type="tel"
          required
          disabled={isPending}
          defaultValue={defaultValues?.customerPhone}
        />
      </FormField>

      <FormField
        id="customerEmail"
        label="Email (optional)"
        errors={errors.customerEmail}
      >
        <Input
          id="customerEmail"
          name="customerEmail"
          type="email"
          disabled={isPending}
          defaultValue={defaultValues?.customerEmail}
        />
      </FormField>

      <FormField id="partySize" label="Party size" errors={errors.partySize}>
        <Input
          id="partySize"
          name="partySize"
          type="number"
          min={1}
          step={1}
          required
          disabled={isPending}
          defaultValue={defaultValues?.partySize ?? 2}
        />
      </FormField>

      <FormField id="notes" label="Notes (optional)" errors={errors.notes}>
        <Textarea
          id="notes"
          name="notes"
          rows={3}
          disabled={isPending}
          defaultValue={defaultValues?.notes}
        />
      </FormField>

      <Button type="submit" disabled={isPending} className="mt-2 self-start">
        {isPending ? "Saving…" : submitLabel}
      </Button>
    </form>
  );
}
