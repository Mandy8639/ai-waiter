/**
 * Turning the order history page's URL into a query it can run.
 *
 * Pure and free of `server-only` so it can be unit-tested directly, per
 * this codebase's extract-the-core convention. Everything here is parsing
 * and clamping: what a stranger puts in the query string decides how much
 * work the database is asked to do, so the limits live in one place rather
 * than being re-derived at each call site.
 */

import { STATUS_LABELS, type OrderStatus } from "./status";

/** Every status an order can hold, derived from the labels so there is no second list to keep in step. */
export const ORDER_STATUSES = Object.keys(STATUS_LABELS) as OrderStatus[];

export const HISTORY_PAGE_SIZE = 25;

/** Ranges the page offers. `all` exists because "when did we ever serve X?" is a real question a preset range cannot answer. */
export const HISTORY_RANGES = ["today", "7d", "30d", "all"] as const;
export type HistoryRange = (typeof HISTORY_RANGES)[number];

export const HISTORY_RANGE_LABELS: Record<HistoryRange, string> = {
  today: "Today",
  "7d": "Last 7 days",
  "30d": "Last 30 days",
  all: "All time",
};

export interface HistoryFilters {
  range: HistoryRange;
  /**
   * A status to narrow to, or null for every status including cancelled.
   *
   * Typed as OrderStatus rather than string because parseHistoryFilters()
   * has already checked it against the real set — carrying it as a loose
   * string would only push that validation onto every caller, and the
   * generated database types reject it at the query anyway.
   */
  status: OrderStatus | null;
  /** Free text: an order number, or part of a dish name. */
  search: string;
  /** Zero-based. */
  page: number;
}

export function isOrderStatus(value: unknown): value is OrderStatus {
  return (
    typeof value === "string" &&
    (ORDER_STATUSES as readonly string[]).includes(value)
  );
}

export function isHistoryRange(value: unknown): value is HistoryRange {
  return (
    typeof value === "string" && HISTORY_RANGES.includes(value as HistoryRange)
  );
}

/**
 * The search box takes either an order number or an item name, because
 * those are the two things a person actually has when they come asking:
 * a receipt with "#42" on it, or "the table that ordered the biryani".
 *
 * A leading # is stripped so pasting "#42" works as readily as "42".
 */
export function parseOrderNumber(search: string): number | null {
  const trimmed = search.trim().replace(/^#/, "");
  if (!/^\d+$/.test(trimmed)) return null;
  const n = Number(trimmed);
  // Order numbers are bigint and always positive; anything beyond a safe
  // integer cannot match a real row and would only risk precision loss.
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

export function parseHistoryFilters(params: {
  range?: string;
  status?: string;
  q?: string;
  page?: string;
}): HistoryFilters {
  const page = Number(params.page);

  return {
    range: isHistoryRange(params.range) ? params.range : "today",
    // An unknown status narrows to nothing rather than silently showing
    // everything — a filter that quietly does not apply is worse than one
    // that returns an empty list.
    status: isOrderStatus(params.status) ? params.status : null,
    // Capped: the value reaches a LIKE pattern, and an unbounded string
    // is work the database does on behalf of whoever typed it.
    search: (params.q ?? "").trim().slice(0, 100),
    page: Number.isSafeInteger(page) && page > 0 ? page : 0,
  };
}

/** Escapes a user's text for a PostgREST `ilike` pattern. */
export function escapeLikePattern(value: string): string {
  // % and _ are wildcards; a customer searching for "100%" must not match
  // every dish. Backslash first, or it would escape the escapes.
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/** The URL for a set of filters, omitting defaults so links stay readable. */
export function historyHref(filters: Partial<HistoryFilters>): string {
  const params = new URLSearchParams();
  if (filters.range && filters.range !== "today")
    params.set("range", filters.range);
  if (filters.status) params.set("status", filters.status);
  if (filters.search) params.set("q", filters.search);
  if (filters.page) params.set("page", String(filters.page));
  const query = params.toString();
  return query ? `/dashboard/orders?${query}` : "/dashboard/orders";
}
