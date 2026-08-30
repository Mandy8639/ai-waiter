"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { KitchenOrder } from "@/lib/orders/kitchen";

/**
 * v1 split UI: exactly two tickets. Every item starts in Ticket 1; toggling
 * a checkbox moves it to Ticket 2. This covers the common real case
 * (course timing — "appetizers now, mains later") without the added
 * complexity of an arbitrary N-way grouping UI; split_order_into_tickets()
 * itself supports any number of groups, so a richer UI could be added
 * later without a backend change.
 */
export function SplitOrderDialog({
  order,
  open,
  onOpenChange,
  onSplit,
}: {
  order: KitchenOrder | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSplit: (
    orderId: string,
    groups: { label?: string; itemIds: string[] }[],
  ) => Promise<{ error?: string }>;
}) {
  const [secondTicketItemIds, setSecondTicketItemIds] = useState<Set<string>>(
    new Set(),
  );
  const [labelOne, setLabelOne] = useState("");
  const [labelTwo, setLabelTwo] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function reset() {
    setSecondTicketItemIds(new Set());
    setLabelOne("");
    setLabelTwo("");
    setError(null);
  }

  function toggleItem(itemId: string) {
    setSecondTicketItemIds((prev) => {
      const next = new Set(prev);
      if (next.has(itemId)) next.delete(itemId);
      else next.add(itemId);
      return next;
    });
  }

  function handleSubmit() {
    if (!order) return;
    setError(null);

    const firstTicketItemIds = order.items
      .map((i) => i.id)
      .filter((id) => !secondTicketItemIds.has(id));

    if (firstTicketItemIds.length === 0 || secondTicketItemIds.size === 0) {
      setError("Both tickets need at least one item.");
      return;
    }

    startTransition(async () => {
      const result = await onSplit(order.id, [
        { label: labelOne || undefined, itemIds: firstTicketItemIds },
        { label: labelTwo || undefined, itemIds: [...secondTicketItemIds] },
      ]);
      if (result.error) {
        setError(result.error);
      } else {
        reset();
        onOpenChange(false);
      }
    });
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) reset();
        onOpenChange(next);
      }}
    >
      <DialogContent>
        {order && (
          <>
            <DialogHeader>
              <DialogTitle>Split order #{order.orderNumber}</DialogTitle>
            </DialogHeader>

            <div className="flex flex-col gap-4 text-sm">
              <p className="text-muted-foreground text-xs">
                Check the items that should fire on a second ticket — the rest
                stay on the first. Each ticket gets its own status from here on.
              </p>

              <div className="flex flex-col gap-1.5">
                <Label htmlFor="split-label-one">
                  Ticket 1 label (optional)
                </Label>
                <Input
                  id="split-label-one"
                  value={labelOne}
                  onChange={(e) => setLabelOne(e.target.value)}
                  placeholder="e.g. Appetizers"
                  disabled={isPending}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="split-label-two">
                  Ticket 2 label (optional)
                </Label>
                <Input
                  id="split-label-two"
                  value={labelTwo}
                  onChange={(e) => setLabelTwo(e.target.value)}
                  placeholder="e.g. Mains"
                  disabled={isPending}
                />
              </div>

              <div className="flex flex-col gap-2">
                {order.items.map((item) => (
                  <label
                    key={item.id}
                    className="flex items-center gap-2 rounded-md border p-2"
                  >
                    <Checkbox
                      checked={secondTicketItemIds.has(item.id)}
                      onCheckedChange={() => toggleItem(item.id)}
                      disabled={isPending}
                    />
                    <span>
                      {item.quantity}× {item.itemName}
                    </span>
                    <span className="text-muted-foreground ml-auto text-xs">
                      {secondTicketItemIds.has(item.id)
                        ? "Ticket 2"
                        : "Ticket 1"}
                    </span>
                  </label>
                ))}
              </div>

              {error && <p className="text-destructive text-xs">{error}</p>}
            </div>

            <DialogFooter>
              <Button type="button" disabled={isPending} onClick={handleSubmit}>
                {isPending ? "Splitting…" : "Split into two tickets"}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
