"use client";

import { useActionState, useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  DELETE_CONFIRMATION,
  isDeletionConfirmed,
  type DeleteAccountState,
} from "@/lib/account/delete-core";

interface DeleteAccountFormProps {
  action: (
    previous: DeleteAccountState,
    formData: FormData,
  ) => Promise<DeleteAccountState>;
}

const initialState: DeleteAccountState = {};

/**
 * The last step of deleting an account: type DELETE, then press the
 * button. The button stays disabled until the word is typed exactly, and
 * the server checks it again (src/lib/account/actions.ts).
 */
export function DeleteAccountForm({ action }: DeleteAccountFormProps) {
  const [state, formAction, isPending] = useActionState(action, initialState);
  const [confirmation, setConfirmation] = useState("");
  const confirmed = isDeletionConfirmed(confirmation);

  return (
    <form action={formAction} className="flex flex-col gap-4">
      {state.error && (
        <Alert variant="destructive">
          <AlertDescription>{state.error}</AlertDescription>
        </Alert>
      )}
      <div className="flex flex-col gap-2">
        <Label htmlFor="delete-confirmation">
          Type {DELETE_CONFIRMATION} to confirm
        </Label>
        <Input
          id="delete-confirmation"
          name="confirmation"
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck={false}
          value={confirmation}
          onChange={(event) => setConfirmation(event.target.value)}
          disabled={isPending}
        />
      </div>
      <Button
        type="submit"
        variant="destructive"
        disabled={!confirmed || isPending}
        className="self-start"
      >
        {isPending ? "Deleting your account…" : "Delete my account"}
      </Button>
    </form>
  );
}
