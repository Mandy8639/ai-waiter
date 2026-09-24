"use client";

import { useActionState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/dashboard/native-select";
import { FormField } from "@/components/dashboard/form-field";
import type { AddStaffFormState } from "@/lib/staff/actions";

const initialState: AddStaffFormState = {};

export function AddStaffForm({
  action,
  canGrantOwner,
}: {
  action: (
    prevState: AddStaffFormState,
    formData: FormData,
  ) => Promise<AddStaffFormState>;
  canGrantOwner: boolean;
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

      <FormField
        id="email"
        label="Email"
        errors={errors.email}
        hint="They must already have a Tableside account — ask them to sign up first if they don't."
      >
        <Input
          id="email"
          name="email"
          type="email"
          required
          disabled={isPending}
        />
      </FormField>

      <FormField id="role" label="Role" errors={errors.role}>
        <NativeSelect
          id="role"
          name="role"
          required
          disabled={isPending}
          defaultValue="staff"
        >
          <option value="staff">Staff</option>
          <option value="kitchen">Kitchen</option>
          <option value="manager">Manager</option>
          {canGrantOwner && <option value="owner">Owner</option>}
        </NativeSelect>
      </FormField>

      <Button type="submit" disabled={isPending} className="mt-2 self-start">
        {isPending ? "Adding…" : "Add member"}
      </Button>
    </form>
  );
}
