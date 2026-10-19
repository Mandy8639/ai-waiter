"use client";

import { useActionState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { FormField } from "@/components/dashboard/form-field";
import { NativeSelect } from "@/components/dashboard/native-select";
import type { TableFormState } from "@/lib/tables/actions";

const initialState: TableFormState = {};

export interface TableFormValues {
  tableNumber: string;
  displayName: string | null;
  isActive: boolean;
  kind: "table" | "counter";
}

export function TableForm({
  action,
  defaultValues,
  submitLabel,
  pendingLabel,
}: {
  action: (
    prevState: TableFormState,
    formData: FormData,
  ) => Promise<TableFormState>;
  defaultValues?: TableFormValues;
  submitLabel: string;
  pendingLabel: string;
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

      <FormField
        id="tableNumber"
        label="Table number"
        errors={errors.tableNumber}
        hint="Unique within this restaurant."
      >
        <Input
          id="tableNumber"
          name="tableNumber"
          required
          disabled={isPending}
          defaultValue={defaultValues?.tableNumber}
        />
      </FormField>

      <FormField
        id="displayName"
        label="Display name (optional)"
        errors={errors.displayName}
        hint='E.g. "Patio 2".'
      >
        <Input
          id="displayName"
          name="displayName"
          disabled={isPending}
          defaultValue={defaultValues?.displayName ?? undefined}
        />
      </FormField>

      <FormField
        id="kind"
        label="Kind"
        errors={errors.kind}
        hint="At a pickup counter, diners order ahead, choose a pickup time and give a name to call. Counters can't be reserved."
      >
        <NativeSelect
          id="kind"
          name="kind"
          disabled={isPending}
          defaultValue={defaultValues?.kind ?? "table"}
        >
          <option value="table">Table — diners sit here</option>
          <option value="counter">Pickup counter — diners order ahead</option>
        </NativeSelect>
      </FormField>

      <div className="flex items-center gap-2">
        <Checkbox
          id="isActive"
          name="isActive"
          defaultChecked={defaultValues?.isActive ?? true}
          disabled={isPending}
        />
        <Label htmlFor="isActive" className="font-normal">
          Active
        </Label>
      </div>

      <Button type="submit" disabled={isPending} className="mt-2 self-start">
        {isPending ? pendingLabel : submitLabel}
      </Button>
    </form>
  );
}
