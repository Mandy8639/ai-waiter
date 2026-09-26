/**
 * The dish funnel's presentation (phase H). Pure, so the wording and the
 * arithmetic are tested without a database.
 */

export interface DishFunnelRow {
  dishId: string;
  dishName: string;
  /** Visits that opened the dish's page. */
  opened: number;
  /** Visits that added it to their cart, from any path — menu or AI waiter. */
  added: number;
  /** Visits that ordered it. */
  ordered: number;
  /** Of the visits that opened it, how many went on to order it. */
  orderedAfterOpen: number;
}

/**
 * "Opened → ordered": of the visits that opened the dish, the share that
 * ordered it. Null when nobody opened it — a dish ordered only through the
 * AI waiter has no rate, rather than an infinite or 0% one.
 */
export function openToOrderRate(row: DishFunnelRow): number | null {
  if (row.opened <= 0) return null;
  return Math.min(1, row.orderedAfterOpen / row.opened);
}

export function formatRate(rate: number | null): string {
  if (rate === null) return "—";
  return `${Math.round(rate * 100)}%`;
}

export function toDishFunnelRows(data: unknown): DishFunnelRow[] {
  if (!Array.isArray(data)) return [];
  return data.map((r: Record<string, unknown>) => ({
    dishId: String(r.dish_id),
    dishName: String(r.dish_name ?? ""),
    opened: Number(r.opened_visits ?? 0),
    added: Number(r.added_visits ?? 0),
    ordered: Number(r.ordered_visits ?? 0),
    orderedAfterOpen: Number(r.ordered_after_open_visits ?? 0),
  }));
}
