"use client";

import { useActionState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  createRestaurantAction,
  type OnboardingFormState,
} from "@/lib/restaurants/onboarding-actions";

const initialState: OnboardingFormState = {};

function Field({
  id,
  name,
  label,
  errors,
  children,
}: {
  id: string;
  name: string;
  label: string;
  errors?: string[];
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2">
      <Label htmlFor={id}>{label}</Label>
      {children}
      {errors?.[0] && (
        <p id={`${name}-error`} className="text-destructive text-sm">
          {errors[0]}
        </p>
      )}
    </div>
  );
}

export function OnboardingForm() {
  const [state, formAction, isPending] = useActionState(
    createRestaurantAction,
    initialState,
  );
  const errors = state.fieldErrors ?? {};

  return (
    <form action={formAction} className="flex flex-col gap-6" noValidate>
      {state.error && (
        <Alert variant="destructive">
          <AlertDescription>{state.error}</AlertDescription>
        </Alert>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          id="name"
          name="name"
          label="Restaurant name"
          errors={errors.name}
        >
          <Input
            id="name"
            name="name"
            required
            disabled={isPending}
            aria-invalid={!!errors.name}
          />
        </Field>
        <Field id="slug" name="slug" label="Slug" errors={errors.slug}>
          <Input
            id="slug"
            name="slug"
            placeholder="my-restaurant"
            required
            disabled={isPending}
            aria-invalid={!!errors.slug}
          />
        </Field>
      </div>

      <Field
        id="description"
        name="description"
        label="Description (optional)"
        errors={errors.description}
      >
        <Textarea
          id="description"
          name="description"
          rows={3}
          disabled={isPending}
        />
      </Field>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          id="phone"
          name="phone"
          label="Phone (optional)"
          errors={errors.phone}
        >
          <Input id="phone" name="phone" type="tel" disabled={isPending} />
        </Field>
        <Field
          id="address"
          name="address"
          label="Address (optional)"
          errors={errors.address}
        >
          <Input id="address" name="address" disabled={isPending} />
        </Field>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <Field
          id="city"
          name="city"
          label="City (optional)"
          errors={errors.city}
        >
          <Input id="city" name="city" disabled={isPending} />
        </Field>
        <Field
          id="state"
          name="state"
          label="State (optional)"
          errors={errors.state}
        >
          <Input id="state" name="state" disabled={isPending} />
        </Field>
        <Field
          id="postalCode"
          name="postalCode"
          label="Postal code (optional)"
          errors={errors.postalCode}
        >
          <Input id="postalCode" name="postalCode" disabled={isPending} />
        </Field>
      </div>

      <Button type="submit" disabled={isPending} className="mt-2 self-start">
        {isPending ? "Creating restaurant…" : "Create restaurant"}
      </Button>
    </form>
  );
}
