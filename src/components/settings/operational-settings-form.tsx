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

export function Toggle({
  id,
  label,
  description,
  defaultChecked,
  disabled,
}: {
  id: string;
  label: string;
  /** What switching this actually does, in the diner's terms. */
  description: string;
  defaultChecked: boolean;
  disabled?: boolean;
}) {
  return (
    <div className="flex items-start gap-3 rounded-lg px-1 py-1.5">
      <Checkbox
        id={id}
        name={id}
        defaultChecked={defaultChecked}
        disabled={disabled}
        aria-describedby={`${id}-description`}
        className="mt-0.5"
      />
      <div className="flex flex-col gap-0.5">
        <Label htmlFor={id} className="font-medium">
          {label}
        </Label>
        <p
          id={`${id}-description`}
          className="type-caption text-muted-foreground"
        >
          {description}
        </p>
      </div>
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
        description="When off, diners can still browse the menu but can't place orders."
        defaultChecked={defaultValues.acceptingOrders}
        disabled={readOnly}
      />
      <Toggle
        id="allowCustomerNotes"
        label="Kitchen notes from diners"
        description="Lets diners add a note to a dish or an order, such as “no onions”."
        defaultChecked={defaultValues.allowCustomerNotes}
        disabled={readOnly}
      />
      {/*
        The field is named allow_ai_recommendations for historical reasons,
        but it switches the whole AI waiter on and off (src/lib/ai/actions.ts
        refuses every message when it is false). The label says what it does.
      */}
      <Toggle
        id="allowAiRecommendations"
        label="AI waiter"
        description="Diners can ask the AI waiter about your menu and order through it. When off, the waiter is hidden from your menu."
        defaultChecked={defaultValues.allowAiRecommendations}
        disabled={readOnly}
      />
      <Toggle
        id="allowUpselling"
        label="Let the AI waiter suggest an extra item"
        description="At most one relevant, low-pressure suggestion per order — for example a drink with a meal. Never invented discounts or urgency."
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
