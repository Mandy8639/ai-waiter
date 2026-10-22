"use client";

import { useState } from "react";
import { Minus, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { formatMoney } from "@/lib/orders/format";
import {
  groupProblem,
  makeLine,
  toggleOption,
  type PosDish,
  type TicketLine,
} from "@/lib/pos/pos-core";

/**
 * Choosing a dish's add-ons, quantity and a note before it goes on the
 * ticket. Opened for any dish with add-on groups, and for "Note" on a
 * dish without them. Keyed by the parent on the dish, so each opening
 * starts clean.
 */
export function DishOptionsDialog({
  dish,
  currency,
  onAdd,
  onClose,
}: {
  dish: PosDish | null;
  currency: string;
  onAdd: (line: TicketLine) => void;
  onClose: () => void;
}) {
  const [selected, setSelected] = useState<string[]>([]);
  const [quantity, setQuantity] = useState(1);
  const [notes, setNotes] = useState("");

  const problems = dish
    ? dish.groups
        .map((g) => groupProblem(g, selected))
        .filter((p): p is string => p !== null)
    : [];
  const preview = dish ? makeLine(dish, selected, notes, quantity) : null;

  return (
    <Dialog
      open={dish !== null}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      {dish && preview && (
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{dish.name}</DialogTitle>
            <DialogDescription>
              {formatMoney(dish.price, currency)}
            </DialogDescription>
          </DialogHeader>

          {dish.groups.map((group) => {
            const problem = groupProblem(group, selected);
            return (
              <fieldset key={group.id} className="flex flex-col gap-2">
                <legend className="mb-1 flex w-full items-baseline justify-between gap-2 text-sm font-medium">
                  <span>{group.name}</span>
                  <span
                    className={cn(
                      "text-xs font-normal",
                      problem ? "text-destructive" : "text-muted-foreground",
                    )}
                  >
                    {problem ??
                      (group.max === 1 ? "Pick one" : `Up to ${group.max}`)}
                  </span>
                </legend>
                <div className="grid grid-cols-2 gap-2">
                  {group.options.map((option) => {
                    const on = selected.includes(option.id);
                    return (
                      <button
                        key={option.id}
                        type="button"
                        disabled={!option.available}
                        aria-pressed={on}
                        onClick={() =>
                          setSelected((prev) =>
                            toggleOption(group, prev, option.id),
                          )
                        }
                        className={cn(
                          "flex min-h-11 items-center justify-between gap-2 rounded-lg border px-3 py-2 text-left text-sm transition-colors",
                          on
                            ? "border-primary bg-primary/10 font-medium"
                            : "hover:bg-muted",
                          !option.available && "opacity-50",
                        )}
                      >
                        <span>
                          {option.name}
                          {!option.available && " (sold out)"}
                        </span>
                        {option.price !== 0 && (
                          <span className="text-muted-foreground tabular-nums">
                            +{formatMoney(option.price, currency)}
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>
              </fieldset>
            );
          })}

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="pos-line-note">Note for the kitchen</Label>
            <Input
              id="pos-line-note"
              value={notes}
              maxLength={200}
              placeholder="No onions, extra spicy…"
              onChange={(e) => setNotes(e.target.value)}
            />
          </div>

          <DialogFooter className="flex-row items-center justify-between gap-3 sm:justify-between">
            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="outline"
                size="icon-lg"
                aria-label="One fewer"
                disabled={quantity <= 1}
                onClick={() => setQuantity((q) => Math.max(1, q - 1))}
              >
                <Minus aria-hidden="true" />
              </Button>
              <span className="w-8 text-center font-medium tabular-nums">
                {quantity}
              </span>
              <Button
                type="button"
                variant="outline"
                size="icon-lg"
                aria-label="One more"
                disabled={quantity >= 99}
                onClick={() => setQuantity((q) => Math.min(99, q + 1))}
              >
                <Plus aria-hidden="true" />
              </Button>
            </div>
            <Button
              type="button"
              size="lg"
              disabled={problems.length > 0}
              onClick={() => onAdd(preview)}
            >
              Add · {formatMoney(preview.unitPrice * quantity, currency)}
            </Button>
          </DialogFooter>
        </DialogContent>
      )}
    </Dialog>
  );
}
