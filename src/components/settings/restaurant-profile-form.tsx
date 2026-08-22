"use client";

import { useActionState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { FormField } from "@/components/dashboard/form-field";
import type { SettingsFormState } from "@/lib/settings/actions";

const initialState: SettingsFormState = {};

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
        <FormField
          id="taxRate"
          label="Tax rate (fraction, e.g. 0.0825)"
          errors={errors.taxRate}
        >
          <Input
            id="taxRate"
            name="taxRate"
            type="number"
            min={0}
            max={1}
            step="0.0001"
            disabled={readOnly}
            defaultValue={defaultValues.taxRate}
          />
        </FormField>
        <FormField
          id="serviceCharge"
          label="Service charge (fraction)"
          errors={errors.serviceCharge}
        >
          <Input
            id="serviceCharge"
            name="serviceCharge"
            type="number"
            min={0}
            max={1}
            step="0.0001"
            disabled={readOnly}
            defaultValue={defaultValues.serviceCharge}
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
