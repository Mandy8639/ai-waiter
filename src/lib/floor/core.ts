/**
 * What each table on the floor view says.
 *
 * floor_tables() (20261128090000) returns facts per table: open requests,
 * the visit's orders by stage, what's unpaid, whether a guest is seated.
 * This file turns those into one state per tile. Pure and free of
 * `server-only`, so the priority rules are unit-tested directly.
 *
 * One state per table, the most urgent: a waiter scanning the room needs
 * to know where to walk first, not every fact about every table. The
 * other facts still show inside the tile.
 */
import { STATUS_LABELS, type OrderStatus } from "@/lib/orders/status";
import {
  STAFF_LABELS,
  isRequestKind,
  tableLabel,
  type RequestKind,
} from "@/lib/table-requests/core";
import { formatMoney } from "@/lib/orders/format";

export type FloorState =
  | "needs_waiter"
  | "wants_bill"
  | "food_ready"
  | "ordered"
  | "eating"
  | "paid"
  | "seated"
  | "free";

/** Most urgent first. Also the order of the legend. */
export const FLOOR_STATES: FloorState[] = [
  "needs_waiter",
  "wants_bill",
  "food_ready",
  "ordered",
  "eating",
  "paid",
  "seated",
  "free",
];

export const FLOOR_STATE_LABELS: Record<FloorState, string> = {
  needs_waiter: "Needs someone",
  wants_bill: "Wants the bill",
  food_ready: "Food ready",
  ordered: "Ordered",
  eating: "Eating",
  paid: "Paid",
  seated: "Seated",
  free: "Free",
};

/** Needs a person to walk over now. */
export function needsAttention(state: FloorState): boolean {
  return (
    state === "needs_waiter" || state === "wants_bill" || state === "food_ready"
  );
}

/**
 * A served table with no activity for this long is treated as free, so a
 * table nobody cleared doesn't read "eating" all evening. Money still owed
 * keeps it on the floor: that's a walkout or a forgotten bill, not a free
 * table.
 */
export const IDLE_AFTER_MS = 3 * 60 * 60 * 1000;

/** One row of floor_tables(), as it arrives over the wire. */
export interface FloorRow {
  table_id: string;
  table_number: string;
  display_name: string | null;
  seated_since: string | null;
  open_requests: unknown;
  active_orders: number;
  oldest_active_at: string | null;
  active_status: string | null;
  ready_orders: number;
  ready_since: string | null;
  served_orders: number;
  last_order_change_at: string | null;
  unpaid_orders: number;
  unpaid_total: number | string;
  currency: string | null;
}

export interface FloorRequest {
  id: string;
  kind: RequestKind;
  note: string | null;
  createdAt: string;
}

export interface FloorTile {
  tableId: string;
  label: string;
  state: FloorState;
  /** When the current state began, for the "12 min" timer. Null: no timer. */
  since: string | null;
  /** One short line under the state, e.g. "Preparing · 2 orders". */
  detail: string | null;
  requests: FloorRequest[];
  /** Orders still in the kitchen, ready, or served this visit. */
  counts: { active: number; ready: number; served: number };
  /** Only when the restaurant takes payments and something is owed. */
  owed: string | null;
  /** Something has happened this visit, so Clear table means something. */
  occupied: boolean;
}

function parseRequests(value: unknown): FloorRequest[] {
  if (!Array.isArray(value)) return [];
  const requests: FloorRequest[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    if (typeof r.id !== "string" || !isRequestKind(r.kind)) continue;
    requests.push({
      id: r.id,
      kind: r.kind,
      note: typeof r.note === "string" ? r.note : null,
      createdAt: String(r.created_at),
    });
  }
  return requests;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

export function floorTile(
  row: FloorRow,
  options: { basicMode: boolean; now: Date },
): FloorTile {
  const requests = parseRequests(row.open_requests);
  const counts = {
    active: row.active_orders,
    ready: row.ready_orders,
    served: row.served_orders,
  };
  const unpaid = Number(row.unpaid_total);
  const owesMoney = !options.basicMode && row.unpaid_orders > 0 && unpaid > 0;
  const owed =
    owesMoney && row.currency ? formatMoney(unpaid, row.currency) : null;

  const base = {
    tableId: row.table_id,
    label: tableLabel(row.table_number, row.display_name),
    requests,
    counts,
    owed,
  };

  const waiter = requests.find((r) => r.kind === "waiter");
  const bill = requests.find((r) => r.kind === "bill");

  let state: FloorState;
  let since: string | null = null;
  let detail: string | null = null;

  if (waiter) {
    state = "needs_waiter";
    since = waiter.createdAt;
    detail = waiter.note ?? STAFF_LABELS.waiter;
  } else if (bill) {
    state = "wants_bill";
    since = bill.createdAt;
    detail = bill.note ?? (owed ? `${owed} to pay` : STAFF_LABELS.bill);
  } else if (counts.ready > 0) {
    state = "food_ready";
    since = row.ready_since;
    detail = `${plural(counts.ready, "order")} to take out`;
  } else if (counts.active > 0) {
    state = "ordered";
    since = row.oldest_active_at;
    const stage =
      STATUS_LABELS[(row.active_status ?? "pending") as OrderStatus] ??
      STATUS_LABELS.pending;
    detail =
      counts.active === 1
        ? stage
        : `${stage} · ${plural(counts.active, "order")}`;
  } else if (counts.served > 0) {
    const lastChange = row.last_order_change_at
      ? new Date(row.last_order_change_at).getTime()
      : 0;
    const idle = options.now.getTime() - lastChange >= IDLE_AFTER_MS;
    if (owed) {
      // Owed money never goes idle: it's exactly what someone must see.
      state = "eating";
      since = row.last_order_change_at;
      detail = `${owed} to pay`;
    } else if (idle) {
      state = row.seated_since ? "seated" : "free";
      since = row.seated_since;
      detail = row.seated_since ? "Looking at the menu" : null;
    } else if (!options.basicMode) {
      // Payments on and nothing owed: everything served is paid for.
      state = "paid";
      since = row.last_order_change_at;
      detail = "Ready to clear";
    } else {
      state = "eating";
      since = row.last_order_change_at;
      detail = plural(counts.served, "order") + " served";
    }
  } else if (row.seated_since) {
    state = "seated";
    since = row.seated_since;
    detail = "Looking at the menu";
  } else {
    state = "free";
  }

  return {
    ...base,
    state,
    since,
    detail,
    occupied: state !== "free",
  };
}

/** Tables in the order staff number them: 2 before 10, "Patio 1" after. */
export function compareTiles(a: FloorTile, b: FloorTile): number {
  return a.label.localeCompare(b.label, undefined, { numeric: true });
}

export function floorTiles(
  rows: FloorRow[],
  options: { basicMode: boolean; now: Date },
): FloorTile[] {
  return rows.map((row) => floorTile(row, options)).sort(compareTiles);
}

/** "3 tables need someone", for the page header and Overview. */
export function attentionSummary(tiles: FloorTile[]): string {
  const n = tiles.filter((t) => needsAttention(t.state)).length;
  if (n === 0) return "Nobody's waiting";
  return n === 1 ? "1 table needs someone" : `${n} tables need someone`;
}

/** The database's error codes, as sentences for floor staff. */
export function floorErrorMessage(message: string): string {
  if (message.includes("FLOOR_TABLE_FORBIDDEN")) {
    return "You can't change that table.";
  }
  if (message.includes("FLOOR_TABLE_NOT_FOUND")) {
    return "That table is no longer there.";
  }
  return "That didn't go through. Please try again.";
}
