/**
 * Split bill (phase J), the part a browser can show. Pure, so the sums a
 * payer is shown are unit-tested; the amounts actually charged are always
 * the database's own (start_split_payment adds up the parts itself).
 */
import { fromMinorUnits, sumMinorUnits } from "./money";

export const SPLIT_MIN_SHARES = 2;
export const SPLIT_MAX_SHARES = 20;

export type SplitMode = "equal" | "by_dish";
export type SplitStatus = "open" | "paid" | "cancelled";
export type SplitPartStatus = "open" | "pending" | "paid";

export interface SplitPart {
  id: string;
  position: number;
  kind: "share" | "dish";
  label: string;
  /** As the database stores it, e.g. "33.34" — never a float. */
  amount: string;
  status: SplitPartStatus;
}

export interface SplitView {
  splitId: string;
  status: SplitStatus;
  mode: SplitMode;
  currency: string;
  total: string;
  paidTotal: string;
  restaurantName: string;
  restaurantSlug: string;
  tippingEnabled: boolean;
  isOwner: boolean;
  orderNumbers: number[];
  parts: SplitPart[];
}

/** get_tab_split()'s JSON, typed. Null for an unknown link. */
export function toSplitView(raw: unknown): SplitView | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const money = (v: unknown) => String(v ?? "0");
  return {
    splitId: String(r.split_id),
    status: r.status as SplitStatus,
    mode: r.mode as SplitMode,
    currency: String(r.currency),
    total: money(r.total),
    paidTotal: money(r.paid_total),
    restaurantName: String(r.restaurant_name ?? ""),
    restaurantSlug: String(r.restaurant_slug ?? ""),
    tippingEnabled: r.tipping_enabled === true,
    isOwner: r.is_owner === true,
    orderNumbers: Array.isArray(r.order_numbers)
      ? r.order_numbers.map(Number)
      : [],
    parts: Array.isArray(r.units)
      ? r.units.map((u: Record<string, unknown>) => ({
          id: String(u.id),
          position: Number(u.position),
          kind: u.kind as "share" | "dish",
          label: String(u.label),
          amount: money(u.amount),
          status: u.status as SplitPartStatus,
        }))
      : [],
  };
}

/** The sum of the chosen parts that are still free, as the database will charge it. */
export function chosenAmount(
  parts: SplitPart[],
  chosenIds: ReadonlySet<string>,
  currency: string,
): string {
  const chosen = parts.filter(
    (p) => chosenIds.has(p.id) && p.status === "open",
  );
  return fromMinorUnits(
    sumMinorUnits(
      chosen.map((p) => p.amount),
      currency,
    ),
    currency,
  );
}

/** What is still to pay: every part not yet paid (pending ones may yet be abandoned). */
export function remainingAmount(view: SplitView): string {
  return fromMinorUnits(
    sumMinorUnits(
      view.parts.filter((p) => p.status !== "paid").map((p) => p.amount),
      view.currency,
    ),
    view.currency,
  );
}

export function progressLabel(view: SplitView): string {
  const paid = view.parts.filter((p) => p.status === "paid").length;
  return view.mode === "equal"
    ? `${paid} of ${view.parts.length} shares paid`
    : `${paid} of ${view.parts.length} dishes paid`;
}
