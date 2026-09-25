"use client";

import { useActionState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/dashboard/native-select";
import { FormField } from "@/components/dashboard/form-field";
import { CopyUrlButton } from "@/components/tables/copy-url-button";
import type { CreateInvitationState } from "@/lib/staff/invitation-actions";
import { roleDescription, roleLabel } from "@/lib/staff/invitations-core";

const initialState: CreateInvitationState = {};

/**
 * Two states in one component, and the second one matters more.
 *
 * Only the sha256 of an invitation token is stored, so the link exists in
 * exactly one place: this response. Navigating away loses it for good. The
 * result panel therefore leads with the link and says plainly that it will
 * not be shown again — the alternative, discovering it later, means an
 * owner who sent nothing and a new hire waiting on a message.
 */
export function InviteLinkForm({
  action,
  canInviteOwner,
}: {
  action: (
    prevState: CreateInvitationState,
    formData: FormData,
  ) => Promise<CreateInvitationState>;
  canInviteOwner: boolean;
}) {
  const [state, formAction, isPending] = useActionState(action, initialState);
  const errors = state.fieldErrors ?? {};

  if (state.inviteUrl) {
    return (
      <div className="flex flex-col gap-4">
        <div>
          <p className="font-medium">
            Invitation link for a {roleLabel(state.invitedRole ?? null)}
          </p>
          <p className="text-muted-foreground text-sm">
            Send it however you normally talk to your staff. It works once, and
            expires in seven days.
          </p>
        </div>

        <p className="bg-muted rounded-md border p-3 font-mono text-xs break-all">
          {state.inviteUrl}
        </p>

        <div className="flex flex-wrap items-center gap-2">
          <CopyUrlButton url={state.inviteUrl} label="Copy link" />
          {/* A full reload, so the action state is genuinely discarded
              rather than kept alive behind a client-side transition. */}
          <a
            href="/dashboard/staff/invite"
            className="text-muted-foreground text-sm underline-offset-4 hover:underline"
          >
            Create another link
          </a>
        </div>

        <Alert>
          <AlertDescription>
            Copy it now — this is the only time it&apos;s shown. We store only a
            fingerprint of the link, so we can&apos;t show it to you again. If
            you lose it, cancel it on the staff page and make a new one.
          </AlertDescription>
        </Alert>
      </div>
    );
  }

  return (
    <form action={formAction} className="flex flex-col gap-5" noValidate>
      {state.error && (
        <Alert variant="destructive">
          <AlertDescription>{state.error}</AlertDescription>
        </Alert>
      )}

      <FormField
        id="role"
        label="Role"
        errors={errors.role}
        hint="Fixed when the link is made — whoever follows it gets exactly this."
      >
        <NativeSelect
          id="role"
          name="role"
          required
          disabled={isPending}
          defaultValue="staff"
        >
          <option value="staff">Staff — {roleDescription("staff")}</option>
          <option value="kitchen">
            Kitchen — {roleDescription("kitchen")}
          </option>
          <option value="manager">
            Manager — {roleDescription("manager")}
          </option>
          {canInviteOwner && (
            <option value="owner">Owner — {roleDescription("owner")}</option>
          )}
        </NativeSelect>
      </FormField>

      <FormField
        id="label"
        label="Who's this for? (optional)"
        errors={errors.label}
        hint="Just a note for you, so you can tell your pending links apart. They never see it."
      >
        <Input
          id="label"
          name="label"
          maxLength={60}
          disabled={isPending}
          placeholder="e.g. Priya, starts Monday"
        />
      </FormField>

      <Button type="submit" disabled={isPending} className="mt-2 self-start">
        {isPending ? "Creating link…" : "Create link"}
      </Button>
    </form>
  );
}
