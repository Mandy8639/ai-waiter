export type OrderStatus =
  "pending" | "confirmed" | "preparing" | "ready" | "served" | "cancelled";

export const ACTIVE_KITCHEN_STATUSES: OrderStatus[] = [
  "pending",
  "confirmed",
  "preparing",
  "ready",
];

export const STATUS_LABELS: Record<OrderStatus, string> = {
  pending: "New",
  confirmed: "Confirmed",
  preparing: "Preparing",
  ready: "Ready",
  served: "Served",
  cancelled: "Cancelled",
};

/** Customer-facing wording differs slightly from the kitchen board's ("New" vs "Order received"). */
export const CUSTOMER_STATUS_LABELS: Record<OrderStatus, string> = {
  ...STATUS_LABELS,
  pending: "Order received",
};

/**
 * UI-only mirror of the SQL role/status matrix in
 * supabase/migrations/20260824090100_order_status_transitions.sql
 * (`role_can_transition_order`) — used purely to decide which action
 * button to render. This is NOT the security boundary: the server
 * (transition_order_status()) re-derives and re-checks role and current
 * status itself on every call, so a stale or tampered client render can
 * never produce an unauthorized transition — see
 * docs/security.md#order-status-transitions. Keep in sync with the SQL
 * matrix if either changes; a mismatch just shows the wrong button, it
 * cannot bypass anything.
 */
const ROLE_TRANSITIONS: Record<
  "owner" | "manager" | "kitchen" | "staff",
  Partial<Record<OrderStatus, OrderStatus>>
> = {
  owner: {
    pending: "confirmed",
    confirmed: "preparing",
    preparing: "ready",
    ready: "served",
  },
  manager: {
    pending: "confirmed",
    confirmed: "preparing",
    preparing: "ready",
    ready: "served",
  },
  kitchen: {
    pending: "confirmed",
    confirmed: "preparing",
    preparing: "ready",
  },
  staff: {
    ready: "served",
  },
};

const ACTION_LABELS: Record<OrderStatus, string> = {
  pending: "Order received",
  confirmed: "Confirm",
  preparing: "Start preparing",
  ready: "Mark ready",
  served: "Mark served",
  cancelled: "Cancel",
};

export interface NextAction {
  targetStatus: OrderStatus;
  label: string;
}

/** The single forward action this role can take on an order in its current status, if any. */
export function nextActionFor(
  role: "owner" | "manager" | "kitchen" | "staff",
  status: OrderStatus,
): NextAction | null {
  const target = ROLE_TRANSITIONS[role][status];
  if (!target) return null;
  return { targetStatus: target, label: ACTION_LABELS[target] };
}

/**
 * Owner/manager can cancel from pending or confirmed; staff can cancel
 * only from pending (see the role-matrix comment in the migration for the
 * documented reasoning). Kitchen cannot cancel at all.
 */
export function canCancel(
  role: "owner" | "manager" | "kitchen" | "staff",
  status: OrderStatus,
): boolean {
  if (status !== "pending" && status !== "confirmed") return false;
  if (role === "owner" || role === "manager") return true;
  if (role === "staff") return status === "pending";
  return false;
}
