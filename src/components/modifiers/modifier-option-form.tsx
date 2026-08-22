"use client";

import { useActionState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { FormField } from "@/components/dashboard/form-field";
import type { ModifierFormState } from "@/lib/modifiers/actions";

const initialState: ModifierFormState = {};

export function ModifierOptionForm({
  action,
}: {
  action: (
    prevState: ModifierFormState,
    formData: FormData,
  ) => Promise<ModifierFormState>;
}) {
  const [state, formAction, isPending] = useActionState(action, initialState);
  const errors = state.fieldErrors ?? {};

  return (
    <form
      action={formAction}
      className="flex flex-col gap-4 sm:flex-row sm:items-end sm:gap-3"
      noValidate
    >
      <div className="flex flex-1 flex-col gap-4 sm:flex-row">
        <FormField id="option-name" label="Option name" errors={errors.name}>
          <Input
            id="option-name"
            name="name"
            required
            disabled={isPending}
            placeholder="Large"
          />
        </FormField>
        <FormField
          id="option-price"
          label="Price adjustment ($)"
          errors={errors.priceAdjustment}
        >
          <Input
            id="option-price"
            name="priceAdjustment"
            type="number"
            step="0.01"
            disabled={isPending}
            defaultValue={0}
          />
        </FormField>
        <FormField id="option-order" label="Order" errors={errors.displayOrder}>
          <Input
            id="option-order"
            name="displayOrder"
            type="number"
            min={0}
            step={1}
            disabled={isPending}
            defaultValue={0}
          />
        </FormField>
      </div>
      <div className="flex items-center gap-2 pb-1">
        <Checkbox
          id="option-available"
          name="isAvailable"
          defaultChecked
          disabled={isPending}
        />
        <Label
          htmlFor="option-available"
          className="font-normal whitespace-nowrap"
        >
          Available
        </Label>
      </div>
      {state.error && (
        <Alert variant="destructive" className="sm:hidden">
          <AlertDescription>{state.error}</AlertDescription>
        </Alert>
      )}
      <Button type="submit" disabled={isPending} size="sm">
        {isPending ? "Adding…" : "Add option"}
      </Button>
    </form>
  );
}
