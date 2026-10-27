/**
 * Pure logic for the KDS's Realtime + polling reconciliation strategy —
 * deliberately has no React/Supabase/timer dependency, mirroring the
 * pure-logic/thin-glue split used throughout this codebase (see
 * src/lib/ai/tools/order-confirmation.ts, menu-fact-detection.ts).
 * kitchen-board.tsx is the thin glue that calls these functions from its
 * Realtime subscription, poll timer, and effects.
 *
 * The "exactly one instance of each order, keyed by order.id" guarantee
 * (Realtime, polling, or both discovering the same order) falls out of an
 * EXISTING architectural choice this file doesn't change: every resync is
 * a full, authoritative re-fetch via the existing
 * getActiveOrdersForRestaurant()/fetchActiveOrders() query, and the result
 * REPLACES component state wholesale rather than being merged into it. A
 * single SQL query can't return the same order.id twice, so there is no
 * separate "merge two partial updates and dedupe by id" step to get wrong.
 * This file's actual job is narrower: decide the polling cadence, whether
 * a given poll tick should run at all, and whether a given resync's result
 * is still the most recently requested one (so a slow response can never
 * overwrite fresher state — see isStaleResync).
 */

/** 10–15s range per spec — the safety net that catches whatever Realtime silently missed while it's otherwise healthy. */
export const KDS_NORMAL_POLL_INTERVAL_MS = 12_000;
/** 2–3s range per spec — used only while the Realtime channel itself is disconnected/degraded. */
export const KDS_DEGRADED_POLL_INTERVAL_MS = 2_500;

/** Which interval to poll at, based on the Realtime channel's current connection state. */
export function resolvePollIntervalMs(realtimeConnected: boolean): number {
  return realtimeConnected
    ? KDS_NORMAL_POLL_INTERVAL_MS
    : KDS_DEGRADED_POLL_INTERVAL_MS;
}

/**
 * The safety net for screens that re-render a whole server page per tick
 * (Settle up, the diner's order page) — several queries each, where the
 * KDS fetches one list. Slower than the KDS's: since Realtime delivers to
 * the browser (src/lib/supabase/realtime.ts) this only catches what it
 * misses, and in the busy-Saturday run these re-renders were most of the
 * database's load.
 */
export const PAGE_NORMAL_POLL_INTERVAL_MS = 30_000;
/**
 * While Realtime is down. Still slower than the KDS's: when the database
 * is what's slow, connections drop, and a fast full-page poll is what made
 * it slower still (busy-Saturday run).
 */
export const PAGE_DEGRADED_POLL_INTERVAL_MS = 8_000;

/** resolvePollIntervalMs for the full-page screens. */
export function resolvePagePollIntervalMs(realtimeConnected: boolean): number {
  return realtimeConnected
    ? PAGE_NORMAL_POLL_INTERVAL_MS
    : PAGE_DEGRADED_POLL_INTERVAL_MS;
}

/** False while the tab is hidden — a poll tick firing in the background is wasted work no one can see anyway (spec: avoid aggressive polling when hidden). */
export function shouldPollNow(documentVisibilityState: string): boolean {
  return documentVisibilityState !== "hidden";
}

/**
 * True if `issuedSeq` is no longer the most recently issued resync — i.e. a
 * newer resync (from Realtime, polling, or a visibility/online event) was
 * requested after this one started, so this result must be discarded even
 * though it just resolved. This is what stops a slow poll from overwriting
 * fresher Realtime-delivered state, and vice versa, regardless of which
 * request actually resolves first.
 */
export function isStaleResync(issuedSeq: number, latestSeq: number): boolean {
  return issuedSeq !== latestSeq;
}

/**
 * Whether to play the new-order chime — true if the fresh, authoritative
 * order list contains a pending order id not already known, the same
 * check regardless of whether the fresh data arrived via Realtime or via
 * the polling fallback (spec: a polling-discovered new order must alert
 * staff exactly like a Realtime-delivered one would).
 */
export function hasNewPendingOrder(
  freshOrders: Array<{ id: string; status: string }>,
  knownIds: ReadonlySet<string>,
): boolean {
  return freshOrders.some((o) => o.status === "pending" && !knownIds.has(o.id));
}
