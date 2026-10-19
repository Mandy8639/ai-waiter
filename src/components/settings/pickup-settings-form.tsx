"use client";

import { useActionState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { FormField } from "@/components/dashboard/form-field";
import { NativeSelect } from "@/components/dashboard/native-select";
import type { SettingsFormState } from "@/lib/settings/actions";
import { PICKUP_SLOT_LENGTHS } from "@/lib/settings/schema";

const initialState: SettingsFormState = {};

export interface PickupSettingsValues {
  slotMinutes: number;
  slotCapacity: number;
  leadMinutes: number;
}

/**
 * The three numbers behind pickup ordering. They only matter once the
 * restaurant has a pickup counter (Tables → New table → Pickup counter),
 * and they apply to new choices only: an order already placed keeps its
 * slot.
 */
export function PickupSettingsForm({
  action,
  defaultValues,
  disabled,
}: {
  action: (
    prevState: SettingsFormState,
    formData: FormData,
  ) => Promise<SettingsFormState>;
  defaultValues: PickupSettingsValues;
  disabled?: boolean;
}) {
  const [state, formAction, isPending] = useActionState(action, initialState);
  const errors = state.fieldErrors ?? {};
  const readOnly = disabled || isPending;

  return (
    <form action={formAction} className="flex flex-col gap-4" noValidate>
      {state.error && (
        <Alert variant="destructive">
          <AlertDescription>{state.error}</AlertDescription>
        </Alert>
      )}
      {state.success && (
        <Alert>
          <AlertDescription>Saved.</AlertDescription>
        </Alert>
      )}

      <FormField
        id="slotMinutes"
        label="Pickup times every"
        errors={errors.slotMinutes}
        hint="Diners choose from times on this grid, starting on the hour."
      >
        <NativeSelect
          id="slotMinutes"
          name="slotMinutes"
          disabled={readOnly}
          defaultValue={String(defaultValues.slotMinutes)}
        >
          {PICKUP_SLOT_LENGTHS.map((minutes) => (
            <option key={minutes} value={minutes}>
              {minutes} minutes
            </option>
          ))}
        </NativeSelect>
      </FormField>

      <FormField
        id="slotCapacity"
        label="Orders per pickup time"
        errors={errors.slotCapacity}
        hint="Once this many orders share a time, it shows as full."
      >
        <Input
          id="slotCapacity"
          name="slotCapacity"
          type="number"
          min={1}
          max={100}
          step={1}
          disabled={readOnly}
          defaultValue={defaultValues.slotCapacity}
        />
      </FormField>

      <FormField
        id="leadMinutes"
        label="Notice the kitchen needs (minutes)"
        errors={errors.leadMinutes}
        hint="The earliest time offered is at least this far away. Also used as the cooking time for dishes with no preparation time set."
      >
        <Input
          id="leadMinutes"
          name="leadMinutes"
          type="number"
          min={5}
          max={240}
          step={1}
          disabled={readOnly}
          defaultValue={defaultValues.leadMinutes}
        />
      </FormField>

      {!disabled && (
        <Button type="submit" disabled={isPending} className="self-start">
          {isPending ? "Saving…" : "Save pickup settings"}
        </Button>
      )}
    </form>
  );
}
