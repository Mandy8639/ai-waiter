"use client";

import { useActionState, useRef, useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  createRestaurantAction,
  type OnboardingFormState,
} from "@/lib/restaurants/onboarding-actions";
import { slugify } from "@/lib/restaurants/slug-core";

const initialState: OnboardingFormState = {};

function Field({
  id,
  name,
  label,
  errors,
  hint,
  children,
}: {
  id: string;
  name: string;
  label: string;
  errors?: string[];
  hint?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2">
      <Label htmlFor={id}>{label}</Label>
      {children}
      {hint && !errors?.[0] && (
        <p id={`${name}-hint`} className="text-muted-foreground text-sm">
          {hint}
        </p>
      )}
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

  // Every field is controlled, so a failed attempt keeps what was typed
  // (an uncontrolled form is reset after each action).
  const [values, setValues] = useState<Record<string, string>>({});
  const value = (field: string) => values[field] ?? "";
  const set = (field: string) => (e: { target: { value: string } }) =>
    setValues((prev) => ({ ...prev, [field]: e.target.value }));

  // The web address follows the name until the owner edits it themselves.
  const [slugEdited, setSlugEdited] = useState(false);
  const slug = slugEdited
    ? value("slug")
    : value("name")
      ? slugify(value("name"))
      : "";

  // The owner's timezone, so hours and "back tomorrow" are in their time.
  // Read when the form is sent, so the server render never has to guess it.
  const timezoneRef = useRef<HTMLInputElement>(null);

  return (
    <form
      action={formAction}
      onSubmit={() => {
        if (timezoneRef.current) {
          timezoneRef.current.value =
            Intl.DateTimeFormat().resolvedOptions().timeZone ?? "";
        }
      }}
      className="flex flex-col gap-6"
      noValidate
    >
      <input ref={timezoneRef} type="hidden" name="timezone" defaultValue="" />
      {/* Tells the server the address was made from the name, so a taken
          one can be swapped for a free variant instead of refused. */}
      <input type="hidden" name="slugAuto" value={slugEdited ? "" : "1"} />
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
            value={value("name")}
            onChange={set("name")}
            placeholder="e.g. Spice Garden"
            disabled={isPending}
            aria-invalid={!!errors.name}
          />
        </Field>
        <Field
          id="slug"
          name="slug"
          label="Web address"
          errors={errors.slug}
          hint={
            <>
              Diners&apos; menu link:{" "}
              <span className="text-foreground font-medium break-all">
                tableside.menu/r/{slug || "your-restaurant"}
              </span>
              . Filled in from the name; change it if you like.
            </>
          }
        >
          <Input
            id="slug"
            name="slug"
            value={slug}
            onChange={(e) => {
              setSlugEdited(true);
              set("slug")(e);
            }}
            placeholder="spice-garden"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            disabled={isPending}
            aria-invalid={!!errors.slug}
            aria-describedby={errors.slug ? "slug-error" : "slug-hint"}
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
          value={value("description")}
          onChange={set("description")}
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
          <Input
            id="phone"
            name="phone"
            type="tel"
            value={value("phone")}
            onChange={set("phone")}
            disabled={isPending}
          />
        </Field>
        <Field
          id="address"
          name="address"
          label="Address (optional)"
          errors={errors.address}
        >
          <Input
            id="address"
            name="address"
            value={value("address")}
            onChange={set("address")}
            disabled={isPending}
          />
        </Field>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <Field
          id="city"
          name="city"
          label="City (optional)"
          errors={errors.city}
        >
          <Input
            id="city"
            name="city"
            value={value("city")}
            onChange={set("city")}
            disabled={isPending}
          />
        </Field>
        <Field
          id="state"
          name="state"
          label="State (optional)"
          errors={errors.state}
        >
          <Input
            id="state"
            name="state"
            value={value("state")}
            onChange={set("state")}
            disabled={isPending}
          />
        </Field>
        <Field
          id="postalCode"
          name="postalCode"
          label="Postal code (optional)"
          errors={errors.postalCode}
        >
          <Input
            id="postalCode"
            name="postalCode"
            value={value("postalCode")}
            onChange={set("postalCode")}
            disabled={isPending}
          />
        </Field>
      </div>

      <Button type="submit" disabled={isPending} className="mt-2 self-start">
        {isPending ? "Creating restaurant…" : "Create restaurant"}
      </Button>
    </form>
  );
}
