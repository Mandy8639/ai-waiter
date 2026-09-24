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
import { spiceLevels } from "@/lib/menu/schema";
import type { MenuItemFormState } from "@/lib/menu/actions";

const initialState: MenuItemFormState = {};

export interface MenuItemFormValues {
  name: string;
  slug: string;
  categoryId: string;
  description: string | null;
  price: number;
  imageUrl: string | null;
  isAvailable: boolean;
  isVegetarian: boolean;
  isHalal: boolean;
  isKosher: boolean;
  isVegan: boolean;
  isSpicy: boolean;
  spiceLevel: string | null;
  containsNuts: boolean;
  containsDairy: boolean;
  containsGluten: boolean;
  preparationTime: number | null;
  portionNote: string | null;
  displayOrder: number;
}

function Toggle({
  id,
  label,
  defaultChecked,
  disabled,
}: {
  id: string;
  label: string;
  defaultChecked?: boolean;
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

export function MenuItemForm({
  action,
  categories,
  defaultValues,
  submitLabel,
  pendingLabel,
}: {
  action: (
    prevState: MenuItemFormState,
    formData: FormData,
  ) => Promise<MenuItemFormState>;
  categories: { id: string; name: string }[];
  defaultValues?: MenuItemFormValues;
  submitLabel: string;
  pendingLabel: string;
}) {
  const [state, formAction, isPending] = useActionState(action, initialState);
  const errors = state.fieldErrors ?? {};

  return (
    <form action={formAction} className="flex flex-col gap-6" noValidate>
      {state.error && (
        <Alert variant="destructive">
          <AlertDescription>{state.error}</AlertDescription>
        </Alert>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        <FormField id="name" label="Name" errors={errors.name}>
          <Input
            id="name"
            name="name"
            required
            disabled={isPending}
            defaultValue={defaultValues?.name}
          />
        </FormField>
        <FormField id="slug" label="Slug" errors={errors.slug}>
          <Input
            id="slug"
            name="slug"
            placeholder="chicken-tikka"
            required
            disabled={isPending}
            defaultValue={defaultValues?.slug}
          />
        </FormField>
      </div>

      <FormField id="categoryId" label="Category" errors={errors.categoryId}>
        <NativeSelect
          id="categoryId"
          name="categoryId"
          required
          disabled={isPending}
          defaultValue={defaultValues?.categoryId ?? ""}
        >
          <option value="" disabled>
            Choose a category
          </option>
          {categories.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </NativeSelect>
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

      <div className="grid gap-4 sm:grid-cols-3">
        <FormField id="price" label="Price ($)" errors={errors.price}>
          <Input
            id="price"
            name="price"
            type="number"
            min={0}
            step="0.01"
            required
            disabled={isPending}
            defaultValue={defaultValues?.price ?? 0}
          />
        </FormField>
        <FormField
          id="preparationTime"
          label="Prep time (minutes, optional)"
          errors={errors.preparationTime}
        >
          <Input
            id="preparationTime"
            name="preparationTime"
            type="number"
            min={0}
            step={1}
            disabled={isPending}
            defaultValue={defaultValues?.preparationTime ?? undefined}
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

      {/*
        Deliberately a sentence, not a "Serves" number. Diners ask "is this
        enough for me?", and the true answer depends on appetite — the
        placeholder shows the shape of a good answer, because a restaurant
        given a blank box will otherwise type "2".
      */}
      <FormField
        id="portionNote"
        label="Portion (optional)"
        errors={errors.portionNote}
        hint="How much food is it, in your own words? e.g. “Generous for one, or two can share it with a roti.”"
      >
        <Textarea
          id="portionNote"
          name="portionNote"
          rows={2}
          maxLength={200}
          disabled={isPending}
          defaultValue={defaultValues?.portionNote ?? undefined}
        />
      </FormField>

      <FormField
        id="imageUrl"
        label="Image URL (optional)"
        errors={errors.imageUrl}
      >
        <Input
          id="imageUrl"
          name="imageUrl"
          type="url"
          placeholder="https://…"
          disabled={isPending}
          defaultValue={defaultValues?.imageUrl ?? undefined}
        />
      </FormField>

      <fieldset className="flex flex-col gap-3">
        <legend className="text-sm font-medium">
          Availability &amp; dietary
        </legend>
        <div className="grid gap-3 sm:grid-cols-2">
          <Toggle
            id="isAvailable"
            label="Available"
            defaultChecked={defaultValues?.isAvailable ?? true}
            disabled={isPending}
          />
          <Toggle
            id="isVegetarian"
            label="Vegetarian"
            defaultChecked={defaultValues?.isVegetarian}
            disabled={isPending}
          />
          <Toggle
            id="isVegan"
            label="Vegan"
            defaultChecked={defaultValues?.isVegan}
            disabled={isPending}
          />
          <Toggle
            id="isSpicy"
            label="Spicy"
            defaultChecked={defaultValues?.isSpicy}
            disabled={isPending}
          />
          <Toggle
            id="containsNuts"
            label="Contains nuts"
            defaultChecked={defaultValues?.containsNuts}
            disabled={isPending}
          />
          <Toggle
            id="containsDairy"
            label="Contains dairy"
            defaultChecked={defaultValues?.containsDairy}
            disabled={isPending}
          />
          <Toggle
            id="containsGluten"
            label="Contains gluten"
            defaultChecked={defaultValues?.containsGluten}
            disabled={isPending}
          />
        </div>
      </fieldset>

      {/*
        Separated from the toggles above on purpose. Those describe a dish;
        these are statements the restaurant makes and that diners may act on
        for religious reasons. The copy says who is making the claim, because
        this software never verifies any of it.
      */}
      <fieldset className="flex flex-col gap-3">
        <legend className="type-label mb-1">What you can confirm</legend>
        <p className="type-caption text-muted-foreground -mt-1">
          Only tick these if your kitchen can stand behind them. Diners see them
          as your restaurant&apos;s statement, and we never work them out from
          ingredients.
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          <Toggle
            id="isHalal"
            label="Halal"
            defaultChecked={defaultValues?.isHalal}
            disabled={isPending}
          />
          <Toggle
            id="isKosher"
            label="Kosher"
            defaultChecked={defaultValues?.isKosher}
            disabled={isPending}
          />
        </div>
      </fieldset>

      <FormField
        id="spiceLevel"
        label="Spice level (optional)"
        errors={errors.spiceLevel}
      >
        <NativeSelect
          id="spiceLevel"
          name="spiceLevel"
          disabled={isPending}
          defaultValue={defaultValues?.spiceLevel ?? ""}
        >
          <option value="">Not set</option>
          {spiceLevels.map((level) => (
            <option key={level} value={level}>
              {level.replace("_", " ")}
            </option>
          ))}
        </NativeSelect>
      </FormField>

      <Button type="submit" disabled={isPending} className="mt-2 self-start">
        {isPending ? pendingLabel : submitLabel}
      </Button>
    </form>
  );
}
