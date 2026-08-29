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
 * candidates is pre-filtered by the caller (kitchen-board.tsx) to orders
 * that are actually eligible per merge_orders_into_ticket()'s own rules
 * (same restaurant — implicit, same status, neither already split) — this
 * dialog only handles the picking UI, never re-derives eligibility itself,
 * so there's exactly one place that logic lives.
 */
export function MergeOrderDialog({
  order,
  candidates,
  open,
  onOpenChange,
  onMerge,
}: {
  order: KitchenOrder | null;
  candidates: KitchenOrder[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onMerge: (
    orderIds: string[],
    label: string | null,
  ) => Promise<{ error?: string }>;
}) {
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [label, setLabel] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function reset() {
    setSelectedIds(new Set());
    setLabel("");
    setError(null);
  }

  function toggle(orderId: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(orderId)) next.delete(orderId);
      else next.add(orderId);
      return next;
    });
  }

  function handleSubmit() {
    if (!order) return;
    setError(null);

    if (selectedIds.size === 0) {
      setError("Select at least one other order to merge with.");
      return;
    }

    startTransition(async () => {
      const result = await onMerge(
        [order.id, ...selectedIds],
        label.trim().length > 0 ? label.trim() : null,
      );
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
              <DialogTitle>Merge order #{order.orderNumber}</DialogTitle>
            </DialogHeader>

            <div className="flex flex-col gap-4 text-sm">
              <p className="text-muted-foreground text-xs">
                Combine this order with another table&apos;s into one kitchen
                ticket — each keeps its own bill and order number, but they move
                through prep together from here on.
              </p>

              <div className="flex flex-col gap-1.5">
                <Label htmlFor="merge-label">Ticket label (optional)</Label>
                <Input
                  id="merge-label"
                  value={label}
                  onChange={(e) => setLabel(e.target.value)}
                  placeholder="e.g. Tables 5 + 6"
                  disabled={isPending}
                />
              </div>

              {candidates.length === 0 ? (
                <p className="text-muted-foreground text-xs">
                  No other orders are currently eligible to merge with this one
                  (they need to share the same status, and neither can already
                  be split).
                </p>
              ) : (
                <div className="flex flex-col gap-2">
                  {candidates.map((candidate) => (
                    <label
                      key={candidate.id}
                      className="flex items-center gap-2 rounded-md border p-2"
                    >
                      <Checkbox
                        checked={selectedIds.has(candidate.id)}
                        onCheckedChange={() => toggle(candidate.id)}
                        disabled={isPending}
                      />
                      <span>
                        #{candidate.orderNumber} — {candidate.tableLabel}
                      </span>
                    </label>
                  ))}
                </div>
              )}

              {error && <p className="text-destructive text-xs">{error}</p>}
            </div>

            <DialogFooter>
              <Button
                type="button"
                disabled={isPending || candidates.length === 0}
                onClick={handleSubmit}
              >
                {isPending ? "Merging…" : "Merge tickets"}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
