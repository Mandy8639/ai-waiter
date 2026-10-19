"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { suggestDetailsBatch } from "@/lib/menu-import/suggest-actions";

/**
 * "Fill in dish details with AI": descriptions, prep times, portion notes,
 * spice levels, ingredients and suggested allergens for every dish without
 * a description, in batches of 25 until done. Until 2026-10-18 there was
 * no button for this at all; Nashta's details came from a one-off script.
 * Everything it writes is a draft: text is marked "Draft text", spice
 * waits in Review spice, and allergens stay hidden from diners until
 * confirmed dish by dish (docs/menu-import.md).
 */
export function DishDetailsCard({
  restaurantId,
  missing,
}: {
  restaurantId: string;
  /** Dishes with no description, counted by the page. */
  missing: number;
}) {
  const [pending, start] = useTransition();
  const [done, setDone] = useState(0);
  const [result, setResult] = useState<{
    details: number;
    allergens: number;
    error?: string;
    finished: boolean;
  } | null>(null);

  if (missing === 0 && !result) return null;

  function run() {
    setResult(null);
    setDone(0);
    start(async () => {
      let afterId: string | null = null;
      let details = 0;
      let allergens = 0;
      let seen = 0;
      // Bounded: even a huge menu ends, and a model that keeps failing
      // stops after a few tries rather than spinning.
      for (let round = 0; round < 40; round += 1) {
        const batch = await suggestDetailsBatch(restaurantId, afterId);
        if (batch.error) {
          setResult({
            details,
            allergens,
            error: batch.error,
            finished: false,
          });
          return;
        }
        seen += batch.dishes;
        details += batch.detailsWritten;
        allergens += batch.allergensSuggested;
        setDone(seen);
        if (batch.done || !batch.lastId) break;
        afterId = batch.lastId;
      }
      setResult({ details, allergens, finished: true });
    });
  }

  return (
    <section className="bg-ai-soft/40 flex flex-col gap-3 rounded-xl border p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="max-w-xl">
          <h2 className="flex items-center gap-2 font-medium">
            <Sparkles className="size-4" aria-hidden="true" />
            Fill in dish details with AI
          </h2>
          <p className="text-muted-foreground text-sm">
            {missing > 0
              ? `${missing} ${missing === 1 ? "dish has" : "dishes have"} no description. `
              : ""}
            Drafts a short description, prep time, spice level, ingredients and
            likely allergens for each. Allergens stay hidden from diners until
            you confirm them, dish by dish.
          </p>
        </div>
        <Button type="button" onClick={run} disabled={pending || missing === 0}>
          {pending ? `Working… ${done} of ${missing}` : "Fill in details"}
        </Button>
      </div>
      {pending && (
        <p className="text-muted-foreground text-sm" role="status">
          This takes about half a minute per 25 dishes. You can leave this page
          open and carry on.
        </p>
      )}
      {result && (
        <div role="status" className="flex flex-col gap-2 text-sm">
          {result.error ? (
            <p className="text-destructive">
              {result.error}{" "}
              {result.details > 0 &&
                `${result.details} dishes were filled in before that. Press again to continue.`}
            </p>
          ) : (
            <p>
              Done: drafted details for {result.details}{" "}
              {result.details === 1 ? "dish" : "dishes"}. Check the ones marked
              &ldquo;Draft text&rdquo;.
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            {result.allergens > 0 && (
              <Link
                href="/dashboard/menu/allergen-review"
                className="underline underline-offset-4"
              >
                Confirm {result.allergens} suggested allergens
              </Link>
            )}
            <Link
              href="/dashboard/menu/spice-review"
              className="underline underline-offset-4"
            >
              Review spice levels
            </Link>
          </div>
        </div>
      )}
    </section>
  );
}
