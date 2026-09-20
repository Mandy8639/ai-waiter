"use client";

import { useActionState, useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { FormField } from "@/components/dashboard/form-field";
import type { SettingsFormState } from "@/lib/settings/actions";

const initialState: SettingsFormState = {};

/**
 * A rate typed as a percentage ("8.25") but submitted as the fraction the
 * server action and database already use ("0.0825"). Asking owners to type
 * 0.0825 was the old UI; the stored value and the action's contract are
 * unchanged — only the hidden input carries the conversion.
 */
function PercentInput({
  id,
  name,
  defaultFraction,
  disabled,
}: {
  id: string;
  name: string;
  defaultFraction: number;
  disabled?: boolean;
}) {
  const [percent, setPercent] = useState(() =>
    // toPrecision trims float noise (0.0825 * 100 = 8.250000000000002).
    String(Number((defaultFraction * 100).toPrecision(10))),
  );
  const parsed = Number(percent);
  const fraction =
    percent.trim() === "" || !Number.isFinite(parsed)
      ? ""
      : String(Number((parsed / 100).toPrecision(10)));

  return (
    <div className="relative">
      <Input
        id={id}
        type="number"
        inputMode="decimal"
        min={0}
        max={100}
        step="0.01"
        disabled={disabled}
        value={percent}
        onChange={(event) => setPercent(event.target.value)}
        className="pr-8"
      />
      <span
        className="text-muted-foreground pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-sm"
        aria-hidden="true"
      >
        %
      </span>
      <input type="hidden" name={name} value={fraction} />
    </div>
  );
}

export interface RestaurantProfileValues {
  name: string;
  description: string | null;
  phone: string | null;
  address: string | null;
  city: string | null;
  state: string | null;
  postalCode: string | null;
  timezone: string;
  currency: string;
  taxRate: number;
  serviceCharge: number;
}

export function RestaurantProfileForm({
  action,
  defaultValues,
  disabled,
}: {
  action: (
    prevState: SettingsFormState,
    formData: FormData,
  ) => Promise<SettingsFormState>;
  defaultValues: RestaurantProfileValues;
  disabled?: boolean;
}) {
  const [state, formAction, isPending] = useActionState(action, initialState);
  const errors = state.fieldErrors ?? {};
  const readOnly = disabled || isPending;

  return (
    <form action={formAction} className="flex flex-col gap-5" noValidate>
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

      <FormField id="name" label="Name" errors={errors.name}>
        <Input
          id="name"
          name="name"
          required
          disabled={readOnly}
          defaultValue={defaultValues.name}
        />
      </FormField>

      <FormField
        id="description"
        label="Description"
        errors={errors.description}
      >
        <Textarea
          id="description"
          name="description"
          rows={3}
          disabled={readOnly}
          defaultValue={defaultValues.description ?? undefined}
        />
      </FormField>

      <div className="grid gap-4 sm:grid-cols-2">
        <FormField id="phone" label="Phone" errors={errors.phone}>
          <Input
            id="phone"
            name="phone"
            type="tel"
            disabled={readOnly}
            defaultValue={defaultValues.phone ?? undefined}
          />
        </FormField>
        <FormField id="address" label="Address" errors={errors.address}>
          <Input
            id="address"
            name="address"
            disabled={readOnly}
            defaultValue={defaultValues.address ?? undefined}
          />
        </FormField>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <FormField id="city" label="City" errors={errors.city}>
          <Input
            id="city"
            name="city"
            disabled={readOnly}
            defaultValue={defaultValues.city ?? undefined}
          />
        </FormField>
        <FormField id="state" label="State" errors={errors.state}>
          <Input
            id="state"
            name="state"
            disabled={readOnly}
            defaultValue={defaultValues.state ?? undefined}
          />
        </FormField>
        <FormField
          id="postalCode"
          label="Postal code"
          errors={errors.postalCode}
        >
          <Input
            id="postalCode"
            name="postalCode"
            disabled={readOnly}
            defaultValue={defaultValues.postalCode ?? undefined}
          />
        </FormField>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <FormField id="timezone" label="Timezone" errors={errors.timezone}>
          <Input
            id="timezone"
            name="timezone"
            required
            disabled={readOnly}
            defaultValue={defaultValues.timezone}
          />
        </FormField>
        <FormField id="currency" label="Currency" errors={errors.currency}>
          <Input
            id="currency"
            name="currency"
            required
            disabled={readOnly}
            defaultValue={defaultValues.currency}
          />
        </FormField>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <FormField id="taxRate" label="Sales tax (%)" errors={errors.taxRate}>
          <PercentInput
            id="taxRate"
            name="taxRate"
            defaultFraction={defaultValues.taxRate}
            disabled={readOnly}
          />
        </FormField>
        <FormField
          id="serviceCharge"
          label="Service charge (%)"
          errors={errors.serviceCharge}
        >
          <PercentInput
            id="serviceCharge"
            name="serviceCharge"
            defaultFraction={defaultValues.serviceCharge}
            disabled={readOnly}
          />
        </FormField>
      </div>

      {!disabled && (
        <Button type="submit" disabled={isPending} className="mt-2 self-start">
          {isPending ? "Saving…" : "Save profile"}
        </Button>
      )}
    </form>
  );
}
