"use client";

import { useActionState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import type { SuggestAllergensState } from "@/lib/menu-graph/actions";

/**
 * "Find likely allergens": asks the menu knowledge graph which dishes'
 * names or listed ingredients point to an allergen not yet marked, and
 * adds those to the list below for review. Nothing is shown to a diner
 * until it's confirmed there.
 */
export function FindAllergensButton({
  action,
}: {
  action: (
    prev: SuggestAllergensState,
    formData: FormData,
  ) => Promise<SuggestAllergensState>;
}) {
  const [state, find, finding] = useActionState(action, {});
  return (
    <form action={find} className="flex flex-col gap-2 rounded-md border p-3">
      <p className="text-sm">
        Tableside can look through your dish names and ingredients for likely
        allergens (paneer and ghee for milk, naan for wheat, cashew for tree
        nuts) and add them below, each with the reason, for you to check.
      </p>
      <Button
        type="submit"
        variant="outline"
        className="self-start"
        disabled={finding}
      >
        {finding ? "Looking…" : "Find likely allergens"}
      </Button>
      {state.error && (
        <Alert variant="destructive">
          <AlertDescription>{state.error}</AlertDescription>
        </Alert>
      )}
      {state.success && (
        <Alert>
          <AlertDescription>{state.success}</AlertDescription>
        </Alert>
      )}
    </form>
  );
}
