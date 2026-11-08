"use client";

import { useActionState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { ReviewLinkFormState } from "@/lib/reviews/actions";

const initialState: ReviewLinkFormState = {};

/**
 * The restaurant's Google review link. Blank turns the prompt off.
 */
export function GoogleReviewLinkForm({
  action,
  defaultValue,
  disabled,
}: {
  action: (
    prev: ReviewLinkFormState,
    formData: FormData,
  ) => Promise<ReviewLinkFormState>;
  defaultValue: string | null;
  disabled: boolean;
}) {
  const [state, formAction, isPending] = useActionState(action, initialState);

  return (
    <form action={formAction} className="flex flex-col gap-3" noValidate>
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

      <div className="flex flex-col gap-1.5">
        <label htmlFor="google-review-url" className="text-sm font-medium">
          Google review link
        </label>
        <Input
          id="google-review-url"
          name="url"
          type="url"
          inputMode="url"
          defaultValue={defaultValue ?? ""}
          maxLength={500}
          placeholder="https://g.page/r/…/review"
          disabled={disabled || isPending}
        />
        <p className="type-caption text-muted-foreground">
          In your Google Business Profile, choose &ldquo;Ask for reviews&rdquo;
          and copy the link. Leave it blank to turn the prompt off.
        </p>
      </div>

      {!disabled && (
        <div>
          <Button type="submit" disabled={isPending}>
            {isPending ? "Saving…" : "Save"}
          </Button>
        </div>
      )}
    </form>
  );
}
