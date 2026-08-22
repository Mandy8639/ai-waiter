"use client";

import { useActionState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { FormField } from "@/components/dashboard/form-field";
import type { TableFormState } from "@/lib/tables/actions";

const initialState: TableFormState = {};

export interface TableFormValues {
  tableNumber: string;
  displayName: string | null;
  isActive: boolean;
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
