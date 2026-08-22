"use client";

import { useActionState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { FormField } from "@/components/dashboard/form-field";
import type { CategoryFormState } from "@/lib/categories/actions";

const initialState: CategoryFormState = {};

export interface CategoryFormValues {
  name: string;
  description: string | null;
  displayOrder: number;
  isActive: boolean;
}

export function CategoryForm({
  action,
  defaultValues,
  submitLabel,
  pendingLabel,
}: {
  action: (
    prevState: CategoryFormState,
    formData: FormData,
  ) => Promise<CategoryFormState>;
  defaultValues?: CategoryFormValues;
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

      <FormField
        id="displayOrder"
        label="Display order"
        errors={errors.displayOrder}
        hint="Lower numbers show first."
      >
        <Input
          id="displayOrder"
          name="displayOrder"
          type="number"
          min={0}
          step={1}
          disabled={isPending}
          defaultValue={defaultValues?.displayOrder ?? 0}
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
          Active (visible for management)
        </Label>
      </div>

      <Button type="submit" disabled={isPending} className="mt-2 self-start">
        {isPending ? pendingLabel : submitLabel}
      </Button>
    </form>
  );
}
