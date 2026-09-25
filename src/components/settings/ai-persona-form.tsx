"use client";

import { useActionState, useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { FormField } from "@/components/dashboard/form-field";
import {
  AI_INSTRUCTIONS_MAX_LENGTH,
  AI_TONE_OPTIONS,
  tidyAiInstructions,
  type AiTone,
} from "@/lib/ai/persona";
import type { SettingsFormState } from "@/lib/settings/actions";

const initialState: SettingsFormState = {};

/**
 * How the AI waiter sounds (phase D).
 *
 * The copy under the note field does two jobs and both are load-bearing.
 * It tells the owner what the note CAN'T do, so nobody writes "always say
 * the lamb is halal" believing it will work — it won't, and the waiter
 * will keep saying the menu doesn't specify. And it tells them the note is
 * not private, because it isn't: prompt text can be coaxed out of any model
 * by a determined diner.
 */
export function AiPersonaForm({
  action,
  defaultValues,
  disabled,
}: {
  action: (
    prevState: SettingsFormState,
    formData: FormData,
  ) => Promise<SettingsFormState>;
  defaultValues: { tone: AiTone; instructions: string | null };
  disabled?: boolean;
}) {
  const [state, formAction, isPending] = useActionState(action, initialState);
  const [note, setNote] = useState(defaultValues.instructions ?? "");
  const errors = state.fieldErrors ?? {};
  const readOnly = disabled || isPending;

  // Counted after normalisation, so the number matches what will be saved
  // — pasted line breaks and doubled spaces don't eat into the limit.
  const used = tidyAiInstructions(note)?.length ?? 0;
  const over = used > AI_INSTRUCTIONS_MAX_LENGTH;

  return (
    <form action={formAction} className="flex flex-col gap-5" noValidate>
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

      <fieldset className="flex flex-col gap-2" disabled={readOnly}>
        <legend className="mb-2 text-sm font-medium">Tone</legend>
        {AI_TONE_OPTIONS.map((option) => (
          <label
            key={option.value}
            htmlFor={`tone-${option.value}`}
            className="has-[:checked]:border-primary has-[:checked]:bg-muted/50 flex cursor-pointer items-start gap-3 rounded-lg border px-3 py-2.5"
          >
            <input
              type="radio"
              id={`tone-${option.value}`}
              name="tone"
              value={option.value}
              defaultChecked={defaultValues.tone === option.value}
              className="mt-1"
            />
            <span className="flex flex-col gap-0.5">
              <span className="font-medium">{option.label}</span>
              <span className="type-caption text-muted-foreground">
                {option.description}
              </span>
            </span>
          </label>
        ))}
        {errors.tone && (
          <p className="text-destructive text-sm">{errors.tone[0]}</p>
        )}
      </fieldset>

      <FormField
        id="instructions"
        label="Anything else about how it should sound? (optional)"
        errors={errors.instructions}
        hint="Style only — for example “greet people with Namaste” or “call the thalis our house specials”. It can't change prices, menu facts, allergen or halal answers, or what the waiter is allowed to do; those always come from your menu. Don't write anything you wouldn't want a customer to read."
      >
        <Textarea
          id="instructions"
          name="instructions"
          rows={3}
          value={note}
          onChange={(event) => setNote(event.target.value)}
          disabled={readOnly}
          aria-describedby="instructions-count"
          placeholder="e.g. Greet people with Namaste, and mention that our chai is made fresh."
        />
      </FormField>
      <p
        id="instructions-count"
        className={
          over
            ? "text-destructive -mt-3 text-xs"
            : "text-muted-foreground -mt-3 text-xs"
        }
      >
        {used} / {AI_INSTRUCTIONS_MAX_LENGTH}
      </p>

      {!disabled && (
        <Button
          type="submit"
          disabled={isPending || over}
          className="self-start"
        >
          {isPending ? "Saving…" : "Save"}
        </Button>
      )}
    </form>
  );
}
