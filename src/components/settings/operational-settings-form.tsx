"use client";

import { useActionState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { FormField } from "@/components/dashboard/form-field";
import type { SettingsFormState } from "@/lib/settings/actions";

const initialState: SettingsFormState = {};

export interface OperationalSettingsValues {
  acceptingOrders: boolean;
  allowCustomerNotes: boolean;
  allowAiRecommendations: boolean;
  allowUpselling: boolean;
  maxOrderItems: number;
}

function Toggle({
  id,
  label,
  defaultChecked,
  disabled,
}: {
  id: string;
  label: string;
  defaultChecked: boolean;
  disabled?: boolean;
}) {
  return (
    <div className="flex items-center gap-2">
      <Checkbox
        id={id}
        name={id}
        defaultChecked={defaultChecked}
        disabled={disabled}
      />
      <Label htmlFor={id} className="font-normal">
        {label}
      </Label>
    </div>
  );
}

export function OperationalSettingsForm({
  action,
  defaultValues,
  disabled,
}: {
  action: (
    prevState: SettingsFormState,
    formData: FormData,
  ) => Promise<SettingsFormState>;
  defaultValues: OperationalSettingsValues;
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

      <Toggle
        id="acceptingOrders"
        label="Accepting orders"
        defaultChecked={defaultValues.acceptingOrders}
        disabled={readOnly}
      />
      <Toggle
        id="allowCustomerNotes"
        label="Allow customer notes on orders"
        defaultChecked={defaultValues.allowCustomerNotes}
        disabled={readOnly}
      />
      <Toggle
        id="allowAiRecommendations"
        label="Allow AI recommendations"
        defaultChecked={defaultValues.allowAiRecommendations}
        disabled={readOnly}
      />
      <Toggle
        id="allowUpselling"
        label="Allow AI upselling"
        defaultChecked={defaultValues.allowUpselling}
        disabled={readOnly}
      />

      <FormField
        id="maxOrderItems"
        label="Max items per order"
        errors={errors.maxOrderItems}
      >
        <Input
          id="maxOrderItems"
          name="maxOrderItems"
          type="number"
          min={1}
          step={1}
          disabled={readOnly}
          defaultValue={defaultValues.maxOrderItems}
        />
      </FormField>

      {!disabled && (
        <Button type="submit" disabled={isPending} className="mt-2 self-start">
          {isPending ? "Saving…" : "Save settings"}
        </Button>
      )}
    </form>
  );
}
