"use client";

import { useActionState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { FormField } from "@/components/dashboard/form-field";
import { NativeSelect } from "@/components/dashboard/native-select";
import type { ModifierFormState } from "@/lib/modifiers/actions";

const initialState: ModifierFormState = {};

export interface ModifierGroupFormValues {
  menuItemId: string;
  name: string;
  description: string | null;
  isRequired: boolean;
  minSelections: number;
  maxSelections: number;
  displayOrder: number;
}

export function ModifierGroupForm({
  action,
  menuItems,
  defaultValues,
  submitLabel,
  pendingLabel,
}: {
  action: (
    prevState: ModifierFormState,
    formData: FormData,
  ) => Promise<ModifierFormState>;
  menuItems: { id: string; name: string }[];
  defaultValues?: ModifierGroupFormValues;
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

      <FormField id="menuItemId" label="Menu item" errors={errors.menuItemId}>
        <NativeSelect
          id="menuItemId"
          name="menuItemId"
          required
          disabled={isPending}
          defaultValue={defaultValues?.menuItemId ?? ""}
        >
          <option value="" disabled>
            Choose a menu item
          </option>
          {menuItems.map((item) => (
            <option key={item.id} value={item.id}>
              {item.name}
            </option>
          ))}
        </NativeSelect>
      </FormField>

      <FormField
        id="name"
        label="Group name"
        errors={errors.name}
        hint='E.g. "Size" or "Spice level".'
      >
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
          rows={2}
          disabled={isPending}
          defaultValue={defaultValues?.description ?? undefined}
        />
      </FormField>

      <div className="flex items-center gap-2">
        <Checkbox
          id="isRequired"
          name="isRequired"
          defaultChecked={defaultValues?.isRequired}
          disabled={isPending}
        />
        <Label htmlFor="isRequired" className="font-normal">
          Required (customer must choose an option)
        </Label>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <FormField
          id="minSelections"
          label="Min selections"
          errors={errors.minSelections}
        >
          <Input
            id="minSelections"
            name="minSelections"
            type="number"
            min={0}
            step={1}
            disabled={isPending}
            defaultValue={defaultValues?.minSelections ?? 0}
          />
        </FormField>
        <FormField
          id="maxSelections"
          label="Max selections"
          errors={errors.maxSelections}
        >
          <Input
            id="maxSelections"
            name="maxSelections"
            type="number"
            min={0}
            step={1}
            disabled={isPending}
            defaultValue={defaultValues?.maxSelections ?? 1}
          />
        </FormField>
        <FormField
          id="displayOrder"
          label="Display order"
          errors={errors.displayOrder}
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
      </div>

      <Button type="submit" disabled={isPending} className="mt-2 self-start">
        {isPending ? pendingLabel : submitLabel}
      </Button>
    </form>
  );
}
