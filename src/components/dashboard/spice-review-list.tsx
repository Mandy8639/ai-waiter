"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { setSpiceLevelForItem } from "@/lib/menu-import/suggest-actions";
import type { SpiceLevel } from "@/lib/menu-import/suggestions";

export interface DraftSpiceItem {
  menuItemId: string;
  itemName: string;
  /** What the import guessed. Starts selected; the reviewer may change it. */
  suggested: SpiceLevel;
}

const LABELS: Record<SpiceLevel, string> = {
  none: "Not spicy",
  mild: "Mild",
  medium: "Medium",
  hot: "Hot",
  very_hot: "Very hot",
};

const ORDER: SpiceLevel[] = ["none", "mild", "medium", "hot", "very_hot"];

/**
 * Confirm or correct the heat level guessed for each dish.
 *
 * The guess arrives pre-selected, which is the whole point: for most
 * dishes it is right, and the reviewer's job is one glance and one click
 * rather than a decision from scratch. Where it is wrong they pick the
 * right one and save the same way — confirming and correcting are the
 * same gesture, so there is no reason to skip the ones that look fine.
 *
 * Unlike the allergen list this one may safely have a per-item Save with
 * the answer already filled in, because the failure mode differs: a
 * carelessly confirmed allergen tells a diner with an allergy that the
 * restaurant checked, while a carelessly confirmed heat level tells them
 * a dish is medium. The first is dangerous, the second is a menu that is
 * slightly wrong.
 */
export function SpiceReviewList({
  restaurantId,
  items,
}: {
  restaurantId: string;
  items: DraftSpiceItem[];
}) {
  const [pending, setPending] = useState(items);
  const [chosen, setChosen] = useState<Record<string, SpiceLevel>>(() =>
    Object.fromEntries(items.map((i) => [i.menuItemId, i.suggested])),
  );
  const [busy, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);

  function save(item: DraftSpiceItem) {
    startTransition(async () => {
      const result = await setSpiceLevelForItem(
        restaurantId,
        item.menuItemId,
        chosen[item.menuItemId] ?? item.suggested,
      );
      if (result.error) {
        setMessage(result.error);
        return;
      }
      setPending((current) =>
        current.filter((i) => i.menuItemId !== item.menuItemId),
      );
      setMessage(null);
    });
  }

  if (pending.length === 0) {
    return (
      <p className="text-muted-foreground text-sm">
        Every dish&apos;s spice level has been reviewed.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {message && (
        <Alert variant="destructive">
          <AlertDescription>{message}</AlertDescription>
        </Alert>
      )}

      {pending.map((item) => (
        <div
          key={item.menuItemId}
          className="flex flex-col gap-3 rounded-lg border p-4"
        >
          <h2 className="text-sm font-medium">{item.itemName}</h2>

          <fieldset className="flex flex-col gap-2">
            <legend className="text-muted-foreground mb-2 text-sm">
              How hot is it?
            </legend>
            <div className="flex flex-wrap gap-x-4 gap-y-2">
              {ORDER.map((level) => (
                <div key={level} className="flex items-center gap-2">
                  <input
                    type="radio"
                    id={`${item.menuItemId}-${level}`}
                    name={`spice-${item.menuItemId}`}
                    className="size-4"
                    checked={
                      (chosen[item.menuItemId] ?? item.suggested) === level
                    }
                    disabled={busy}
                    onChange={() =>
                      setChosen((c) => ({ ...c, [item.menuItemId]: level }))
                    }
                  />
                  <label
                    htmlFor={`${item.menuItemId}-${level}`}
                    className="text-sm"
                  >
                    {LABELS[level]}
                    {/*
                      Says which one was guessed, in words rather than by
                      colour alone (SC 1.4.1), so a reviewer can tell their
                      own correction from the suggestion they started with.
                    */}
                    {level === item.suggested && (
                      <span className="text-muted-foreground">
                        {" "}
                        — suggested
                      </span>
                    )}
                  </label>
                </div>
              ))}
            </div>
          </fieldset>

          <div>
            <Button size="sm" disabled={busy} onClick={() => save(item)}>
              {(chosen[item.menuItemId] ?? item.suggested) === item.suggested
                ? "Confirm"
                : "Save change"}
            </Button>
          </div>
        </div>
      ))}
    </div>
  );
}
