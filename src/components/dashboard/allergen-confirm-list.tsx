"use client";

import { useEffect, useState, useTransition } from "react";
import { Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { confirmAllergensForItem } from "@/lib/menu-import/suggest-actions";
import { confirmReviewedAllergens } from "@/lib/review/actions";
import {
  allergenSignature,
  namesFromSignature,
  readStored,
  restoreMarks,
  storageKey,
  writeStored,
  type ReviewedMarks,
} from "@/lib/review/reviewed-core";

export interface PendingItem {
  menuItemId: string;
  itemName: string;
  /** The whole vocabulary. `suggested` only decides what starts ticked. */
  options: { name: string; suggested: boolean }[];
}

/**
 * Allergen confirmation: reviewed dish by dish, then confirmed together.
 *
 * The failure this screen guards against is not a bad model. It is a tired
 * owner clearing 150 items at 11pm. A "confirm everything" button would
 * record nothing except that somebody wanted the banner gone, while a diner
 * with an allergy is told the restaurant checked. So there is still no
 * such button. Each dish gets its own **Reviewed** mark, which freezes its
 * ticks, and "Confirm all reviewed" confirms only the marked dishes, with
 * exactly the ticks that were reviewed. A dish nobody marked stays waiting.
 * The per-dish "Confirm now" remains for confirming one at once.
 *
 * Unticked suggestions are discarded rather than left pending, so the same
 * question isn't asked forever — see confirm_menu_item_allergens().
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
  const [marks, setMarks] = useState<ReviewedMarks>({});
  const [busy, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);
  const key = storageKey("allergens", restaurantId);

  // A long review survives a reload: marks (and the ticks they froze) are
  // read back after mount, for dishes that are still waiting.
  useEffect(() => {
    const waiting = new Set(items.map((i) => i.menuItemId));
    const restored = restoreMarks(readStored(key), (id) => waiting.has(id));
    if (Object.keys(restored).length === 0) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setMarks(restored);
    setTicked((current) => {
      const next = { ...current };
      for (const [id, signature] of Object.entries(restored)) {
        next[id] = new Set(namesFromSignature(signature));
      }
      return next;
    });
  }, [items, key]);

  function updateMarks(next: ReviewedMarks) {
    setMarks(next);
    writeStored(key, next);
  }

  function toggle(menuItemId: string, name: string) {
    if (marks[menuItemId] !== undefined) return;
    setTicked((current) => {
      const next = new Set(current[menuItemId] ?? []);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return { ...current, [menuItemId]: next };
    });
  }

  function toggleReviewed(menuItemId: string) {
    const next = { ...marks };
    if (next[menuItemId] !== undefined) delete next[menuItemId];
    else next[menuItemId] = allergenSignature(ticked[menuItemId] ?? []);
    updateMarks(next);
  }

  function removeConfirmed(ids: string[]) {
    const done = new Set(ids);
    setPending((current) => current.filter((i) => !done.has(i.menuItemId)));
    const next = { ...marks };
    for (const id of ids) delete next[id];
    updateMarks(next);
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
      removeConfirmed([item.menuItemId]);
      setMessage(null);
    });
  }

  const reviewedIds = pending
    .map((i) => i.menuItemId)
    .filter((id) => marks[id] !== undefined);

  function confirmReviewed() {
    startTransition(async () => {
      const result = await confirmReviewedAllergens(
        restaurantId,
        reviewedIds.map((id) => ({
          menuItemId: id,
          allergenNames: namesFromSignature(marks[id]),
        })),
      );
      removeConfirmed(result.confirmedIds);
      setMessage(result.error ?? null);
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
          doesn&apos;t specify its allergens — which is the safe answer. Check
          each dish, untick anything that isn&apos;t right, and mark it{" "}
          <strong>Reviewed</strong>. Then confirm all the reviewed dishes at
          once.
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
        {pending.map((item) => {
          const reviewed = marks[item.menuItemId] !== undefined;
          return (
            <li
              key={item.menuItemId}
              className={
                "flex flex-col gap-2 rounded-md border p-3" +
                (reviewed ? " border-primary/40 bg-primary/5" : "")
              }
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
                        disabled={reviewed}
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
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant={reviewed ? "default" : "outline"}
                  aria-pressed={reviewed}
                  disabled={busy}
                  onClick={() => toggleReviewed(item.menuItemId)}
                >
                  {reviewed && <Check className="size-4" aria-hidden="true" />}
                  {reviewed ? "Reviewed" : "Mark reviewed"}
                </Button>
                {reviewed ? (
                  <span className="text-muted-foreground text-xs">
                    Tap again to change the ticks.
                  </span>
                ) : (
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    disabled={busy}
                    onClick={() => confirm(item)}
                  >
                    Confirm now
                  </Button>
                )}
              </div>
            </li>
          );
        })}
      </ul>

      <ConfirmReviewedBar
        reviewed={reviewedIds.length}
        total={pending.length}
        busy={busy}
        onConfirm={confirmReviewed}
      />
    </div>
  );
}

/** The sticky "N of M reviewed · Confirm N reviewed" bar both review screens share. */
export function ConfirmReviewedBar({
  reviewed,
  total,
  busy,
  onConfirm,
}: {
  reviewed: number;
  total: number;
  busy: boolean;
  onConfirm: () => void;
}) {
  return (
    <div className="bg-background/95 sticky bottom-3 z-10 flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3 shadow-sm backdrop-blur">
      <p className="text-sm" aria-live="polite">
        <span className="font-medium">{reviewed}</span> of {total} reviewed
        {reviewed < total && reviewed > 0 && (
          <span className="text-muted-foreground">
            {" "}
            · the rest stay waiting
          </span>
        )}
      </p>
      <Button
        type="button"
        disabled={busy || reviewed === 0}
        onClick={onConfirm}
      >
        {busy ? "Confirming…" : `Confirm ${reviewed} reviewed — show to diners`}
      </Button>
    </div>
  );
}
