"use client";

import { useActionState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { FormField } from "@/components/dashboard/form-field";

export interface NameDescriptionFormState {
  error?: string;
  fieldErrors?: Record<string, string[] | undefined>;
}

const initialState: NameDescriptionFormState = {};

/** Shared shape used by ingredients and allergens — both are just name + optional description. */
export function NameDescriptionForm({
  action,
  defaultValues,
  submitLabel,
  pendingLabel,
}: {
  action: (
    prevState: NameDescriptionFormState,
    formData: FormData,
  ) => Promise<NameDescriptionFormState>;
  defaultValues?: { name: string; description: string | null };
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

      <FormField id="name" label="Name" errors={errors.name}>
        <Input
          id="name"
          name="name"
          required
          disabled={isPending}
          defaultValue={defaultValues?.name}
        />
      </FormField>

      <FormField
        id="description"
        label="Description (optional)"
        errors={errors.description}
      >
        <Textarea
          id="description"
          name="description"
          rows={3}
          disabled={isPending}
          defaultValue={defaultValues?.description ?? undefined}
        />
      </FormField>

      <Button type="submit" disabled={isPending} className="mt-2 self-start">
        {isPending ? pendingLabel : submitLabel}
      </Button>
    </form>
  );
}
