"use client";

import { useState } from "react";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { KitchenOrder, KitchenTicketGroup } from "@/lib/orders/kitchen";
import {
  canCancel,
  nextActionFor,
  STATUS_LABELS,
  type OrderStatus,
} from "@/lib/orders/status";
import { useElapsedLabel } from "./use-elapsed-label";

type Role = "owner" | "manager" | "kitchen" | "staff";

/** owner/manager/kitchen can split/merge (matches role_can_transition_order's own kitchen-workflow roles); staff cannot — see docs/security.md#order-splitting-and-merging. */
const CAN_ORGANIZE_TICKETS: Role[] = ["owner", "manager", "kitchen"];

function TicketGroupRow({
  group,
  order,
  role,
  isPending,
  onTransition,
}: {
  group: KitchenTicketGroup;
  order: KitchenOrder;
  role: Role;
  isPending: boolean;
  onTransition: (ticketGroupId: string, target: OrderStatus) => void;
}) {
  const action = nextActionFor(role, group.status);
  const items = order.items.filter((i) => i.ticketGroupId === group.id);

  return (
    <div className="flex flex-col gap-1.5 rounded-md border p-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium">{group.label || "Ticket"}</span>
        <Badge variant="outline">{STATUS_LABELS[group.status]}</Badge>
      </div>
      <ul className="flex flex-col gap-1 text-sm">
        {items.map((item) => (
          <li key={item.id}>
            <span className="font-medium">
              {item.quantity}× {item.itemName}
            </span>
            {item.modifiers.length > 0 && (
              <span className="text-muted-foreground block text-xs">
                {item.modifiers.map((m) => m.optionName).join(", ")}
              </span>
            )}
          </li>
        ))}
      </ul>
      {action && (
        <Button
          type="button"
          size="sm"
          disabled={isPending}
          onClick={() => onTransition(group.id, action.targetStatus)}
        >
          {isPending ? "Updating…" : action.label}
        </Button>
      )}
    </div>
  );
}

export function OrderCard({
  order,
  role,
  isPending,
  onTransition,
  onCancel,
  onOpenDetail,
  onGroupTransition,
  onOpenSplit,
  onOpenMerge,
  orderNumberById,
}: {
  order: KitchenOrder;
  role: Role;
  isPending: boolean;
  onTransition: (orderId: string, target: OrderStatus) => void;
  onCancel: (orderId: string) => void;
  onOpenDetail: (order: KitchenOrder) => void;
  onGroupTransition: (ticketGroupId: string, target: OrderStatus) => void;
  onOpenSplit: (order: KitchenOrder) => void;
  onOpenMerge: (order: KitchenOrder) => void;
  /** Other orders' ids -> their customer-facing order numbers, for the "Merged ticket" line below. */
  orderNumberById: Map<string, number>;
}) {
  const elapsed = useElapsedLabel(order.createdAt);
  const action = nextActionFor(role, order.status);
  const cancellable = canCancel(role, order.status);
  const [cancelOpen, setCancelOpen] = useState(false);

  const isSplitOrMerged = order.ticketGroups.length > 0;
  const canOrganize = CAN_ORGANIZE_TICKETS.includes(role);

  return (
    <div
      data-order-number={order.orderNumber}
      className="bg-card flex flex-col gap-3 rounded-lg border p-3 shadow-sm"
    >
      <button
        type="button"
        onClick={() => onOpenDetail(order)}
        className="flex items-start justify-between gap-2 text-left"
      >
        <div>
          <p className="text-lg font-semibold tabular-nums">
            #{order.orderNumber}
          </p>
          <p className="text-muted-foreground text-sm">{order.tableLabel}</p>
        </div>
        <div className="flex flex-col items-end gap-1">
          {order.status === "pending" && (
            <Badge variant="destructive">New</Badge>
          )}
          <span
            className="text-muted-foreground text-xs"
            aria-label="Time since order was placed"
          >
            {elapsed}
          </span>
        </div>
      </button>

      {order.mergedWithOrderIds.length > 0 && (
        <p className="text-muted-foreground text-xs">
          Merged ticket — moves with order
          {order.mergedWithOrderIds.length > 1 ? "s" : ""} #
          {order.mergedWithOrderIds
            .map((id) => orderNumberById.get(id) ?? "?")
            .join(", #")}
        </p>
      )}

      {isSplitOrMerged ? (
        <div className="flex flex-col gap-2">
          {order.ticketGroups.map((group) => (
            <TicketGroupRow
              key={group.id}
              group={group}
              order={order}
              role={role}
              isPending={isPending}
              onTransition={onGroupTransition}
            />
          ))}
        </div>
      ) : (
        <ul className="flex flex-col gap-1.5 text-sm">
          {order.items.map((item) => (
            <li key={item.id}>
              <span className="font-medium">
                {item.quantity}× {item.itemName}
              </span>
              {item.modifiers.length > 0 && (
                <span className="text-muted-foreground block text-xs">
                  {item.modifiers.map((m) => m.optionName).join(", ")}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}

      {order.customerNote && (
        <p className="bg-muted rounded-md p-2 text-xs">
          <span className="font-medium">Note: </span>
          {order.customerNote}
        </p>
      )}

      <div className="mt-auto flex flex-wrap items-center gap-2">
        {!isSplitOrMerged && action && (
          <Button
            type="button"
            className="flex-1"
            disabled={isPending}
            onClick={() => onTransition(order.id, action.targetStatus)}
          >
            {isPending ? "Updating…" : action.label}
          </Button>
        )}
        {cancellable && (
          <AlertDialog open={cancelOpen} onOpenChange={setCancelOpen}>
            <AlertDialogTrigger
              render={
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={isPending}
                >
                  Cancel
                </Button>
              }
            />
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>
                  Cancel order #{order.orderNumber}?
                </AlertDialogTitle>
                <AlertDialogDescription>
                  This tells the customer their order was cancelled. This
                  can&apos;t be undone.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Keep order</AlertDialogCancel>
                <Button
                  type="button"
                  variant="destructive"
                  disabled={isPending}
                  onClick={() => {
                    onCancel(order.id);
                    setCancelOpen(false);
                  }}
                >
                  {isPending ? "Cancelling…" : "Cancel order"}
                </Button>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        )}
        {!isSplitOrMerged && canOrganize && order.items.length >= 2 && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={isPending}
            onClick={() => onOpenSplit(order)}
          >
            Split
          </Button>
        )}
        {!isSplitOrMerged && canOrganize && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={isPending}
            onClick={() => onOpenMerge(order)}
          >
            Merge
          </Button>
        )}
      </div>
    </div>
  );
}
