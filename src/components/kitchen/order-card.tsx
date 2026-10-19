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
import type {
  KitchenOrder,
  KitchenOrderItem,
  KitchenTicketGroup,
} from "@/lib/orders/kitchen";
import {
  canCancel,
  nextActionFor,
  STATUS_LABELS,
  type OrderStatus,
} from "@/lib/orders/status";
import {
  canMarkStationDone,
  stationMayTransition,
  type StationProgress,
} from "@/lib/kitchen/stations-core";
import { useElapsedLabel } from "./use-elapsed-label";
import { startsLater } from "@/lib/pickup/board-core";

const SPICE_WORDS: Record<string, string> = {
  none: "no spice",
  mild: "mild",
  medium: "medium",
  hot: "hot",
  very_hot: "very hot",
};

/**
 * A line the cook has to actually change something for.
 *
 * Rendered louder than the modifier list above it, because it is a
 * different kind of information: a modifier is what was ordered, this is a
 * deviation from how this kitchen normally makes the dish. It carries its
 * meaning in words ("Make it hot") rather than in colour, so it survives a
 * greyscale kitchen printer as well as SC 1.4.1.
 */
function SpecialRequest({
  spicePreference,
  notes,
}: {
  spicePreference: string | null;
  notes: string | null;
}) {
  return (
    <span className="text-foreground mt-1 block text-xs font-medium">
      {spicePreference && (
        <span className="block">
          Make it {SPICE_WORDS[spicePreference] ?? spicePreference}
        </span>
      )}
      {notes && <span className="block">Note: {notes}</span>}
    </span>
  );
}

type Role = "owner" | "manager" | "kitchen" | "staff";

/** owner/manager/kitchen can split/merge (matches role_can_transition_order's own kitchen-workflow roles); staff cannot — see docs/security.md#order-splitting-and-merging. */
const CAN_ORGANIZE_TICKETS: Role[] = ["owner", "manager", "kitchen"];

/** One ordered line. On a station screen, a line with no station says so. */
function LineItem({
  item,
  markUnassigned,
}: {
  item: KitchenOrderItem;
  markUnassigned: boolean;
}) {
  return (
    <li>
      <span className="font-medium">
        {item.quantity}× {item.itemName}
      </span>
      {markUnassigned && item.stationId === null && (
        <span className="text-muted-foreground ml-1.5 text-xs">
          (no station)
        </span>
      )}
      {item.modifiers.length > 0 && (
        <span className="text-muted-foreground block text-xs">
          {item.modifiers.map((m) => m.optionName).join(", ")}
        </span>
      )}
      {(item.spicePreference || item.notes) && (
        <SpecialRequest
          spicePreference={item.spicePreference}
          notes={item.notes}
        />
      )}
    </li>
  );
}

function TicketGroupRow({
  group,
  order,
  role,
  isPending,
  onTransition,
  stationView,
}: {
  group: KitchenTicketGroup;
  order: KitchenOrder;
  role: Role;
  isPending: boolean;
  onTransition: (ticketGroupId: string, target: OrderStatus) => void;
  stationView: boolean;
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
          <LineItem key={item.id} item={item} markUnassigned={stationView} />
        ))}
      </ul>
      {action &&
        (!stationView || stationMayTransition(action.targetStatus)) && (
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
  station,
  progress,
  now,
}: {
  order: KitchenOrder;
  /** The board's clock (ms), for whether a pickup order is due to start. Without it, treated as due. */
  now?: number;
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
  /**
   * Phase I, one station's screen: this station's part of the order and
   * the button to mark it done. The order-level ready/served steps and
   * split/merge are left to the all-stations view (the pass).
   */
  station?: {
    name: string;
    done: boolean;
    canMark: boolean;
    onToggle: (done: boolean) => void;
  };
  /** Phase I, the all-stations view: which stations this order needs and which are done. */
  progress?: StationProgress[];
}) {
  const elapsed = useElapsedLabel(order.createdAt);
  // Dimmed and sorted down: accepted and not yet due (startsLater).
  // The badge's wording only asks whether the start time has come.
  const later = now !== undefined && startsLater(order, now);
  const startDue =
    order.pickup === null ||
    now === undefined ||
    new Date(order.pickup.startAt).getTime() <= now;
  const action = nextActionFor(role, order.status);
  const cancellable = canCancel(role, order.status);
  const [cancelOpen, setCancelOpen] = useState(false);

  const isSplitOrMerged = order.ticketGroups.length > 0;
  const stationView = station !== undefined;
  const canOrganize = CAN_ORGANIZE_TICKETS.includes(role) && !stationView;
  const showOrderAction =
    action !== null &&
    action !== undefined &&
    (!stationView || stationMayTransition(action.targetStatus));

  return (
    <div
      data-order-number={order.orderNumber}
      className={
        "bg-card flex flex-col gap-3 rounded-lg border p-3 shadow-sm" +
        (station?.done || later ? " opacity-60" : "")
      }
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
          {/*
            In words, not only in the card's dimming: a pickup order's start
            time is the one thing the cook needs from it before anything else
            (SC 1.4.1), and it has to survive a greyscale printout.
          */}
          {order.pickup &&
            (order.status === "pending" || order.status === "confirmed") && (
              <Badge variant={startDue ? "default" : "outline"}>
                {startDue ? "Start now" : `Start ${order.pickup.startTime}`}
              </Badge>
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
              stationView={stationView}
            />
          ))}
        </div>
      ) : (
        <ul className="flex flex-col gap-1.5 text-sm">
          {order.items.map((item) => (
            <LineItem key={item.id} item={item} markUnassigned={stationView} />
          ))}
        </ul>
      )}

      {progress && progress.length > 0 && (
        <ul
          className="flex flex-wrap gap-1.5"
          aria-label="Stations for this order"
        >
          {progress.map((p) => (
            <li key={p.id}>
              <Badge variant={p.done ? "secondary" : "outline"}>
                {p.done ? `${p.name} ✓` : `${p.name} …`}
                <span className="sr-only">
                  {p.done ? " done" : " still cooking"}
                </span>
              </Badge>
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

      {station && station.canMark && canMarkStationDone(order.status) && (
        <Button
          type="button"
          variant={station.done ? "outline" : "default"}
          disabled={isPending}
          onClick={() => station.onToggle(!station.done)}
        >
          {station.done
            ? `${station.name} done ✓ · Undo`
            : `${station.name} done`}
        </Button>
      )}

      <div className="mt-auto flex flex-wrap items-center gap-2">
        {!isSplitOrMerged && showOrderAction && action && (
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
