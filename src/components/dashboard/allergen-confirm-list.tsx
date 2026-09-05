"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { confirmAllergensForItem } from "@/lib/menu-import/suggest-actions";

export interface PendingItem {
  menuItemId: string;
  itemName: string;
  /** The whole vocabulary. `suggested` only decides what starts ticked. */
  options: { name: string; suggested: boolean }[];
}

/**
 * Per-item allergen confirmation.
 *
 * There is deliberately NO "confirm all" button, and there should never be
 * one. The realistic failure here is not a bad model — it is a tired owner
 * clearing 150 items at 11pm. If confirming an allergen is as cheap as one
 * click for the whole menu, the confirmation records nothing except that
 * somebody wanted the banner to go away, while a diner with an allergy is
 * told the restaurant checked.
 *
 * So each dish is confirmed on its own, and the unticked suggestions are
 * discarded rather than left pending — see confirm_menu_item_allergens().
 */
export function AllergenConfirmList({
  restaurantId,
  items,
}: {
  restaurantId: string;
  items: PendingItem[];
}) {
  const [pending, setPending] = useState(items);
  const [ticked, setTicked] = useState<Record<string, Set<string>>>(() =>
    Object.fromEntries(
      items.map((i) => [
        i.menuItemId,
        new Set(i.options.filter((o) => o.suggested).map((o) => o.name)),
      ]),
    ),
  );
  const [busy, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);

  function toggle(menuItemId: string, name: string) {
    setTicked((current) => {
      const next = new Set(current[menuItemId] ?? []);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return { ...current, [menuItemId]: next };
    });
  }

  function confirm(item: PendingItem) {
    startTransition(async () => {
      const result = await confirmAllergensForItem(
        restaurantId,
        item.menuItemId,
        [...(ticked[item.menuItemId] ?? [])],
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
      <Alert>
        <AlertDescription>
          Nothing waiting. Diners are only ever shown allergens someone here has
          confirmed.
        </AlertDescription>
      </Alert>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <Alert>
        <AlertDescription>
          These are <strong>suggestions</strong>, worked out from the dish name.
          Until you confirm a dish, the AI waiter tells diners the menu
          doesn&apos;t specify its allergens — which is the safe answer. Untick
          anything that isn&apos;t right.
        </AlertDescription>
      </Alert>

      {message && (
        <Alert variant="destructive">
          <AlertDescription>{message}</AlertDescription>
        </Alert>
      )}

      <p className="text-muted-foreground text-sm">
        {pending.length} dish{pending.length === 1 ? "" : "es"} to check.
      </p>

      <ul className="flex flex-col gap-2">
        {pending.map((item) => (
          <li
            key={item.menuItemId}
            className="flex flex-col gap-2 rounded-md border p-3"
          >
            <p className="text-sm font-medium">{item.itemName}</p>
            <div className="flex flex-wrap gap-x-4 gap-y-2">
              {item.options.map((option) => {
                const isTicked =
                  ticked[item.menuItemId]?.has(option.name) ?? false;
                return (
                  <label
                    key={option.name}
                    className="flex items-center gap-1.5 text-sm"
                  >
                    <input
                      type="checkbox"
                      className="accent-primary size-4"
                      checked={isTicked}
                      onChange={() => toggle(item.menuItemId, option.name)}
                    />
                    <span className={isTicked ? "font-medium" : undefined}>
                      {option.name}
                    </span>
                    {/*
                      Marks what the model proposed, so a reviewer can tell
                      its guesses from their own additions. Text, not
                      styling alone.
                    */}
                    {option.suggested && (
                      <span className="text-muted-foreground text-xs">
                        (suggested)
                      </span>
                    )}
                  </label>
                );
              })}
            </div>
            <div>
              <Button
                type="button"
                size="sm"
                disabled={busy}
                onClick={() => confirm(item)}
              >
                Confirm for {item.itemName}
              </Button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
