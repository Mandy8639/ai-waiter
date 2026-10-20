import type { OrderStatus } from "@/lib/orders/status";

/**
 * Kitchen taps move the card at once (2026-10-20): the board shows the
 * status the cook chose while the undo window runs and the server catches
 * up, instead of "Updating…" for five seconds and more.
 *
 * The board refreshes from the server on every Realtime event and poll,
 * and until the tap is saved the server still has the old status. So the
 * taps still on their way are kept as overrides and laid over every
 * refresh; otherwise a card would jump back mid-undo-window.
 *
 * No `server-only` and no React, so it is unit-tested directly.
 */
export function withOverrides<T extends { id: string; status: OrderStatus }>(
  orders: T[],
  overrides: ReadonlyMap<string, OrderStatus>,
): T[] {
  if (overrides.size === 0) return orders;
  return orders.map((o) => {
    const status = overrides.get(o.id);
    return status && status !== o.status ? { ...o, status } : o;
  });
}
